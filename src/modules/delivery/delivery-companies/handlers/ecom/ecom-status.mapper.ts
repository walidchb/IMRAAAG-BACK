import { createHash } from 'crypto';
import {
  CARRIER_ORDER_SIGNALS,
  CARRIER_SIGNAL_PRIORITY,
  DELIVERED_NORMALIZED_STATUSES,
  IN_TRANSIT_NORMALIZED_STATUSES,
  NORMALIZED_STATUSES,
  applySignalOverride,
  normalizeText,
} from '../../../delivery-status/carrier/carrier-signal';
import type {
  CarrierOrderSignal,
  CarrierSignalSource,
  DetectedCarrierOrderSignal,
  NormalizedDeliveryStatus,
  SignalOverrides,
  StateOverrides,
} from '../../../delivery-status/carrier/carrier-signal';
import { EcomHistoryEntryDto, EcomParcelDto } from './ecom-status.types';

export type EcomSituationFlag =
  | 'customer_cancelled'
  | 'unreachable'
  | 'no_answer'
  | 'call_attempt'
  | 'address_issue'
  | 'postponed'
  | 'redirected_to_pickup'
  | 'awaiting_pickup'
  | 'sms_sent';

export interface EcomStatusRule {
  key: string;
  label: string;
  normalized: NormalizedDeliveryStatus;
  signal: CarrierOrderSignal;
  terminal: boolean;
  unresolved?: boolean;
}

export const ECOM_STATUS_RULES: readonly EcomStatusRule[] = [
  {
    key: 'encours',
    label: 'EnCours',
    normalized: 'processing',
    signal: 'none',
    terminal: false,
  },
  {
    key: 'en traitement',
    label: 'En Traitement',
    normalized: 'processing',
    signal: 'none',
    terminal: false,
  },
  {
    key: 'commande confirmee',
    label: 'Commande Confirmée',
    normalized: 'customer_confirmed',
    signal: 'none',
    terminal: false,
  },
  {
    key: 'en preparation',
    label: 'En Préparation',
    normalized: 'preparing',
    signal: 'none',
    terminal: false,
  },
  {
    key: 'au bureau',
    label: 'Au Bureau',
    normalized: 'at_pickup_point',
    signal: 'in_transit',
    terminal: false,
  },
  {
    key: 'en livraison',
    label: 'En livraison',
    normalized: 'out_for_delivery',
    signal: 'in_transit',
    terminal: false,
  },
  {
    key: 'sortir en livraison',
    label: 'Sortir en livraison',
    normalized: 'with_courier',
    signal: 'in_transit',
    terminal: false,
  },
  {
    key: 'sortie en livraison',
    label: 'Sortie en livraison',
    normalized: 'with_courier',
    signal: 'in_transit',
    terminal: false,
  },
  {
    key: 'livree',
    label: 'Livrée',
    normalized: 'delivered',
    signal: 'delivered',
    terminal: true,
  },
  {
    key: 'recuperer',
    label: 'Récupérer',
    normalized: 'unknown',
    signal: 'none',
    terminal: false,
    unresolved: true,
  },
  {
    key: 'encaisser',
    label: 'Encaisser',
    normalized: 'cash_collected',
    signal: 'delivered',
    terminal: true,
  },
  {
    key: 'recouvert',
    label: 'Recouvert',
    normalized: 'settled',
    signal: 'delivered',
    terminal: true,
  },
] as const;

export const ECOM_STATUS_RULES_BY_KEY: Readonly<Record<string, EcomStatusRule>> =
  Object.fromEntries(ECOM_STATUS_RULES.map((rule) => [rule.key, rule]));

export const ECOM_UNRESOLVED_LABELS: readonly string[] = ['recuperer'] as const;

export const ECOM_CANCELLED_PATTERNS: readonly string[] = [
  'annul',
  'annule',
  'annulee',
  'cancel',
  'supprim',
] as const;

export const ECOM_RETURN_PATTERNS: readonly string[] = [
  'retour',
  'retourn',
  'renvoy',
  'reinject',
  'restit',
  'refus',
] as const;

export const ECOM_SITUATION_FLAG_BY_PHRASE: readonly {
  flag: EcomSituationFlag;
  phrases: string[];
}[] = [
  { flag: 'no_answer', phrases: ['ne repond', 'ne reponde'] },
  { flag: 'unreachable', phrases: ['injoignable'] },
  { flag: 'customer_cancelled', phrases: ['commande annulee'] },
  { flag: 'call_attempt', phrases: ['appel telephonique'] },
  { flag: 'address_issue', phrases: ['commune erronee', 'adresse erronee'] },
  { flag: 'postponed', phrases: ['reporte', 'reportee', 'reporter'] },
  { flag: 'redirected_to_pickup', phrases: ['changement bureau'] },
  { flag: 'awaiting_pickup', phrases: ['en attente'] },
  { flag: 'sms_sent', phrases: ['sms envoye'] },
] as const;

export const ECOM_SITUATION_FLAGS: readonly EcomSituationFlag[] = [
  'customer_cancelled',
  'unreachable',
  'no_answer',
  'call_attempt',
  'address_issue',
  'postponed',
  'redirected_to_pickup',
  'awaiting_pickup',
  'sms_sent',
] as const;

function matchesToken(value: unknown, patterns: readonly string[]): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  return patterns.some((pattern) => text.includes(normalizeText(pattern)));
}

export function ecomStatusRule(value: unknown): EcomStatusRule | null {
  const key = normalizeText(value);
  if (!key) return null;
  return ECOM_STATUS_RULES_BY_KEY[key] ?? null;
}

export function ecomSituationFlags(value: unknown, comment?: unknown): EcomSituationFlag[] {
  const text = `${normalizeText(value)} ${normalizeText(comment)}`.trim();
  if (!text) return [];
  const flags: EcomSituationFlag[] = [];
  for (const rule of ECOM_SITUATION_FLAG_BY_PHRASE) {
    if (rule.phrases.some((phrase) => text.includes(normalizeText(phrase)))) {
      flags.push(rule.flag);
    }
  }
  return flags;
}

function overrideKeys(label: unknown, id?: unknown): string[] {
  const keys: string[] = [];
  const normalizedLabel = normalizeText(label);
  if (normalizedLabel) keys.push(normalizedLabel);
  if (id !== undefined && id !== null && String(id).trim()) keys.push(String(id).trim());
  return keys;
}

function lookupOverride(keys: readonly string[], overrides?: Readonly<Record<string, string>> | null): string | null {
  if (!overrides) return null;
  for (const key of keys) {
    const value = overrides[key];
    if (value !== undefined && value !== null) return String(value).trim().toLowerCase();
  }
  return null;
}

export function applyEcomStateOverride(
  label: unknown,
  overrides?: StateOverrides | null,
  id?: unknown,
): NormalizedDeliveryStatus | null {
  const target = lookupOverride(overrideKeys(label, id), overrides);
  if (!target) return null;
  if (!NORMALIZED_STATUSES.includes(target as NormalizedDeliveryStatus)) return null;
  return target as NormalizedDeliveryStatus;
}

export function applyEcomSignalOverride(
  label: unknown,
  overrides?: SignalOverrides | null,
  id?: unknown,
): CarrierOrderSignal | null {
  const target = lookupOverride(overrideKeys(label, id), overrides);
  if (!target) return null;
  if (!CARRIER_ORDER_SIGNALS.includes(target as CarrierOrderSignal)) return null;
  return target as CarrierOrderSignal;
}

export function normalizeEcomStatus(
  label: unknown,
  overrides?: StateOverrides | null,
  id?: unknown,
): NormalizedDeliveryStatus {
  const override = applyEcomStateOverride(label, overrides, id);
  if (override) return override;
  if (matchesToken(label, ECOM_RETURN_PATTERNS)) return 'returned';
  if (matchesToken(label, ECOM_CANCELLED_PATTERNS)) return 'cancelled';
  return ecomStatusRule(label)?.normalized ?? 'unknown';
}

export function ecomSignalForLabel(label: unknown): CarrierOrderSignal {
  if (matchesToken(label, ECOM_RETURN_PATTERNS)) return 'returned';
  if (matchesToken(label, ECOM_CANCELLED_PATTERNS)) return 'cancelled';
  return ecomStatusRule(label)?.signal ?? 'none';
}

export function isEcomTerminalStatus(status: unknown): boolean {
  return (
    status === 'delivered' ||
    status === 'cash_collected' ||
    status === 'settled' ||
    status === 'cancelled' ||
    status === 'returned'
  );
}

function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function newestHistoryEntry(
  history?: readonly EcomHistoryEntryDto[] | null,
): EcomHistoryEntryDto | null {
  if (!history || history.length === 0) return null;
  let newest: EcomHistoryEntryDto | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const entry of history) {
    const at = parseDate(entry.date)?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (newest === null || at >= newestAt) {
      newest = entry;
      newestAt = at;
    }
  }
  return newest;
}

function signalFromText(label: unknown, source: CarrierSignalSource): DetectedCarrierOrderSignal | null {
  const signal = ecomSignalForLabel(label);
  if (signal === 'none') return null;
  return { signal, source };
}

export function detectEcomOrderSignal(
  parcel: EcomParcelDto,
  history?: readonly EcomHistoryEntryDto[] | null,
  signalOverrides?: SignalOverrides | null,
): DetectedCarrierOrderSignal {
  const entries = history ?? parcel.historique ?? null;
  const currentAt = parseDate(parcel.date_action);
  const newest = newestHistoryEntry(entries);
  const newestAt = parseDate(newest?.date);
  const useHistory = Boolean(newest && currentAt && newestAt && newestAt.getTime() > currentAt.getTime());

  const candidates: DetectedCarrierOrderSignal[] = [];

  if (useHistory && newest) {
    const signal = signalFromText(newest.situation, 'situation');
    if (signal) candidates.push(signal);

    const flags = ecomSituationFlags(newest.situation, newest.commentaire);
    if (flags.includes('customer_cancelled')) {
      candidates.push({ signal: 'cancelled', source: 'situation' });
    }

    const override = applyEcomSignalOverride(newest.situation, signalOverrides);
    if (override && override !== 'none') {
      candidates.push({ signal: override, source: 'override' });
    }
  } else {
    for (const [label, id, source] of [
      [parcel.etat_logistique, parcel.id_etat_logistique, 'state'],
      [parcel.situation, parcel.id_situation, 'situation'],
    ] as const) {
      const signal = signalFromText(label, source);
      if (signal) candidates.push(signal);

      const flags = ecomSituationFlags(label);
      if (flags.includes('customer_cancelled')) {
        candidates.push({ signal: 'cancelled', source: 'situation' });
      }

      const override = applyEcomSignalOverride(label, signalOverrides, id);
      if (override && override !== 'none') {
        candidates.push({ signal: override, source: 'override' });
      }
    }

    if (parcel.encaisser === true || parcel.recouvert === true) {
      candidates.push({ signal: 'delivered', source: 'state' });
    }
  }

  for (const signal of CARRIER_SIGNAL_PRIORITY) {
    if (signal === 'none') continue;
    const match = candidates.find((candidate) => candidate.signal === signal);
    if (match) return match;
  }

  return { signal: 'none', source: 'none' };
}

export interface MappedEcomSituation {
  slug: string | null;
  name: string | null;
  description: string | null;
  flags: EcomSituationFlag[];
  raw: EcomHistoryEntryDto;
}

export interface MappedEcomParcel {
  parcelId: string;
  externalId: string | null;
  trackingNumber: string | null;
  deliveryStatus: NormalizedDeliveryStatus;
  carrierStateId: string | null;
  carrierStateName: string | null;
  carrierStateDescription: string | null;
  carrierStateRank: number | null;
  carrierStateLocked: boolean | null;
  carrierStateBlocking: boolean | null;
  terminal: boolean;
  situationFlags: EcomSituationFlag[];
  rawSituation: Record<string, unknown> | null;
  deliveryType: string | null;
  lastStateUpdateAt: Date | null;
  createdAt: Date | null;
  raw: EcomParcelDto;
}

export interface MappedEcomHistoryEntry {
  providerEntryId: string;
  parcelId: string | null;
  fromState: string | null;
  toState: string | null;
  fromStatus: NormalizedDeliveryStatus;
  toStatus: NormalizedDeliveryStatus;
  at: Date | null;
  comment: string | null;
  hubName: string | null;
  hubCity: string | null;
  hubDistrict: string | null;
  modifiedBy: string | null;
  situations: MappedEcomSituation[];
  raw: EcomHistoryEntryDto;
}

export function mapEcomParcel(
  dto: EcomParcelDto,
  overrides?: StateOverrides | null,
): MappedEcomParcel {
  const logisticStatus = normalizeEcomStatus(
    dto.etat_logistique,
    overrides,
    dto.id_etat_logistique,
  );
  const situationStatus = normalizeEcomStatus(
    dto.situation,
    overrides,
    dto.id_situation,
  );

  const deliveryStatus: NormalizedDeliveryStatus =
    logisticStatus === 'returned' || logisticStatus === 'cancelled'
      ? logisticStatus
      : situationStatus === 'returned' || situationStatus === 'cancelled'
        ? situationStatus
        : logisticStatus !== 'unknown'
          ? logisticStatus
          : situationStatus;

  const primaryLabel = dto.etat_logistique || dto.situation || null;
  const primaryKey = normalizeText(primaryLabel) || null;
  const newest = newestHistoryEntry(dto.historique);
  const lastStateUpdateAt =
    parseDate(dto.date_action) ?? parseDate(newest?.date) ?? null;

  return {
    parcelId: dto.tracking ? String(dto.tracking) : '',
    externalId: dto.id_externe ?? null,
    trackingNumber: dto.tracking ?? null,
    deliveryStatus,
    carrierStateId:
      dto.id_etat_logistique !== null && dto.id_etat_logistique !== undefined
        ? String(dto.id_etat_logistique)
        : dto.id_situation !== null && dto.id_situation !== undefined
          ? String(dto.id_situation)
          : null,
    carrierStateName: primaryKey,
    carrierStateDescription: primaryLabel,
    carrierStateRank: null,
    carrierStateLocked: null,
    carrierStateBlocking: null,
    terminal: isEcomTerminalStatus(deliveryStatus),
    situationFlags: ecomSituationFlags(dto.situation),
    rawSituation: {
      situation: dto.situation ?? null,
      id_situation: dto.id_situation ?? null,
      etat_logistique: dto.etat_logistique ?? null,
      id_etat_logistique: dto.id_etat_logistique ?? null,
      encaisser: dto.encaisser ?? null,
      recouvert: dto.recouvert ?? null,
    },
    deliveryType:
      dto.stopdesk === 1 || dto.stopdesk === true
        ? 'pickup-point'
        : dto.stopdesk === 0 || dto.stopdesk === false
          ? 'home'
          : null,
    lastStateUpdateAt,
    createdAt: parseDate(dto.date_creation),
    raw: dto,
  };
}

function providerEntryId(
  tracking: string | null,
  entry: EcomHistoryEntryDto,
  position: number,
): string {
  return createHash('sha256')
    .update(
      [
        tracking ?? '',
        entry.date ?? '',
        entry.ville ?? '',
        entry.situation ?? '',
        entry.commentaire ?? '',
        String(position),
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 40);
}

export function mapEcomHistoryEntries(
  tracking: string | null,
  history?: readonly EcomHistoryEntryDto[] | null,
  overrides?: StateOverrides | null,
): MappedEcomHistoryEntry[] {
  const ordered = (history ?? [])
    .map((entry, index) => ({ entry, index, at: parseDate(entry.date) }))
    .sort((left, right) => {
      const leftAt = left.at?.getTime() ?? Number.POSITIVE_INFINITY;
      const rightAt = right.at?.getTime() ?? Number.POSITIVE_INFINITY;
      return leftAt === rightAt ? left.index - right.index : leftAt - rightAt;
    });

  let previousState: string | null = null;
  let previousStatus: NormalizedDeliveryStatus = 'unknown';
  const mapped: MappedEcomHistoryEntry[] = [];

  ordered.forEach(({ entry }, position) => {
    const state = normalizeText(entry.situation) || null;
    const status = normalizeEcomStatus(entry.situation, overrides);
    const flags = ecomSituationFlags(entry.situation, entry.commentaire);
    const situations: MappedEcomSituation[] =
      entry.situation || entry.commentaire
        ? [
            {
              slug: state,
              name: entry.situation ?? null,
              description: entry.commentaire ?? null,
              flags,
              raw: entry,
            },
          ]
        : [];

    mapped.push({
      providerEntryId: providerEntryId(tracking, entry, position),
      parcelId: tracking,
      fromState: previousState,
      toState: state,
      fromStatus: previousStatus,
      toStatus: status,
      at: parseDate(entry.date),
      comment: entry.commentaire ?? null,
      hubName: null,
      hubCity:
        entry.ville !== null && entry.ville !== undefined
          ? String(entry.ville)
          : null,
      hubDistrict: null,
      modifiedBy: null,
      situations,
      raw: entry,
    });

    previousState = state;
    previousStatus = status;
  });

  return mapped;
}

export function validateEcomCatalogue(): string[] {
  const problems: string[] = [];
  const keys = ECOM_STATUS_RULES.map((rule) => rule.key);

  if (new Set(keys).size !== keys.length) {
    problems.push('ECOM_STATUS_RULES contains a duplicate key');
  }

  for (const rule of ECOM_STATUS_RULES) {
    if (normalizeText(rule.label) !== rule.key) {
      problems.push(`rule "${rule.label}" does not normalize to its key "${rule.key}"`);
    }
    if (!NORMALIZED_STATUSES.includes(rule.normalized)) {
      problems.push(`rule "${rule.key}" has an unknown normalized status "${rule.normalized}"`);
    }
    if (!CARRIER_ORDER_SIGNALS.includes(rule.signal)) {
      problems.push(`rule "${rule.key}" has an unknown signal "${rule.signal}"`);
    }
    const terminalExpected =
      rule.normalized === 'delivered' ||
      rule.normalized === 'cash_collected' ||
      rule.normalized === 'settled';
    if (rule.terminal !== terminalExpected) {
      problems.push(`rule "${rule.key}" has an inconsistent terminal flag`);
    }
    if (rule.unresolved && (rule.normalized !== 'unknown' || rule.signal !== 'none')) {
      problems.push(`unresolved rule "${rule.key}" must stay unknown with no signal`);
    }
    if (rule.normalized === 'delivered' && rule.signal !== 'delivered') {
      problems.push(`delivered rule "${rule.key}" must signal delivered`);
    }
    if (
      (rule.normalized === 'cash_collected' || rule.normalized === 'settled') &&
      rule.signal !== 'delivered'
    ) {
      problems.push(`financial rule "${rule.key}" must signal delivered`);
    }
    if (
      IN_TRANSIT_NORMALIZED_STATUSES.includes(rule.normalized) &&
      rule.signal !== 'in_transit'
    ) {
      problems.push(`in-transit rule "${rule.key}" must signal in_transit`);
    }
    if (
      DELIVERED_NORMALIZED_STATUSES.includes(rule.normalized) &&
      rule.signal !== 'delivered'
    ) {
      problems.push(`delivered-band rule "${rule.key}" must signal delivered`);
    }
  }

  if (!ECOM_UNRESOLVED_LABELS.includes('recuperer')) {
    problems.push('the unresolved "Récupérer" label must remain explicitly listed');
  }

  if (!ECOM_STATUS_RULES.some((rule) => rule.normalized === 'delivered')) {
    problems.push('the catalogue must contain a delivered rule');
  }

  for (const flag of ECOM_SITUATION_FLAGS) {
    if (!ECOM_SITUATION_FLAG_BY_PHRASE.some((rule) => rule.flag === flag)) {
      problems.push(`situation flag "${flag}" has no matching phrase rule`);
    }
  }

  for (const rule of ECOM_SITUATION_FLAG_BY_PHRASE) {
    if (!ECOM_SITUATION_FLAGS.includes(rule.flag)) {
      problems.push(`situation rule "${rule.flag}" is not in ECOM_SITUATION_FLAGS`);
    }
  }

  return problems;
}
