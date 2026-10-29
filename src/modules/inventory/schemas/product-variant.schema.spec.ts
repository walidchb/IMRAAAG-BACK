import { ProductVariantSchema } from './product-variant.schema';

/**
 * Guards the two per-store uniqueness indexes the Barcode/SKU/Label feature depends on.
 *
 * The live `{storeId, barcode}` index was found NON-unique during Phase 5 (the schema declared
 * it without `unique: true`), so a duplicate barcode could never raise `BARCODE_DUPLICATE` —
 * `mapDuplicateErrors` mapped an error that the database never produced. These tests pin the
 * schema declaration so the regression cannot return; the live index is verified separately by
 * `scripts/audit-barcode-sku.js`.
 */
describe('product-variant.schema — code uniqueness indexes', () => {
  const find = (field: 'sku' | 'barcode') =>
    ProductVariantSchema.indexes().find(([key]) => key.storeId === 1 && key[field] === 1);

  it('declares a unique partial {storeId, sku} index', () => {
    const ix = find('sku');
    expect(ix).toBeDefined();
    expect(ix![1].unique).toBe(true);
    expect(ix![1].partialFilterExpression).toEqual({ sku: { $type: 'string' } });
  });

  it('declares a unique partial {storeId, barcode} index', () => {
    const ix = find('barcode');
    expect(ix).toBeDefined();
    expect(ix![1].unique).toBe(true);
    expect(ix![1].partialFilterExpression).toEqual({ barcode: { $type: 'string' } });
  });
});
