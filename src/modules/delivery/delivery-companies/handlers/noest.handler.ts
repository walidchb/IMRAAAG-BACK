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

interface NoestCreateOrderPayload {
  user_guid: string;
  reference?: string;
  client: string;
  phone: string;
  phone_2?: string;
  adresse: string;
  wilaya_id: number;
  commune: string;
  montant: number;
  remarque?: string;
  produit: string;
  type_id: number;
  poids?: number;
  stop_desk: number;
  station_code?: string;
  can_open?: number;
  shop_name?: string;
}

interface NoestCreateOrderResponse {
  success: boolean;
  tracking?: string;
  reference?: string;
  message?: string;
}

@Injectable()
export class NoestHandler implements DeliveryCompanyHandler {
  readonly companyId = 'noest';
  private readonly apiBase = 'https://app.noest-dz.com';
  private readonly logger = new Logger(NoestHandler.name);

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
    const config = await this.configModel.findOne({ vendorEmail: order.vendorEmail }).exec();
    const rawCreds = config?.companies?.['noest']?.credentials || {};
    const creds = decryptRecord(rawCreds, this.encryptionKey);

    const apiToken: string | undefined = creds.apiToken;
    const userGuid: string | undefined = creds.guid;

    if (!apiToken || !userGuid) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, { company: 'Noest', vendor: order.vendorEmail });
    }

    const communeName = await this.resolveCommuneName(order.customer.wilaya, order.customer.commune);

    const payload = this.buildNoestPayload(order, userGuid, communeName);

    if (payload.wilaya_id < 1 || payload.wilaya_id > 58) {
      throw new AppException(AppErrorCode.DELIVERY_INVALID_WILAYA, { wilaya: payload.wilaya_id, orderNo: order.orderNo });
    }

    try {
      this.logger.log(`Noest payload for ${order.orderNo}: ${JSON.stringify(payload)}`);

      const response = await fetchWithRetry(
        `${this.apiBase}/api/public/create/order`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          timeout: 10000,
        },
        {
          circuitBreakerName: 'noest',
          onRetry: (attempt, err) => this.logger.warn(`Noest create order retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseText = await response.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(responseText);
      } catch {
        body = { raw: responseText };
      }

      this.logger.log(`Noest response for ${order.orderNo} (${response.status}): ${JSON.stringify(body)}`);

      if (!response.ok || body.success !== true) {
        throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'Noest', status: response.status, text: responseText });
      }

      const tracking = body.tracking as string | undefined;
      if (!tracking) {
        throw new AppException(AppErrorCode.DELIVERY_ORDER_NOT_IN_RESPONSE, { orderNo: order.orderNo, company: 'Noest' });
      }

      this.logger.log(`Noest order created: ${tracking} for order ${order.orderNo}`);
      return { parcelId: tracking };
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Noest API call failed for order ${order.orderNo}: ${message}`);
      throw new AppException(AppErrorCode.DELIVERY_UNKNOWN_ERROR, { company: 'Noest', orderNo: order.orderNo, message });
    }
  }

  async createBulkOrders(orders: Order[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return [];
    if (orders.length > 100) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Max 100 orders per bulk request' }));
    }

    const config = await this.configModel.findOne({ vendorEmail: orders[0].vendorEmail }).exec();
    const rawCreds = config?.companies?.['noest']?.credentials || {};
    const creds = decryptRecord(rawCreds, this.encryptionKey);
    const apiToken = creds.apiToken;
    const userGuid = creds.guid;

    if (!apiToken || !userGuid) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Noest credentials not configured' }));
    }

    const orderPayloads: NoestCreateOrderPayload[] = [];
    for (const order of orders) {
      const communeName = await this.resolveCommuneName(order.customer.wilaya, order.customer.commune);
      const payload = this.buildNoestPayload(order, userGuid, communeName);

      if (payload.wilaya_id < 1 || payload.wilaya_id > 58) {
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: `Invalid wilaya_id ${payload.wilaya_id} for order ${order.orderNo}` }));
      }

      orderPayloads.push(payload);
    }

    try {
      this.logger.log(`Noest bulk payload for ${orders.length} orders`);

      const response = await fetchWithRetry(
        `${this.apiBase}/api/public/create/orders`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ user_guid: userGuid, orders: orderPayloads }),
          timeout: 15000,
        },
        {
          circuitBreakerName: 'noest',
          onRetry: (attempt, err) => this.logger.warn(`Noest bulk create retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseText = await response.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(responseText);
      } catch {
        body = { raw: responseText };
      }

      this.logger.log(`Noest bulk response (${response.status}): ${JSON.stringify(body)}`);

      const results: BulkOrderResult[] = [];
      const passed = body.passed as Record<string, { success: boolean; tracking?: string }> | undefined;
      const failed = body.failed as Record<string, { reference?: string; errors?: string }> | undefined;

      if (passed) {
        for (const [indexStr, result] of Object.entries(passed)) {
          const index = parseInt(indexStr, 10);
          const order = orders[index];
          if (order) {
            results.push({ orderNo: order.orderNo, success: true, parcelId: result.tracking });
          }
        }
      }

      if (failed) {
        for (const [indexStr, result] of Object.entries(failed)) {
          const index = parseInt(indexStr, 10);
          const order = orders[index];
          if (order) {
            results.push({ orderNo: order.orderNo, success: false, error: result.errors || 'Unknown error' });
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
      this.logger.error(`Noest bulk API call failed: ${message}`);
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: message }));
    }
  }

  private buildNoestPayload(order: Order, userGuid: string, communeName: string): NoestCreateOrderPayload {
    const weight = order.items?.reduce((sum, item) => sum + (item.weight || 0) * (item.quantity || 1), 0) || 1;

    const produit =
      order.items
        ?.map((item) => item.productName || `Product ${item.productId || ''}`)
        .filter(Boolean)
        .join(', ') || `Order ${order.orderNo}`;

    const isStopDesk = order.shippingMethod === 'stopdesk';

    const payload: NoestCreateOrderPayload = {
      user_guid: userGuid,
      reference: order.orderNo,
      client: order.customer.name || 'Client',
      phone: this.cleanPhone(order.customer.phone || ''),
      adresse: order.customer.address || communeName,
      wilaya_id: parseInt(order.customer.wilaya, 10) || 0,
      commune: communeName,
      montant: order.total || 0,
      produit,
      type_id: 1,
      stop_desk: isStopDesk ? 1 : 0,
      poids: weight,
      can_open: 1,
    };

    if (isStopDesk && order.stopDeskCode) {
      payload.station_code = order.stopDeskCode;
    }

    if (order.customer.note) {
      payload.remarque = order.customer.note;
    }

    if (order.customer.email) {
      payload.phone_2 = this.cleanPhone(order.customer.email);
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

      if (commune?.noestexpress_uuid) {
        this.logger.log(`Resolved commune "${communeValue}" → noest name "${commune.noestexpress_uuid}"`);
        return commune.noestexpress_uuid;
      }

      if (commune) {
        this.logger.warn(`Commune ${communeValue} found but no noestexpress_uuid set, falling back to DB name "${commune.name}"`);
        return commune.name;
      }
    } catch (err) {
      this.logger.warn(`Failed to lookup commune ${communeValue}: ${err instanceof Error ? err.message : ''}`);
    }

    this.logger.warn(`Commune ${communeValue} not found in DB, sending as-is`);
    return communeValue;
  }

  private cleanPhone(phone: string): string {
    return phone.replace(/[^0-9]/g, '').slice(0, 10);
  }
}
