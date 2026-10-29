import {
  AnalyticsBucket,
} from '../constants/analytics.constants';
import {
  TZ_OFFSET_MS,
  startOfDayInTz,
  startOfHourInTz,
  startOfMonthInTz,
  startOfNextDayInTz,
  startOfNextMonthInTz,
  startOfWeekInTz,
} from './date-range';

/**
 * Trend bucketing (roadmap Phase 1, decision D4).
 *
 * Every bucket boundary is computed in the same Algiers-anchored math the range resolution
 * uses, so a "day" bucket is a calendar day for the seller, not a UTC window. Windows are
 * half-open `[from, to)`; `bucketAdvance` steps from one bucket start to the next, and
 * `bucketKey` names a bucket by its Algiers date (hour buckets get `YYYY-MM-DDTHH:00`).
 */

export function bucketStartAt(instant: Date, bucket: AnalyticsBucket): Date {
  switch (bucket) {
    case 'hour':
      return startOfHourInTz(instant);
    case 'day':
      return startOfDayInTz(instant);
    case 'week':
      return startOfWeekInTz(instant);
    case 'month':
      return startOfMonthInTz(instant);
  }
}

export function bucketAdvance(start: Date, bucket: AnalyticsBucket): Date {
  switch (bucket) {
    case 'hour':
      return new Date(start.getTime() + 60 * 60 * 1000);
    case 'day':
      return startOfNextDayInTz(start);
    case 'week':
      return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    case 'month':
      return startOfNextMonthInTz(start);
  }
}

const two = (n: number) => String(n).padStart(2, '0');

/** Names the bucket by its Algiers calendar date (`YYYY-MM-DD`) or clock hour (`…THH:00`). */
export function bucketKey(start: Date, bucket: AnalyticsBucket): string {
  const shifted = new Date(start.getTime() + TZ_OFFSET_MS);
  const date = `${shifted.getUTCFullYear()}-${two(shifted.getUTCMonth() + 1)}-${two(shifted.getUTCDate())}`;
  switch (bucket) {
    case 'hour':
      return `${date}T${two(shifted.getUTCHours())}:00`;
    case 'month':
      return date.slice(0, 7);
    default:
      return date;
  }
}