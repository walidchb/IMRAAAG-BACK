import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CommuneDocument = Commune & Document;

@Schema({ timestamps: true })
export class Commune {
  @Prop({ required: true })
  post_code: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  ar_name: string;

  @Prop()
  longitude: string;

  @Prop()
  latitude: string;

  @Prop({ required: true })
  wilaya_code: string;

  @Prop()
  zrexpress_uuid: string;

  @Prop()
  yalidine_uuid: string;

  @Prop()
  noestexpress_uuid: string;

  @Prop()
  ecomdelivery_uuid: string;
}

export const CommuneSchema = SchemaFactory.createForClass(Commune);

CommuneSchema.index({ wilaya_code: 1, name: 1 });
