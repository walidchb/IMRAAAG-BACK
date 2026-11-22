import { buildFunnel, FunnelOrderInput } from './order-funnel';

function order(overrides: FunnelOrderInput = {}): FunnelOrderInput {
  return {
    statusSlug: 'placed',
    historySlugs: ['placed'],
    confirmedAt: null,
    dispatchedAt: null,
    ...overrides,
  };
}

describe('buildFunnel', () => {
  it('counts a placed-only order in received only', () => {
    expect(buildFunnel([order()])).toEqual({
      received: 1,
      confirmed: 0,
      dispatched: 0,
      delivered: 0,
    });
  });

  it('counts a confirmed order in received + confirmed', () => {
    expect(buildFunnel([order({ statusSlug: 'confirmed', historySlugs: ['placed', 'confirmed'] })])).toEqual({
      received: 1,
      confirmed: 1,
      dispatched: 0,
      delivered: 0,
    });
  });

  it('infers confirmed + dispatched from a current dispatched status with no history', () => {
    expect(buildFunnel([order({ statusSlug: 'dispatched', historySlugs: [] })])).toEqual({
      received: 1,
      confirmed: 1,
      dispatched: 1,
      delivered: 0,
    });
  });

  it('counts a delivered order in all four stages', () => {
    expect(buildFunnel([order({ statusSlug: 'delivered', historySlugs: [] })])).toEqual({
      received: 1,
      confirmed: 1,
      dispatched: 1,
      delivered: 1,
    });
  });

  it('counts a returned order with dispatched history as not delivered', () => {
    expect(
      buildFunnel([
        order({ statusSlug: 'returned', historySlugs: ['placed', 'confirmed', 'dispatched', 'returned'] }),
      ]),
    ).toEqual({ received: 1, confirmed: 1, dispatched: 1, delivered: 0 });
  });

  it('counts a returned order with a delivered history entry as delivered', () => {
    expect(
      buildFunnel([
        order({
          statusSlug: 'returned',
          historySlugs: ['placed', 'confirmed', 'dispatched', 'delivered', 'returned'],
        }),
      ]),
    ).toEqual({ received: 1, confirmed: 1, dispatched: 1, delivered: 1 });
  });

  it('counts an order cancelled after confirmation in received + confirmed', () => {
    expect(
      buildFunnel([
        order({ statusSlug: 'cancelled', historySlugs: ['placed', 'confirmed', 'cancelled'] }),
      ]),
    ).toEqual({ received: 1, confirmed: 1, dispatched: 0, delivered: 0 });
  });

  it('uses timestamps when history is missing', () => {
    expect(
      buildFunnel([
        order({
          statusSlug: 'placed',
          historySlugs: [],
          confirmedAt: '2026-10-01T10:00:00.000Z',
          dispatchedAt: '2026-10-02T10:00:00.000Z',
        }),
      ]),
    ).toEqual({ received: 1, confirmed: 1, dispatched: 1, delivered: 0 });
  });

  it('counts a POS order with full history in all four stages', () => {
    expect(
      buildFunnel([
        order({
          statusSlug: 'delivered',
          historySlugs: ['placed', 'confirmed', 'dispatched', 'delivered'],
          confirmedAt: '2026-10-01T10:00:00.000Z',
          dispatchedAt: '2026-10-01T10:00:00.000Z',
        }),
      ]),
    ).toEqual({ received: 1, confirmed: 1, dispatched: 1, delivered: 1 });
  });

  it('returns zeros for an empty cohort', () => {
    expect(buildFunnel([])).toEqual({ received: 0, confirmed: 0, dispatched: 0, delivered: 0 });
  });
});
