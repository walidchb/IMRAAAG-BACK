import type { CarrierStatusProfile } from './carrier-profile';
import { ZR_STATUS_PROFILE } from '../../delivery-companies/handlers/zr-express/zr-status.profile';
import { ECOM_STATUS_PROFILE } from '../../delivery-companies/handlers/ecom/ecom-status.profile';
import { DHD_STATUS_PROFILE } from '../../delivery-companies/handlers/dhd/dhd-status.profile';
import { NOEST_STATUS_PROFILE } from '../../delivery-companies/handlers/noest/noest-status.profile';

/** Kept for the pre-provider-neutral call sites and tests. */
export const DEFAULT_CARRIER_COMPANY_ID = 'zr-express';

const profiles = new Map<string, CarrierStatusProfile>();

export function registerCarrierProfile(profile: CarrierStatusProfile): void {
  profiles.set(profile.companyId, profile);
}

export function getCarrierProfile(companyId: unknown): CarrierStatusProfile | null {
  if (!companyId) return null;
  return profiles.get(String(companyId).trim().toLowerCase()) ?? null;
}

export function requireCarrierProfile(companyId: unknown): CarrierStatusProfile {
  const profile = getCarrierProfile(companyId);
  if (!profile) {
    throw new Error(`No carrier status profile registered for "${String(companyId)}"`);
  }
  return profile;
}

export function listCarrierProfiles(): CarrierStatusProfile[] {
  return [...profiles.values()];
}

export function isKnownCarrier(companyId: unknown): boolean {
  return getCarrierProfile(companyId) !== null;
}

registerCarrierProfile(ZR_STATUS_PROFILE);
registerCarrierProfile(ECOM_STATUS_PROFILE);
registerCarrierProfile(DHD_STATUS_PROFILE);
registerCarrierProfile(NOEST_STATUS_PROFILE);
