import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { NoestHandler } from './noest.handler';
import { DeliveryConfig } from '../../schemas/delivery-config.schema';
import { Commune } from '../../../territories/schemas/commune.schema';
import { AppException } from '../../../../common/errors/app-exception';
import { AppErrorCode } from '../../../../common/errors/error-codes.enum';

// Mock fetchWithRetry
jest.mock('../../../../common/fetch-with-retry', () => ({
  fetchWithRetry: jest.fn(),
}));

const { fetchWithRetry } = require('../../../../common/fetch-with-retry');

describe('NoestHandler — status capability', () => {
  let handler: NoestHandler;
  let configModel: any;
  let communeModel: any;
  let configService: ConfigService;

  const mockContext = {
    storeId: '507f1f77bcf86cd799439011',
    parcelIds: ['NOE111', 'NOE222'],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NoestHandler,
        {
          provide: getModelToken(DeliveryConfig.name),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getModelToken(Commune.name),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'deliveryEncryptionKey') return 'test-key-32-bytes-long-string!!';
              return null;
            }),
          },
        },
      ],
    }).compile();

    handler = module.get<NoestHandler>(NoestHandler);
    configModel = module.get(getModelToken(DeliveryConfig.name));
    communeModel = module.get(getModelToken(Commune.name));
    configService = module.get<ConfigService>(ConfigService);

    jest.clearAllMocks();

    // Default mock config with Noest credentials
    configModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        storeId: '507f1f77bcf86cd799439011',
        companies: {
          noest: {
            credentials: {
              apiToken: 'encrypted-token',
              guid: 'encrypted-guid',
            },
          },
        },
      }),
    });
  });

  describe('searchStatusParcels', () => {
    it('returns parcels + missing correctly', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({
          NOE111: {
            OrderInfo: {
              id: '1',
              reference: 'NOE111',
              tracking: 'NOE111',
              status: 'Delivered',
            },
            status: 'delivered',
            activity: [
              {
                event: 'Uploaded to system',
                event_key: 'upload',
                date: '2026-10-15 10:00:00',
                by: 'Partner Store',
              },
              {
                event: 'Delivered',
                event_key: 'livre',
                date: '2026-10-18 16:00:00',
                by: 'Driver 001',
              },
            ],
          },
          // NOE222 is absent (not found)
        }),
      };

      fetchWithRetry.mockResolvedValue(mockResponse);

      const result = await handler.searchStatusParcels(mockContext);

      expect(result.parcels).toHaveLength(1);
      expect(result.parcels[0].parcelId).toBe('NOE111');
      expect(result.parcels[0].deliveryStatus).toBe('delivered');
      expect(result.missingParcelIds).toEqual(['NOE222']);
    });

    it('handles empty activity array', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({
          NOE333: {
            OrderInfo: {
              id: '3',
              tracking: 'NOE333',
              status: 'Processing',
            },
            status: 'processing',
            activity: [],
          },
        }),
      };

      fetchWithRetry.mockResolvedValue(mockResponse);

      const result = await handler.searchStatusParcels({
        storeId: '507f1f77bcf86cd799439011',
        parcelIds: ['NOE333'],
      });

      expect(result.parcels).toHaveLength(1);
      expect(result.parcels[0].deliveryStatus).toBe('processing');
    });

    it('throws on 429 rate limit with retry-after', async () => {
      const mockResponse = {
        status: 429,
        headers: new Map([['retry-after', '60']]),
        json: jest.fn(),
      };

      fetchWithRetry.mockResolvedValue(mockResponse);

      await expect(
        handler.searchStatusParcels({
          storeId: '507f1f77bcf86cd799439011',
          parcelIds: ['NOE444'],
        }),
      ).rejects.toThrow(AppException);

      try {
        await handler.searchStatusParcels({
          storeId: '507f1f77bcf86cd799439011',
          parcelIds: ['NOE444'],
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(AppErrorCode.RATE_LIMIT_EXCEEDED);
      }
    });

    it('throws on 401 unauthorized', async () => {
      const mockResponse = {
        status: 401,
        headers: new Map(),
        json: jest.fn(),
      };

      fetchWithRetry.mockResolvedValue(mockResponse);

      await expect(
        handler.searchStatusParcels({
          storeId: '507f1f77bcf86cd799439011',
          parcelIds: ['NOE555'],
        }),
      ).rejects.toThrow(AppException);

      try {
        await handler.searchStatusParcels({
          storeId: '507f1f77bcf86cd799439011',
          parcelIds: ['NOE555'],
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(
          AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED,
        );
      }
    });

    it('calls API with correct payload and headers', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({}),
      };

      fetchWithRetry.mockResolvedValue(mockResponse);

      await handler.searchStatusParcels({
        storeId: '507f1f77bcf86cd799439011',
        parcelIds: ['NOE666', 'NOE777'],
      });

      expect(fetchWithRetry).toHaveBeenCalledWith(
        'https://app.noest-dz.com/api/public/get/trackings/info',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: expect.stringContaining('Bearer'),
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ trackings: ['NOE666', 'NOE777'] }),
        }),
        expect.any(Object),
      );
    });
  });

  describe('fetchStatusHistory', () => {
    const discoveryEntry = {
      OrderInfo: {
        id: '1',
        reference: 'NOE888',
        tracking: 'NOE888',
        status: 'Out for delivery',
      },
      status: 'out_for_delivery',
      activity: [
        {
          event: 'Uploaded to system',
          event_key: 'upload',
          date: '2026-10-15 10:00:00',
        },
        {
          event: 'Out for delivery',
          event_key: 'fdr_activated',
          date: '2026-10-17 11:00:00',
        },
      ],
    };

    it('derives entries from the discovery endpoint for a found parcel', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({ NOE888: discoveryEntry }),
      };

      fetchWithRetry.mockResolvedValue(mockResponse);

      const result = await handler.fetchStatusHistory(mockContext, 'NOE888');

      expect(result).toHaveLength(2);
      expect(result[0].toState).toBe('upload');
      expect(result[1].toState).toBe('fdr_activated');
      expect(result[1].toStatus).toBe('out_for_delivery');
    });

    it('returns an empty array when discovery does not know the parcel', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({}),
      };

      fetchWithRetry.mockResolvedValue(mockResponse);

      const result = await handler.fetchStatusHistory(mockContext, 'NOE999');

      expect(result).toEqual([]);
    });

    it('handles empty activity array', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({
          NOE000: {
            OrderInfo: { id: '2', tracking: 'NOE000', status: 'Processing' },
            status: 'processing',
            activity: [],
          },
        }),
      };

      fetchWithRetry.mockResolvedValue(mockResponse);

      const result = await handler.fetchStatusHistory(mockContext, 'NOE000');

      expect(result).toEqual([]);
    });

    it('throws on 429 rate limit', async () => {
      const mockResponse = {
        status: 429,
        headers: new Map([['retry-after', '30']]),
        json: jest.fn(),
      };

      fetchWithRetry.mockResolvedValue(mockResponse);

      await expect(handler.fetchStatusHistory(mockContext, 'NOE111')).rejects.toThrow(
        AppException,
      );
    });

    it('calls the discovery endpoint with a one-item batch', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({}),
      };

      fetchWithRetry.mockResolvedValue(mockResponse);

      await handler.fetchStatusHistory(mockContext, 'NOE123');

      expect(fetchWithRetry).toHaveBeenCalledWith(
        'https://app.noest-dz.com/api/public/get/trackings/info',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: expect.stringContaining('Bearer'),
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ trackings: ['NOE123'] }),
        }),
        expect.any(Object),
      );
    });
  });


  describe('resolveStatusTenant', () => {
    it('returns tenantId when credentials present (storeId lookup)', async () => {
      const result = await handler.resolveStatusTenant({
        storeId: '507f1f77bcf86cd799439011',
      });

      expect(result).toBeTruthy();
      expect(result).toMatch(/^[a-f0-9]{16}$/);
    });

    it('falls back to vendorEmail when storeId lookup fails', async () => {
      configModel.findOne
        .mockReturnValueOnce({
          lean: jest.fn().mockResolvedValue(null),
        })
        .mockReturnValueOnce({
          lean: jest.fn().mockResolvedValue({
            vendorEmail: 'vendor@example.com',
            companies: {
              noest: {
                credentials: {
                  apiToken: 'encrypted-token',
                  guid: 'encrypted-guid',
                },
              },
            },
          }),
        });

      const result = await handler.resolveStatusTenant({
        storeId: '507f1f77bcf86cd799439011',
        vendorEmail: 'vendor@example.com',
      });

      expect(result).toBeTruthy();
      expect(configModel.findOne).toHaveBeenCalledTimes(2);
    });

    it('throws when config not found', async () => {
      configModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });

      await expect(
        handler.resolveStatusTenant({ storeId: '507f1f77bcf86cd799439011' }),
      ).rejects.toThrow(AppException);
    });

    it('throws when Noest company not configured', async () => {
      configModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          storeId: '507f1f77bcf86cd799439011',
          companies: {
            // No 'noest' entry
          },
        }),
      });

      await expect(
        handler.resolveStatusTenant({ storeId: '507f1f77bcf86cd799439011' }),
      ).rejects.toThrow(AppException);
    });

    it('throws when credentials are incomplete', async () => {
      configModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          storeId: '507f1f77bcf86cd799439011',
          companies: {
            noest: {
              credentials: {
                // Only apiToken, no guid
                apiToken: 'encrypted-token',
              },
            },
          },
        }),
      });

      await expect(
        handler.resolveStatusTenant({ storeId: '507f1f77bcf86cd799439011' }),
      ).rejects.toThrow(AppException);
    });

    it('generates deterministic tenant ID', async () => {
      const result1 = await handler.resolveStatusTenant({
        storeId: '507f1f77bcf86cd799439011',
      });
      const result2 = await handler.resolveStatusTenant({
        storeId: '507f1f77bcf86cd799439011',
      });

      expect(result1).toBe(result2);
      expect(result1).toHaveLength(16);
    });
  });
});
