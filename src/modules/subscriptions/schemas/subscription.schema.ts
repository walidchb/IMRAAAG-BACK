import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  SubscriptionStatus,
} from '../../../common/constants/subscription.const';
import type {
  SubscriptionPlanSnapshot,
  SubscriptionSource,
} from '../../../common/constants/subscription.const';

export type SubscriptionDocument = Subscription & Document;

/**
 * One **current** subscription per store (unique `storeId`). Terms live in `planSnapshot` so a
 * later plan edit cannot retroactively change an existing subscriber. History is append-only
 * in `subscriptionevents`. See `PLANS_AND_SUBSCRIPTIONS_IMPLEMENTATION_PLAN.md` §8.
 *
 * `storeId` uses the `'ObjectId'` string form: in this Mongoose/@nestjs-mongoose build the
 * `Types.ObjectId` form compiles to a Mixed path and skips casting (see `store-member.schema.ts`).
 */
@Schema({ timestamps: true, collection: 'subscriptions' })
export class Subscription {
  @Prop({ type: 'ObjectId', ref: 'Store', required: true })
  storeId: Types.ObjectId;

  @Prop({ type: 'ObjectId', ref: 'SubscriptionPlan', default: null })
  planId: Types.ObjectId | null;

  @Prop({ type: Object, required: true })
  planSnapshot: SubscriptionPlanSnapshot;

  @Prop({
    type: String,
    enum: Object.values(SubscriptionStatus),
    required: true,
    default: SubscriptionStatus.ACTIVE,
  })
  status: SubscriptionStatus;

  @Prop({ default: false })
  isTrial: boolean;

  @Prop({ type: Date, required: true })
  startDate: Date;

  /** `null` = perpetual (legacy/grandfathered). */
  @Prop({ type: Date, default: null })
  endDate: Date | null;

  @Prop({ type: Date, default: null })
  trialStartedAt?: Date | null;

  @Prop({ type: Date, default: null })
  trialEndsAt?: Date | null;

  /** Retained after a trial ends so a second trial can be refused. */
  @Prop({ type: Date, default: null })
  trialUsedAt?: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt?: Date | null;

  @Prop({ type: String, default: null })
  cancelledByAdminId?: string | null;

  @Prop({ type: String, default: null })
  cancelledByAdminEmail?: string | null;

  @Prop({ type: String, default: null })
  cancelReason?: string | null;

  @Prop({
    type: { ordersUsed: { type: Number, default: 0, min: 0 } },
    default: { ordersUsed: 0 },
  })
  usage: { ordersUsed: number };

  @Prop({
    type: String,
    enum: ['admin_assigned', 'admin_trial', 'legacy_backfill', 'signup_default'],
    required: true,
  })
  source: SubscriptionSource;

  @Prop({ type: String, default: null })
  createdByAdminId?: string | null;

  @Prop({ type: String, default: null })
  createdByAdminEmail?: string | null;

  @Prop({ type: String, default: null })
  lastUpdatedByAdminId?: string | null;

  @Prop({ type: String, default: null })
  lastUpdatedByAdminEmail?: string | null;
}

export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);

SubscriptionSchema.index({ storeId: 1 }, { unique: true });
SubscriptionSchema.index({ status: 1, endDate: 1 });
SubscriptionSchema.index({ planId: 1, status: 1 });
SubscriptionSchema.index({ endDate: 1 });
