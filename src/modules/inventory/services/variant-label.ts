/**
 * The single implementation of a variant's display label.
 *
 * A variant has no label of its own - it is composed from the option values it joins to, so
 * the same variant is named by several views (the creation matrix, the inventory list, the
 * movement ledger and the POS register). All of them call this, because a seller who sees
 * "Small / Red" on the matrix and "s / red" in the ledger cannot tell whether those are one
 * variant or two, and that ambiguity is indistinguishable from a data bug.
 *
 * The rule, in full:
 *  - parts are ordered by option-value id, so the same variant always renders the same way;
 *  - each part is the value's display name only; option names ("Size", "Colour") are omitted;
 *  - the value name is the requested locale's `valueXx`, falling back to `valueEn`, `valueFr`,
 *    `valueAr`, then to the raw `value` slug;
 *  - parts are joined with ' / ' and unknown ids are skipped rather than rendered as blanks.
 *
 * The locale comes from the caller (the vendor UI sends its current locale). It defaults to
 * English so the buyer-facing public matrix and order snapshots keep their canonical shape.
 */

export type LabelLocale = 'en' | 'fr' | 'ar';

export const DEFAULT_LABEL_LOCALE: LabelLocale = 'en';

const FALLBACK_ORDER: Record<LabelLocale, readonly LabelLocale[]> = {
  en: ['en', 'fr', 'ar'],
  fr: ['fr', 'en', 'ar'],
  ar: ['ar', 'en', 'fr'],
};

/** Narrows an arbitrary query-string value to a supported label locale. */
export function normalizeLabelLocale(locale?: string | null): LabelLocale {
  return locale === 'fr' || locale === 'ar' || locale === 'en' ? locale : DEFAULT_LABEL_LOCALE;
}

interface LocalizedLabel {
  en?: string | null;
  fr?: string | null;
  ar?: string | null;
}

function pickName(name: LocalizedLabel | undefined, locale: LabelLocale): string {
  if (!name) return '';
  for (const key of FALLBACK_ORDER[locale]) {
    const candidate = name[key];
    if (candidate && candidate.trim()) return candidate.trim();
  }
  return '';
}

export interface LabelOption {
  _id: unknown;
  nameEn?: string | null;
  nameAr?: string | null;
  nameFr?: string | null;
  key?: string | null;
  /** Marks the auto-seeded scaffold; it can remain set after the seller repurposes it. */
  isDefault?: boolean;
}

export interface LabelValue {
  _id: unknown;
  optionId: unknown;
  value?: string | null;
  valueEn?: string | null;
  valueAr?: string | null;
  valueFr?: string | null;
}

export function buildVariantLabel(
  optionValueIds: string[],
  options: Map<string, LabelOption>,
  values: Map<string, LabelValue>,
  locale: string = DEFAULT_LABEL_LOCALE,
): string {
  const resolvedLocale = normalizeLabelLocale(locale);

  return [...optionValueIds]
    .sort()
    .map((id) => {
      const value = values.get(id);
      if (!value) return null;
      const option = options.get(String(value.optionId));
      const optionName =
        pickName(
          { en: option?.nameEn, fr: option?.nameFr, ar: option?.nameAr },
          resolvedLocale,
        ) ||
        option?.key ||
        '';
      const valueName =
        pickName(
          { en: value.valueEn, fr: value.valueFr, ar: value.valueAr },
          resolvedLocale,
        ) || value.value?.trim();
      if (!valueName) return null;
      // Every non-scaffold part is the value name only; option names are omitted so the
      // inventory list reads "S / Chocolate Brown" rather than "Size: S / Colour: Chocolate Brown".
      // The untouched auto-seeded scaffold is the only part still named by its option alone.
      const isUntouchedScaffold =
        option?.isDefault && value.value === 'default' && value.valueEn === 'One Size';
      if (isUntouchedScaffold) return optionName || String(valueName);
      return String(valueName);
    })
    .filter((part): part is string => !!part)
    .join(' / ');
}
