import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateStoreDto } from './create-store.dto';
import { UpdateStoreDto } from './update-store.dto';

/**
 * Store required/optional contract.
 *
 * Only `storeName`, `storeSlug` (derived) and the contact identity are mandatory; every
 * other attribute is optional. The vendor edit form posts empty strings for attributes that
 * were never filled (e.g. `storeLogo: ''`), and `@IsOptional()` does NOT skip validators for
 * an empty string - so without the empty-string transform these requests 400'd and the store
 * could not be saved. These tests pin both halves.
 */

const validVendorEdit = {
  storeName: 'Atelier Nour',
  contactPhone: '0551234567',
  contactEmail: 'vendor@test.com',
};

describe('UpdateStoreDto - optional attributes tolerate empty strings', () => {
  it('collapses empty storeLogo/coverImage/contactEmail to undefined', async () => {
    const dto = plainToInstance(UpdateStoreDto, {
      ...validVendorEdit,
      storeLogo: '',
      coverImage: '   ',
      tagline: '',
      wilaya: '',
      commune: '',
    });

    expect(dto.storeLogo).toBeUndefined();
    expect(dto.coverImage).toBeUndefined();
    // Empty plain strings are left as-is (only URL/email fields carry the transform).
    expect(dto.tagline).toBe('');

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('still validates a real URL', async () => {
    const dto = plainToInstance(UpdateStoreDto, {
      ...validVendorEdit,
      storeLogo: 'https://cdn.imraaah.com/logo.png',
    });
    expect(dto.storeLogo).toBe('https://cdn.imraaah.com/logo.png');
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a non-empty but malformed URL', async () => {
    const dto = plainToInstance(UpdateStoreDto, { storeLogo: 'not-a-url' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'storeLogo')).toBe(true);
  });

  it('drops empty social links but validates real ones', async () => {
    const dto = plainToInstance(UpdateStoreDto, {
      socialMedia: { instagram: '', facebook: 'https://facebook.com/shop' },
    });
    expect(dto.socialMedia?.instagram).toBeUndefined();
    expect(dto.socialMedia?.facebook).toBe('https://facebook.com/shop');
    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});

describe('CreateStoreDto - mandatory contact identity', () => {
  it('requires contactEmail', async () => {
    const dto = plainToInstance(CreateStoreDto, {
      vendorEmail: 'vendor@test.com',
      storeName: 'Atelier Nour',
      contactPhone: '0551234567',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'contactEmail')).toBe(true);
  });

  it('rejects an empty contactEmail rather than treating it as provided', async () => {
    const dto = plainToInstance(CreateStoreDto, {
      vendorEmail: 'vendor@test.com',
      storeName: 'Atelier Nour',
      contactPhone: '0551234567',
      contactEmail: '',
    });
    expect(dto.contactEmail).toBeUndefined();
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'contactEmail')).toBe(true);
  });

  it('accepts a valid minimal payload', async () => {
    const dto = plainToInstance(CreateStoreDto, {
      vendorEmail: 'vendor@test.com',
      storeName: 'Atelier Nour',
      contactEmail: 'vendor@test.com',
      contactPhone: '0551234567',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
