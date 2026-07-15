import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SubCategoryDocument = SubCategory & Document;

@Schema({ timestamps: true })
export class SubCategory {
  @Prop({ type: Types.ObjectId, ref: 'Category', required: true, index: true })
  categoryId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  nameEn: string;

  @Prop({ required: true, trim: true })
  nameAr: string;

  @Prop({ required: true, trim: true })
  nameFr: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug: string;
}

export const SubCategorySchema = SchemaFactory.createForClass(SubCategory);

SubCategorySchema.index({ categoryId: 1 });
