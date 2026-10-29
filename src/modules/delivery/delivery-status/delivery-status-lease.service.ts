import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { DELIVERY_STATUS_LEASE_KEY } from '../../../common/constants/delivery-status.const';
import { SyncLease, SyncLeaseDocument } from '../schemas/sync-lease.schema';

const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === DUPLICATE_KEY
  );
}

/**
 * The single-instance lease (roadmap §12.5).
 *
 * The lease is **conditional**: an instance may take it only when no live lease exists, or when
 * the live one has expired. The unique index on `key` is the final guard, so two instances
 * racing for a free lease can never both win — the loser sees the duplicate-key error and
 * stands down.
 *
 * The lease is stored in MongoDB, never in process memory (roadmap §15.1): an instance that
 * crashes simply lets the lease expire, and the next instance takes it over.
 */
@Injectable()
export class DeliveryStatusLeaseService {
  private readonly logger = new Logger(DeliveryStatusLeaseService.name);
  private readonly instanceId = randomUUID();
  private readonly held = new Set<string>();

  constructor(
    @InjectModel(SyncLease.name)
    private readonly model: Model<SyncLeaseDocument>,
  ) {}

  /** This instance's id — the lease owner. */
  get owner(): string {
    return this.instanceId;
  }

  /** Whether this instance currently believes it holds the lease. */
  get isHeld(): boolean {
    return this.held.size > 0;
  }

  /** Whether this instance holds one provider's lease. */
  isHeldForKey(key: string = DELIVERY_STATUS_LEASE_KEY): boolean {
    return this.held.has(key);
  }

  /**
   * Acquires (or renews) the lease.
   *
   * Returns `true` when this instance holds the lease afterwards, `false` when another instance
   * holds a live one.
   */
  async acquire(
    leaseSeconds: number,
    key: string = DELIVERY_STATUS_LEASE_KEY,
  ): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(1, leaseSeconds) * 1000);

    // 1. Take over an expired lease, or renew our own.
    const taken = await this.model
      .findOneAndUpdate(
        {
          key,
          $or: [{ expiresAt: { $lte: now } }, { owner: this.instanceId }],
        },
        { $set: { owner: this.instanceId, expiresAt } },
        { new: true },
      )
      .exec();

    if (taken) {
      this.held.add(key);
      return true;
    }

    // 2. No lease yet — try to create one. The unique index decides the race.
    try {
      await this.model.create({
        key,
        owner: this.instanceId,
        expiresAt,
      });
      this.held.add(key);
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        // Another instance created the lease first. It holds it.
        this.held.delete(key);
        return false;
      }
      throw error;
    }
  }

  /** Extends the lease we already hold. Returns `false` when it was taken over meanwhile. */
  async renew(
    leaseSeconds: number,
    key: string = DELIVERY_STATUS_LEASE_KEY,
  ): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(1, leaseSeconds) * 1000);

    const renewed = await this.model
      .findOneAndUpdate(
        { key, owner: this.instanceId },
        { $set: { expiresAt } },
        { new: true },
      )
      .exec();

    if (renewed) this.held.add(key);
    else this.held.delete(key);
    return Boolean(renewed);
  }

  /**
   * Releases the lease on shutdown.
   *
   * The document is kept (rather than deleted) so the unique index keeps guarding the key; only
   * its expiry is moved into the past, which frees the lease for the next instance.
   */
  async release(key: string = DELIVERY_STATUS_LEASE_KEY): Promise<void> {
    if (!this.held.has(key)) return;
    try {
      await this.model
        .updateOne(
          { key, owner: this.instanceId },
          { $set: { expiresAt: new Date(0) } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Could not release the status-sync lease: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.held.delete(key);
    }
  }

  /** The lease document, for the health payload and the tests. */
  async current(key: string = DELIVERY_STATUS_LEASE_KEY): Promise<SyncLeaseDocument | null> {
    return this.model.findOne({ key }).exec();
  }
}
