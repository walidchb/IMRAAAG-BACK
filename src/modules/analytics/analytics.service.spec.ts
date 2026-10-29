import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { AnalyticsService, AnalyticsProjectedOrder, StoreScope } from './analytics.service';
import { Order } from '../orders/schemas/order.schema';

/**
 * Seller-dashboard analytics service (roadmap Phase 1).
 *
 * The acceptance test for the whole phase lives in this file: the headline figures are
 * recomputed from a fixed, hand-bucketed fixture of projected orders and asserted exactly, so
 * "landing totals equal server-side recomputation over the full dataset" is pinned at the unit
 * level. The aggregation `$match` is captured on every read to prove the store is scoped by
 * session values and the channel filter is the only client-controlled condition.
 */

const STORE_ID = new Types.ObjectId();
const SCOPE: StoreScope = { storeId: STORE_ID, vendorEmail: 'vendor-a@store.test' };

/** The mocked `aggregate().exec()` chain, resolved to the given projected rows. */
const agg = (rows: AnalyticsProjectedOrder[]) => ({
  exec: jest.fn().mockResolvedValue(rows),
});

const row = (
  over: Partial<AnalyticsProjectedOrder> & { createdAt: Date },
): AnalyticsProjectedOrder => ({
  _id: 'r',
  statusSlug: 'delivered',
  itemsTotal: 0,
  itemQty: 0,
  source: 'ONLINE',
  ...over,
});

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let orderModel: any;

  beforeEach(async () => {
    orderModel = {
      aggregate: jest.fn().mockImplementation(() => agg([])),
      // Phase 2: `summary()` resolves `discountSince` through a findOne chain. Default: no
      // snapshot-bearing order yet.
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(null),
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getModelToken(Order.name), useValue: orderModel },
        { provide: getModelToken('Product'), useValue: { aggregate: jest.fn(), find: jest.fn(), findOne: jest.fn() } },
        { provide: getModelToken('ProductVariant'), useValue: { aggregate: jest.fn(), find: jest.fn(), findOne: jest.fn() } },
      ],
    }).compile();
    service = module.get<AnalyticsService>(AnalyticsService);
  });

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-12T12:00:00Z'));
  });

  afterAll(() => jest.useRealTimers());

  /**
   * Deterministic 30-day window anchored to `now` (12:00 UTC / 13:00 Algiers on 2026-10-12):
   *   from = Algiers 2026-09-13 00:00  = 2026-09-12T23:00:00Z
   *   to   = Algiers 2026-10-13 00:00  = 2026-10-12T23:00:00Z
   * Previous period = [2026-08-13T23:00:00Z, 2026-09-12T23:00:00Z).
   */
  const RANGE_FROM = '2026-09-12T23:00:00.000Z';
  const RANGE_TO = '2026-10-12T23:00:00.000Z';
  const PREV_FROM = '2026-08-13T23:00:00.000Z';
  const PREV_TO = '2026-09-12T23:00:00.000Z';

  const current = () => [
    row({ _id: 'r1', createdAt: new Date('2026-09-20T10:00:00Z'), statusSlug: 'delivered', itemsTotal: 2500, itemQty: 3 }),
    row({ _id: 'r2', createdAt: new Date('2026-09-21T10:00:00Z'), statusSlug: 'cancelled', itemsTotal: 800, itemQty: 1 }),
    row({ _id: 'r3', createdAt: new Date('2026-09-22T10:00:00Z'), statusSlug: 'returned', itemsTotal: 1200, itemQty: 2 }),
    row({ _id: 'r4', createdAt: new Date('2026-10-01T22:00:00Z'), statusSlug: 'placed', itemsTotal: 300, itemQty: 1, source: 'MANUAL' }),
    row({ _id: 'r5', createdAt: new Date('2026-10-02T23:30:00Z'), statusSlug: 'delivered', itemsTotal: 600, itemQty: 1, source: 'POS' }),
  ];

  function lastMatch(): Record<string, unknown> {
    const calls = orderModel.aggregate.mock.calls;
    const stages = calls[calls.length - 1][0];
    return stages[0].$match;
  }

  describe('range resolution', () => {
    it('resolves a preset to its Algiers-anchored half-open window', async () => {
      await service.summary(SCOPE, { preset: '30d' });
      const m = lastMatch();
      expect(m.createdAt).toEqual({ $gte: new Date(RANGE_FROM), $lt: new Date(RANGE_TO) });
    });

    it('accepts a requested bucket over a preset', async () => {
      const res = await service.trend(SCOPE, { preset: '30d', bucket: 'week' });
      expect(res.bucket).toBe('week');
    });
  });

  describe('summary — the headline (phase acceptance)', () => {
    it('recomputes every landing figure over the projected dataset (D7 acceptance)', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(current()));
      const res = await service.summary(SCOPE, { preset: '30d', channel: 'all' });

      expect(res.preset).toBe('30d');
      expect(res.from).toBe(RANGE_FROM);
      expect(res.to).toBe(RANGE_TO);
      expect(res.bucket).toBe('day');
      expect(res.channel).toBe('all');
      expect(res.currency).toBe('DZD');
      expect(res.comparison).toBeNull();

      expect(res.summary).toEqual({
        netSales: 4600, // 2500 (delivered) + 1200 (returned) + 300 (manual) + 600 (POS)
        settled: 3100, // 2500 + 600 delivered; 4000-demand proofs: returned excluded
        returned: 1200, // r3 — reported separately, never added to sales
        grossVolume: 5400, // incl. the cancelled r2
        // Phase 2 (D12): these fixture rows carry no `items` snapshots, so gross/discount are
        // unknowable — the exact figures stay `null` rather than being guessed.
        grossSales: null,
        discount: null,
        orderCount: 4, // cancelled excluded
        units: 7, // 3 + 2 + 1 + 1
        aov: 1150, // 4600 / 4
      });
    });

    it('scopes the store from the session values, not from the query', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(current()));
      await service.summary(SCOPE, { preset: '30d' });
      const m = lastMatch();
      expect(m.$or).toEqual([
        { storeId: STORE_ID },
        { vendorEmail: 'vendor-a@store.test' },
      ]);
      expect(m.isDeleted).toEqual({ $ne: true });
      expect(m.source).toBeUndefined(); // channel=all adds no source condition
    });

    it('narrows the window by channel via the source $in filter', async () => {
      // Mirror the server-side $match: the mock returns only the ONLINE rows the pipeline keeps.
      orderModel.aggregate.mockImplementationOnce(() => agg(current().filter((r) => r.source === 'ONLINE')));
      const online = await service.summary(SCOPE, { preset: '30d', channel: 'online' });
      expect(lastMatch().source).toEqual({ $in: ['ONLINE'] });
      expect(online.summary).toMatchObject({ netSales: 3700, orderCount: 2, units: 5, settled: 2500, returned: 1200 });

      orderModel.aggregate.mockImplementationOnce(() => agg(current().filter((r) => r.source === 'POS')));
      const inStore = await service.summary(SCOPE, { preset: '30d', channel: 'in-store' });
      expect(lastMatch().source).toEqual({ $in: ['POS'] });
      expect(inStore.summary).toMatchObject({ netSales: 600, orderCount: 1, units: 1 });
    });
  });

  describe('summary — previous-period comparison', () => {
    const prevDelivered = () => [
      row({ _id: 'p1', createdAt: new Date('2026-09-01T10:00:00Z'), statusSlug: 'delivered', itemsTotal: 5000, itemQty: 1 }),
    ];

    it('returns the equal-length prior window with real deltas (D5)', async () => {
      orderModel.aggregate
        .mockImplementationOnce(() => agg(current()))
        .mockImplementationOnce(() => agg(prevDelivered()));
      const res = await service.summary(SCOPE, { preset: '30d', compare: 'true' });

      expect(res.comparison).not.toBeNull();
      expect(res.comparison!.from).toBe(PREV_FROM);
      expect(res.comparison!.to).toBe(PREV_TO);
      expect(res.comparison!.summary).toEqual({
        netSales: 5000, settled: 5000, returned: 0, grossVolume: 5000,
        grossSales: null, discount: null, // prior fixture rows carry no items snapshots
        orderCount: 1, units: 1, aov: 5000,
      });
      expect(res.comparison!.deltas).toEqual({
        netSales: -8,       // (4600 - 5000) / 5000
        settled: -38,       // (3100 - 5000) / 5000
        returned: null,     // previous period had no returns
        grossVolume: 8,     // (5400 - 5000) / 5000
        grossSales: null,   // no snapshot coverage in either period
        discount: null,
        orderCount: 300,    // (4 - 1) / 1
        units: 600,         // (7 - 1) / 1
        aov: -77,           // (1150 - 5000) / 5000
      });
    });

    it('deltas are null when the previous period baseline is zero', async () => {
      orderModel.aggregate
        .mockImplementationOnce(() => agg(current()))
        .mockImplementationOnce(() => agg([]));
      const res = await service.summary(SCOPE, { preset: '30d', compare: 'true' });
      expect(res.comparison!.summary.aov).toBeNull();
      expect(Object.values(res.comparison!.deltas).every((d) => d === null)).toBe(true);
    });
  });

  describe('trend', () => {
    it('emits contiguous day buckets over the window, zero-filled, exact keys (D4)', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(current()));
      const res = await service.trend(SCOPE, { preset: '30d', bucket: 'day' });

      expect(res.bucket).toBe('day');
      expect(res.points).toHaveLength(30);
      expect(res.points[0].key).toBe('2026-09-13');
      expect(res.points[29].key).toBe('2026-10-12');

      const point = res.points.find((p) => p.key === '2026-09-20')!;
      expect(point).toEqual({
        key: '2026-09-20', netSales: 2500, settled: 2500, returned: 0, orderCount: 1, units: 3,
        gross: null, discount: null, // rows carry no items snapshots → breakdown unavailable
      });
      // cancelled orders are excluded from the series: the bucket exists but stays zeroed
      expect(res.points.find((p) => p.key === '2026-09-21')).toEqual({
        key: '2026-09-21', netSales: 0, settled: 0, returned: 0, orderCount: 0, units: 0,
        gross: null, discount: null,
      });
      expect(res.points.find((p) => p.key === '2026-09-22')).toEqual({
        key: '2026-09-22', netSales: 1200, settled: 0, returned: 1200, orderCount: 1, units: 2,
        gross: null, discount: null,
      });
      // MANUAL and POS both count when channel=all (D6)
      expect(res.points.find((p) => p.key === '2026-10-01')!.netSales).toBe(300);
      expect(res.points.find((p) => p.key === '2026-10-03')!).toEqual({
        key: '2026-10-03', netSales: 600, settled: 600, returned: 0, orderCount: 1, units: 1,
        gross: null, discount: null,
      });
      expect(res.points.reduce((s, p) => s + p.netSales, 0)).toBe(4600);
    });

    it('month buckets align to Algiers month boundaries', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(current()));
      const res = await service.trend(SCOPE, { preset: '30d', bucket: 'month' });
      expect(res.points.map((p) => p.key)).toEqual(['2026-09', '2026-10']);
      expect(res.points[0].netSales).toBe(3700); // r1 + r3 (r2 cancelled excluded)
      expect(res.points[1].netSales).toBe(900); // r4 + r5
    });

    it('hour buckets cover the full Algiers day with the expected keys', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg([
        row({ _id: 'h1', createdAt: new Date('2026-10-12T10:30:00Z'), statusSlug: 'delivered', itemsTotal: 700, itemQty: 1 }),
      ]));
      const res = await service.trend(SCOPE, { preset: 'today', bucket: 'hour' });
      expect(res.points).toHaveLength(24);
      expect(res.points[0].key).toBe('2026-10-12T00:00');
      expect(res.points[23].key).toBe('2026-10-12T23:00');
      expect(res.points.find((p) => p.key === '2026-10-12T11:00')).toMatchObject({ netSales: 700, settled: 700 });
    });
  });

  describe('channels', () => {
    it('returns the full three-way split with shares (D6)', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(current()));
      const res = await service.channels(SCOPE, { preset: '30d' });

      expect(res.channels).toHaveLength(3);
      const online = res.channels.find((c) => c.channel === 'online')!;
      const manual = res.channels.find((c) => c.channel === 'manual')!;
      const inStore = res.channels.find((c) => c.channel === 'in-store')!;

      expect(online).toMatchObject({ orders: 3, netSales: 3700, units: 6, prevNetSales: null, deltaPct: null });
      expect(online.shareOfNetSales).toBeCloseTo((3700 / 4600) * 100, 5);
      expect(manual).toMatchObject({ orders: 1, netSales: 300, units: 1 });
      expect(inStore).toMatchObject({ orders: 1, netSales: 600, units: 1 });
      expect(res.channels.reduce((s, c) => s + (c.shareOfNetSales ?? 0), 0)).toBeCloseTo(100, 5);
    });

    it('a narrow channel request both filters the rows and reports that channel at 100% share', async () => {
      orderModel.aggregate.mockImplementationOnce(() =>
        agg(current().filter((r) => r.source === 'POS')),
      );
      const res = await service.channels(SCOPE, { preset: '30d', channel: 'in-store' });
      expect(res.channels).toHaveLength(1);
      expect(res.channels[0].channel).toBe('in-store');
      expect(res.channels[0]).toMatchObject({ netSales: 600, shareOfNetSales: 100 });
      expect(lastMatch().source).toEqual({ $in: ['POS'] });
    });

    it('adds previous-period net sales and deltas when comparing', async () => {
      orderModel.aggregate
        .mockImplementationOnce(() => agg(current()))
        .mockImplementationOnce(() => agg([
          row({ _id: 'p1', createdAt: new Date('2026-09-01T10:00:00Z'), statusSlug: 'delivered', itemsTotal: 5000, itemQty: 1 }),
        ]));
      const res = await service.channels(SCOPE, { preset: '30d', compare: 'true' });
      const online = res.channels.find((c) => c.channel === 'online')!;
      expect(online.prevNetSales).toBe(5000);
      expect(online.deltaPct).toBeCloseTo(-26, 5);
      expect(res.channels.find((c) => c.channel === 'manual')!.prevNetSales).toBe(0);
      expect(res.channels.find((c) => c.channel === 'manual')!.deltaPct).toBeNull();
    });
  });

  describe('sales breakdown (Phase 2 / D12)', () => {
    // Fully snapshot-covered fixture: c1 online 2×800@1000 + 1×900@900 (discount 400);
    // c2 cancelled (excluded from sales entirely); c3 manual 1×300@null (recorded no discount).
    const covered = () => [
      row({
        _id: 'c1',
        createdAt: new Date('2026-09-20T10:00:00Z'),
        statusSlug: 'delivered',
        itemsTotal: 2500,
        itemQty: 3,
        items: [
          { price: 800, quantity: 2, originalPrice: 1000 },
          { price: 900, quantity: 1, originalPrice: 900 },
        ],
      }),
      row({
        _id: 'c2',
        createdAt: new Date('2026-09-21T10:00:00Z'),
        statusSlug: 'cancelled',
        itemsTotal: 800,
        itemQty: 1,
        items: [{ price: 800, quantity: 1, originalPrice: 800 }],
      }),
      row({
        _id: 'c3',
        createdAt: new Date('2026-10-01T22:00:00Z'),
        statusSlug: 'placed',
        itemsTotal: 300,
        itemQty: 1,
        source: 'MANUAL',
        items: [{ price: 300, quantity: 1, originalPrice: null }],
      }),
    ];

    it('splits gross/discount exactly when every eligible line is covered', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(covered()));
      const res = await service.summary(SCOPE, { preset: '30d' });

      // net = 2500 + 300; gross = (1000×2 + 900×1) + 300; discount = gross − net
      expect(res.summary).toMatchObject({
        netSales: 2800,
        grossSales: 3200,
        discount: 400,
      });
      // a presence-but-null `originalPrice` counts as covered and zero discount
      expect(res.summary.grossVolume).toBe(3600); // incl. cancelled c2
    });

    it('marks a window unavailable when any eligible line is legacy (missing originalPrice)', async () => {
      const legacy = covered().concat([
        row({
          _id: 'c4',
          createdAt: new Date('2026-10-02T10:00:00Z'),
          statusSlug: 'delivered',
          itemsTotal: 600,
          itemQty: 1,
          source: 'POS',
          items: [{ price: 600, quantity: 1 }], // pre-deploy line: no snapshot field
        }),
      ]);
      orderModel.aggregate.mockImplementationOnce(() => agg(legacy));
      const res = await service.summary(SCOPE, { preset: '30d' });

      expect(res.summary.netSales).toBe(3400);
      expect(res.summary.grossSales).toBeNull();
      expect(res.summary.discount).toBeNull();
    });

    it('fails closed when a sales-eligible order has no items projection at all', async () => {
      // A projected order without an `items` array cannot prove coverage.
      orderModel.aggregate.mockImplementationOnce(() =>
        agg([row({ _id: 'c5', createdAt: new Date('2026-09-20T10:00:00Z'), statusSlug: 'delivered', itemsTotal: 100, itemQty: 1 })]),
      );
      const res = await service.summary(SCOPE, { preset: '30d' });
      expect(res.summary.grossSales).toBeNull();
      expect(res.summary.discount).toBeNull();
    });

    it('trend echoes the requested metric and prices points when covered (sales only)', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(covered()));
      const res = await service.trend(SCOPE, { preset: '30d', bucket: 'day', metric: 'sales' });

      expect(res.metric).toBe('sales');
      expect(res.discountAvailable).toBe(true);
      expect(res.points.find((p) => p.key === '2026-09-20')).toMatchObject({ gross: 2900, discount: 400 });
      // cancelled bucket stays empty — zeros would read as "no discount happened"
      expect(res.points.find((p) => p.key === '2026-09-21')).toMatchObject({ gross: null, discount: null });
      expect(res.points.find((p) => p.key === '2026-10-01')).toMatchObject({ gross: 300, discount: 0 });
    });

    it('trend defaults to sales and validates against the metric dictionary on other metrics', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(covered()));
      const res = await service.trend(SCOPE, { preset: '30d', bucket: 'day', metric: 'orders' });
      expect(res.metric).toBe('orders');
      // coverage is a data property, independent of the requested series
      expect(res.discountAvailable).toBe(true);
    });

    it('channels reports a per-channel breakdown with independent coverage', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(covered()));
      const res = await service.channels(SCOPE, { preset: '30d' });

      expect(res.channels.find((c) => c.channel === 'online')).toMatchObject({ grossSales: 2900, discount: 400 });
      expect(res.channels.find((c) => c.channel === 'manual')).toMatchObject({ grossSales: 300, discount: 0 });
    });

    it('discountSince is the earliest snapshot-bearing order and feeds the response', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(current()));
      orderModel.findOne.mockImplementationOnce(() => ({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ createdAt: new Date('2026-09-20T10:00:00Z') }),
      }));
      const res = await service.summary(SCOPE, { preset: '30d' });

      expect(res.discountSince).toBe('2026-09-20T10:00:00.000Z');
      // the query is store-scoped by session values (not the query) and matches field presence
      expect(orderModel.findOne).toHaveBeenCalledWith({
        $or: [{ storeId: STORE_ID }, { vendorEmail: SCOPE.vendorEmail }],
        isDeleted: { $ne: true },
        'items.originalPrice': { $exists: true },
      });
    });

    it('discountSince is null for a store with no snapshot-bearing orders yet', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(current()));
      const res = await service.summary(SCOPE, { preset: '30d' });
      expect(res.discountSince).toBeNull();
    });
  });

  describe('orders/status', () => {
    it('counts by status slug, zero-filling all seven statuses', async () => {
      orderModel.aggregate.mockImplementationOnce(() => agg(current()));
      const res = await service.ordersStatus(SCOPE, { preset: '30d' });
      expect(res.statuses).toEqual({
        placed: 1,
        confirmed: 0,
        dispatched: 0,
        'in-transit': 0,
        delivered: 2,
        cancelled: 1,
        returned: 1,
      });
    });
  });
});