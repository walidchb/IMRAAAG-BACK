import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { DeliveryConfig, DeliveryConfigDocument } from './schemas/delivery-config.schema';
import { DeliveryAttribution, DeliveryAttributionDocument } from './schemas/delivery-attribution.schema';
import { NoestDesk, NoestDeskDocument } from './schemas/noest-desk.schema';
import { EcomDesk, EcomDeskDocument } from './schemas/ecom-desk.schema';
import { ZrHub, ZrHubDocument } from './schemas/zr-hub.schema';
import { DhdDesk, DhdDeskDocument } from './schemas/dhd-desk.schema';
import { SaveDeliveryConfigDto, SaveAttributionsDto } from './dto/save-delivery-config.dto';
import { DeliveryCompanyRegistry } from './delivery-companies/delivery-company-registry.service';
import { BulkOrderResult } from './delivery-companies/interfaces/delivery-company-handler.interface';
import { Order } from '../orders/schemas/order.schema';
import { Wilaya, WilayaDocument } from '../territories/schemas/wilaya.schema';
import { Commune, CommuneDocument } from '../territories/schemas/commune.schema';

interface NoestDeskRaw {
  code: string;
  name: string;
  address: string;
  email: string;
}

interface ZrTerritoryRaw {
  id: string;
  code: number;
  name: string;
  postalCode: string;
  level: string;
  parentId: string | null;
  delivery?: { hasHomeDelivery: boolean; hasPickupPoint: boolean };
}

interface ZrHubAddress {
  street?: string;
  city?: string;
  cityTerritoryId?: string;
  district?: string;
  districtTerritoryId?: string;
  postalCode?: string;
  country?: string;
  coordinates?: { lat?: number; lng?: number };
}

interface ZrHubPhone {
  number1?: string;
  number2?: string;
  number3?: string;
}

interface ZrHubRaw {
  id: string;
  name: string;
  type: string;
  isPickupPoint: boolean;
  address: ZrHubAddress;
  openingHours?: string;
  phone: ZrHubPhone;
  createdAt?: string;
}

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);
  private readonly zrApiBase = 'https://api.zrexpress.app/api/v1';
  private readonly noestApiBase = 'https://app.noest-dz.com';

  constructor(
    @InjectModel(DeliveryConfig.name)
    private configModel: Model<DeliveryConfigDocument>,
    @InjectModel(DeliveryAttribution.name)
    private attributionModel: Model<DeliveryAttributionDocument>,
    @InjectModel(NoestDesk.name)
    private noestDeskModel: Model<NoestDeskDocument>,
    @InjectModel(EcomDesk.name)
    private ecomDeskModel: Model<EcomDeskDocument>,
    @InjectModel(ZrHub.name)
    private zrHubModel: Model<ZrHubDocument>,
    @InjectModel(DhdDesk.name)
    private dhdDeskModel: Model<DhdDeskDocument>,
    @InjectModel(Wilaya.name)
    private wilayaModel: Model<WilayaDocument>,
    @InjectModel(Commune.name)
    private communeModel: Model<CommuneDocument>,
    private readonly deliveryCompanyRegistry: DeliveryCompanyRegistry,
  ) {}

  async resolveCompanyForWilaya(vendorEmail: string, wilayaCode: string): Promise<string | null> {
    const [attribution, config] = await Promise.all([
      this.attributionModel.findOne({ vendorEmail }).lean().exec(),
      this.configModel.findOne({ vendorEmail }).lean().exec(),
    ]);

    if (attribution?.attributions?.[wilayaCode]) {
      this.logger.log(`Resolved company "${attribution.attributions[wilayaCode]}" for wilaya ${wilayaCode} from attributions`);
      return attribution.attributions[wilayaCode];
    }

    this.logger.warn(`No attribution found for wilaya ${wilayaCode}, attributions keys: ${Object.keys(attribution?.attributions || {}).join(',') || 'none'}`);

    if (config?.companies) {
      for (const [id, c] of Object.entries(config.companies)) {
        if (c.isDefault) {
          this.logger.log(`Falling back to default company: ${id}`);
          return id;
        }
      }
    }

    this.logger.warn(`No default company found for vendor ${vendorEmail}`);
    return null;
  }

  async createDeliveryForOrder(order: Order): Promise<{ parcelId: string }> {
    const companyId = order.deliveryCompanyId;
    if (!companyId) {
      throw new AppException(AppErrorCode.DELIVERY_COMPANY_NOT_ASSIGNED, { orderNo: order.orderNo });
    }

    const handler = this.deliveryCompanyRegistry.getHandler(companyId);
    if (!handler) {
      throw new AppException(AppErrorCode.DELIVERY_HANDLER_NOT_FOUND, { companyId });
    }

    this.logger.log(`Creating delivery for order ${order.orderNo} via ${companyId}`);
    return handler.createOrder(order);
  }

  async createBulkDeliveriesForOrders(orders: Order[]): Promise<BulkOrderResult[]> {
    const results: BulkOrderResult[] = [];

    const groups = new Map<string, Order[]>();
    for (const order of orders) {
      const companyId = order.deliveryCompanyId;
      if (!companyId) {
        results.push({ orderNo: order.orderNo, success: false, error: 'No delivery company assigned to this order' });
        continue;
      }
      if (!groups.has(companyId)) groups.set(companyId, []);
      groups.get(companyId)!.push(order);
    }

    for (const [companyId, groupOrders] of groups) {
      const handler = this.deliveryCompanyRegistry.getHandler(companyId);
      if (!handler) {
        for (const order of groupOrders) {
          results.push({ orderNo: order.orderNo, success: false, error: `No handler registered for delivery company: ${companyId}` });
        }
        continue;
      }

      if (handler.createBulkOrders) {
        this.logger.log(`Creating bulk delivery for ${groupOrders.length} orders via ${companyId}`);
        const bulkResults = await handler.createBulkOrders(groupOrders);
        results.push(...bulkResults);
      } else {
        this.logger.log(`Creating individual deliveries for ${groupOrders.length} orders via ${companyId} (no bulk endpoint)`);
        for (const order of groupOrders) {
          try {
            const { parcelId } = await handler.createOrder(order);
            results.push({ orderNo: order.orderNo, success: true, parcelId });
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            results.push({ orderNo: order.orderNo, success: false, error: message });
          }
        }
      }
    }

    return results;
  }

  async syncNoestDesks(vendorEmail: string): Promise<{ inserted: number }> {
    const config = await this.configModel.findOne({ vendorEmail }).lean().exec();
    const creds = config?.companies?.['noest']?.credentials || {};
    const apiToken: string | undefined = creds.apiToken;

    if (!apiToken) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, { company: 'Noest' });
    }

    this.logger.log(`Fetching Noest desks from ${this.noestApiBase}/api/public/desks`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let response: Response;
    try {
      response = await fetch(`${this.noestApiBase}/api/public/desks`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new AppException(AppErrorCode.DELIVERY_API_TIMEOUT, { company: 'Noest' });
      }
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'Noest', message: String(err) });
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      this.logger.error(`Noest desks API returned ${response.status}: ${text}`);
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'Noest', status: response.status, text });
    }

    const raw = await response.json() as Record<string, NoestDeskRaw>;
    this.logger.log(`Noest API returned ${Object.keys(raw).length} raw desks, sample keys: ${Object.keys(raw).slice(0, 5).join(', ')}`);

    const desks = Object.values(raw).map((d) => {
      const match = d.code.match(/^(\d+)/);
      const wilayaCode = match ? String(parseInt(match[1], 10)) : '';
      this.logger.log(`  Desk code="${d.code}" name="${d.name}" -> wilayaCode="${wilayaCode}"`);
      return {
        code: d.code,
        name: d.name,
        address: d.address || '',
        wilayaCode,
        email: d.email || '',
      };
    });

    this.logger.log(`Extracted ${desks.length} desks from API response`);
    if (desks.length === 0) return { inserted: 0 };

    await this.noestDeskModel.deleteMany({});
    try {
      await this.noestDeskModel.insertMany(desks, { ordered: false });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
        this.logger.warn('Duplicate key(s) during insertMany (concurrent sync) — ignoring');
      } else {
        throw err;
      }
    }

    const countInDb = await this.noestDeskModel.countDocuments();
    this.logger.log(`Total NoestDesk docs in DB after sync: ${countInDb}`);

    return { inserted: desks.length };
  }

  async getNoestDesks(wilayaCode?: string): Promise<NoestDesk[]> {
    const total = await this.noestDeskModel.countDocuments();
    this.logger.log(`getNoestDesks called with wilayaCode="${wilayaCode ?? '(none)'}", total docs in collection: ${total}`);

    const filter = wilayaCode ? { wilayaCode } : {};
    const results = await this.noestDeskModel.find(filter).sort({ code: 1 }).lean().exec();
    this.logger.log(`getNoestDesks returning ${results.length} desks${wilayaCode ? ` for wilaya ${wilayaCode}` : ''}`);

    if (wilayaCode && results.length === 0) {
      const distinctWilayas = await this.noestDeskModel.distinct('wilayaCode');
      this.logger.log(`Distinct wilayaCodes in collection: [${distinctWilayas.join(', ')}]`);
    }

    return results;
  }

  async getEcomDesks(wilayaCode?: string): Promise<EcomDesk[]> {
    const filter = wilayaCode ? { wilayaCode } : {};
    return this.ecomDeskModel.find(filter).sort({ nom_bureau: 1 }).lean().exec();
  }

  async syncEcomDesks(vendorEmail: string): Promise<{ inserted: number }> {
    const config = await this.configModel.findOne({ vendorEmail }).lean().exec();
    const creds = config?.companies?.['ecom-delivery']?.credentials || {};
    const apiKey: string | undefined = creds.key;
    const apiToken: string | undefined = creds.token;

    if (!apiKey || !apiToken) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, { company: 'Ecom' });
    }

    this.logger.log('Syncing Ecom Delivery stop desks from API');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let response: Response;
    try {
      response = await fetch('https://ecom-dz.com/api_v2/bureaux', {
        method: 'GET',
        headers: {
          'X-API-Key': apiKey,
          'X-API-Token': apiToken,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new AppException(AppErrorCode.DELIVERY_API_TIMEOUT, { company: 'Ecom' });
      }
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'Ecom', message: String(err) });
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      this.logger.error(`Ecom desks API returned ${response.status}: ${text}`);
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'Ecom', status: response.status, text });
    }

    const raw = await response.json() as Array<Record<string, unknown>>;
    this.logger.log(`Ecom API returned ${raw.length} bureaux`);

    if (raw.length === 0) return { inserted: 0 };

    const desks = raw.map((item) => ({
      code_stopdesk: String(item.code_stopdesk || item.code || item.id || ''),
      nom_bureau: String(item.nom_bureau || item.nom || item.name || ''),
      wilayaCode: String(item.wilayaCode || item.wilaya || item.code_wilaya || ''),
      commune: String(item.commune || item.commune_name || ''),
      adresse: String(item.adresse || item.address || item.adress || ''),
      adresse_maps: String(item.adresse_maps || item.google_maps || item.maps || ''),
      tel_contact: String(item.tel_contact || item.tel || item.phone || item.telephone || ''),
      ecomId: typeof item.id === 'number' ? item.id : (typeof item.ecomId === 'number' ? item.ecomId : 0),
    }));

    await this.ecomDeskModel.deleteMany({});
    try {
      await this.ecomDeskModel.insertMany(desks, { ordered: false });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
        this.logger.warn('Duplicate key(s) during Ecom desk insertMany (concurrent sync) — ignoring');
      } else {
        throw err;
      }
    }

    const countInDb = await this.ecomDeskModel.countDocuments();
    this.logger.log(`Total EcomDesk docs in DB after sync: ${countInDb}`);

    return { inserted: desks.length };
  }

  async syncZRTerritories(vendorEmail: string): Promise<{ updated: number }> {
    const config = await this.configModel.findOne({ vendorEmail }).lean().exec();
    const { apiKey, tenantId } = this.getZrCredentials(config);

    const allTerritories = await this.fetchAllZRTerritories(apiKey, tenantId);
    this.logger.log(`ZR territories sync: fetched ${allTerritories.length} territories`);

    const wilayas = allTerritories.filter((t: ZrTerritoryRaw) => t.level === 'wilaya');
    const communes = allTerritories.filter((t: ZrTerritoryRaw) => t.level === 'commune');

    let updated = 0;

    for (const w of wilayas) {
      const result = await this.wilayaModel.updateOne(
        { code: String(w.code) },
        { $set: { zrexpress_uuid: w.id } },
      ).exec();
      if (result.modifiedCount > 0 || result.upsertedCount > 0) updated++;
    }

    for (const c of communes) {
      const result = await this.communeModel.updateOne(
        { post_code: c.postalCode },
        { $set: { zrexpress_uuid: c.id } },
      ).exec();
      if (result.modifiedCount > 0 || result.upsertedCount > 0) updated++;
    }

    this.logger.log(`ZR territories sync: updated ${updated} territories (${wilayas.length} wilayas, ${communes.length} communes)`);
    return { updated };
  }

  private async fetchAllZRTerritories(apiKey: string, tenantId: string): Promise<ZrTerritoryRaw[]> {
    const all: ZrTerritoryRaw[] = [];
    let page = 1;
    let hasNext = true;

    while (hasNext) {
      const response = await fetch(`${this.zrApiBase}.0/territories/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Tenant': tenantId,
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify({ pageNumber: page, pageSize: 1000, orderBy: ['code asc'] }),
      });

      if (!response.ok) {
        this.logger.error(`ZR territories/search error page ${page}: ${response.status}`);
        break;
      }

      const data = await response.json() as { items: ZrTerritoryRaw[]; hasNext: boolean; totalCount: number };
      const items = data.items || [];
      all.push(...items);
      this.logger.log(`ZR territories page ${page}: ${items.length} items (total ${all.length}/${data.totalCount || '?'})`);
      hasNext = data.hasNext === true && items.length > 0;
      page++;
    }

    return all;
  }

  async syncZRHubs(vendorEmail: string): Promise<{ inserted: number }> {
    const config = await this.configModel.findOne({ vendorEmail }).lean().exec();
    const { apiKey, tenantId } = this.getZrCredentials(config);

    const allHubs = await this.fetchAllZRHubs(apiKey, tenantId);
    this.logger.log(`ZR hubs sync: fetched ${allHubs.length} hubs`);

    const territoryIds = [...new Set(
      allHubs.map(h => h.address?.cityTerritoryId).filter(Boolean) as string[],
    )];

    const wilayas = territoryIds.length > 0
      ? await this.wilayaModel.find({ zrexpress_uuid: { $in: territoryIds } }).lean().exec()
      : [];

    const territoryToWilaya = new Map<string, string>();
    wilayas.forEach(w => {
      if (w.zrexpress_uuid) territoryToWilaya.set(w.zrexpress_uuid, w.code);
    });

    const hubDocs = allHubs.map((h) => {
      const addressParts = [h.address?.street, h.address?.city, h.address?.district].filter(Boolean);
      const wilayaCode = h.address?.cityTerritoryId
        ? (territoryToWilaya.get(h.address.cityTerritoryId) || '')
        : '';

      return {
        hubId: h.id,
        name: h.name || 'Unknown Hub',
        type: h.type || '',
        isPickupPoint: h.isPickupPoint ?? true,
        address: addressParts.join(', ') || '',
        wilayaCode,
        phone: h.phone?.number1 || '',
        openingHours: h.openingHours || '',
      };
    });

    this.logger.log(`First hubDoc sample: ${JSON.stringify(hubDocs[0])}`);
    this.logger.log(`Mapped ${hubDocs.length} hubs, resolved ${territoryToWilaya.size} territory-to-wilaya mappings`);

    if (hubDocs.length === 0) return { inserted: 0 };

    await this.zrHubModel.deleteMany({});
    try {
      const inserted = await this.zrHubModel.insertMany(hubDocs, { ordered: false });
      this.logger.log(`ZR hubs insertMany returned ${inserted.length} docs`);
    } catch (err: unknown) {
      if (err && typeof err === 'object') {
        this.logger.error(`ZR hubs insertMany error, keys: ${Object.keys(err).join(', ')}, code: ${(err as Record<string, unknown>).code}, name: ${(err as Record<string, unknown>).name}`);
        if ('code' in err && (err as { code: number }).code === 11000) {
          this.logger.warn('Duplicate key(s) during ZR hub insertMany (concurrent sync) — ignoring');
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const countInDb = await this.zrHubModel.countDocuments();
    this.logger.log(`Total ZrHub docs in DB after sync: ${countInDb}`);
    return { inserted: hubDocs.length };
  }

  private async fetchAllZRHubs(apiKey: string, tenantId: string): Promise<ZrHubRaw[]> {
    const all: ZrHubRaw[] = [];
    let page = 1;
    let hasNext = true;

    while (hasNext) {
      const response = await fetch(`${this.zrApiBase}/hubs/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Tenant': tenantId,
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify({ pageNumber: page, pageSize: 100, orderBy: ['name asc'] }),
      });

      if (!response.ok) {
        this.logger.error(`ZR hubs/search error page ${page}: ${response.status}`);
        break;
      }

      const body = await response.json() as { items: ZrHubRaw[]; hasNext: boolean; totalCount: number };
      const items = body.items || [];

      this.logger.log(`ZR hubs page ${page}: ${items.length} hubs (total ${all.length + items.length}/${body.totalCount || '?'})`);

      all.push(...items);

      hasNext = body.hasNext === true && items.length > 0;
      page++;
    }

    return all;
  }

  async getZRHubs(wilayaCode?: string): Promise<ZrHub[]> {
    const filter = wilayaCode ? { wilayaCode } : {};
    return this.zrHubModel.find(filter).sort({ name: 1 }).lean().exec();
  }

  async getDhdDesks(wilayaCode?: string): Promise<DhdDesk[]> {
    const filter = wilayaCode ? { wilayaCode } : {};
    return this.dhdDeskModel.find(filter).sort({ nom: 1 }).lean().exec();
  }

  async getConfigs(vendorEmail: string): Promise<DeliveryConfig | null> {
    return this.configModel.findOne({ vendorEmail }).exec();
  }

  async saveConfig(vendorEmail: string, dto: SaveDeliveryConfigDto): Promise<DeliveryConfig> {
    const setPaths: Record<string, unknown> = {};

    if (dto.credentials !== undefined) {
      setPaths[`companies.${dto.companyId}.credentials`] = dto.credentials;
    }
    if (dto.status !== undefined) {
      setPaths[`companies.${dto.companyId}.status`] = dto.status;
    }

    if (dto.isDefault === true) {
      const current = await this.configModel.findOne({ vendorEmail }).exec();
      if (current?.companies) {
        for (const cId of Object.keys(current.companies)) {
          if (cId !== dto.companyId) {
            setPaths[`companies.${cId}.isDefault`] = false;
          }
        }
      }
      setPaths[`companies.${dto.companyId}.isDefault`] = true;
    } else if (dto.isDefault === false) {
      setPaths[`companies.${dto.companyId}.isDefault`] = false;
    }

    return this.configModel.findOneAndUpdate(
      { vendorEmail },
      { $set: setPaths },
      { upsert: true, new: true },
    ).exec();
  }

  async getAttributions(vendorEmail: string): Promise<DeliveryAttribution | null> {
    return this.attributionModel.findOne({ vendorEmail }).exec();
  }
  async saveAttributions(vendorEmail: string, dto: SaveAttributionsDto): Promise<DeliveryAttribution> {
    const result = await this.attributionModel.findOneAndUpdate(
      { vendorEmail },
      { $set: { vendorEmail, attributions: dto.attributions } },
      { upsert: true, new: true },
    ).exec();

    return result;
  }

  private async getHubId(apiKey: string, tenantId: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.zrApiBase}/hubs/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Tenant': tenantId,
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify({ pageSize: 10, pageNumber: 1 }),
      });

      const body = await response.json() as Record<string, unknown>;
      this.logger.log(`ZR Express hubs/search response: ${JSON.stringify(body)}`);

      if (response.ok) {
        const hubs = (body.data as Array<{ id: string }> | undefined)
          || (body.items as Array<{ id: string }> | undefined)
          || [];
        this.logger.log(`ZR Express hubs found: ${hubs.length}`);
        if (hubs.length > 0) {
          const selected = hubs[Math.floor(Math.random() * hubs.length)];
          this.logger.log(`ZR Express selected hub: ${JSON.stringify(selected)}`);
          return selected.id;
        }
      }
    } catch (err) {
      this.logger.error(`ZR Express hubs/search call failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return null;
  }

  private getZrCredentials(config: DeliveryConfig | null): { apiKey: string; tenantId: string } {
    const creds = config?.companies?.['zr-express']?.credentials || {};
    return {
      apiKey: creds.apiKey || '',
      tenantId: creds.tenantId || '',
    };
  }

  async getTerritories(vendorEmail: string): Promise<Record<string, unknown>> {
    const config = await this.configModel.findOne({ vendorEmail }).exec();
    const { apiKey, tenantId } = this.getZrCredentials(config);

    const doFetch = async (body: Record<string, unknown>) => {
      const response = await fetch(`${this.zrApiBase}.0/territories/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Tenant': tenantId,
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        this.logger.error(`ZR Express territories/search error: ${response.status}`);
        return null;
      }
      return response.json() as Promise<{ items: Array<Record<string, unknown>> }>;
    };

    try {
      const all = await doFetch({ pageNumber: 1, pageSize: 1000, orderBy: ['code asc'] });
      if (!all?.items) return { error: 'No territories returned' };

      const wilayas = all.items.filter(
        (t: Record<string, unknown>) => t.level === 'wilaya',
      ) as Array<Record<string, unknown>>;

      const allCommunes = all.items.filter(
        (t: Record<string, unknown>) => t.level === 'commune',
      ) as Array<Record<string, unknown>>;

      // this.logger.log(`ZR Express: ${wilayas.length} wilayas, ${allCommunes.length} communes`);
      // allCommunes.forEach(c => {
      //   this.logger.log(`ZR Commune: "${c.name}" (code: ${c.code}, postalCode: ${c.postalCode}, parentId: ${c.parentId})`);
      // });

      const outputPath = path.resolve(__dirname, '../../../zr-express-territories.json');
      fs.writeFileSync(outputPath, JSON.stringify(all.items, null, 2), 'utf8');
      this.logger.log(`ZR Express territories saved to ${outputPath}`);

      const wilayaMap = new Map<string, Record<string, unknown>>();
      wilayas.forEach(w => {
        const id = w.id as string;
        const communes = allCommunes.filter(c => (c as Record<string, unknown>).parentId === id);
        wilayaMap.set(id, { ...w, communes });
      });

      return { wilayas: [...wilayaMap.values()] };
    } catch (err) {
      this.logger.error(`ZR Express territories/search failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      return { error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  async createParcelWithZRExpress(order: Order): Promise<{ parcelId?: string; error?: string }> {
    const config = await this.configModel.findOne({ vendorEmail: order.vendorEmail }).exec();
    const { apiKey, tenantId } = this.getZrCredentials(config);
    const hubId = await this.getHubId(apiKey, tenantId);

    const payload: Record<string, unknown> = {
      customer: {
        customerId: crypto.randomUUID(),
        name: order.customer.name || 'Client Test',
        phone: { number1: '+213550050505' },
      },
      deliveryAddress: {
        cityTerritoryId: '53c9e062-9c4e-4c77-8b71-55eabf887f83',
        districtTerritoryId: '8d0b6cd9-7712-47d2-9ea4-460246494c32',
        street: order.customer.address || 'Adresse test',
      },
      orderedProducts: order.items.map((item) => ({
        productId: '80d318ff-55f2-445e-a3e5-3ad40be223c4',
        productName: item.productName || 'Produit test',
        productSku: `SKU-${item.productId || 'TEST'}`,
        unitPrice: item.price || 100,
        quantity: item.quantity || 1,
        stockType: 'local',
      })),
      amount: order.total || 1000,
      description: `Commande ${order.orderNo}`,
      deliveryType: 'home',
      hubId,
      weight: { weight: 1 },
      externalId: order.orderNo,
    };

    try {
      const response = await fetch(`${this.zrApiBase}/parcels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Tenant': tenantId,
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.error(`ZR Express API error (${response.status}): ${errorBody}`);
        return { error: `ZR Express API returned ${response.status}: ${errorBody}` };
      }

      const result = await response.json() as { id: string };
      this.logger.log(`ZR Express parcel created: ${result.id} for order ${order.orderNo}`);
      return { parcelId: result.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`ZR Express API call failed: ${message}`);
      return { error: message };
    }
  }
}
