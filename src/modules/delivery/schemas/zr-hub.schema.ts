import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ZrHubDocument = ZrHub & Document;

@Schema({ timestamps: true })
export class ZrHub {
  @Prop({ required: true, unique: true })
  hubId: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  type: string;

  @Prop()
  isPickupPoint: boolean;

  @Prop()
  address: string;

  @Prop({ required: true })
  wilayaCode: string;

  @Prop()
  phone: string;

  @Prop()
  openingHours: string;
}

export const ZrHubSchema = SchemaFactory.createForClass(ZrHub);

ZrHubSchema.index({ wilayaCode: 1 });
