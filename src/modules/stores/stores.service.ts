import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Store, StoreDocument } from './schemas/store.schema';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import { StoreStatus } from './schemas/store-status.enum';
import { UploadService } from '../upload/upload.service';

export interface CursorDto {
  createdAt: string;
  _id: string;
}

export interface CursorPaginatedStoresResult {
  stores: Store[];
  nextCursor: CursorDto | null;
  hasMore: boolean;
}

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);
  constructor(
    @InjectModel(Store.name) private storeModel: Model<StoreDocument>,
    private readonly uploadService: UploadService,
  ) {}

  private slugify(name: string): string {
    let slug = name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) {
      slug = `store-${Date.now()}`;
    }
    return slug;
  }

  async create(createStoreDto: CreateStoreDto): Promise<Store> {
    const vendorEmail = createStoreDto.vendorEmail?.toLowerCase();
    if (!vendorEmail) {
      throw new AppException(AppErrorCode.STORE_VENDOR_EMAIL_REQUIRED);
    }

    const existingVendor = await this.storeModel.findOne({ vendorEmail }).exec();
    if (existingVendor) {
      throw new AppException(AppErrorCode.STORE_ALREADY_EXISTS);
    }

    let storeSlug = createStoreDto.storeSlug || this.slugify(createStoreDto.storeName);
    const existingSlug = await this.storeModel.findOne({ storeSlug }).exec();
    if (existingSlug) {
      storeSlug = `${storeSlug}-${Date.now()}`;
    }

    const created = new this.storeModel({
      ...createStoreDto,
      vendorEmail,
      storeSlug,
    });

    return created.save();
  }

  async findAll(query: {
    search?: string;
    limit?: number;
    cursor?: string;
  }): Promise<CursorPaginatedStoresResult> {
    const filter: Record<string, any> = { status: StoreStatus.ACTIVE };

    const limit = query.limit || 10;

    let cursorObj: CursorDto | null = null;
    if (query.cursor) {
      try { cursorObj = JSON.parse(query.cursor); } catch {}
    }

    let searchFilter: Record<string, any>;

    if (query.search) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = { $regex: escaped, $options: 'i' };

      const orConditions = [
        { storeName: regex },
        { storeSlug: regex },
        { description: regex },
        { tagline: regex },
        { vendorEmail: regex },
        { contactEmail: regex },
        { contactPhone: regex },
        { wilaya: regex },
      ];

      const andConditions: Record<string, any>[] = [filter, { $or: orConditions }];

      if (cursorObj && cursorObj.createdAt && cursorObj._id) {
        andConditions.push({
          $or: [
            { createdAt: { $lt: new Date(cursorObj.createdAt) } },
            { createdAt: new Date(cursorObj.createdAt), _id: { $lt: new Types.ObjectId(cursorObj._id) } },
          ],
        });
      }

      searchFilter = { $and: andConditions };
    } else {
      searchFilter = { ...filter };

      if (cursorObj && cursorObj.createdAt && cursorObj._id) {
        searchFilter.$or = [
          { createdAt: { $lt: new Date(cursorObj.createdAt) } },
          { createdAt: new Date(cursorObj.createdAt), _id: { $lt: new Types.ObjectId(cursorObj._id) } },
        ];
      }
    }

    const items = await this.storeModel
      .find(searchFilter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .exec();

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

    let nextCursor: CursorDto | null = null;
    if (items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = {
        createdAt: (last as any).createdAt instanceof Date
          ? (last as any).createdAt.toISOString()
          : String((last as any).createdAt),
        _id: String(last._id),
      };
    }

    return { stores: items as Store[], nextCursor, hasMore };
  }

  async findOne(id: string, opts?: { skipStatusCheck?: boolean }): Promise<Store> {
    const store = await this.storeModel.findById(id).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });
    if (!opts?.skipStatusCheck && store.status !== StoreStatus.ACTIVE) {
      throw new AppException(AppErrorCode.STORE_NOT_ACTIVE, { id });
    }
    return store;
  }

  async findBySlug(slug: string, opts?: { skipStatusCheck?: boolean }): Promise<Store> {
    const store = await this.storeModel.findOne({ storeSlug: slug }).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'slug', value: slug });
    if (!opts?.skipStatusCheck && store.status !== StoreStatus.ACTIVE) {
      throw new AppException(AppErrorCode.STORE_NOT_ACTIVE, { slug });
    }
    return store;
  }

  async findByVendor(vendorId: string, opts?: { skipStatusCheck?: boolean }): Promise<Store> {
    const store = await this.storeModel.findOne({ vendorId }).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'vendorId', value: vendorId });
    if (!opts?.skipStatusCheck && store.status !== StoreStatus.ACTIVE) {
      throw new AppException(AppErrorCode.STORE_NOT_ACTIVE, { vendorId });
    }
    return store;
  }

  async findByEmail(email: string, opts?: { skipStatusCheck?: boolean }): Promise<Store> {
    const store = await this.storeModel.findOne({ vendorEmail: email.toLowerCase() }).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'email', value: email });
    if (!opts?.skipStatusCheck && store.status !== StoreStatus.ACTIVE) {
      throw new AppException(AppErrorCode.STORE_NOT_ACTIVE, { email });
    }
    return store;
  }

  async update(id: string, updateStoreDto: UpdateStoreDto): Promise<Store> {
    const existing = await this.storeModel.findById(id).exec();
    if (!existing) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });

    const updateData: Record<string, any> = {};

    if (updateStoreDto.storeName !== undefined) updateData.storeName = updateStoreDto.storeName;
    if (updateStoreDto.description !== undefined) updateData.description = updateStoreDto.description;
    if (updateStoreDto.contactEmail !== undefined) updateData.contactEmail = updateStoreDto.contactEmail;
    if (updateStoreDto.contactPhone !== undefined) updateData.contactPhone = updateStoreDto.contactPhone;
    if (updateStoreDto.contactPhones !== undefined) updateData.contactPhones = updateStoreDto.contactPhones;
    if (updateStoreDto.commune !== undefined) updateData.commune = updateStoreDto.commune;
    if (updateStoreDto.socialMedia !== undefined) updateData.socialMedia = updateStoreDto.socialMedia;
    if (updateStoreDto.status !== undefined) updateData.status = updateStoreDto.status;
    if (updateStoreDto.storeLogo !== undefined) updateData.storeLogo = updateStoreDto.storeLogo;
    if (updateStoreDto.coverImage !== undefined) updateData.coverImage = updateStoreDto.coverImage;
    if (updateStoreDto.wilaya !== undefined) updateData.wilaya = updateStoreDto.wilaya;
    if (updateStoreDto.categories !== undefined) updateData.categories = updateStoreDto.categories;
    if (updateStoreDto.tagline !== undefined) updateData.tagline = updateStoreDto.tagline;

    if (updateStoreDto.storeName) {
      let storeSlug = this.slugify(updateStoreDto.storeName);
      const slugConflict = await this.storeModel.findOne({
        storeSlug,
        _id: { $ne: id },
      }).exec();
      if (slugConflict) {
        storeSlug = `${storeSlug}-${Date.now()}`;
      }
      updateData.storeSlug = storeSlug;
    }

    const updated = await this.storeModel
      .findByIdAndUpdate(id, updateData, { returnDocument: 'after' })
      .exec();

    if (!updated) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });

    // Clean up old images from R2 when replaced
    if (updateStoreDto.storeLogo !== undefined && existing.storeLogo && existing.storeLogo !== updateStoreDto.storeLogo) {
      const oldKey = this.uploadService.extractKeyFromUrl(existing.storeLogo);
      if (oldKey) {
        await this.uploadService.deleteFile(oldKey).catch((err) =>
          this.logger.warn(`Failed to delete old store logo: ${err.message}`),
        );
      }
    }
    if (updateStoreDto.coverImage !== undefined && existing.coverImage && existing.coverImage !== updateStoreDto.coverImage) {
      const oldKey = this.uploadService.extractKeyFromUrl(existing.coverImage);
      if (oldKey) {
        await this.uploadService.deleteFile(oldKey).catch((err) =>
          this.logger.warn(`Failed to delete old store cover: ${err.message}`),
        );
      }
    }

    return updated;
  }

  async toggleStatus(id: string): Promise<Store> {
    const store = await this.storeModel.findById(id).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });

    const newStatus = store.status === StoreStatus.ACTIVE ? StoreStatus.PAUSED : StoreStatus.ACTIVE;
    const updated = await this.storeModel.findByIdAndUpdate(
      id,
      { status: newStatus },
      { returnDocument: 'after' }
    ).exec();

    if (!updated) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });
    return updated;
  }

  async findAllRaw(filter: Record<string, any>): Promise<Store[]> {
    return this.storeModel.find(filter).sort({ createdAt: -1 }).limit(50).exec();
  }

  async incrementProductCount(vendorEmail: string, delta = 1): Promise<void> {
    await this.storeModel.updateOne(
      { vendorEmail: vendorEmail.toLowerCase() },
      { $inc: { totalProducts: delta } },
    ).exec();
  }

  async incrementOrderCount(vendorEmail: string, delta = 1): Promise<void> {
    await this.storeModel.updateOne(
      { vendorEmail: vendorEmail.toLowerCase() },
      { $inc: { totalOrders: delta } },
    ).exec();
  }

  async remove(id: string): Promise<void> {
    const result = await this.storeModel.findByIdAndDelete(id).exec();
    if (!result) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });

    // Clean up store images from R2
    const imageKeys = [result.storeLogo, result.coverImage]
      .map((u) => this.uploadService.extractKeyFromUrl(u))
      .filter(Boolean) as string[];
    if (imageKeys.length > 0) {
      await this.uploadService.deleteFiles(imageKeys).catch((err) => {
        this.logger.warn(`Failed to delete store images: ${err.message}`);
      });
    }
  }
}
