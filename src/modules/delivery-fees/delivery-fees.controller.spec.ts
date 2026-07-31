import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryFeesController } from './delivery-fees.controller';
import { DeliveryFeesService } from './delivery-fees.service';
import { UpdateDeliveryFeeDto, BulkUpdateDeliveryFeeDto } from './dto/manage-delivery-fees.dto';

describe('DeliveryFeesController', () => {
  let controller: DeliveryFeesController;
  let service: jest.Mocked<DeliveryFeesService>;

  const mockService = {
    getFees: jest.fn(),
    getFee: jest.fn(),
    updateFee: jest.fn(),
    bulkUpdate: jest.fn(),
    seedDefaults: jest.fn(),
    fetchNoestFees: jest.fn(),
    fetchNoestFeeForWilaya: jest.fn(),
    fetchEcomFees: jest.fn(),
    fetchEcomFeeForWilaya: jest.fn(),
    fetchZrFees: jest.fn(),
    fetchZrFeeForWilaya: jest.fn(),
    fetchDhdFees: jest.fn(),
    fetchDhdFeeForWilaya: jest.fn(),
    startFetchNoest: jest.fn(),
    startFetchEcom: jest.fn(),
    startFetchZr: jest.fn(),
    startFetchDhd: jest.fn(),
    getFetchJobStatus: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeliveryFeesController],
      providers: [
        { provide: DeliveryFeesService, useValue: mockService },
      ],
    }).compile();

    controller = module.get<DeliveryFeesController>(DeliveryFeesController);
    jest.clearAllMocks();
  });

  const mockReq = (email = 'vendor@test.com') => ({ user: { email } });

  describe('GET /delivery-fees', () => {
    it('returns fees for the authenticated vendor', async () => {
      const expected = { fees: {} };
      mockService.getFees.mockResolvedValue(expected);

      const result = await controller.getFees(mockReq());
      expect(result).toBe(expected);
      expect(mockService.getFees).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('GET /delivery-fees/by-wilaya', () => {
    it('returns fee for a specific wilaya', async () => {
      const expected = { wilayaCode: '01', homeDeliveryFee: 100, stopDeskDeliveryFee: 80 };
      mockService.getFee.mockResolvedValue(expected);

      const result = await controller.getFee('vendor@test.com', '01');
      expect(result).toBe(expected);
      expect(mockService.getFee).toHaveBeenCalledWith('vendor@test.com', '01');
    });
  });

  describe('PATCH /delivery-fees/:wilayaCode', () => {
    it('updates fee for a wilaya', async () => {
      const dto: UpdateDeliveryFeeDto = { homeDeliveryFee: 150, stopDeskDeliveryFee: 120 };
      const expected = { wilayaCode: '01', homeDeliveryFee: 150, stopDeskDeliveryFee: 120 };
      mockService.updateFee.mockResolvedValue(expected);

      const result = await controller.updateFee(mockReq(), '01', dto);
      expect(result).toBe(expected);
      expect(mockService.updateFee).toHaveBeenCalledWith('vendor@test.com', '01', dto);
    });
  });

  describe('POST /delivery-fees/bulk', () => {
    it('bulk updates fees', async () => {
      const dto: BulkUpdateDeliveryFeeDto = { fees: { '01': { homeDeliveryFee: 100, stopDeskDeliveryFee: 80 } } };
      const expected = { modifiedCount: 1 };
      mockService.bulkUpdate.mockResolvedValue(expected);

      const result = await controller.bulkUpdate(mockReq(), dto);
      expect(result).toBe(expected);
      expect(mockService.bulkUpdate).toHaveBeenCalledWith('vendor@test.com', dto);
    });
  });

  describe('POST /delivery-fees/seed', () => {
    it('seeds default fees for wilayas', async () => {
      mockService.seedDefaults.mockResolvedValue({ modifiedCount: 48 });

      const result = await controller.seed(mockReq(), { wilayaCodes: ['01', '02'] });
      expect(result).toEqual({ modifiedCount: 48 });
      expect(mockService.seedDefaults).toHaveBeenCalledWith('vendor@test.com', ['01', '02']);
    });
  });

  describe('POST /delivery-fees/fetch-from-noest', () => {
    it('fetches Noest fees', async () => {
      const expected = [{ wilayaCode: '01', homeDeliveryFee: 100, stopDeskDeliveryFee: 80 }];
      mockService.fetchNoestFees.mockResolvedValue(expected);

      const result = await controller.fetchFromNoest(mockReq());
      expect(result).toBe(expected);
      expect(mockService.fetchNoestFees).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('POST /delivery-fees/fetch-from-noest/:wilayaCode', () => {
    it('fetches Noest fee for specific wilaya', async () => {
      const expected = { wilayaCode: '01', homeDeliveryFee: 100, stopDeskDeliveryFee: 80 };
      mockService.fetchNoestFeeForWilaya.mockResolvedValue(expected);

      const result = await controller.fetchFromNoestForWilaya(mockReq(), '01');
      expect(result).toBe(expected);
      expect(mockService.fetchNoestFeeForWilaya).toHaveBeenCalledWith('vendor@test.com', '01');
    });
  });

  describe('POST /delivery-fees/fetch-from-ecom', () => {
    it('fetches Ecom fees with apiKey and apiToken', async () => {
      const expected = [{ wilayaCode: '01', homeDeliveryFee: 100, stopDeskDeliveryFee: 80 }];
      mockService.fetchEcomFees.mockResolvedValue(expected);

      const result = await controller.fetchFromEcom(mockReq(), { apiKey: 'key', apiToken: 'token' });
      expect(result).toBe(expected);
      expect(mockService.fetchEcomFees).toHaveBeenCalledWith('vendor@test.com', 'key', 'token');
    });
  });

  describe('POST /delivery-fees/fetch-from-zr-express', () => {
    it('fetches ZR Express fees with apiKey and tenantId', async () => {
      const expected = [{ wilayaCode: '01', homeDeliveryFee: 100, stopDeskDeliveryFee: 80 }];
      mockService.fetchZrFees.mockResolvedValue(expected);

      const result = await controller.fetchFromZr(mockReq(), { apiKey: 'key', tenantId: 'tenant' });
      expect(result).toBe(expected);
      expect(mockService.fetchZrFees).toHaveBeenCalledWith('vendor@test.com', 'key', 'tenant');
    });
  });

  describe('POST /delivery-fees/fetch-from-dhd', () => {
    it('fetches DHD fees', async () => {
      const expected = [{ wilayaCode: '01', homeDeliveryFee: 100, stopDeskDeliveryFee: 80 }];
      mockService.fetchDhdFees.mockResolvedValue(expected);

      const result = await controller.fetchFromDhd(mockReq());
      expect(result).toBe(expected);
      expect(mockService.fetchDhdFees).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('POST /delivery-fees/fetch-from-noest/async', () => {
    it('starts async Noest fee fetch and returns jobId', async () => {
      mockService.startFetchNoest.mockResolvedValue({ jobId: 'fee-fetch-1-123' });

      const result = await controller.fetchFromNoestAsync(mockReq());
      expect(result).toEqual({ jobId: 'fee-fetch-1-123' });
      expect(mockService.startFetchNoest).toHaveBeenCalledWith('vendor@test.com');
    });
  });

  describe('GET /delivery-fees/jobs/:jobId', () => {
    it('returns job status when found', async () => {
      const job = { id: 'fee-fetch-1-123', company: 'noest', status: 'done', result: [], createdAt: new Date() };
      mockService.getFetchJobStatus.mockReturnValue(job);

      const result = await controller.getJobStatus('fee-fetch-1-123');
      expect(result).toEqual({ id: 'fee-fetch-1-123', company: 'noest', status: 'done', result: [] });
    });

    it('returns not_found when job does not exist', async () => {
      mockService.getFetchJobStatus.mockReturnValue(null);

      const result = await controller.getJobStatus('nonexistent');
      expect(result).toEqual({ status: 'not_found' });
    });
  });
});
