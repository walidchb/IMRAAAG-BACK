import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { SubscriptionEventAction } from '../../../common/constants/subscription.const';
import type { SubscriptionActorType } from '../../../common/constants/subscription.const';

export type SubscriptionEventDocument = SubscriptionEvent & Document;

export interface SubscriptionEventSnapshot {
  status?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  planVersion?: number | null;
  snapshotName?: string | null;
}

/**
 * Append-only audit trail for commercial actions. Never used for enforcement; never exposed to
 * customers. Supports both subscription events (storeId/subscriptionId set) and plan-level
 * events (planId set, no store). See plan §8.5.
 */
@Schema({ timestamps: true, collection: 'subscriptionevents' })
export class SubscriptionEvent {
  @Prop({ type: 'ObjectId', ref: 'Store', default: null })
  storeId?: Types.ObjectId | null;

  @Prop({ type: 'ObjectId', ref: 'Subscription', default: null })
  subscriptionId?: Types.ObjectId | null;

  @Prop({ type: 'ObjectId', ref: 'SubscriptionPlan', default: null })
  planId?: Types.ObjectId | null;

  @Prop({ type: String, enum: Object.values(SubscriptionEventAction), required: true })
  action: SubscriptionEventAction;

  @Prop({ type: Object, default: null })
  from?: SubscriptionEventSnapshot | null;

  @Prop({ type: Object, default: null })
  to?: SubscriptionEventSnapshot | null;

  @Prop({ type: String, default: null })
  reason?: string | null;

  @Prop({ type: String, enum: ['admin', 'system'], required: true })
  actorType: SubscriptionActorType;

  @Prop({ type: String, default: null })
  adminId?: string | null;

  @Prop({ type: String, default: null })
  adminEmail?: string | null;

  /** Extra non-sensitive context (e.g. changed field names, order count). */
  @Prop({ type: Object, default: null })
  details?: Record<string, unknown> | null;
}

export const SubscriptionEventSchema = SchemaFactory.createForClass(SubscriptionEvent);

SubscriptionEventSchema.index({ storeId: 1, createdAt: -1 });
SubscriptionEventSchema.index({ subscriptionId: 1, createdAt: -1 });
SubscriptionEventSchema.index({ planId: 1, createdAt: -1 });
