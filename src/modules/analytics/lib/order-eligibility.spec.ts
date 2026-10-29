import { OrderSource } from '../../../common/constants/order-sources.const';
import { OrderStatus } from '../../../common/constants/order-statuses.const';
import {
  channelOf,
  countsTowardProcessing,
  isInChannel,
  isReturned,
  isSalesEligible,
  isSettled,
  isSoftDeleted,
  orderStatusSlug,
} from './order-eligibility';

describe('orderStatusSlug', () => {
  it('reads a bare string status', () => {
    expect(orderStatusSlug({ status: 'delivered' })).toBe('delivered');
  });

  it('reads an embedded status document', () => {
    expect(orderStatusSlug({ status: { slug: 'in-transit' } })).toBe('in-transit');
  });

  it('returns empty for a missing status', () => {
    expect(orderStatusSlug({})).toBe('');
    expect(orderStatusSlug({ status: null })).toBe('');
  });
});

describe('sales eligibility (D1)', () => {
  it('treats placed/confirmed/dispatched/in-transit/delivered as sales', () => {
    for (const status of [
      OrderStatus.PLACED,
      OrderStatus.CONFIRMED,
      OrderStatus.DISPATCHED,
      OrderStatus.IN_TRANSIT,
      OrderStatus.DELIVERED,
    ]) {
      expect(isSalesEligible({ status })).toBe(true);
    }
  });

  it('excludes cancelled orders', () => {
    expect(isSalesEligible({ status: OrderStatus.CANCELLED })).toBe(false);
  });

  it('excludes soft-deleted orders regardless of status', () => {
    expect(isSalesEligible({ status: OrderStatus.DELIVERED, isDeleted: true })).toBe(false);
  });

  it('counts a returned order as having sold (it is reversed separately, not cancelled)', () => {
    expect(isSalesEligible({ status: OrderStatus.RETURNED })).toBe(true);
  });
});

describe('settled / returned (D2)', () => {
  it('only delivered is settled', () => {
    expect(isSettled({ status: OrderStatus.DELIVERED })).toBe(true);
    expect(isSettled({ status: OrderStatus.IN_TRANSIT })).toBe(false);
    expect(isSettled({ status: OrderStatus.RETURNED })).toBe(false);
  });

  it('only returned is returned', () => {
    expect(isReturned({ status: OrderStatus.RETURNED })).toBe(true);
    expect(isReturned({ status: OrderStatus.DELIVERED })).toBe(false);
  });

  it('a deleted delivered order is neither settled nor returned', () => {
    expect(isSettled({ status: OrderStatus.DELIVERED, isDeleted: true })).toBe(false);
    expect(isReturned({ status: OrderStatus.RETURNED, isDeleted: true })).toBe(false);
  });

  it('flags only a true soft-delete', () => {
    expect(isSoftDeleted({ isDeleted: true })).toBe(true);
    expect(isSoftDeleted({ isDeleted: false })).toBe(false);
    expect(isSoftDeleted({})).toBe(false);
  });
});

describe('processing-time eligibility (D8)', () => {
  it('excludes POS (instantaneous) and keeps online/manual', () => {
    expect(countsTowardProcessing({ source: OrderSource.POS })).toBe(false);
    expect(countsTowardProcessing({ source: OrderSource.ONLINE })).toBe(true);
    expect(countsTowardProcessing({ source: OrderSource.MANUAL })).toBe(true);
  });
});

describe('channel mapping (D6)', () => {
  it.each([
    [OrderSource.ONLINE, 'online'],
    [OrderSource.POS, 'in-store'],
    [OrderSource.MANUAL, 'manual'],
    [undefined, 'unknown'],
    ['SOMETHING', 'unknown'],
  ])('maps %s to %s', (source, expected) => {
    expect(channelOf(source as string | undefined)).toBe(expected);
  });

  it('`all` accepts every order', () => {
    expect(isInChannel({ source: OrderSource.POS }, 'all')).toBe(true);
    expect(isInChannel({}, 'all')).toBe(true);
  });

  it('filters to a specific channel', () => {
    expect(isInChannel({ source: OrderSource.ONLINE }, 'online')).toBe(true);
    expect(isInChannel({ source: OrderSource.POS }, 'online')).toBe(false);
    expect(isInChannel({ source: OrderSource.POS }, 'in-store')).toBe(true);
  });
});
