import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SavedProductDocument = SavedProduct & Document;

@Schema({ timestamps: true })
export class SavedProduct {
  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  userId: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Product' })
  productId: Types.ObjectId;
}

export const SavedProductSchema = SchemaFactory.createForClass(SavedProduct);

SavedProductSchema.index({ userId: 1, productId: 1 }, { unique: true });
