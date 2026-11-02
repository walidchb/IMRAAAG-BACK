import { UserSchema } from './user.schema';

/**
 * C3 regression guard. A TTL index on `refreshTokenExpiresAt` expires the whole user document,
 * so an inactive account used to be deleted ~30 days after its refresh token lapsed. If this
 * fails, an account-data-loss bug has been reintroduced.
 */
describe('UserSchema indexes', () => {
  it('declares no TTL index on refreshTokenExpiresAt', () => {
    const ttlIndexes = UserSchema.indexes().filter(
      ([fields, options]) =>
        (options as { expireAfterSeconds?: number } | undefined)?.expireAfterSeconds !== undefined &&
        'refreshTokenExpiresAt' in (fields as Record<string, unknown>),
    );

    expect(ttlIndexes).toEqual([]);
  });

  it('declares no TTL index at all', () => {
    const ttlIndexes = UserSchema.indexes().filter(
      ([, options]) =>
        (options as { expireAfterSeconds?: number } | undefined)?.expireAfterSeconds !== undefined,
    );

    expect(ttlIndexes).toEqual([]);
  });
});
