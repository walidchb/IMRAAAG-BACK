import { isReservedStoreSubdomain } from '../../common/constants/store-subdomain.const';

/**
 * Store Subdomain plan, §4.2 - pure format/normalization rules.
 *
 * A store subdomain is a single DNS label under the platform root (e.g. `zainab` in
 * `zainab.imraaah.com`). Everything here is pure and unit-testable; the service layers
 * (and the migration scripts, via the compiled build) are the only callers.
 *
 * Deliberately separate from `storeSlug`: a slug is recomputed whenever the store is renamed,
 * whereas the public storefront address must stay stable for the lifetime of the store.
 */

/** DNS-label-safe value shape (an internal store subdomain is always a single label). */
export const STORE_SUBDOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

/** Platform policy: short enough to read and type, long enough to be meaningful. */
export const STORE_SUBDOMAIN_MIN_LENGTH = 3;
export const STORE_SUBDOMAIN_MAX_LENGTH = 30;

/**
 * Normalize raw user input to its canonical form, or `null` when it is not a valid label.
 *
 * Rules: NFKD -> lower-case -> trim -> strip trailing dot(s) -> ASCII only. Then the label must
 * match the DNS pattern with the platform 3-30 length window, and must not start/end with a
 * hyphen, contain consecutive hyphens, start with `xn--`, or be all-numeric (those are
 * infrastructure/IP-like and confusing).
 *
 * Reserved-label policy is intentionally *not* applied here - callers that want it use
 * `isReservedStoreSubdomain` so that availability can distinguish `reserved` from `invalid`.
 */
export function normalizeSubdomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\.+$/, '');

  if (!normalized) return null;
  // ASCII-only. `%` (percent-encoding), spaces, underscores and dots all fail this check.
  if (!/^[a-z0-9-]+$/.test(normalized)) return null;
  if (normalized.length < STORE_SUBDOMAIN_MIN_LENGTH) return null;
  if (normalized.length > STORE_SUBDOMAIN_MAX_LENGTH) return null;
  if (!STORE_SUBDOMAIN_LABEL_PATTERN.test(normalized)) return null;
  if (normalized.includes('--')) return null;
  if (normalized.startsWith('xn--')) return null;
  if (/^\d+$/.test(normalized)) return null;

  return normalized;
}

/** True when `raw` normalizes to a valid, non-reserved store subdomain. */
export function isValidStoreSubdomain(raw: unknown): boolean {
  const normalized = normalizeSubdomain(raw);
  return normalized !== null && !isReservedStoreSubdomain(normalized);
}
