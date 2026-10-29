import {
  buildMergedTimeline,
  normalizeCurrentSituation,
} from './delivery-status-view';
import type { DeliveryTimelineEntry } from '../schemas/delivery-parcel-status.schema';

/**
 * The merged timeline (roadmap §8.4).
 *
 * The rule is simple to state and easy to get wrong, so it is pinned here:
 *
 * - our own order events and the carrier's transitions are interleaved by timestamp;
 * - a carrier event that arrived *before* our `dispatched` event is rendered under a
 *   synthetic "Parcel created" anchor — it is never dropped;
 * - a carrier event that arrived after it is not anchored.
 */
describe('buildMergedTimeline — the displayed history (§8.4)', () => {
  const orderEvent = (slug: string, date: string, user = 'Vendor') => ({
    slug,
    displayName: slug.toUpperCase(),
    date: new Date(date),
    user,
  });

  const carrierEntry = (overrides: Partial<DeliveryTimelineEntry> = {}): DeliveryTimelineEntry =>
    ({
      providerEntryId: 'entry-1',
      fromState: 'pret_a_expedier',
      toState: 'en_livraison',
      at: new Date('2026-10-21T10:00:00.000Z'),
      comment: null,
      hubName: 'Hub Alger',
      situations: [],
      ...overrides,
    }) as DeliveryTimelineEntry;

  it('interleaves our own order events with the carrier transitions by timestamp', () => {
    const timeline = buildMergedTimeline(
      [
        orderEvent('placed', '2026-10-20T08:00:00.000Z'),
        orderEvent('confirmed', '2026-10-20T09:00:00.000Z'),
        orderEvent('dispatched', '2026-10-20T12:00:00.000Z'),
      ],
      [
        carrierEntry({
          providerEntryId: 'entry-1',
          toState: 'en_livraison',
          at: new Date('2026-10-21T10:00:00.000Z'),
        }),
      ],
    );

    expect(timeline.map((item) => item.kind)).toEqual(['order', 'order', 'order', 'carrier']);
    expect(timeline[3].toState).toBe('en_livraison');
    expect(timeline[3].toStatus).toBe('out_for_delivery');
  });

  it('anchors a carrier event that arrived before the dispatch under "parcel created"', () => {
    const timeline = buildMergedTimeline(
      [
        orderEvent('placed', '2026-10-20T08:00:00.000Z'),
        orderEvent('dispatched', '2026-10-20T12:00:00.000Z'),
      ],
      [
        carrierEntry({
          providerEntryId: 'entry-early',
          toState: 'commande_recue',
          at: new Date('2026-10-20T11:00:00.000Z'),
        }),
      ],
    );

    expect(timeline.map((item) => item.kind)).toEqual(['order', 'anchor', 'carrier', 'order']);
    const anchor = timeline[1];
    expect(anchor.anchor).toBe('parcel_created');
    expect(anchor.at).toEqual(new Date('2026-10-20T11:00:00.000Z'));
    // The early carrier event is kept, not dropped.
    expect(timeline[2].toState).toBe('commande_recue');
  });

  it('does not anchor a carrier event that arrived after the dispatch', () => {
    const timeline = buildMergedTimeline(
      [orderEvent('dispatched', '2026-10-20T12:00:00.000Z')],
      [
        carrierEntry({
          providerEntryId: 'entry-late',
          at: new Date('2026-10-21T10:00:00.000Z'),
        }),
      ],
    );

    expect(timeline.map((item) => item.kind)).toEqual(['order', 'carrier']);
    expect(timeline.some((item) => item.kind === 'anchor')).toBe(false);
  });

  it('does not anchor when the order was never dispatched — there is no "before"', () => {
    const timeline = buildMergedTimeline(
      [orderEvent('placed', '2026-10-20T08:00:00.000Z')],
      [
        carrierEntry({
          providerEntryId: 'entry-1',
          at: new Date('2026-10-21T10:00:00.000Z'),
        }),
      ],
    );

    expect(timeline.map((item) => item.kind)).toEqual(['order', 'carrier']);
  });

  it('normalises a carrier state with the store’s own override', () => {
    const timeline = buildMergedTimeline(
      [],
      [carrierEntry({ toState: 'tenant_state', at: new Date('2026-10-21T10:00:00.000Z') })],
      { tenant_state: 'en_livraison' },
    );

    expect(timeline[0].toStatus).toBe('out_for_delivery');
  });

  it('maps an unknown carrier state to `unknown` rather than guessing', () => {
    const timeline = buildMergedTimeline(
      [],
      [carrierEntry({ toState: 'brand_new_state', at: new Date('2026-10-21T10:00:00.000Z') })],
    );

    expect(timeline[0].toStatus).toBe('unknown');
  });

  it('derives the situation flags of a carrier event from its situations', () => {
    const timeline = buildMergedTimeline(
      [],
      [
        carrierEntry({
          toState: 'en_livraison',
          at: new Date('2026-10-21T10:00:00.000Z'),
          situations: [
            {
              slug: 'situation-1',
              name: 'Client injoignable',
              description: 'Client injoignable',
              at: new Date('2026-10-21T10:00:00.000Z'),
            },
          ],
        }),
      ],
    );

    expect(timeline[0].flags).toContain('unreachable');
    expect(timeline[0].situations?.[0]?.name).toBe('Client injoignable');
  });

  it('renders our own order events with their status and author', () => {
    const timeline = buildMergedTimeline(
      [orderEvent('confirmed', '2026-10-20T09:00:00.000Z', 'Customer')],
      [],
    );

    expect(timeline[0].kind).toBe('order');
    expect(timeline[0].orderStatus).toBe('confirmed');
    expect(timeline[0].user).toBe('Customer');
  });
});

describe('normalizeCurrentSituation', () => {
  it('reads the carrier’s own situation, verbatim', () => {
    expect(
      normalizeCurrentSituation({ slug: 'situation-1', name: 'Reporté', description: 'Reporté' }),
    ).toEqual({ slug: 'situation-1', name: 'Reporté', description: 'Reporté' });
  });

  it('returns null when there is no situation at all', () => {
    expect(normalizeCurrentSituation(null)).toBeNull();
    expect(normalizeCurrentSituation({})).toBeNull();
  });
});
