import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TrackingConfigDocument = TrackingConfig & Document;

@Schema({ timestamps: true })
export class TrackingConfig {
  @Prop({ required: true, unique: true })
  vendorEmail: string;

  @Prop({ type: String, default: null })
  metaPixelId: string | null;

  @Prop({ type: String, default: null })
  metaAccessToken: string | null;

  @Prop({ type: Boolean, default: false })
  metaPixelEnabled: boolean;

  @Prop({ type: String, default: null })
  tikTokPixelId: string | null;

  @Prop({ type: String, default: null })
  tikTokAccessToken: string | null;

  @Prop({ type: Boolean, default: false })
  tikTokPixelEnabled: boolean;
}

export const TrackingConfigSchema = SchemaFactory.createForClass(TrackingConfig);
