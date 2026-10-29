/**
 * EAN-13 checksum and assembly (Barcode/SKU/Label plan, Phase 0).
 *
 * Pure, dependency-free, no side effects. This is the single source of truth for the barcode
 * maths; the vendorFront ships a byte-identical copy at `src/lib/barcode/ean13.ts` because the
 * two apps do not share a workspace package, and a cross-implementation test asserts they agree
 * on known vectors and random bodies.
 *
 * EAN-13 layout: 12 payload digits followed by one modulo-10 check digit. The check digit uses
 * alternating weights of 1 and 3 across the payload, starting with weight 1 on the first digit.
 */

/** Total length of a valid code, including the check digit. */
export const EAN13_LENGTH = 13;

/** Number of payload digits the check digit is computed over. */
export const EAN13_PAYLOAD_LENGTH = 12;

const DIGITS_ONLY = /^\d+$/;

/**
 * Computes the EAN-13 check digit for a 12-digit payload.
 *
 * @throws RangeError if `payload` is not exactly 12 digits.
 */
export function ean13CheckDigit(payload: string): number {
  if (typeof payload !== 'string' || payload.length !== EAN13_PAYLOAD_LENGTH || !DIGITS_ONLY.test(payload)) {
    throw new RangeError(`EAN-13 payload must be exactly ${EAN13_PAYLOAD_LENGTH} digits`);
  }

  let sum = 0;
  for (let i = 0; i < EAN13_PAYLOAD_LENGTH; i += 1) {
    const digit = payload.charCodeAt(i) - 48;
    // Odd positions (1-indexed) carry weight 1, even positions carry weight 3.
    sum += i % 2 === 0 ? digit : digit * 3;
  }

  return (10 - (sum % 10)) % 10;
}

/**
 * True when `code` is a syntactically valid, correctly checksummed 13-digit EAN-13.
 * Never throws — anything that is not a string of 13 digits is simply `false`.
 */
export function isValidEan13(code: unknown): code is string {
  if (typeof code !== 'string' || code.length !== EAN13_LENGTH || !DIGITS_ONLY.test(code)) {
    return false;
  }
  return ean13CheckDigit(code.slice(0, EAN13_PAYLOAD_LENGTH)) === code.charCodeAt(EAN13_PAYLOAD_LENGTH) - 48;
}

/**
 * Assembles a full EAN-13 from a numeric prefix and body.
 *
 * `body` is right-aligned and zero-padded to `bodyLength` digits, then prefixed, so
 * `buildEan13('20', '5')` yields the payload `20` + `0000000005`. The combined payload must be
 * exactly `EAN13_PAYLOAD_LENGTH` digits; anything longer is rejected rather than silently
 * truncated.
 *
 * @throws RangeError if `prefix`/`body` are not digits, or if the padded payload is not 12 digits.
 */
export function buildEan13(prefix: string, body: string | number, bodyLength = 10): string {
  const prefixStr = String(prefix);
  const bodyStr = String(body);

  if (!DIGITS_ONLY.test(prefixStr)) {
    throw new RangeError('EAN-13 prefix must contain digits only');
  }
  if (!DIGITS_ONLY.test(bodyStr)) {
    throw new RangeError('EAN-13 body must contain digits only');
  }

  const paddedBody = bodyStr.padStart(bodyLength, '0');
  const payload = prefixStr + paddedBody;
  if (payload.length !== EAN13_PAYLOAD_LENGTH) {
    throw new RangeError(`EAN-13 payload must be exactly ${EAN13_PAYLOAD_LENGTH} digits`);
  }

  return payload + ean13CheckDigit(payload);
}
