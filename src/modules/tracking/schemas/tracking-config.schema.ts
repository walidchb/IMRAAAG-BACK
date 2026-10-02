import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TrackingConfigDocument = TrackingConfig & Document;

@Schema({ timestamps: true })
export class TrackingConfig {
  /**
   * @deprecated Migration shim — use `storeId`. **Nothing reads this field**; it is only
   * written, to satisfy the unique index while `PLAN_STORE_ID_MIGRATION.md` Phase 5 is
   * blocked. Phase 5 removes this field, this `unique` index, and the write in
   * `TrackingService.updateConfig`. Do not add a read filter on it: filtering by
   * `vendorEmail` while `storeId` is the canonical key is the bug behind F5 (E11000 on
   * email change).
   */
  @Prop({ required: true, unique: true })
  vendorEmail: string;

  /** Canonical owner reference and the key every read and write selects on. */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId?: Types.ObjectId;

  /** Meta Pixel ID (browser pixel only — no access token is stored, see D2 in PLAN_PIXELS_MODULE.md) */
  @Prop({ type: String, default: null })
  metaPixelId: string | null;

  @Prop({ type: Boolean, default: false })
  metaPixelEnabled: boolean;

  /** TikTok Pixel ID (browser pixel only — no access token is stored, see D2 in PLAN_PIXELS_MODULE.md) */
  @Prop({ type: String, default: null })
  tikTokPixelId: string | null;

  @Prop({ type: Boolean, default: false })
  tikTokPixelEnabled: boolean;
}

export const TrackingConfigSchema = SchemaFactory.createForClass(TrackingConfig);

TrackingConfigSchema.index({ storeId: 1 }, { unique: true, sparse: true });
