import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WilayaDocument = Wilaya & Document;

@Schema({ timestamps: true })
export class Wilaya {
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  ar_name: string;

  @Prop()
  longitude: string;

  @Prop()
  latitude: string;

  @Prop()
  zrexpress_uuid: string;

  @Prop()
  yalidine_uuid: string;

  @Prop()
  noestexpress_uuid: string;

  @Prop()
  ecomdelivery_uuid: string;
}

export const WilayaSchema = SchemaFactory.createForClass(Wilaya);

WilayaSchema.index({ code: 1 });
