import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SubCategoryDocument = SubCategory & Document;

@Schema({ timestamps: true })
export class SubCategory {
  /** Owning store. Mirrors the parent's store on every write. */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Category', required: true })
  categoryId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  nameEn: string;

  @Prop({ required: true, trim: true })
  nameAr: string;

  @Prop({ required: true, trim: true })
  nameFr: string;

  @Prop({ required: true, lowercase: true, trim: true })
  slug: string;

  @Prop({ default: true })
  isPublished: boolean;

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  deletedBy?: Types.ObjectId;

  /** Original global subcategory id, kept for deterministic migration clone lookup. */
  @Prop({ type: Types.ObjectId })
  legacyId?: Types.ObjectId;
}

export const SubCategorySchema = SchemaFactory.createForClass(SubCategory);

SubCategorySchema.index(
  { storeId: 1, categoryId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
SubCategorySchema.index({ storeId: 1, categoryId: 1, isDeleted: 1, isPublished: 1 });
SubCategorySchema.index({ storeId: 1, legacyId: 1 }, { sparse: true });
