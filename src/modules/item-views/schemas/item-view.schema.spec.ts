import { Types } from 'mongoose';
import { ItemViewDailySchema } from './item-view-daily.schema';

/**
 * Guards the tenant-critical casting behaviour.
 *
 * `@Prop({ type: Types.ObjectId })` compiles to a `Mixed` path in this Mongoose build, which
 * silently disables casting: a string `storeId` written by a caller would never match an
 * ObjectId-scoped query, so a tenant's rows could be created but never read (or vice versa).
 * The schema uses `SchemaTypes.ObjectId`, and these specs pin both the path type and the
 * unique dedupe index.
 */
describe('item-view-daily.schema', () => {
  const oid = new Types.ObjectId().toHexString();

  it('declares storeId and itemId as real ObjectId paths (not Mixed)', () => {
    expect(ItemViewDailySchema.path('storeId').instance).toBe('ObjectId');
    expect(ItemViewDailySchema.path('itemId').instance).toBe('ObjectId');
  });

  it('casts a string storeId/itemId to an ObjectId', () => {
    const storeId = ItemViewDailySchema.path('storeId').cast(oid);
    const itemId = ItemViewDailySchema.path('itemId').cast(oid);
    expect(storeId).toBeInstanceOf(Types.ObjectId);
    expect(itemId).toBeInstanceOf(Types.ObjectId);
    expect(String(storeId)).toBe(oid);
    expect(String(itemId)).toBe(oid);
  });

  it('declares the unique dedupe index', () => {
    const ix = ItemViewDailySchema.indexes().find(
      ([key]) =>
        key.storeId === 1 &&
        key.itemType === 1 &&
        key.itemId === 1 &&
        key.dayStart === 1 &&
        key.visitorHash === 1,
    );
    expect(ix).toBeDefined();
    expect(ix![1].unique).toBe(true);
  });

  it('declares the all-items range index', () => {
    const ix = ItemViewDailySchema.indexes().find(
      ([key]) =>
        key.storeId === 1 &&
        key.dayStart === 1 &&
        key.itemType === 1 &&
        key.itemId === 1 &&
        key.visitorHash === 1,
    );
    expect(ix).toBeDefined();
  });
});
