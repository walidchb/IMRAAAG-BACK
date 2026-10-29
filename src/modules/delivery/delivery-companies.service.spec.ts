import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { DeliveryCompaniesService } from './delivery-companies.service';
import { DeliveryCompany } from './schemas/delivery-company.schema';

describe('DeliveryCompaniesService', () => {
  let service: DeliveryCompaniesService;
  let model: {
    find: jest.Mock;
    findOne: jest.Mock;
  };

  const makeQuery = (result: unknown[]) => {
    const query = { sort: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(result) };
    return query;
  };

  beforeEach(async () => {
    model = {
      find: jest.fn(),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryCompaniesService,
        { provide: getModelToken(DeliveryCompany.name), useValue: model },
      ],
    }).compile();

    service = module.get<DeliveryCompaniesService>(DeliveryCompaniesService);
    jest.clearAllMocks();
  });

  describe('getAll', () => {
    it('returns only active companies, sorted by slug', async () => {
      const expected = [{ slug: 'noest' }, { slug: 'zr-express' }];
      model.find.mockReturnValue(makeQuery(expected));

      const result = await service.getAll();

      expect(model.find).toHaveBeenCalledWith({ isActive: true });
      expect(result).toBe(expected);
    });

    it('applies the active filter even when no companies match', async () => {
      model.find.mockReturnValue(makeQuery([]));

      const result = await service.getAll();

      expect(model.find).toHaveBeenCalledWith({ isActive: true });
      expect(result).toEqual([]);
    });
  });

  describe('getBySlug', () => {
    it('looks up a company by slug', async () => {
      const expected = { slug: 'noest' };
      model.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(expected) });

      const result = await service.getBySlug('noest');

      expect(model.findOne).toHaveBeenCalledWith({ slug: 'noest' });
      expect(result).toBe(expected);
    });
  });
});
