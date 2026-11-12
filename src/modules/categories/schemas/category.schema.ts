import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CategoryDocument = Category & Document;

@Schema({ timestamps: true })
export class Category {
  /**
   * Owning store. Optional at the schema level for legacy rows that predate the
   * store-owned taxonomy; every write through `CategoriesService` sets it.
   */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  nameEn: string;

  @Prop({ required: true, trim: true })
  nameAr: string;

  @Prop({ required: true, trim: true })
  nameFr: string;

  @Prop({ required: true, lowercase: true, trim: true })
  slug: string;

  @Prop({ type: String, default: null })
  image?: string | null;

  @Prop({ default: true })
  isPublished: boolean;

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  deletedBy?: Types.ObjectId;

  /** Original global category id, kept for deterministic migration clone lookup. */
  @Prop({ type: Types.ObjectId })
  legacyId?: Types.ObjectId;
}

export const CategorySchema = SchemaFactory.createForClass(Category);

// Slug is unique per store among non-deleted rows (the global unique index is gone:
// every store needs its own `general` category).
CategorySchema.index(
  { storeId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
CategorySchema.index({ storeId: 1, isDeleted: 1, isPublished: 1 });
CategorySchema.index({ storeId: 1, legacyId: 1 }, { sparse: true });
