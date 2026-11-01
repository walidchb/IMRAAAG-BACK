export interface DhdCommuneSelection {
  /** DHD commune name (nom), sent verbatim as `commune` in dispatch payloads. */
  name: string;
  /** DHD numeric wilaya ID normalized as a 1-2 digit string (e.g. "5"). */
  wilayaId: string;
  /** Optional DHD postal code (code_postal). */
  postalCode?: string | null;
  /** Whether DHD supports stop-desk pickup for this commune. */
  hasStopDesk?: boolean;
  /** Audit timestamp of when this selection was made/updated. */
  selectedAt?: Date | string | null;
  /** Actor user ID who made the selection. */
  selectedBy?: string | null;
}

export interface DhdCommuneOption {
  name: string;
  wilayaId: string;
  postalCode: string | null;
  hasStopDesk: boolean;
}

export function isDhdMappingRequired(order: { deliveryCompanyId?: string | null }): boolean {
  return order.deliveryCompanyId === 'dhd';
}

export function isDhdMappingValid(order: {
  customer?: { wilaya?: string | null } | null;
  dhdCommune?: DhdCommuneSelection | null;
}): boolean {
  const sel = order.dhdCommune;
  if (!sel?.name?.trim()) return false;
  const selWilaya = Number(sel.wilayaId);
  const orderWilaya = Number(order.customer?.wilaya);
  if (!Number.isFinite(selWilaya) || !Number.isFinite(orderWilaya)) return false;
  return selWilaya === orderWilaya;
}

export function isDhdDispatchable(order: {
  deliveryCompanyId?: string | null;
  customer?: { wilaya?: string | null } | null;
  dhdCommune?: DhdCommuneSelection | null;
  shippingMethod?: string | null;
}): boolean {
  if (order.deliveryCompanyId !== 'dhd') return true;
  if (!isDhdMappingValid(order)) return false;
  if (order.shippingMethod === 'stopdesk' && order.dhdCommune?.hasStopDesk !== true) {
    return false;
  }
  return true;
}

export function normalizeDhdCommuneSelection(
  input: {
    name?: string | null;
    wilayaId?: string | number | null;
    postalCode?: string | null;
    hasStopDesk?: boolean | null;
  },
  actorUserId?: string | null,
  now: Date = new Date(),
): DhdCommuneSelection | null {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return null;

  if (input.wilayaId === null || input.wilayaId === undefined || input.wilayaId === '') {
    return null;
  }
  const numWilaya = Number(input.wilayaId);
  if (!Number.isFinite(numWilaya) || numWilaya < 1 || numWilaya > 58) {
    return null;
  }
  const wilayaId = String(Math.floor(numWilaya));
  const postalCode = typeof input.postalCode === 'string' ? input.postalCode.trim() : '';

  return {
    name,
    wilayaId,
    postalCode: postalCode || null,
    hasStopDesk: input.hasStopDesk === true,
    selectedAt: now,
    selectedBy: actorUserId ?? null,
  };
}
