import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import type {
  SubscriptionFeatures,
  SubscriptionLimits,
  SubscriptionTrialConfig,
} from '../../../common/constants/subscription.const';

export type SubscriptionPlanDocument = SubscriptionPlan & Document;

/**
 * A reusable commercial plan (template). Editing a plan only affects **future** assignments:
 * existing subscriptions enforce from their stored `planSnapshot`, never from this document.
 * See `PLANS_AND_SUBSCRIPTIONS_IMPLEMENTATION_PLAN.md` §7.
 */
@Schema({ timestamps: true, collection: 'plans' })
export class SubscriptionPlan {
  @Prop({ required: true, trim: true })
  name: string;

  /** Lower-cased, trimmed name used for the unique index and duplicate detection. */
  @Prop({ required: true, trim: true, lowercase: true })
  nameKey: string;

  /** Stable script/config code (`legacy-unlimited`, `starter`, …). Optional; unique when set. */
  @Prop({ trim: true })
  code?: string;

  @Prop()
  description?: string;

  /** Integer DZD, >= 0. */
  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ required: true, enum: ['DZD'], default: 'DZD' })
  currency: string;

  /** Integer days, >= 1. */
  @Prop({ required: true, min: 1 })
  durationDays: number;

  /** Available for new assignments. Deactivating never touches existing subscriptions. */
  @Prop({ default: true })
  isActive: boolean;

  /** At most one active plan may be the default for new store signups. */
  @Prop({ default: false })
  isDefaultForSignup: boolean;

  /** Increments on every commercial edit. */
  @Prop({ default: 1 })
  version: number;

  @Prop({
    type: {
      maxOrders: { type: Number, default: null },
      maxProducts: { type: Number, default: null },
      maxTeamMembers: { type: Number, default: null },
    },
    default: { maxOrders: null, maxProducts: null, maxTeamMembers: null },
  })
  limits: SubscriptionLimits;

  @Prop({
    type: { pos: { type: Boolean, default: false } },
    default: { pos: false },
  })
  features: SubscriptionFeatures;

  @Prop({
    type: {
      enabled: { type: Boolean, default: false },
      days: { type: Number, default: null },
    },
    default: { enabled: false, days: null },
  })
  trial: SubscriptionTrialConfig;

  @Prop({ type: String, default: null })
  createdByAdminId?: string | null;

  @Prop({ type: String, default: null })
  createdByAdminEmail?: string | null;

  @Prop({ type: String, default: null })
  lastEditedByAdminId?: string | null;

  @Prop({ type: String, default: null })
  lastEditedByAdminEmail?: string | null;
}

export const SubscriptionPlanSchema = SchemaFactory.createForClass(SubscriptionPlan);

SubscriptionPlanSchema.index({ nameKey: 1 }, { unique: true });
SubscriptionPlanSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string' } } },
);
SubscriptionPlanSchema.index({ isActive: 1, createdAt: -1 });
SubscriptionPlanSchema.index(
  { isDefaultForSignup: 1 },
  { unique: true, partialFilterExpression: { isDefaultForSignup: true, isActive: true } },
);

