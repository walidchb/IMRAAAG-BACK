/**
 * COD order-performance funnel (decisions D-P12–D-P18).
 *
 * The cohort is every order received in the selected window/channel — cancellations included,
 * because they are drop-offs rather than exclusions. Current status alone cannot reconstruct how
 * far an order got (a returned order may never have been delivered; a cancelled order may have
 * been confirmed first), so the reliable evidence is the event timestamps, the history entries
 * and, for active orders, the monotonic current status.
 */

export interface FunnelOrderInput {
  statusSlug?: string | null;
  historySlugs?: readonly (string | null | undefined)[] | null;
  confirmedAt?: Date | string | null;
  dispatchedAt?: Date | string | null;
}

export interface FunnelCounts {
  received: number;
  confirmed: number;
  dispatched: number;
  delivered: number;
}

/** Current statuses that can only have been reached after confirmation. */
const CONFIRMED_STATUSES = new Set(['confirmed', 'dispatched', 'in-transit', 'delivered']);

/** Current statuses that can only have been reached after dispatch. */
const DISPATCHED_STATUSES = new Set(['dispatched', 'in-transit', 'delivered']);

/** Counts the cohort's progression through the four funnel stages. */
export function buildFunnel(rows: readonly FunnelOrderInput[]): FunnelCounts {
  const counts: FunnelCounts = { received: 0, confirmed: 0, dispatched: 0, delivered: 0 };

  for (const row of rows) {
    counts.received += 1;

    const status = row.statusSlug == null ? '' : String(row.statusSlug);
    const history = new Set<string>();
    for (const slug of row.historySlugs ?? []) {
      if (slug != null && slug !== '') history.add(String(slug));
    }

    // Every carrier return edge starts at dispatched/in-transit/delivered, so a returned order
    // always passed confirmation and dispatch — but it never implies delivery.
    const returned = status === 'returned';

    let confirmed =
      row.confirmedAt != null ||
      history.has('confirmed') ||
      CONFIRMED_STATUSES.has(status) ||
      returned;
    let dispatched =
      row.dispatchedAt != null ||
      history.has('dispatched') ||
      DISPATCHED_STATUSES.has(status) ||
      returned;
    const delivered = status === 'delivered' || history.has('delivered');

    // Monotonicity (D-P16): sparse legacy history must never produce an increasing funnel.
    if (delivered) {
      dispatched = true;
      confirmed = true;
    }
    if (dispatched) confirmed = true;

    if (confirmed) counts.confirmed += 1;
    if (dispatched) counts.dispatched += 1;
    if (delivered) counts.delivered += 1;
  }

  return counts;
}
