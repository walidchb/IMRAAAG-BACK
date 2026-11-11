import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { VariantsService } from './variants.service';
import { ProductOption } from '../schemas/product-option.schema';
import { ProductOptionValue } from '../schemas/product-option-value.schema';
import { ProductVariant } from '../schemas/product-variant.schema';
import { VariantOptionValue } from '../schemas/variant-option-value.schema';
import { InventoryBalance } from '../schemas/inventory-balance.schema';
import { InventoryMovement } from '../schemas/inventory-movement.schema';
import { Product } from '../../products/schemas/product.schema';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

/**
 * Product image ↔ option value association — critical write-path behaviour.
 *
 * The endpoint moves a gallery image between values, so the parts worth pinning are the ones a
 * silent bug would corrupt: gallery membership, cross-store/foreign values, clear-before-set
 * moves (and the `clearedValueIds` report), clearing, and the all-or-nothing transaction.
 */

const STORE_ID = new Types.ObjectId();
const PRODUCT_ID = new Types.ObjectId();
const OPTION_ID = new Types.ObjectId();
const VALUE_A = new Types.ObjectId();
const VALUE_B = new Types.ObjectId();
const VALUE_INACTIVE = new Types.ObjectId();

const IMAGE_A = 'https://cdn.example.com/a.jpg';
const IMAGE_B = 'https://cdn.example.com/b.jpg';

/** A mongoose query-chain stub. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

/** A promise that also supports `.exec()`, like a Mongoose update query. */
const writable = (result: unknown) => {
  const promise: any = Promise.resolve(result);
  promise.exec = () => Promise.resolve(result);
  return promise;
};

const makeSession = (opts: { failStart?: boolean } = {}) => {
  const session: any = {
    startTransaction: jest.fn(async () => {
      if (opts.failStart) {
        throw new Error('Transaction numbers are only allowed on a replica set member or mongos');
      }
    }),
    abortTransaction: jest.fn(async () => undefined),
    endSession: jest.fn(async () => undefined),
    withTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
  };
  return session;
};

describe('VariantsService.setOptionValueImages', () => {
  let service: VariantsService;
  let productModel: any;
  let valueModel: any;
  let balanceModel: any;

  const values = () => [
    { _id: VALUE_A, optionId: OPTION_ID, image: IMAGE_A, isActive: true },
    { _id: VALUE_B, optionId: OPTION_ID, image: null, isActive: true },
    { _id: VALUE_INACTIVE, optionId: OPTION_ID, image: null, isActive: false },
  ];

  beforeEach(async () => {
    productModel = {
      findById: jest.fn().mockReturnValue(
        query({
          _id: PRODUCT_ID,
          storeId: STORE_ID,
          price: 1000,
          originalPrice: 1500,
          image: IMAGE_A,
          images: [IMAGE_B],
        }),
      ),
    };
    valueModel = {
      find: jest.fn().mockReturnValue(query(values())),
      updateMany: jest.fn().mockReturnValue(writable({ modifiedCount: 1 })),
      updateOne: jest.fn().mockReturnValue(writable({ modifiedCount: 1 })),
    };
    balanceModel = { startSession: jest.fn() };
    balanceModel.startSession.mockImplementation(async () => makeSession());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantsService,
        { provide: getModelToken(ProductOption.name), useValue: { find: jest.fn() } },
        { provide: getModelToken(ProductOptionValue.name), useValue: valueModel },
        { provide: getModelToken(ProductVariant.name), useValue: { find: jest.fn() } },
        { provide: getModelToken(VariantOptionValue.name), useValue: { find: jest.fn() } },
        { provide: getModelToken(InventoryBalance.name), useValue: balanceModel },
        { provide: getModelToken(InventoryMovement.name), useValue: { find: jest.fn() } },
        { provide: getModelToken(Product.name), useValue: productModel },
      ],
    }).compile();

    service = module.get<VariantsService>(VariantsService);
  });

  const assignment = (valueId: Types.ObjectId, image: string | null, optionId = OPTION_ID) => ({
    optionId: optionId.toString(),
    valueId: valueId.toString(),
    image,
  });

  it('links a gallery image to a value', async () => {
    const result = await service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
      assignments: [assignment(VALUE_B, IMAGE_B)],
    } as any);

    expect(result.updated).toBe(1);
    expect(result.assignments).toEqual([
      { optionId: OPTION_ID.toString(), valueId: VALUE_B.toString(), image: IMAGE_B },
    ]);
    expect(result.clearedValueIds).toEqual([]);
    expect(valueModel.updateOne).toHaveBeenCalledTimes(1);
    expect(valueModel.updateOne.mock.calls[0][1]).toEqual({ $set: { image: IMAGE_B } });
    expect(valueModel.updateOne.mock.calls[0][2]).toHaveProperty('session');
  });

  it('moves an image: clears the previous owner and reports it', async () => {
    const result = await service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
      assignments: [assignment(VALUE_B, IMAGE_A)],
    } as any);

    expect(result.clearedValueIds).toEqual([VALUE_A.toString()]);
    // Clear-before-set: the image is detached from every other value first.
    expect(valueModel.updateMany).toHaveBeenCalledTimes(1);
    expect(valueModel.updateMany.mock.calls[0][0]).toMatchObject({
      productId: PRODUCT_ID,
      storeId: STORE_ID,
      image: IMAGE_A,
    });
    expect(String(valueModel.updateMany.mock.calls[0][0]._id.$ne)).toBe(VALUE_B.toString());
    // Then the target is set.
    const setCall = valueModel.updateOne.mock.calls[0];
    expect(String(setCall[0]._id)).toBe(VALUE_B.toString());
    expect(setCall[1]).toEqual({ $set: { image: IMAGE_A } });
  });

  it('clears a link with a null image', async () => {
    const result = await service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
      assignments: [assignment(VALUE_A, null)],
    } as any);

    expect(result.updated).toBe(1);
    expect(valueModel.updateMany).not.toHaveBeenCalled();
    expect(valueModel.updateOne.mock.calls[0][1]).toEqual({ $set: { image: null } });
  });

  it('rejects an image that is not in the product gallery', async () => {
    await expect(
      service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
        assignments: [assignment(VALUE_B, 'https://cdn.example.com/not-in-gallery.jpg')],
      } as any),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.OPTION_VALUE_IMAGE_NOT_IN_GALLERY,
    });
    expect(balanceModel.startSession).not.toHaveBeenCalled();
  });

  it('rejects a foreign value or a value under a different option', async () => {
    await expect(
      service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
        assignments: [assignment(new Types.ObjectId(), IMAGE_B)],
      } as any),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.OPTION_VALUE_NOT_FOUND });

    await expect(
      service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
        assignments: [assignment(VALUE_B, IMAGE_B, new Types.ObjectId())],
      } as any),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.OPTION_VALUE_NOT_FOUND });

    expect(balanceModel.startSession).not.toHaveBeenCalled();
  });

  it('rejects linking an inactive value but still allows clearing it', async () => {
    await expect(
      service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
        assignments: [assignment(VALUE_INACTIVE, IMAGE_B)],
      } as any),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.VALIDATION_INVALID_VALUE });

    const cleared = await service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
      assignments: [assignment(VALUE_INACTIVE, null)],
    } as any);
    expect(cleared.updated).toBe(1);
  });

  it('maps a unique-index collision to OPTION_VALUE_IMAGE_DUPLICATE', async () => {
    valueModel.updateOne.mockReturnValueOnce(
      writable(Promise.reject(Object.assign(new Error('E11000'), { code: 11000 }))),
    );

    await expect(
      service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
        assignments: [assignment(VALUE_B, IMAGE_B)],
      } as any),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.OPTION_VALUE_IMAGE_DUPLICATE });
  });

  it('surfaces a transaction failure instead of falling back to sequential writes', async () => {
    valueModel.updateOne.mockReturnValueOnce(writable(Promise.reject(new Error('write aborted'))));

    await expect(
      service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
        assignments: [assignment(VALUE_B, IMAGE_B)],
      } as any),
    ).rejects.toThrow('write aborted');
  });

  it('refuses to run when transactions are unavailable', async () => {
    balanceModel.startSession.mockImplementation(async () => makeSession({ failStart: true }));

    await expect(
      service.setOptionValueImages(PRODUCT_ID.toString(), STORE_ID, {
        assignments: [assignment(VALUE_B, IMAGE_B)],
      } as any),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.INVALID_COMBINATION,
      errorParams: expect.objectContaining({ reason: 'transactions_unavailable' }),
    });
    expect(valueModel.updateOne).not.toHaveBeenCalled();
  });
});

describe('VariantsService.clearImageAssignments', () => {
  let service: VariantsService;
  let valueModel: any;

  beforeEach(async () => {
    valueModel = { updateMany: jest.fn().mockReturnValue(writable({ modifiedCount: 2 })) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantsService,
        { provide: getModelToken(ProductOption.name), useValue: {} },
        { provide: getModelToken(ProductOptionValue.name), useValue: valueModel },
        { provide: getModelToken(ProductVariant.name), useValue: {} },
        { provide: getModelToken(VariantOptionValue.name), useValue: {} },
        { provide: getModelToken(InventoryBalance.name), useValue: {} },
        { provide: getModelToken(InventoryMovement.name), useValue: {} },
        { provide: getModelToken(Product.name), useValue: {} },
      ],
    }).compile();

    service = module.get<VariantsService>(VariantsService);
  });

  it('clears links for removed gallery URLs, trimmed and de-duplicated', async () => {
    const cleared = await service.clearImageAssignments(PRODUCT_ID.toString(), STORE_ID, [
      ` ${IMAGE_A} `,
      IMAGE_A,
      '',
      null,
      IMAGE_B,
    ]);

    expect(cleared).toBe(2);
    expect(valueModel.updateMany).toHaveBeenCalledTimes(1);
    expect(valueModel.updateMany.mock.calls[0][0]).toMatchObject({
      productId: PRODUCT_ID,
      storeId: STORE_ID,
      image: { $in: [IMAGE_A, IMAGE_B] },
    });
    expect(valueModel.updateMany.mock.calls[0][1]).toEqual({ $set: { image: null } });
  });

  it('is a no-op when no URLs are supplied', async () => {
    await expect(service.clearImageAssignments(PRODUCT_ID.toString(), STORE_ID, [])).resolves.toBe(0);
    expect(valueModel.updateMany).not.toHaveBeenCalled();
  });
});
