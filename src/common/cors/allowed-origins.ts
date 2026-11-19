/**
 * CORS origin policy (store subdomains).
 *
 * A store subdomain is a normal browser origin (`https://zainab.imraaah.com`, or
 * `http://zainab.localhost:3002` in development), so the API must echo that exact origin in
 * `Access-Control-Allow-Origin` - `*` cannot be used because credentials are enabled.
 *
 * Instead of listing every store in `CORS_ORIGINS`, this module accepts any origin under a
 * configured root domain (`CORS_SUBDOMAIN_ROOTS`, default `imraaah.com`). Development also
 * always accepts `*.localhost` / `*.127.0.0.1` on any port, so local store testing needs no
 * configuration at all.
 *
 * This is transport-level browser policy only: it never authorizes a tenant. Store/order
 * ownership is still validated server-side from the session and `storeId`.
 */

export interface CorsOriginOptions {
  /** Normalized entries of `CORS_ORIGINS` (exact match). */
  exactOrigins: string[];
  /** Root domains whose apex and subdomains are accepted (e.g. `imraaah.com`). */
  subdomainRoots?: string[];
  isProduction: boolean;
}

/** Trailing slashes are not part of an origin; normalize them away. */
export function normalizeCorsOrigin(origin: string): string {
  return String(origin || '').trim().replace(/\/+$/, '');
}

/**
 * Normalizes a comma-separated list of root domains. Accepts entries with or without a
 * scheme (or path) so `imraaah.com`, `https://imraaah.com` and `.imraaah.com` all work.
 */
export function normalizeSubdomainRoots(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((entry) =>
      entry
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/^\.+/, '')
        .replace(/\.+$/, ''),
    )
    .filter((root) => !!root && root !== '*');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Any localhost name (including store hosts) on any port; development only. */
const DEV_LOCALHOST_ORIGIN =
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

/**
 * True when the browser origin is allowed.
 *
 * - no `Origin` header (server-to-server, same-origin, curl) -> allowed, as before;
 * - an exact `CORS_ORIGINS` entry -> allowed;
 * - development `*.localhost` / `*.127.0.0.1` -> allowed;
 * - the apex or a subdomain of a configured root -> allowed. Production is HTTPS-only and
 *   port-less (browsers omit the default port); development also allows HTTP and any port.
 */
export function isOriginAllowed(
  origin: string | undefined,
  options: CorsOriginOptions,
): boolean {
  if (!origin) return true;

  const value = normalizeCorsOrigin(origin);
  if (!value) return true;

  if (options.exactOrigins.includes(value)) return true;

  if (!options.isProduction && DEV_LOCALHOST_ORIGIN.test(value)) return true;

  const scheme = options.isProduction ? 'https' : 'https?';
  const port = options.isProduction ? '' : '(?::\\d+)?';

  for (const root of options.subdomainRoots ?? []) {
    // Exact suffix on a dot boundary: `imraaah.com.evil.com` and `evilimraaah.com` never match.
    const pattern = new RegExp(
      `^${scheme}://(?:[a-z0-9-]+\\.)*${escapeRegExp(root)}${port}$`,
      'i',
    );
    if (pattern.test(value)) return true;
  }

  return false;
}
