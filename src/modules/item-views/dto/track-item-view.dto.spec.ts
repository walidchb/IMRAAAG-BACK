import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { TrackItemViewDto } from './track-item-view.dto';

/**
 * The public beacon must only accept visitor ids the storefront actually generates. Without
 * this, any short string can mint a new "unique" visitor row on every request.
 */
describe('TrackItemViewDto visitorId', () => {
  const itemId = new Types.ObjectId().toString();

  const dtoWith = (visitorId?: string) => {
    const dto = new TrackItemViewDto();
    dto.itemType = 'product';
    dto.itemId = itemId;
    if (visitorId !== undefined) dto.visitorId = visitorId;
    return dto;
  };

  it('accepts a UUID v4 from crypto.randomUUID()', async () => {
    await expect(validate(dtoWith('2f8a1d5c-3b7e-4c9a-8d1f-6e5b4a3c2d1e'))).resolves.toEqual(
      [],
    );
  });

  it('accepts the 32-character hex fallback from getRandomValues()', async () => {
    await expect(validate(dtoWith('2f8a1d5c3b7e4c9a8d1f6e5b4a3c2d1e'))).resolves.toEqual([]);
  });

  it('remains valid without a visitorId (server falls back to a salted IP+UA hash)', async () => {
    await expect(validate(dtoWith())).resolves.toEqual([]);
  });

  it.each(['x', 'short', 'not-a-visitor-id', ' ', '2f8a1d5c-3b7e-4c9a-8d1f'])(
    'rejects an arbitrary visitorId (%p)',
    async (visitorId) => {
      const errors = await validate(dtoWith(visitorId));
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('visitorId');
    },
  );
});
