import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TrackingConfigDocument = TrackingConfig & Document;

@Schema({ timestamps: true })
export class TrackingConfig {
  /**
   * Prototype migration shim — use `storeId` as the canonical owner reference. This field is
   * written but is **not** read as the selection key anywhere in the normal path; it exists
   * only to satisfy the unique index while `PLAN_STORE_ID_MIGRATION.md` Phase 5 is blocked.
   * The unique `vendorEmail_1` index and this write are removed together with the field when
   * Phase 5 lands. Do **not** add any read filter on it: selecting by `vendorEmail` while
   * `storeId` is canonical is the F5/E11000 bug.
   */
  @Prop({ required: true, unique: true })
  vendorEmail: string;

  /** Canonical owner reference and the key every read and write selects on. */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId?: Types.ObjectId;

  /** @deprecated Use `storeId` instead */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId_vendorEmail?: Types.ObjectId;

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

TrackingConfigSchema.index({ vendorId: 1, storeId: 1 }, { unique: true, sparse: true });

/** @deprecated Use `storeId` on the tracking config instead */
TrackingConfigSchema.index({ vendorEmail: 1, storeId: 1 }, { unique: true, sparse: true });
