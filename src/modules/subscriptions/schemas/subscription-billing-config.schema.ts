import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  DEFAULT_ENABLED_BILLING_DURATIONS,
  type SupportedBillingDuration,
} from '../../../common/constants/subscription.const';

export type SubscriptionBillingConfigDocument = SubscriptionBillingConfig & Document;

/**
 * Global monthly billing configuration. A single `key: 'global'` document controls which of
 * the fixed durations (1/3/6/12) are offered platform-wide. Plans only store discounts; they
 * never control availability, so every plan always exposes the same duration set.
 */
@Schema({ timestamps: true, collection: 'subscriptionbillingconfigs' })
export class SubscriptionBillingConfig {
  @Prop({ required: true, unique: true, default: 'global', immutable: true })
  key: string;

  @Prop({ type: [Number], default: () => [...DEFAULT_ENABLED_BILLING_DURATIONS] })
  enabledDurations: SupportedBillingDuration[];

  @Prop({ type: String, default: null })
  updatedByAdminId?: string | null;

  @Prop({ type: String, default: null })
  updatedByAdminEmail?: string | null;
}

export const SubscriptionBillingConfigSchema = SchemaFactory.createForClass(
  SubscriptionBillingConfig,
);
