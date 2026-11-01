/**
 * Noest Express commune mapping predicates and normalizers.
 *
 * Noest publishes no commune UUID: a commune is identified by `{ nom, wilaya_id }`. These helpers
 * mirror `dhd-commune.ts` one for one, minus the stop-desk rule — Noest exposes no per-commune
 * stop-desk capability, so there is nothing to gate on.
 */

export interface NoestCommuneSelection {
  /** Noest commune name (`nom`), sent verbatim as `commune` in dispatch payloads. */
  name: string;
  /** Noest numeric wilaya id normalised as a 1-2 digit string (e.g. "5"). */
  wilayaId: string;
  /** Noest postal code (`code_postal`). Display/audit only — never sent to Noest. */
  postalCode?: string | null;
  /** Audit timestamp of when this selection was made/updated. */
  selectedAt?: Date | string | null;
  /** Actor user ID who made the selection. */
  selectedBy?: string | null;
}

export interface NoestCommuneOption {
  name: string;
  wilayaId: string;
  postalCode: string | null;
}

export function isNoestMappingRequired(order: { deliveryCompanyId?: string | null }): boolean {
  return order.deliveryCompanyId === 'noest';
}

/**
 * A selection is valid only when it names a commune and its wilaya matches the order's current
 * wilaya. Noest identifies communes by `{ nom, wilaya_id }`, so the pair is the identity.
 */
export function isNoestMappingValid(order: {
  customer?: { wilaya?: string | null } | null;
  noestCommune?: NoestCommuneSelection | null;
}): boolean {
  const sel = order.noestCommune;
  if (!sel?.name?.trim()) return false;
  const selWilaya = Number(sel.wilayaId);
  const orderWilaya = Number(order.customer?.wilaya);
  if (!Number.isFinite(selWilaya) || !Number.isFinite(orderWilaya)) return false;
  return selWilaya === orderWilaya;
}

/**
 * Dispatchability. `registryName` is the commune's `noestexpress_uuid`, resolved by the caller
 * (backend) or read from the loaded territories (frontend). Deliberately NO stop-desk rule:
 * Noest publishes no per-commune stop-desk capability.
 */
export function isNoestDispatchable(
  order: {
    deliveryCompanyId?: string | null;
    customer?: { wilaya?: string | null } | null;
    noestCommune?: NoestCommuneSelection | null;
  },
  registryName?: string | null,
): boolean {
  if (order.deliveryCompanyId !== 'noest') return true;
  if (isNoestMappingValid(order)) return true;
  return !!registryName?.trim();
}

/**
 * Validates and stamps a client-supplied selection. Audit fields are server-owned: the client may
 * only send `name`, `wilayaId` and `postalCode`. Returns `null` for anything unusable, which the
 * caller turns into `DELIVERY_COMMUNE_INVALID`.
 */
export function normalizeNoestCommuneSelection(
  input: { name?: string | null; wilayaId?: string | number | null; postalCode?: string | null },
  actorUserId?: string | null,
  now: Date = new Date(),
): NoestCommuneSelection | null {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return null;

  if (input.wilayaId === null || input.wilayaId === undefined || input.wilayaId === '') {
    return null;
  }
  const numWilaya = Number(input.wilayaId);
  if (!Number.isFinite(numWilaya) || numWilaya < 1 || numWilaya > 58) {
    return null;
  }

  const postalCode = typeof input.postalCode === 'string' ? input.postalCode.trim() : '';

  return {
    name,
    wilayaId: String(Math.floor(numWilaya)),
    postalCode: postalCode || null,
    selectedAt: now,
    selectedBy: actorUserId ?? null,
  };
}
