import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { VariantsService } from './services/variants.service';
import { ProductOption } from './schemas/product-option.schema';
import { ProductOptionValue } from './schemas/product-option-value.schema';
import { ProductVariant } from './schemas/product-variant.schema';
import { VariantOptionValue } from './schemas/variant-option-value.schema';
import { InventoryBalance } from './schemas/inventory-balance.schema';
import { InventoryMovement } from './schemas/inventory-movement.schema';
import { Product } from '../products/schemas/product.schema';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

/**
 * Variant-pricing tenancy (Variant Pricing roadmap, Phase 1).
 *
 * A per-variant price is a seller-owned value, so the write path must never let one store read or
 * mutate another store's variant. `updateVariant(productId, storeId, variantId, dto)` takes the
 * store from its **argument** (resolved from the session by the controller), resolves the product
 * and the variant *through* that store, and builds its `$set` from a fixed field list — a
 * `storeId` smuggled into the body is never consulted.
 *
 * The read is store-scoped (`requireVariant`), so a foreign variant is indistinguishable from a
 * missing one; the write then addresses the resolved `_id`, which can only be an in-store row.
 * Nest guards are an HTTP concern and do not run on a plain method call, so the service is
 * exercised directly.
 */

const STORE_A = new Types.ObjectId();
const STORE_B = new Types.ObjectId();
const PRODUCT_A = new Types.ObjectId();
const VARIANT_A = new Types.ObjectId();
const VARIANT_B = new Types.ObjectId();

/** Query-chain stub: every mongoose builder returns itself, `.exec()` resolves. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

describe('Variant pricing tenancy — a price write is scoped to the session store', () => {
  let service: VariantsService;
  let productModel: any;
  let variantModel: any;

  beforeEach(async () => {
    productModel = { findById: jest.fn().mockReturnValue(query({ _id: PRODUCT_A, storeId: STORE_A })) };
    variantModel = {
      findOne: jest.fn().mockReturnValue(query({ _id: VARIANT_A })),
      findOneAndUpdate: jest.fn().mockReturnValue(query({ _id: VARIANT_A, priceOverride: 1500 })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantsService,
        { provide: getModelToken(ProductOption.name), useValue: {} },
        { provide: getModelToken(ProductOptionValue.name), useValue: {} },
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(VariantOptionValue.name), useValue: {} },
        { provide: getModelToken(InventoryBalance.name), useValue: {} },
        { provide: getModelToken(InventoryMovement.name), useValue: {} },
        { provide: getModelToken(Product.name), useValue: productModel },
      ],
    }).compile();

    service = module.get<VariantsService>(VariantsService);
  });

  it('resolves the variant through the session store and writes the price to that row', async () => {
    await service.updateVariant(PRODUCT_A.toString(), STORE_A, VARIANT_A.toString(), {
      priceOverride: 1500,
    });

    // The read carries the session store, so an id from another store can never resolve.
    expect(variantModel.findOne).toHaveBeenCalledWith({
      _id: VARIANT_A.toString(),
      productId: new Types.ObjectId(PRODUCT_A.toString()),
      storeId: STORE_A,
    });
    expect(variantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_A },
      { $set: { priceOverride: 1500 } },
      { new: true },
    );
  });

  it('reports a variant owned by another store as not found and never writes the price', async () => {
    variantModel.findOne.mockReturnValue(query(null));

    await expect(
      service.updateVariant(PRODUCT_A.toString(), STORE_A, VARIANT_B.toString(), { priceOverride: 1500 }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.VARIANT_NOT_FOUND });

    expect(variantModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses a product owned by another store before reading any variant', async () => {
    productModel.findById.mockReturnValue(query({ _id: PRODUCT_A, storeId: STORE_B }));

    await expect(
      service.updateVariant(PRODUCT_A.toString(), STORE_A, VARIANT_A.toString(), { priceOverride: 1500 }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_NOT_IN_STORE });

    expect(variantModel.findOne).not.toHaveBeenCalled();
    expect(variantModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('ignores a store id smuggled into the body — the scope comes from the argument', async () => {
    await service.updateVariant(PRODUCT_A.toString(), STORE_A, VARIANT_A.toString(), {
      priceOverride: 1500,
      storeId: STORE_B.toString(),
    } as any);

    // The read is scoped to the session store...
    expect(variantModel.findOne).toHaveBeenCalledWith(expect.objectContaining({ storeId: STORE_A }));
    // ...and the write `$set` carries only the price — never a body-supplied storeId.
    const set = variantModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set).toEqual({ priceOverride: 1500 });
    expect(set).not.toHaveProperty('storeId');
  });
});
