import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SyncLeaseDocument = SyncLease & Document;

/**
 * A single-instance lease (roadmap §12.5).
 *
 * The platform may run more than one instance of the backend. Without a lease, every replica
 * would poll every parcel, multiplying the provider load by the replica count — and multiplying
 * the chance of a 429. One document per key is held by exactly one instance at a time: the
 * holder renews `expiresAt` on every cycle, and an instance that crashes simply lets the lease
 * expire so the next cycle can take it over.
 */
@Schema({ timestamps: true })
export class SyncLease {
  /** The lease's name — one lease per guarded job. */
  @Prop({ required: true, unique: true })
  key: string;

  /** The instance id that currently holds the lease. */
  @Prop({ required: true })
  owner: string;

  /** When the lease expires. An expired lease may be taken over. */
  @Prop({ type: Date, required: true })
  expiresAt: Date;

  @Prop({ type: Date })
  createdAt?: Date;

  @Prop({ type: Date })
  updatedAt?: Date;
}

export const SyncLeaseSchema = SchemaFactory.createForClass(SyncLease);

SyncLeaseSchema.index({ expiresAt: 1 });
