import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ClientSession, Types } from 'mongoose';
import { InventoryService, SetOnHandInput, AdjustDeltaInput } from './inventory.service';
import { InventoryBalance } from '../schemas/inventory-balance.schema';
import { ProductVariant } from '../schemas/product-variant.schema';
import { Product } from '../../products/schemas/product.schema';
import { MovementsService } from './movements.service';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

/**
 * Store-isolation matrix (roadmap Phase 7, D3).
 *
 * One vendor's ids must never mutate another vendor's stock — and the refusal must happen
 * BEFORE any balance write or ledger append, so a denied request leaves no trace at all.
 * The full matrix, per entry point:
 *
 *   entry point                 | pinned here        | also pinned in
 *   ----------------------------|--------------------|----------------------------------
 *   setOnHand (foreign store)   | (baseline)         | inventory.service.spec.ts
 *   adjustByDelta (foreign)     | this file          | —
 *   bulkAdjust (mixed batch)    | this file          | —
 *   assertVariantAccess         | this file          | —
 *   variants mutations          | variants-ownership.spec.ts (B2) | —
 *   reserve (foreign variant)   | —                  | reservations.service.spec.ts
 *   read/list scoping           | —                  | inventory-read.service.spec.ts
 *   controller smuggling        | —                  | inventory.controller.spec.ts
 *
 * `bulkAdjust` matters most: a batch that mixes vendor A's and vendor B's variant ids must
 * update A's rows and refuse B's with a per-item error — never abort silently, never touch
 * the foreign row, and never leak whether B's id exists.
 */

const STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();
const VARIANT_ID = new Types.ObjectId();
const OTHER_VARIANT_ID = new Types.ObjectId();

/** Stands in for a ClientSession; identity is what matters to `withOptionalSession`. */
const SESSION = {} as ClientSession;

const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

describe('Store-isolation matrix — inventory write entry points', () => {
  let service: InventoryService;
  let balanceModel: any;
  let variantModel: any;
  let movementsService: jest.Mocked<MovementsService>;

  const ownedVariant = (over: Record<string, unknown> = {}) => ({
    _id: VARIANT_ID,
    storeId: STORE_ID,
    isDeleted: false,
    ...over,
  });

  const balanceRow = (over: Record<string, unknown> = {}) => ({
    variantId: VARIANT_ID,
    storeId: STORE_ID,
    onHand: 3,
    reserved: 1,
    ...over,
  });

  beforeEach(async () => {
    balanceModel = {
      findOne: jest.fn().mockReturnValue(query(balanceRow())),
      findOneAndUpdate: jest.fn().mockReturnValue(query(balanceRow({ onHand: 10 }))),
      // bulkAdjust drives setOnHand/adjustByDelta with no caller session, so each write opens
      // its own via openTransactionSession: a probe (start/abort/end) plus a real session.
      startSession: jest.fn().mockImplementation(async () => ({
        startTransaction: jest.fn().mockResolvedValue(undefined),
        abortTransaction: jest.fn().mockResolvedValue(undefined),
        endSession: jest.fn().mockResolvedValue(undefined),
        withTransaction: jest.fn(async (cb: any) => cb()),
      })),
    };
    variantModel = {
      findById: jest.fn().mockReturnValue(query(ownedVariant())),
      find: jest.fn().mockReturnValue(query([{ _id: VARIANT_ID }])),
    };
    movementsService = {
      append: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<MovementsService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: getModelToken(InventoryBalance.name), useValue: balanceModel },
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(Product.name), useValue: {} },
        { provide: MovementsService, useValue: movementsService },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
  });

  const baseAdjust = (overrides: Partial<AdjustDeltaInput> = {}): AdjustDeltaInput => ({
    storeId: STORE_ID,
    variantId: VARIANT_ID,
    delta: 5,
    reason: 'stock count',
    session: SESSION,
    ...overrides,
  });

  it('adjustByDelta denies a variant owned by another store before any write', async () => {
    variantModel.findById.mockReturnValue(query(ownedVariant({ storeId: OTHER_STORE_ID })));

    await expect(service.adjustByDelta(baseAdjust())).rejects.toMatchObject({
      errorCode: AppErrorCode.TENANT_ACCESS_DENIED,
    });

    expect(balanceModel.findOne).not.toHaveBeenCalled();
    expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(movementsService.append).not.toHaveBeenCalled();
  });

  it('adjustByDelta also denies a soft-deleted variant (a tombstone is not stock)', async () => {
    variantModel.findById.mockReturnValue(query(ownedVariant({ isDeleted: true })));

    await expect(service.adjustByDelta(baseAdjust())).rejects.toMatchObject({
      errorCode: AppErrorCode.TENANT_ACCESS_DENIED,
    });
    expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(movementsService.append).not.toHaveBeenCalled();
  });

  describe('bulkAdjust — mixed-tenant batch', () => {
    const batch = (items: Array<Record<string, unknown>>, reason = 'weekly count') =>
      service.bulkAdjust(STORE_ID, items as any, reason);

    it('updates the owned row and refuses the foreign row with a per-item error', async () => {
      // variantModel.find scopes by storeId: only vendor A's id comes back as owned.
      variantModel.find.mockReturnValue(query([{ _id: VARIANT_ID }]));

      const result = await batch([
        { variantId: VARIANT_ID.toString(), delta: 2 },
        { variantId: OTHER_VARIANT_ID.toString(), delta: -99 },
      ]);

      expect(result.updated).toHaveLength(1);
      expect(result.errors).toEqual([
        {
          variantId: OTHER_VARIANT_ID.toString(),
          code: AppErrorCode.VARIANT_NOT_FOUND,
          message: 'Variant does not exist in this store',
        },
      ]);
      // Exactly one write pair: the owned row's set/delta — the foreign id never reached a write.
      expect(balanceModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(movementsService.append).toHaveBeenCalledTimes(1);
      expect(variantModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: STORE_ID, isDeleted: { $ne: true } }),
      );
    });

    it('refuses the whole batch when no reason is given', async () => {
      await expect(batch([{ variantId: VARIANT_ID.toString(), delta: 1 }], '  ')).rejects.toMatchObject({
        errorCode: AppErrorCode.ADJUSTMENT_REASON_REQUIRED,
      });
      expect(variantModel.find).not.toHaveBeenCalled();
    });

    it('rejects an item carrying both quantity and delta (INVALID_ADJUSTMENT_MODE)', async () => {
      const result = await batch([
        { variantId: VARIANT_ID.toString(), quantity: 5, delta: 1 },
      ]);

      expect(result.updated).toHaveLength(0);
      expect(result.errors[0]).toMatchObject({ code: AppErrorCode.INVALID_ADJUSTMENT_MODE });
      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects an item carrying neither quantity nor delta', async () => {
      const result = await batch([{ variantId: VARIANT_ID.toString() }]);

      expect(result.errors[0]).toMatchObject({ code: AppErrorCode.INVALID_ADJUSTMENT_MODE });
    });

    it('keeps going after one item conflicts, reporting the conflict per item', async () => {
      balanceModel.findOneAndUpdate
        .mockReturnValueOnce(query(null)) // first item: optimistic CAS lost → RESERVED_STOCK_CONFLICT
        .mockReturnValueOnce(query(balanceRow({ onHand: 6 }))); // second item succeeds

      const result = await batch([
        { variantId: VARIANT_ID.toString(), delta: 1 },
        { variantId: VARIANT_ID.toString(), delta: 2 },
      ]);

      expect(result.updated).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ code: AppErrorCode.RESERVED_STOCK_CONFLICT });
    });

    it('reports a malformed variant id as not-found without querying', async () => {
      const result = await batch([{ variantId: 'not-an-id', delta: 1 }]);

      expect(result.errors[0]).toMatchObject({ code: AppErrorCode.VARIANT_NOT_FOUND });
      expect(variantModel.findById).not.toHaveBeenCalled();
    });
  });

  describe('assertVariantAccess', () => {
    it('passes for a live variant of the caller\'s store', async () => {
      await expect(service.assertVariantAccess(VARIANT_ID, STORE_ID)).resolves.toBeUndefined();
    });

    it('denies a variant owned by another store', async () => {
      variantModel.findById.mockReturnValue(query(ownedVariant({ storeId: OTHER_STORE_ID })));

      await expect(service.assertVariantAccess(OTHER_VARIANT_ID, STORE_ID)).rejects.toMatchObject({
        errorCode: AppErrorCode.TENANT_ACCESS_DENIED,
      });
    });

    it('denies a soft-deleted variant', async () => {
      variantModel.findById.mockReturnValue(query(ownedVariant({ isDeleted: true })));

      await expect(service.assertVariantAccess(VARIANT_ID, STORE_ID)).rejects.toMatchObject({
        errorCode: AppErrorCode.TENANT_ACCESS_DENIED,
      });
    });

    it('denies an unknown id without distinguishing it from a foreign one', async () => {
      variantModel.findById.mockReturnValue(query(null));

      await expect(service.assertVariantAccess(VARIANT_ID, STORE_ID)).rejects.toMatchObject({
        errorCode: AppErrorCode.TENANT_ACCESS_DENIED,
      });
    });
  });
});
