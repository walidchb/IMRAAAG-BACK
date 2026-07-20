import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OtpDocument = Otp & Document;

@Schema({ timestamps: true })
export class Otp {
  @Prop({ required: true, index: true })
  phoneNumber: string;

  @Prop({ required: true })
  code: string;

  @Prop({ required: true, default: 'password_reset' })
  type: string;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop()
  verifiedAt?: Date;

  @Prop()
  usedAt?: Date;
}

export const OtpSchema = SchemaFactory.createForClass(Otp);
