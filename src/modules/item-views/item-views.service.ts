import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { Model, Types } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Role } from '../../common/constants/roles.enum';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Box, BoxDocument } from '../boxes/schemas/box.schema';
import { StoresService } from '../stores/stores.service';
import {
  resolveViewRange,
  startOfDayInTz,
  TZ_OFFSET_MS,
} from '../analytics/lib/date-range';
import { TrackItemViewDto } from './dto/track-item-view.dto';
import { ItemViewQueryDto } from './dto/item-view-query.dto';
import {
  ItemViewDaily,
  ItemViewDailyDocument,
} from './schemas/item-view-daily.schema';
import {
  isIgnoredUserAgent,
  ITEM_VIEW_HASH_LENGTH,
} from './item-view.constants';

export interface TrackItemViewContext {
  ip?: string;
  userAgent?: string;
  authorization?: string;
}

interface ItemViewsConfig {
  enabled?: boolean;
  hashSalt?: string;
  retentionDays?: number;
}

interface TypeTotals {
  views: number;
  uniqueVisitors: number;
  itemsViewed: number;
}

const ZERO_TOTALS = (): TypeTotals => ({ views: 0, uniqueVisitors: 0, itemsViewed: 0 });

const round = (value: number, dp: number): number => {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
};

/** `YYYY-MM-DD` of the Algiers calendar day a UTC `dayStart` instant belongs to. */
const algiersDayKey = (dayStart: Date): string =>
  new Date(dayStart.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);

export interface ItemViewSummaryResponse {
  preset: string;
  from: Date;
  to: Date;
  timezone: string;
  type: 'all' | 'product' | 'box';
  enabled: boolean;
  totalViews: number;
  uniqueVisitors: number;
  itemsViewed: number;
  viewsPerVisitor: number;
  byType: { product: TypeTotals; box: TypeTotals };
}

export interface ItemViewRow {
  itemType: 'product' | 'box';
  itemId: string;
  deleted: boolean;
  name: { en: string; fr: string; ar: string } | null;
  image: string | null;
  slug: string | null;
  published: boolean | null;
  isArchived: boolean | null;
  views: number;
  uniqueVisitors: number;
  share: number;
}

/**
 * Product & Box view analytics.
 *
 * The write path is deliberately best-effort: the beacon always answers 204 and a lookup,
 * hash or upsert failure only logs a warning. The store is **derived from the item**, never
 * from the caller, so a client can never write into another tenant's counters.
 */
@Injectable()
export class ItemViewsService {
  private readonly logger = new Logger(ItemViewsService.name);
  private warnedMissingSalt = false;

  constructor(
    @InjectModel(ItemViewDaily.name)
    private readonly viewModel: Model<ItemViewDailyDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Box.name)
    private readonly boxModel: Model<BoxDocument>,
    private readonly storesService: StoresService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /** Record one view if it is countable. Never throws. */
  async track(dto: TrackItemViewDto, ctx: TrackItemViewContext): Promise<void> {
    try {
      await this.trackInternal(dto, ctx);
    } catch {
      // The beacon is fire-and-forget; a failure must never surface to the shopper. Nothing
      // identifying is logged (no raw visitor id, IP or User-Agent).
      this.logger.warn('Item view tracking skipped after an internal error');
    }
  }

  private async trackInternal(
    dto: TrackItemViewDto,
    ctx: TrackItemViewContext,
  ): Promise<void> {
    if (!this.config().enabled) return;
    if (!Types.ObjectId.isValid(dto.itemId)) return;
    if (isIgnoredUserAgent(ctx.userAgent)) return;

    const itemId = new Types.ObjectId(String(dto.itemId));
    const item = await this.findPublicItem(dto.itemType, itemId);
    if (!item?.storeId) return;

    const storeId = new Types.ObjectId(String(item.storeId));
    if (await this.isSelfView(ctx.authorization, storeId)) return;

    const now = new Date();
    const dayStart = startOfDayInTz(now);
    const visitorHash = this.hashVisitor(
      dto.visitorId,
      ctx.ip,
      ctx.userAgent,
    );

    const key = {
      storeId,
      itemType: dto.itemType,
      itemId,
      dayStart,
      visitorHash,
    };

    // One row per visitor + item + Algiers day. Every counted visit increments `views`;
    // uniqueness is enforced by the row key (and its unique index), never by suppressing
    // the increment, so total views and unique visitors are independent figures.
    await this.incrementView(key, now);
  }

  /**
   * Increment a visitor-day row, creating it on first sight. The unique index is the
   * concurrency guard: a request that loses a first-insert race retries as a plain
   * increment, so every valid visit is still counted exactly once.
   */
  private async incrementView(
    key: {
      storeId: Types.ObjectId;
      itemType: 'product' | 'box';
      itemId: Types.ObjectId;
      dayStart: Date;
      visitorHash: string;
    },
    now: Date,
  ): Promise<void> {
    try {
      await this.viewModel.updateOne(
        key,
        {
          $inc: { views: 1 },
          $set: { lastViewedAt: now },
          $setOnInsert: { firstViewedAt: now },
        },
        { upsert: true },
      );
    } catch (error) {
      // A concurrent first insert won the unique key; the row now exists, so retry the
      // increment without an upsert instead of dropping this visit.
      if ((error as { code?: number })?.code !== 11000) throw error;
      await this.viewModel.updateOne(key, {
        $inc: { views: 1 },
        $set: { lastViewedAt: now },
      });
    }
  }

  /** Only published, non-archived items are countable (V1). */
  private async findPublicItem(
    itemType: 'product' | 'box',
    itemId: Types.ObjectId,
  ): Promise<{ storeId?: Types.ObjectId } | null> {
    const query = {
      _id: itemId,
      published: true,
      isArchived: { $ne: true },
    };
    const model: Model<any> =
      itemType === 'box' ? this.boxModel : this.productModel;
    return model.findOne(query).select('storeId').lean().exec();
  }

  /**
   * Best-effort self-view suppression. The endpoint is public, so an invalid/expired token is
   * treated as anonymous rather than rejected. A vendor whose session resolves to the owning
   * store is not counted; admins are never counted. (A logged-out seller is undetectable.)
   */
  private async isSelfView(
    authorization: string | undefined,
    storeId: Types.ObjectId,
  ): Promise<boolean> {
    const token = this.bearerToken(authorization);
    if (!token) return false;

    let payload: { sub?: string; id?: string; role?: string } | null = null;
    try {
      payload = await this.jwtService.verifyAsync(token);
    } catch {
      return false;
    }
    if (!payload) return false;
    if (payload.role === Role.ADMIN) return true;
    if (payload.role !== Role.VENDOR) return false;

    const userId = payload.sub ?? payload.id;
    if (!userId || !Types.ObjectId.isValid(userId)) return false;
    const store = await this.storesService.findByMemberId(String(userId));
    return !!store && String(store._id) === String(storeId);
  }

  private bearerToken(authorization: string | undefined): string | null {
    if (!authorization) return null;
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return match?.[1]?.trim() || null;
  }

  private hashVisitor(
    visitorId: string | undefined,
    ip: string | undefined,
    userAgent: string | undefined,
  ): string {
    const raw = visitorId
      ? `id:${visitorId}`
      : `anon:${ip ?? ''}:${userAgent ?? ''}`;
    return createHash('sha256')
      .update(`${this.hashSalt()}:${raw}`)
      .digest('hex')
      .slice(0, ITEM_VIEW_HASH_LENGTH);
  }

  /** Salt is `ITEM_VIEW_HASH_SALT`, falling back to `JWT_SECRET` with a one-time warning. */
  private hashSalt(): string {
    const config = this.config();
    if (config.hashSalt) return config.hashSalt;
    if (!this.warnedMissingSalt) {
      this.warnedMissingSalt = true;
      this.logger.warn(
        'ITEM_VIEW_HASH_SALT is unset; falling back to JWT_SECRET. Set a stable salt in production.',
      );
    }
    return this.configService.get<string>('jwt.secret') || '';
  }

  // ────────────────────────────── Vendor reads ──────────────────────────────

  /**
   * KPI summary for the selected window. The all-scope unique count is a distinct count over
   * `visitorHash` across both item kinds — never the sum of the per-type uniques.
   */
  async summary(
    storeId: Types.ObjectId,
    query: ItemViewQueryDto,
  ): Promise<ItemViewSummaryResponse> {
    const range = resolveViewRange(query);
    const type = query.type ?? 'all';
    const enabled = !!this.config().enabled;
    const base = {
      preset: range.preset,
      from: range.from,
      to: range.to,
      timezone: range.timezone,
      type,
      enabled,
    };

    if (!enabled) {
      return {
        ...base,
        totalViews: 0,
        uniqueVisitors: 0,
        itemsViewed: 0,
        viewsPerVisitor: 0,
        byType: { product: ZERO_TOTALS(), box: ZERO_TOTALS() },
      };
    }

    const match: Record<string, unknown> = {
      storeId,
      dayStart: { $gte: range.from, $lt: range.to },
    };
    if (type !== 'all') match.itemType = type;

    const [facet] = await this.viewModel
      .aggregate([
        { $match: match },
        {
          $facet: {
            byType: [
              {
                $group: {
                  _id: '$itemType',
                  views: { $sum: '$views' },
                  items: { $addToSet: '$itemId' },
                },
              },
              { $project: { _id: 0, itemType: '$_id', views: 1, itemsViewed: { $size: '$items' } } },
            ],
            typeUniques: [
              { $group: { _id: { type: '$itemType', hash: '$visitorHash' } } },
              { $group: { _id: '$_id.type', uniqueVisitors: { $sum: 1 } } },
            ],
            allUniques: [{ $group: { _id: '$visitorHash' } }, { $count: 'uniqueVisitors' }],
            allTotal: [{ $group: { _id: null, totalViews: { $sum: '$views' } } }],
          },
        },
      ])
      .option({ allowDiskUse: true });

    const byType = { product: ZERO_TOTALS(), box: ZERO_TOTALS() };
    for (const row of (facet?.byType ?? []) as any[]) {
      if (row.itemType === 'product' || row.itemType === 'box') {
        byType[row.itemType as 'product' | 'box'].views = row.views ?? 0;
        byType[row.itemType as 'product' | 'box'].itemsViewed = row.itemsViewed ?? 0;
      }
    }
    for (const row of (facet?.typeUniques ?? []) as any[]) {
      if (row._id === 'product' || row._id === 'box') {
        byType[row._id as 'product' | 'box'].uniqueVisitors = row.uniqueVisitors ?? 0;
      }
    }

    const totalViews = facet?.allTotal?.[0]?.totalViews ?? 0;
    const uniqueVisitors = facet?.allUniques?.[0]?.uniqueVisitors ?? 0;
    const itemsViewed = byType.product.itemsViewed + byType.box.itemsViewed;

    return {
      ...base,
      totalViews,
      uniqueVisitors,
      itemsViewed,
      viewsPerVisitor: uniqueVisitors ? round(totalViews / uniqueVisitors, 2) : 0,
      byType,
    };
  }

  /** Ranked per-item rows for the selected window, with archive/deleted handling. */
  async items(storeId: Types.ObjectId, query: ItemViewQueryDto) {
    const range = resolveViewRange(query);
    const type = query.type ?? 'all';
    const sort = query.sort ?? 'views';
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const enabled = !!this.config().enabled;
    const base = {
      preset: range.preset,
      from: range.from,
      to: range.to,
      timezone: range.timezone,
      type,
      sort,
      limit,
      offset,
      enabled,
    };

    if (!enabled) {
      return { ...base, total: 0, totalViews: 0, items: [] as ItemViewRow[] };
    }

    const match: Record<string, unknown> = {
      storeId,
      dayStart: { $gte: range.from, $lt: range.to },
    };
    if (type !== 'all') match.itemType = type;

    const [facet] = await this.viewModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: { itemType: '$itemType', itemId: '$itemId', hash: '$visitorHash' },
            views: { $sum: '$views' },
          },
        },
        {
          $group: {
            _id: { itemType: '$_id.itemType', itemId: '$_id.itemId' },
            views: { $sum: '$views' },
            uniqueVisitors: { $sum: 1 },
          },
        },
        {
          $sort:
            sort === 'unique'
              ? { uniqueVisitors: -1, views: -1, '_id.itemId': 1 }
              : { views: -1, uniqueVisitors: -1, '_id.itemId': 1 },
        },
        {
          $facet: {
            rows: [{ $skip: offset }, { $limit: limit }],
            meta: [{ $count: 'total' }],
            totals: [{ $group: { _id: null, totalViews: { $sum: '$views' } } }],
          },
        },
      ])
      .option({ allowDiskUse: true });

    const pageRows = (facet?.rows ?? []) as any[];
    const productIds = pageRows
      .filter((row) => row._id.itemType === 'product')
      .map((row) => row._id.itemId);
    const boxIds = pageRows
      .filter((row) => row._id.itemType === 'box')
      .map((row) => row._id.itemId);

    const [products, boxes] = await Promise.all([
      productIds.length
        ? this.productModel
            .find({ _id: { $in: productIds }, storeId })
            .select('nameEn nameAr nameFr image slug published isArchived')
            .lean()
            .exec()
        : Promise.resolve([] as any[]),
      boxIds.length
        ? this.boxModel
            .find({ _id: { $in: boxIds }, storeId })
            .select('nameEn nameAr nameFr image slug published isArchived')
            .lean()
            .exec()
        : Promise.resolve([] as any[]),
    ]);

    const docs = new Map<string, any>();
    for (const doc of products as any[]) docs.set(`product:${String(doc._id)}`, doc);
    for (const doc of boxes as any[]) docs.set(`box:${String(doc._id)}`, doc);

    const totalViews = facet?.totals?.[0]?.totalViews ?? 0;
    const items: ItemViewRow[] = pageRows.map((row) => {
      const itemType = row._id.itemType as 'product' | 'box';
      const itemId = String(row._id.itemId);
      const doc = docs.get(`${itemType}:${itemId}`);
      return {
        itemType,
        itemId,
        deleted: !doc,
        name: doc
          ? { en: doc.nameEn ?? '', fr: doc.nameFr ?? '', ar: doc.nameAr ?? '' }
          : null,
        image: doc?.image ?? null,
        slug: doc?.slug ?? null,
        published: doc?.published ?? null,
        isArchived: doc?.isArchived ?? null,
        views: row.views ?? 0,
        uniqueVisitors: row.uniqueVisitors ?? 0,
        share: totalViews ? round(((row.views ?? 0) / totalViews) * 100, 1) : 0,
      };
    });

    return {
      ...base,
      total: facet?.meta?.[0]?.total ?? 0,
      totalViews,
      items,
    };
  }

  /** One item's totals (ownership-checked), optionally with a zero-filled daily series. */
  async itemDetail(
    storeId: Types.ObjectId,
    itemType: 'product' | 'box',
    itemIdRaw: string,
    query: ItemViewQueryDto,
  ) {
    const range = resolveViewRange(query);
    const enabled = !!this.config().enabled;
    const itemId = Types.ObjectId.isValid(itemIdRaw)
      ? new Types.ObjectId(String(itemIdRaw))
      : null;
    const model: Model<any> = itemType === 'box' ? this.boxModel : this.productModel;

    const doc = itemId
      ? await model
          .findOne({ _id: itemId, storeId })
          .select('nameEn nameAr nameFr image slug published isArchived')
          .lean()
          .exec()
      : null;

    if (!doc || !itemId) {
      throw new AppException(
        itemType === 'box' ? AppErrorCode.BOX_NOT_FOUND : AppErrorCode.PRODUCT_NOT_FOUND,
        { field: 'itemId', value: String(itemIdRaw) },
      );
    }

    const base = {
      preset: range.preset,
      from: range.from,
      to: range.to,
      timezone: range.timezone,
      enabled,
      itemType,
      itemId: String(itemId),
      deleted: false,
      name: {
        en: (doc as any).nameEn ?? '',
        fr: (doc as any).nameFr ?? '',
        ar: (doc as any).nameAr ?? '',
      },
      image: (doc as any).image ?? null,
      slug: (doc as any).slug ?? null,
      published: (doc as any).published ?? null,
      isArchived: (doc as any).isArchived ?? null,
    };

    if (!enabled) {
      return {
        ...base,
        totalViews: 0,
        uniqueVisitors: 0,
        ...(query.include === 'daily' ? { daily: this.zeroFillDaily(range, []) } : {}),
      };
    }

    const dailyFacet =
      query.include === 'daily'
        ? {
            daily: [
              {
                $group: {
                  _id: { dayStart: '$dayStart', hash: '$visitorHash' },
                  views: { $sum: '$views' },
                },
              },
              {
                $group: {
                  _id: '$_id.dayStart',
                  views: { $sum: '$views' },
                  uniqueVisitors: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
          }
        : {};

    const pipeline: any[] = [
        {
          $match: {
            storeId,
            itemType,
            itemId,
            dayStart: { $gte: range.from, $lt: range.to },
          },
        },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  totalViews: { $sum: '$views' },
                  hashes: { $addToSet: '$visitorHash' },
                },
              },
              { $project: { _id: 0, totalViews: 1, uniqueVisitors: { $size: '$hashes' } } },
            ],
            ...dailyFacet,
          },
        },
      ];

    const [facet] = await this.viewModel
      .aggregate(pipeline)
      .option({ allowDiskUse: true });

    return {
      ...base,
      totalViews: facet?.totals?.[0]?.totalViews ?? 0,
      uniqueVisitors: facet?.totals?.[0]?.uniqueVisitors ?? 0,
      ...(query.include === 'daily'
        ? { daily: this.zeroFillDaily(range, (facet?.daily ?? []) as any[]) }
        : {}),
    };
  }

  /** Zero-fill every Algiers day in the half-open window so a chart never has gaps. */
  private zeroFillDaily(
    range: { from: Date; to: Date },
    rows: any[],
  ): Array<{ date: string; views: number; uniqueVisitors: number }> {
    const byDay = new Map<string, { views: number; uniqueVisitors: number }>();
    for (const row of rows) {
      byDay.set(algiersDayKey(new Date(row._id)), {
        views: row.views ?? 0,
        uniqueVisitors: row.uniqueVisitors ?? 0,
      });
    }

    const series: Array<{ date: string; views: number; uniqueVisitors: number }> = [];
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    for (let t = range.from.getTime(); t < range.to.getTime(); t += MS_PER_DAY) {
      const key = algiersDayKey(new Date(t));
      const day = byDay.get(key);
      series.push({
        date: key,
        views: day?.views ?? 0,
        uniqueVisitors: day?.uniqueVisitors ?? 0,
      });
    }
    return series;
  }

  private config(): ItemViewsConfig {
    return this.configService.get<ItemViewsConfig>('itemViews') ?? {};
  }
}
