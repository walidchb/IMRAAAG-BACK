import { model, deleteModel } from 'mongoose';
import { AdminSchema } from './admin.schema';
import { AdminStatus } from '../../../common/constants/admin-status.enum';

const MODEL_NAME = 'AdminSchemaSpec';

function getModel() {
  try {
    return model(MODEL_NAME);
  } catch {
    return model(MODEL_NAME, AdminSchema);
  }
}

afterAll(() => {
  try {
    deleteModel(MODEL_NAME);
  } catch {
    /* already removed */
  }
});

describe('AdminSchema', () => {
  it('defaults status to active and tokenVersion to 0 with nullable session fields', async () => {
    const AdminModel = getModel();
    const admin = new AdminModel({
      firstName: 'Amina',
      lastName: 'Bensalem',
      email: 'ADMIN@Example.COM ',
      passwordHash: 'hashed',
    });

    await expect(admin.validate()).resolves.toBeUndefined();
    expect(admin.status).toBe(AdminStatus.ACTIVE);
    expect(admin.tokenVersion).toBe(0);
    expect(admin.refreshTokenHash).toBeNull();
    expect(admin.refreshTokenExpiresAt).toBeNull();
    expect(admin.lastLoginAt).toBeNull();
    expect(admin.passwordChangedAt).toBeNull();
    expect(admin.createdBy).toBeNull();
    expect(admin.disabledAt).toBeNull();
    expect(admin.disabledBy).toBeNull();
  });

  it('normalizes the email to lowercase and trimmed', () => {
    const AdminModel = getModel();
    const admin = new AdminModel({
      firstName: 'Amina',
      lastName: 'Bensalem',
      email: '  AMINA@Example.COM  ',
      passwordHash: 'hashed',
    });
    expect(admin.email).toBe('amina@example.com');
    expect(AdminSchema.path('email').options.unique).toBe(true);
  });

  it('marks every secret field as select:false', () => {
    for (const field of ['passwordHash', 'refreshTokenHash', 'refreshTokenExpiresAt']) {
      expect(AdminSchema.path(field).options.select).toBe(false);
    }
    expect(AdminSchema.path('tokenVersion').options.select).not.toBe(false);
  });

  it('declares the list and name supporting indexes; email is unique only', () => {
    const indexes = AdminSchema.indexes();
    const definitions = indexes.map(([definition]) => JSON.stringify(definition));
    expect(definitions).toContain(JSON.stringify({ status: 1, createdAt: -1 }));
    expect(definitions).toContain(JSON.stringify({ lastName: 1, firstName: 1 }));

    const emailIndex = indexes.find(([definition]) => JSON.stringify(definition) === '{"email":1}');
    expect(emailIndex?.[1]?.unique).toBe(true);
  });

  it('bounds the identity fields and uses the admins collection', () => {
    expect(AdminSchema.path('firstName').options.maxlength).toBe(80);
    expect(AdminSchema.path('lastName').options.maxlength).toBe(80);
    expect(AdminSchema.path('email').options.maxlength).toBe(254);
    expect(AdminSchema.get('collection')).toBe('admins');
  });
});
