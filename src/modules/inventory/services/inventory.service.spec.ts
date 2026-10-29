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
 * HI-8 coverage: a manual stock edit is a two-document write (balance + append-only ledger),
 * and the two must commit together.
 *
 * The defect this pins: `setOnHand`/`adjustByDelta` used to run the balance
 * `findOneAndUpdate`, then call `movementsService.append` with NO session. If the append
 * failed, stock had changed with no record — invisible to `reserved ≤ onHand`, unrecoverable
 * by replay. Every test that asserts `session` on *both* writes fails if either side of the
 * pair loses its session again.
 *
 * Tests pass an explicit `session` in the input (as `ReservationsService` tests do) so
 * `withOptionalSession` runs `work(existing)` inline; one dedicated test covers the
 * no-caller-session path, where the service must open its own transaction.
 */

const STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();
const VARIANT_ID = new Types.ObjectId();

/** Stands in for a ClientSession; identity is what matters to `withOptionalSession`. */
const SESSION = {} as ClientSession;

const baseInput = (overrides: Partial<SetOnHandInput> = {}): SetOnHandInput => ({
  storeId: STORE_ID,
  variantId: VARIANT_ID,
  quantity: 10,
  reason: 'restock',
  session: SESSION,
  ...overrides,
});

const baseAdjust = (overrides: Partial<AdjustDeltaInput> = {}): AdjustDeltaInput => ({
  storeId: STORE_ID,
  variantId: VARIANT_ID,
  delta: 5,
  reason: 'stock count',
  session: SESSION,
  ...overrides,
});

/** A query-chain stub: every mongoose builder method returns itself, `.exec()` resolves. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

describe('InventoryService — HI-8 (balance + ledger in one transaction)', () => {
  let service: InventoryService;
  let balanceModel: any;
  let variantModel: any;
  let movementsService: jest.Mocked<MovementsService>;

  const ownedVariant = (overrides: Record<string, unknown> = {}) => ({
    _id: VARIANT_ID,
    storeId: STORE_ID,
    isDeleted: false,
    ...overrides,
  });

  const balanceRow = (overrides: Record<string, unknown> = {}) => ({
    variantId: VARIANT_ID,
    storeId: STORE_ID,
    onHand: 3,
    reserved: 1,
    ...overrides,
  });

  beforeEach(async () => {
    balanceModel = {
      findOne: jest.fn().mockReturnValue(query(balanceRow())),
      findOneAndUpdate: jest.fn().mockReturnValue(query(balanceRow({ onHand: 10 }))),
      startSession: jest.fn(),
    };
    variantModel = {
      findById: jest.fn().mockReturnValue(query(ownedVariant())),
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

  describe('setOnHand', () => {
    it('runs the balance write and the ledger append on the SAME session', async () => {
      await service.setOnHand(baseInput());

      expect(balanceModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ session: SESSION }),
      );
      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({ session: SESSION }),
      );
    });

    it('reads the pre-balance inside the same session, so the ledger before-value is not stale', async () => {
      await service.setOnHand(baseInput({ quantity: 10 }));

      expect(balanceModel.findOne).toHaveBeenCalledWith({ variantId: VARIANT_ID });
      expect(balanceModel.findOne.mock.results[0].value.session).toHaveBeenCalledWith(SESSION);
    });

    it('records the delta against the pre-read, not against zero', async () => {
      balanceModel.findOne.mockReturnValue(query(balanceRow({ onHand: 3, reserved: 1 })));
      balanceModel.findOneAndUpdate.mockReturnValue(query(balanceRow({ onHand: 10, reserved: 1 })));

      await service.setOnHand(baseInput({ quantity: 10 }));

      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'initial_stock',
          quantityDelta: 7,
          onHandBefore: 3,
          onHandAfter: 10,
          reservedBefore: 1,
          reservedAfter: 1,
        }),
      );
    });

    it('first write (no balance row) inserts reserved: 0 and upserts', async () => {
      balanceModel.findOne.mockReturnValue(query(null));
      balanceModel.findOneAndUpdate.mockReturnValue(
        query(balanceRow({ onHand: 5, reserved: 0 })),
      );

      await service.setOnHand(baseInput({ quantity: 5 }));

      expect(balanceModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { $set: { onHand: 5, reserved: 0 } },
        expect.objectContaining({ upsert: true, session: SESSION }),
      );
      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({ quantityDelta: 5, onHandBefore: 0, reservedBefore: 0 }),
      );
    });

    it('propagates a ledger failure instead of reporting a change that did not commit', async () => {
      movementsService.append.mockRejectedValue(new Error('ledger insert failed'));

      await expect(service.setOnHand(baseInput())).rejects.toThrow('ledger insert failed');
    });

    it('refuses to set onHand below what is reserved', async () => {
      balanceModel.findOne.mockReturnValue(query(balanceRow({ onHand: 5, reserved: 4 })));
      // The `reserved ≤ quantity` predicate in the filter does not match, so the write
      // finds nothing. `upsert` must be false here: with a row present an upsert would try
      // to insert a duplicate balance and die on the unique variantId index (500) instead
      // of returning null for this typed conflict.
      balanceModel.findOneAndUpdate.mockReturnValue(query(null));

      await expect(
        service.setOnHand(baseInput({ quantity: 2 })),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.RESERVED_STOCK_CONFLICT });

      expect(balanceModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ upsert: false }),
      );
      expect(movementsService.append).not.toHaveBeenCalled();
    });

    it('reports a concurrent reserved bump as a conflict without writing', async () => {
      balanceModel.findOneAndUpdate.mockReturnValue(query(null));

      await expect(service.setOnHand(baseInput({ quantity: 5 }))).rejects.toMatchObject({
        errorCode: AppErrorCode.RESERVED_STOCK_CONFLICT,
      });
      expect(movementsService.append).not.toHaveBeenCalled();
    });

    it('validates quantity and reason before touching the database', async () => {
      await expect(
        service.setOnHand(baseInput({ quantity: 1.5 })),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.INVALID_QUANTITY });
      await expect(
        service.setOnHand(baseInput({ quantity: -1 })),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.INVALID_QUANTITY });
      await expect(service.setOnHand(baseInput({ reason: '  ' }))).rejects.toMatchObject({
        errorCode: AppErrorCode.ADJUSTMENT_REASON_REQUIRED,
      });

      expect(variantModel.findById).not.toHaveBeenCalled();
      expect(balanceModel.findOne).not.toHaveBeenCalled();
      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('denies a variant owned by another store before any write', async () => {
      variantModel.findById.mockReturnValue(query(ownedVariant({ storeId: OTHER_STORE_ID })));

      await expect(service.setOnHand(baseInput())).rejects.toMatchObject({
        errorCode: AppErrorCode.TENANT_ACCESS_DENIED,
      });

      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(movementsService.append).not.toHaveBeenCalled();
    });
  });

  describe('adjustByDelta', () => {
    it('runs the balance write and the ledger append on the SAME session', async () => {
      await service.adjustByDelta(baseAdjust({ delta: 5 }));

      expect(balanceModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ session: SESSION }),
      );
      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({ session: SESSION }),
      );
    });

    it('applies the optimistic onHand guard and keeps the ledger consistent with it', async () => {
      balanceModel.findOne.mockReturnValue(query(balanceRow({ onHand: 3, reserved: 1 })));
      balanceModel.findOneAndUpdate.mockReturnValue(query(balanceRow({ onHand: 8, reserved: 1 })));

      await service.adjustByDelta(baseAdjust({ delta: 5 }));

      const [filter, update, opts] = balanceModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual(
        expect.objectContaining({ variantId: VARIANT_ID, storeId: STORE_ID, onHand: 3 }),
      );
      expect(update).toEqual({ $inc: { onHand: 5 } });
      expect(opts).toEqual(expect.objectContaining({ upsert: false, session: SESSION }));
      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'manual_increase',
          quantityDelta: 5,
          onHandBefore: 3,
          onHandAfter: 8,
        }),
      );
    });

    it('labels a negative adjustment as manual_decrease', async () => {
      balanceModel.findOne.mockReturnValue(query(balanceRow({ onHand: 6, reserved: 1 })));
      balanceModel.findOneAndUpdate.mockReturnValue(query(balanceRow({ onHand: 4, reserved: 1 })));

      await service.adjustByDelta(baseAdjust({ delta: -2 }));

      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'manual_decrease', quantityDelta: -2 }),
      );
    });

    it('first write only accepts a positive delta and reserves room on insert', async () => {
      balanceModel.findOne.mockReturnValue(query(null));
      balanceModel.findOneAndUpdate.mockReturnValue(
        query(balanceRow({ onHand: 4, reserved: 0 })),
      );

      await service.adjustByDelta(baseAdjust({ delta: 4 }));

      const [filter, update, opts] = balanceModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual(expect.objectContaining({ onHand: 0 }));
      expect(update).toEqual({ $inc: { onHand: 4 }, $setOnInsert: { reserved: 0 } });
      expect(opts).toEqual(expect.objectContaining({ upsert: true, session: SESSION }));
    });

    it('rejects a negative first write (nothing to decrement)', async () => {
      balanceModel.findOne.mockReturnValue(query(null));

      await expect(service.adjustByDelta(baseAdjust({ delta: -3 }))).rejects.toMatchObject({
        errorCode: AppErrorCode.INVALID_QUANTITY,
      });
      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses to push onHand below zero', async () => {
      balanceModel.findOne.mockReturnValue(query(balanceRow({ onHand: 2, reserved: 0 })));

      await expect(service.adjustByDelta(baseAdjust({ delta: -5 }))).rejects.toMatchObject({
        errorCode: AppErrorCode.INVALID_QUANTITY,
      });
      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses to push onHand below the reserved units', async () => {
      balanceModel.findOne.mockReturnValue(query(balanceRow({ onHand: 5, reserved: 4 })));

      await expect(service.adjustByDelta(baseAdjust({ delta: -3 }))).rejects.toMatchObject({
        errorCode: AppErrorCode.RESERVED_STOCK_CONFLICT,
      });
      expect(movementsService.append).not.toHaveBeenCalled();
    });

    it('treats a lost optimistic race as a conflict, not a silent overwrite', async () => {
      balanceModel.findOneAndUpdate.mockReturnValue(query(null));

      await expect(service.adjustByDelta(baseAdjust({ delta: 1 }))).rejects.toMatchObject({
        errorCode: AppErrorCode.RESERVED_STOCK_CONFLICT,
      });
      expect(movementsService.append).not.toHaveBeenCalled();
    });

    it('validates delta and reason before touching the database', async () => {
      await expect(service.adjustByDelta(baseAdjust({ delta: 0 }))).rejects.toMatchObject({
        errorCode: AppErrorCode.INVALID_QUANTITY,
      });
      await expect(service.adjustByDelta(baseAdjust({ delta: 2.5 }))).rejects.toMatchObject({
        errorCode: AppErrorCode.INVALID_QUANTITY,
      });
      await expect(service.adjustByDelta(baseAdjust({ reason: '' }))).rejects.toMatchObject({
        errorCode: AppErrorCode.ADJUSTMENT_REASON_REQUIRED,
      });

      expect(variantModel.findById).not.toHaveBeenCalled();
      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('propagates a ledger failure instead of reporting a change that did not commit', async () => {
      movementsService.append.mockRejectedValue(new Error('ledger insert failed'));

      await expect(service.adjustByDelta(baseAdjust({ delta: 5 }))).rejects.toThrow(
        'ledger insert failed',
      );
    });
  });

  describe('no caller session (what the controller sends)', () => {
    it('opens its own transaction and runs both writes inside it', async () => {
      const txSession = {
        withTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
        endSession: jest.fn().mockResolvedValue(undefined),
      };
      const probeSession = {
        startTransaction: jest.fn(),
        abortTransaction: jest.fn(),
        endSession: jest.fn().mockResolvedValue(undefined),
      };
      balanceModel.startSession
        .mockResolvedValueOnce(probeSession as unknown as ClientSession)
        .mockResolvedValueOnce(txSession as unknown as ClientSession);

      await service.setOnHand(baseInput({ session: undefined }));

      expect(probeSession.startTransaction).toHaveBeenCalled();
      expect(probeSession.abortTransaction).toHaveBeenCalled();
      expect(txSession.withTransaction).toHaveBeenCalledTimes(1);
      expect(balanceModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ session: txSession }),
      );
      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({ session: txSession }),
      );
      expect(txSession.endSession).toHaveBeenCalled();
    });

    it('ends the session even when the ledger write fails', async () => {
      const txSession = {
        withTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
        endSession: jest.fn().mockResolvedValue(undefined),
      };
      const probeSession = {
        startTransaction: jest.fn(),
        abortTransaction: jest.fn(),
        endSession: jest.fn().mockResolvedValue(undefined),
      };
      balanceModel.startSession
        .mockResolvedValueOnce(probeSession as unknown as ClientSession)
        .mockResolvedValueOnce(txSession as unknown as ClientSession);
      movementsService.append.mockRejectedValue(new Error('ledger insert failed'));

      await expect(service.adjustByDelta(baseAdjust({ session: undefined }))).rejects.toThrow(
        'ledger insert failed',
      );

      expect(txSession.endSession).toHaveBeenCalled();
    });
  });
});
