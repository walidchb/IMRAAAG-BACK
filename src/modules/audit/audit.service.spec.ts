import { AuditService } from './audit.service';
import { AuditAction } from '../../common/constants/audit-action.enum';
import { ResourceType } from '../../common/constants/resource-type.enum';
import { Types } from 'mongoose';

/**
 * H12 — the audit module existed but had zero writers. The service must persist an entry and,
 * critically, must never let a logging failure break the operation it is describing.
 */
describe('AuditService', () => {
  function makeService(create = jest.fn().mockResolvedValue({})) {
    const model = { create };
    const service = new AuditService(model as any);
    return { service, model };
  }

  it('persists an order status change with actor and tenant', async () => {
    const { service, model } = makeService();
    const actorId = new Types.ObjectId().toString();
    const storeId = new Types.ObjectId().toString();
    const orderId = new Types.ObjectId().toString();

    await service.record({
      action: AuditAction.ORDER_STATUS_CHANGE,
      actorId,
      actorEmail: 'vendor@test.com',
      storeId,
      resourceType: ResourceType.ORDER,
      resourceId: orderId,
      details: { from: 'placed', to: 'confirmed' },
    });

    const written = model.create.mock.calls[0][0];
    expect(written.action).toBe(AuditAction.ORDER_STATUS_CHANGE);
    expect(written.resourceType).toBe(ResourceType.ORDER);
    expect(String(written.userId)).toBe(actorId);
    expect(String(written.storeId)).toBe(storeId);
    expect(String(written.resourceId)).toBe(orderId);
    expect(written.details).toEqual({ from: 'placed', to: 'confirmed' });
  });

  it('drops an invalid ObjectId instead of throwing', async () => {
    const { service, model } = makeService();

    await service.record({
      action: AuditAction.STORE_UPDATE,
      actorEmail: 'vendor@test.com',
      resourceId: 'not-an-id',
      details: { operation: 'delivery_config_save' },
    });

    expect(model.create.mock.calls[0][0].userId).toBeUndefined();
    expect(model.create.mock.calls[0][0].resourceId).toBeUndefined();
  });

  it('swallows a write failure so the business operation is unaffected', async () => {
    const { service } = makeService(jest.fn().mockRejectedValue(new Error('mongo down')));

    await expect(
      service.record({ action: AuditAction.ORDER_UPDATE, resourceType: ResourceType.ORDER }),
    ).resolves.toBeUndefined();
  });
});
