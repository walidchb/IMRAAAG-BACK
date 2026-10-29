/**
 * End-to-end verification of the Phase 4 reservation engine against the live database.
 *
 * Covers acceptance criteria Â§15.9-Â§15.14, which are the Phase 4 exit criteria:
 *   Â§15.9  confirmation reserves stock
 *   Â§15.10 cancellation releases reservations without changing on-hand
 *   Â§15.11 dispatch/fulfillment consumes stock exactly once
 *   Â§15.12 returns require receipt/inspection before restock
 *   Â§15.13 concurrent reservations cannot oversell
 *   Â§15.14 retried operations are idempotent
 *
 * Creates throwaway `ZZ Smoke` products and orders, exercises the real services through the
 * Nest DI container (real indexes, real transactions, real unique constraints), then deletes
 * everything it created. Collection names are resolved from the compiled schemas via
 * scripts/lib/inventory-collections.js, never hardcoded.
 *
 * Run: `npm run build && node scripts/verify-reservations-phase4.js`
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { NestFactory } = require('@nestjs/core');
const { Types } = mongoose;
const { VariantsService } = require('../dist/modules/inventory/services/variants.service');
const { InventoryService } = require('../dist/modules/inventory/services/inventory.service');
const { ReservationsService } = require('../dist/modules/inventory/services/reservations.service');
const { OrdersService } = require('../dist/modules/orders/orders.service');
const { DeliveryCompanyRegistry } = require('../dist/modules/delivery/delivery-companies/delivery-company-registry.service');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

const COL = inventoryCollectionNames();

/**
 * Dispatch books a parcel with a real courier through `DeliveryCompanyRegistry`. The four
 * registered handlers all make live HTTP calls, so the smoke test registers a hermetic stub
 * instead - no network, and the parcel id is predictable.
 */
const SMOKE_COURIER = 'ZZ Smoke Courier';
const BROKEN_COURIER = 'ZZ Broken Courier';
let courierForOrders = SMOKE_COURIER;

let app;
let db;
let variantsService;
let inventoryService;
let reservationsService;
let ordersService;

const tmpProducts = [];
const tmpOrders = [];

let passed = 0;
function assert(cond, label) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (cond) passed += 1;
  else process.exitCode = 1;
}

async function errOf(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/**
 * A vendor product with a 2x2 matrix and every combination stocked.
 *
 * Returns the variant ids keyed by `<Size>-<Colour>` so scenarios can address them the way a
 * client would rather than by guessing at array order.
 */
async function makeVariantProduct(label, quantities = {}, price = 100) {
  const store = await db.collection('stores').findOne({});
  const res = await db.collection('products').insertOne({
    storeId: store._id,
    vendorEmail: store.vendorEmail,
    nameEn: `ZZ Smoke ${label}`,
    slug: `zz-smoke-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    // `originalPrice` is the initial (pre-discount) price, so it must sit above the selling
    // price. Step 4.6 raises a variant's `priceOverride` above the product price to prove the
    // override wins, which the variant pricing invariant refuses when the initial price equals
    // the selling price - so the smoke product keeps a headroom initial price.
    originalPrice: price * 3,
    price,
    weight: 1,
    published: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const productId = res.insertedId;
  tmpProducts.push(productId);
  // Services take `storeId: Types.ObjectId`. Passing the hex string works today only because
  // the inventory schemas cast it; the contract is ObjectId and the smoke test must not depend
  // on the cast to hide a caller that gets it wrong.
  const storeId = new Types.ObjectId(store._id);

  const size = await variantsService.createOption(String(productId), storeId, { key: 'Size', nameEn: 'Size' });
  const colour = await variantsService.createOption(String(productId), storeId, { key: 'colour', nameEn: 'Colour' });
  const small = await variantsService.createValue(String(productId), storeId, size._id, { value: 's', valueEn: 'Small' });
  const large = await variantsService.createValue(String(productId), storeId, size._id, { value: 'l', valueEn: 'Large' });
  const red = await variantsService.createValue(String(productId), storeId, colour._id, { value: 'red', valueEn: 'Red' });
  const blue = await variantsService.createValue(String(productId), storeId, colour._id, { value: 'blue', valueEn: 'Blue' });

  // `toggleVariants` no longer exists: every product is a variant product, combinations are
  // created via `createVariants` (all at zero balance), and quantities come from `setOnHand`.
  const preview = await variantsService.previewCombinations(String(productId), storeId, {});
  const selections = preview.possibleCombinations.map((c) => ({
    combinationKey: c.combinationKey,
    optionValueIds: c.optionValueIds,
  }));
  await variantsService.createVariants(String(productId), storeId, { selections });

  let matrix = await variantsService.getMatrix(String(productId), storeId);
  for (const mv of matrix.variants) {
    const qty = quantities[mv.combinationKey] ?? 10;
    await inventoryService.setOnHand({
      storeId,
      variantId: new Types.ObjectId(mv.variantId),
      quantity: qty,
      reason: 'phase4 smoke setup',
    });
  }

  matrix = await variantsService.getMatrix(String(productId), storeId);
  const byLabel = {};
  for (const v of matrix.variants) {
    const sizeName = v.optionValueIds.some((id) => id === String(small._id)) ? 'Small' : 'Large';
    const colourName = v.optionValueIds.some((id) => id === String(red._id)) ? 'Red' : 'Blue';
    byLabel[`${sizeName}-${colourName}`] = v;
  }

  return { productId, storeId, matrix, variants: byLabel, store: store, vendorUser: null };
}

/**
 * Places a real order through `OrdersService.create`, so the assertions exercise the same
 * snapshot + advisory path a storefront would.
 */
async function placeOrder(ctx, lines, extra = {}) {
  const created = await ordersService.create(
    {
      storeId: String(ctx.storeId),
      vendorEmail: ctx.store.vendorEmail,
      shippingMethod: 'stopdesk',
      paymentMethod: 'COD',
      ...(courierForOrders ? { deliveryCompanyId: courierForOrders } : {}),
      total: lines.reduce((sum, l) => sum + l.price * l.quantity, 0),
      customer: {
        name: 'Smoke Buyer',
        phone: '0555000000',
        wilaya: '16',
        commune: 'Alger Centre',
      },
      items: lines.map((l) => ({
        productId: String(ctx.productId),
        productName: `ZZ Smoke ${l.label}`,
        quantity: l.quantity,
        // Deliberately wrong: the server must resolve price itself (Â§7.2 rule 7).
        price: 1,
        ...(l.variantId ? { variantId: l.variantId } : {}),
      })),
      ...extra,
    },
    ctx.vendorUser,
  );
  tmpOrders.push(created._id);
  return created;
}

async function balanceOf(variantId) {
  return db.collection(COL.balances).findOne({ variantId: new Types.ObjectId(variantId) });
}

async function movementsFor(orderId) {
  return db.collection(COL.movements).find({ orderId: new Types.ObjectId(orderId) }).sort({ _id: 1 }).toArray();
}

async function reservationsFor(orderId) {
  return db.collection(COL.reservations).find({ orderId: new Types.ObjectId(orderId) }).sort({ orderItemIndex: 1 }).toArray();
}

function slugOf(order) {
  return typeof order.status === 'string' ? order.status : order.status?.slug;
}

async function setStatus(orderId, slug) {
  return ordersService.update(String(orderId), { status: slug }, ctx.vendorUserRef());
}

let ctx;

async function main() {
  const { AppModule } = require('../dist/app.module');
  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  const connection = app.get(require('@nestjs/mongoose').getConnectionToken());
  db = connection.db;
  variantsService = app.get(VariantsService);
  inventoryService = app.get(InventoryService);
  reservationsService = app.get(ReservationsService);
  ordersService = app.get(OrdersService);

  // `register` is TS-private; from plain JS it is just a method. A stub keeps dispatch
  // exercising the real precheck + booking path without touching a courier's API.
  const registry = app.get(DeliveryCompanyRegistry);
  registry.register({
    companyId: SMOKE_COURIER,
    createOrder: async (o) => ({ parcelId: `ZZ-${o.orderNo}` }),
  });
  registry.register({
    companyId: BROKEN_COURIER,
    createOrder: async () => {
      throw new Error('ZZ courier is unreachable');
    },
  });
  console.log('\n[SMOKE] context up\n');

  // ---------------------------------------------------------------------------------
  console.log('setup: one stocked variant product');
  ctx = await makeVariantProduct('p4', {}, 100);
  const v = ctx.variants;
  ctx.vendorUser = { id: String(ctx.store.vendorId), email: ctx.store.vendorEmail, role: 'VENDOR', fullName: 'Smoke' };
  ctx.vendorUserRef = () => ctx.vendorUser;
  console.log(`  product=${ctx.productId} store=${ctx.storeId}`);

  // ---------------------------------------------------------------------------------
  console.log('\n4.6 order-line snapshots + priceOverride resolution');
  {
    const target = v['Small-Red'];
    await variantsService.updateVariant(String(ctx.productId), ctx.storeId, target.variantId, {
      sku: 'SMK-SR-1',
      priceOverride: 175,
      image: 'https://img.test/sr.jpg',
    });

    const order = await placeOrder(ctx, [{ label: 'snap', variantId: target.variantId, quantity: 2, price: 175 }]);
    const line = order.items[0];

    assert(line.lineId && String(line.lineId).length === 24, 'a stable lineId is assigned');
    assert(line.variantId === target.variantId, 'the line records the variant that was bought');
    assert(line.sku === 'SMK-SR-1', `sku is snapshotted (${line.sku})`);
    assert(line.image === 'https://img.test/sr.jpg', 'the variant image is snapshotted');
    assert(!!line.variantSnapshot?.label, `a structured snapshot label exists (${line.variantSnapshot?.label})`);
    assert(
      (line.variantSnapshot?.options || []).length === 2,
      'the snapshot records both option dimensions',
    );
    // Â§7.2 rule 7: the client sent price: 1 on purpose.
    assert(line.price === 175, `priceOverride wins over the client price (${line.price})`);
    assert(order.total === 350, `the total is computed from the resolved price (${order.total})`);

    // A variant id that does not exist must be refused rather than silently dropped, which
    // would create an order that reserves nothing.
    const bogus = await errOf(() =>
      placeOrder(ctx, [{ label: 'bogus', variantId: new Types.ObjectId().toHexString(), quantity: 1, price: 100 }]),
    );
    assert(bogus?.errorCode === 'VARIANT_NOT_FOUND', `an unknown variant is refused (${bogus?.errorCode})`);
  }

  // ---------------------------------------------------------------------------------
  console.log('\nÂ§15.9 confirmation reserves stock');
  {
    const target = v['Large-Blue'];
    const order = await placeOrder(ctx, [{ label: 'reserve', variantId: target.variantId, quantity: 3, price: 100 }]);

    const before = await balanceOf(target.variantId);
    await setStatus(order._id, 'confirmed');

    const after = await balanceOf(target.variantId);
    assert(after.onHand === before.onHand, 'reservation leaves on-hand untouched');
    assert(after.reserved === before.reserved + 3, `reserved rose by the ordered quantity (${after.reserved})`);
    assert(after.onHand - after.reserved === (before.onHand - before.reserved) - 3, 'available fell by 3');

    const reservations = await reservationsFor(order._id);
    assert(reservations.length === 1, 'a reservation row exists for the line');
    assert(reservations[0].status === 'active', 'the reservation is active');
    assert(reservations[0].orderItemIndex === 0, 'the reservation is keyed to the line index');
    assert(String(reservations[0].quantity) === '3', 'the reservation records the quantity');

    const movements = await movementsFor(order._id);
    const reserve = movements.filter((m) => m.type === 'order_reservation');
    assert(reserve.length === 1, 'exactly one order_reservation movement was written');
    assert(reserve[0].quantityDelta === 0, 'the reservation movement has a zero on-hand delta');
    assert(reserve[0].reservedAfter - reserve[0].reservedBefore === 3, 'the ledger records the reserved delta');
    assert(!!reserve[0].reservationId, 'the movement points at its reservation');

    const refreshed = await ordersService.findOne(String(order._id));
    assert(!!refreshed.inventoryState?.reservedAt, 'the order records when it was reserved');

    // Â§15.14 idempotency: a repeated confirmation must not reserve twice.
    const again = await errOf(() => reservationsService.reserve(
      {
        orderId: order._id,
        orderNo: order.orderNo,
        storeId: ctx.storeId,
        items: [{ variantId: target.variantId, quantity: 3 }],
      },
      null,
    ));
    assert(!again, 'reserving an already-reserved order succeeds');
    const afterRetry = await balanceOf(target.variantId);
    assert(afterRetry.reserved === after.reserved, 'a retried reservation does not double-reserve');
    assert((await movementsFor(order._id)).filter((m) => m.type === 'order_reservation').length === 1,
      'a retried reservation writes no second movement');

    // Unwind so later scenarios start from a clean balance.
    await reservationsService.release(
      {
        orderId: order._id,
        orderNo: order.orderNo,
        storeId: ctx.storeId,
        items: [{ variantId: target.variantId, quantity: 3 }],
      },
      null,
    );
  }

  // ---------------------------------------------------------------------------------
  console.log('\nÂ§7.2 rule 5 multi-line reservation is all-or-nothing');
  {
    const good = v['Small-Red'];
    const poor = v['Large-Red'];
    // Take `poor` down to zero so the second line cannot be satisfied.
    await inventoryService.setOnHand({
      storeId: ctx.storeId,
      variantId: new Types.ObjectId(poor.variantId),
      quantity: 0,
      reason: 'phase4 smoke setup',
    });

    const beforeGood = await balanceOf(good.variantId);
    // A vendor-entered order is now gated at creation (`ORDER_ITEM_OUT_OF_STOCK`), so the
    // all-or-nothing proof has to run through the public storefront path, which stays advisory:
    // the order is accepted with the short line, and the shortage only surfaces at confirmation.
    const vendorUser = ctx.vendorUser;
    ctx.vendorUser = undefined;
    const order = await placeOrder(ctx, [
      { label: 'line0', variantId: good.variantId, quantity: 2, price: 100 },
      { label: 'line1', variantId: poor.variantId, quantity: 5, price: 100 },
    ]);
    ctx.vendorUser = vendorUser;

    const failure = await errOf(() => setStatus(order._id, 'confirmed'));
    assert(failure?.errorCode === 'INSUFFICIENT_STOCK', `the short line is refused (${failure?.errorCode})`);

    // The whole point: the first line must not stay reserved.
    const afterGood = await balanceOf(good.variantId);
    assert(afterGood.reserved === beforeGood.reserved, 'the satisfiable line was NOT left reserved');
    assert((await reservationsFor(order._id)).length === 0, 'no partial reservation rows survive');

    const stillPlaced = await ordersService.findOne(String(order._id));
    assert(slugOf(stillPlaced) === 'placed', `the status change was rolled back (${slugOf(stillPlaced)})`);
    assert(!stillPlaced.inventoryState?.reservedAt, 'a rolled-back confirm leaves no reservedAt stamp');

    await inventoryService.setOnHand({
      storeId: ctx.storeId,
      variantId: new Types.ObjectId(poor.variantId),
      quantity: 10,
      reason: 'phase4 smoke restore',
    });
  }

  // ---------------------------------------------------------------------------------
  console.log('\nÂ§15.10 cancellation releases without touching on-hand');
  {
    const target = v['Small-Blue'];
    const order = await placeOrder(ctx, [{ label: 'cancel', variantId: target.variantId, quantity: 4, price: 100 }]);
    await setStatus(order._id, 'confirmed');

    const mid = await balanceOf(target.variantId);
    assert(mid.reserved === 4, 'the confirmed order holds a reservation');

    await setStatus(order._id, 'cancelled');

    const after = await balanceOf(target.variantId);
    assert(after.reserved === mid.reserved - 4, 'the reservation was released');
    assert(after.onHand === mid.onHand, 'on-hand is unchanged by a release');

    const reservations = await reservationsFor(order._id);
    assert(reservations[0].status === 'released', 'the reservation is marked released');

    const movements = await movementsFor(order._id);
    assert(movements.filter((m) => m.type === 'reservation_release').length === 1, 'one release movement');
    assert(
      movements.filter((m) => m.type === 'fulfillment_deduction').length === 0,
      'a cancelled order never deducts stock',
    );

    // Â§7.2 rule 10: cancelling an order that was never confirmed must be inert.
    const bare = await placeOrder(ctx, [{ label: 'bare', variantId: target.variantId, quantity: 1, price: 100 }]);
    const bareBefore = await balanceOf(target.variantId);
    await setStatus(bare._id, 'cancelled');
    const bareAfter = await balanceOf(target.variantId);
    assert(bareAfter.reserved === bareBefore.reserved, 'cancelling an unconfirmed order changes nothing');
    assert(bareAfter.onHand === bareBefore.onHand, 'and leaves on-hand alone');
    assert((await movementsFor(bare._id)).length === 0, 'and writes no movement at all');
  }

  // ---------------------------------------------------------------------------------
  console.log('\nÂ§15.11 dispatch consumes exactly once');
  {
    const target = v['Large-Red'];
    const order = await placeOrder(ctx, [{ label: 'ship', variantId: target.variantId, quantity: 3, price: 100 }]);
    await setStatus(order._id, 'confirmed');

    const before = await balanceOf(target.variantId);
    await setStatus(order._id, 'dispatched');
    const after = await balanceOf(target.variantId);

    assert(after.onHand === before.onHand - 3, `on-hand was deducted (${before.onHand} -> ${after.onHand})`);
    assert(after.reserved === before.reserved - 3, 'the reservation was consumed');

    const reservations = await reservationsFor(order._id);
    assert(reservations[0].status === 'consumed', 'the reservation is marked consumed');

    const deductions = (await movementsFor(order._id)).filter((m) => m.type === 'fulfillment_deduction');
    assert(deductions.length === 1, 'exactly one fulfillment_deduction movement');
    assert(deductions[0].quantityDelta === -3, 'the deduction delta is the fulfilled quantity');

    const shipped = await ordersService.findOne(String(order._id));
    assert(!!shipped.inventoryState?.fulfilledAt, 'the order records when it was fulfilled');

    // Â§15.14: a retried dispatch must not deduct again. `confirmed -> dispatched` is already
    // illegal a second time, so exercise the engine directly.
    await reservationsService.consume(
      {
        orderId: order._id,
        orderNo: order.orderNo,
        storeId: ctx.storeId,
        items: [{ variantId: target.variantId, quantity: 3 }],
      },
      null,
    );
    const afterRetry = await balanceOf(target.variantId);
    assert(afterRetry.onHand === after.onHand, 'a retried consume does not deduct twice');
    assert(
      (await movementsFor(order._id)).filter((m) => m.type === 'fulfillment_deduction').length === 1,
      'a retried consume writes no second deduction',
    );
  }

  // ---------------------------------------------------------------------------------
  console.log('\ncourier booking: precheck before mutation, failure after the claim is recorded');
  {
    // The dispatch claim and the stock deduction are one transaction; the courier booking is
    // an HTTP call and cannot join it. So "no courier configured" has to be refused *before*
    // the claim, or the order would be dispatched with stock already deducted and then report
    // an error. Nothing at all may change.
    const target = v['Large-Blue'];
    await inventoryService.setOnHand({
      storeId: ctx.storeId,
      variantId: new Types.ObjectId(target.variantId),
      quantity: 5,
      reason: 'phase4 delivery setup',
    });

    courierForOrders = null;
    const noCourier = await placeOrder(ctx, [
      { label: 'nocourier', variantId: target.variantId, quantity: 2, price: 100 },
    ]);
    await setStatus(noCourier._id, 'confirmed');
    const beforeFail = await balanceOf(target.variantId);

    const refused = await errOf(() => setStatus(noCourier._id, 'dispatched'));
    assert(
      refused?.errorCode === 'DELIVERY_COMPANY_NOT_ASSIGNED',
      `dispatch without a courier is refused (${refused?.errorCode})`,
    );
    const afterFail = await balanceOf(target.variantId);
    assert(afterFail.onHand === beforeFail.onHand, 'on-hand untouched by the refused dispatch');
    assert(afterFail.reserved === beforeFail.reserved, 'the reservation survived the refusal');
    const stillConfirmed = await ordersService.findOne(String(noCourier._id));
    assert(slugOf(stillConfirmed) === 'confirmed', `the order is still confirmed (${slugOf(stillConfirmed)})`);
    assert(
      (await movementsFor(noCourier._id)).filter((m) => m.type === 'fulfillment_deduction').length === 0,
      'no deduction was written by the refused dispatch',
    );
    courierForOrders = SMOKE_COURIER;

    // A courier that is configured but unreachable is refused the same way: the parcel has to
    // exist before the order may claim to be dispatched, so the claim never runs, the stock
    // stays reserved, and the booking failure is recorded on the order for a retry.
    courierForOrders = BROKEN_COURIER;
    const broken = await placeOrder(ctx, [
      { label: 'brokencourier', variantId: target.variantId, quantity: 2, price: 100 },
    ]);
    await setStatus(broken._id, 'confirmed');
    const beforeBook = await balanceOf(target.variantId);

    const bookingFailed = await errOf(() => setStatus(broken._id, 'dispatched'));
    assert(
      // The stub courier throws a plain Error, which the booking path surfaces as-is (a real
      // handler raises a typed `DELIVERY_*`), so the stable contract is "the dispatch was
      // refused, and never with a non-delivery code".
      bookingFailed && (!bookingFailed.errorCode || /^DELIVERY_/.test(bookingFailed.errorCode)),
      `an unreachable courier refuses the dispatch (${bookingFailed?.errorCode ?? bookingFailed?.message})`,
    );

    const afterBook = await balanceOf(target.variantId);
    assert(afterBook.onHand === beforeBook.onHand, 'no stock left the building on a refused dispatch');
    assert(afterBook.reserved === beforeBook.reserved, 'the refused dispatch keeps the reservation');
    const shippedAnyway = await ordersService.findOne(String(broken._id));
    assert(slugOf(shippedAnyway) === 'confirmed', `the order stayed confirmed (${slugOf(shippedAnyway)})`);
    assert(!shippedAnyway.deliveryParcelId, 'no parcel id was recorded');
    assert(!!shippedAnyway.deliveryError, `the booking error is recorded for a retry (${shippedAnyway.deliveryError})`);
    courierForOrders = SMOKE_COURIER;

    // And the happy path really does book the parcel.
    const okOrder = await placeOrder(ctx, [{ label: 'okcourier', variantId: target.variantId, quantity: 1, price: 100 }]);
    await setStatus(okOrder._id, 'confirmed');
    await setStatus(okOrder._id, 'dispatched');
    const shipped = await ordersService.findOne(String(okOrder._id));
    assert(!!shipped.deliveryParcelId, `the parcel was booked (${shipped.deliveryParcelId})`);
    assert(!shipped.deliveryError, 'no delivery error on the happy path');

    // Both orders that could not be dispatched are still holding a reservation; cancelling them
    // is the realistic operator action and hands the stock back for the scenarios below.
    const beforeFree = await balanceOf(target.variantId);
    await setStatus(noCourier._id, 'cancelled');
    await setStatus(broken._id, 'cancelled');
    const afterFree = await balanceOf(target.variantId);
    assert(afterFree.reserved === beforeFree.reserved - 4, 'cancelling the stuck orders released their reservations');
  }

  // ---------------------------------------------------------------------------------
  console.log('\n4.4 post-dispatch cancel: no stock change + correction movement (G-1)');
  {
    const target = v['Large-Blue'];
    const order = await placeOrder(ctx, [{ label: 'g1', variantId: target.variantId, quantity: 2, price: 100 }]);
    await setStatus(order._id, 'confirmed');
    await setStatus(order._id, 'dispatched');

    const before = await balanceOf(target.variantId);
    await setStatus(order._id, 'cancelled');
    const after = await balanceOf(target.variantId);

    assert(after.onHand === before.onHand, 'a post-dispatch cancel does NOT return stock to sellable');
    assert(after.reserved === before.reserved, 'reserved is untouched');

    const corrections = (await movementsFor(order._id)).filter((m) => m.type === 'correction');
    assert(corrections.length === 1, 'a correction movement explains the discrepancy');
    assert(corrections[0].quantityDelta === 0, 'the correction changes no stock');
    assert(corrections[0].reason === 'post_dispatch_cancellation', 'the correction names the reason');
  }

  // ---------------------------------------------------------------------------------
  console.log('\nÂ§15.12 returns need a receipt before restocking');
  {
    const restock = v['Small-Red'];
    const order = await placeOrder(ctx, [{ label: 'ret', variantId: restock.variantId, quantity: 3, price: 100 }]);
    await setStatus(order._id, 'confirmed');
    await setStatus(order._id, 'dispatched');

    const afterShip = await balanceOf(restock.variantId);

    const received = await ordersService.receiveReturn(
      String(order._id),
      { items: [{ orderItemIndex: 0, disposition: 'restock' }], note: 'ZZ smoke: box opened, goods fine' },
      ctx.vendorUser,
    );
    assert(received.results[0].applied === true, 'the restock receipt applied');
    assert(received.inventory.inventoryState.receivedAt !== null, 'the order records the receipt time');

    const afterRestock = await balanceOf(restock.variantId);
    assert(afterRestock.onHand === afterShip.onHand + 3, 'restocked units became sellable again');
    assert(
      (await movementsFor(order._id)).filter((m) => m.type === 'return_restock').length === 1,
      'one return_restock movement',
    );

    // Â§15.14: a retried receipt must not restock twice.
    const repeated = await ordersService.receiveReturn(
      String(order._id),
      { items: [{ orderItemIndex: 0, disposition: 'restock' }] },
      ctx.vendorUser,
    );
    assert(repeated.results[0].applied === false, 'a retried receipt is reported as already recorded');
    const afterRepeat = await balanceOf(restock.variantId);
    assert(afterRepeat.onHand === afterRestock.onHand, 'a retried receipt does not restock twice');

    // Write-off: damaged goods must NOT become sellable.
    const damaged = v['Large-Red'];
    const order2 = await placeOrder(ctx, [{ label: 'dmg', variantId: damaged.variantId, quantity: 2, price: 100 }]);
    await setStatus(order2._id, 'confirmed');
    await setStatus(order2._id, 'dispatched');

    const beforeWriteOff = await balanceOf(damaged.variantId);
    await ordersService.receiveReturn(
      String(order2._id),
      { items: [{ orderItemIndex: 0, disposition: 'write_off' }] },
      ctx.vendorUser,
    );
    const afterWriteOff = await balanceOf(damaged.variantId);
    assert(afterWriteOff.onHand === beforeWriteOff.onHand, 'a write-off does not return stock');
    assert(
      (await movementsFor(order2._id)).filter((m) => m.type === 'damage_write_off').length === 1,
      'a damage_write_off movement records the disposition',
    );

    // The idempotency key identifies the *receipt*, not the disposition, so a replayed
    // receipt cannot switch a line from `write_off` to `restock` (or the reverse) after the
    // fact - which would either invent sellable stock or silently zero real stock.
    const replayed = await ordersService.receiveReturn(
      String(order2._id),
      { items: [{ orderItemIndex: 0, disposition: 'restock' }] },
      ctx.vendorUser,
    );
    assert(replayed.results[0].applied === false, 'a receipt cannot be replayed with a different disposition');
    const afterReplay = await balanceOf(damaged.variantId);
    assert(afterReplay.onHand === beforeWriteOff.onHand, 'the replayed receipt did not restock the written-off units');

    // The operator note is accepted by the DTO and must reach the ledger, not be dropped.
    const noted = await db.collection(COL.movements).findOne({ orderId: order._id, type: 'return_restock' });
    assert(!!noted?.note, `the ledger movement keeps its note (${noted?.note})`);
    assert(
      String(noted?.note).includes('box opened, goods fine'),
      'the operator note reaches the ledger verbatim',
    );

    // A receipt against an order that never shipped must be refused: the goods never left.
    const neverShipped = await placeOrder(ctx, [{ label: 'nosh', variantId: v['Small-Blue'].variantId, quantity: 1, price: 100 }]);
    const refused = await errOf(() =>
      ordersService.receiveReturn(
        String(neverShipped._id),
        { items: [{ orderItemIndex: 0, disposition: 'restock' }] },
        ctx.vendorUser,
      ),
    );
    assert(
      refused?.errorCode === 'INVALID_ORDER_TRANSITION',
      `receiving against an undispatched order is refused (${refused?.errorCode})`,
    );
  }

  // ---------------------------------------------------------------------------------
  console.log('\nÂ§15.13 concurrent reservations cannot oversell');
  {
    // One unit, two orders racing for it. This is the assertion that matters most: a
    // read-then-write here would let both see available 1 and both succeed.
    const target = v['Large-Blue'];
    await inventoryService.setOnHand({
      storeId: ctx.storeId,
      variantId: new Types.ObjectId(target.variantId),
      quantity: 1,
      reason: 'phase4 concurrency setup',
    });

    const orderA = await placeOrder(ctx, [{ label: 'raceA', variantId: target.variantId, quantity: 1, price: 100 }]);
    const orderB = await placeOrder(ctx, [{ label: 'raceB', variantId: target.variantId, quantity: 1, price: 100 }]);

    const ctxFor = (order) => ({
      orderId: order._id,
      orderNo: order.orderNo,
      storeId: ctx.storeId,
      items: [{ variantId: target.variantId, quantity: 1 }],
    });

    const outcomes = await Promise.allSettled([
      reservationsService.reserve(ctxFor(orderA), null),
      reservationsService.reserve(ctxFor(orderB), null),
    ]);
    const winners = outcomes.filter((o) => o.status === 'fulfilled').length;
    const losers = outcomes.filter((o) => o.status === 'rejected');

    assert(winners === 1, `exactly one of two concurrent reserves succeeded (${winners})`);
    assert(losers.length === 1, 'the other reported a failure');

    const final = await balanceOf(target.variantId);
    assert(final.onHand === 1, 'on-hand is untouched');
    assert(final.reserved === 1, 'reserved is exactly 1 - the last unit was sold once');
    assert(final.onHand - final.reserved === 0, 'available never went negative');

    const rows = (await reservationsFor(orderA._id)).length + (await reservationsFor(orderB._id)).length;
    assert(rows === 1, 'only one reservation row exists across both orders');
  }

  // ---------------------------------------------------------------------------------
  console.log('\ntwo order lines referencing the same variant');
  {
    const target = v['Small-Red'];
    await inventoryService.setOnHand({
      storeId: ctx.storeId,
      variantId: new Types.ObjectId(target.variantId),
      quantity: 10,
      reason: 'phase4 shared-variant setup',
    });

    const order = await placeOrder(ctx, [
      { label: 'dup0', variantId: target.variantId, quantity: 1, price: 100 },
      { label: 'dup1', variantId: target.variantId, quantity: 2, price: 100 },
    ]);
    const before = await balanceOf(target.variantId);
    await setStatus(order._id, 'confirmed');
    const after = await balanceOf(target.variantId);

    assert(after.reserved === before.reserved + 3, `both lines reserved against one balance (${after.reserved})`);
    const reservations = await reservationsFor(order._id);
    assert(reservations.length === 2, 'one reservation row per line, not per variant');
    assert(reservations[0].orderItemIndex === 0 && reservations[1].orderItemIndex === 1,
      'each reservation is keyed to its own line index');
    assert(String(reservations[0].quantity) === '1' && String(reservations[1].quantity) === '2',
      'each reservation keeps its own quantity');
  }

  // ---------------------------------------------------------------------------------
  console.log('\n4.7 advisory availability check at placed');
  {
    const target = v['Large-Blue']; // left at 1 on-hand, fully reserved by the race above
    // The advisory contract is the storefront's: a shopper may place an order the store cannot
    // yet satisfy. A vendor-entered order is gated at creation instead, so this runs un-gated.
    const vendorUser = ctx.vendorUser;
    ctx.vendorUser = undefined;
    const order = await placeOrder(ctx, [{ label: 'advisory', variantId: target.variantId, quantity: 9, price: 100 }]);
    ctx.vendorUser = vendorUser;
    assert(!!order._id, 'an order that cannot be satisfied is still accepted at placed');
    assert(slugOf(order) === 'placed', 'it is created in the placed status');

    const report = await reservationsService.checkAdvisoryAvailability({
      orderId: order._id,
      orderNo: order.orderNo,
      storeId: ctx.storeId,
      items: [{ variantId: target.variantId, quantity: 9 }],
    });
    assert(report.length === 1, 'the advisory report covers the line');
    assert(report[0].isShort === true, 'the advisory report flags the shortfall');
    assert(report[0].available === 0, 'it reports the real availability');
  }

  // ---------------------------------------------------------------------------------
  console.log('\n4.8 bulkAction confirm/cancel drives inventory too');
  {
    const target = v['Small-Blue'];
    await inventoryService.setOnHand({
      storeId: ctx.storeId,
      variantId: new Types.ObjectId(target.variantId),
      quantity: 20,
      reason: 'phase4 bulk setup',
    });

    const order = await placeOrder(ctx, [{ label: 'bulk', variantId: target.variantId, quantity: 6, price: 100 }]);
    const before = await balanceOf(target.variantId);

    const confirmed = await ordersService.bulkAction(
      { ids: [String(order._id)], action: 'confirm' },
      ctx.vendorUser,
    );
    assert(confirmed.modifiedCount === 1, 'bulk confirm applied');
    const mid = await balanceOf(target.variantId);
    assert(mid.reserved === before.reserved + 6, 'bulk confirm reserved the stock');

    const cancelled = await ordersService.bulkAction(
      { ids: [String(order._id)], action: 'cancel' },
      ctx.vendorUser,
    );
    assert(cancelled.modifiedCount === 1, 'bulk cancel applied');
    const after = await balanceOf(target.variantId);
    assert(after.reserved === before.reserved, 'bulk cancel released the stock');
    assert(after.onHand === before.onHand, 'bulk cancel left on-hand alone');

    // A bulk confirm whose stock is missing must not move the status at all. The order itself
    // has to come in through the advisory storefront path, since a vendor-entered line is
    // gated at creation.
    const poor = v['Large-Red'];
    await inventoryService.setOnHand({
      storeId: ctx.storeId,
      variantId: new Types.ObjectId(poor.variantId),
      quantity: 0,
      reason: 'phase4 bulk failure setup',
    });
    const vendorUser = ctx.vendorUser;
    ctx.vendorUser = undefined;
    const doomed = await placeOrder(ctx, [{ label: 'bulkfail', variantId: poor.variantId, quantity: 4, price: 100 }]);
    ctx.vendorUser = vendorUser;
    const result = await ordersService.bulkAction(
      { ids: [String(doomed._id)], action: 'confirm' },
      ctx.vendorUser,
    );
    assert(result.modifiedCount === 0, 'a bulk confirm with no stock did not apply');
    assert((result.errors || []).length === 1, 'the failing order is reported by orderNo');
    const stillPlaced = await ordersService.findOne(String(doomed._id));
    assert(slugOf(stillPlaced) === 'placed', 'the failing order stayed placed');
    await inventoryService.setOnHand({
      storeId: ctx.storeId,
      variantId: new Types.ObjectId(poor.variantId),
      quantity: 10,
      reason: 'phase4 bulk restore',
    });
  }

  // ---------------------------------------------------------------------------------
  console.log('\ndefault-variant products flow through the engine (universal variants supersede roadmap §4.3)');
  {
    // A product created without an explicit matrix gets a "Default > One Size" variant; its
    // balance is the stock source, and orders must name it like any other variant.
    const plain = await db.collection('products').insertOne({
      storeId: ctx.store._id,
      vendorEmail: ctx.store.vendorEmail,
      nameEn: 'ZZ Smoke default',
      slug: `zz-smoke-default-${Date.now()}`,
      originalPrice: 50,
      price: 50,
      weight: 1,
      published: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tmpProducts.push(plain.insertedId);

    const built = await variantsService.createDefaultVariant(String(plain.insertedId), ctx.storeId, 4);
    assert(built.variantsCreated === 1, 'the default variant was created');

    const matrix = await variantsService.getMatrix(String(plain.insertedId), ctx.storeId);
    assert(matrix.variants.length === 1, 'the matrix offers exactly the default variant');
    assert(matrix.variants[0].available === 4, 'the default balance is the stock source');

    const order = await ordersService.create(
      {
        storeId: String(ctx.storeId),
        vendorEmail: ctx.store.vendorEmail,
        shippingMethod: 'stopdesk',
        ...(courierForOrders ? { deliveryCompanyId: courierForOrders } : {}),
        total: 100,
        customer: { name: 'Smoke', phone: '0555000000', wilaya: '16', commune: 'Alger Centre' },
        items: [
          {
            productId: String(plain.insertedId),
            productName: 'ZZ Smoke default',
            quantity: 2,
            price: 50,
            variantId: matrix.variants[0].variantId,
          },
        ],
      },
      ctx.vendorUser,
    );
    tmpOrders.push(order._id);

    await ordersService.update(String(order._id), { status: 'confirmed' }, ctx.vendorUser);
    await ordersService.update(String(order._id), { status: 'dispatched' }, ctx.vendorUser);

    const after = await balanceOf(matrix.variants[0].variantId);
    assert(after.onHand === 2, `dispatch consumed the default balance (${after.onHand})`);
    assert(after.reserved === 0, 'the reservation was consumed');
    assert(
      (await movementsFor(order._id)).filter((m) => m.type === 'fulfillment_deduction').length === 1,
      'one fulfillment deduction for the default-variant order',
    );

    // Products own no stock, so a line without a variantId has nothing to reserve or fulfill.
    const noVariant = await errOf(() =>
      ordersService.create(
        {
          storeId: String(ctx.storeId),
          vendorEmail: ctx.store.vendorEmail,
          shippingMethod: 'stopdesk',
          total: 50,
          customer: { name: 'Smoke', phone: '0555000000', wilaya: '16', commune: 'Alger Centre' },
          items: [
            { productId: String(plain.insertedId), productName: 'ZZ Smoke default', quantity: 1, price: 50 },
          ],
        },
        ctx.vendorUser,
      ),
    );
    assert(
      noVariant?.errorCode === 'VALIDATION_REQUIRED',
      `a line without a variantId is refused (${noVariant?.errorCode})`,
    );
    const bareProduct = await db.collection('products').findOne({ _id: plain.insertedId });
    assert(
      bareProduct.stock === undefined,
      'the product document itself holds no stock field',
    );
  }

  // ---------------------------------------------------------------------------------
  console.log('\ntenant isolation');
  {
    const other = await db.collection('stores').findOne({ _id: { $ne: ctx.store._id } });
    if (!other) {
      console.log('  skip  only one store exists, cannot test cross-store access');
    } else {
      // An order that names another store's variant must be refused at creation.
      const crossStore = await errOf(async () => {
        const order = await ordersService.create(
          {
            storeId: String(ctx.storeId),
            vendorEmail: ctx.store.vendorEmail,
            shippingMethod: 'stopdesk',
            total: 100,
            customer: { name: 'Smoke', phone: '0555000000', wilaya: '16', commune: 'Alger Centre' },
            items: [
              {
                productId: String(ctx.productId),
                productName: 'ZZ Smoke',
                quantity: 1,
                price: 100,
                variantId: new Types.ObjectId().toHexString(),
              },
            ],
          },
          ctx.vendorUser,
        );
        tmpOrders.push(order._id);
      });
      assert(
        crossStore?.errorCode === 'VARIANT_NOT_FOUND',
        `an unknown variant is refused rather than reserved (${crossStore?.errorCode})`,
      );

      // Reserving a variant that belongs to a different store is refused as not-found, so the
      // endpoint cannot be used to probe which ids exist.
      const probe = await errOf(() =>
        reservationsService.reserve(
          {
            orderId: new Types.ObjectId(),
            orderNo: '000000',
            storeId: new Types.ObjectId(other._id),
            items: [{ variantId: v['Small-Red'].variantId, quantity: 1 }],
          },
          null,
        ),
      );
      assert(
        probe?.errorCode === 'VARIANT_NOT_FOUND',
        `cross-store reserve is refused as not-found (${probe?.errorCode})`,
      );
    }
  }

  // ---------------------------------------------------------------------------------
  console.log('\n4.10 product deletion cascade + reservation block');
  {
    const { ProductsService } = require('../dist/modules/products/products.service');
    const productsService = app.get(ProductsService);

    // A product with a live reservation must refuse deletion (spec Â§7.5).
    const busyCtx = await makeVariantProduct('busy', {}, 100);
    const busyVariant = busyCtx.variants['Small-Red'];
    const busyOrder = await placeOrder(busyCtx, [
      { label: 'busy', variantId: busyVariant.variantId, quantity: 2, price: 100 },
    ]);
    await busyOrder; // placed
    await ordersService.update(String(busyOrder._id), { status: 'confirmed' }, {
      id: String(busyCtx.store.vendorId), email: busyCtx.store.vendorEmail, role: 'VENDOR', fullName: 'Smoke',
    });

    const blocked = await errOf(() =>
      productsService.remove(String(busyCtx.productId), busyCtx.store.vendorEmail),
    );
    assert(
      blocked?.errorCode === 'PRODUCT_CANNOT_DELETE_HAS_ORDERS' ||
        blocked?.errorCode === 'VARIANT_HAS_RESERVED_STOCK',
      `deleting a product with a live reservation is refused (${blocked?.errorCode})`,
    );
    const survived = await db.collection('products').findOne({ _id: busyCtx.productId });
    assert(!!survived, 'the product still exists after the refusal');

    // An unsold product deletes cleanly and takes its matrix with it.
    const spareCtx = await makeVariantProduct('spare', {}, 100);
    const spareVariantsBefore = await db.collection(COL.variants)
      .countDocuments({ productId: spareCtx.productId, isDeleted: { $ne: true } });
    assert(spareVariantsBefore === 4, `the spare product has 4 live variants (${spareVariantsBefore})`);

    await productsService.remove(String(spareCtx.productId), spareCtx.store.vendorEmail);

    const gone = await db.collection('products').findOne({ _id: spareCtx.productId });
    assert(!gone, 'the unsold product was deleted');
    const variantsAfter = await db.collection(COL.variants)
      .find({ productId: spareCtx.productId }).toArray();
    assert(
      variantsAfter.every((v) => v.isDeleted === true),
      'its variants were soft-deleted, not orphaned',
    );
    const joinsAfter = await db.collection(COL.joins).countDocuments({ productId: spareCtx.productId });
    assert(joinsAfter === 0, `its join rows were removed (${joinsAfter})`);
  }

  console.log(`\n[SMOKE] ${passed} assertions passed`);
}

async function cleanup() {
  for (const orderId of tmpOrders) {
    await db.collection(COL.movements).deleteMany({ orderId });
    await db.collection(COL.reservations).deleteMany({ orderId });
    await db.collection('orders').deleteOne({ _id: orderId });
  }

  for (const productId of tmpProducts) {
    const variantIds = (await db.collection(COL.variants).find({ productId }).toArray()).map((v) => v._id);
    await db.collection(COL.movements).deleteMany({ variantId: { $in: variantIds } });
    await db.collection(COL.reservations).deleteMany({ variantId: { $in: variantIds } });
    await db.collection(COL.balances).deleteMany({ variantId: { $in: variantIds } });
    await db.collection(COL.joins).deleteMany({ variantId: { $in: variantIds } });
    await db.collection(COL.variants).deleteMany({ productId });
    await db.collection(COL.optionValues).deleteMany({ productId });
    await db.collection(COL.options).deleteMany({ productId });
    await db.collection('products').deleteOne({ _id: productId });
  }

  console.log('\n[SMOKE] cleanup complete');
}

main()
  .catch((e) => {
    console.error('\n[SMOKE] ERROR:', e.message, '\n', e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (db && tmpProducts.length) {
      await cleanup().catch((e) => console.error('cleanup failed:', e.message));
    }
    if (app) await app.close();
    console.log(process.exitCode ? '\n[SMOKE] FAILED' : '\n[SMOKE] ALL CHECKS PASSED');
  });
