import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NoestDeskDocument = NoestDesk & Document;

@Schema({ timestamps: true })
export class NoestDesk {
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  address: string;

  @Prop({ required: true })
  wilayaCode: string;

  @Prop()
  email: string;
}

export const NoestDeskSchema = SchemaFactory.createForClass(NoestDesk);

NoestDeskSchema.index({ wilayaCode: 1 });
