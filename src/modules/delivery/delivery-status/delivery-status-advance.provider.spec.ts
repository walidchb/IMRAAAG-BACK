import { OrdersService } from '../../orders/orders.service';
import { OrdersCarrierStatusAdvance } from './delivery-status-advance.provider';
import type { DeliveryStatusAdvanceRequest } from './delivery-status-advance.interface';

/**
 * The advance provider (roadmap Phase 4, task 4.2).
 *
 * The provider is the only thing in the platform that lets a carrier signal move an order. It
 * is deliberately thin: it must not decide *whether* the order may move — that is the orders
 * module's conditional-claim discipline — it must only ask, and report the answer faithfully.
 * The reason matters as much as the outcome: the poller records it on the parcel-status
 * record so the vendor can see *why* the order did not follow the carrier (§10.4).
 */
const REQUEST: DeliveryStatusAdvanceRequest = {
  storeId: '6ac400e26b1b2c3d4e5f6a71',
  orderId: '6ac400e26b1b2c3d4e5f6a73',
  orderNo: 'ORD-1',
  parcelId: 'parcel-1',
  fromStatus: 'dispatched',
  toStatus: 'in-transit',
  deliveryStatus: 'in_transit',
  signal: 'in_transit',
  target: 'in-transit',
  steps: ['in-transit'],
  inventoryAware: false,
};

describe('OrdersCarrierStatusAdvance — the carrier’s advance provider (Phase 4)', () => {
  let ordersService: { applyCarrierOrderAction: jest.Mock };
  let provider: OrdersCarrierStatusAdvance;

  beforeEach(() => {
    ordersService = {
      applyCarrierOrderAction: jest.fn().mockResolvedValue({
        applied: true,
        fromStatus: 'dispatched',
        toStatus: 'in-transit',
        orderNo: 'ORD-1',
      }),
    };
    provider = new OrdersCarrierStatusAdvance(ordersService as unknown as OrdersService);
  });

  it('asks the orders module for the guarded advance, never writing the order itself', async () => {
    await provider.advance(REQUEST);

    expect(ordersService.applyCarrierOrderAction).toHaveBeenCalledTimes(1);
    const [orderId, action, expectedSlug, actor, options] =
      ordersService.applyCarrierOrderAction.mock.calls[0];

    expect(orderId).toBe(REQUEST.orderId);
    expect(action).toEqual({ target: 'in-transit', steps: ['in-transit'] });
    expect(expectedSlug).toBe('dispatched');
    expect(actor.user).toBe('ZR Express');
    expect(options.storeId).toBe(REQUEST.storeId);
  });

  it('attributes an Ecom advance to Ecom Delivery, not ZR Express (§E4)', async () => {
    await provider.advance({ ...REQUEST, companyId: 'ecom-delivery' });

    const [, , , actor] = ordersService.applyCarrierOrderAction.mock.calls[0];
    expect(actor.user).toBe('Ecom Delivery');
    expect(actor.system).toBe('ecom-delivery-sync');
  });

  it('reports an applied advance', async () => {
    const result = await provider.advance(REQUEST);

    expect(result.outcome).toBe('advanced');
    expect(result.fromStatus).toBe('dispatched');
    expect(result.toStatus).toBe('in-transit');
  });

  it('reports a conflict with the reason the orders module gave', async () => {
    ordersService.applyCarrierOrderAction.mockResolvedValue({
      applied: false,
      conflict: true,
      reason: 'order_cancelled_before_delivery',
      fromStatus: 'cancelled',
      toStatus: 'in-transit',
    });

    const result = await provider.advance(REQUEST);

    expect(result.outcome).toBe('conflict');
    expect(result.reason).toBe('order_cancelled_before_delivery');
  });

  it('reports a refusal as a skip, with its reason', async () => {
    ordersService.applyCarrierOrderAction.mockResolvedValue({
      applied: false,
      reason: 'order_not_in_store',
      fromStatus: 'dispatched',
      toStatus: 'in-transit',
    });

    const result = await provider.advance(REQUEST);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('order_not_in_store');
  });

  it('hands the caller’s transaction to the orders module', async () => {
    const session = { id: 'session-1' } as never;

    await provider.advance(REQUEST, session);

    const [, , , , options] = ordersService.applyCarrierOrderAction.mock.calls[0];
    expect(options.session).toBe(session);
  });
});
