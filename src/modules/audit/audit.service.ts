import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';
import { AuditAction } from '../../common/constants/audit-action.enum';
import { ResourceType } from '../../common/constants/resource-type.enum';

export interface AuditEntry {
  action: AuditAction;
  /** The acting user, when the request was authenticated. */
  actorId?: string | null;
  /** The acting user's email (vendors are resolved by email in some flows). */
  actorEmail?: string | null;
  /** The tenant the change belongs to. */
  storeId?: string | null;
  resourceType?: ResourceType;
  resourceId?: string | null;
  /** Non-sensitive context only - never credentials, tokens or passwords. */
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Append-only audit trail (H12).
 *
 * The `AuditLog` schema and module already existed but nothing ever wrote to them, so price,
 * stock, order-status and delivery-credential changes were untraceable after the fact. Services
 * call `record()` on their highest-risk mutations.
 *
 * Writing an audit entry must never fail the business operation: the write is best-effort and
 * its failure is logged, not thrown. `record()` is intentionally fire-and-forget for callers
 * that do not await it.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectModel(AuditLog.name)
    private readonly auditModel: Model<AuditLogDocument>,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.auditModel.create({
        userId: this.toObjectId(entry.actorId),
        actorEmail: entry.actorEmail ?? undefined,
        storeId: this.toObjectId(entry.storeId),
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: this.toObjectId(entry.resourceId),
        details: entry.details,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
      });
    } catch (err) {
      // Never let observability break a sale, a dispatch or a settings save.
      this.logger.warn(
        `Failed to write audit entry ${entry.action}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private toObjectId(value?: string | null): Types.ObjectId | undefined {
    if (!value || !Types.ObjectId.isValid(value)) return undefined;
    return new Types.ObjectId(value);
  }
}
