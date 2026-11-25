import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { AdminStatus } from '../../../common/constants/admin-status.enum';

export type AdminDocument = Admin & Document;

/**
 * Panel administrators live in their own `admins` collection. A `users` document with
 * `role: 'ADMIN'` is a seller-side role and never authenticates an admin route.
 */
@Schema({ timestamps: true, collection: 'admins' })
export class Admin {
  @Prop({ required: true, trim: true, maxlength: 80 })
  firstName: string;

  @Prop({ required: true, trim: true, maxlength: 80 })
  lastName: string;

  /** Lowercased/trimmed; unique within THIS collection only. */
  @Prop({ required: true, unique: true, lowercase: true, trim: true, maxlength: 254 })
  email: string;

  /** bcrypt hash; never selected by default. */
  @Prop({ required: true, select: false })
  passwordHash: string;

  @Prop({ type: String, enum: AdminStatus, default: AdminStatus.ACTIVE, index: true })
  status: AdminStatus;

  /** Bumped on disable / password change → invalidates all issued access tokens. */
  @Prop({ type: Number, default: 0 })
  tokenVersion: number;

  /** SHA-256 of the opaque refresh token; single active session V1. */
  @Prop({ type: String, select: false, default: null })
  refreshTokenHash: string | null;

  @Prop({ type: Date, select: false, default: null })
  refreshTokenExpiresAt: Date | null;

  @Prop({ type: Date, default: null })
  lastLoginAt: Date | null;

  @Prop({ type: Date, default: null })
  passwordChangedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Admin', default: null })
  createdBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  disabledAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Admin', default: null })
  disabledBy: Types.ObjectId | null;
}

export const AdminSchema = SchemaFactory.createForClass(Admin);

AdminSchema.index({ status: 1, createdAt: -1 });
AdminSchema.index({ lastName: 1, firstName: 1 });
