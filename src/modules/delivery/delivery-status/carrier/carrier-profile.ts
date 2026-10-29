import type {
  CarrierOrderSignal,
  DetectedCarrierOrderSignal,
  NormalizedDeliveryStatus,
  SignalOverrides,
  SituationFlag,
  StateOverrides,
} from './carrier-signal';
import type {
  DeliveryStatusEntry,
  DeliveryStatusParcel,
} from '../../delivery-companies/interfaces/delivery-company-handler.interface';

export interface CarrierSituationInput {
  slug?: string | null;
  name?: string | null;
  description?: string | null;
}

/**
 * Everything the poller, the read view and the advance path need from a carrier.
 *
 * The profile is pure: it reads no database, holds no credentials and performs no I/O. A
 * provider contributes one profile plus an optional handler status capability.
 */
export interface CarrierStatusProfile {
  companyId: string;
  displayName: string;
  historyUser: string;
  systemActor: string;
  normalizeState(state: unknown, overrides?: StateOverrides | null): NormalizedDeliveryStatus;
  isTerminalState(state: unknown): boolean;
  detectSignal(
    parcel: DeliveryStatusParcel,
    history?: readonly DeliveryStatusEntry[] | null,
    signalOverrides?: SignalOverrides | null,
  ): DetectedCarrierOrderSignal;
  flagsForSituations(situations: readonly CarrierSituationInput[]): SituationFlag[];
  deliverySignalForStatus?(status: unknown): CarrierOrderSignal;
}
