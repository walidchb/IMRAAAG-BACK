import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  StoreInvitationStatus,
  StoreRole,
} from '../../../common/constants/store-roles.enum';

export type StoreInvitationDocument = StoreInvitation & Document;

/**
 * A pending/accepted/revoked invitation to join one store under one role.
 *
 * Security invariants:
 *  - the raw token is never stored or returned; only `sha256(rawToken)` is persisted;
 *  - `expiresAt` is enforced logically (`status === 'pending' && expiresAt < now`); there is
 *    deliberately **no TTL index** on this collection — a TTL would delete the document, not
 *    just expire it, and the same mistake previously deleted whole user documents;
 *  - resend/create reuses the same pending row (new hash/expiry), so the partial unique index
 *    `{ storeId, email } where status='pending'` never conflicts.
 */
@Schema({ timestamps: true, collection: 'storeinvitations' })
export class StoreInvitation {
  @Prop({ type: 'ObjectId', ref: 'Store', required: true, index: true })
  storeId: Types.ObjectId;

  @Prop({ required: true, lowercase: true, trim: true, index: true })
  email: string;

  @Prop({ type: String, enum: Object.values(StoreRole), required: true })
  role: StoreRole;

  /** SHA-256 hex of the raw token. The raw value is never persisted. */
  @Prop({ required: true })
  tokenHash: string;

  @Prop({
    type: String,
    enum: Object.values(StoreInvitationStatus),
    default: StoreInvitationStatus.PENDING,
  })
  status: StoreInvitationStatus;

  @Prop({ type: 'ObjectId', ref: 'User', required: true })
  invitedBy: Types.ObjectId;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop()
  acceptedAt?: Date;

  @Prop({ type: 'ObjectId', ref: 'User' })
  acceptedByUserId?: Types.ObjectId;

  @Prop()
  revokedAt?: Date;

  @Prop({ type: 'ObjectId', ref: 'User' })
  revokedBy?: Types.ObjectId;

  @Prop()
  lastSentAt?: Date;

  @Prop({ default: 0 })
  sendCount: number;
}

export const StoreInvitationSchema = SchemaFactory.createForClass(StoreInvitation);

StoreInvitationSchema.index({ tokenHash: 1 }, { unique: true });
StoreInvitationSchema.index({ storeId: 1, email: 1, status: 1 });
StoreInvitationSchema.index(
  { storeId: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
StoreInvitationSchema.index({ storeId: 1, status: 1, createdAt: -1 });
StoreInvitationSchema.index({ expiresAt: 1 });
