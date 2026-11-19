/**
 * Store Subdomain plan, §4.2 - the canonical reserved-label policy.
 *
 * Labels here can never be claimed as a store subdomain, because they either collide with
 * platform infrastructure (`api`, `vendor`, `www`, ...), look like a locale prefix (`en`, `ar`,
 * `fr`) or would shadow the platform name itself. The list is deliberately an exact,
 * case-insensitive match: `www2` is a perfectly valid store label, `www` is not.
 *
 * Keep this list as the single source of truth. Frontends may mirror it for routing safety
 * (see the storefront's `lib/storeHost.ts`), never the other way round.
 */
export const RESERVED_STORE_SUBDOMAINS: readonly string[] = [
  // Platform infrastructure / service hosts
  'www',
  'api',
  'vendor',
  'admin',
  'app',
  'dashboard',
  'pos',
  'auth',
  'login',
  'logout',
  'account',
  'profile',
  // Storefront route words
  'cart',
  'checkout',
  'orders',
  'order',
  'stores',
  'store',
  'shop',
  'marketplace',
  // Mail
  'mail',
  'email',
  'smtp',
  'imap',
  'pop',
  'webmail',
  // DNS / delivery infrastructure
  'ns1',
  'ns2',
  'dns',
  'cdn',
  'static',
  'assets',
  'media',
  'images',
  'img',
  'files',
  'download',
  'uploads',
  // Support / informational
  'docs',
  'help',
  'support',
  'status',
  'blog',
  // Payments
  'pay',
  'payment',
  // Environments / operational names
  'preview',
  'staging',
  'dev',
  'test',
  'demo',
  'beta',
  'sandbox',
  'origin',
  'vpn',
  'git',
  'ci',
  'monitor',
  'analytics',
  // Locales
  'en',
  'ar',
  'fr',
  // The platform label itself
  'imraaah',
];

const RESERVED_STORE_SUBDOMAIN_SET = new Set(RESERVED_STORE_SUBDOMAINS);

/** True when `label` is reserved (exact, case-insensitive). An empty value is not reserved. */
export function isReservedStoreSubdomain(label: string): boolean {
  if (!label) return false;
  return RESERVED_STORE_SUBDOMAIN_SET.has(label.trim().toLowerCase());
}
