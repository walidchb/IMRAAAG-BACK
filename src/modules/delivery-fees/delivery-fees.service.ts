import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DeliveryFee, DeliveryFeeDocument } from './schemas/delivery-fee.schema';
import { UpdateDeliveryFeeDto, BulkUpdateDeliveryFeeDto } from './dto/manage-delivery-fees.dto';
import { DeliveryConfig, DeliveryConfigDocument } from '../delivery/schemas/delivery-config.schema';
import { CacheService } from '../../common/cache.service';

const CACHE_TTL = 3600000; // 1 hour

interface NoestFeeEntry {
  tarif?: string;
  tarif_stopdesk?: string;
}

interface EcomWilayaFee {
  wilaya: number;
  domicile: number;
  stopdesk: number;
  annuler: number;
}

interface ZrRateEntry {
  toTerritoryId: string;
  toTerritoryCode: number;
  toTerritoryName: string;
  toTerritoryLevel: string;
  deliveryPrices: Array<{ deliveryType: string; price: number }>;
}

interface DhdWilayaFee {
  wilaya_id: number;
  tarif: string;
  tarif_stopdesk: string;
}

@Injectable()
export class DeliveryFeesService {
  private readonly logger = new Logger(DeliveryFeesService.name);
  private readonly noestApiBase = 'https://app.noest-dz.com';

  constructor(
    @InjectModel(DeliveryFee.name)
    private feeModel: Model<DeliveryFeeDocument>,
    @InjectModel(DeliveryConfig.name)
    private configModel: Model<DeliveryConfigDocument>,
    private readonly cacheService: CacheService,
  ) {}

  async getFees(vendorEmail: string): Promise<DeliveryFee | null> {
    const cacheKey = `delivery-fees:${vendorEmail}:all`;
    const cached = this.cacheService.get<DeliveryFee | null>(cacheKey);
    if (cached !== undefined) return cached;
    const result = await this.feeModel.findOne({ vendorEmail }).exec();
    this.cacheService.set(cacheKey, result, CACHE_TTL);
    return result;
  }

  async getFee(vendorEmail: string, wilayaCode: string): Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }> {
    const cacheKey = `delivery-fees:${vendorEmail}:single:${wilayaCode}`;
    const cached = this.cacheService.get<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }>(cacheKey);
    if (cached) return cached;
    const doc = await this.feeModel.findOne({ vendorEmail }).exec();
    if (!doc || !doc.fees || !doc.fees[wilayaCode]) {
      throw new NotFoundException(`Delivery fee not found for wilaya ${wilayaCode}`);
    }
    const result = {
      wilayaCode,
      homeDeliveryFee: doc.fees[wilayaCode].homeDeliveryFee ?? 0,
      stopDeskDeliveryFee: doc.fees[wilayaCode].stopDeskDeliveryFee ?? 0,
    };
    this.cacheService.set(cacheKey, result, CACHE_TTL);
    return result;
  }

  async updateFee(vendorEmail: string, wilayaCode: string, dto: UpdateDeliveryFeeDto): Promise<DeliveryFee> {
    this.cacheService.clear(`delivery-fees:${vendorEmail}`);
    const doc = await this.feeModel.findOne({ vendorEmail }).exec();
    const current = doc?.fees?.[wilayaCode] || { homeDeliveryFee: 0, stopDeskDeliveryFee: 0 };
    return this.feeModel.findOneAndUpdate(
      { vendorEmail },
      {
        $set: {
          [`fees.${wilayaCode}`]: {
            homeDeliveryFee: dto.homeDeliveryFee ?? current.homeDeliveryFee,
            stopDeskDeliveryFee: dto.stopDeskDeliveryFee ?? current.stopDeskDeliveryFee,
          },
        },
      },
      { upsert: true, new: true },
    ).exec();
  }

  async bulkUpdate(vendorEmail: string, dto: BulkUpdateDeliveryFeeDto): Promise<{ success: boolean; count: number }> {
    this.cacheService.clear(`delivery-fees:${vendorEmail}`);
    if (!dto.fees) return { success: false, count: 0 };
    const setFields: Record<string, any> = {};
    for (const [wilayaCode, values] of Object.entries(dto.fees)) {
      setFields[`fees.${wilayaCode}`] = {
        homeDeliveryFee: values.homeDeliveryFee ?? 0,
        stopDeskDeliveryFee: values.stopDeskDeliveryFee ?? 0,
      };
    }
    if (Object.keys(setFields).length > 0) {
      await this.feeModel.updateOne(
        { vendorEmail },
        { $set: setFields },
        { upsert: true },
      ).exec();
    }
    return { success: true, count: Object.keys(dto.fees).length };
  }

  async seedDefaults(vendorEmail: string, wilayaCodes: string[]): Promise<void> {
    this.cacheService.clear(`delivery-fees:${vendorEmail}`);
    const doc = await this.feeModel.findOne({ vendorEmail }).exec();
    const existingCodes = new Set(Object.keys(doc?.fees || {}));
    const missing = wilayaCodes.filter(c => !existingCodes.has(c));
    if (missing.length === 0) return;
    const setFields: Record<string, any> = {};
    for (const code of missing) {
      setFields[`fees.${code}`] = { homeDeliveryFee: 0, stopDeskDeliveryFee: 0 };
    }
    await this.feeModel.updateOne(
      { vendorEmail },
      { $set: setFields },
      { upsert: true },
    ).exec();
  }

  private async getNoestApiToken(vendorEmail: string): Promise<string> {
    const config = await this.configModel.findOne({ vendorEmail }).lean().exec();
    const token = config?.companies?.['noest']?.credentials?.apiToken;
    if (!token) {
      throw new Error('Noest API token not configured. Set it up in Delivery Configuration.');
    }
    return token;
  }

  private async callNoestFeesApi(vendorEmail: string): Promise<Record<string, NoestFeeEntry>> {
    const apiToken = await this.getNoestApiToken(vendorEmail);
    const response = await fetch(`${this.noestApiBase}/api/public/fees`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Noest API returned ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const tarifs = data?.tarifs as Record<string, unknown> | undefined;
    const delivery = tarifs?.delivery as Record<string, unknown> | undefined;

    if (!delivery) {
      throw new Error('No delivery fees found in Noest response');
    }

    return delivery as Record<string, NoestFeeEntry>;
  }

  async upsertFees(
    vendorEmail: string,
    fees: { wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }[],
  ): Promise<void> {
    this.cacheService.clear(`delivery-fees:${vendorEmail}`);
    if (fees.length === 0) return;
    const setFields: Record<string, any> = {};
    for (const f of fees) {
      setFields[`fees.${f.wilayaCode}`] = {
        homeDeliveryFee: f.homeDeliveryFee,
        stopDeskDeliveryFee: f.stopDeskDeliveryFee,
      };
    }
    await this.feeModel.updateOne(
      { vendorEmail },
      { $set: setFields },
      { upsert: true },
    ).exec();
  }

  async syncFeesFromNoest(
    vendorEmail: string,
    wilayaCodes: string[],
  ): Promise<void> {
    const delivery = await this.callNoestFeesApi(vendorEmail);
    const fees = wilayaCodes
      .filter((code) => delivery[code])
      .map((code) => ({
        wilayaCode: code,
        homeDeliveryFee: parseInt(delivery[code].tarif || '0', 10) || 0,
        stopDeskDeliveryFee: parseInt(delivery[code].tarif_stopdesk || '0', 10) || 0,
      }));
    await this.upsertFees(vendorEmail, fees);
  }

  async fetchNoestFees(vendorEmail: string): Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }[]> {
    try {
      const delivery = await this.callNoestFeesApi(vendorEmail);
      return Object.entries(delivery).map(([wilayaId, fee]) => ({
        wilayaCode: wilayaId,
        homeDeliveryFee: parseInt(fee.tarif || '0', 10) || 0,
        stopDeskDeliveryFee: parseInt(fee.tarif_stopdesk || '0', 10) || 0,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch Noest fees: ${message}`);
      throw new Error(`Failed to fetch Noest fees: ${message}`);
    }
  }

  async fetchNoestFeeForWilaya(vendorEmail: string, wilayaCode: string): Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }> {
    try {
      const delivery = await this.callNoestFeesApi(vendorEmail);
      const fee = delivery[wilayaCode];
      if (!fee) {
        throw new NotFoundException(`No Noest fee found for wilaya ${wilayaCode}`);
      }
      return {
        wilayaCode,
        homeDeliveryFee: parseInt(fee.tarif || '0', 10) || 0,
        stopDeskDeliveryFee: parseInt(fee.tarif_stopdesk || '0', 10) || 0,
      };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch Noest fee for wilaya ${wilayaCode}: ${message}`);
      throw new Error(`Failed to fetch Noest fee for wilaya ${wilayaCode}: ${message}`);
    }
  }

  private async callEcomFeesApi(apiKey: string, apiToken: string): Promise<EcomWilayaFee[]> {
    const response = await fetch('https://ecom-dz.com/api_v2/tarifs', {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        'X-API-Token': apiToken,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ecom Delivery API returned ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as { wilayas?: EcomWilayaFee[] };
    const wilayas = data?.wilayas;

    if (!wilayas || !Array.isArray(wilayas)) {
      throw new Error('No wilayas fees found in Ecom Delivery response');
    }

    return wilayas;
  }

  async syncFeesFromEcom(
    vendorEmail: string,
    wilayaCodes: string[],
    apiKey: string,
    apiToken: string,
  ): Promise<void> {
    const wilayas = await this.callEcomFeesApi(apiKey, apiToken);
    const feeMap = new Map(wilayas.map(w => [String(w.wilaya), w]));
    const fees = wilayaCodes
      .filter((code) => feeMap.has(code))
      .map((code) => {
        const w = feeMap.get(code)!;
        return {
          wilayaCode: code,
          homeDeliveryFee: w.domicile,
          stopDeskDeliveryFee: w.stopdesk,
        };
      });
    await this.upsertFees(vendorEmail, fees);
  }

  async fetchEcomFees(
    vendorEmail: string,
    apiKey: string,
    apiToken: string,
  ): Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }[]> {
    try {
      const wilayas = await this.callEcomFeesApi(apiKey, apiToken);
      return wilayas.map((w) => ({
        wilayaCode: String(w.wilaya),
        homeDeliveryFee: w.domicile,
        stopDeskDeliveryFee: w.stopdesk,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch Ecom Delivery fees: ${message}`);
      throw new Error(`Failed to fetch Ecom Delivery fees: ${message}`);
    }
  }

  async fetchEcomFeeForWilaya(
    vendorEmail: string,
    wilayaCode: string,
    apiKey: string,
    apiToken: string,
  ): Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }> {
    try {
      const wilayas = await this.callEcomFeesApi(apiKey, apiToken);
      const fee = wilayas.find((w) => String(w.wilaya) === wilayaCode);
      if (!fee) {
        throw new NotFoundException(`No Ecom Delivery fee found for wilaya ${wilayaCode}`);
      }
      return {
        wilayaCode,
        homeDeliveryFee: fee.domicile,
        stopDeskDeliveryFee: fee.stopdesk,
      };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch Ecom Delivery fee for wilaya ${wilayaCode}: ${message}`);
      throw new Error(`Failed to fetch Ecom Delivery fee for wilaya ${wilayaCode}: ${message}`);
    }
  }

  private async callZrFeesApi(apiKey: string, tenantId: string): Promise<ZrRateEntry[]> {
    const response = await fetch('https://api.zrexpress.app/api/v1/delivery-pricing/rates', {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        'X-Tenant': tenantId,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`ZR Express API returned ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as { rates?: ZrRateEntry[] };
    const rates = data?.rates;

    if (!rates || !Array.isArray(rates)) {
      throw new Error('No rates found in ZR Express response');
    }

    return rates;
  }

  async syncFeesFromZr(
    vendorEmail: string,
    wilayaCodes: string[],
    apiKey: string,
    tenantId: string,
  ): Promise<void> {
    const rates = await this.callZrFeesApi(apiKey, tenantId);
    const feeByCode = new Map(rates.map(r => [String(r.toTerritoryCode), r]));
    const fees = wilayaCodes
      .filter((code) => feeByCode.has(code))
      .map((code) => {
        const rate = feeByCode.get(code)!;
        return {
          wilayaCode: code,
          homeDeliveryFee: rate.deliveryPrices?.find(p => p.deliveryType === 'home')?.price ?? 0,
          stopDeskDeliveryFee: rate.deliveryPrices?.find(p => p.deliveryType === 'pickup-point')?.price ?? 0,
        };
      });
    await this.upsertFees(vendorEmail, fees);
  }

  async fetchZrFees(
    vendorEmail: string,
    apiKey: string,
    tenantId: string,
  ): Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }[]> {
    try {
      const rates = await this.callZrFeesApi(apiKey, tenantId);
      return rates.map((r) => ({
        wilayaCode: String(r.toTerritoryCode),
        homeDeliveryFee: r.deliveryPrices?.find(p => p.deliveryType === 'home')?.price ?? 0,
        stopDeskDeliveryFee: r.deliveryPrices?.find(p => p.deliveryType === 'pickup-point')?.price ?? 0,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch ZR Express fees: ${message}`);
      throw new Error(`Failed to fetch ZR Express fees: ${message}`);
    }
  }

  async fetchZrFeeForWilaya(
    vendorEmail: string,
    wilayaCode: string,
    apiKey: string,
    tenantId: string,
  ): Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }> {
    try {
      const rates = await this.callZrFeesApi(apiKey, tenantId);
      const rate = rates.find((r) => String(r.toTerritoryCode) === wilayaCode);
      if (!rate) {
        throw new NotFoundException(`No ZR Express fee found for wilaya ${wilayaCode}`);
      }
      return {
        wilayaCode,
        homeDeliveryFee: rate.deliveryPrices?.find(p => p.deliveryType === 'home')?.price ?? 0,
        stopDeskDeliveryFee: rate.deliveryPrices?.find(p => p.deliveryType === 'pickup-point')?.price ?? 0,
      };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch ZR Express fee for wilaya ${wilayaCode}: ${message}`);
      throw new Error(`Failed to fetch ZR Express fee for wilaya ${wilayaCode}: ${message}`);
    }
  }

  private async getDhdApiToken(vendorEmail: string): Promise<string> {
    const config = await this.configModel.findOne({ vendorEmail }).lean().exec();
    const token = config?.companies?.['dhd']?.credentials?.apiToken;
    if (!token) {
      throw new Error('DHD API token not configured. Set it up in Delivery Configuration.');
    }
    return token;
  }

  private async callDhdFeesApi(apiToken: string): Promise<DhdWilayaFee[]> {
    const response = await fetch('https://platform.dhd-dz.com/api/v1/get/fees', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`DHD API returned ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as { livraison?: DhdWilayaFee[] };
    const livraison = data?.livraison;

    if (!livraison || !Array.isArray(livraison)) {
      throw new Error('No delivery fees found in DHD response');
    }

    return livraison;
  }

  async syncFeesFromDhd(
    vendorEmail: string,
    wilayaCodes: string[],
  ): Promise<void> {
    const apiToken = await this.getDhdApiToken(vendorEmail);
    const wilayas = await this.callDhdFeesApi(apiToken);
    const feeByCode = new Map(wilayas.map(w => [String(w.wilaya_id), w]));
    const fees = wilayaCodes
      .filter((code) => feeByCode.has(code))
      .map((code) => {
        const w = feeByCode.get(code)!;
        return {
          wilayaCode: code,
          homeDeliveryFee: parseInt(w.tarif || '0', 10) || 0,
          stopDeskDeliveryFee: parseInt(w.tarif_stopdesk || '0', 10) || 0,
        };
      });
    await this.upsertFees(vendorEmail, fees);
  }

  async fetchDhdFees(
    vendorEmail: string,
  ): Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }[]> {
    try {
      const apiToken = await this.getDhdApiToken(vendorEmail);
      const wilayas = await this.callDhdFeesApi(apiToken);
      return wilayas.map((w) => ({
        wilayaCode: String(w.wilaya_id),
        homeDeliveryFee: parseInt(w.tarif || '0', 10) || 0,
        stopDeskDeliveryFee: parseInt(w.tarif_stopdesk || '0', 10) || 0,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch DHD fees: ${message}`);
      throw new Error(`Failed to fetch DHD fees: ${message}`);
    }
  }

  async fetchDhdFeeForWilaya(
    vendorEmail: string,
    wilayaCode: string,
  ): Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }> {
    try {
      const apiToken = await this.getDhdApiToken(vendorEmail);
      const wilayas = await this.callDhdFeesApi(apiToken);
      const fee = wilayas.find((w) => String(w.wilaya_id) === wilayaCode);
      if (!fee) {
        throw new NotFoundException(`No DHD fee found for wilaya ${wilayaCode}`);
      }
      return {
        wilayaCode,
        homeDeliveryFee: parseInt(fee.tarif || '0', 10) || 0,
        stopDeskDeliveryFee: parseInt(fee.tarif_stopdesk || '0', 10) || 0,
      };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch DHD fee for wilaya ${wilayaCode}: ${message}`);
      throw new Error(`Failed to fetch DHD fee for wilaya ${wilayaCode}: ${message}`);
    }
  }
}