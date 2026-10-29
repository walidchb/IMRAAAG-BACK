import type { CarrierStatusProfile, CarrierSituationInput } from '../../../delivery-status/carrier/carrier-profile';
import type { SituationFlag } from '../../../delivery-status/carrier/carrier-signal';
import type { ZrSituationDto, ZrSituationHistoryDto } from './zr-status.types';
import {
  detectCarrierOrderSignal,
  flagsForSituations,
  isTerminalCarrierState,
  normalizeCarrierState,
} from './zr-status.mapper';

/** ZR Express's contribution to the provider-neutral status engine. */
export const ZR_STATUS_PROFILE: CarrierStatusProfile = {
  companyId: 'zr-express',
  displayName: 'ZR Express',
  historyUser: 'ZR Express',
  systemActor: 'zr-express-sync',

  normalizeState: (state, overrides) => normalizeCarrierState(state, overrides),
  isTerminalState: (state) => isTerminalCarrierState(state),

  detectSignal: (parcel, history, overrides) =>
    detectCarrierOrderSignal(parcel, history, overrides),

  flagsForSituations: (situations: readonly CarrierSituationInput[]): SituationFlag[] =>
    flagsForSituations(
      situations.map(
        (situation): ZrSituationDto | ZrSituationHistoryDto => ({
          situationSlug: situation.slug ?? null,
          situationName: situation.name ?? null,
          situationDescription: situation.description ?? null,
        }),
      ),
    ),
};
