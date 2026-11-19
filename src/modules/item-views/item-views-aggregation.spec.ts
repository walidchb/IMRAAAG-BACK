import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Product } from '../products/schemas/product.schema';
import { Box } from '../boxes/schemas/box.schema';
import { StoresService } from '../stores/stores.service';
import { ItemViewsService } from './item-views.service';
import { ItemViewDaily } from './schemas/item-view-daily.schema';

const STORE = new Types.ObjectId();
const PRODUCT_ID = new Types.ObjectId();
const BOX_ID = new Types.ObjectId();

const chain = (result: any) => {
  const query: any = {};
  for (const method of ['select', 'lean', 'exec']) {
    query[method] = jest.fn().mockReturnValue(query);
  }
  query.exec = jest.fn().mockResolvedValue(result);
  return query;
};

/** The `aggregate(...).option(...)` chain resolves the pre-computed facet result. */
const agg = (result: any) => ({
  option: jest.fn().mockResolvedValue(result),
});

describe('ItemViewsService reads', () => {
  let service: ItemViewsService;
  let viewModel: { aggregate: jest.Mock; updateOne: jest.Mock; exists: jest.Mock; create: jest.Mock };
  let productModel: { findOne: jest.Mock; find: jest.Mock };
  let boxModel: { findOne: jest.Mock; find: jest.Mock };
  let config: { get: jest.Mock };

  const build = async (enabled = true) => {
    viewModel = {
      aggregate: jest.fn(),
      updateOne: jest.fn(),
      exists: jest.fn(),
      create: jest.fn(),
    };
    productModel = { findOne: jest.fn(), find: jest.fn().mockReturnValue(chain([])) };
    boxModel = { findOne: jest.fn(), find: jest.fn().mockReturnValue(chain([])) };
    config = {
      get: jest.fn((key: string) =>
        key === 'itemViews'
          ? { enabled, dedupeMinutes: 30, hashSalt: 'salt', retentionDays: 0 }
          : key === 'jwt.secret'
            ? 'jwt-secret'
            : undefined,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ItemViewsService,
        { provide: getModelToken(ItemViewDaily.name), useValue: viewModel },
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(Box.name), useValue: boxModel },
        { provide: StoresService, useValue: { findByMemberId: jest.fn() } },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(ItemViewsService);
  };

  beforeEach(() => build(true));

  describe('summary', () => {
    it('uses the distinct all-scope unique, never the sum of type uniques', async () => {
      viewModel.aggregate.mockReturnValue(
        agg([
          {
            byType: [
              { itemType: 'product', views: 8, itemsViewed: 2 },
              { itemType: 'box', views: 2, itemsViewed: 1 },
            ],
            // Deliberately overlaps: the same visitor viewed a product and a box.
            typeUniques: [
              { _id: 'product', uniqueVisitors: 2 },
              { _id: 'box', uniqueVisitors: 2 },
            ],
            allUniques: [{ uniqueVisitors: 3 }],
            allTotal: [{ totalViews: 10 }],
          },
        ]),
      );

      const res = await service.summary(STORE, {});

      expect(res.totalViews).toBe(10);
      expect(res.uniqueVisitors).toBe(3);
      expect(res.uniqueVisitors).not.toBe(4);
      expect(res.itemsViewed).toBe(3);
      expect(res.viewsPerVisitor).toBe(3.33);
      expect(res.byType.product).toEqual({ views: 8, uniqueVisitors: 2, itemsViewed: 2 });
      expect(res.byType.box).toEqual({ views: 2, uniqueVisitors: 2, itemsViewed: 1 });
      expect(res.preset).toBe('7d');
    });

    it('filters the match by type and leaves the other type at zero', async () => {
      viewModel.aggregate.mockReturnValue(
        agg([
          {
            byType: [{ itemType: 'product', views: 5, itemsViewed: 1 }],
            typeUniques: [{ _id: 'product', uniqueVisitors: 1 }],
            allUniques: [{ uniqueVisitors: 1 }],
            allTotal: [{ totalViews: 5 }],
          },
        ]),
      );

      const res = await service.summary(STORE, { type: 'product' });

      const match = viewModel.aggregate.mock.calls[0][0][0].$match;
      expect(match.storeId).toBe(STORE);
      expect(match.itemType).toBe('product');
      expect(res.byType.box).toEqual({ views: 0, uniqueVisitors: 0, itemsViewed: 0 });
      expect(res.totalViews).toBe(5);
    });

    it('returns zeros for an empty period', async () => {
      viewModel.aggregate.mockReturnValue(agg([{}]));

      const res = await service.summary(STORE, {});

      expect(res).toMatchObject({
        totalViews: 0,
        uniqueVisitors: 0,
        itemsViewed: 0,
        viewsPerVisitor: 0,
      });
      expect(res.byType.product).toEqual({ views: 0, uniqueVisitors: 0, itemsViewed: 0 });
    });

    it('returns zeros and enabled:false when the feature is off', async () => {
      await build(false);

      const res = await service.summary(STORE, {});

      expect(res.enabled).toBe(false);
      expect(res.totalViews).toBe(0);
      expect(viewModel.aggregate).not.toHaveBeenCalled();
    });
  });

  describe('items', () => {
    const row = (id: Types.ObjectId, type: 'product' | 'box', views: number, unique: number) => ({
      _id: { itemType: type, itemId: id },
      views,
      uniqueVisitors: unique,
    });

    it('maps share, archive state and deleted rows', async () => {
      viewModel.aggregate.mockReturnValue(
        agg([
          {
            rows: [row(PRODUCT_ID, 'product', 60, 2), row(BOX_ID, 'box', 40, 1)],
            meta: [{ total: 2 }],
            totals: [{ totalViews: 100 }],
          },
        ]),
      );
      productModel.find.mockReturnValue(
        chain([
          {
            _id: PRODUCT_ID,
            nameEn: 'Shirt',
            nameAr: 'قميص',
            nameFr: 'Chemise',
            image: 'shirt.jpg',
            slug: 'shirt',
            published: true,
            isArchived: true,
          },
        ]),
      );
      boxModel.find.mockReturnValue(chain([]));

      const res = await service.items(STORE, {});

      expect(res.total).toBe(2);
      expect(res.totalViews).toBe(100);
      expect(res.items[0]).toMatchObject({
        itemType: 'product',
        itemId: String(PRODUCT_ID),
        deleted: false,
        isArchived: true,
        views: 60,
        uniqueVisitors: 2,
        share: 60,
      });
      expect(res.items[0].name).toEqual({ en: 'Shirt', fr: 'Chemise', ar: 'قميص' });
      expect(res.items[1]).toMatchObject({
        itemType: 'box',
        deleted: true,
        name: null,
        image: null,
        slug: null,
        share: 40,
      });
    });

    it('sorts by unique and applies pagination in the pipeline', async () => {
      viewModel.aggregate.mockReturnValue(agg([{ rows: [], meta: [], totals: [] }]));

      await service.items(STORE, { sort: 'unique', limit: 5, offset: 10 });

      const pipeline = viewModel.aggregate.mock.calls[0][0];
      const sortStage = pipeline.find((stage: any) => stage.$sort);
      expect(Object.keys(sortStage.$sort)[0]).toBe('uniqueVisitors');
      const facet = pipeline.find((stage: any) => stage.$facet).$facet;
      expect(facet.rows).toEqual([{ $skip: 10 }, { $limit: 5 }]);
    });

    it('returns an empty list and enabled:false when the feature is off', async () => {
      await build(false);

      const res = await service.items(STORE, {});

      expect(res).toMatchObject({ enabled: false, total: 0, totalViews: 0, items: [] });
      expect(viewModel.aggregate).not.toHaveBeenCalled();
    });
  });

  describe('itemDetail', () => {
    const doc = {
      _id: PRODUCT_ID,
      nameEn: 'Shirt',
      nameAr: 'قميص',
      nameFr: 'Chemise',
      image: 'shirt.jpg',
      slug: 'shirt',
      published: true,
      isArchived: false,
    };

    it('404s a foreign or missing product', async () => {
      productModel.findOne.mockReturnValue(chain(null));

      await expect(service.itemDetail(STORE, 'product', String(PRODUCT_ID), {})).rejects.toMatchObject(
        { errorCode: AppErrorCode.PRODUCT_NOT_FOUND },
      );
    });

    it('404s a foreign or missing box', async () => {
      boxModel.findOne.mockReturnValue(chain(null));

      await expect(service.itemDetail(STORE, 'box', String(BOX_ID), {})).rejects.toBeInstanceOf(
        AppException,
      );
      expect(boxModel.findOne).toHaveBeenCalledWith({ _id: BOX_ID, storeId: STORE });
    });

    it('404s a malformed id without querying', async () => {
      await expect(service.itemDetail(STORE, 'product', 'not-an-id', {})).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_NOT_FOUND,
      });
      expect(productModel.findOne).not.toHaveBeenCalled();
    });

    it('returns totals and a zero-filled daily series', async () => {
      productModel.findOne.mockReturnValue(chain(doc));
      const dayWithData = new Date('2026-06-10T23:00:00.000Z'); // 2026-06-11 Algiers
      viewModel.aggregate.mockReturnValue(
        agg([
          {
            totals: [{ totalViews: 7, uniqueVisitors: 3 }],
            daily: [{ _id: dayWithData, views: 4, uniqueVisitors: 2 }],
          },
        ]),
      );

      const res: any = await service.itemDetail(STORE, 'product', String(PRODUCT_ID), {
        preset: 'custom',
        from: '2026-06-10',
        to: '2026-06-11',
        include: 'daily',
      });

      expect(res.totalViews).toBe(7);
      expect(res.uniqueVisitors).toBe(3);
      expect(res.daily).toHaveLength(2);
      expect(res.daily[0]).toEqual({ date: '2026-06-10', views: 0, uniqueVisitors: 0 });
      expect(res.daily[1]).toEqual({ date: '2026-06-11', views: 4, uniqueVisitors: 2 });
    });

    it('keeps the ownership check when the feature is off', async () => {
      await build(false);
      productModel.findOne.mockReturnValue(chain(doc));

      const res: any = await service.itemDetail(STORE, 'product', String(PRODUCT_ID), {});

      expect(res.enabled).toBe(false);
      expect(res.totalViews).toBe(0);
      expect(productModel.findOne).toHaveBeenCalledWith({ _id: PRODUCT_ID, storeId: STORE });
      expect(viewModel.aggregate).not.toHaveBeenCalled();
    });
  });
});
