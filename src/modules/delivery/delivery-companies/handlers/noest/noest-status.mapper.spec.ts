import {
  mapNoestDiscoveryEntry,
  mapNoestHistoryResponse,
  normalizeNoestEvent,
  deriveSituationFlags,
} from './noest-status.mapper';
import {
  NoestDiscoveryEntry,
  NoestHistoryResponseDto,
} from './noest-status.types';

describe('NoestStatusMapper', () => {
  describe('normalizeNoestEvent', () => {
    it('maps upload to processing', () => {
      expect(normalizeNoestEvent('upload')).toBe('processing');
    });

    it('maps customer_validation to processing', () => {
      expect(normalizeNoestEvent('customer_validation')).toBe('processing');
    });

    it('maps livre to delivered', () => {
      expect(normalizeNoestEvent('livre')).toBe('delivered');
    });

    it('maps livred (typo) to delivered', () => {
      expect(normalizeNoestEvent('livred')).toBe('delivered');
    });

    it('maps return_asked_by_customer to returned', () => {
      expect(normalizeNoestEvent('return_asked_by_customer')).toBe('returned');
    });

    it('maps fdr_activated to out_for_delivery', () => {
      expect(normalizeNoestEvent('fdr_activated')).toBe('out_for_delivery');
    });

    it('maps pickedup to ready_for_pickup', () => {
      expect(normalizeNoestEvent('pickedup')).toBe('ready_for_pickup');
    });

    it('maps colis_suspendu to processing (no dedicated platform status)', () => {
      expect(normalizeNoestEvent('colis_suspendu')).toBe('processing');
    });

    it('maps mise_a_jour to processing (failed attempt, never an order signal)', () => {
      expect(normalizeNoestEvent('mise_a_jour')).toBe('processing');
    });

    it('maps the documented event aliases to catalogue statuses', () => {
      expect(normalizeNoestEvent('dispatched')).toBe('dispatch_local');
      expect(normalizeNoestEvent('in_transit')).toBe('dispatch_interwilaya');
      expect(normalizeNoestEvent('out_for_delivery')).toBe('out_for_delivery');
      expect(normalizeNoestEvent('delivered')).toBe('delivered');
      expect(normalizeNoestEvent('returned')).toBe('returned');
      expect(normalizeNoestEvent('cancelled')).toBe('cancelled');
    });

    it('maps ask_to_delete_by_admin to cancelled', () => {
      expect(normalizeNoestEvent('ask_to_delete_by_admin')).toBe('cancelled');
    });

    it('maps unknown event to unknown', () => {
      expect(normalizeNoestEvent('mystery_event')).toBe('unknown');
    });

    it('handles empty/null event gracefully', () => {
      expect(normalizeNoestEvent('')).toBe('unknown');
      expect(normalizeNoestEvent(null as any)).toBe('unknown');
    });

    it('handles case-insensitive event keys', () => {
      expect(normalizeNoestEvent('LIVRE')).toBe('delivered');
      expect(normalizeNoestEvent('Upload')).toBe('processing');
    });
  });

  describe('deriveSituationFlags', () => {
    it('returns DELIVERED flag for livre', () => {
      expect(deriveSituationFlags('livre')).toContain('DELIVERED');
    });

    it('returns DELIVERED flag for livred', () => {
      expect(deriveSituationFlags('livred')).toContain('DELIVERED');
    });

    it('returns RETURNED flag for return_asked_by_customer', () => {
      expect(deriveSituationFlags('return_asked_by_customer')).toContain('RETURNED');
    });

    it('returns CANCELLED flag for ask_to_delete_by_admin', () => {
      expect(deriveSituationFlags('ask_to_delete_by_admin')).toContain('CANCELLED');
    });

    it('returns OUT_FOR_DELIVERY flag for fdr_activated', () => {
      expect(deriveSituationFlags('fdr_activated')).toContain('OUT_FOR_DELIVERY');
    });

    it('returns AT_PICKUP_POINT flag for pickedup', () => {
      expect(deriveSituationFlags('pickedup')).toContain('AT_PICKUP_POINT');
    });

    it('returns empty array for unknown event', () => {
      expect(deriveSituationFlags('mystery_event')).toEqual([]);
    });

    it('handles case-insensitive flags', () => {
      expect(deriveSituationFlags('LIVRE')).toContain('DELIVERED');
    });
  });

  describe('mapNoestDiscoveryEntry', () => {
    it('maps delivered event correctly', () => {
      const entry: NoestDiscoveryEntry = {
        OrderInfo: {
          id: 'internal-123',
          reference: 'NOE123',
          tracking: 'NOE123',
          status: 'Livré',
          created_at: '2026-10-15T10:00:00Z',
        },
        status: 'delivered',
        activity: [
          {
            event: 'Uploaded to system',
            event_key: 'upload',
            date: '2026-10-15 10:00:00',
            by: 'Partner Store',
            causer: 'PARTNER',
          },
          {
            event: 'Delivered',
            event_key: 'livre',
            date: '2026-10-18 16:00:00',
            by: 'Driver 001',
            causer: 'NOEST',
          },
        ],
      };

      const result = mapNoestDiscoveryEntry(entry, 'NOE123');

      expect(result.providerState).toBe('livre');
      expect(result.normalizedStatus).toBe('delivered');
      expect(result.situations).toContain('DELIVERED');
      expect(result.timeline).toHaveLength(2);
      expect(result.timeline[0].event).toBe('upload');
      expect(result.timeline[1].event).toBe('livre');
      expect(result.timeline[0].providerEntryId).toMatch(/^[a-f0-9]{40}$/);
    });

    it('maps returned event correctly', () => {
      const entry: NoestDiscoveryEntry = {
        OrderInfo: {
          id: '2',
          reference: 'NOE456',
          tracking: 'NOE456',
          status: 'Returned',
        },
        status: 'returned',
        activity: [
          {
            event: 'Uploaded to system',
            event_key: 'upload',
            date: '2026-10-15 10:00:00',
          },
          {
            event: 'Return requested by partner',
            event_key: 'return_asked_by_customer',
            date: '2026-10-20 12:00:00',
          },
        ],
      };

      const result = mapNoestDiscoveryEntry(entry, 'NOE456');

      expect(result.providerState).toBe('return_asked_by_customer');
      expect(result.normalizedStatus).toBe('returned');
      expect(result.situations).toContain('RETURNED');
    });

    it('maps cancelled event correctly', () => {
      const entry: NoestDiscoveryEntry = {
        OrderInfo: {
          id: '3',
          reference: 'NOE789',
          tracking: 'NOE789',
          status: 'Cancelled',
        },
        status: 'cancelled',
        activity: [
          {
            event: 'Uploaded to system',
            event_key: 'upload',
            date: '2026-10-15 10:00:00',
          },
          {
            event: 'Deletion requested',
            event_key: 'ask_to_delete_by_admin',
            date: '2026-10-16 09:00:00',
          },
        ],
      };

      const result = mapNoestDiscoveryEntry(entry, 'NOE789');

      expect(result.providerState).toBe('ask_to_delete_by_admin');
      expect(result.normalizedStatus).toBe('cancelled');
      expect(result.situations).toContain('CANCELLED');
    });

    it('maps in_transit event correctly', () => {
      const entry: NoestDiscoveryEntry = {
        OrderInfo: {
          id: '4',
          reference: 'NOE111',
          tracking: 'NOE111',
          status: 'In Transit',
        },
        status: 'in_transit',
        activity: [
          {
            event: 'Uploaded to system',
            event_key: 'upload',
            date: '2026-10-15 10:00:00',
          },
          {
            event: 'Package Picked Up',
            event_key: 'validation_collect_colis',
            date: '2026-10-16 08:00:00',
          },
          {
            event: 'Out for delivery',
            event_key: 'fdr_activated',
            date: '2026-10-17 11:00:00',
          },
        ],
      };

      const result = mapNoestDiscoveryEntry(entry, 'NOE111');

      expect(result.providerState).toBe('fdr_activated');
      expect(result.normalizedStatus).toBe('out_for_delivery');
      expect(result.timeline).toHaveLength(3);
      expect(result.situations).toContain('OUT_FOR_DELIVERY');
    });

    it('handles unknown event gracefully', () => {
      const entry: NoestDiscoveryEntry = {
        OrderInfo: {
          id: '5',
          reference: 'NOE999',
          tracking: 'NOE999',
          status: 'Unknown State',
        },
        status: 'mystery_state',
        activity: [
          {
            event: 'Mystery event',
            event_key: 'mystery_event',
            date: '2026-10-15 10:00:00',
          },
        ],
      };

      const result = mapNoestDiscoveryEntry(entry, 'NOE999');

      expect(result.providerState).toBe('mystery_event');
      expect(result.normalizedStatus).toBe('unknown');
      expect(result.situations).toEqual([]);
    });

    it('handles empty activity array', () => {
      const entry: NoestDiscoveryEntry = {
        OrderInfo: {
          id: '6',
          reference: 'NOE000',
          tracking: 'NOE000',
          status: 'Processing',
        },
        status: 'processing',
        activity: [],
      };

      const result = mapNoestDiscoveryEntry(entry, 'NOE000');

      expect(result.normalizedStatus).toBe('processing');
      expect(result.timeline).toHaveLength(0);
    });

    it('generates deterministic timeline IDs', () => {
      const entry: NoestDiscoveryEntry = {
        OrderInfo: {
          id: '7',
          reference: 'NOE222',
          tracking: 'NOE222',
          status: 'Delivered',
        },
        status: 'delivered',
        activity: [
          {
            event: 'Delivered',
            event_key: 'livre',
            date: '2026-10-18 16:00:00',
            by: 'Driver',
          },
        ],
      };

      const result1 = mapNoestDiscoveryEntry(entry, 'NOE222');
      const result2 = mapNoestDiscoveryEntry(entry, 'NOE222');

      expect(result1.timeline[0].providerEntryId).toBe(
        result2.timeline[0].providerEntryId,
      );
    });

    it('sorts activity oldest to newest', () => {
      const entry: NoestDiscoveryEntry = {
        OrderInfo: {
          id: '8',
          reference: 'NOE333',
          tracking: 'NOE333',
        },
        activity: [
          {
            event_key: 'livre',
            date: '2026-10-18 16:00:00',
          },
          {
            event_key: 'upload',
            date: '2026-10-15 10:00:00',
          },
          {
            event_key: 'fdr_activated',
            date: '2026-10-17 11:00:00',
          },
        ],
      };

      const result = mapNoestDiscoveryEntry(entry, 'NOE333');

      expect(result.timeline[0].event).toBe('upload');
      expect(result.timeline[1].event).toBe('fdr_activated');
      expect(result.timeline[2].event).toBe('livre');
    });

    it('handles missing event_key by falling back to event', () => {
      const entry: NoestDiscoveryEntry = {
        OrderInfo: {
          id: '9',
          tracking: 'NOE444',
        },
        activity: [
          {
            event: 'Uploaded to system',
            date: '2026-10-15 10:00:00',
          },
        ],
      };

      const result = mapNoestDiscoveryEntry(entry, 'NOE444');

      expect(result.timeline[0].event).toBe('Uploaded to system');
    });
  });

  describe('mapNoestHistoryResponse', () => {
    it('maps history response correctly', () => {
      const response: NoestHistoryResponseDto = {
        tracking: 'NOE555',
        status: 'delivered',
        history: [
          {
            event: 'Uploaded to system',
            event_key: 'upload',
            date: '2026-10-15 10:00:00',
          },
          {
            event: 'Delivered',
            event_key: 'livre',
            date: '2026-10-18 16:00:00',
          },
        ],
      };

      const result = mapNoestHistoryResponse(response);

      expect(result.providerState).toBe('livre');
      expect(result.normalizedStatus).toBe('delivered');
      expect(result.timeline).toHaveLength(2);
      expect(result.timeline[0].event).toBe('upload');
      expect(result.timeline[1].event).toBe('livre');
    });

    it('handles empty history array', () => {
      const response: NoestHistoryResponseDto = {
        tracking: 'NOE666',
        status: 'unknown',
        history: [],
      };

      const result = mapNoestHistoryResponse(response);

      expect(result.normalizedStatus).toBe('unknown');
      expect(result.timeline).toHaveLength(0);
    });

    it('sorts history oldest to newest', () => {
      const response: NoestHistoryResponseDto = {
        tracking: 'NOE777',
        history: [
          {
            event_key: 'livre',
            date: '2026-10-18 16:00:00',
          },
          {
            event_key: 'upload',
            date: '2026-10-15 10:00:00',
          },
        ],
      };

      const result = mapNoestHistoryResponse(response);

      expect(result.timeline[0].event).toBe('upload');
      expect(result.timeline[1].event).toBe('livre');
    });
  });
});
