import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Store, StoreDocument } from '../../stores/schemas/store.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import {
  StoresService,
  type StoreAdminStatusActor,
} from '../../stores/stores.service';
import { StoreAdminStatus } from '../../stores/schemas/store-status.enum';
import { AdminStoreQueryDto } from './dto/admin-store-query.dto';
import {
  AdminStoreDetailDto,
  AdminStoreListItemDto,
  AdminStoreOwnerDto,
  AdminStoreOwnerSource,
  AdminStoreSource,
  toAdminStoreDetail,
  toAdminStoreListItem,
  toAdminStoreOwner,
} from './mappers/admin-store-response.mapper';

export interface AdminStoreListResult {
  items: AdminStoreListItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AdminStoreDetailResult {
  store: AdminStoreDetailDto;
  owner: AdminStoreOwnerDto | null;
}

export interface AdminStoreStatusResult {
  store: AdminStoreDetailDto;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Safe owner projection. `password` is `select: false` on the schema and is never requested;
 * refresh tokens are deliberately not listed either.
 */
const OWNER_PROJECTION = '_id fullName email phoneNumber role isActive createdAt lastLogin';

@Injectable()
export class AdminStoresService {
  constructor(
    @InjectModel(Store.name) private readonly storeModel: Model<StoreDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly storesService: StoresService,
  ) {}

  async list(query: AdminStoreQueryDto): Promise<AdminStoreListResult> {
    const filter: Record<string, any> = {};
    const and: Record<string, any>[] = [];

    if (query.adminStatus) filter.adminStatus = query.adminStatus;
    if (query.ownerStatus) filter.ownerStatus = query.ownerStatus;
    if (query.wilaya) filter.wilaya = query.wilaya;

    const term = query.search?.trim();
    if (term) {
      const regex = new RegExp(escapeRegex(term), 'i');
      const ownerMatches = (await this.userModel
        .find({ $or: [{ fullName: regex }, { email: regex }, { phoneNumber: regex }] })
        .select('_id email')
        .lean()
        .exec()) as AdminStoreOwnerSource[];

      const storeConditions: Record<string, any>[] = [
        { storeName: regex },
        { storeSlug: regex },
        { subdomain: regex },
        { vendorEmail: regex },
        { contactEmail: regex },
        { contactPhone: regex },
      ];

      if (ownerMatches.length > 0) {
        const objectIds = ownerMatches
          .filter((user) => user._id && Types.ObjectId.isValid(String(user._id)))
          .map((user) => new Types.ObjectId(String(user._id)));
        const stringIds = objectIds.map((id) => String(id));
        const emails = ownerMatches
          .map((user) => user.email)
          .filter((email): email is string => Boolean(email));

        if (objectIds.length > 0) {
          storeConditions.push({ vendorId: { $in: [...objectIds, ...stringIds] } });
        }
        if (emails.length > 0) {
          storeConditions.push({ vendorEmail: { $in: emails } });
        }
      }

      and.push({ $or: storeConditions });
    }

    if (and.length > 0) filter.$and = and;

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const sortField = query.sort === 'storeName' ? 'storeName' : 'createdAt';
    const sortOrder: 1 | -1 = query.order === 'asc' ? 1 : -1;

    const [docs, total] = await Promise.all([
      this.storeModel
        .find(filter)
        .sort({ [sortField]: sortOrder, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.storeModel.countDocuments(filter).exec(),
    ]);

    const stores = docs as unknown as AdminStoreSource[];
    const owners = await this.resolveOwners(stores);
    const items = stores.map((store) =>
      toAdminStoreListItem(store, owners.get(String(store._id)) ?? null),
    );

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async get(id: string): Promise<AdminStoreDetailResult> {
    const store = await this.storesService.findOne(id, { skipStatusCheck: true });
    const source = store as unknown as AdminStoreSource;
    const owners = await this.resolveOwners([source]);
    return {
      store: toAdminStoreDetail(source),
      owner: owners.get(String(source._id)) ?? null,
    };
  }

  /**
   * Admin-controlled suspend/reactivate. `StoresService` owns the atomic write so the
   * owner's decision is never overwritten and the legacy mirror is recomputed consistently.
   */
  async updateStatus(
    id: string,
    adminStatus: StoreAdminStatus.ACTIVE | StoreAdminStatus.SUSPENDED,
    actor: StoreAdminStatusActor,
    reason?: string,
  ): Promise<AdminStoreStatusResult> {
    const updated = await this.storesService.setAdminStatus(id, {
      adminStatus,
      actor,
      reason: adminStatus === StoreAdminStatus.SUSPENDED ? reason ?? null : null,
    });
    return { store: toAdminStoreDetail(updated as unknown as AdminStoreSource) };
  }

  /** Distinct, non-empty stored wilaya labels (not the territories catalogue). */
  async listWilayas(): Promise<string[]> {
    const values = (await this.storeModel.distinct('wilaya').exec()) as unknown[];
    const seen = new Set<string>();
    const wilayas: string[] = [];
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      wilayas.push(trimmed);
    }
    return wilayas.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Batch owner enrichment for a whole page. Deliberately not a `$lookup`: legacy stores can
   * hold `vendorId` as a BSON **string**, which an ObjectId join would silently miss. The
   * two-step id/email lookup mirrors `StoresService.vendorIdFilter()` tolerance.
   */
  private async resolveOwners(
    stores: AdminStoreSource[],
  ): Promise<Map<string, AdminStoreOwnerDto | null>> {
    const objectIds: Types.ObjectId[] = [];
    const seenIds = new Set<string>();
    for (const store of stores) {
      const raw = (store as { vendorId?: unknown }).vendorId;
      if (!raw) continue;
      const id = String(raw);
      if (Types.ObjectId.isValid(id) && !seenIds.has(id)) {
        seenIds.add(id);
        objectIds.push(new Types.ObjectId(id));
      }
    }

    const ownersById = new Map<string, AdminStoreOwnerSource>();
    if (objectIds.length > 0) {
      const users = (await this.userModel
        .find({ _id: { $in: objectIds } })
        .select(OWNER_PROJECTION)
        .lean()
        .exec()) as AdminStoreOwnerSource[];
      for (const user of users) {
        ownersById.set(String(user._id), user);
      }
    }

    const unresolvedEmails: string[] = [];
    const seenEmails = new Set<string>();
    for (const store of stores) {
      const raw = (store as { vendorId?: unknown }).vendorId;
      if (raw && ownersById.has(String(raw))) continue;
      const email = typeof store.vendorEmail === 'string' ? store.vendorEmail.trim().toLowerCase() : '';
      if (email && !seenEmails.has(email)) {
        seenEmails.add(email);
        unresolvedEmails.push(email);
      }
    }

    const ownersByEmail = new Map<string, AdminStoreOwnerSource>();
    if (unresolvedEmails.length > 0) {
      const users = (await this.userModel
        .find({ email: { $in: unresolvedEmails } })
        .select(OWNER_PROJECTION)
        .lean()
        .exec()) as AdminStoreOwnerSource[];
      for (const user of users) {
        if (typeof user.email === 'string') {
          ownersByEmail.set(user.email.trim().toLowerCase(), user);
        }
      }
    }

    const result = new Map<string, AdminStoreOwnerDto | null>();
    for (const store of stores) {
      const raw = (store as { vendorId?: unknown }).vendorId;
      const byId = raw ? ownersById.get(String(raw)) : undefined;
      const email = typeof store.vendorEmail === 'string' ? store.vendorEmail.trim().toLowerCase() : '';
      const user = byId ?? (email ? ownersByEmail.get(email) : undefined);
      result.set(String(store._id), toAdminStoreOwner(user));
    }
    return result;
  }
}
