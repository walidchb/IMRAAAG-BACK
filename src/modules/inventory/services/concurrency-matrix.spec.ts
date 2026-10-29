import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types, ClientSession } from 'mongoose';
import { ReservationsService, OrderInventoryContext } from './reservations.service';
import { InventoryService, SetOnHandInput, AdjustDeltaInput } from './inventory.service';
import { MovementsService } from './movements.service';
import { InventoryReservation } from '../schemas/inventory-reservation.schema';
import { InventoryBalance, InventoryBalanceDocument } from '../schemas/inventory-balance.schema';
import { ProductVariant } from '../schemas/product-variant.schema';
import { Order } from '../../orders/schemas/order.schema';
import { Product } from '../../products/schemas/product.schema';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

/**
 * Concurrency matrix (roadmap Phase 7, DoD "reservations + orders cover the concurrency
 * matrix"): reserve-vs-adjust and consume-vs-return, driven through the REAL
 * ReservationsService and the REAL InventoryService against one shared in-memory balance.
 *
 * The fake balance is CAS-faithful: `findOneAndUpdate` matches the caller's predicate
 * (equality, `$gte`, `$lte`) against the CURRENT row and only then applies `$inc`/`$set`,
 * exactly like MongoDB's findAndModify. That is the whole point — every safety rule in
 * these two services lives in the predicate, not in a prior read, so a test that mocks
 * results instead of evaluating predicates would pass while the rules were broken.
 *
 * Races are orchestrated with one-shot hooks that fire just before a CAS: the "concurrent"
 * operation runs to completion inside the hook, against the same row the victim already
 * pre-read, and the victim's CAS then sees (or fails to see) the result. This models the
 * serializable outcome a real transaction would produce after a write-conflict retry.
 *
 * Cells covered here (✘ = refused with nothing written):
 *   reserve vs adjust ─ setOnHand below reserved ✘ · boundary setOnHand at reserved ✓
 *                        positive adjust while reserved ✓ · adjust ∥ adjust (lost update ✘)
 *                        reserve ∥ reserve on last units ✘
 *   consume vs return ─ full sequence reserve→consume→restock ✓ · return before dispatch ✘
 *                        duplicate receipt idempotent ✓ · write-off leaves onHand alone ✓
 *                        release ∥ consume (both orders) — exactly one applies ✓
 */

const STORE_ID = new Types.ObjectId();
const VARIANT_ID = new Types.ObjectId();
const BALANCE_ID = new Types.ObjectId();
const ORDER_A = new Types.ObjectId();
const ORDER_B = new Types.ObjectId();
const ACTOR_ID = new Types.ObjectId();
const SESSION = {} as ClientSession;

const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

/** Equality + `$gte`/`$lte` matcher — the subset of Mongo predicates these services use. */
const matches = (doc: Record<string, any>, filter: Record<string, any>): boolean => {
  for (const [key, cond] of Object.entries(filter)) {
    const value = doc[key];
    if (cond !== null && typeof cond === 'object' && (cond.$gte !== undefined || cond.$lte !== undefined)) {
      if (cond.$gte !== undefined && !(value >= cond.$gte)) return false;
      if (cond.$lte !== undefined && !(value <= cond.$lte)) return false;
    } else if (String(value) !== String(cond)) {
      return false;
    }
  }
  return true;
};

describe('Concurrency matrix — reserve/adjust × consume/return', () => {
  let reservations: ReservationsService;
  let inventory: InventoryService;

  let balances: Array<Record<string, any>>;
  let reservations2: Array<Record<string, any>>;
  let ledger: Array<Record<string, any>>;
  let movementKeys: Set<string>;
  let orderWrites: Array<Record<string, any>>;

  let balanceModel: any;
  let reservationModel: any;
  let variantModel: any;
  let orderModel: any;
  let movements: { append: jest.Mock; hasMovement: jest.Mock; listForOrder: jest.Mock };

  /** One-shot orchestration points, consumed before the corresponding CAS. */
  const hooks: { beforeBalanceCas?: () => Promise<void>; beforeReservationCas?: () => Promise<void> } = {};

  const cas = (filter: Record<string, any>, update: Record<string, any>): Record<string, any> | null => {
    const doc = balances.find((b) => matches(b, filter));
    if (!doc) return null;
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] ?? 0) + (v as number);
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) doc[k] = v;
    return { ...doc };
  };

  const hooked = (hook: keyof typeof hooks, run: () => Record<string, any> | null) => {
    const exec = async () => {
      if (hooks[hook]) {
        const fn = hooks[hook]!;
        delete hooks[hook];
        await fn();
      }
      return run();
    };
    const q: any = {};
    for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
      q[m] = jest.fn().mockReturnValue(q);
    }
    q.exec = exec;
    return q;
  };

  const balanceRow = (over: Record<string, unknown> = {}) => ({
    _id: BALANCE_ID,
    storeId: STORE_ID,
    variantId: VARIANT_ID,
    onHand: 10,
    reserved: 0,
    ...over,
  });

  const reservationRow = (over: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    storeId: STORE_ID,
    orderId: ORDER_A,
    variantId: VARIANT_ID,
    orderItemIndex: 0,
    quantity: 4,
    status: 'active',
    ...over,
  });

  const ctx = (order: Types.ObjectId, overrides: Partial<OrderInventoryContext> = {}): OrderInventoryContext => ({
    orderId: order,
    orderNo: `ORD-${order.toString().slice(-6)}`,
    storeId: STORE_ID,
    items: [{ lineId: 'line-1', variantId: VARIANT_ID.toString(), productId: 'p-1', quantity: 4 }],
    ...overrides,
  });

  const balance = () => ({ ...balances[0] });
  const types = () => ledger.map((m) => m.type);

  const seed = ({ onHand = 10, reserved = 0, reservationStatus }: { onHand?: number; reserved?: number; reservationStatus?: 'active' | 'consumed' } = {}) => {
    balances = [balanceRow({ onHand, reserved })];
    reservations2 = reservationStatus ? [reservationRow({ status: reservationStatus, quantity: 4 })] : [];
  };

  beforeEach(async () => {
    balances = [];
    reservations2 = [];
    ledger = [];
    movementKeys = new Set();
    orderWrites = [];

    balanceModel = {
      findOne: jest.fn().mockImplementation((filter: any) => query(balances.find((b) => matches(b, filter)) ?? null)),
      findOneAndUpdate: jest.fn().mockImplementation((filter: any, update: any) =>
        hooked('beforeBalanceCas', () => cas(filter, update)),
      ),
      find: jest.fn().mockReturnValue(query([])),
      startSession: jest.fn(),
    };

    reservationModel = jest.fn().mockImplementation((data: any) => ({
      ...data,
      save: jest.fn().mockImplementation(async () => {
        const row = { ...data, _id: new Types.ObjectId() };
        reservations2.push(row);
        return { ...row };
      }),
    }));
    reservationModel.findOne = jest
      .fn()
      .mockImplementation((filter: any) => query(reservations2.find((r) => matches(r, filter)) ?? null));
    reservationModel.find = jest
      .fn()
      .mockImplementation((filter: any) => query(reservations2.filter((r) => matches(r, filter))));
    reservationModel.findOneAndUpdate = jest.fn().mockImplementation((filter: any, update: any) =>
      hooked('beforeReservationCas', () => casOn(reservations2, filter, update)),
    );

    const casOn = (rows: Array<Record<string, any>>, filter: Record<string, any>, update: Record<string, any>) => {
      const doc = rows.find((r) => matches(r, filter));
      if (!doc) return null;
      if (update.$set) for (const [k, v] of Object.entries(update.$set)) doc[k] = v;
      return { ...doc };
    };

    variantModel = {
      findOne: jest.fn().mockReturnValue(
        query({ _id: VARIANT_ID, storeId: STORE_ID, isActive: true, sku: 'SKU-1' }),
      ),
      findById: jest
        .fn()
        .mockReturnValue(query({ _id: VARIANT_ID, storeId: STORE_ID, isDeleted: false })),
    };
    orderModel = {
      updateOne: jest.fn().mockImplementation((filter: any, update: any) => {
        orderWrites.push({ filter, update });
        return query(null);
      }),
    };
    movements = {
      append: jest.fn().mockImplementation(async (row: any) => {
        ledger.push(row);
        if (row.idempotencyKey) movementKeys.add(row.idempotencyKey);
      }),
      hasMovement: jest.fn().mockImplementation(async (key: string) => movementKeys.has(key)),
      listForOrder: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReservationsService,
        InventoryService,
        { provide: getModelToken(InventoryReservation.name), useValue: reservationModel },
        { provide: getModelToken(InventoryBalance.name), useValue: balanceModel },
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(Order.name), useValue: orderModel },
        { provide: getModelToken(Product.name), useValue: {} },
        { provide: MovementsService, useValue: movements },
      ],
    }).compile();

    reservations = module.get<ReservationsService>(ReservationsService);
    inventory = module.get<InventoryService>(InventoryService);
  });

  const adjust = (overrides: Partial<AdjustDeltaInput> = {}) =>
    inventory.adjustByDelta({
      storeId: STORE_ID,
      variantId: VARIANT_ID,
      delta: 5,
      reason: 'cycle count',
      session: SESSION,
      ...overrides,
    });

  const setOnHand = (quantity: number) =>
    inventory.setOnHand({
      storeId: STORE_ID,
      variantId: VARIANT_ID,
      quantity,
      reason: 'cycle count',
      session: SESSION,
    } as SetOnHandInput);

  // ------------------------------------------------------------ reserve vs adjust

  describe('reserve vs adjust', () => {
    it('a setOnHand at exactly the reserved boundary is allowed (available becomes 0)', async () => {
      seed({ onHand: 10 });
      await reservations.reserve(ctx(ORDER_A), ACTOR_ID, SESSION);
      expect(balance()).toMatchObject({ onHand: 10, reserved: 4 });

      const view = await setOnHand(4);
      expect(view).toMatchObject({ onHand: 4, reserved: 4, available: 0 });
      expect(balance()).toMatchObject({ onHand: 4, reserved: 4 });
      expect(movements.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'order_reservation' }));
    });

    it('✘ a setOnHand below the reserved floor loses the CAS — nothing written, no ledger row', async () => {
      seed({ onHand: 10 });
      await reservations.reserve(ctx(ORDER_A), ACTOR_ID, SESSION);
      const rowsBefore = ledger.length;

      await expect(setOnHand(3)).rejects.toMatchObject({
        errorCode: AppErrorCode.RESERVED_STOCK_CONFLICT,
      });
      expect(balance()).toMatchObject({ onHand: 10, reserved: 4 });
      expect(ledger).toHaveLength(rowsBefore);
    });

    it('a positive adjust while units are reserved is allowed (promised stock stays promised)', async () => {
      seed({ onHand: 10 });
      await reservations.reserve(ctx(ORDER_A), ACTOR_ID, SESSION);

      await adjust({ delta: 5 });
      expect(balance()).toMatchObject({ onHand: 15, reserved: 4 });
    });

    it('✘ adjust ∥ adjust on the same pre-read: exactly one CAS wins, no lost update', async () => {
      seed({ onHand: 10 });

      // The second adjustment runs to completion between the first one's pre-read and its CAS,
      // so both pre-read onHand=10 — the classic lost-update shape.
      hooks.beforeBalanceCas = async () => {
        await adjust({ delta: 7 });
      };

      await expect(adjust({ delta: 5 })).rejects.toMatchObject({
        errorCode: AppErrorCode.RESERVED_STOCK_CONFLICT,
      });
      expect(balance().onHand).toBe(17); // 10 + 7: the winner's delta, once
      expect(types().filter((t) => t === 'manual_increase')).toHaveLength(1);
    });

    it('✘ reserve ∥ reserve for the last units: the second CAS fails on reserved', async () => {
      seed({ onHand: 5 });

      // Both lines pre-check availability=5 ≥ 4; the CAS on {onHand:5, reserved:0} is the gate.
      hooks.beforeBalanceCas = async () => {
        await reservations.reserve(ctx(ORDER_B), ACTOR_ID, SESSION);
      };

      await expect(reservations.reserve(ctx(ORDER_A), ACTOR_ID, SESSION)).rejects.toMatchObject({
        errorCode: AppErrorCode.RESERVED_STOCK_CONFLICT,
      });
      expect(balance()).toMatchObject({ onHand: 5, reserved: 4 }); // sold exactly once
      expect(reservations2.filter((r) => r.status === 'active')).toHaveLength(1);
      expect(types().filter((t) => t === 'order_reservation')).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------- consume vs return

  describe('consume vs return', () => {
    it('full sequence: reserve → dispatch-consume → restock-return restores onHand exactly', async () => {
      seed({ onHand: 10 });
      await reservations.reserve(ctx(ORDER_A), ACTOR_ID, SESSION);

      await reservations.consume(ctx(ORDER_A), ACTOR_ID, SESSION);
      expect(balance()).toMatchObject({ onHand: 6, reserved: 0 });

      const results = await reservations.receiveReturn(
        ctx(ORDER_A),
        [{ orderItemIndex: 0, disposition: 'restock' }],
        ACTOR_ID,
        SESSION,
      );
      expect(results).toEqual([expect.objectContaining({ applied: true, quantity: 4, disposition: 'restock' })]);
      expect(balance()).toMatchObject({ onHand: 10, reserved: 0 });

      const deduction = ledger.find((m) => m.type === 'fulfillment_deduction');
      expect(deduction).toMatchObject({
        quantityDelta: -4,
        onHandBefore: 10,
        onHandAfter: 6,
        reservedBefore: 4,
        reservedAfter: 0,
      });
      const restock = ledger.find((m) => m.type === 'return_restock');
      expect(restock).toMatchObject({
        quantityDelta: 4,
        onHandBefore: 6,
        onHandAfter: 10,
        reservedBefore: 0,
        reservedAfter: 0,
      });
    });

    it('✘ a return receipt before dispatch is refused and writes nothing', async () => {
      seed({ onHand: 10, reservationStatus: 'active' });

      await expect(
        reservations.receiveReturn(ctx(ORDER_A), [{ orderItemIndex: 0, disposition: 'restock' }], ACTOR_ID, SESSION),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_ALREADY_FULFILLED });

      expect(balance()).toMatchObject({ onHand: 10, reserved: 0 });
      expect(ledger).toHaveLength(0);
      expect(movements.append).not.toHaveBeenCalled();
    });

    it('a retried receipt is idempotent: restock applies once, second attempt reports already_recorded', async () => {
      seed({ onHand: 10, reservationStatus: 'consumed' });
      // consume already ran in reality: simulate its deduction for a dispatched line.
      balances[0].onHand = 6;

      const first = await reservations.receiveReturn(
        ctx(ORDER_A),
        [{ orderItemIndex: 0, disposition: 'restock' }],
        ACTOR_ID,
        SESSION,
      );
      const second = await reservations.receiveReturn(
        ctx(ORDER_A),
        [{ orderItemIndex: 0, disposition: 'restock' }],
        ACTOR_ID,
        SESSION,
      );

      expect(first[0].applied).toBe(true);
      expect(second[0]).toMatchObject({ applied: false, reason: 'already_recorded' });
      expect(balance().onHand).toBe(10); // +4 exactly once
      expect(types().filter((t) => t === 'return_restock')).toHaveLength(1);
    });

    it('a write-off receipt records damage and leaves onHand untouched', async () => {
      seed({ onHand: 10, reservationStatus: 'consumed' });
      balances[0].onHand = 6;

      const results = await reservations.receiveReturn(
        ctx(ORDER_A),
        [{ orderItemIndex: 0, disposition: 'write_off', note: 'crushed box' }],
        ACTOR_ID,
        SESSION,
      );

      expect(results[0]).toMatchObject({ applied: true, disposition: 'write_off' });
      expect(balance().onHand).toBe(6); // damaged goods never become sellable again
      const writeOff = ledger.find((m) => m.type === 'damage_write_off');
      expect(writeOff).toMatchObject({ quantityDelta: 0, onHandBefore: 6, onHandAfter: 6 });
    });

    it('release ∥ consume (cancel wins the flip): stock is released, never deducted', async () => {
      seed({ onHand: 10 });
      await reservations.reserve(ctx(ORDER_A), ACTOR_ID, SESSION);

      // consume has already read the active reservation; the cancel lands before its flip.
      hooks.beforeReservationCas = async () => {
        await reservations.release(ctx(ORDER_A), ACTOR_ID, SESSION);
      };

      await reservations.consume(ctx(ORDER_A), ACTOR_ID, SESSION);

      expect(balance()).toMatchObject({ onHand: 10, reserved: 0 }); // promised units returned, none deducted
      expect(reservations2[0].status).toBe('released');
      expect(types()).toContain('reservation_release');
      expect(types()).not.toContain('fulfillment_deduction');
    });

    it('consume ∥ release (dispatch wins the flip): stock is deducted once, release is a no-op', async () => {
      seed({ onHand: 10 });
      await reservations.reserve(ctx(ORDER_A), ACTOR_ID, SESSION);

      // release has already read the active reservation; dispatch lands before its flip.
      hooks.beforeReservationCas = async () => {
        await reservations.consume(ctx(ORDER_A), ACTOR_ID, SESSION);
      };

      await reservations.release(ctx(ORDER_A), ACTOR_ID, SESSION);

      expect(balance()).toMatchObject({ onHand: 6, reserved: 0 }); // deducted exactly once
      expect(reservations2[0].status).toBe('consumed');
      expect(types()).toContain('fulfillment_deduction');
      expect(types()).not.toContain('reservation_release');
    });
  });
});
