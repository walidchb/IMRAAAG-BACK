import { NOEST_STATUS_PROFILE } from './noest-status.profile';
import type { DeliveryStatusParcel } from '../../interfaces/delivery-company-handler.interface';

describe('NoestStatusProfile', () => {
  describe('normalizeState', () => {
    it('normalizes upload to processing', () => {
      const result = NOEST_STATUS_PROFILE.normalizeState('upload');
      expect(result).toBe('processing');
    });

    it('normalizes livre to delivered', () => {
      const result = NOEST_STATUS_PROFILE.normalizeState('livre');
      expect(result).toBe('delivered');
    });

    it('normalizes return_asked_by_customer to returned', () => {
      const result = NOEST_STATUS_PROFILE.normalizeState('return_asked_by_customer');
      expect(result).toBe('returned');
    });

    it('applies overrides when provided', () => {
      const result = NOEST_STATUS_PROFILE.normalizeState('upload', {
        upload: 'ready_for_pickup',
      });
      expect(result).toBe('ready_for_pickup');
    });

    it('falls back to default when override value is unknown', () => {
      const result = NOEST_STATUS_PROFILE.normalizeState('upload', {
        upload: 'invalid_value',
      });
      expect(result).toBe('processing');
    });
  });

  describe('isTerminalState', () => {
    it('returns true for livre (delivered)', () => {
      expect(NOEST_STATUS_PROFILE.isTerminalState('livre')).toBe(true);
    });

    it('returns true for livred (delivered typo)', () => {
      expect(NOEST_STATUS_PROFILE.isTerminalState('livred')).toBe(true);
    });

    it('returns false for upload (processing)', () => {
      expect(NOEST_STATUS_PROFILE.isTerminalState('upload')).toBe(false);
    });

    it('returns false for fdr_activated (in_transit)', () => {
      expect(NOEST_STATUS_PROFILE.isTerminalState('fdr_activated')).toBe(false);
    });
  });

  describe('detectSignal', () => {
    const parcelWith = (carrierStateName: string): DeliveryStatusParcel => ({
      parcelId: carrierStateName,
      externalId: null,
      trackingNumber: carrierStateName,
      deliveryStatus: 'unknown',
      carrierStateId: null,
      carrierStateName,
      carrierStateDescription: null,
      carrierStateRank: null,
      carrierStateLocked: null,
      terminal: false,
      situationFlags: [],
      lastStateUpdateAt: null,
      deliveryType: null,
      situation: null,
      rawSituation: null,
      raw: null,
    });

    it('returns delivered signal for livre state', () => {
      const result = NOEST_STATUS_PROFILE.detectSignal(parcelWith('livre'));

      expect(result.signal).toBe('delivered');
      expect(result.source).toBe('situation');
    });

    it('returns returned signal for return_asked_by_customer', () => {
      const result = NOEST_STATUS_PROFILE.detectSignal(
        parcelWith('return_asked_by_customer'),
      );

      expect(result.signal).toBe('returned');
      expect(result.source).toBe('situation');
    });

    it('returns cancelled signal for ask_to_delete_by_admin', () => {
      const result = NOEST_STATUS_PROFILE.detectSignal(
        parcelWith('ask_to_delete_by_admin'),
      );

      expect(result.signal).toBe('cancelled');
      expect(result.source).toBe('situation');
    });

    it('returns in_transit signal for fdr_activated', () => {
      const result = NOEST_STATUS_PROFILE.detectSignal(parcelWith('fdr_activated'));

      expect(result.signal).toBe('in_transit');
      expect(result.source).toBe('state');
    });

    it('returns none signal for upload (processing)', () => {
      const result = NOEST_STATUS_PROFILE.detectSignal(parcelWith('upload'));

      expect(result.signal).toBe('none');
      expect(result.source).toBe('state');
    });

    it('respects signal overrides', () => {
      const result = NOEST_STATUS_PROFILE.detectSignal(
        parcelWith('livre'),
        null,
        { livre: 'none' },
      );

      expect(result.signal).toBe('none');
      expect(result.source).toBe('override');
    });

    it('prioritizes returned over delivered', () => {
      const result = NOEST_STATUS_PROFILE.detectSignal(
        parcelWith('return_dispatched_to_partenaire'),
      );

      expect(result.signal).toBe('returned');
    });

    it('prioritizes cancelled over delivered', () => {
      const result = NOEST_STATUS_PROFILE.detectSignal(
        parcelWith('annulation_dispatch_retour'),
      );

      expect(result.signal).toBe('cancelled');
    });
  });

  describe('flagsForSituations', () => {
    it('returns empty array for empty situations', () => {
      const result = NOEST_STATUS_PROFILE.flagsForSituations([]);
      expect(result).toEqual([]);
    });

    it('derives postponed flag from suspendu', () => {
      const result = NOEST_STATUS_PROFILE.flagsForSituations([
        { name: 'Colis suspendu', slug: 'colis_suspendu' },
      ]);

      expect(result).toContain('postponed');
    });

    it('derives unreachable flag', () => {
      const result = NOEST_STATUS_PROFILE.flagsForSituations([
        { name: 'Client injoignable', slug: 'unreachable' },
      ]);

      expect(result).toContain('unreachable');
    });

    it('derives customer_cancelled flag', () => {
      const result = NOEST_STATUS_PROFILE.flagsForSituations([
        { name: 'Annulation', slug: 'cancel' },
      ]);

      expect(result).toContain('customer_cancelled');
    });

    it('derives pickup flags', () => {
      const result = NOEST_STATUS_PROFILE.flagsForSituations([
        { name: 'Retrait en StopDesk', slug: 'pickup' },
      ]);

      expect(result).toContain('redirected_to_pickup');
      expect(result).toContain('awaiting_pickup');
    });

    it('marks situation as raw when no specific flag matches', () => {
      const result = NOEST_STATUS_PROFILE.flagsForSituations([
        { name: 'Unknown situation', slug: 'unknown' },
      ]);

      expect(result).toContain('raw');
    });

    it('returns empty array for null/empty situation', () => {
      const result = NOEST_STATUS_PROFILE.flagsForSituations([
        { name: null, slug: null },
      ]);

      expect(result).toEqual([]);
    });
  });

  describe('deliverySignalForStatus', () => {
    it('returns delivered for livre', () => {
      const result = NOEST_STATUS_PROFILE.deliverySignalForStatus?.('livre');
      expect(result).toBe('delivered');
    });

    it('returns delivered for livred', () => {
      const result = NOEST_STATUS_PROFILE.deliverySignalForStatus?.('livred');
      expect(result).toBe('delivered');
    });

    it('returns in_transit for fdr_activated', () => {
      const result = NOEST_STATUS_PROFILE.deliverySignalForStatus?.('fdr_activated');
      expect(result).toBe('in_transit');
    });

    it('returns cancelled for ask_to_delete_by_admin', () => {
      const result = NOEST_STATUS_PROFILE.deliverySignalForStatus?.('ask_to_delete_by_admin');
      expect(result).toBe('cancelled');
    });

    it('returns returned for return_asked_by_customer', () => {
      const result = NOEST_STATUS_PROFILE.deliverySignalForStatus?.('return_asked_by_customer');
      expect(result).toBe('returned');
    });

    it('returns none for upload (processing)', () => {
      const result = NOEST_STATUS_PROFILE.deliverySignalForStatus?.('upload');
      expect(result).toBe('none');
    });
  });

  describe('profile metadata', () => {
    it('has correct company ID', () => {
      expect(NOEST_STATUS_PROFILE.companyId).toBe('noest');
    });

    it('has correct display name', () => {
      expect(NOEST_STATUS_PROFILE.displayName).toBe('Noest Express');
    });

    it('has correct history user', () => {
      expect(NOEST_STATUS_PROFILE.historyUser).toBe('Noest Express');
    });

    it('has correct system actor', () => {
      expect(NOEST_STATUS_PROFILE.systemActor).toBe('noest-status-sync');
    });
  });
});
