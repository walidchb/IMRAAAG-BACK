import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../../../common/errors/app-exception';
import { AppErrorCode } from '../../../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DeliveryCompanyHandler, BulkOrderResult } from '../interfaces/delivery-company-handler.interface';
import { DeliveryConfig, DeliveryConfigDocument } from '../../schemas/delivery-config.schema';
import { Commune, CommuneDocument } from '../../../territories/schemas/commune.schema';
import { Order } from '../../../orders/schemas/order.schema';

interface EcomParcelPayload {
  nom_complet: string;
  mobile_1: string;
  id_wilaya: number;
  commune?: string;
  code_stopdesk?: string;
  article: string;
  mobile_2?: string;
  adresse?: string;
  quantite?: number;
  total?: number;
  stopdesk?: number;
  note_fournisseur?: string;
  id_externe?: string;
}

interface EcomResultItem {
  index: number;
  ok: boolean;
  tracking: string | null;
  id_colis: number | null;
  tarif_si_livrer: number | null;
  tarif_si_annuler: number | null;
  erreur: string | null;
}

interface EcomCreateResponse {
  total: number;
  crees: number;
  echecs: number;
  resultats: EcomResultItem[];
}

@Injectable()
export class EcomHandler implements DeliveryCompanyHandler {
  readonly companyId = 'ecom-delivery';
  private readonly apiBase = 'https://ecom-dz.com/api_v2';
  private readonly logger = new Logger(EcomHandler.name);

  constructor(
    @InjectModel(DeliveryConfig.name)
    private configModel: Model<DeliveryConfigDocument>,
    @InjectModel(Commune.name)
    private communeModel: Model<CommuneDocument>,
  ) {}

  async createOrder(order: Order): Promise<{ parcelId: string }> {
    const results = await this.createBulkOrders([order]);
    if (results[0]?.success && results[0].parcelId) {
      return { parcelId: results[0].parcelId };
    }
    throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'Ecom', orderNo: order.orderNo, error: results[0]?.error || 'Unknown error' });
  }

  async createBulkOrders(orders: Order[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return [];
    if (orders.length > 100) {
      return orders.map(o => ({ orderNo: o.orderNo, success: false, error: 'Max 100 orders per bulk request' }));
    }

    const config = await this.configModel.findOne({ vendorEmail: orders[0].vendorEmail }).lean().exec();
    const creds = config?.companies?.['ecom-delivery']?.credentials || {};
    const apiKey: string | undefined = creds.key;
    const apiToken: string | undefined = creds.token;

    if (!apiKey || !apiToken) {
      return orders.map(o => ({ orderNo: o.orderNo, success: false, error: 'Ecom Delivery credentials not configured' }));
    }

    const parcels: EcomParcelPayload[] = [];
    for (const order of orders) {
      const communeName = await this.resolveCommuneName(order.customer.wilaya, order.customer.commune);
      const payload = this.buildPayload(order, communeName);
      parcels.push(payload);
    }

    try {
      this.logger.log(`Ecom payload for ${orders.length} orders: ${JSON.stringify(parcels).slice(0, 500)}...`);

      const response = await fetch(`${this.apiBase}/colis`, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'X-API-Token': apiToken,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(parcels),
      });

      const responseText = await response.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(responseText);
      } catch {
        body = { raw: responseText };
      }

      this.logger.log(`Ecom response (${response.status}): ${JSON.stringify(body).slice(0, 500)}`);

      if (!response.ok) {
        const errorMsg = body?.error
          ? typeof body.error === 'object'
            ? (body.error as Record<string, unknown>).message || JSON.stringify(body.error)
            : String(body.error)
          : `HTTP ${response.status}`;
        return orders.map(o => ({ orderNo: o.orderNo, success: false, error: `Ecom API error: ${errorMsg}` }));
      }

      const resultats = (body as unknown as EcomCreateResponse).resultats;
      if (!resultats || !Array.isArray(resultats)) {
        return orders.map(o => ({ orderNo: o.orderNo, success: false, error: 'Unexpected Ecom API response format' }));
      }

      const results: BulkOrderResult[] = [];
      for (const r of resultats) {
        const order = orders[r.index];
        if (order) {
          if (r.ok && r.tracking) {
            results.push({ orderNo: order.orderNo, success: true, parcelId: r.tracking });
          } else {
            results.push({ orderNo: order.orderNo, success: false, error: r.erreur || 'Unknown error' });
          }
        }
      }

      const returnedOrderNos = new Set(results.map(r => r.orderNo));
      for (const order of orders) {
        if (!returnedOrderNos.has(order.orderNo)) {
          results.push({ orderNo: order.orderNo, success: false, error: 'Order not included in API response' });
        }
      }

      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Ecom API call failed: ${message}`);
      return orders.map(o => ({ orderNo: o.orderNo, success: false, error: message }));
    }
  }

  private buildPayload(order: Order, communeName: string): EcomParcelPayload {
    const isStopDesk = order.shippingMethod === 'stopdesk';

    const article = order.items
      ?.map((item) => item.productName || `Product ${item.productId || ''}`)
      .filter(Boolean)
      .join(', ')
      .slice(0, 255) || `Order ${order.orderNo}`;

    const payload: EcomParcelPayload = {
      nom_complet: (order.customer.name || 'Client').slice(0, 20),
      mobile_1: this.cleanPhone(order.customer.phone || ''),
      id_wilaya: parseInt(order.customer.wilaya, 10) || 0,
      article,
      total: order.total || 0,
      id_externe: order.orderNo.slice(0, 20),
    };

    if (isStopDesk) {
      payload.stopdesk = 1;
      if (order.stopDeskCode) {
        payload.code_stopdesk = order.stopDeskCode.slice(0, 10);
      }
    } else {
      payload.stopdesk = 0;
      payload.commune = communeName;
    }

    if (order.customer.address) {
      payload.adresse = order.customer.address.slice(0, 30);
    }

    if (order.customer.email) {
      payload.mobile_2 = this.cleanPhone(order.customer.email);
    }

    if (order.customer.note) {
      payload.note_fournisseur = order.customer.note.slice(0, 255);
    }

    const totalQty = order.items?.reduce((sum, item) => sum + (item.quantity || 1), 0) || 1;
    if (totalQty > 1) {
      payload.quantite = totalQty;
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

      if (commune?.ecomdelivery_uuid) {
        this.logger.log(`Resolved commune "${communeValue}" → ecom name "${commune.ecomdelivery_uuid}"`);
        return commune.ecomdelivery_uuid;
      }

      if (commune) {
        this.logger.warn(`Commune ${communeValue} found but no ecomdelivery_uuid set, falling back to DB name "${commune.name}"`);
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
