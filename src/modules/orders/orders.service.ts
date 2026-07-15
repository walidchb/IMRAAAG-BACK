import { Injectable, NotFoundException, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from './schemas/order.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { BulkActionDto } from './dto/bulk-action.dto';
import { BulkShipDto } from './dto/bulk-ship.dto';
import { DeliveryService } from '../delivery/delivery.service';
import { OrderStatusesService } from './order-statuses.service';
import { BulkOrderResult } from '../delivery/delivery-companies/interfaces/delivery-company-handler.interface';

export interface PaginatedOrdersResult {
  data: Order[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  statusCounts: Record<string, number>;
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  placed: ['confirmed', 'cancelled'],
  confirmed: ['dispatched', 'cancelled'],
  dispatched: ['in-transit', 'cancelled'],
  'in-transit': ['delivered', 'cancelled'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

@Injectable()
export class OrdersService implements OnModuleInit {
  private slugToIdMap = new Map<string, string>();
  private idToSlugMap = new Map<string, string>();

  constructor(
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    private readonly deliveryService: DeliveryService,
    private readonly statusesService: OrderStatusesService,
  ) {}

  async onModuleInit() {
    await this.reloadStatusMaps();
  }

  async reloadStatusMaps() {
    const { slugToId, idToSlug } = await this.statusesService.getAllAsMap();
    this.slugToIdMap = slugToId;
    this.idToSlugMap = idToSlug;
  }

  private resolveId(slug: string): string {
    const id = this.slugToIdMap.get(slug);
    if (!id) throw new BadRequestException(`Unknown status slug: '${slug}'`);
    return id;
  }

  private resolveSlug(id: string): string {
    const slug = this.idToSlugMap.get(id);
    if (!slug) throw new BadRequestException(`Unknown status id: '${id}'`);
    return slug;
  }

  private async generateOrderNo(): Promise<string> {
    const lastOrder = await this.orderModel
      .findOne()
      .sort({ createdAt: -1 })
      .select('orderNo')
      .lean()
      .exec();
    const nextNumber = lastOrder
      ? String(Number(lastOrder.orderNo) + 1).padStart(6, '0')
      : '000001';
    return nextNumber;
  }

  private validateStatusTransition(currentId: string, nextId: string): void {
    const currentSlug = this.resolveSlug(currentId);
    const nextSlug = this.resolveSlug(nextId);
    const allowed = ALLOWED_TRANSITIONS[currentSlug];
    if (!allowed || !allowed.includes(nextSlug)) {
      throw new BadRequestException(
        `Cannot transition order from '${currentSlug}' to '${nextSlug}'. Allowed transitions: ${(allowed || []).join(', ') || 'none'}`,
      );
    }
  }

  private isSlug(statusId: string, slug: string): boolean {
    return this.idToSlugMap.get(statusId) === slug;
  }

  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const nextNumber = await this.generateOrderNo();
    const now = new Date().toISOString();

    if (createOrderDto.shippingMethod === 'home') {
      if (!createOrderDto.customer?.wilaya || !createOrderDto.customer?.commune) {
        throw new BadRequestException('Wilaya and commune are required for home delivery');
      }
    }
    if (createOrderDto.shippingMethod === 'stopdesk' && !createOrderDto.stopDeskCode) {
      throw new BadRequestException('Stop desk code is required for stop desk delivery');
    }

    const itemsTotal = createOrderDto.items
      .reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const expectedMinTotal = itemsTotal + (createOrderDto.shippingFee || 0);
    if (createOrderDto.total < expectedMinTotal - 0.01) {
      throw new BadRequestException(
        `Total (${createOrderDto.total}) must be at least item subtotal (${itemsTotal}) plus shipping fee (${createOrderDto.shippingFee || 0})`,
      );
    }

    let deliveryCompanyId: string | undefined = createOrderDto.deliveryCompanyId;
    if (!deliveryCompanyId && createOrderDto.vendorEmail && createOrderDto.customer?.wilaya) {
      deliveryCompanyId = (await this.deliveryService.resolveCompanyForWilaya(
        createOrderDto.vendorEmail,
        createOrderDto.customer.wilaya,
      )) ?? undefined;
    }

    const items = await this.enrichItemsWithWeight(createOrderDto.items || []);

    const placedId = new Types.ObjectId(this.resolveId('placed'));

    const created = new this.orderModel({
      ...createOrderDto,
      items,
      orderNo: nextNumber,
      date: createOrderDto.date || now,
      createdAt: createOrderDto.createdAt || now,
      deliveryCompanyId: deliveryCompanyId || undefined,
      status: placedId,
      history: [
        {
          status: placedId,
          date: now,
          user: createOrderDto.createdBy || 'Vendor',
        },
      ],
    });

    return created.save();
  }

  private async enrichItemsWithWeight(
    items: Array<{ productId?: string; weight?: number }>,
  ): Promise<Array<{ productId?: string; weight?: number }>> {
    const objectIds = items
      .map(i => i.productId)
      .filter((id): id is string => !!id && /^[a-fA-F0-9]{24}$/.test(id));

    const weightMap = new Map<string, number | undefined>();

    if (objectIds.length > 0) {
      const products = await this.productModel
        .find({ _id: { $in: objectIds } })
        .select('weight')
        .lean()
        .exec();
      for (const p of products) {
        weightMap.set(String(p._id), (p as any).weight);
      }
    }

    return items.map(item => {
      if (item.weight !== undefined && item.weight > 0) return item;
      const productWeight = item.productId ? weightMap.get(item.productId) : undefined;
      return { ...item, weight: productWeight || item.weight };
    });
  }

  async findAll(query: Record<string, string>): Promise<PaginatedOrdersResult> {
    const filter: Record<string, any> = {};
    const orConditions: Record<string, any>[] = [];

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    if (query.vendorEmail) filter.vendorEmail = query.vendorEmail;

    if (query.orderStatus) {
      const statusId = this.slugToIdMap.get(query.orderStatus);
      if (statusId) filter.status = new Types.ObjectId(statusId);
    }

    if (query.search) {
      const term = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orConditions.push(
        { orderNo: { $regex: term, $options: 'i' } },
        { 'customer.name': { $regex: term, $options: 'i' } },
        { 'customer.phone': { $regex: term, $options: 'i' } },
      );
    }

    if (query.client) filter['customer.name'] = { $regex: query.client.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.orderNo) filter.orderNo = { $regex: query.orderNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.wilaya) filter['customer.wilaya'] = query.wilaya;
    if (query.commune) filter['customer.commune'] = query.commune;
    if (query.shippingMethod) filter.shippingMethod = query.shippingMethod;
    if (query.createdBy) filter.createdBy = { $regex: query.createdBy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.confirmedBy) filter.confirmedBy = { $regex: query.confirmedBy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.bureau) filter.bureau = { $regex: query.bureau.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.phone) filter['customer.phone'] = { $regex: query.phone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.note) filter['customer.note'] = { $regex: query.note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.createdAt) {
      const term = query.createdAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orConditions.push(
        { createdAt: { $regex: term, $options: 'i' } },
        { date: { $regex: term, $options: 'i' } },
      );
    }
    if (query.confirmedAt) filter.confirmedAt = { $regex: query.confirmedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.dispatchedAt) filter.dispatchedAt = { $regex: query.dispatchedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.statusConfirmation) {
      const term = query.statusConfirmation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orConditions.push(
        { statusConfirmation: { $regex: term, $options: 'i' } },
      );
    }
    if (query.total) {
      filter.total = Number(query.total);
    } else if (query.minTotal || query.maxTotal) {
      filter.total = {};
      if (query.minTotal) filter.total.$gte = Number(query.minTotal);
      if (query.maxTotal) filter.total.$lte = Number(query.maxTotal);
    }

    if (orConditions.length > 0) {
      filter.$or = orConditions;
    }

    const countFilter = query.vendorEmail ? { vendorEmail: query.vendorEmail } : {};

    const [data, total, statusCountsRaw] = await Promise.all([
      this.orderModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      this.orderModel.countDocuments(filter).exec(),
      this.orderModel.aggregate([
        { $match: countFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
    ]);

    const statusCounts: Record<string, number> = { All: 0 };
    let allTotal = 0;
    for (const entry of statusCountsRaw) {
      const idStr = entry._id ? String(entry._id) : undefined;
      const slug = idStr ? this.idToSlugMap.get(idStr) : undefined;
      if (slug) {
        statusCounts[slug] = entry.count;
        allTotal += entry.count;
      }
    }
    for (const slug of Object.keys(ALLOWED_TRANSITIONS)) {
      if (!(slug in statusCounts)) statusCounts[slug] = 0;
    }
    statusCounts.All = allTotal;

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      statusCounts,
    };
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  async update(id: string, updateOrderDto: UpdateOrderDto): Promise<Order> {
    const existing = await this.orderModel.findById(id).exec();
    if (!existing) throw new NotFoundException(`Order ${id} not found`);

    const updateData: Record<string, any> = { ...updateOrderDto };

    if (updateOrderDto.status && updateOrderDto.status !== String(existing.status)) {
      this.validateStatusTransition(String(existing.status), updateOrderDto.status);

      if (this.isSlug(updateOrderDto.status, 'confirmed') && !this.isSlug(String(existing.status), 'confirmed')) {
        updateData.confirmedAt = new Date().toISOString();
        updateData.confirmedBy = updateOrderDto.createdBy || 'Vendor';
      }

      if (this.isSlug(updateOrderDto.status, 'dispatched') && !this.isSlug(String(existing.status), 'dispatched')) {
        updateData.dispatchedAt = new Date().toISOString();
      }

      if (!updateOrderDto.history) {
        const historyEntry = {
          status: new Types.ObjectId(updateOrderDto.status),
          date: new Date().toISOString(),
          user: updateOrderDto.createdBy || 'Vendor',
        };
        updateData.history = [...(existing.history || []), historyEntry];
      }
    }

    const effectiveShippingMethod = updateOrderDto.shippingMethod || existing.shippingMethod;
    if (effectiveShippingMethod === 'home') {
      const wilaya = updateOrderDto.customer?.wilaya || existing.customer?.wilaya;
      const commune = updateOrderDto.customer?.commune || existing.customer?.commune;
      if (!wilaya || !commune) throw new BadRequestException('Wilaya and commune are required for home delivery');
    }
    if (effectiveShippingMethod === 'stopdesk') {
      const stopDeskCode = updateOrderDto.stopDeskCode || existing.stopDeskCode;
      if (!stopDeskCode) throw new BadRequestException('Stop desk code is required for stop desk delivery');
    }

    if (updateOrderDto.total !== undefined || updateOrderDto.items) {
      const items = updateOrderDto.items || (existing.items as any[]);
      const shippingFee = updateOrderDto.shippingFee ?? existing.shippingFee ?? 0;
      const itemsTotal = items.reduce((sum: number, item: any) => sum + (item.price || 0) * (item.quantity || 0), 0);
      const total = updateOrderDto.total ?? existing.total;
      const expectedMinTotal = itemsTotal + shippingFee;
      if (total < expectedMinTotal - 0.01) {
        throw new BadRequestException(
          `Total (${total}) must be at least item subtotal (${itemsTotal}) plus shipping fee (${shippingFee})`,
        );
      }
    }

    if (updateOrderDto.deliveryCompanyId === '') {
      const resolved = await this.deliveryService.resolveCompanyForWilaya(
        existing.vendorEmail,
        existing.customer.wilaya,
      );
      updateData.deliveryCompanyId = resolved || undefined;
    }

    const isBecomingDispatched = updateOrderDto.status
      && this.isSlug(updateOrderDto.status, 'dispatched')
      && !this.isSlug(String(existing.status), 'dispatched');

    if (isBecomingDispatched) {
      const { parcelId, error } = await this.deliveryService.createDeliveryForOrder(existing);

      if (!parcelId) {
        throw new BadRequestException(`Failed to create delivery: ${error || 'Unknown error'}`);
      }

      updateData.deliveryParcelId = parcelId;
    }

    const updated = await this.orderModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .exec();

    if (!updated) throw new NotFoundException(`Order ${id} not found`);

    return updated;
  }

  async remove(id: string): Promise<{ id: string; deleted: true }> {
    const result = await this.orderModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Order ${id} not found`);
    return { id: String(result._id), deleted: true };
  }

  async bulkAction(bulkActionDto: BulkActionDto): Promise<{ modifiedCount: number; errors?: string[] }> {
    const { ids, action } = bulkActionDto;

    if (action === 'delete') {
      const result = await this.orderModel.deleteMany({ _id: { $in: ids } }).exec();
      return { modifiedCount: result.deletedCount || 0 };
    }

    const targetSlug = action === 'confirm' ? 'confirmed' : 'cancelled';
    const targetId = this.resolveId(targetSlug);
    const now = new Date().toISOString();

    const orders = await this.orderModel.find({ _id: { $in: ids } }).exec();
    const errors: string[] = [];

    const bulkOps = orders
      .filter((order) => {
        try {
          this.validateStatusTransition(String(order.status), targetId);
          return true;
        } catch {
          errors.push(`Order ${order.orderNo}: Cannot transition from '${this.resolveSlug(String(order.status))}' to '${targetSlug}'`);
          return false;
        }
      })
      .map((order) => ({
        updateOne: {
          filter: { _id: order._id },
          update: {
            $set: {
              status: new Types.ObjectId(targetId),
              ...(targetSlug === 'confirmed' ? { confirmedAt: now, confirmedBy: 'Vendor' } : {}),
            },
            $push: {
              history: { status: new Types.ObjectId(targetId), date: now, user: 'Vendor' },
            },
          },
        },
      }));

    let modifiedCount = 0;
    if (bulkOps.length > 0) {
      const result = await this.orderModel.bulkWrite(bulkOps);
      modifiedCount = result.modifiedCount || 0;
    }

    const response: { modifiedCount: number; errors?: string[] } = { modifiedCount };
    if (errors.length > 0) response.errors = errors;
    return response;
  }

  async bulkShip(bulkShipDto: BulkShipDto): Promise<BulkOrderResult[]> {
    const { ids } = bulkShipDto;

    const orders = await this.orderModel.find({ _id: { $in: ids } }).exec();

    if (orders.length === 0) {
      return [];
    }

    const confirmedId = this.resolveId('confirmed');
    const nonConfirmable = orders.filter(o => String(o.status) !== confirmedId);
    if (nonConfirmable.length > 0) {
      const orderNos = nonConfirmable.map(o => o.orderNo).join(', ');
      throw new BadRequestException(
        `Only confirmed orders can be shipped. Orders not in confirmed status: ${orderNos}`,
      );
    }

    const results = await this.deliveryService.createBulkDeliveriesForOrders(orders);

    const now = new Date().toISOString();
    const user = orders[0]?.createdBy || 'Vendor';
    const dispatchedId = new Types.ObjectId(this.resolveId('dispatched'));

    for (const result of results) {
      if (result.success && result.parcelId) {
        await this.orderModel.updateOne(
          { orderNo: result.orderNo },
          {
            $set: {
              status: dispatchedId,
              deliveryParcelId: result.parcelId,
              deliveryError: undefined,
              dispatchedAt: now,
            },
            $push: {
              history: { status: dispatchedId, date: now, user },
            },
          },
        ).exec();
      } else if (!result.success) {
        await this.orderModel.updateOne(
          { orderNo: result.orderNo },
          { $set: { deliveryError: result.error } },
        ).exec();
      }
    }

    return results;
  }
}
