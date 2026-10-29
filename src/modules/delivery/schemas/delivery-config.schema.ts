import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DeliveryConfigDocument = DeliveryConfig & Document;

@Schema({ timestamps: true })
export class DeliveryConfig {
  @Prop({ type: Types.ObjectId, ref: 'User' })
  vendorId: Types.ObjectId;

  /** @deprecated Migration shim — use `storeId`. Retained until store-id migration completes. */
  @Prop({ required: true, unique: true })
  vendorEmail: string;

  /** Canonical owner reference. Populated by backfill + dual-write during migration. */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId?: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  companies: Record<string, {
    credentials: Record<string, string>;
    isDefault: boolean;
    status: 'enabled' | 'disabled';
    /** Per-provider pause for the carrier status poller. Absent means "follow the store". */
    statusSyncEnabled?: boolean;
  }>;

  /**
   * The store-wide carrier-status switch (Ecom/Recon plan, E3/E5).
   *
   * A vendor can pause status polling for the whole store without deleting any credentials. The
   * poller skips a paused store silently; a per-provider `companies.<id>.statusSyncEnabled` can
   * pause one carrier while the rest keep syncing.
   */
  @Prop({ type: Boolean, default: true })
  statusSyncEnabled: boolean;

  /**
   * Per-store carrier state overrides, namespaced by provider slug.
   *
   * `{ 'zr-express': { pret_a_expedier: 'en_preparation' } }` re-maps a carrier state slug for
   * this store only — the escape hatch for a tenant whose workflow uses a slug for a different
   * step (roadmap §11.3). The target must be another slug of the built-in catalogue, so an
   * override can redirect a state but can never invent a new normalized status.
   */
  @Prop({ type: Object, default: {} })
  statusStateOverrides: Record<string, Record<string, string>>;

  /**
   * Per-store order-signal overrides, namespaced by provider slug.
   *
   * `{ 'zr-express': { pret_a_expedier: 'cancelled' } }` tells the signal detector that this
   * carrier state means an order action even when the shared profile does not say so. Unlike a
   * state override, this one redirects *behaviour*: it can only name a known signal, so it can
   * never invent an order status either.
   */
  @Prop({ type: Object, default: {} })
  statusSignalOverrides: Record<string, Record<string, string>>;
}

export const DeliveryConfigSchema = SchemaFactory.createForClass(DeliveryConfig);

DeliveryConfigSchema.index({ vendorId: 1 });
DeliveryConfigSchema.index({ storeId: 1 }, { unique: true, sparse: true });
