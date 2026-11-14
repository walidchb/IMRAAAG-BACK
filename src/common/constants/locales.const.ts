/** Locales supported by the vendor frontend. Keep in sync with `i18n/routing.ts`. */
export const SUPPORTED_LOCALES = ['en', 'fr', 'ar'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/** Falls back to English for a missing or unsupported locale. */
export function normalizeLocale(locale?: string | null): AppLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale ?? '')
    ? (locale as AppLocale)
    : 'en';
}
