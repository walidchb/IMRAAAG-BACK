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
  detectDhdOrderSignal,
  dhdSituationFlags,
  isDhdTerminalStatus,
  normalizeDhdStatus,
} from './dhd-status.mapper';
import type { DhdActivityDto, DhdParcelDto } from './dhd-status.types';

function parcelDto(parcel: DeliveryStatusParcel): DhdParcelDto {
  const raw = parcel.raw;
  if (raw && typeof raw === 'object') {
    const dto = raw as DhdParcelDto;
    if (!dto.tracking) dto.tracking = parcel.trackingNumber ?? parcel.parcelId;
    if (!dto.status) dto.status = parcel.carrierStateDescription ?? parcel.carrierStateName;
    return dto;
  }
  return {
    tracking: parcel.trackingNumber ?? parcel.parcelId,
    reference: parcel.externalId,
    status: parcel.carrierStateDescription ?? parcel.carrierStateName,
  };
}

function historyDto(entry: DeliveryStatusEntry): DhdActivityDto {
  const raw = entry.raw;
  if (raw && typeof raw === 'object') return raw as DhdActivityDto;
  return {
    date: entry.at?.toISOString() ?? null,
    status: entry.toState,
    station: entry.hubName,
    driver: entry.modifiedBy,
    details: entry.comment,
  };
}

export const DHD_STATUS_PROFILE: CarrierStatusProfile = {
  companyId: 'dhd',
  displayName: 'DHD',
  historyUser: 'DHD',
  systemActor: 'dhd-status-sync',

  normalizeState: (state, overrides) => normalizeDhdStatus(state, overrides),
  isTerminalState: (state) => isDhdTerminalStatus(normalizeDhdStatus(state)),

  detectSignal: (parcel, history, signalOverrides) =>
    detectDhdOrderSignal(
      parcelDto(parcel),
      (history ?? []).map(historyDto),
      signalOverrides,
    ),

  flagsForSituations: (situations: readonly CarrierSituationInput[]): SituationFlag[] =>
    situations.flatMap((situation) =>
      dhdSituationFlags(
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
