import {
  ANALYTICS_BUCKETS,
  ANALYTICS_DEFAULT_BUCKET_BY_PRESET,
  ANALYTICS_DEFAULT_PRESET,
  ANALYTICS_RANGE_PRESETS,
  ANALYTICS_TIMEZONE,
  AnalyticsBucket,
  AnalyticsRangePreset,
} from '../constants/analytics.constants';

/**
 * Date-range resolution for analytics reads (roadmap Phase 0, decisions D4/D5).
 *
 * Every window is **half-open `[from, to)`** — an order created exactly at midnight belongs to
 * exactly one bucket, never two. All presets are anchored to `ANALYTICS_TIMEZONE`. Algeria
 * observes no DST, so the offset is a fixed +1h; the math below would need a real tz library
 * only if that ever changes.
 */

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
/** Fixed UTC offset of the platform timezone (Algiers = UTC+1, no DST). Exported so the
 * trend bucketing can format bucket keys (year/month/day/hour in Algiers) without re-deriving
 * the offset or reaching for a tz library. */
export const TZ_OFFSET_MS = 1 * MS_PER_HOUR;

export interface DateWindow {
  /** Inclusive start, as a UTC instant. */
  from: Date;
  /** Exclusive end, as a UTC instant. */
  to: Date;
}

export interface ResolvedAnalyticsRange extends DateWindow {
  preset: AnalyticsRangePreset;
  bucket: AnalyticsBucket;
  timezone: string;
}

export interface ResolveRangeInput {
  preset?: string | null;
  /** ISO 8601 string. Date-only (`YYYY-MM-DD`) is read as an Algiers calendar day. */
  from?: string | null;
  /** ISO 8601 string, exclusive end. Date-only is read as the end of that Algiers day. */
  to?: string | null;
  bucket?: string | null;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

function toTz(instant: Date): Date {
  return new Date(instant.getTime() + TZ_OFFSET_MS);
}

function fromTz(shifted: Date): Date {
  return new Date(shifted.getTime() - TZ_OFFSET_MS);
}

/** Start of the Algiers calendar day containing `instant`, as a UTC instant. */
export function startOfDayInTz(instant: Date): Date {
  const shifted = toTz(instant);
  shifted.setUTCHours(0, 0, 0, 0);
  return fromTz(shifted);
}

/** Start of the Algiers calendar day after the one containing `instant`. */
export function startOfNextDayInTz(instant: Date): Date {
  const shifted = toTz(instant);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() + 1);
  return fromTz(shifted);
}

/** Start of the Algiers calendar month containing `instant`. */
export function startOfMonthInTz(instant: Date): Date {
  const shifted = toTz(instant);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(1);
  return fromTz(shifted);
}

/** Start of the Algiers calendar month after the one containing `instant`. */
export function startOfNextMonthInTz(instant: Date): Date {
  const shifted = toTz(instant);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + 1);
  return fromTz(shifted);
}

/** Start of the Algiers clock-hour containing `instant`. */
export function startOfHourInTz(instant: Date): Date {
  const shifted = toTz(instant);
  shifted.setUTCMinutes(0, 0, 0);
  return fromTz(shifted);
}

/** Start of the Algiers week (Monday 00:00) containing `instant`. */
export function startOfWeekInTz(instant: Date): Date {
  const shifted = toTz(instant);
  const dow = shifted.getUTCDay(); // 0=Sunday ..
  shifted.setUTCDate(shifted.getUTCDate() - ((dow + 6) % 7)); // .. to Monday
  shifted.setUTCHours(0, 0, 0, 0);
  return fromTz(shifted);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Algiers midnight of the calendar day named by a date-only string. `Date.UTC(y,m,d)` is that
 * day's **UTC** midnight; Algiers midnight is one hour earlier, so the offset is subtracted.
 */
function algiersMidnight(value: string, nextDay: boolean): Date | null {
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const shifted = nextDay ? utcMidnight + MS_PER_DAY : utcMidnight;
  return new Date(shifted - TZ_OFFSET_MS);
}

function parseBound(value: string | null | undefined, kind: 'from' | 'to'): Date | null {
  if (!value) return null;
  const fromDateOnly = algiersMidnight(value, kind === 'to');
  if (fromDateOnly) return fromDateOnly;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function presetWindow(
  preset: Exclude<AnalyticsRangePreset, 'custom'>,
  now: Date,
): DateWindow {
  switch (preset) {
    case 'today':
      return { from: startOfDayInTz(now), to: startOfNextDayInTz(now) };
    case 'yesterday': {
      const startToday = startOfDayInTz(now);
      return { from: new Date(startToday.getTime() - MS_PER_DAY), to: startToday };
    }
    case '7d': {
      const to = startOfNextDayInTz(now);
      return { from: new Date(to.getTime() - 7 * MS_PER_DAY), to };
    }
    case '30d': {
      const to = startOfNextDayInTz(now);
      return { from: new Date(to.getTime() - 30 * MS_PER_DAY), to };
    }
    case 'month':
      return { from: startOfMonthInTz(now), to: startOfNextMonthInTz(now) };
  }
}

function isPreset(value: string | null | undefined): value is AnalyticsRangePreset {
  return !!value && (ANALYTICS_RANGE_PRESETS as readonly string[]).includes(value);
}

function pickBucket(
  requested: string | null | undefined,
  preset: AnalyticsRangePreset,
): AnalyticsBucket {
  if (requested && (ANALYTICS_BUCKETS as readonly string[]).includes(requested)) {
    return requested as AnalyticsBucket;
  }
  if (preset === 'custom') return 'day';
  return ANALYTICS_DEFAULT_BUCKET_BY_PRESET[preset];
}

/**
 * Turn a raw query into the concrete window every read aggregates over.
 *
 * A `custom` request without two valid, ordered bounds is not an error the client should see
 * mid-navigation: it silently falls back to the default preset rather than 500-ing the
 * dashboard. Anything the DTO already rejected never reaches here.
 */
export function resolveAnalyticsRange(input: ResolveRangeInput = {}): ResolvedAnalyticsRange {
  const now = input.now ?? new Date();
  const requested = isPreset(input.preset) ? input.preset : ANALYTICS_DEFAULT_PRESET;

  let preset: AnalyticsRangePreset;
  let window: DateWindow;

  if (requested === 'custom') {
    const from = parseBound(input.from, 'from');
    const to = parseBound(input.to, 'to');
    if (from && to && to.getTime() > from.getTime()) {
      preset = 'custom';
      window = { from, to };
    } else {
      preset = ANALYTICS_DEFAULT_PRESET;
      window = presetWindow(ANALYTICS_DEFAULT_PRESET, now);
    }
  } else {
    preset = requested;
    window = presetWindow(requested, now);
  }

  return {
    preset,
    from: window.from,
    to: window.to,
    bucket: pickBucket(input.bucket, preset),
    timezone: ANALYTICS_TIMEZONE,
  };
}

/** The equal-length window immediately before `range` (decision D5). */
export function previousPeriod(range: DateWindow): DateWindow {
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: new Date(range.from.getTime()) };
}
