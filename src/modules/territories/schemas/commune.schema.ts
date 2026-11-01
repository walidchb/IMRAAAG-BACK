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

  /**
   * The commune's DHD/ECOTRACK counterpart, stored as the carrier's commune **name** (`nom`):
   * DHD exposes no commune UUID and matches on the French toponym. A populated value means the
   * commune needs no manual DHD mapping — dispatch sends it verbatim.
   */
  @Prop()
  dhd_uuid: string;

  @Prop()
  zrexpress_uuid: string;

  @Prop()
  yalidine_uuid: string;

  /**
   * The commune's Noest Express counterpart, stored as the carrier's commune **name** (`nom`):
   * Noest exposes no commune UUID and matches on `{ nom, wilaya_id }`. A populated value means the
   * commune needs no manual Noest mapping — dispatch sends it verbatim.
   */
  @Prop()
  noestexpress_uuid: string;

  @Prop()
  ecomdelivery_uuid: string;
}

export const CommuneSchema = SchemaFactory.createForClass(Commune);

CommuneSchema.index({ wilaya_code: 1, name: 1 });
