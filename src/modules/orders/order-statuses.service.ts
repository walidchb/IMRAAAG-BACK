import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OrderStatus, OrderStatusDocument } from './schemas/order-status.schema';

@Injectable()
export class OrderStatusesService {
  constructor(
    @InjectModel(OrderStatus.name) private statusModel: Model<OrderStatusDocument>,
  ) {}

  async getAll(): Promise<OrderStatus[]> {
    return this.statusModel.find().sort({ sortOrder: 1 }).exec();
  }

  async getBySlug(slug: string): Promise<OrderStatus | null> {
    return this.statusModel.findOne({ slug }).exec();
  }

  async getById(id: string): Promise<OrderStatus | null> {
    return this.statusModel.findById(id).exec();
  }

  async getAllAsMap(): Promise<{ slugToId: Map<string, string>; idToSlug: Map<string, string> }> {
    const statuses = await this.getAll();
    const slugToId = new Map<string, string>();
    const idToSlug = new Map<string, string>();
    for (const s of statuses) {
      const id = String((s as any)._id);
      slugToId.set(s.slug, id);
      idToSlug.set(id, s.slug);
    }
    return { slugToId, idToSlug };
  }
}
