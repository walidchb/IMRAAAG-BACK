import { BARCODE_BODY_LENGTH, BARCODE_PREFIX } from './constants';
import {
  EAN13_LENGTH,
  EAN13_PAYLOAD_LENGTH,
  buildEan13,
  ean13CheckDigit,
  isValidEan13,
} from './ean13';

describe('EAN-13 (Phase 0)', () => {
  describe('ean13CheckDigit', () => {
    it('matches the canonical Wikipedia example', () => {
      // payload 400638133393 -> check digit 1
      expect(ean13CheckDigit('400638133393')).toBe(1);
    });

    it('matches a second known vector', () => {
      // payload 590123412345 -> check digit 7
      expect(ean13CheckDigit('590123412345')).toBe(7);
    });

    it('handles an all-zero payload', () => {
      expect(ean13CheckDigit('000000000000')).toBe(0);
    });

    it('rejects a payload that is not exactly 12 digits', () => {
      expect(() => ean13CheckDigit('123')).toThrow(RangeError);
      expect(() => ean13CheckDigit('1234567890123')).toThrow(RangeError);
    });

    it('rejects a non-numeric payload', () => {
      expect(() => ean13CheckDigit('40063813339x')).toThrow(RangeError);
    });
  });

  describe('isValidEan13', () => {
    it('accepts valid codes', () => {
      expect(isValidEan13('4006381333931')).toBe(true);
      expect(isValidEan13('5901234123457')).toBe(true);
    });

    it('rejects a wrong check digit', () => {
      expect(isValidEan13('4006381333932')).toBe(false);
    });

    it('rejects wrong length, non-digits and non-strings without throwing', () => {
      expect(isValidEan13('123')).toBe(false);
      expect(isValidEan13('40063813339310')).toBe(false);
      expect(isValidEan13('400638133393a')).toBe(false);
      expect(isValidEan13(4006381333931)).toBe(false);
      expect(isValidEan13(null)).toBe(false);
      expect(isValidEan13(undefined)).toBe(false);
    });
  });

  describe('buildEan13', () => {
    it('prefixes, zero-pads the body and appends the check digit', () => {
      expect(buildEan13(BARCODE_PREFIX, '5')).toBe('2000000000053');
    });

    it('produces a 13-digit, checksum-valid code', () => {
      const code = buildEan13(BARCODE_PREFIX, '1');
      expect(code).toHaveLength(EAN13_LENGTH);
      expect(code.startsWith(BARCODE_PREFIX)).toBe(true);
      expect(isValidEan13(code)).toBe(true);
    });

    it('pads a full-width body unchanged', () => {
      // body already exactly BARCODE_BODY_LENGTH digits
      const code = buildEan13('20', '1234567890');
      expect(code.slice(0, EAN13_PAYLOAD_LENGTH)).toBe('201234567890');
      expect(isValidEan13(code)).toBe(true);
    });

    it('rejects a payload that overflows 12 digits', () => {
      expect(() => buildEan13('20', '12345678901')).toThrow(RangeError);
    });

    it('rejects a non-numeric prefix or body', () => {
      expect(() => buildEan13('2x', '1')).toThrow(RangeError);
      expect(() => buildEan13('20', '1a')).toThrow(RangeError);
    });

    it('rejects a prefix whose length leaves the payload off 12 digits', () => {
      expect(() => buildEan13('2', '5', BARCODE_BODY_LENGTH)).toThrow(RangeError);
    });
  });
});
