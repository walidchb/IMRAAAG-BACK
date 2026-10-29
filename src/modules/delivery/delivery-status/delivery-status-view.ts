import type { StateOverrides } from './carrier/carrier-signal';
import type { CarrierStatusProfile } from './carrier/carrier-profile';
import { DEFAULT_CARRIER_COMPANY_ID, getCarrierProfile } from './carrier/carrier-profiles';
import {
  DeliveryTimelineEntry,
  DeliveryTimelineSituation,
} from '../schemas/delivery-parcel-status.schema';

/**
 * The **displayed history** (roadmap §8.4).
 *
 * A merged, timestamp-ordered view computed at read time from two sources:
 *
 * 1. `Order.history` — our own order-status events. Authoritative for "what happened to the
 *    order".
 * 2. The carrier's transitions — authoritative for "where is the parcel".
 *
 * The merge rule: sort by timestamp ascending; a carrier event is rendered beneath the
 * corresponding order event; a carrier event that arrived *before* our `dispatched` event (the
 * parcel is created during dispatch, so this is normal) is rendered under a synthetic
 * "Parcel created" anchor rather than being dropped.
 *
 * This module is pure: no Nest decorators, no I/O. Everything here is a function of its
 * arguments, which is what makes the merge rule testable in isolation.
 */

/** What kind of thing a timeline entry is. */
export type DeliveryTimelineKind = 'order' | 'carrier' | 'anchor';

/** One entry of the merged timeline. */
export interface DeliveryTimelineItem {
  kind: DeliveryTimelineKind;
  /** When it happened. `null` only when the source carried no timestamp. */
  at: Date | null;
  /** The order status slug — order events only. */
  orderStatus?: string | null;
  /** The order status display name — order events only. */
  orderStatusLabel?: string | null;
  /** Who made the change — order events only (`Vendor`, `Customer`, `ZR Express`). */
  user?: string | null;
  /** The carrier state the parcel left — carrier events only. */
  fromState?: string | null;
  /** The carrier state the parcel entered — carrier events only. */
  toState?: string | null;
  /** The normalized status of that carrier state — carrier events only. */
  toStatus?: string | null;
  /** The carrier's free-text comment — carrier events only. */
  comment?: string | null;
  /** The hub the move happened at — carrier events only. */
  hubName?: string | null;
  /** The situations attached to the move — carrier events only. */
  situations?: { slug: string | null; name: string | null; description: string | null }[];
  /** The normalized flags the situations produced — carrier events only. */
  flags?: string[];
  /** The anchor's own label — anchor events only. */
  anchor?: 'parcel_created';
}

/** One of our own order-status events, as stored in `Order.history`. */
export interface DeliveryOrderEvent {
  slug: string | null;
  displayName: string | null;
  date: Date | null;
  user: string | null;
}

/** The order-status slug that means "the parcel left the seller". */
const DISPATCHED_SLUG = 'dispatched';

/**
 * Merges our own order events with the carrier's transitions.
 *
 * The carrier's events that happened before the order's `dispatched` event are grouped under a
 * synthetic "Parcel created" anchor — the parcel is created *during* dispatch, so the carrier
 * can legitimately be ahead of us. Dropping them would hide the parcel's real beginning.
 */
export function buildMergedTimeline(
  orderEvents: DeliveryOrderEvent[],
  carrierEntries: DeliveryTimelineEntry[],
  overrides?: StateOverrides | null,
  profile: CarrierStatusProfile | null = getCarrierProfile(DEFAULT_CARRIER_COMPANY_ID),
): DeliveryTimelineItem[] {
  const orderItems: DeliveryTimelineItem[] = orderEvents.map((event) => ({
    kind: 'order',
    at: event.date ?? null,
    orderStatus: event.slug,
    orderStatusLabel: event.displayName,
    user: event.user,
  }));

  const carrierItems: DeliveryTimelineItem[] = (carrierEntries ?? []).map((entry) =>
    toCarrierItem(entry, overrides, profile),
  );

  const dispatchedAt = orderEvents
    .filter((event) => event.slug === DISPATCHED_SLUG)
    .map((event) => event.date)
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  const early: DeliveryTimelineItem[] = [];
  const rest: DeliveryTimelineItem[] = [];

  for (const item of carrierItems) {
    // The anchor explains the carrier being *ahead* of our dispatch — so it only exists when we
    // dispatched. An order we never dispatched has no "before" to be ahead of.
    const isEarly =
      dispatchedAt !== undefined &&
      item.at !== null &&
      item.at.getTime() < dispatchedAt.getTime();
    if (isEarly) early.push(item);
    else rest.push(item);
  }

  const blocks: { at: number; rank: number; items: DeliveryTimelineItem[] }[] = [];

  for (const item of orderItems) {
    blocks.push({ at: item.at ? item.at.getTime() : 0, rank: 0, items: [item] });
  }

  for (const item of rest) {
    blocks.push({ at: item.at ? item.at.getTime() : 0, rank: 2, items: [item] });
  }

  if (early.length > 0) {
    const anchorAt = early.reduce((min, item) => {
      const value = item.at ? item.at.getTime() : Number.MAX_SAFE_INTEGER;
      return value < min ? value : min;
    }, Number.MAX_SAFE_INTEGER);

    const anchor: DeliveryTimelineItem = {
      kind: 'anchor',
      at: anchorAt === Number.MAX_SAFE_INTEGER ? null : new Date(anchorAt),
      anchor: 'parcel_created',
    };

    blocks.push({
      at: anchorAt === Number.MAX_SAFE_INTEGER ? 0 : anchorAt,
      rank: 1,
      items: [anchor, ...early],
    });
  }

  blocks.sort((a, b) => (a.at === b.at ? a.rank - b.rank : a.at - b.at));

  return blocks.flatMap((block) => block.items);
}

/** One carrier transition, normalized for display. */
function toCarrierItem(
  entry: DeliveryTimelineEntry,
  overrides?: StateOverrides | null,
  profile: CarrierStatusProfile | null = getCarrierProfile(DEFAULT_CARRIER_COMPANY_ID),
): DeliveryTimelineItem {
  const situations = (entry.situations ?? []) as DeliveryTimelineSituation[];

  return {
    kind: 'carrier',
    at: entry.at ?? null,
    fromState: entry.fromState ?? null,
    toState: entry.toState ?? null,
    toStatus: profile?.normalizeState(entry.toState, overrides) ?? 'unknown',
    comment: entry.comment ?? null,
    hubName: entry.hubName ?? null,
    situations: situations.map((situation) => ({
      slug: situation.slug ?? null,
      name: situation.name ?? null,
      description: situation.description ?? null,
    })),
    flags: profile?.flagsForSituations(situations) ?? [],
  };
}

/** The carrier's current situation, normalized for display. */
export function normalizeCurrentSituation(
  rawSituation: Record<string, unknown> | null | undefined,
): { slug: string | null; name: string | null; description: string | null } | null {
  if (!rawSituation || typeof rawSituation !== 'object') return null;

  const source = rawSituation as Record<string, unknown>;
  const slug = typeof source.slug === 'string' ? source.slug : null;
  const name = typeof source.name === 'string' ? source.name : null;
  const description = typeof source.description === 'string' ? source.description : null;

  if (!slug && !name && !description) return null;
  return { slug, name, description };
}
