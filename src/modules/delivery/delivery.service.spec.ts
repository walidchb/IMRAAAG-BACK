import { Types } from 'mongoose';
import { DeliveryService } from './delivery.service';
import { AppException } from '../../common/errors/app-exception';

/**
 * Focused cover for `saveConfig`'s default-company behaviour: making a company the default
 * applies it to every wilaya (creating the attribution document), while re-saving an
 * already-default company's credentials does not clobber per-wilaya overrides.
 */
describe('DeliveryService.saveConfig — default applies to all wilayas', () => {
  const VENDOR = 'vendor@test.com';
  const wilayas = [{ code: '16' }, { code: '31' }, { code: '09' }];

  function makeService(
    currentConfig: unknown = null,
    resolvedStoreId: Types.ObjectId | null = null,
    currentAttribution: unknown = null,
  ) {
    const currentConfigQuery = {
      exec: jest.fn().mockResolvedValue(currentConfig),
      lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(currentConfig) }),
    };
    const configModel = {
      findOne: jest.fn().mockReturnValue(currentConfigQuery),
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ vendorEmail: VENDOR, companies: {} }),
      }),
    };
    const attributionModel = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(currentAttribution) }),
      }),
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ vendorEmail: VENDOR, attributions: {} }),
      }),
    };
    const wilayaModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(wilayas) }),
      }),
    };
    const storesService = {
      resolveStoreIdByEmail: jest.fn().mockResolvedValue(resolvedStoreId),
    };
    const configService = { get: jest.fn().mockReturnValue('test-key') };

    const service = new DeliveryService(
      configModel as any,
      attributionModel as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      wilayaModel as any,
      {} as any,
      {} as any,
      {} as any,
      configService as any,
      storesService as any,
    );
    return { service, configModel, attributionModel, wilayaModel };
  }

  it('applies the newly-default company to every wilaya and creates the attribution doc', async () => {
    const { service, configModel, attributionModel, wilayaModel } = makeService({
      companies: { zimou: { isDefault: true } },
    });

    await service.saveConfig(VENDOR, { companyId: 'noest', isDefault: true });

    expect(wilayaModel.find).toHaveBeenCalled();
    expect(attributionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = attributionModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ vendorEmail: VENDOR });
    expect(update.$set.attributions).toEqual({ '16': 'noest', '31': 'noest', '09': 'noest' });

    // The config default flags are still handled exactly as before.
    expect(configModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const configSet = configModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(configSet['companies.noest.isDefault']).toBe(true);
    expect(configSet['companies.zimou.isDefault']).toBe(false);
  });

  it('dual-writes storeId onto the attribution document when the store resolves', async () => {
    const storeId = new Types.ObjectId();
    const { service, attributionModel } = makeService(null, storeId);

    await service.saveConfig(VENDOR, { companyId: 'noest', isDefault: true });

    const update = attributionModel.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.storeId).toBe(storeId);
  });

  it('does NOT re-apply when the company is already the default', async () => {
    const { service, attributionModel } = makeService({
      companies: { noest: { isDefault: true }, zimou: { isDefault: false } },
    });

    await service.saveConfig(VENDOR, { companyId: 'noest', isDefault: true });

    expect(attributionModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not touch attributions when isDefault is false', async () => {
    const { service, attributionModel } = makeService({ companies: { zimou: { isDefault: true } } });

    await service.saveConfig(VENDOR, { companyId: 'noest', isDefault: false });

    expect(attributionModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('writes validated state/signal overrides under the company (§E6)', async () => {
    const { service, configModel } = makeService();

    await service.saveConfig(VENDOR, {
      companyId: 'ecom-delivery',
      statusStateOverrides: { 'En cours de livraison': 'out_for_delivery' },
      statusSignalOverrides: { 'Retour client': 'returned' },
    });

    const set = configModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set['statusStateOverrides.ecom-delivery']).toEqual({
      'En cours de livraison': 'out_for_delivery',
    });
    expect(set['statusSignalOverrides.ecom-delivery']).toEqual({ 'Retour client': 'returned' });
  });

  it('refuses an override value outside the catalogue (§E6)', async () => {
    const { service, configModel } = makeService();

    await expect(
      service.saveConfig(VENDOR, {
        companyId: 'ecom-delivery',
        statusStateOverrides: { livre: 'not_a_status' },
      }),
    ).rejects.toBeInstanceOf(AppException);
    await expect(
      service.saveConfig(VENDOR, {
        companyId: 'ecom-delivery',
        statusSignalOverrides: { livre: 'confirmed' },
      }),
    ).rejects.toBeInstanceOf(AppException);
    expect(configModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses an override key that would inject a MongoDB path (§E6)', async () => {
    const { service, configModel } = makeService();

    await expect(
      service.saveConfig(VENDOR, {
        companyId: 'ecom-delivery',
        statusStateOverrides: { 'a.b': 'delivered' },
      }),
    ).rejects.toBeInstanceOf(AppException);
    expect(configModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('clears the default flag when a company is disabled', async () => {
    const { service, configModel } = makeService({
      companies: { noest: { isDefault: true, status: 'enabled' } },
    });

    await service.saveConfig(VENDOR, { companyId: 'noest', status: 'disabled' });

    const set = configModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set['companies.noest.status']).toBe('disabled');
    expect(set['companies.noest.isDefault']).toBe(false);
  });

  it('keeps credentials when a company is disabled (orders already assigned can finish)', async () => {
    const { service, configModel } = makeService({
      companies: { noest: { isDefault: false, status: 'enabled' } },
    });

    await service.saveConfig(VENDOR, { companyId: 'noest', status: 'disabled' });

    const set = configModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set['companies.noest.credentials']).toBeUndefined();
  });

  it('ignores a disabled attribution and falls back to the enabled default', async () => {
    const { service } = makeService(
      {
        companies: {
          noest: { isDefault: true, status: 'enabled' },
          dhd: { isDefault: false, status: 'disabled' },
        },
      },
      null,
      { attributions: { '16': 'dhd' } },
    );

    await expect(service.resolveCompanyForWilaya(VENDOR, '16')).resolves.toBe('noest');
  });

  it('returns no company when every attributed/default option is disabled', async () => {
    const { service } = makeService(
      { companies: { noest: { isDefault: true, status: 'disabled' } } },
      null,
      { attributions: { '16': 'noest' } },
    );

    await expect(service.resolveCompanyForWilaya(VENDOR, '16')).resolves.toBeNull();
  });
});

describe('DeliveryService.resolveDefaultStopDesk - first pickup point per carrier', () => {
  const WILAYA = '16';

  function makeQuery(result: unknown) {
    const q: any = {};
    q.sort = jest.fn().mockReturnValue(q);
    q.lean = jest.fn().mockReturnValue(q);
    q.exec = jest.fn().mockResolvedValue(result);
    return q;
  }

  function makeService() {
    const noestDeskModel = { findOne: jest.fn() };
    const ecomDeskModel = { findOne: jest.fn() };
    const zrHubModel = { findOne: jest.fn() };
    const dhdDeskModel = { findOne: jest.fn() };

    const service = new DeliveryService(
      {} as any,
      {} as any,
      noestDeskModel as any,
      ecomDeskModel as any,
      zrHubModel as any,
      dhdDeskModel as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
      {} as any,
    );

    return { service, noestDeskModel, ecomDeskModel, zrHubModel, dhdDeskModel };
  }

  it('returns the Noest desk code ordered like the vendor dialog', async () => {
    const { service, noestDeskModel } = makeService();
    noestDeskModel.findOne.mockReturnValue(makeQuery({ code: '16-001', wilayaCode: WILAYA }));

    await expect(service.resolveDefaultStopDesk('noest', WILAYA)).resolves.toBe('16-001');
    expect(noestDeskModel.findOne).toHaveBeenCalledWith({ wilayaCode: WILAYA });
    expect(noestDeskModel.findOne.mock.results[0].value.sort).toHaveBeenCalledWith({ code: 1 });
  });

  it('returns the Ecom stopdesk code ordered by office name', async () => {
    const { service, ecomDeskModel } = makeService();
    ecomDeskModel.findOne.mockReturnValue(makeQuery({ code_stopdesk: 'ECOM-16' }));

    await expect(service.resolveDefaultStopDesk('ecom-delivery', WILAYA)).resolves.toBe('ECOM-16');
    expect(ecomDeskModel.findOne).toHaveBeenCalledWith({ wilayaCode: WILAYA });
    expect(ecomDeskModel.findOne.mock.results[0].value.sort).toHaveBeenCalledWith({ nom_bureau: 1 });
  });

  it('returns a ZR hub id, preferring pickup points', async () => {
    const { service, zrHubModel } = makeService();
    zrHubModel.findOne.mockReturnValue(makeQuery({ hubId: 'HUB-16' }));

    await expect(service.resolveDefaultStopDesk('zr-express', WILAYA)).resolves.toBe('HUB-16');
    expect(zrHubModel.findOne).toHaveBeenCalledWith({
      wilayaCode: WILAYA,
      isPickupPoint: { $ne: false },
    });
    expect(zrHubModel.findOne.mock.results[0].value.sort).toHaveBeenCalledWith({ name: 1 });
  });

  it('falls back to a ZR hub that is not flagged as a pickup point', async () => {
    const { service, zrHubModel } = makeService();
    zrHubModel.findOne
      .mockReturnValueOnce(makeQuery(null))
      .mockReturnValueOnce(makeQuery({ hubId: 'HUB-LEGACY' }));

    await expect(service.resolveDefaultStopDesk('zr-express', WILAYA)).resolves.toBe('HUB-LEGACY');
    expect(zrHubModel.findOne).toHaveBeenNthCalledWith(2, { wilayaCode: WILAYA });
  });

  it('returns the DHD document id, which is the code the vendor dialog stores', async () => {
    const { service, dhdDeskModel } = makeService();
    const id = new Types.ObjectId();
    dhdDeskModel.findOne.mockReturnValue(makeQuery({ _id: id, nom: 'DHD Desk' }));

    await expect(service.resolveDefaultStopDesk('dhd', WILAYA)).resolves.toBe(id.toString());
    expect(dhdDeskModel.findOne).toHaveBeenCalledWith({ wilayaCode: WILAYA });
    expect(dhdDeskModel.findOne.mock.results[0].value.sort).toHaveBeenCalledWith({ nom: 1 });
  });

  it('returns null when no desk exists or the company/wilaya is unknown', async () => {
    const { service, noestDeskModel, ecomDeskModel, zrHubModel, dhdDeskModel } = makeService();
    noestDeskModel.findOne.mockReturnValue(makeQuery(null));

    await expect(service.resolveDefaultStopDesk('noest', WILAYA)).resolves.toBeNull();
    await expect(service.resolveDefaultStopDesk('unknown', WILAYA)).resolves.toBeNull();
    await expect(service.resolveDefaultStopDesk('noest', undefined)).resolves.toBeNull();
    await expect(service.resolveDefaultStopDesk(undefined, WILAYA)).resolves.toBeNull();

    expect(ecomDeskModel.findOne).not.toHaveBeenCalled();
    expect(zrHubModel.findOne).not.toHaveBeenCalled();
    expect(dhdDeskModel.findOne).not.toHaveBeenCalled();
  });
});

/**
 * `GET /delivery/noest-communes` — the service validates the wilaya, resolves the vendor's store
 * from the session and delegates the carrier read to the handler (which owns the credentials).
 */
describe('DeliveryService.getNoestCommunes', () => {
  const VENDOR = 'vendor@test.com';
  const STORE_ID = new Types.ObjectId('6ac400e26b1b2c3d4e5f6a71');

  function makeService(listCommunes: jest.Mock) {
    const registry = { getHandler: jest.fn().mockReturnValue({ listCommunes }) };
    const storesService = { resolveStoreIdByEmail: jest.fn().mockResolvedValue(STORE_ID) };
    const service = new DeliveryService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      registry as any,
      {} as any,
      { get: jest.fn() } as any,
      storesService as any,
    );
    return { service, registry, storesService };
  }

  it('delegates with the store resolved from the session and returns the three option fields', async () => {
    const listCommunes = jest.fn().mockResolvedValue([
      { name: 'Batna', wilayaId: '5', postalCode: '05001' },
    ]);
    const { service, registry } = makeService(listCommunes);

    await expect(service.getNoestCommunes(VENDOR, ' 5 ')).resolves.toEqual([
      { name: 'Batna', wilayaId: '5', postalCode: '05001' },
    ]);

    expect(registry.getHandler).toHaveBeenCalledWith('noest');
    expect(listCommunes).toHaveBeenCalledWith('5', {
      storeId: String(STORE_ID),
      vendorEmail: VENDOR,
    });
  });

  it('refuses a missing or out-of-range wilaya before any carrier call', async () => {
    const listCommunes = jest.fn();
    const { service } = makeService(listCommunes);

    await expect(service.getNoestCommunes(VENDOR, '')).rejects.toMatchObject({
      errorCode: 'VALIDATION_REQUIRED',
    });
    await expect(service.getNoestCommunes(VENDOR, '59')).rejects.toMatchObject({
      errorCode: 'VALIDATION_INVALID_VALUE',
    });
    expect(listCommunes).not.toHaveBeenCalled();
  });

  it('reports a missing handler capability instead of failing silently', async () => {
    const { service, registry } = makeService(jest.fn());
    registry.getHandler.mockReturnValue({});

    await expect(service.getNoestCommunes(VENDOR, '5')).rejects.toMatchObject({
      errorCode: 'DELIVERY_HANDLER_NOT_FOUND',
    });
  });
});
