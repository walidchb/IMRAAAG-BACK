import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from './schemas/order.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { BulkActionDto } from './dto/bulk-action.dto';
import { BulkShipDto } from './dto/bulk-ship.dto';
import { DeliveryService } from '../delivery/delivery.service';
import { OrderStatusesService } from './order-statuses.service';
import { BulkOrderResult } from '../delivery/delivery-companies/interfaces/delivery-company-handler.interface';
import { ORDER_STATUSES, ORDER_STATUS_TRANSITIONS, OrderStatus } from '../../common/constants/order-statuses.const';

export interface PaginatedOrdersResult {
  data: Order[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  statusCounts: Record<string, number>;
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    private readonly deliveryService: DeliveryService,
    private readonly statusesService: OrderStatusesService,
  ) {}

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

  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const nextNumber = await this.generateOrderNo();
    const now = new Date();

    if (createOrderDto.shippingMethod === 'home') {
      if (!createOrderDto.customer?.wilaya || !createOrderDto.customer?.commune) {
        throw new BadRequestException('Wilaya and commune are required for home delivery');
      }
    }

    const objectIds = (createOrderDto.items || [])
      .map(i => i.productId)
      .filter((id): id is string => !!id && /^[a-fA-F0-9]{24}$/.test(id));

    const productMap = new Map<string, { price: number; weight: number }>();

    if (objectIds.length > 0) {
      const products = await this.productModel
        .find({ _id: { $in: objectIds }, status: 'Active', published: true })
        .select('price weight')
        .lean()
        .exec();
      for (const p of products) {
        productMap.set(String(p._id), { price: (p as any).price, weight: (p as any).weight });
      }
    }

    let itemsTotal = 0;
    const items = (createOrderDto.items || []).map(item => {
      let price = item.price;
      let weight = item.weight;

      if (item.productId) {
        const product = productMap.get(item.productId);
        if (!product) {
          throw new BadRequestException(
            `Product "${item.productName}" is not found or is not available`,
          );
        }
        price = product.price;
        if (!weight || weight <= 0) {
          weight = product.weight;
        }
      }

      itemsTotal += price * item.quantity;
      return { ...item, price, weight: weight || item.weight };
    });

    const total = itemsTotal + (createOrderDto.shippingFee || 0);

    let deliveryCompanyId: string | undefined = createOrderDto.deliveryCompanyId;
    if (!deliveryCompanyId && createOrderDto.vendorEmail && createOrderDto.customer?.wilaya) {
      deliveryCompanyId = (await this.deliveryService.resolveCompanyForWilaya(
        createOrderDto.vendorEmail,
        createOrderDto.customer.wilaya,
      )) ?? undefined;
    }

    const created = new this.orderModel({
      ...createOrderDto,
      items,
      total,
      orderNo: nextNumber,
      date: createOrderDto.date || now,
      createdAt: createOrderDto.createdAt || now,
      deliveryCompanyId: deliveryCompanyId || undefined,
      status: ORDER_STATUSES.find(s => s.slug === 'placed')!,
      history: [
        {
          status: ORDER_STATUSES.find(s => s.slug === 'placed')!,
          date: now,
          user: createOrderDto.createdBy || 'Vendor',
        },
      ],
    });

    return created.save();
  }

  async findAll(query: Record<string, string>): Promise<PaginatedOrdersResult> {
    const filter: Record<string, any> = {};
    const orConditions: Record<string, any>[] = [];

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    if (query.vendorEmail) filter.vendorEmail = query.vendorEmail;

    if (query.orderStatus) {
      filter['status.slug'] = query.orderStatus;
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
        { $expr: { $regexMatch: { input: { $toString: '$createdAt' }, regex: term, options: 'i' } } },
        { $expr: { $regexMatch: { input: { $toString: '$date' }, regex: term, options: 'i' } } },
      );
    }
    const dateExprs: Record<string, any>[] = [];
    if (query.confirmedAt) {
      dateExprs.push({
        $expr: { $regexMatch: { input: { $toString: '$confirmedAt' }, regex: query.confirmedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' } },
      });
    }
    if (query.dispatchedAt) {
      dateExprs.push({
        $expr: { $regexMatch: { input: { $toString: '$dispatchedAt' }, regex: query.dispatchedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' } },
      });
    }
    if (dateExprs.length > 0) {
      filter.$and = dateExprs;
    }
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
        { $group: { _id: { $ifNull: ['$status.slug', '$status'] }, count: { $sum: 1 } } },
      ]).exec(),
    ]);

    const statusCounts: Record<string, number> = { All: 0 };
    let allTotal = 0;
    for (const entry of statusCountsRaw) {
      const slug = entry._id ? String(entry._id) : undefined;
      const knownSlug = ORDER_STATUSES.find(s => s.slug === slug) ? slug : undefined;
      if (knownSlug) {
        statusCounts[knownSlug] = entry.count;
        allTotal += entry.count;
      } else if (slug && slug !== 'null') {
        statusCounts[slug] = entry.count;
        allTotal += entry.count;
      }
    }
    for (const slug of Object.keys(ORDER_STATUS_TRANSITIONS)) {
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

  async findByCustomerPhone(phone: string, query: { page: number; limit: number; status?: string }) {
    const filter: any = { 'customer.phone': phone };
    if (query.status) {
      filter['status.slug'] = query.status;
    }
    const total = await this.orderModel.countDocuments(filter);
    const items = await this.orderModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .exec();
    return { items, total, page: query.page, pages: Math.ceil(total / query.limit) };
  }

  private getStatusSlug(status: any): string {
    if (!status) return 'placed';
    if (typeof status === 'string') return status;
    return (status as any).slug || 'placed';
  }

  async update(id: string, updateOrderDto: UpdateOrderDto): Promise<Order> {
    const existing = await this.orderModel.findById(id).exec();
    if (!existing) throw new NotFoundException(`Order ${id} not found`);

    const { status: _, ...restDto } = updateOrderDto;
    const updateData: Record<string, any> = { ...restDto };

    const existingSlug = this.getStatusSlug(existing.status);

    if (updateOrderDto.status && updateOrderDto.status !== existingSlug) {
      this.statusesService.validateTransition(existingSlug, updateOrderDto.status);

      const statusConfig = this.statusesService.getBySlug(updateOrderDto.status);
      if (!statusConfig) throw new BadRequestException(`Invalid status: ${updateOrderDto.status}`);
      updateData.status = statusConfig;

      if (updateOrderDto.status === 'confirmed' && existingSlug !== 'confirmed') {
        updateData.confirmedAt = new Date();
        updateData.confirmedBy = updateOrderDto.createdBy || 'Vendor';
      }

      if (updateOrderDto.status === 'dispatched' && existingSlug !== 'dispatched') {
        updateData.dispatchedAt = new Date();
      }

      if (!updateOrderDto.history) {
        const historyEntry = {
          status: statusConfig,
          date: new Date(),
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

    const isBecomingDispatched = updateOrderDto.status === 'dispatched' && existingSlug !== 'dispatched';

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

    const targetSlug: OrderStatus = action === 'confirm' ? OrderStatus.CONFIRMED : OrderStatus.CANCELLED;
    const now = new Date();

    const orders = await this.orderModel.find({ _id: { $in: ids } }).exec();
    const errors: string[] = [];

    const targetStatusConfig = this.statusesService.getBySlug(targetSlug)!;

    const bulkOps = orders
      .filter((order) => {
        try {
          this.statusesService.validateTransition(this.getStatusSlug(order.status), targetSlug);
          return true;
        } catch {
          errors.push(`Order ${order.orderNo}: Cannot transition from '${this.getStatusSlug(order.status)}' to '${targetSlug}'`);
          return false;
        }
      })
      .map((order) => ({
        updateOne: {
          filter: { _id: order._id },
          update: {
            $set: {
              status: targetStatusConfig,
              ...(targetSlug === OrderStatus.CONFIRMED ? { confirmedAt: now, confirmedBy: 'Vendor' } : {}),
            },
            $push: {
              history: { status: targetStatusConfig, date: now, user: 'Vendor' },
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

    const nonConfirmable = orders.filter(o => this.getStatusSlug(o.status) !== OrderStatus.CONFIRMED);
    if (nonConfirmable.length > 0) {
      const orderNos = nonConfirmable.map(o => o.orderNo).join(', ');
      throw new BadRequestException(
        `Only confirmed orders can be shipped. Orders not in confirmed status: ${orderNos}`,
      );
    }

    const results = await this.deliveryService.createBulkDeliveriesForOrders(orders);

    const dispatchedStatus = this.statusesService.getBySlug(OrderStatus.DISPATCHED)!;
    const now = new Date();
    const user = orders[0]?.createdBy || 'Vendor';

    for (const result of results) {
      if (result.success && result.parcelId) {
        await this.orderModel.updateOne(
          { orderNo: result.orderNo },
          {
            $set: {
              status: dispatchedStatus,
              deliveryParcelId: result.parcelId,
              deliveryError: undefined,
              dispatchedAt: now,
            },
            $push: {
              history: { status: dispatchedStatus, date: now, user },
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
