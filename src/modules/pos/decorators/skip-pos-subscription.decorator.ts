import { SetMetadata } from '@nestjs/common';

/**
 * Marks a POS route as inventory-recovery only, exempt from the POS feature gate.
 *
 * Use it **only** on routes that exist to release stranded stock (listing and releasing held
 * sales). Sale-creating routes must stay gated: completing a hold is a POS sale.
 */
export const SKIP_POS_SUBSCRIPTION = 'skipPosSubscription';
export const SkipPosSubscription = () => SetMetadata(SKIP_POS_SUBSCRIPTION, true);
