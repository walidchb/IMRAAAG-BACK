import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { InventoryReadService } from './services/inventory-read.service';
import { Product } from '../products/schemas/product.schema';
import { InventoryBalance } from './schemas/inventory-balance.schema';
import { ProductVariant } from './schemas/product-variant.schema';
import { ProductOption } from './schemas/product-option.schema';
import { ProductOptionValue } from './schemas/product-option-value.schema';
import { VariantOptionValue } from './schemas/variant-option-value.schema';
import { DEFAULT_LOW_STOCK_THRESHOLD } from './services/low-stock';

/**
 * Contract tests for the inventory read paths (spec §2, §5, §8, §9).
 *
 * The pipeline is assembled at runtime from validated query params, so what is asserted
 * here is exactly the thing a unit test can pin without a database: which stages reach
 * MongoDB, in what order, with what operands. Search/filter/paging must happen inside
 * the aggregation (never in Node), the statistics query must carry no query at all, and
 * rows must come back in the fixed `{ productName: 1, _id: 1 }` order.
 */

const STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();

/** Captures the pipeline passed to `aggregate()` and resolves `exec()`. */
const aggregateMock = (result: unknown) => {
  const exec = jest.fn().mockResolvedValue(result);
  const aggregate = jest.fn().mockReturnValue({ exec });
  return { aggregate, exec };
};

/** A query-chain stub for `.find().lean().exec()`. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['select', 'lean']) q[m] = jest.fn().mockReturnValue(q);
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

describe('InventoryReadService', () => {
  let service: InventoryReadService;

  let variantModel: any;
  let productModel: any;
  let balanceModel: any;
  let optionModel: any;
  let valueModel: any;
  let joinModel: any;
  let agg: ReturnType<typeof aggregateMock>;

  const pipelineOf = (): Record<string, any>[] => agg.aggregate.mock.calls[agg.aggregate.mock.calls.length - 1][0];
  const firstMatch = (): Record<string, any> => pipelineOf()[0].$match;

  const facetStage = (): Record<string, any> =>
    pipelineOf().find((s) => !!s.$facet) as Record<string, any>;
  const rowsStages = (): Record<string, any>[] => facetStage().$facet.rows;
  const sortOf = (): Record<string, any> =>
    rowsStages().find((s) => !!s.$sort) as Record<string, any>;

  const statusMatchIndexes = (): number[] =>
    pipelineOf()
      .map((s, i) => (s.$match && i > 0 ? i : -1))
      .filter((i) => i >= 0);

  beforeEach(async () => {
    agg = aggregateMock([]);

    variantModel = { aggregate: agg.aggregate, find: jest.fn() };
    productModel = { findById: jest.fn(), find: jest.fn() };
    balanceModel = { find: jest.fn(), findOne: jest.fn(), collection: { name: 'inventory_balances' } };
    optionModel = { find: jest.fn().mockReturnValue(query([])) };
    valueModel = { find: jest.fn().mockReturnValue(query([])) };
    joinModel = { collection: { name: 'variant_option_values' } };
    productModel.collection = { name: 'products' };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryReadService,
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(InventoryBalance.name), useValue: balanceModel },
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(ProductOption.name), useValue: optionModel },
        { provide: getModelToken(ProductOptionValue.name), useValue: valueModel },
        { provide: getModelToken(VariantOptionValue.name), useValue: joinModel },
      ],
    }).compile();

    service = module.get(InventoryReadService);
  });

  describe('listStoreInventory — store scoping', () => {
    it('matches only the calling store, never a client-supplied one', async () => {
      await service.listStoreInventory(STORE_ID, {});

      expect(firstMatch().storeId).toEqual(STORE_ID);
      expect(firstMatch().storeId).not.toEqual(OTHER_STORE_ID);
      expect(firstMatch().isDeleted).toEqual({ $ne: true });
    });

    it('narrows productId to an ObjectId of the caller’s own filter', async () => {
      const productId = new Types.ObjectId().toString();
      await service.listStoreInventory(STORE_ID, { productId });

      expect(firstMatch().productId).toBeInstanceOf(Types.ObjectId);
      expect(String(firstMatch().productId)).toBe(productId);
      expect(firstMatch().storeId).toEqual(STORE_ID);
    });
  });

  describe('listStoreInventory — search', () => {
    it('adds an $or regex match over SKU and all three product name languages', async () => {
      await service.listStoreInventory(STORE_ID, { search: 'shirt' });

      const searchStage = pipelineOf()[pipelineOf().findIndex((s) => s.$match && s.$match.$or)];
      expect(searchStage.$match.$or).toEqual([
        { sku: { $regex: 'shirt', $options: 'i' } },
        { 'prod.nameEn': { $regex: 'shirt', $options: 'i' } },
        { 'prod.nameAr': { $regex: 'shirt', $options: 'i' } },
        { 'prod.nameFr': { $regex: 'shirt', $options: 'i' } },
      ]);
    });

    it('runs before the $facet that pages the result', async () => {
      await service.listStoreInventory(STORE_ID, { search: 'shirt' });

      const stages = pipelineOf();
      const searchIndex = stages.findIndex((s) => s.$match && s.$match.$or);
      const facetIndex = stages.findIndex((s) => s.$facet);
      expect(searchIndex).toBeGreaterThan(0);
      expect(searchIndex).toBeLessThan(facetIndex);
    });

    it('trims and ignores an empty search', async () => {
      await service.listStoreInventory(STORE_ID, { search: '   ' });

      expect(pipelineOf().some((s) => s.$match && s.$match.$or)).toBe(false);
    });

    it('escapes regex metacharacters so they match literally (LO-4)', async () => {
      await service.listStoreInventory(STORE_ID, { search: 'C++ (test)[1]' });

      const searchStage = pipelineOf()[pipelineOf().findIndex((s) => s.$match && s.$match.$or)];
      const escaped = searchStage.$match.$or[0].sku.$regex;
      // Careful: we assert against the same escaping rule the code uses, treating each of
      // `/.*+?^${}()|[]\` as a literal — an unmatched `(` would otherwise surface as a
      // Mongo 51091 regex error → 500 on the live endpoint.
      expect(escaped).toBe('C\\+\\+ \\(test\\)\\[1\\]');
    });
  });

  describe('listStoreInventory — status filters', () => {
    it('all: adds no extra match', async () => {
      await service.listStoreInventory(STORE_ID, { status: 'all' });
      expect(statusMatchIndexes()).toEqual([]);
    });

    it('active/inactive: folded into the first store match (index-friendly)', async () => {
      await service.listStoreInventory(STORE_ID, { status: 'active' });
      expect(firstMatch().isActive).toBe(true);
      expect(statusMatchIndexes()).toEqual([]);

      await service.listStoreInventory(STORE_ID, { status: 'inactive' });
      expect(firstMatch().isActive).toBe(false);
      expect(statusMatchIndexes()).toEqual([]);
    });

    it('low: field-to-field $expr over the resolved threshold, excluding zero', async () => {
      await service.listStoreInventory(STORE_ID, { status: 'low' });

      const stages = pipelineOf();
      const idx = statusMatchIndexes()[0];
      expect(stages[idx].$match.$expr).toEqual({
        $and: [{ $gt: ['$available', 0] }, { $lte: ['$available', '$threshold'] }],
      });
    });

    it('threshold never resolves to null: the platform default is the final fallback', async () => {
      await service.listStoreInventory(STORE_ID, {});

      const addFields = pipelineOf().find((s) => s.$addFields) as Record<string, any>;
      expect(addFields.$addFields.threshold).toEqual({
        $ifNull: [
          '$bal.lowStockThreshold',
          {
            $ifNull: [
              '$lowStockThreshold',
              { $ifNull: ['$prod.lowStockThreshold', DEFAULT_LOW_STOCK_THRESHOLD] },
            ],
          },
        ],
      });
    });

    it('out: available at or below zero', async () => {
      await service.listStoreInventory(STORE_ID, { status: 'out' });
      expect(pipelineOf()[statusMatchIndexes()[0]].$match).toEqual({ available: { $lte: 0 } });
    });

    it('in_stock: available above zero', async () => {
      await service.listStoreInventory(STORE_ID, { status: 'in_stock' });
      expect(pipelineOf()[statusMatchIndexes()[0]].$match).toEqual({ available: { $gt: 0 } });
    });

    it('filters before paging, so total reflects the filtered set', async () => {
      await service.listStoreInventory(STORE_ID, { status: 'out', page: 3, limit: 10 });

      const stages = pipelineOf();
      const statusIndex = statusMatchIndexes()[0];
      const facetIndex = stages.findIndex((s) => s.$facet);
      expect(statusIndex).toBeLessThan(facetIndex);
      // count shares the filtered pipeline: only rows/count sit inside $facet.
      expect(Object.keys(facetStage().$facet).sort()).toEqual(['count', 'rows']);
    });
  });

  describe('listStoreInventory — pagination', () => {
    it('skips and limits from page/limit', async () => {
      await service.listStoreInventory(STORE_ID, { page: 3, limit: 25 });

      const skip = rowsStages().find((s) => '$skip' in s) as Record<string, any>;
      const limit = rowsStages().find((s) => '$limit' in s) as Record<string, any>;
      expect(skip.$skip).toBe(50);
      expect(limit.$limit).toBe(25);
    });

    it('clamps page below 1 to 1 and limit outside 1..200', async () => {
      await service.listStoreInventory(STORE_ID, { page: 0, limit: 0 });
      expect((rowsStages().find((s) => '$skip' in s) as Record<string, any>).$skip).toBe(0);
      expect((rowsStages().find((s) => '$limit' in s) as Record<string, any>).$limit).toBe(1);

      await service.listStoreInventory(STORE_ID, { page: -5, limit: 5000 });
      expect((rowsStages().find((s) => '$skip' in s) as Record<string, any>).$skip).toBe(0);
      expect((rowsStages().find((s) => '$limit' in s) as Record<string, any>).$limit).toBe(200);
    });

    it('derives page metadata from the filtered total, not the store total', async () => {
      agg = aggregateMock([{ rows: [], count: [{ n: 17 }] }]);
      variantModel.aggregate = agg.aggregate;

      const result = await service.listStoreInventory(STORE_ID, {
        status: 'out',
        page: 2,
        limit: 10,
      });

      expect(result.total).toBe(17);
      expect(result.totalPages).toBe(2);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
    });

    it('returns an empty page rather than throwing when nothing matches', async () => {
      agg = aggregateMock([{ rows: [], count: [] }]);
      variantModel.aggregate = agg.aggregate;

      const result = await service.listStoreInventory(STORE_ID, { search: 'zzz-no-match' });

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });
  });

  describe('listStoreInventory — combined', () => {
    it('applies search + filter + pagination in one pipeline', async () => {
      agg = aggregateMock([{ rows: [], count: [{ n: 1 }] }]);
      variantModel.aggregate = agg.aggregate;

      await service.listStoreInventory(STORE_ID, {
        search: 'dress',
        status: 'out',
        page: 2,
        limit: 50,
      });

      const stages = pipelineOf();
      const order = stages.map((s) => Object.keys(s)[0]);
      const searchIndex = stages.findIndex((s) => s.$match && s.$match.$or);
      const statusIndex = stages.findIndex((s) => s.$match && s.$match.available);
      const facetIndex = stages.findIndex((s) => s.$facet);

      expect(searchIndex).toBeGreaterThan(0);
      expect(statusIndex).toBeGreaterThan(searchIndex);
      expect(facetIndex).toBeGreaterThan(statusIndex);

      // Derived fields exist before the computed filter reads them, and both run before paging.
      const addFieldsIndex = stages.findIndex((s) => s.$addFields);
      expect(addFieldsIndex).toBeGreaterThan(0);
      expect(addFieldsIndex).toBeLessThan(statusIndex);
      expect(order[0]).toBe('$match');

      expect(sortOf().$sort).toEqual({ productName: 1, _id: 1 });
      expect((rowsStages().find((s) => '$skip' in s) as Record<string, any>).$skip).toBe(50);
      expect((rowsStages().find((s) => '$limit' in s) as Record<string, any>).$limit).toBe(50);

      // Exactly one aggregate call: filtering and paging are the database's job.
      expect(agg.aggregate).toHaveBeenCalledTimes(1);
    });

    it('does not carry a summary in the list facet (stats live on /inventory/stats)', async () => {
      await service.listStoreInventory(STORE_ID, {});

      expect(Object.keys(facetStage().$facet).sort()).toEqual(['count', 'rows']);
    });
  });

  describe('getStoreStats', () => {
    it('matches the store only — no search, filter or paging can reach it', async () => {
      agg = aggregateMock([]);
      variantModel.aggregate = agg.aggregate;

      await service.getStoreStats(STORE_ID);

      const stages = pipelineOf();
      expect(stages[0].$match).toEqual({ storeId: STORE_ID, isDeleted: { $ne: true } });
      expect(stages.some((s) => s.$facet)).toBe(false);
      expect(stages.some((s) => s.$skip)).toBe(false);
      expect(stages.some((s) => s.$limit)).toBe(false);
      expect(stages.some((s) => s.$sort)).toBe(false);
      // No search regex, no status predicate: a single $match and it is the store scope.
      expect(stages.filter((s) => s.$match)).toHaveLength(1);
      expect(stages.some((s) => s.$group)).toBe(true);
    });

    it('scopes to the calling store', async () => {
      agg = aggregateMock([]);
      variantModel.aggregate = agg.aggregate;

      await service.getStoreStats(OTHER_STORE_ID);

      expect(firstMatch().storeId).toEqual(OTHER_STORE_ID);
    });

    it('returns the grouped totals unchanged', async () => {
      agg = aggregateMock([
        {
          _id: null,
          variantCount: 500,
          activeCount: 460,
          lowStockCount: 35,
          outOfStockCount: 80,
          totalOnHand: 4200,
          totalReserved: 120,
          totalAvailable: 4080,
        },
      ]);
      variantModel.aggregate = agg.aggregate;

      const stats = await service.getStoreStats(STORE_ID);

      expect(stats).toEqual({
        variantCount: 500,
        activeCount: 460,
        lowStockCount: 35,
        outOfStockCount: 80,
        totalOnHand: 4200,
        totalReserved: 120,
        totalAvailable: 4080,
      });
    });

    it('returns zeroes for a store with no inventory', async () => {
      agg = aggregateMock([]);
      variantModel.aggregate = agg.aggregate;

      expect(await service.getStoreStats(STORE_ID)).toEqual({
        variantCount: 0,
        activeCount: 0,
        lowStockCount: 0,
        outOfStockCount: 0,
        totalOnHand: 0,
        totalReserved: 0,
        totalAvailable: 0,
      });
    });
  });
});
