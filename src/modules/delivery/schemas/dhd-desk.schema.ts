import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DhdDeskDocument = DhdDesk & Document;

@Schema({ timestamps: true })
export class DhdDesk {
  @Prop({ required: true })
  nom: string;

  @Prop({ required: true })
  wilayaCode: string;

  @Prop()
  commune: string;

  @Prop()
  adresse: string;

  @Prop()
  phone: string;

  @Prop()
  mapLink: string;

  @Prop({ type: Object })
  workingDays: Record<string, unknown>;
}

export const DhdDeskSchema = SchemaFactory.createForClass(DhdDesk);

DhdDeskSchema.index({ wilayaCode: 1 });
