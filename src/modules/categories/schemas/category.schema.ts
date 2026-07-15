import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CategoryDocument = Category & Document;

@Schema({ timestamps: true })
export class Category {
  @Prop({ required: true, trim: true })
  nameEn: string;

  @Prop({ required: true, trim: true })
  nameAr: string;

  @Prop({ required: true, trim: true })
  nameFr: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug: string;
}

export const CategorySchema = SchemaFactory.createForClass(Category);
