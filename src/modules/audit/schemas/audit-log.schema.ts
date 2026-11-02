import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { AuditAction } from '../../../common/constants/audit-action.enum';
import { ResourceType } from '../../../common/constants/resource-type.enum';

export type AuditLogDocument = AuditLog & Document;

@Schema({ timestamps: true })
export class AuditLog {
  @Prop({ type: Types.ObjectId, ref: 'User' })
  userId: Types.ObjectId;

  /**
   * Who acted, when the flow only knows the email (vendor-scoped delivery config, for example).
   * Kept alongside `userId` so an entry is still attributable if the user row is gone.
   */
  @Prop()
  actorEmail: string;

  /** Tenant the change belongs to, so an audit review is store-scoped. */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId: Types.ObjectId;

  @Prop({ type: String, enum: AuditAction, required: true })
  action: AuditAction;

  @Prop({ type: String, enum: ResourceType })
  resourceType: ResourceType;

  @Prop({ type: Types.ObjectId })
  resourceId: Types.ObjectId;

  @Prop({ type: Object })
  details: Record<string, any>;

  @Prop()
  ipAddress: string;

  @Prop()
  userAgent: string;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

// Indexes
AuditLogSchema.index({ userId: 1 });
AuditLogSchema.index({ action: 1 });
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ storeId: 1, createdAt: -1 });
