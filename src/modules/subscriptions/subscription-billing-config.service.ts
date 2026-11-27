import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  DEFAULT_ENABLED_BILLING_DURATIONS,
  SUPPORTED_BILLING_DURATIONS,
  normalizeBillingDurationList,
  type SupportedBillingDuration,
} from '../../common/constants/subscription.const';
import {
  SubscriptionBillingConfig,
  SubscriptionBillingConfigDocument,
} from './schemas/subscription-billing-config.schema';

export interface BillingConfigView {
  enabledDurations: SupportedBillingDuration[];
  allDurations: number[];
  updatedAt: Date | null;
}

const GLOBAL_KEY = 'global';

@Injectable()
export class SubscriptionBillingConfigService {
  constructor(
    @InjectModel(SubscriptionBillingConfig.name)
    private readonly configModel: Model<SubscriptionBillingConfigDocument>,
  ) {}

  /** Read the global config (creating the singleton lazily with every duration enabled). */
  async get(): Promise<BillingConfigView> {
    let doc = await this.configModel.findOne({ key: GLOBAL_KEY }).lean().exec();
    if (!doc) {
      try {
        doc = (
          await this.configModel.create({
            key: GLOBAL_KEY,
            enabledDurations: [...DEFAULT_ENABLED_BILLING_DURATIONS],
          })
        ).toObject();
      } catch {
        // Concurrent first read lost the unique-key race; re-read the winner.
        doc = await this.configModel.findOne({ key: GLOBAL_KEY }).lean().exec();
      }
    }

    return {
      enabledDurations: normalizeBillingDurationList(doc?.enabledDurations ?? []),
      allDurations: [...SUPPORTED_BILLING_DURATIONS],
      updatedAt: (doc as unknown as { updatedAt?: Date } | null)?.updatedAt ?? null,
    };
  }

  async getEnabledDurations(): Promise<SupportedBillingDuration[]> {
    return (await this.get()).enabledDurations;
  }

  async update(
    enabledDurations: unknown,
    actor: { id?: string | null; email?: string | null } = {},
  ): Promise<BillingConfigView> {
    const normalized = normalizeBillingDurationList(enabledDurations);
    const doc = await this.configModel
      .findOneAndUpdate(
        { key: GLOBAL_KEY },
        {
          $set: {
            enabledDurations: normalized,
            updatedByAdminId: actor.id ?? null,
            updatedByAdminEmail: actor.email ?? null,
          },
          $setOnInsert: { key: GLOBAL_KEY },
        },
        { upsert: true, new: true },
      )
      .exec();

    return {
      enabledDurations: normalizeBillingDurationList(doc?.enabledDurations ?? normalized),
      allDurations: [...SUPPORTED_BILLING_DURATIONS],
      updatedAt: (doc as unknown as { updatedAt?: Date } | null)?.updatedAt ?? null,
    };
  }
}
