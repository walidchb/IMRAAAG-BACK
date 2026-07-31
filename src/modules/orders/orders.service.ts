import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from './schemas/order.schema';
import { Counter, CounterDocument } from './schemas/counter.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { BulkActionDto } from './dto/bulk-action.dto';
import { BulkShipDto } from './dto/bulk-ship.dto';
import { DeliveryService } from '../delivery/delivery.service';
import { OrderStatusesService } from './order-statuses.service';
import { BulkOrderResult } from '../delivery/delivery-companies/interfaces/delivery-company-handler.interface';
import { ORDER_STATUS_VALUES, ORDER_STATUS_TRANSITIONS, OrderStatus } from '../../common/constants/order-statuses.const';
import { Role } from '../../common/constants/roles.enum';
import { StoresService } from '../stores/stores.service';

export interface RequestUser {
  id: string;
  email: string;
  role: string;
  fullName: string;
  phoneNumber?: string;
}

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
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(Counter.name) private counterModel: Model<CounterDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    private readonly deliveryService: DeliveryService,
    private readonly statusesService: OrderStatusesService,
    private readonly storesService: StoresService,
  ) {}

  private assertVendorOrAdmin(user: RequestUser): void {
    if (user.role !== Role.VENDOR && user.role !== Role.ADMIN) {
      throw new AppException(AppErrorCode.AUTH_VENDOR_ONLY);
    }
  }

  private assertOrderOwnership(order: Order, user: RequestUser): void {
    if (user.role === Role.ADMIN) return;
    if (order.vendorEmail?.toLowerCase() !== user.email?.toLowerCase()) {
      throw new AppException(AppErrorCode.AUTH_ORDER_OWNER_ONLY, { orderNo: order.orderNo });
    }
  }

  private async generateOrderNo(): Promise<string> {
    while (true) {
      const result = await this.counterModel
        .findOneAndUpdate(
          { key: 'orderNo' },
          { $inc: { seq: 1 } },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        )
        .exec();
      const seq = (result as any)?.seq ?? 1;
      const orderNo = String(seq).padStart(6, '0');
      const exists = await this.orderModel.findOne({ orderNo }).select('_id').lean().exec();
      if (!exists) return orderNo;
    }
  }

  async create(createOrderDto: CreateOrderDto, user?: RequestUser): Promise<Order> {
    if (user) {
      this.assertVendorOrAdmin(user);
      if (user.role === Role.VENDOR && createOrderDto.vendorEmail?.toLowerCase() !== user.email?.toLowerCase()) {
        throw new AppException(AppErrorCode.AUTH_ORDER_OWNER_ONLY);
      }
    }

    const now = new Date();

    if (createOrderDto.shippingMethod === 'home') {
      if (!createOrderDto.customer?.wilaya || !createOrderDto.customer?.commune) {
        throw new AppException(AppErrorCode.ORDER_WILAYA_COMMUNE_REQUIRED);
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
          throw new AppException(AppErrorCode.ORDER_PRODUCT_NOT_AVAILABLE, { name: item.productName });
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

    const placedStatus = (await this.statusesService.getBySlug('placed'))!;

    let saved: OrderDocument;
    let retries = 0;

    while (true) {
      const nextNumber = await this.generateOrderNo();

      const created = new this.orderModel({
        ...createOrderDto,
        items,
        total,
        orderNo: nextNumber,
        date: createOrderDto.date || now,
        createdAt: createOrderDto.createdAt || now,
        deliveryCompanyId: deliveryCompanyId || undefined,
        status: placedStatus,
        history: [{ status: placedStatus, date: now, user: createOrderDto.createdBy || (user ? 'Vendor' : 'Customer') }],
        updatedAt: now,
      });

      try {
        saved = await created.save();
        if (createOrderDto.vendorEmail) {
          await this.storesService.incrementOrderCount(createOrderDto.vendorEmail, 1);
        }
        break;
      } catch (err: any) {
        if (err.code === 11000 && retries < 3) {
          retries++;
          continue;
        }
        throw err;
      }
    }

    return saved;
  }

  async findAll(query: Record<string, string>, user?: RequestUser): Promise<PaginatedOrdersResult> {
    const filter: Record<string, any> = {};
    const orConditions: Record<string, any>[] = [];

    if (query.showDeleted !== 'true') {
      filter.isDeleted = { $ne: true };
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    if (user) {
      this.assertVendorOrAdmin(user);
      if (user.role === Role.VENDOR) {
        filter.vendorEmail = user.email;
      } else if (query.vendorEmail) {
        filter.vendorEmail = query.vendorEmail;
      }
    } else if (query.vendorEmail) {
      filter.vendorEmail = query.vendorEmail;
    }

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
    if (query.deliveryCompanyId) filter.deliveryCompanyId = query.deliveryCompanyId;
    if (query.productId) filter['items.productId'] = query.productId;
    if (query.createdAt) {
      const date = new Date(query.createdAt);
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      orConditions.push({ createdAt: { $gte: date, $lt: next } });
    } else if (query.createdAtFrom || query.createdAtTo) {
      const dateFilter: Record<string, any> = {};
      if (query.createdAtFrom) dateFilter.$gte = new Date(query.createdAtFrom);
      if (query.createdAtTo) dateFilter.$lte = new Date(query.createdAtTo);
      orConditions.push({ createdAt: dateFilter });
    }
    if (query.confirmedAt) {
      const date = new Date(query.confirmedAt);
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      filter.confirmedAt = { $gte: date, $lt: next };
    } else if (query.confirmedAtFrom || query.confirmedAtTo) {
      const dateFilter: Record<string, any> = {};
      if (query.confirmedAtFrom) dateFilter.$gte = new Date(query.confirmedAtFrom);
      if (query.confirmedAtTo) dateFilter.$lte = new Date(query.confirmedAtTo);
      filter.confirmedAt = dateFilter;
    }
    if (query.dispatchedAt) {
      const date = new Date(query.dispatchedAt);
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      filter.dispatchedAt = { $gte: date, $lt: next };
    } else if (query.dispatchedAtFrom || query.dispatchedAtTo) {
      const dateFilter: Record<string, any> = {};
      if (query.dispatchedAtFrom) dateFilter.$gte = new Date(query.dispatchedAtFrom);
      if (query.dispatchedAtTo) dateFilter.$lte = new Date(query.dispatchedAtTo);
      filter.dispatchedAt = dateFilter;
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

    const statusCountsFilter = { ...filter };
    delete statusCountsFilter['status.slug'];

    const allowedSortFields = ['createdAt', 'updatedAt', 'orderNo', 'total', 'date', 'customer.name', 'customer.phone', 'customer.wilaya', 'shippingMethod'];
    const sortField = allowedSortFields.includes(query.sortBy) ? query.sortBy : 'createdAt';
    const sortOrder = query.order === 'asc' ? 1 : -1;
    const [data, total, statusCountsRaw] = await Promise.all([
      this.orderModel.find(filter).sort({ [sortField]: sortOrder }).skip(skip).limit(limit).exec(),
      this.orderModel.countDocuments(filter).exec(),
      this.orderModel.aggregate([
        { $match: statusCountsFilter },
        { $group: { _id: { $ifNull: ['$status.slug', '$status'] }, count: { $sum: 1 } } },
      ]).exec(),
    ]);

    const statusCounts: Record<string, number> = { All: 0 };
    let allTotal = 0;
    for (const entry of statusCountsRaw) {
      const slug = entry._id ? String(entry._id) : undefined;
      const knownSlug = slug && ORDER_STATUS_VALUES.includes(slug) ? slug : undefined;
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

  async findOne(id: string, user?: RequestUser, allowDeleted?: boolean): Promise<Order> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    if (!allowDeleted && order.isDeleted) {
      throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    }
    if (user) {
      this.assertVendorOrAdmin(user);
      this.assertOrderOwnership(order, user);
    }
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

  async findByOrderNo(orderNo: string, phone: string): Promise<Order> {
    const order = await this.orderModel.findOne({ orderNo }).exec();
    if (!order) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { orderNo });
    if (order.customer.phone !== phone) {
      throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { orderNo });
    }
    return order;
  }

  async findOneByCustomer(id: string, phone: string): Promise<Order> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    if (order.customer.phone !== phone) {
      throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    }
    return order;
  }

  private getStatusSlug(status: any): string {
    if (!status) return 'placed';
    if (typeof status === 'string') return status;
    return (status as any).slug || 'placed';
  }

  async update(id: string, updateOrderDto: UpdateOrderDto, user?: RequestUser): Promise<Order> {
    if (user) {
      this.assertVendorOrAdmin(user);
    }

    const existing = await this.orderModel.findById(id).exec();
    if (!existing) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    if (user) {
      this.assertOrderOwnership(existing, user);
    }

    if (updateOrderDto.expectedUpdatedAt && existing.updatedAt) {
      const expected = new Date(updateOrderDto.expectedUpdatedAt).getTime();
      const actual = new Date(existing.updatedAt).getTime();
      if (Math.abs(expected - actual) > 1000) {
        this.logger.warn(`Order ${id} conflict — expected ${expected} vs actual ${actual}`);
      }
    }

    const { status: _, expectedUpdatedAt: __, history: _history, ...restDto } = updateOrderDto;
    const updateData: Record<string, any> = { ...restDto, updatedAt: new Date() };

    const existingSlug = this.getStatusSlug(existing.status);

    if (updateOrderDto.status && updateOrderDto.status !== existingSlug) {
      if (existingSlug === 'cancelled') {
        throw new AppException(AppErrorCode.ORDER_ALREADY_CANCELLED, { id });
      }
      if (existingSlug === 'delivered') {
        throw new AppException(AppErrorCode.ORDER_ALREADY_DELIVERED, { id });
      }
      this.statusesService.validateTransition(existingSlug, updateOrderDto.status);

      const statusConfig = await this.statusesService.getBySlug(updateOrderDto.status);
      if (!statusConfig) throw new AppException(AppErrorCode.ORDER_INVALID_STATUS, { status: updateOrderDto.status });
      updateData.status = statusConfig;

      if (updateOrderDto.status === 'confirmed') {
        updateData.confirmedAt = new Date();
        updateData.confirmedBy = updateOrderDto.createdBy || 'Vendor';
      }

      if (updateOrderDto.status === 'dispatched') {
        updateData.dispatchedAt = new Date();
      }

      const newHistoryEntry = {
        status: updateData.status,
        date: new Date(),
        user: updateOrderDto.createdBy || user?.email || 'Vendor',
      };
      updateData.$push = { history: newHistoryEntry };
    }

    const effectiveShippingMethod = updateOrderDto.shippingMethod || existing.shippingMethod;
    if (effectiveShippingMethod === 'home') {
      const wilaya = updateOrderDto.customer?.wilaya || existing.customer?.wilaya;
      const commune = updateOrderDto.customer?.commune || existing.customer?.commune;
      if (!wilaya || !commune) throw new AppException(AppErrorCode.ORDER_WILAYA_COMMUNE_REQUIRED);
    }

    if (updateOrderDto.total !== undefined || updateOrderDto.items) {
      const items = updateOrderDto.items || (existing.items as any[]);
      const shippingFee = updateOrderDto.shippingFee ?? existing.shippingFee ?? 0;
      const itemsTotal = items.reduce((sum: number, item: any) => sum + (item.price || 0) * (item.quantity || 0), 0);
      const total = updateOrderDto.total ?? existing.total;
      const expectedMinTotal = itemsTotal + shippingFee;
      if (total < expectedMinTotal - 0.01) {
        throw new AppException(AppErrorCode.ORDER_TOTAL_MISMATCH, { total, subtotal: itemsTotal });
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
      const { parcelId } = await this.deliveryService.createDeliveryForOrder(existing);
      updateData.deliveryParcelId = parcelId;
    }

    const updated = await this.orderModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .exec();

    if (!updated) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });

    return updated;
  }

  async remove(id: string, user?: RequestUser): Promise<{ id: string; deleted: true }> {
    if (user) {
      this.assertVendorOrAdmin(user);
    }

    const existing = await this.orderModel.findById(id).exec();
    if (!existing) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    if (user) {
      this.assertOrderOwnership(existing, user);
    }

    if (existing.isDeleted) {
      throw new AppException(AppErrorCode.ORDER_ALREADY_DELETED, { id });
    }

    await this.orderModel.findByIdAndUpdate(id, {
      $set: { isDeleted: true, deletedAt: new Date() },
    }).exec();

    return { id, deleted: true };
  }

  async bulkAction(bulkActionDto: BulkActionDto, user?: RequestUser): Promise<{ modifiedCount: number; errors?: string[] }> {
    const { ids, action } = bulkActionDto;

    const baseFilter: Record<string, any> = { _id: { $in: ids } };
    if (user) {
      this.assertVendorOrAdmin(user);
      if (user.role === Role.VENDOR) {
        baseFilter.vendorEmail = user.email;
      }
    }

    if (action === 'delete') {
      const now = new Date();
      const result = await this.orderModel.updateMany(
        { ...baseFilter, isDeleted: { $ne: true } },
        { $set: { isDeleted: true, deletedAt: now } },
      ).exec();
      return { modifiedCount: result.modifiedCount || 0 };
    }

    const targetSlug: OrderStatus = action === 'confirm' ? OrderStatus.CONFIRMED : OrderStatus.CANCELLED;
    const now = new Date();

    const orders = await this.orderModel.find(baseFilter).exec();
    const errors: string[] = [];

    const targetStatusConfig = (await this.statusesService.getBySlug(targetSlug))!;

    const bulkOps = orders
      .filter((order) => {
        const slug = this.getStatusSlug(order.status);
        if (slug === 'cancelled') {
          errors.push(`Order ${order.orderNo}: This order has already been cancelled`);
          return false;
        }
        if (slug === 'delivered') {
          errors.push(`Order ${order.orderNo}: This order has already been delivered`);
          return false;
        }
        try {
          this.statusesService.validateTransition(slug, targetSlug);
          return true;
        } catch {
          errors.push(`Order ${order.orderNo}: Cannot transition from '${slug}' to '${targetSlug}'`);
          return false;
        }
      })
      .map((order) => ({
        updateOne: {
          filter: { _id: order._id },
          update: {
            $set: {
              status: targetStatusConfig,
              updatedAt: now,
              ...(targetSlug === OrderStatus.CONFIRMED ? { confirmedAt: now, confirmedBy: user?.email || 'Vendor' } : {}),
            },
            $push: {
              history: {
                status: targetStatusConfig,
                date: now,
                user: user?.email || 'Vendor',
              },
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

  async bulkShip(bulkShipDto: BulkShipDto, user?: RequestUser): Promise<BulkOrderResult[]> {
    const { ids } = bulkShipDto;

    const baseFilter: Record<string, any> = { _id: { $in: ids } };
    if (user) {
      this.assertVendorOrAdmin(user);
      if (user.role === Role.VENDOR) {
        baseFilter.vendorEmail = user.email;
      }
    }

    const orders = await this.orderModel.find(baseFilter).exec();

    if (orders.length === 0) {
      return [];
    }

    const nonConfirmable = orders.filter(o => this.getStatusSlug(o.status) !== OrderStatus.CONFIRMED);
    if (nonConfirmable.length > 0) {
      const orderNos = nonConfirmable.map(o => o.orderNo).join(', ');
      throw new AppException(AppErrorCode.ORDER_ONLY_CONFIRMED_CAN_SHIP);
    }

    const results = await this.deliveryService.createBulkDeliveriesForOrders(orders);

    const dispatchedStatus = (await this.statusesService.getBySlug(OrderStatus.DISPATCHED))!;
    const now = new Date();
    const dispatchedBy = orders[0]?.createdBy || 'Vendor';

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
              updatedAt: now,
            },
            $push: {
              history: {
                status: dispatchedStatus,
                date: now,
                user: user?.email || 'Vendor',
              },
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
