import { ANALYTICS_TIMEZONE } from '../constants/analytics.constants';
import {
  startOfDayInTz,
  startOfMonthInTz,
  startOfNextDayInTz,
  startOfNextMonthInTz,
  previousPeriod,
  resolveAnalyticsRange,
} from './date-range';

/**
 * `now` is chosen so the Algiers calendar date (UTC+1) is unambiguous:
 * 2026-06-15 10:30 UTC = 2026-06-15 11:30 Algiers.
 */
const NOW = new Date('2026-06-15T10:30:00.000Z');

const iso = (d: Date) => d.toISOString();
const resolve = (input: Parameters<typeof resolveAnalyticsRange>[0]) =>
  resolveAnalyticsRange({ ...input, now: NOW });

describe('date-range boundaries (Africa/Algiers, UTC+1)', () => {
  it('anchors the day boundary one hour before UTC midnight', () => {
    expect(iso(startOfDayInTz(NOW))).toBe('2026-06-14T23:00:00.000Z');
    expect(iso(startOfNextDayInTz(NOW))).toBe('2026-06-15T23:00:00.000Z');
  });

  it('anchors the month boundary correctly', () => {
    expect(iso(startOfMonthInTz(NOW))).toBe('2026-05-31T23:00:00.000Z');
    expect(iso(startOfNextMonthInTz(NOW))).toBe('2026-06-30T23:00:00.000Z');
  });
});

describe('resolveAnalyticsRange presets', () => {
  const cases: Array<[string, string, string]> = [
    ['today', '2026-06-14T23:00:00.000Z', '2026-06-15T23:00:00.000Z'],
    ['yesterday', '2026-06-13T23:00:00.000Z', '2026-06-14T23:00:00.000Z'],
    ['7d', '2026-06-08T23:00:00.000Z', '2026-06-15T23:00:00.000Z'],
    ['30d', '2026-05-16T23:00:00.000Z', '2026-06-15T23:00:00.000Z'],
    ['month', '2026-05-31T23:00:00.000Z', '2026-06-30T23:00:00.000Z'],
  ];

  it.each(cases)('%s resolves to the expected half-open window', (preset, from, to) => {
    const range = resolve({ preset });
    expect(iso(range.from)).toBe(from);
    expect(iso(range.to)).toBe(to);
    expect(range.preset).toBe(preset);
    expect(range.timezone).toBe(ANALYTICS_TIMEZONE);
  });

  it('defaults to 30d when no preset is given', () => {
    const range = resolve({});
    expect(range.preset).toBe('30d');
    expect(iso(range.from)).toBe('2026-05-16T23:00:00.000Z');
  });

  it('defaults to 30d when the preset is unknown', () => {
    expect(resolve({ preset: 'last-quarter' }).preset).toBe('30d');
  });

  it('every preset window is strictly positive', () => {
    for (const [preset] of cases) {
      const range = resolve({ preset });
      expect(range.to.getTime()).toBeGreaterThan(range.from.getTime());
    }
  });
});

describe('resolveAnalyticsRange custom bounds', () => {
  it('reads date-only bounds as Algiers calendar days (inclusive start, exclusive next-day end)', () => {
    const range = resolve({ preset: 'custom', from: '2026-01-01', to: '2026-01-31' });
    expect(range.preset).toBe('custom');
    expect(iso(range.from)).toBe('2025-12-31T23:00:00.000Z');
    expect(iso(range.to)).toBe('2026-01-31T23:00:00.000Z');
  });

  it('uses full ISO timestamps verbatim when a time is present', () => {
    const range = resolve({
      preset: 'custom',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });
    expect(iso(range.from)).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(range.to)).toBe('2026-02-01T00:00:00.000Z');
  });

  it('reads equal date-only bounds as a single Algiers day', () => {
    const range = resolve({ preset: 'custom', from: '2026-01-01', to: '2026-01-01' });
    expect(range.preset).toBe('custom');
    expect(iso(range.from)).toBe('2025-12-31T23:00:00.000Z');
    expect(iso(range.to)).toBe('2026-01-01T23:00:00.000Z');
  });

  it.each([
    ['missing both bounds', { preset: 'custom' }],
    ['only a start', { preset: 'custom', from: '2026-01-01' }],
    ['only an end', { preset: 'custom', to: '2026-01-31' }],
    ['inverted bounds', { preset: 'custom', from: '2026-02-01', to: '2026-01-01' }],
    ['a malformed bound', { preset: 'custom', from: 'nonsense', to: '2026-01-31' }],
  ])('falls back to the default preset for %s', (_label, input) => {
    const range = resolve(input);
    expect(range.preset).toBe('30d');
    expect(iso(range.from)).toBe('2026-05-16T23:00:00.000Z');
  });
});

describe('resolveAnalyticsRange bucket selection', () => {
  it.each([
    ['today', 'hour'],
    ['yesterday', 'hour'],
    ['7d', 'day'],
    ['30d', 'day'],
    ['month', 'day'],
  ])('%s defaults to the %s bucket', (preset, bucket) => {
    expect(resolve({ preset }).bucket).toBe(bucket);
  });

  it('defaults a custom range to daily buckets', () => {
    expect(resolve({ preset: 'custom', from: '2026-01-01', to: '2026-02-01' }).bucket).toBe('day');
  });

  it('honours an explicit valid bucket', () => {
    expect(resolve({ preset: '7d', bucket: 'week' }).bucket).toBe('week');
  });

  it('ignores an unknown bucket and takes the preset default', () => {
    expect(resolve({ preset: '7d', bucket: 'year' }).bucket).toBe('day');
  });
});

describe('previousPeriod', () => {
  it('returns the equal-length window immediately before the range', () => {
    const range = resolve({ preset: 'today' });
    const prev = previousPeriod(range);
    expect(iso(prev.to)).toBe('2026-06-14T23:00:00.000Z');
    expect(iso(prev.from)).toBe('2026-06-13T23:00:00.000Z');
  });

  it('keeps the duration identical', () => {
    const range = resolve({ preset: '7d' });
    const prev = previousPeriod(range);
    const span = range.to.getTime() - range.from.getTime();
    expect(prev.to.getTime() - prev.from.getTime()).toBe(span);
    expect(prev.to.getTime()).toBe(range.from.getTime());
  });
});
