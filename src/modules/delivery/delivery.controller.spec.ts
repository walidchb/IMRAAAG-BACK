import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DeliveryCompaniesService } from './delivery-companies.service';
import { SaveDeliveryConfigDto, SaveAttributionsDto } from './dto/save-delivery-config.dto';

describe('DeliveryController', () => {
  let controller: DeliveryController;
  let deliveryService: jest.Mocked<DeliveryService>;

  const mockDeliveryService = {
    getConfigs: jest.fn(),
    saveConfig: jest.fn(),
    getAttributions: jest.fn(),
    saveAttributions: jest.fn(),
    getNoestDesks: jest.fn(),
    syncNoestDesks: jest.fn(),
    getEcomDesks: jest.fn(),
    syncEcomDesks: jest.fn(),
    getDhdDesks: jest.fn(),
    getZRHubs: jest.fn(),
    syncZRHubs: jest.fn(),
    syncZRTerritories: jest.fn(),
    getTerritories: jest.fn(),
  };

  const mockCompaniesService = {
    getAll: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeliveryController],
      providers: [
        { provide: DeliveryService, useValue: mockDeliveryService },
        { provide: DeliveryCompaniesService, useValue: mockCompaniesService },
      ],
    }).compile();

    controller = module.get<DeliveryController>(DeliveryController);
    jest.clearAllMocks();
  });

  const mockReq = (email = 'vendor@test.com') => ({ user: { email } });

  describe('GET /delivery/companies', () => {
    it('returns all delivery companies', async () => {
      const expected = [{ slug: 'noest', name: 'Noest Express' }];
      mockCompaniesService.getAll.mockResolvedValue(expected);

      const result = await controller.getCompanies();
      expect(result).toBe(expected);
    });
  });

  describe('GET /delivery/configs', () => {
    it('returns configs for authenticated vendor', async () => {
      const expected = { vendorEmail: 'vendor@test.com', companies: {} };
      mockDeliveryService.getConfigs.mockResolvedValue(expected);

      const result = await controller.getConfigs(mockReq());
      expect(result).toBe(expected);
      expect(mockDeliveryService.getConfigs).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('PATCH /delivery/configs', () => {
    it('saves config for authenticated vendor', async () => {
      const dto: SaveDeliveryConfigDto = { companyId: 'noest', status: 'enabled', credentials: {} };
      const expected = { vendorEmail: 'vendor@test.com', companies: {} };
      mockDeliveryService.saveConfig.mockResolvedValue(expected);

      const result = await controller.saveConfig(mockReq(), dto);
      expect(result).toBe(expected);
      expect(mockDeliveryService.saveConfig).toHaveBeenCalledWith('vendor@test.com', dto);
    });
  });

  describe('GET /delivery/attributions', () => {
    it('returns attributions for authenticated vendor', async () => {
      const expected = { vendorEmail: 'vendor@test.com', attributions: { '01': 'noest' } };
      mockDeliveryService.getAttributions.mockResolvedValue(expected);

      const result = await controller.getAttributions(mockReq());
      expect(result).toBe(expected);
      expect(mockDeliveryService.getAttributions).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('PATCH /delivery/attributions', () => {
    it('saves attributions for authenticated vendor', async () => {
      const dto: SaveAttributionsDto = { attributions: { '01': 'noest' } };
      mockDeliveryService.saveAttributions.mockResolvedValue({ vendorEmail: 'vendor@test.com', attributions: dto.attributions });

      const result = await controller.saveAttributions(mockReq(), dto);
      expect(result).toBeDefined();
      expect(mockDeliveryService.saveAttributions).toHaveBeenCalledWith('vendor@test.com', dto);
    });
  });

  describe('GET /delivery/noest-desks', () => {
    it('returns Noest desks without filter', async () => {
      const expected = [{ code: '001', name: 'Desk 1' }];
      mockDeliveryService.getNoestDesks.mockResolvedValue(expected);

      const result = await controller.getNoestDesks();
      expect(result).toBe(expected);
      expect(mockDeliveryService.getNoestDesks).toHaveBeenCalledWith(undefined);
    });

    it('returns Noest desks filtered by wilaya', async () => {
      const expected = [{ code: '001', name: 'Desk 1' }];
      mockDeliveryService.getNoestDesks.mockResolvedValue(expected);

      const result = await controller.getNoestDesks('16');
      expect(result).toBe(expected);
      expect(mockDeliveryService.getNoestDesks).toHaveBeenCalledWith('16');
    });
  });

  describe('POST /delivery/noest-desks/sync', () => {
    it('syncs Noest desks', async () => {
      mockDeliveryService.syncNoestDesks.mockResolvedValue({ synced: 10 });

      const result = await controller.syncNoestDesks(mockReq());
      expect(result).toEqual({ synced: 10 });
      expect(mockDeliveryService.syncNoestDesks).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('GET /delivery/ecom-desks', () => {
    it('returns Ecom desks', async () => {
      const expected = [{ code_stopdesk: 'B001', nom_bureau: 'Bureau 1' }];
      mockDeliveryService.getEcomDesks.mockResolvedValue(expected);

      const result = await controller.getEcomDesks();
      expect(result).toBe(expected);
    });
  });

  describe('GET /delivery/dhd-desks', () => {
    it('returns DHD desks', async () => {
      const expected = [{ _id: 'dhd1', nom: 'DHD Desk 1' }];
      mockDeliveryService.getDhdDesks.mockResolvedValue(expected);

      const result = await controller.getDhdDesks();
      expect(result).toBe(expected);
    });
  });

  describe('GET /delivery/zr-hubs', () => {
    it('returns ZR hubs', async () => {
      const expected = [{ hubId: 'hub1', name: 'Hub 1' }];
      mockDeliveryService.getZRHubs.mockResolvedValue(expected);

      const result = await controller.getZRHubs();
      expect(result).toBe(expected);
    });
  });

  describe('POST /delivery/zr-hubs/sync', () => {
    it('syncs ZR hubs', async () => {
      mockDeliveryService.syncZRHubs.mockResolvedValue({ synced: 5 });

      const result = await controller.syncZRHubs(mockReq());
      expect(result).toEqual({ synced: 5 });
      expect(mockDeliveryService.syncZRHubs).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('POST /delivery/zr-territories/sync', () => {
    it('syncs ZR territories', async () => {
      mockDeliveryService.syncZRTerritories.mockResolvedValue({ synced: 48 });

      const result = await controller.syncZRTerritories(mockReq());
      expect(result).toEqual({ synced: 48 });
      expect(mockDeliveryService.syncZRTerritories).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('GET /delivery/zr-territories', () => {
    it('returns ZR territories', async () => {
      const expected = [{ id: 'terr1', name: 'Territory 1' }];
      mockDeliveryService.getTerritories.mockResolvedValue(expected);

      const result = await controller.getZRTerritories(mockReq());
      expect(result).toBe(expected);
      expect(mockDeliveryService.getTerritories).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('GET /delivery/public/attributions/:vendorEmail', () => {
    it('returns public attributions for vendor', async () => {
      const expected = { vendorEmail: 'vendor@test.com', attributions: { '01': 'noest' } };
      mockDeliveryService.getAttributions.mockResolvedValue(expected);

      const result = await controller.getPublicAttributions('vendor@test.com');
      expect(result).toBe(expected);
      expect(mockDeliveryService.getAttributions).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('GET /delivery/public/configs/:vendorEmail', () => {
    it('returns public configs for vendor', async () => {
      const expected = { vendorEmail: 'vendor@test.com', companies: {} };
      mockDeliveryService.getConfigs.mockResolvedValue(expected);

      const result = await controller.getPublicConfigs('vendor@test.com');
      expect(result).toBe(expected);
      expect(mockDeliveryService.getConfigs).toHaveBeenCalledWith('vendor@test.com');
    });
  });
});
