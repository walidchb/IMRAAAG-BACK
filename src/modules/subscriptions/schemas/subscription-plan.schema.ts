import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import type {
  BillingMode,
  SubscriptionFeatures,
  SubscriptionLimits,
  SubscriptionTrialConfig,
} from '../../../common/constants/subscription.const';

export type SubscriptionPlanDocument = SubscriptionPlan & Document;

/**
 * One supported monthly duration. Names/labels and global availability are **not** stored
 * per plan: durations are the fixed global catalogue (`1/3/6/12`) and the admin enables them
 * platform-wide. A plan only stores the discount for each supported duration, so prices stay
 * derived from `price` and can never go stale.
 */
@Schema({ _id: true, timestamps: false })
export class PlanBillingOption {
  /**
   * One of the four globally supported durations (1, 3, 6, 12). Deliberately not an `enum`
   * here: pre-migration documents may still carry an obsolete duration and must remain
   * editable. The DTO and `PlansService.normalizeBillingOptions` enforce the supported set.
   */
  @Prop({ type: Number, required: true, min: 1, max: 36 })
  durationMonths: number;

  @Prop({ type: Number, required: true, min: 0, max: 100, default: 0 })
  discountPercent: number;
}

export const PlanBillingOptionSchema = SchemaFactory.createForClass(PlanBillingOption);

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

  /**
   * Legacy single-language description. Kept in sync with `descriptionEn` on write so older
   * readers keep working; new UI surfaces the per-language fields below.
   */
  @Prop()
  description?: string;

  /** English description (storefront picks the field matching the visitor's locale). */
  @Prop({ trim: true })
  descriptionEn?: string;

  @Prop({ trim: true })
  descriptionFr?: string;

  @Prop({ trim: true })
  descriptionAr?: string;

  /** Optional icon shown on top of the plan card (R2 public URL). */
  @Prop({ trim: true })
  image?: string;

  /** Integer DZD, >= 0. Monthly base price when `billingMode='monthly'`, period price when legacy. */
  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ required: true, enum: ['DZD'], default: 'DZD' })
  currency: string;

  /** Integer days, >= 1. For monthly plans this must be 30 and is ignored for assignment. */
  @Prop({ required: true, min: 1 })
  durationDays: number;

  /** `legacy` = single period price/duration; `monthly` = price is the monthly base + options. */
  @Prop({ type: String, enum: ['legacy', 'monthly'], default: 'legacy' })
  billingMode: BillingMode;

  /**
   * Per-duration discounts for monthly plans. Always contains the four supported durations
   * (1/3/6/12); global enablement is stored separately. Empty for legacy plans.
   */
  @Prop({ type: [PlanBillingOptionSchema], default: [] })
  billingOptions: PlanBillingOption[];

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

