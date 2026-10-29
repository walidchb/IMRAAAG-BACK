import { model } from 'mongoose';
import { OrderSchema } from './order.schema';

/**
 * POS Phase 2 — the customer contact fields.
 *
 * The leaf-level `required` flags that used to guard `customer.name/phone/wilaya/commune` were
 * replaced by a `pre('validate')` hook, because a nested `required` function cannot read the
 * sibling `shippingMethod` and so could not exempt a `pickup` (in-store) sale. These tests pin
 * the two guarantees that replacement must preserve: a shipped order still needs its contact
 * fields, and an anonymous pickup sale is allowed while a document with no customer at all
 * keeps validating exactly as it always did.
 */
describe('order.schema — customer fields (POS Phase 2)', () => {
  const makeModel = (name: string) => model(name, OrderSchema);

  const base = (shippingMethod: string): any => ({
    orderNo: 'ORD-1',
    vendorEmail: 'store@imraaah.com',
    total: 0,
    status: { slug: 'placed' },
    shippingMethod,
  });

  it('allows an anonymous pickup sale with empty contact fields', async () => {
    const Model = makeModel('OrderCustomerPickup');
    const doc = new Model({
      ...base('pickup'),
      customer: { name: 'Walk-in', phone: '', wilaya: '', commune: '' },
    } as any);

    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('requires phone, wilaya and commune when the order is shipped', async () => {
    const Model = makeModel('OrderCustomerShippedMissing');
    const doc = new Model({
      ...base('stopdesk'),
      customer: { name: 'Customer' },
    } as any);

    await expect(doc.validate()).rejects.toMatchObject({
      errors: {
        'customer.phone': expect.anything(),
        'customer.wilaya': expect.anything(),
        'customer.commune': expect.anything(),
      },
    });
  });

  it('accepts a fully specified shipped order', async () => {
    const Model = makeModel('OrderCustomerShippedComplete');
    const doc = new Model({
      ...base('home'),
      customer: { name: 'Customer', phone: '0550000000', wilaya: '16', commune: 'Alger' },
    } as any);

    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('keeps allowing a document with no customer at all (historical behaviour)', async () => {
    const Model = makeModel('OrderCustomerAbsent');
    const doc = new Model(base('stopdesk') as any);

    await expect(doc.validate()).resolves.toBeUndefined();
  });
});
