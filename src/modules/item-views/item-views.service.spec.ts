import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { Role } from '../../common/constants/roles.enum';
import { Product } from '../products/schemas/product.schema';
import { Box } from '../boxes/schemas/box.schema';
import { StoresService } from '../stores/stores.service';
import { startOfDayInTz } from '../analytics/lib/date-range';
import { ItemViewsService } from './item-views.service';
import { ItemViewDaily } from './schemas/item-view-daily.schema';

const STORE_A = new Types.ObjectId();
const STORE_B = new Types.ObjectId();
const ITEM_ID = new Types.ObjectId();
const USER_ID = new Types.ObjectId().toHexString();

const leanChain = (result: unknown) => {
  const query: any = {};
  for (const method of ['select', 'lean', 'exec']) {
    query[method] = jest.fn().mockReturnValue(query);
  }
  query.exec = jest.fn().mockResolvedValue(result);
  return query;
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36';

describe('ItemViewsService.track', () => {
  let service: ItemViewsService;
  let viewModel: { updateOne: jest.Mock };
  let productModel: { findOne: jest.Mock };
  let boxModel: { findOne: jest.Mock };
  let stores: { findByMemberId: jest.Mock };
  let jwt: { verifyAsync: jest.Mock };
  let config: { get: jest.Mock };

  const cfg = {
    enabled: true,
    hashSalt: 'test-salt',
    retentionDays: 0,
  };

  beforeEach(async () => {
    viewModel = {
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    productModel = { findOne: jest.fn().mockReturnValue(leanChain({ storeId: STORE_A })) };
    boxModel = { findOne: jest.fn().mockReturnValue(leanChain({ storeId: STORE_B })) };
    stores = { findByMemberId: jest.fn().mockResolvedValue(null) };
    jwt = { verifyAsync: jest.fn().mockRejectedValue(new Error('invalid')) };
    config = {
      get: jest.fn((key: string) => {
        if (key === 'itemViews') return cfg;
        if (key === 'jwt.secret') return 'jwt-secret';
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ItemViewsService,
        { provide: getModelToken(ItemViewDaily.name), useValue: viewModel },
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(Box.name), useValue: boxModel },
        { provide: StoresService, useValue: stores },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(ItemViewsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const track = (overrides: Record<string, any> = {}, ctx: Record<string, any> = {}) =>
    service.track(
      { itemType: 'product', itemId: ITEM_ID.toHexString(), ...overrides } as any,
      { ip: '10.0.0.1', userAgent: UA, ...ctx },
    );

  it('counts a first public view with ObjectId tenant keys and a 32-char hash', async () => {
    await track({ visitorId: 'visitor-123' });

    expect(productModel.findOne).toHaveBeenCalledWith({
      _id: ITEM_ID,
      published: true,
      isArchived: { $ne: true },
    });
    expect(viewModel.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = viewModel.updateOne.mock.calls[0];
    expect(filter.storeId).toBeInstanceOf(Types.ObjectId);
    expect(String(filter.storeId)).toBe(String(STORE_A));
    expect(filter.itemId).toBeInstanceOf(Types.ObjectId);
    expect(filter.itemType).toBe('product');
    expect(filter.dayStart).toBeInstanceOf(Date);
    expect(filter.visitorHash).toHaveLength(32);
    expect(filter.visitorHash).not.toContain('visitor-123');
    expect(update.$inc.views).toBe(1);
    expect(update.$set.lastViewedAt).toBeInstanceOf(Date);
    expect(update.$setOnInsert.firstViewedAt).toBeInstanceOf(Date);
    expect(options).toEqual({ upsert: true });
  });

  it('increments total views on every visit for the same visitor/day', async () => {
    await track({ visitorId: 'visitor-123' });
    await track({ visitorId: 'visitor-123' });

    expect(viewModel.updateOne).toHaveBeenCalledTimes(2);
    const calls = viewModel.updateOne.mock.calls;
    expect(calls[0][0].visitorHash).toBe(calls[1][0].visitorHash);
    for (const [, update] of calls) {
      expect(update.$inc.views).toBe(1);
    }
  });

  it('keeps different visitors on separate rows', async () => {
    await track({ visitorId: 'visitor-a' });
    await track({ visitorId: 'visitor-b' });

    const [first, second] = viewModel.updateOne.mock.calls;
    expect(first[0].visitorHash).not.toBe(second[0].visitorHash);
  });

  it('retries as a plain increment when a concurrent insert loses the unique-key race', async () => {
    viewModel.updateOne
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: 11000 }))
      .mockResolvedValueOnce({ acknowledged: true });

    await track({ visitorId: 'visitor-123' });

    expect(viewModel.updateOne).toHaveBeenCalledTimes(2);
    const [filter, update, options] = viewModel.updateOne.mock.calls[1];
    expect(filter.visitorHash).toBe(viewModel.updateOne.mock.calls[0][0].visitorHash);
    expect(update.$inc.views).toBe(1);
    expect(options).toBeUndefined();
  });

  it('buckets the view into the Algiers calendar day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T23:30:00.000Z'));

    await track();

    const [filter] = viewModel.updateOne.mock.calls[0];
    expect(filter.dayStart).toEqual(startOfDayInTz(new Date('2026-11-19T23:30:00.000Z')));
  });

  it('ignores a missing or bot User-Agent', async () => {
    await track({}, { userAgent: undefined });
    await track({}, { userAgent: 'Googlebot/2.1' });

    expect(productModel.findOne).not.toHaveBeenCalled();
    expect(viewModel.updateOne).not.toHaveBeenCalled();
  });

  it('ignores private, archived and unknown items without revealing existence', async () => {
    productModel.findOne.mockReturnValue(leanChain(null));

    await track();

    expect(viewModel.updateOne).not.toHaveBeenCalled();
  });

  it('does nothing when the feature is disabled', async () => {
    const disabled = { ...cfg, enabled: false };
    config.get.mockImplementation((key: string) =>
      key === 'itemViews' ? disabled : key === 'jwt.secret' ? 'jwt-secret' : undefined,
    );

    await track();

    expect(productModel.findOne).not.toHaveBeenCalled();
    expect(viewModel.updateOne).not.toHaveBeenCalled();
  });

  it('uses the box model and the box store for a box view', async () => {
    await track({ itemType: 'box' });

    expect(boxModel.findOne).toHaveBeenCalled();
    const [filter] = viewModel.updateOne.mock.calls[0];
    expect(String(filter.storeId)).toBe(String(STORE_B));
  });

  it('never lets a smuggled storeId override the item store', async () => {
    await track({ storeId: STORE_B.toHexString() });

    const [filter] = viewModel.updateOne.mock.calls[0];
    expect(String(filter.storeId)).toBe(String(STORE_A));
  });

  it('suppresses a vendor viewing their own store', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, role: Role.VENDOR });
    stores.findByMemberId.mockResolvedValue({ _id: STORE_A });

    await track({}, { authorization: 'Bearer vendor-token' });

    expect(stores.findByMemberId).toHaveBeenCalledWith(USER_ID);
    expect(viewModel.updateOne).not.toHaveBeenCalled();
  });

  it('suppresses an admin view', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, role: Role.ADMIN });

    await track({}, { authorization: 'Bearer admin-token' });

    expect(viewModel.updateOne).not.toHaveBeenCalled();
  });

  it('treats an invalid token as anonymous and still counts', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('expired'));

    await track({}, { authorization: 'Bearer stale' });

    expect(viewModel.updateOne).toHaveBeenCalledTimes(1);
  });

  it('never throws when the write fails', async () => {
    viewModel.updateOne.mockRejectedValue(new Error('db down'));

    await expect(track()).resolves.toBeUndefined();
  });
});
