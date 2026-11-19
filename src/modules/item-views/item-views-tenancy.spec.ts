import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { StoresService } from '../stores/stores.service';
import { ItemViewsAnalyticsController } from './item-views.analytics.controller';
import { ItemViewsTrackController } from './item-views.track.controller';
import { ItemViewsService } from './item-views.service';

/**
 * The public beacon must resolve the store from the item, never from the caller.
 *
 * The DTO is whitelisted (`forbidNonWhitelisted`), so a `storeId` in the body is a 400 at the
 * pipe. These specs pin the handler contract: it forwards only the body + request context, and
 * the service (covered separately) derives the tenant from the looked-up item.
 */
describe('ItemViewsTrackController tenancy', () => {
  let controller: ItemViewsTrackController;
  let service: { track: jest.Mock };

  beforeEach(() => {
    service = { track: jest.fn().mockResolvedValue(undefined) };
    controller = new ItemViewsTrackController(service as unknown as ItemViewsService);
  });

  it('is marked @Public', () => {
    const isPublic = new Reflector().get<boolean>(IS_PUBLIC_KEY, controller.track);
    expect(isPublic).toBe(true);
  });

  it('forwards the body and request context without a seller identifier', async () => {
    const dto = {
      itemType: 'product' as const,
      itemId: new Types.ObjectId().toHexString(),
      visitorId: 'visitor-1',
    };
    const req = {
      ip: '10.0.0.1',
      headers: {
        'user-agent': 'Mozilla/5.0 Chrome/120',
        authorization: 'Bearer abc',
      },
    } as any;

    await controller.track(dto, req);

    expect(service.track).toHaveBeenCalledWith(dto, {
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0 Chrome/120',
      authorization: 'Bearer abc',
    });
  });
});

describe('ItemViewsAnalyticsController tenancy', () => {
  const STORE = new Types.ObjectId();
  const VENDOR_ID = new Types.ObjectId().toString();
  const req = { user: { id: VENDOR_ID } } as any;
  let controller: any;
  let service: { summary: jest.Mock; items: jest.Mock; itemDetail: jest.Mock };
  let stores: { findByMemberIdOrThrow: jest.Mock };

  beforeEach(async () => {
    service = {
      summary: jest.fn().mockResolvedValue({}),
      items: jest.fn().mockResolvedValue({}),
      itemDetail: jest.fn().mockResolvedValue({}),
    };
    stores = {
      findByMemberIdOrThrow: jest.fn().mockResolvedValue({ _id: STORE }),
    };
    const module = await Test.createTestingModule({
      controllers: [ItemViewsAnalyticsController],
      providers: [
        { provide: ItemViewsService, useValue: service },
        { provide: StoresService, useValue: stores },
      ],
    }).compile();
    controller = module.get(ItemViewsAnalyticsController);
  });

  it('resolves the store from the session and ignores a smuggled storeId', async () => {
    const query = { preset: '7d', storeId: new Types.ObjectId().toHexString() };
    await controller.summary(query, req);

    expect(stores.findByMemberIdOrThrow).toHaveBeenCalledWith(VENDOR_ID);
    expect(service.summary).toHaveBeenCalledWith(STORE, query);
  });

  it('propagates a store-resolution failure without reading', async () => {
    stores.findByMemberIdOrThrow.mockRejectedValue(
      new AppException(AppErrorCode.STORE_NOT_FOUND, { value: VENDOR_ID }),
    );

    await expect(controller.items({}, req)).rejects.toBeInstanceOf(AppException);
    expect(service.items).not.toHaveBeenCalled();
  });

  it('passes the session store, item type and id to the detail read', async () => {
    const id = new Types.ObjectId().toHexString();
    await controller.itemDetail({}, req, 'box', id);

    expect(service.itemDetail).toHaveBeenCalledWith(STORE, 'box', id, {});
  });

  it('answers 404 for an unknown item type without calling the service', async () => {
    await expect(controller.itemDetail({}, req, 'widget', 'x')).rejects.toMatchObject({
      errorCode: AppErrorCode.PRODUCT_NOT_FOUND,
    });
    expect(service.itemDetail).not.toHaveBeenCalled();
  });
});
