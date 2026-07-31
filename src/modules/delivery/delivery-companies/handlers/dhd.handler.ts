import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../../../common/errors/app-exception';
import { AppErrorCode } from '../../../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DeliveryCompanyHandler, BulkOrderResult } from '../interfaces/delivery-company-handler.interface';
import { DeliveryConfig, DeliveryConfigDocument } from '../../schemas/delivery-config.schema';
import { Commune, CommuneDocument } from '../../../territories/schemas/commune.schema';
import { Order } from '../../../orders/schemas/order.schema';
import { decryptRecord } from '../../../../common/encryption.util';
import { fetchWithRetry } from '../../../../common/fetch-with-retry';

interface DhdOrderPayload {
  reference?: string;
  nom_client: string;
  telephone: string;
  telephone_2?: string;
  adresse: string;
  commune: string;
  code_wilaya: string;
  montant: number;
  remarque?: string;
  produit: string;
  type: number;
  stop_desk: number;
  poids?: number;
}

interface DhdBulkResponse {
  results?: Record<string, DhdSingleResult | Record<string, string[]>>;
}

interface DhdSingleResult {
  success: boolean;
  tracking?: string;
  error?: string;
  message?: string;
}

@Injectable()
export class DhdHandler implements DeliveryCompanyHandler {
  readonly companyId = 'dhd';
  private readonly apiBase = 'https://platform.dhd-dz.com';
  private readonly logger = new Logger(DhdHandler.name);

  constructor(
    @InjectModel(DeliveryConfig.name)
    private configModel: Model<DeliveryConfigDocument>,
    @InjectModel(Commune.name)
    private communeModel: Model<CommuneDocument>,
    private readonly configService: ConfigService,
  ) {}

  private get encryptionKey(): string {
    return this.configService.get<string>('deliveryEncryptionKey') || '';
  }

  async createOrder(order: Order): Promise<{ parcelId: string }> {
    const apiToken = await this.getApiToken(order.vendorEmail);
    if (!apiToken) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, { company: 'DHD', vendor: order.vendorEmail });
    }

    const communeName = await this.resolveCommuneName(order.customer.wilaya, order.customer.commune);
    const payload = this.buildPayload(order, communeName);

    const params = new URLSearchParams();
    if (payload.reference) params.append('reference', payload.reference);
    params.append('nom_client', payload.nom_client);
    params.append('telephone', payload.telephone);
    params.append('adresse', payload.adresse);
    params.append('commune', payload.commune);
    params.append('code_wilaya', payload.code_wilaya);
    params.append('montant', String(payload.montant));
    params.append('produit', payload.produit);
    params.append('type', String(payload.type));
    params.append('stop_desk', String(payload.stop_desk));
    if (payload.telephone_2) params.append('telephone_2', payload.telephone_2);
    if (payload.remarque) params.append('remarque', payload.remarque);
    if (payload.poids) params.append('weight', String(payload.poids));

    try {
      const url = `${this.apiBase}/api/v1/create/order?${params.toString()}`;
      this.logger.log(`DHD order URL (truncated): ${url.slice(0, 300)}...`);

      const response = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            Accept: 'application/json',
          },
          timeout: 10000,
        },
        {
          circuitBreakerName: 'dhd',
          onRetry: (attempt, err) => this.logger.warn(`DHD create order retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const text = await response.text();
      this.logger.log(`DHD create order response (${response.status}): ${text}`);

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }

      if (body.success === true && body.tracking) {
        return { parcelId: String(body.tracking) };
      }

      const msg = body.message || body.error || text;
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'DHD', status: response.status, text: msg });
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`DHD create order failed for ${order.orderNo}: ${message}`);
      throw new AppException(AppErrorCode.DELIVERY_UNKNOWN_ERROR, { company: 'DHD', orderNo: order.orderNo, message });
    }
  }

  async createBulkOrders(orders: Order[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return [];
    if (orders.length > 100) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Max 100 orders per bulk request' }));
    }

    const apiToken = await this.getApiToken(orders[0].vendorEmail);
    if (!apiToken) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'DHD API token not configured' }));
    }

    const ordersPayload: Record<string, DhdOrderPayload> = {};
    for (let i = 0; i < orders.length; i++) {
      const communeName = await this.resolveCommuneName(orders[i].customer.wilaya, orders[i].customer.commune);
      ordersPayload[String(i)] = this.buildPayload(orders[i], communeName);
    }

    try {
      this.logger.log(`DHD bulk payload for ${orders.length} orders`);

      const response = await fetchWithRetry(
        `${this.apiBase}/api/v1/create/orders`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ orders: ordersPayload }),
          timeout: 15000,
        },
        {
          circuitBreakerName: 'dhd',
          onRetry: (attempt, err) => this.logger.warn(`DHD bulk create retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseText = await response.text();
      let body: DhdBulkResponse;
      try {
        body = JSON.parse(responseText);
      } catch {
        body = {};
      }

      this.logger.log(`DHD bulk response (${response.status}): ${JSON.stringify(body).slice(0, 800)}`);

      const results: BulkOrderResult[] = [];
      const resultMap = body.results;

      if (resultMap) {
        for (let i = 0; i < orders.length; i++) {
          const order = orders[i];
          const ref = order.orderNo;
          const entry = resultMap[ref] || resultMap[String(i)];

          if (!entry) {
            results.push({ orderNo: order.orderNo, success: false, error: 'Order not included in API response' });
            continue;
          }

          if ('success' in entry && typeof entry.success === 'boolean') {
            const result = entry as DhdSingleResult;
            if (result.success && result.tracking) {
              results.push({ orderNo: order.orderNo, success: true, parcelId: result.tracking });
            } else {
              const msg = result.message || result.error || 'Unknown error';
              results.push({ orderNo: order.orderNo, success: false, error: msg });
            }
          } else {
            const errors = Object.values(entry).flat().join('; ');
            results.push({ orderNo: order.orderNo, success: false, error: errors || 'Unknown error' });
          }
        }
      } else {
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Unexpected DHD API response format' }));
      }

      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`DHD bulk API call failed: ${message}`);
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: message }));
    }
  }

  private buildPayload(order: Order, communeName: string): DhdOrderPayload {
    const isStopDesk = order.shippingMethod === 'stopdesk';

    const produit =
      order.items
        ?.map((item) => item.productName || `Product ${item.productId || ''}`)
        .filter(Boolean)
        .join(', ')
        .slice(0, 255) || `Order ${order.orderNo}`;

    const weight = order.items?.reduce((sum, item) => sum + (item.weight || 0) * (item.quantity || 1), 0) || 0;

    const payload: DhdOrderPayload = {
      reference: order.orderNo,
      nom_client: (order.customer.name || 'Client').slice(0, 255),
      telephone: this.cleanPhone(order.customer.phone || ''),
      adresse: (order.customer.address || '').slice(0, 255) || 'N/A',
      commune: communeName,
      code_wilaya: order.customer.wilaya || '',
      montant: order.total || 0,
      produit: produit.slice(0, 255),
      type: 1,
      stop_desk: isStopDesk ? 1 : 0,
    };

    if (order.customer.email) {
      payload.telephone_2 = this.cleanPhone(order.customer.email);
    }

    if (order.customer.note) {
      payload.remarque = order.customer.note.slice(0, 255);
    }

    if (weight > 0) {
      payload.poids = weight;
    }

    return payload;
  }

  private async resolveCommuneName(wilayaCode: string, communeValue: string): Promise<string> {
    try {
      const isObjectId = /^[a-fA-F0-9]{24}$/.test(communeValue);

      const query: Record<string, unknown> = { wilaya_code: wilayaCode };
      if (isObjectId) {
        query._id = communeValue;
      } else {
        query.post_code = communeValue;
      }

      const commune = await this.communeModel.findOne(query).exec();
      if (commune) {
        return commune.name;
      }
    } catch (err) {
      this.logger.warn(`Failed to lookup commune ${communeValue}: ${err instanceof Error ? err.message : ''}`);
    }

    this.logger.warn(`Commune ${communeValue} not found in DB, sending as-is`);
    return communeValue;
  }

  private async getApiToken(vendorEmail: string): Promise<string | null> {
    try {
      const config = await this.configModel.findOne({ vendorEmail }).lean().exec();
      const rawCreds = config?.companies?.['dhd']?.credentials || {};
      const creds = decryptRecord(rawCreds, this.encryptionKey);
      return creds.apiToken || null;
    } catch {
      return null;
    }
  }

  private cleanPhone(phone: string): string {
    return phone.replace(/[^0-9]/g, '').slice(0, 10);
  }
}
