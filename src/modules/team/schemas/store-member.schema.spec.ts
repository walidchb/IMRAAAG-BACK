import { Types, model } from 'mongoose';
import { StoreMember, StoreMemberSchema } from './store-member.schema';

/**
 * Locks the ObjectId casting quirk documented in the implementation plan § 2.7.
 *
 * In this Mongoose 9 + `@nestjs/mongoose` build the `{ type: Types.ObjectId }` form compiles
 * to a Mixed path and skips casting. These schemas deliberately use the string `'ObjectId'`
 * form, so a string written through a model must be stored as a real ObjectId.
 */
describe('StoreMember schema', () => {
  it('declares storeId and userId as ObjectId paths (not Mixed)', () => {
    expect(StoreMemberSchema.path('storeId').instance).toBe('ObjectId');
    expect(StoreMemberSchema.path('userId').instance).toBe('ObjectId');
  });

  it('enforces the unique (storeId, userId) index', () => {
    const unique = StoreMemberSchema.indexes().find(
      ([keys]) => keys.storeId === 1 && keys.userId === 1,
    );
    expect(unique?.[1]).toMatchObject({ unique: true });
  });

  it('casts string ids to ObjectId and applies defaults', () => {
    const M =
      (model as any).models?.StoreMemberSchemaTest ??
      model('StoreMemberSchemaTest', StoreMemberSchema);
    const doc = new M({
      storeId: new Types.ObjectId().toHexString(),
      userId: new Types.ObjectId().toHexString(),
      role: 'PARTNER',
    });

    expect(doc.storeId).toBeInstanceOf(Types.ObjectId);
    expect(doc.userId).toBeInstanceOf(Types.ObjectId);
    expect(doc.status).toBe('active');
    expect(doc.permissionOverrides).toEqual([]);
  });
});
