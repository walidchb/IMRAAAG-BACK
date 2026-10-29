import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  isLowStock,
  resolveLowStockThreshold,
} from './services/low-stock';

describe('low-stock', () => {
  it('platform default is 3 (roadmap ME-6 / ProductCard `?? 3`)', () => {
    expect(DEFAULT_LOW_STOCK_THRESHOLD).toBe(3);
  });

  describe('resolveLowStockThreshold', () => {
    it('balance > variant > product > platform default', () => {
      expect(resolveLowStockThreshold(9, 5, 1)).toBe(9);
      expect(resolveLowStockThreshold(null, 5, 1)).toBe(5);
      expect(resolveLowStockThreshold(undefined, 5, 1)).toBe(5);
      expect(resolveLowStockThreshold(null, null, 1)).toBe(1);
      // The case that used to yield `null` and therefore "never low".
      expect(resolveLowStockThreshold(null, null, null)).toBe(3);
      expect(resolveLowStockThreshold(undefined, undefined, undefined)).toBe(3);
      expect(resolveLowStockThreshold()).toBe(DEFAULT_LOW_STOCK_THRESHOLD);
    });

    it('treats explicit 0 as a real threshold, not as missing', () => {
      expect(resolveLowStockThreshold(0, 9, 4)).toBe(0);
      expect(resolveLowStockThreshold(null, 0, 4)).toBe(0);
    });
  });

  describe('isLowStock', () => {
    it('excludes zero - an empty variant is out of stock, not low', () => {
      expect(isLowStock(0, 3)).toBe(false);
      expect(isLowStock(-1, 3)).toBe(false);
    });

    it('covers 1..threshold inclusive', () => {
      expect(isLowStock(1, 3)).toBe(true);
      expect(isLowStock(3, 3)).toBe(true);
      expect(isLowStock(4, 3)).toBe(false);
      expect(isLowStock(100, 3)).toBe(false);
    });

    it('respects an explicit threshold', () => {
      expect(isLowStock(5, 5)).toBe(true);
      expect(isLowStock(6, 5)).toBe(false);
      expect(isLowStock(1, 0)).toBe(false); // threshold 0 means "always healthy once stocked"
    });

    it('every quantity lands in exactly one bucket (out | low | healthy)', () => {
      const threshold = DEFAULT_LOW_STOCK_THRESHOLD;
      for (let available = 0; available <= 10; available++) {
        const out = available <= 0;
        const low = isLowStock(available, threshold);
        const healthy = !out && !low;
        // out and low never overlap, and out/low/healthy cover every value.
        expect(out && low).toBe(false);
        expect([out, low, healthy].filter(Boolean)).toHaveLength(1);
        if (available === 0) expect(out).toBe(true);
        if (available >= 1 && available <= threshold) expect(low).toBe(true);
        if (available > threshold) expect(healthy).toBe(true);
      }
    });
  });
});
