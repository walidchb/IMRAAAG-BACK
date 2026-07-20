import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Store, StoreDocument } from './schemas/store.schema';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';

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
  constructor(
    @InjectModel(Store.name) private storeModel: Model<StoreDocument>,
  ) {}

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  async create(createStoreDto: CreateStoreDto): Promise<Store> {
    const vendorEmail = createStoreDto.vendorEmail?.toLowerCase();
    if (!vendorEmail) {
      throw new BadRequestException('vendorEmail is required');
    }

    const existingVendor = await this.storeModel.findOne({ vendorEmail }).exec();
    if (existingVendor) {
      throw new ConflictException('A store already exists for this vendor email');
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
    isActive?: string;
    isVerified?: string;
    search?: string;
    limit?: number;
    cursor?: string;
  }): Promise<CursorPaginatedStoresResult> {
    const filter: Record<string, any> = {};

    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
    if (query.isVerified !== undefined) filter.isVerified = query.isVerified === 'true';

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
        { 'address.city': regex },
        { 'address.street': regex },
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

  async findOne(id: string): Promise<Store> {
    const store = await this.storeModel.findById(id).exec();
    if (!store) throw new NotFoundException(`Store ${id} not found`);
    return store;
  }

  async findBySlug(slug: string): Promise<Store> {
    const store = await this.storeModel.findOne({ storeSlug: slug }).exec();
    if (!store) throw new NotFoundException(`Store with slug "${slug}" not found`);
    return store;
  }

  async findByVendor(vendorId: string): Promise<Store> {
    const store = await this.storeModel.findOne({ vendorId }).exec();
    if (!store) throw new NotFoundException(`Store for vendor ${vendorId} not found`);
    return store;
  }

  async findByEmail(email: string): Promise<Store> {
    const store = await this.storeModel.findOne({ vendorEmail: email.toLowerCase() }).exec();
    if (!store) throw new NotFoundException(`Store for vendor ${email} not found`);
    return store;
  }

  async update(id: string, updateStoreDto: UpdateStoreDto): Promise<Store> {
    const existing = await this.storeModel.findById(id).exec();
    if (!existing) throw new NotFoundException(`Store ${id} not found`);

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
    if (updateStoreDto.isActive !== undefined) updateData.isActive = updateStoreDto.isActive;
    if (updateStoreDto.isVerified !== undefined) updateData.isVerified = updateStoreDto.isVerified;

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

    if (!updated) throw new NotFoundException(`Store ${id} not found`);
    return updated;
  }

  async toggleStatus(id: string): Promise<Store> {
    const store = await this.storeModel.findById(id).exec();
    if (!store) throw new NotFoundException(`Store ${id} not found`);

    store.status = store.status === 'Active' ? 'Paused' : 'Active';
    return store.save();
  }

  async findAllRaw(filter: Record<string, any>): Promise<Store[]> {
    return this.storeModel.find(filter).sort({ createdAt: -1 }).limit(50).exec();
  }

  async remove(id: string): Promise<void> {
    const result = await this.storeModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Store ${id} not found`);
  }
}
