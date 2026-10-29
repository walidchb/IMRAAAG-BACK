import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { DeliveryFeesService } from './delivery-fees.service';
import { DeliveryFee } from './schemas/delivery-fee.schema';
import { DeliveryConfig } from '../delivery/schemas/delivery-config.schema';
import { CacheService } from '../../common/cache.service';
import { StoresService } from '../stores/stores.service';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

describe('DeliveryFeesService — fee import uses the chosen company only', () => {
  let service: DeliveryFeesService;
  let configFindOne: jest.Mock;
  const originalFetch = global.fetch;

  /**
   * The stored delivery config. `companies` is a plain object, so a test can freely name the
   * companies that ARE configured — including only ones that must never be used as a stand-in.
   */
  const stubConfig = (companies: Record<string, { credentials: Record<string, string> }>) => {
    configFindOne.mockReturnValue({
      lean: () => ({
        exec: async () => (companies === undefined ? null : { companies }),
      }),
    });
  };

  const okResponse = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as unknown as Response;

  beforeEach(async () => {
    configFindOne = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryFeesService,
        { provide: getModelToken(DeliveryFee.name), useValue: {} },
        { provide: getModelToken(DeliveryConfig.name), useValue: { findOne: configFindOne } },
        { provide: CacheService, useValue: { get: jest.fn(), set: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: StoresService, useValue: { resolveStoreIdByEmail: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();

    service = module.get<DeliveryFeesService>(DeliveryFeesService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('fetchNoestFees', () => {
    it('authorises the Noest API with the token stored under noest', async () => {
      stubConfig({
        noest: { credentials: { apiToken: 'noest-token' } },
        dhd: { credentials: { apiToken: 'dhd-token' } },
      });
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.Authorization });
        return okResponse({ tarifs: { delivery: { '16': { tarif: '400', tarif_stopdesk: '300' } } } });
      });

      const fees = await service.fetchNoestFees('vendor@test.com');

      expect(seen).toHaveLength(1);
      expect(seen[0].url).toContain('noest-dz.com');
      expect(seen[0].auth).toBe('Bearer noest-token');
      expect(fees).toEqual([{ wilayaCode: '16', homeDeliveryFee: 400, stopDeskDeliveryFee: 300 }]);
    });

    it('refuses when noest is unconfigured even though another company has credentials', async () => {
      stubConfig({
        dhd: { credentials: { apiToken: 'dhd-token' } },
        'zr-express': { credentials: { apiKey: 'ak', tenantId: 'tk' } },
      });
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy;

      await expect(service.fetchNoestFees('vendor@test.com')).rejects.toMatchObject({
        errorCode: AppErrorCode.FEE_API_CREDENTIALS_MISSING,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses when the vendor has no delivery config at all', async () => {
      configFindOne.mockReturnValue({ lean: () => ({ exec: async () => null }) });
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy;

      await expect(service.fetchNoestFees('vendor@test.com')).rejects.toMatchObject({
        errorCode: AppErrorCode.FEE_API_CREDENTIALS_MISSING,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('preserves the credentials code for the single-wilaya path too', async () => {
      stubConfig({ dhd: { credentials: { apiToken: 'dhd-token' } } });
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy;

      await expect(service.fetchNoestFeeForWilaya('vendor@test.com', '16')).rejects.toMatchObject({
        errorCode: AppErrorCode.FEE_API_CREDENTIALS_MISSING,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('fetchDhdFees', () => {
    it('authorises the DHD API with the token stored under dhd', async () => {
      stubConfig({
        dhd: { credentials: { apiToken: 'dhd-token' } },
        noest: { credentials: { apiToken: 'noest-token' } },
      });
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.Authorization });
        return okResponse({ livraison: [{ wilaya_id: 16, tarif: '500', tarif_stopdesk: '350' }] });
      });

      const fees = await service.fetchDhdFees('vendor@test.com');

      expect(seen[0].url).toContain('dhd-dz.com');
      expect(seen[0].auth).toBe('Bearer dhd-token');
      expect(fees).toEqual([{ wilayaCode: '16', homeDeliveryFee: 500, stopDeskDeliveryFee: 350 }]);
    });

    it('refuses when dhd is unconfigured even though noest has credentials', async () => {
      stubConfig({ noest: { credentials: { apiToken: 'noest-token' } } });
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy;

      await expect(service.fetchDhdFees('vendor@test.com')).rejects.toMatchObject({
        errorCode: AppErrorCode.FEE_API_CREDENTIALS_MISSING,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('error codes survive the fetch wrapper', () => {
    it('reports an upstream Noest failure as FEE_API_ERROR, not a generic failure', async () => {
      stubConfig({ noest: { credentials: { apiToken: 'noest-token' } } });
      global.fetch = jest.fn(async () =>
        ({ ok: false, status: 502, text: async () => 'bad gateway', json: async () => ({}) }) as unknown as Response,
      );

      // A single call: fetchWithRetry retries a 502 with exponential backoff.
      const err = await service.fetchNoestFees('vendor@test.com').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppException);
      expect(err).toMatchObject({ errorCode: AppErrorCode.FEE_API_ERROR });
    }, 20_000);
  });
});
