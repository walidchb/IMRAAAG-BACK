import { CARRIER_STATES } from './zr-status.mapper';
import {
  ALL_SIGNAL_FIXTURES,
  CANCEL_SIGNAL_FIXTURES,
  CORE_STATE_SIGNAL_FIXTURES,
  HISTORY_PRECEDENCE_FIXTURES,
  RETURN_SIGNAL_FIXTURES,
  UNKNOWN_SIGNAL_FIXTURES,
} from './__fixtures__/zr-status.fixtures';

const SIGNALS = ['none', 'in_transit', 'delivered', 'cancelled', 'returned'];
const ORDER_STATUSES = [
  'placed',
  'confirmed',
  'dispatched',
  'in-transit',
  'delivered',
  'cancelled',
  'returned',
];

describe('the Phase 0 ZR signal fixtures', () => {
  it('covers every one of the 14 core carrier states exactly once', () => {
    const coreSlugs = CARRIER_STATES.map((state) => state.slug);
    const fixtureSlugs = CORE_STATE_SIGNAL_FIXTURES.map((fixture) => fixture.parcel.state?.name);

    expect(CORE_STATE_SIGNAL_FIXTURES).toHaveLength(coreSlugs.length);
    expect(new Set(fixtureSlugs).size).toBe(fixtureSlugs.length);
    expect(new Set(fixtureSlugs)).toEqual(new Set(coreSlugs));
  });

  it('has a unique, descriptive name for every fixture', () => {
    const names = ALL_SIGNAL_FIXTURES.map((fixture) => fixture.name);

    expect(names.every((name) => name.trim().length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has a well-formed parcel, history and expectation for every fixture', () => {
    for (const fixture of ALL_SIGNAL_FIXTURES) {
      expect(fixture.parcel.id).toBeTruthy();
      expect(fixture.parcel.state?.name).toBeTruthy();
      expect(Array.isArray(fixture.history)).toBe(true);
      expect(SIGNALS).toContain(fixture.expectedSignal);
      expect(ORDER_STATUSES).toContain(fixture.orderStatus);
      expect(
        fixture.expectedTarget === null || ORDER_STATUSES.includes(fixture.expectedTarget),
      ).toBe(true);
    }
  });

  it('covers every signal the detector must support', () => {
    const signals = new Set(ALL_SIGNAL_FIXTURES.map((fixture) => fixture.expectedSignal));

    expect(signals).toEqual(new Set(SIGNALS));
  });

  it('covers cancellation, returns, unknown states, overrides and history precedence', () => {
    expect(CANCEL_SIGNAL_FIXTURES.length).toBeGreaterThanOrEqual(3);
    expect(RETURN_SIGNAL_FIXTURES.length).toBeGreaterThanOrEqual(4);
    expect(UNKNOWN_SIGNAL_FIXTURES.length).toBeGreaterThanOrEqual(1);
    expect(HISTORY_PRECEDENCE_FIXTURES).toHaveLength(1);

    expect(
      RETURN_SIGNAL_FIXTURES.some(
        (fixture) => Object.values(fixture.signalOverrides ?? {}).includes('returned'),
      ),
    ).toBe(true);
    expect(
      CANCEL_SIGNAL_FIXTURES.some((fixture) => fixture.expectedTarget === null),
    ).toBe(true);
  });

  it('keeps the early intake states inert and starts in-transit at pret_a_expedier', () => {
    const early = CORE_STATE_SIGNAL_FIXTURES.slice(0, 5);
    const advanced = CORE_STATE_SIGNAL_FIXTURES.slice(5, 11);

    expect(early.map((fixture) => fixture.expectedSignal)).toEqual([
      'none',
      'none',
      'none',
      'none',
      'none',
    ]);
    expect(advanced.map((fixture) => fixture.expectedSignal)).toEqual(
      Array.from({ length: 6 }, () => 'in_transit'),
    );
  });

  it('allows a direct carrier delivery to apply two steps in one cycle', () => {
    const direct = CORE_STATE_SIGNAL_FIXTURES.find(
      (fixture) => fixture.parcel.state?.name === 'livre',
    );

    expect(direct?.orderStatus).toBe('dispatched');
    expect(direct?.expectedTarget).toBe('delivered');
  });
});
