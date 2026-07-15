import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EcomDeskDocument = EcomDesk & Document;

@Schema({ timestamps: true })
export class EcomDesk {
  @Prop({ required: true, unique: true })
  code_stopdesk: string;

  @Prop({ required: true })
  nom_bureau: string;

  @Prop({ required: true })
  wilayaCode: string;

  @Prop()
  commune: string;

  @Prop()
  adresse: string;

  @Prop()
  adresse_maps: string;

  @Prop()
  tel_contact: string;

  @Prop()
  ecomId: number;
}

export const EcomDeskSchema = SchemaFactory.createForClass(EcomDesk);

EcomDeskSchema.index({ wilayaCode: 1 });
