import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../../../common/errors/app-exception';
import { AppErrorCode } from '../../../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DeliveryCompanyHandler, BulkOrderResult } from '../interfaces/delivery-company-handler.interface';
import { DeliveryConfig, DeliveryConfigDocument } from '../../schemas/delivery-config.schema';
import { Wilaya, WilayaDocument } from '../../../territories/schemas/wilaya.schema';
import { Commune, CommuneDocument } from '../../../territories/schemas/commune.schema';
import { Order } from '../../../orders/schemas/order.schema';
import { decryptRecord } from '../../../../common/encryption.util';
import { fetchWithRetry } from '../../../../common/fetch-with-retry';

interface ZrCreateParcelPayload {
  customer: {
    customerId: string;
    name: string;
    phone: { number1: string };
  };
  deliveryAddress: {
    cityTerritoryId: string;
    districtTerritoryId: string;
    street?: string;
  };
  orderedProducts: Array<{
    productId: string;
    productName: string;
    productSku: string;
    unitPrice: number;
    quantity: number;
    stockType: string;
  }>;
  amount: number;
  description: string;
  deliveryType: string;
  weight?: { weight: number };
  externalId?: string;
  hubId?: string;
}

@Injectable()
export class ZrExpressHandler implements DeliveryCompanyHandler {
  readonly companyId = 'zr-express';
  private readonly apiBase = 'https://api.zrexpress.app/api/v1.0';
  private readonly logger = new Logger(ZrExpressHandler.name);

  constructor(
    @InjectModel(DeliveryConfig.name)
    private configModel: Model<DeliveryConfigDocument>,
    @InjectModel(Wilaya.name)
    private wilayaModel: Model<WilayaDocument>,
    @InjectModel(Commune.name)
    private communeModel: Model<CommuneDocument>,
    private readonly configService: ConfigService,
  ) {}

  private get encryptionKey(): string {
    return this.configService.get<string>('deliveryEncryptionKey') || '';
  }

  async createOrder(order: Order): Promise<{ parcelId: string }> {
    const config = await this.configModel.findOne({ vendorEmail: order.vendorEmail }).exec();
    const { apiKey, tenantId } = this.getCredentials(config);

    if (!apiKey || !tenantId) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, { company: 'ZR Express', vendor: order.vendorEmail });
    }

    const cityTerritoryId = await this.resolveCityTerritoryId(order.customer.wilaya);
    if (!cityTerritoryId) {
      throw new AppException(AppErrorCode.DELIVERY_TERRITORY_NOT_SYNCED, { type: 'wilaya', code: order.customer.wilaya, company: 'ZR Express' });
    }

    const districtTerritoryId = await this.resolveDistrictTerritoryId(order.customer.wilaya, order.customer.commune);
    if (!districtTerritoryId) {
      throw new AppException(AppErrorCode.DELIVERY_TERRITORY_NOT_SYNCED, { type: 'commune', code: order.customer.commune, company: 'ZR Express' });
    }

    const payload = await this.buildZrPayload(order, cityTerritoryId, districtTerritoryId);

    try {
      this.logger.log(`ZR Express request for ${order.orderNo}: POST ${this.apiBase}/parcels`);
      this.logger.log(`ZR Express payload for ${order.orderNo}: ${JSON.stringify(payload)}`);
      this.logger.log(`ZR Express headers: X-Tenant=${tenantId}, X-Api-Key=${apiKey.slice(0, 8)}...`);

      const response = await fetchWithRetry(
        `${this.apiBase}/parcels`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Tenant': tenantId,
            'X-Api-Key': apiKey,
          },
          body: JSON.stringify(payload),
          timeout: 10000,
        },
        {
          circuitBreakerName: 'zr-express',
          onRetry: (attempt, err) => this.logger.warn(`ZR create order retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseStatus = response.status;
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });
      this.logger.log(`ZR Express response status: ${responseStatus}`);
      this.logger.log(`ZR Express response headers: ${JSON.stringify(responseHeaders)}`);

      const errorBody = await response.text();
      this.logger.log(`ZR Express response body for ${order.orderNo}: ${errorBody}`);

      if (!response.ok) {
        this.logger.error(`ZR Express API error (${responseStatus}): ${errorBody}`);
        throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'ZR Express', status: responseStatus, text: errorBody });
      }

      let result: { id: string };
      try {
        result = JSON.parse(errorBody) as { id: string };
      } catch {
        this.logger.error(`ZR Express response for ${order.orderNo} is not valid JSON: ${errorBody}`);
        throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'ZR Express', status: responseStatus, text: 'Invalid JSON response' });
      }

      this.logger.log(`ZR Express parcel created: ${result.id} for order ${order.orderNo}`);
      return { parcelId: result.id };
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`ZR Express API call failed for order ${order.orderNo}: ${message}`);
      throw new AppException(AppErrorCode.DELIVERY_UNKNOWN_ERROR, { company: 'ZR Express', orderNo: order.orderNo, message });
    }
  }

  async createBulkOrders(orders: Order[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return [];
    if (orders.length > 100) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Max 100 orders per bulk request' }));
    }

    const config = await this.configModel.findOne({ vendorEmail: orders[0].vendorEmail }).exec();
    const { apiKey, tenantId } = this.getCredentials(config);

    if (!apiKey || !tenantId) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'ZR Express credentials not configured' }));
    }

    const parcels: ZrCreateParcelPayload[] = [];
    for (const order of orders) {
      const cityTerritoryId = await this.resolveCityTerritoryId(order.customer.wilaya);
      const districtTerritoryId = await this.resolveDistrictTerritoryId(order.customer.wilaya, order.customer.commune);
      if (!cityTerritoryId || !districtTerritoryId) {
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: `Territory IDs not resolved. Run territory sync first.` }));
      }
      parcels.push(await this.buildZrPayload(order, cityTerritoryId, districtTerritoryId));
    }

    try {
      this.logger.log(`ZR Express bulk request: POST ${this.apiBase}/parcels/bulk for ${orders.length} orders`);
      this.logger.log(`ZR Express bulk headers: X-Tenant=${tenantId}, X-Api-Key=${apiKey.slice(0, 8)}...`);

      const response = await fetchWithRetry(
        `${this.apiBase}/parcels/bulk`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Tenant': tenantId,
            'X-Api-Key': apiKey,
          },
          body: JSON.stringify(parcels),
          timeout: 30000,
        },
        {
          circuitBreakerName: 'zr-express',
          onRetry: (attempt, err) => this.logger.warn(`ZR bulk create retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseStatus = response.status;
      const responseText = await response.text();
      this.logger.log(`ZR Express bulk response status: ${responseStatus}`);
      this.logger.log(`ZR Express bulk response body: ${responseText.slice(0, 2000)}`);

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(responseText);
      } catch {
        this.logger.error(`ZR Express bulk response is not valid JSON: ${responseText}`);
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: `ZR Express returned invalid JSON: ${responseText}` }));
      }

      if (!response.ok) {
        this.logger.error(`ZR Express bulk API error (${responseStatus}): ${responseText}`);
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: `ZR Express API returned ${responseStatus}` }));
      }

      const successes = (body as any).successes as Array<{ index: number; parcelId: string; trackingNumber: string }> | undefined;
      const failures = (body as any).failures as Array<{ index: number; errorCode: string; errorMessage: string; externalId: string }> | undefined;

      const results: BulkOrderResult[] = [];

      if (successes) {
        for (const s of successes) {
          const order = orders[s.index];
          if (order) {
            results.push({ orderNo: order.orderNo, success: true, parcelId: s.parcelId });
          }
        }
      }

      if (failures) {
        for (const f of failures) {
          const order = orders[f.index];
          if (order) {
            results.push({ orderNo: order.orderNo, success: false, error: f.errorMessage });
          }
        }
      }

      const returnedOrderNos = new Set(results.map((r) => r.orderNo));
      for (const order of orders) {
        if (!returnedOrderNos.has(order.orderNo)) {
          results.push({ orderNo: order.orderNo, success: false, error: 'Order not included in API response' });
        }
      }

      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`ZR Express bulk API call failed: ${message}`);
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: message }));
    }
  }

  private async buildZrPayload(order: Order, cityTerritoryId: string, districtTerritoryId: string): Promise<ZrCreateParcelPayload> {
    const isPickupPoint = order.shippingMethod === 'stopdesk';
    const weight = order.items?.reduce((sum, item) => sum + (item.weight || 0) * (item.quantity || 1), 0) || 1;

    const payload: ZrCreateParcelPayload = {
      customer: {
        customerId: crypto.randomUUID(),
        name: order.customer.name || 'Client',
        phone: { number1: this.cleanPhone(order.customer.phone || '') },
      },
      deliveryAddress: {
        cityTerritoryId,
        districtTerritoryId,
        street: order.customer.address || undefined,
      },
      orderedProducts: order.items.map((item) => ({
        productId: crypto.randomUUID(),
        productName: item.productName || `Product ${item.productId || ''}`,
        productSku: `SKU-${item.productId || 'unknown'}`,
        unitPrice: item.price || 0,
        quantity: item.quantity || 1,
        stockType: 'local',
      })),
      amount: order.total || 0,
      description: `Order ${order.orderNo}`,
      deliveryType: isPickupPoint ? 'pickup-point' : 'home',
      weight: { weight },
      externalId: order.orderNo,
    };

    if (isPickupPoint && order.stopDeskCode) {
      payload.hubId = order.stopDeskCode;
    }

    return payload;
  }

  private async resolveCityTerritoryId(wilayaCode: string): Promise<string | undefined> {
    const wilaya = await this.wilayaModel.findOne({ code: wilayaCode }).exec();
    if (wilaya?.zrexpress_uuid) {
      return wilaya.zrexpress_uuid;
    }
    this.logger.warn(`Wilaya ${wilayaCode} has no zrexpress_uuid set`);
    return undefined;
  }

  private async resolveDistrictTerritoryId(wilayaCode: string, communeValue: string): Promise<string | undefined> {
    try {
      const isObjectId = /^[a-fA-F0-9]{24}$/.test(communeValue);

      const query: Record<string, unknown> = { wilaya_code: wilayaCode };
      if (isObjectId) {
        query._id = communeValue;
      } else {
        query.post_code = communeValue;
      }

      const commune = await this.communeModel.findOne(query).exec();
      if (commune?.zrexpress_uuid) {
        return commune.zrexpress_uuid;
      }

      this.logger.warn(`Commune ${communeValue} found but no zrexpress_uuid set`);
      return undefined;
    } catch (err) {
      this.logger.warn(`Failed to lookup commune ${communeValue}: ${err instanceof Error ? err.message : ''}`);
      return undefined;
    }
  }

  private cleanPhone(phone: string): string {
    const digits = phone.replace(/[^0-9]/g, '');
    if (digits.startsWith('213')) return `+${digits}`;
    if (digits.startsWith('0')) return `+213${digits.slice(1)}`;
    return `+213${digits}`;
  }

  private getCredentials(config: DeliveryConfig | null): { apiKey: string; tenantId: string } {
    const rawCreds = config?.companies?.['zr-express']?.credentials || {};
    const creds = decryptRecord(rawCreds, this.encryptionKey);
    return {
      apiKey: creds.apiKey || '',
      tenantId: creds.tenantId || '',
    };
  }
}
