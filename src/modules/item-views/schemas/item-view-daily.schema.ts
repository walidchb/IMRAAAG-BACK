import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export type ItemViewDailyDocument = ItemViewDaily & Document;

/**
 * One aggregate row per `(storeId, itemType, itemId, Algiers day, visitorHash)`.
 *
 * `SchemaTypes.ObjectId` is deliberate: `Types.ObjectId` compiles to a `Mixed` path in this
 * Mongoose build, which silently disables casting and breaks tenant-scoped comparisons. The
 * unique index is the dedupe key *and* the concurrency guard for a first insert.
 *
 * Never stored here: `vendorEmail`, raw IP/UA/referrer/session id/name. Only the salted,
 * truncated `visitorHash` is persisted.
 */
@Schema({ collection: 'itemviewdaily', timestamps: true })
export class ItemViewDaily {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Store', required: true })
  storeId: Types.ObjectId;

  @Prop({ type: String, enum: ['product', 'box'], required: true })
  itemType: 'product' | 'box';

  @Prop({ type: SchemaTypes.ObjectId, required: true })
  itemId: Types.ObjectId;

  /** Algiers midnight of the counted day, expressed as the UTC instant. */
  @Prop({ type: Date, required: true })
  dayStart: Date;

  /** `sha256(salt + ':' + visitorId).slice(0, 32)`. Never reversible to a person. */
  @Prop({ type: String, required: true })
  visitorHash: string;

  @Prop({ type: Number, default: 1, min: 1 })
  views: number;

  @Prop({ type: Date, required: true })
  firstViewedAt: Date;

  @Prop({ type: Date, required: true })
  lastViewedAt: Date;
}

export const ItemViewDailySchema = SchemaFactory.createForClass(ItemViewDaily);

// Dedupe key + per-item range reads.
ItemViewDailySchema.index(
  { storeId: 1, itemType: 1, itemId: 1, dayStart: 1, visitorHash: 1 },
  { unique: true },
);
// All-items range/summary scans with the hash in the index.
ItemViewDailySchema.index({ storeId: 1, dayStart: 1, itemType: 1, itemId: 1, visitorHash: 1 });
