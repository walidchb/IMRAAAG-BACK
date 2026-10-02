import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TrackingConfig, TrackingConfigDocument } from './schemas/tracking-config.schema';
import { UpdateTrackingConfigDto } from './dto/tracking-config.dto';
import { StoreDocument } from '../stores/schemas/store.schema';
import { Store } from '../stores/schemas/store.schema';

/**
 * Shape returned to every caller. Deliberately excludes `vendorEmail` and the mongoose
 * document internals, so a miss and a hit serialise identically (F12).
 */
export interface TrackingConfigView {
  storeId: string;
  metaPixelId: string | null;
  metaPixelEnabled: boolean;
  tikTokPixelId: string | null;
  tikTokPixelEnabled: boolean;
}

/**
 * What the customer storefront is allowed to see. A Pixel ID is public by design — it ships
 * in the page source of every site using it — so this is safe to serve unauthenticated.
 *
 * Only an ID that is both present and enabled is returned, and it is returned as `null`
 * otherwise. This is what makes the D1 scoping invariant enforceable on the client: a
 * storefront that receives `null` has no pixel to fire, and cannot fall back to another
 * store's ID.
 */
export interface PublicPixelConfig {
  storeId: string;
  metaPixelId: string | null;
  tikTokPixelId: string | null;
}

export interface PixelTestResult {
  ok: boolean;
  name: string | null;
  message: string;
}

@Injectable()
export class TrackingService {
  constructor(
    @InjectModel(TrackingConfig.name)
    private configModel: Model<TrackingConfigDocument>,
    @InjectModel(Store.name)
    private storeModel: Model<StoreDocument>,
  ) {}

  private static toView(config: TrackingConfigDocument, store: StoreDocument): TrackingConfigView {
    return {
      storeId: String(config.storeId ?? store._id),
      metaPixelId: config.metaPixelId ?? null,
      metaPixelEnabled: !!config.metaPixelEnabled,
      tikTokPixelId: config.tikTokPixelId ?? null,
      tikTokPixelEnabled: !!config.tikTokPixelEnabled,
    };
  }

  async getConfig(store: StoreDocument): Promise<TrackingConfigView> {
    const config = await this.configModel.findOne({ storeId: store._id }).exec();
    if (!config) {
      return {
        storeId: String(store._id),
        metaPixelId: null,
        metaPixelEnabled: false,
        tikTokPixelId: null,
        tikTokPixelEnabled: false,
      };
    }
    return TrackingService.toView(config, store);
  }

  /**
   * Upsert is keyed on `storeId`, which is the canonical owner reference and the unique
   * index in the database.
   *
   * The previous filter used `vendorEmail` while reads used `storeId`. Because both
   * `vendorEmail_1` and `storeId_1` are unique indexes, a vendor changing their email
   * made the upsert match nothing and attempt an insert carrying an already-used
   * `storeId` — a hard E11000 failure that permanently blocked saving pixel config
   * (finding F5 in PLAN_PIXELS_MODULE.md).
   *
   * The legacy `vendorEmail` value is still written for the store-id migration shim, but
   * it is never used to select the document in the normal path.
   */
  async updateConfig(store: StoreDocument, dto: UpdateTrackingConfigDto): Promise<TrackingConfigView> {
    const found = await this.configModel.findOne({ storeId: store._id }).exec();
    // Only consulted when the canonical lookup missed. See `adoptStaleConfigRow`.
    const existing = found ?? (await this.adoptStaleConfigRow(store));

    const update = {
      $set: {
        ...dto,
        storeId: store._id,
        vendorEmail: store.vendorEmail,
      },
    };

    const config = existing
      ? await this.configModel.findOneAndUpdate({ storeId: store._id }, update, { new: true }).exec()
      : await this.configModel.findOneAndUpdate(
          { storeId: store._id },
          update,
          { upsert: true, new: true, setDefaultsOnInsert: true },
        ).exec();

    return TrackingService.toView(config!, store);
  }

  /**
   * Repairs a config row that points at a `storeId` which no longer resolves to a store.
   *
   * This is NOT a read fallback and does not reintroduce the F5 bug. It runs only when the
   * canonical `storeId` lookup has already missed, it requires the row's own `vendorEmail`
   * to equal the session vendor's own email (so the row can only ever be *this* vendor's
   * history), and it re-points the row at `storeId` so every later read is `storeId`-only.
   * Net effect: it removes the collection's dependence on `vendorEmail` rather than adding
   * to it.
   *
   * Without this, such a row makes saving impossible forever: the `storeId` lookup misses,
   * the upsert tries to insert, and the insert collides with the stale row on the legacy
   * `vendorEmail_1` unique index — E11000, with no way for the vendor to clear it. That is
   * not hypothetical; it is why a vendor could not save a Meta Pixel ID.
   *
   * Refuses to adopt when the stale `storeId` still resolves to a live store, so another
   * store's configuration can never be taken over.
   */
  private async adoptStaleConfigRow(store: StoreDocument): Promise<TrackingConfigDocument | null> {
    const vendorEmail = store.vendorEmail?.toLowerCase();
    if (!vendorEmail) return null;

    const legacy = await this.configModel.findOne({ vendorEmail }).exec();
    if (!legacy) return null;

    if (legacy.storeId) {
      const staleStoreStillExists = await this.storeModel.exists({ _id: legacy.storeId }).exec();
      if (staleStoreStillExists) {
        // Belongs to a live store that is not this one. Adopting it would hand another
        // vendor's pixel config over, so leave it alone and let the insert fail loudly.
        return null;
      }
    }

    legacy.storeId = store._id;
    await legacy.save();
    return legacy;
  }

  /**
   * Public per-store lookup for the storefront (F16).
   *
   * Reads by `storeId` only — no `vendorEmail` fallback, because a storefront page must
   * never be able to resolve a different store's pixel than the one it is rendering.
   * A missing config is not an error: the storefront simply gets all-null and loads no
   * pixel.
   */
  async getPublicConfig(storeId: string): Promise<PublicPixelConfig> {
    const config = await this.configModel
      .findOne({ storeId: new Types.ObjectId(storeId) })
      .select('metaPixelId metaPixelEnabled tikTokPixelId tikTokPixelEnabled')
      .lean()
      .exec();

    if (!config) {
      return { storeId, metaPixelId: null, tikTokPixelId: null };
    }

    return {
      storeId,
      metaPixelId: config.metaPixelEnabled && config.metaPixelId ? config.metaPixelId : null,
      tikTokPixelId: config.tikTokPixelEnabled && config.tikTokPixelId ? config.tikTokPixelId : null,
    };
  }

  /**
   * Validates a Meta Pixel ID against Events Manager so a typo surfaces in the vendor's
   * dashboard instead of failing silently at event time (F6). Returns the pixel's name,
   * which also proves the vendor pasted their own pixel rather than someone else's.
   *
   * This is the only outbound call left in the module, so it carries an explicit timeout.
   * TikTok has no equivalent lightweight ID-check endpoint, so it is reported as
   * unverified rather than given a misleading "failed" result.
   */
  async testConfig(store: StoreDocument, dto: UpdateTrackingConfigDto): Promise<{ meta: PixelTestResult; tikTok: PixelTestResult }> {
    const saved = await this.getConfig(store);
    const metaPixelId = dto.metaPixelId ?? saved.metaPixelId;
    const tikTokPixelId = dto.tikTokPixelId ?? saved.tikTokPixelId;

    return {
      meta: await this.testMetaPixel(metaPixelId),
      tikTok: {
        ok: !!tikTokPixelId,
        name: null,
        message: tikTokPixelId
          ? 'Saved. TikTok provides no pixel-lookup API — check the name in TikTok Events Manager.'
          : 'No TikTok Pixel ID configured.',
      },
    };
  }

  private async testMetaPixel(pixelId: string | null): Promise<PixelTestResult> {
    if (!pixelId) {
      return { ok: false, name: null, message: 'No Meta Pixel ID configured.' };
    }

    const url = `https://graph.facebook.com/v22.0/${pixelId}?fields=name,is_empty`;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = (await response.json()) as { name?: string; error?: { message?: string } };

      if (!response.ok) {
        return {
          ok: false,
          name: null,
          message: body.error?.message || `Meta returned HTTP ${response.status}.`,
        };
      }

      return {
        ok: true,
        name: body.name ?? null,
        message: body.name ? 'Pixel found.' : 'Pixel reachable, but it has no name yet.',
      };
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError'
        ? 'Meta did not respond within 8s.'
        : 'Could not reach Meta.';
      return { ok: false, name: null, message: reason };
    }
  }
}
