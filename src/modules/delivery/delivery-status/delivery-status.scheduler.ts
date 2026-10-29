import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { deliveryStatusLeaseKey } from '../../../common/constants/delivery-status.const';
import { DeliveryStatusService } from './delivery-status.service';
import { DeliveryStatusLeaseService } from './delivery-status-lease.service';
import { getCarrierProfile, listCarrierProfiles } from './carrier/carrier-profiles';

/**
 * The interval provider (roadmap A12.1, Option A).
 *
 * One dependency-free `setTimeout` chain **per enabled carrier**. A chain schedules its next
 * cycle when the current one ends, so a slow cycle can never overlap itself and a second
 * provider is never delayed by the first.
 *
 * The **lease** is the second guard (roadmap A12.5): when the platform runs more than one
 * instance, only the instance that holds a provider's lease polls that provider. The lease is
 * taken for the duration of the cycle and released when it ends, so a crashed instance's lease
 * simply expires.
 */
@Injectable()
export class DeliveryStatusScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryStatusScheduler.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly service: DeliveryStatusService,
    private readonly lease: DeliveryStatusLeaseService,
  ) {}

  onModuleInit(): void {
    const providers = this.service.enabledProviders();

    // Log every registered provider, not only the enabled ones: a provider that is silently
    // off (a missing settings-block entry, a typo in its env flag) is otherwise invisible.
    for (const profile of listCarrierProfiles()) {
      const settings = this.service.settingsFor(profile.companyId);
      this.logger.log(
        `Carrier status sync '${profile.companyId}': enabled=${settings.enabled}, ` +
          `interval=${settings.intervalMinutes}m, maxCalls=${settings.maxCallsPerMinute}/min.`,
      );
    }

    if (providers.length === 0) {
      this.logger.log(
        'No carrier status poller is enabled (every provider *_STATUS_SYNC_ENABLED is off) — nothing to schedule.',
      );
      return;
    }

    for (const profile of providers) {
      const settings = this.service.settingsFor(profile.companyId);
      this.logger.log(
        `The ${profile.displayName} status poller is enabled: every ${settings.intervalMinutes} minute(s), ` +
          `at most ${settings.maxCallsPerMinute} carrier call(s) per minute.`,
      );
      this.schedule(profile.companyId, 0);
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Schedules the next cycle for one provider, with a jitter (roadmap A12.5). */
  private schedule(companyId: string, delayMs: number): void {
    if (this.stopped) return;

    const timer = setTimeout(() => {
      this.timers.delete(companyId);
      void this.tick(companyId);
    }, Math.max(0, delayMs));

    // A pending timer must never keep the process alive on its own.
    timer.unref?.();
    this.timers.set(companyId, timer);
  }

  /** The next delay: the provider's interval plus a random jitter. */
  private nextDelayMs(companyId: string): number {
    const settings = this.service.settingsFor(companyId);
    const base = Math.max(1, settings.intervalMinutes) * 60_000;
    const jitter = base * Math.max(0, settings.jitterRatio) * Math.random();
    return base + jitter;
  }

  /** One scheduled run for one provider. */
  private async tick(companyId: string): Promise<void> {
    if (this.stopped) return;

    const displayName = getCarrierProfile(companyId)?.displayName ?? companyId;
    const settings = this.service.settingsFor(companyId);
    const leaseKey = deliveryStatusLeaseKey(companyId);

    try {
      const acquired = await this.lease.acquire(settings.leaseSeconds, leaseKey);
      if (!acquired) {
        this.logger.debug(
          `Another instance holds the ${displayName} sync lease �?" this one stands down.`,
        );
        return;
      }

      try {
        await this.service.runCycle({ companyId });
      } finally {
        await this.lease.release(leaseKey);
      }
    } catch (error) {
      // The scheduler never dies: a failed cycle is logged and the next one is scheduled.
      this.logger.error(
        `The ${displayName} status cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.schedule(companyId, this.nextDelayMs(companyId));
    }
  }
}
