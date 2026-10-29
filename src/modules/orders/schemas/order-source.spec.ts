import { model } from 'mongoose';
import { OrderSchema } from './order.schema';
import { OrderSource, ORDER_SOURCE_VALUES } from '../../../common/constants/order-sources.const';

/**
 * POS Phase 0 — the order `source` channel.
 *
 * The value is server-set on every write, so these tests pin the two schema guarantees the
 * backfill relies on: an absent value means `ONLINE` (so pre-POS documents keep their original
 * meaning), and anything outside the three declared channels is rejected rather than stored.
 */
describe('order.schema — source (POS Phase 0)', () => {
  const makeModel = (name: string) => model(name, OrderSchema);

  it('declares exactly the three sales channels', () => {
    expect(ORDER_SOURCE_VALUES).toEqual(['ONLINE', 'POS', 'MANUAL']);
  });

  it('defaults a document with no source to ONLINE', () => {
    const Model = makeModel('OrderSourceDefault');
    const doc = new Model({ orderNo: 'ORD-1' } as any);
    expect(doc.source).toBe(OrderSource.ONLINE);
  });

  it('accepts every declared channel', () => {
    const Model = makeModel('OrderSourceAccept');
    for (const value of ORDER_SOURCE_VALUES) {
      const doc = new Model({ orderNo: 'ORD-1', source: value } as any);
      expect(doc.source).toBe(value);
    }
  });

  it('rejects an undeclared channel at validation', async () => {
    const Model = makeModel('OrderSourceReject');
    const doc = new Model({ orderNo: 'ORD-1', source: 'WEB' } as any);
    await expect(doc.validate()).rejects.toMatchObject({ errors: { source: expect.anything() } });
  });
});
