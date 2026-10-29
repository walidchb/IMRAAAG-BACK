/**
 * Barcode + SKU format constants (Barcode/SKU/Label plan, Phase 0).
 *
 * These are the Imraaah-specific values layered on top of the generic EAN-13 maths in
 * `ean13.ts`. Keeping them here — rather than hard-coded inside the encoder — means a future
 * per-store prefix is a one-line change with no effect on the checksum logic.
 *
 * - `BARCODE_PREFIX = '20'` is the GS1 range reserved for internal / in-store use, so an
 *   Imraaah barcode can never collide with a real retail GTIN.
 * - A full barcode is `BARCODE_PREFIX` + `BARCODE_BODY_LENGTH` digits + the check digit.
 */

/** GS1 internal-use prefix. Prefix '20' + a 10-digit body + check digit = 13 digits (EAN-13). */
export const BARCODE_PREFIX = '20';

/** Digits between the prefix and the check digit. 10 digits allows 10 billion codes per store. */
export const BARCODE_BODY_LENGTH = 10;

/** Human-readable SKU namespace. */
export const SKU_PREFIX = 'IMR';

/** Separator between SKU segments (`IMR-ABAYA-RED-S`). */
export const SKU_SEPARATOR = '-';

/** Upper bound so a generated SKU stays printable on a small label. */
export const SKU_MAX_LENGTH = 40;

/**
 * A generated SKU is upper-case alphanumerics joined by single hyphens, with no leading,
 * trailing or doubled separator.
 */
export const SKU_REGEX = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
