import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DeliveryFee, DeliveryFeeDocument } from './schemas/delivery-fee.schema';
import { UpdateDeliveryFeeDto, BulkUpdateDeliveryFeeDto } from './dto/manage-delivery-fees.dto';
import { DeliveryConfig, DeliveryConfigDocument } from '../delivery/schemas/delivery-config.schema';
import { CacheService } from '../../common/cache.service';
import { decryptRecord } from '../../common/encryption.util';
import { fetchWithRetry } from '../../common/fetch-with-retry';

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

interface FeeFetchJob {
  id: string;
  company: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result?: { wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }[];
  error?: string;
  createdAt: Date;
}

@Injectable()
export class DeliveryFeesService {
  private readonly logger = new Logger(DeliveryFeesService.name);
  private readonly noestApiBase = 'https://app.noest-dz.com';
  private readonly feeJobs = new Map<string, FeeFetchJob>();
  private jobCounter = 0;

  constructor(
    @InjectModel(DeliveryFee.name)
    private feeModel: Model<DeliveryFeeDocument>,
    @InjectModel(DeliveryConfig.name)
    private configModel: Model<DeliveryConfigDocument>,
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
  ) {}

  private get encryptionKey(): string {
    return this.configService.get<string>('deliveryEncryptionKey') || '';
  }

  async startFeeFetch(
    vendorEmail: string,
    company: string,
    fetchFn: () => Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }[]>,
  ): Promise<{ jobId: string }> {
    const jobId = `fee-fetch-${++this.jobCounter}-${Date.now()}`;
    const job: FeeFetchJob = {
      id: jobId,
      company,
      status: 'pending',
      createdAt: new Date(),
    };
    this.feeJobs.set(jobId, job);

    this.processFeeFetchJob(jobId, fetchFn);

    return { jobId };
  }

  private async processFeeFetchJob(
    jobId: string,
    fetchFn: () => Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }[]>,
  ): Promise<void> {
    const job = this.feeJobs.get(jobId);
    if (!job) return;
    job.status = 'running';

    try {
      const result = await fetchFn();
      job.status = 'done';
      job.result = result;
    } catch (err) {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : 'Unknown error';
    }
  }

  getFetchJobStatus(jobId: string): FeeFetchJob | null {
    return this.feeJobs.get(jobId) ?? null;
  }

  async startFetchNoest(vendorEmail: string): Promise<{ jobId: string }> {
    return this.startFeeFetch(vendorEmail, 'noest', () => this.fetchNoestFees(vendorEmail));
  }

  async startFetchEcom(vendorEmail: string, apiKey: string, apiToken: string): Promise<{ jobId: string }> {
    return this.startFeeFetch(vendorEmail, 'ecom', () => this.fetchEcomFees(vendorEmail, apiKey, apiToken));
  }

  async startFetchDhd(vendorEmail: string): Promise<{ jobId: string }> {
    return this.startFeeFetch(vendorEmail, 'dhd', () => this.fetchDhdFees(vendorEmail));
  }

  async startFetchZr(vendorEmail: string, apiKey: string, tenantId: string): Promise<{ jobId: string }> {
    return this.startFeeFetch(vendorEmail, 'zr-express', () => this.fetchZrFees(vendorEmail, apiKey, tenantId));
  }

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
    const doc = await this.feeModel.findOne({ vendorEmail }).lean().exec();
    if (!doc || !doc.fees || !doc.fees[wilayaCode]) {
      throw new AppException(AppErrorCode.FEE_NOT_FOUND_FOR_WILAYA, { wilayaCode });
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
    const rawCreds = config?.companies?.['noest']?.credentials || {};
    const key = this.encryptionKey;
    const creds = decryptRecord(rawCreds, key);
    const token = creds.apiToken;
    if (!token) {
      throw new AppException(AppErrorCode.FEE_API_CREDENTIALS_MISSING, { company: 'Noest' });
    }
    return token;
  }

  private async callNoestFeesApi(vendorEmail: string): Promise<Record<string, NoestFeeEntry>> {
    const apiToken = await this.getNoestApiToken(vendorEmail);

    let response: Response;
    try {
      response = await fetchWithRetry(`${this.noestApiBase}/api/public/fees`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Accept': 'application/json',
        },
        timeout: 10000,
      }, {
        circuitBreakerName: 'noest',
        onRetry: (attempt, err) => this.logger.warn(`Noest fees API retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + (err as Response).status}`),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('timed out')) {
        throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'Noest', message: 'Request timed out' });
      }
      throw err;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new AppException(AppErrorCode.FEE_API_ERROR, { company: 'Noest', status: response.status, body: errorBody });
    }

    const data = await response.json() as Record<string, unknown>;
    const tarifs = data?.tarifs as Record<string, unknown> | undefined;
    const delivery = tarifs?.delivery as Record<string, unknown> | undefined;

    if (!delivery) {
      throw new AppException(AppErrorCode.FEE_API_NO_DATA, { company: 'Noest' });
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
      throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'Noest', message });
    }
  }

  async fetchNoestFeeForWilaya(vendorEmail: string, wilayaCode: string): Promise<{ wilayaCode: string; homeDeliveryFee: number; stopDeskDeliveryFee: number }> {
    try {
      const delivery = await this.callNoestFeesApi(vendorEmail);
      const fee = delivery[wilayaCode];
      if (!fee) {
        throw new AppException(AppErrorCode.FEE_NOT_FOUND_FOR_WILAYA, { company: 'Noest', wilayaCode });
      }
      return {
        wilayaCode,
        homeDeliveryFee: parseInt(fee.tarif || '0', 10) || 0,
        stopDeskDeliveryFee: parseInt(fee.tarif_stopdesk || '0', 10) || 0,
      };
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch Noest fee for wilaya ${wilayaCode}: ${message}`);
      throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'Noest', wilayaCode, message });
    }
  }

  private async callEcomFeesApi(apiKey: string, apiToken: string): Promise<EcomWilayaFee[]> {
    let response: Response;
    try {
      response = await fetchWithRetry('https://ecom-dz.com/api_v2/tarifs', {
        method: 'GET',
        headers: {
          'X-API-Key': apiKey,
          'X-API-Token': apiToken,
          'Accept': 'application/json',
        },
        timeout: 10000,
      }, {
        circuitBreakerName: 'ecom',
        onRetry: (attempt, err) => this.logger.warn(`Ecom fees API retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + (err as Response).status}`),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('timed out')) {
        throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'Ecom', message: 'Request timed out' });
      }
      throw err;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new AppException(AppErrorCode.FEE_API_ERROR, { company: 'Ecom', status: response.status, body: errorBody });
    }

    const data = await response.json() as { wilayas?: EcomWilayaFee[] };
    const wilayas = data?.wilayas;

    if (!wilayas || !Array.isArray(wilayas)) {
      throw new AppException(AppErrorCode.FEE_API_NO_DATA, { company: 'Ecom' });
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
      throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'Ecom', message });
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
        throw new AppException(AppErrorCode.FEE_NOT_FOUND_FOR_WILAYA, { company: 'Ecom', wilayaCode });
      }
      return {
        wilayaCode,
        homeDeliveryFee: fee.domicile,
        stopDeskDeliveryFee: fee.stopdesk,
      };
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch Ecom Delivery fee for wilaya ${wilayaCode}: ${message}`);
      throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'Ecom', wilayaCode, message });
    }
  }

  private async callZrFeesApi(apiKey: string, tenantId: string): Promise<ZrRateEntry[]> {
    let response: Response;
    try {
      response = await fetchWithRetry('https://api.zrexpress.app/api/v1/delivery-pricing/rates', {
        method: 'GET',
        headers: {
          'X-Api-Key': apiKey,
          'X-Tenant': tenantId,
          'Accept': 'application/json',
        },
        timeout: 10000,
      }, {
        circuitBreakerName: 'zr-express',
        onRetry: (attempt, err) => this.logger.warn(`ZR fees API retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + (err as Response).status}`),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('timed out')) {
        throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'ZR Express', message: 'Request timed out' });
      }
      throw err;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new AppException(AppErrorCode.FEE_API_ERROR, { company: 'ZR Express', status: response.status, body: errorBody });
    }

    const data = await response.json() as { rates?: ZrRateEntry[] };
    const rates = data?.rates;

    if (!rates || !Array.isArray(rates)) {
      throw new AppException(AppErrorCode.FEE_API_NO_DATA, { company: 'ZR Express' });
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
      throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'ZR Express', message });
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
        throw new AppException(AppErrorCode.FEE_NOT_FOUND_FOR_WILAYA, { company: 'ZR Express', wilayaCode });
      }
      return {
        wilayaCode,
        homeDeliveryFee: rate.deliveryPrices?.find(p => p.deliveryType === 'home')?.price ?? 0,
        stopDeskDeliveryFee: rate.deliveryPrices?.find(p => p.deliveryType === 'pickup-point')?.price ?? 0,
      };
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch ZR Express fee for wilaya ${wilayaCode}: ${message}`);
      throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'ZR Express', wilayaCode, message });
    }
  }

  private async getDhdApiToken(vendorEmail: string): Promise<string> {
    const config = await this.configModel.findOne({ vendorEmail }).lean().exec();
    const rawCreds = config?.companies?.['dhd']?.credentials || {};
    const key = this.encryptionKey;
    const creds = decryptRecord(rawCreds, key);
    const token = creds.apiToken;
    if (!token) {
      throw new AppException(AppErrorCode.FEE_API_CREDENTIALS_MISSING, { company: 'DHD' });
    }
    return token;
  }

  private async callDhdFeesApi(apiToken: string): Promise<DhdWilayaFee[]> {
    let response: Response;
    try {
      response = await fetchWithRetry('https://platform.dhd-dz.com/api/v1/get/fees', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Accept': 'application/json',
        },
        timeout: 10000,
      }, {
        circuitBreakerName: 'dhd',
        onRetry: (attempt, err) => this.logger.warn(`DHD fees API retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + (err as Response).status}`),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('timed out')) {
        throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'DHD', message: 'Request timed out' });
      }
      throw err;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new AppException(AppErrorCode.FEE_API_ERROR, { company: 'DHD', status: response.status, body: errorBody });
    }

    const data = await response.json() as { livraison?: DhdWilayaFee[] };
    const livraison = data?.livraison;

    if (!livraison || !Array.isArray(livraison)) {
      throw new AppException(AppErrorCode.FEE_API_NO_DATA, { company: 'DHD' });
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
      throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'DHD', message });
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
        throw new AppException(AppErrorCode.FEE_NOT_FOUND_FOR_WILAYA, { company: 'DHD', wilayaCode });
      }
      return {
        wilayaCode,
        homeDeliveryFee: parseInt(fee.tarif || '0', 10) || 0,
        stopDeskDeliveryFee: parseInt(fee.tarif_stopdesk || '0', 10) || 0,
      };
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Failed to fetch DHD fee for wilaya ${wilayaCode}: ${message}`);
      throw new AppException(AppErrorCode.FEE_FETCH_FAILED, { company: 'DHD', wilayaCode, message });
    }
  }
}