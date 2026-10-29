import type {
  CarrierStatusProfile,
  CarrierSituationInput,
} from '../../../delivery-status/carrier/carrier-profile';
import {
  DELIVERED_NORMALIZED_STATUSES,
  IN_TRANSIT_NORMALIZED_STATUSES,
} from '../../../delivery-status/carrier/carrier-signal';
import type {
  CarrierOrderSignal,
  SituationFlag,
} from '../../../delivery-status/carrier/carrier-signal';
import type {
  DeliveryStatusEntry,
  DeliveryStatusParcel,
} from '../../interfaces/delivery-company-handler.interface';
import {
  detectEcomOrderSignal,
  ecomSituationFlags,
  isEcomTerminalStatus,
  normalizeEcomStatus,
} from './ecom-status.mapper';
import type { EcomHistoryEntryDto, EcomParcelDto } from './ecom-status.types';

function parcelDto(parcel: DeliveryStatusParcel): EcomParcelDto {
  const raw = parcel.raw;
  if (raw && typeof raw === 'object') return raw as EcomParcelDto;
  return {
    tracking: parcel.trackingNumber ?? parcel.parcelId,
    id_externe: parcel.externalId,
    situation: parcel.situation?.name ?? null,
    etat_logistique: parcel.carrierStateDescription,
    date_action: parcel.lastStateUpdateAt?.toISOString() ?? null,
  };
}

function historyDto(entry: DeliveryStatusEntry): EcomHistoryEntryDto {
  const raw = entry.raw;
  if (raw && typeof raw === 'object') return raw as EcomHistoryEntryDto;
  return {
    date: entry.at?.toISOString() ?? null,
    situation: entry.toState,
    commentaire: entry.comment,
    ville: entry.hubCity,
  };
}

/** Ecom Delivery's contribution to the provider-neutral status engine. */
export const ECOM_STATUS_PROFILE: CarrierStatusProfile = {
  companyId: 'ecom-delivery',
  displayName: 'Ecom Delivery',
  historyUser: 'Ecom Delivery',
  systemActor: 'ecom-delivery-sync',

  normalizeState: (state, overrides) => normalizeEcomStatus(state, overrides),
  isTerminalState: (state) => isEcomTerminalStatus(normalizeEcomStatus(state)),

  detectSignal: (parcel, history, overrides) =>
    detectEcomOrderSignal(
      parcelDto(parcel),
      (history ?? []).map(historyDto),
      overrides,
    ),

  flagsForSituations: (situations: readonly CarrierSituationInput[]): SituationFlag[] =>
    situations.flatMap((situation) =>
      ecomSituationFlags(
        situation.name ?? situation.slug ?? null,
        situation.description ?? null,
      ),
    ),

  deliverySignalForStatus: (status): CarrierOrderSignal => {
    const normalized = String(status ?? '').trim().toLowerCase();
    if (DELIVERED_NORMALIZED_STATUSES.includes(normalized as never)) return 'delivered';
    if (IN_TRANSIT_NORMALIZED_STATUSES.includes(normalized as never)) return 'in_transit';
    if (normalized === 'cancelled') return 'cancelled';
    if (normalized === 'returned') return 'returned';
    return 'none';
  },
};
