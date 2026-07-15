import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OrderStatusDocument = OrderStatus & Document;

@Schema({ timestamps: true })
export class OrderStatus {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug: string;

  @Prop({ required: true, trim: true })
  displayName: string;

  @Prop({ required: true, trim: true })
  nameEn: string;

  @Prop({ required: true, trim: true })
  nameFr: string;

  @Prop({ required: true, trim: true })
  nameAr: string;

  @Prop({ required: true })
  color: string;

  @Prop({ default: 0 })
  sortOrder: number;
}

export const OrderStatusSchema = SchemaFactory.createForClass(OrderStatus);
