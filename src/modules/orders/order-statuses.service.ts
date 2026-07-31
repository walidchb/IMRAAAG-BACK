import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { ORDER_STATUS_TRANSITIONS, OrderStatus, StatusConfig } from '../../common/constants/order-statuses.const';
import { OrderStatus as OrderStatusSchema, OrderStatusDocument } from './schemas/order-status.schema';

function toStatusConfig(doc: any): StatusConfig {
  return {
    _id: doc._id.toString(),
    slug: doc.slug,
    displayName: doc.displayName,
    nameEn: doc.nameEn,
    nameFr: doc.nameFr,
    nameAr: doc.nameAr,
    color: doc.color,
    sortOrder: doc.sortOrder,
  };
}

@Injectable()
export class OrderStatusesService {
  constructor(
    @InjectModel(OrderStatusSchema.name)
    private orderStatusModel: Model<OrderStatusDocument>,
  ) {}

  async getAll(): Promise<StatusConfig[]> {
    const docs = await this.orderStatusModel.find().sort({ sortOrder: 1 }).lean();
    return docs.map(toStatusConfig);
  }

  async getBySlug(slug: string): Promise<StatusConfig | null> {
    const doc = await this.orderStatusModel.findOne({ slug }).lean();
    return doc ? toStatusConfig(doc) : null;
  }

  async getById(id: string): Promise<StatusConfig | null> {
    const doc = await this.orderStatusModel.findById(id).lean();
    return doc ? toStatusConfig(doc) : null;
  }

  async getAllAsMap() {
    const statuses = await this.orderStatusModel.find().lean();
    const slugToId = new Map<string, string>();
    const idToSlug = new Map<string, string>();
    for (const s of statuses) {
      slugToId.set(s.slug, s._id.toString());
      idToSlug.set(s._id.toString(), s.slug);
    }
    return { slugToId, idToSlug };
  }

  getTransitions(): Record<string, string[]> {
    return ORDER_STATUS_TRANSITIONS;
  }

  validateTransition(currentSlug: string, nextSlug: string): void {
    const allowed = ORDER_STATUS_TRANSITIONS[currentSlug];
    if (!allowed || !allowed.includes(nextSlug)) {
      throw new AppException(AppErrorCode.ORDER_CANNOT_TRANSITION, { current: currentSlug, next: nextSlug });
    }
  }
}
