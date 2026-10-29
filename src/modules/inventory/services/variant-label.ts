/**
 * The single implementation of a variant's display label.
 *
 * A variant has no label of its own - it is composed from the option values it joins to, so
 * the same variant is named by three different views (the creation matrix, the inventory list
 * and the movement ledger). All three call this, because a seller who sees "Size: Small /
 * Colour: Red" on the matrix and "s / red" in the ledger cannot tell whether those are one
 * variant or two, and that ambiguity is indistinguishable from a data bug.
 *
 * The rule, in full:
 *  - parts are ordered by option-value id, so the same variant always renders the same way;
 *  - an option contributes `<option name>: <value name>`;
 *  - the option name is `nameEn`, falling back to the stable `key` and then to nothing, in
 *    which case the bare value is used;
 *  - the value name is the localized `valueEn`, falling back to the raw `value` slug;
 *  - the auto-seeded "Default > One Size" scaffold contributes the option name alone
 *    ("Default"), because "Default: One Size" implies a size dimension the product does not
 *    have. Only the scaffold is specialised this way; a seller's own option named "Default"
 *    still renders its value;
 *  - parts are joined with ' / ' and unknown ids are skipped rather than rendered as blanks.
 *
 * `nameEn` is used regardless of the request's locale because these are seller-facing admin
 * screens that have never been localized; a store that only fills in `nameAr` still renders.
 */

export interface LabelOption {
  _id: unknown;
  nameEn?: string | null;
  key?: string | null;
  /** True only for the auto-seeded "Default > One Size" scaffold; see the rule above. */
  isDefault?: boolean;
}

export interface LabelValue {
  _id: unknown;
  optionId: unknown;
  value?: string | null;
  valueEn?: string | null;
}

export function buildVariantLabel(
  optionValueIds: string[],
  options: Map<string, LabelOption>,
  values: Map<string, LabelValue>,
): string {
  return [...optionValueIds]
    .sort()
    .map((id) => {
      const value = values.get(id);
      if (!value) return null;
      const option = options.get(String(value.optionId));
      const optionName = option?.nameEn || option?.key || '';
      const valueName = value.valueEn || value.value;
      if (!valueName) return null;
      // The scaffold has exactly one value ("One Size"); naming the option alone reads as the
      // single default variant instead of implying a size dimension the product lacks.
      if (option?.isDefault) return optionName || String(valueName);
      return optionName ? `${optionName}: ${valueName}` : String(valueName);
    })
    .filter((part): part is string => !!part)
    .join(' / ');
}