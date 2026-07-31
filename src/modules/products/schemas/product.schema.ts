import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true, trim: true })
  vendorEmail: string;

  @Prop({ trim: true })
  vendorId: string;

  @Prop({ required: true, trim: true })
  nameEn: string;

  @Prop({ required: true, trim: true })
  nameAr: string;

  @Prop({ required: true, trim: true })
  nameFr: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug: string;

  @Prop()
  storyEn: string;

  @Prop()
  storyAr: string;

  @Prop()
  storyFr: string;

  @Prop({ type: Types.ObjectId, ref: 'Category', required: true })
  category: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'SubCategory' })
  subCategory: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  originalPrice: number;

  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ required: true, min: 0, default: 0 })
  stock: number;

  @Prop({ required: true, min: 0, default: 1 })
  weight: number;

  @Prop()
  image: string;

  @Prop([String])
  images: string[];

  @Prop({ enum: ['Active', 'Draft'], default: 'Active' })
  status: string;

  @Prop({ default: false })
  published: boolean;

  @Prop({
    type: [{
      nameEn: { type: String },
      nameAr: { type: String },
      nameFr: { type: String },
      type: { type: String, enum: ['generic', 'color'] },
      options: [{
        nameEn: { type: String },
        nameAr: { type: String },
        nameFr: { type: String },
        value: { type: String },
      }]
    }]
  })
  variants: Array<{
    nameEn?: string;
    nameAr?: string;
    nameFr?: string;
    type?: string;
    options?: Array<{
      nameEn?: string;
      nameAr?: string;
      nameFr?: string;
      value?: string;
    }>;
  }>;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ nameEn: 'text', nameAr: 'text', nameFr: 'text', storyEn: 'text', storyAr: 'text', storyFr: 'text' });
ProductSchema.index({ vendorEmail: 1 });
ProductSchema.index({ vendorId: 1 });
ProductSchema.index({ category: 1, subCategory: 1 });
ProductSchema.index({ price: 1 });
ProductSchema.index({ status: 1 });
ProductSchema.index({ published: 1 });
// Cursor pagination indexes
ProductSchema.index({ published: 1, status: 1, createdAt: -1, _id: -1 });
ProductSchema.index({ published: 1, status: 1, category: 1, createdAt: -1, _id: -1 });
ProductSchema.index({ published: 1, status: 1, vendorEmail: 1, createdAt: -1, _id: -1 });
ProductSchema.index({ published: 1, status: 1, price: 1, createdAt: -1, _id: -1 });
