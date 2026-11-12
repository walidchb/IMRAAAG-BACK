import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { StoreMemberStatus, StoreRole } from '../../../common/constants/store-roles.enum';

export type StoreMemberDocument = StoreMember & Document;

/**
 * A user's membership of one store.
 *
 * The Owner is projected here as a `{ storeId, userId: vendorId, role: OWNER }` row, but
 * `Store.vendorId` remains the canonical ownership pointer. This collection is the
 * authorisation source for every non-owner role.
 *
 * The `'ObjectId'` string form is required: in this Mongoose/@nestjs-mongoose build the
 * `Types.ObjectId` form compiles to a Mixed path and silently skips casting (the same quirk
 * documented for `Order.storeId`). See `store-member.schema.spec.ts`.
 */
@Schema({ timestamps: true, collection: 'storemembers' })
export class StoreMember {
  @Prop({ type: 'ObjectId', ref: 'Store', required: true, index: true })
  storeId: Types.ObjectId;

  @Prop({ type: 'ObjectId', ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(StoreRole), required: true })
  role: StoreRole;

  /**
   * Reserved extension point for future custom roles. A non-empty array replaces the role
   * map; empty (the MVP default) uses `STORE_ROLE_PERMISSIONS[role]`.
   */
  @Prop({ type: [String], default: [] })
  permissionOverrides: string[];

  @Prop({ type: String, enum: Object.values(StoreMemberStatus), default: StoreMemberStatus.ACTIVE })
  status: StoreMemberStatus;

  @Prop({ type: 'ObjectId', ref: 'User' })
  invitedBy?: Types.ObjectId;

  @Prop()
  joinedAt?: Date;

  @Prop()
  deactivatedAt?: Date;

  @Prop({ type: 'ObjectId', ref: 'User' })
  deactivatedBy?: Types.ObjectId;
}

export const StoreMemberSchema = SchemaFactory.createForClass(StoreMember);

StoreMemberSchema.index({ storeId: 1, userId: 1 }, { unique: true });
StoreMemberSchema.index({ userId: 1, status: 1 });
StoreMemberSchema.index({ storeId: 1, status: 1, role: 1 });
