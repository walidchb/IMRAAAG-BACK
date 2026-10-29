import { createHash } from 'crypto';
import {
  CARRIER_ORDER_SIGNALS,
  CARRIER_SIGNAL_PRIORITY,
  DELIVERED_NORMALIZED_STATUSES,
  NORMALIZED_STATUSES,
  RETURN_STATE_PATTERNS,
  CANCELLED_STATE_PATTERNS,
  normalizeText,
} from '../../../delivery-status/carrier/carrier-signal';
import type {
  CarrierOrderSignal,
  CarrierSignalSource,
  DetectedCarrierOrderSignal,
  NormalizedDeliveryStatus,
  SignalOverrides,
  SituationFlag,
  StateOverrides,
} from '../../../delivery-status/carrier/carrier-signal';
import type { DhdActivityDto, DhdParcelDto } from './dhd-status.types';

export interface DhdStatusRule {
  key: string;
  keys: readonly string[];
  label: string;
  normalized: NormalizedDeliveryStatus;
  signal: CarrierOrderSignal;
  terminal: boolean;
}

export const DHD_STATUS_RULES: readonly DhdStatusRule[] = [
  {
    key: 'prete a expedier',
    keys: ['prete a expedier', 'pret a expedier'],
    label: 'Prêt à expédier',
    normalized: 'processing',
    signal: 'none',
    terminal: false,
  },
  {
    key: 'prete a preparer',
    keys: ['prete a preparer', 'pret a preparer'],
    label: 'Prêt à préparer',
    normalized: 'preparing',
    signal: 'none',
    terminal: false,
  },
  {
    key: 'en ramassage',
    keys: ['en ramassage'],
    label: 'En ramassage',
    normalized: 'dispatch_local',
    signal: 'none',
    terminal: false,
  },
  {
    key: 'stock en preparation',
    keys: ['en preparation stock', 'stock en preparation'],
    label: 'Stock en préparation',
    normalized: 'preparing',
    signal: 'none',
    terminal: false,
  },
  {
    key: 'vers hub',
    keys: ['vers hub'],
    label: 'Vers hub',
    normalized: 'dispatch_local',
    signal: 'in_transit',
    terminal: false,
  },
  {
    key: 'en hub',
    keys: ['en hub'],
    label: 'En hub',
    normalized: 'dispatch_interwilaya',
    signal: 'in_transit',
    terminal: false,
  },
  {
    key: 'vers wilaya',
    keys: ['vers wilaya'],
    label: 'Vers wilaya',
    normalized: 'dispatch_interwilaya',
    signal: 'in_transit',
    terminal: false,
  },
  {
    key: 'en preparation',
    keys: ['en preparation'],
    label: 'En préparation',
    normalized: 'preparing',
    signal: 'none',
    terminal: false,
  },
  {
    key: 'en livraison',
    keys: ['en livraison'],
    label: 'En livraison',
    normalized: 'out_for_delivery',
    signal: 'in_transit',
    terminal: false,
  },
  {
    key: 'suspendu',
    keys: ['suspendu', 'suspendus'],
    label: 'Suspendus',
    normalized: 'unknown',
    signal: 'none',
    terminal: false,
  },
  {
    key: 'livre non encaisse',
    keys: ['livre non encaisse'],
    label: 'Livre non encaissé',
    normalized: 'delivered',
    signal: 'delivered',
    terminal: true,
  },
  {
    key: 'encaisse non paye',
    keys: ['encaisse non paye', 'livre encaisse non paye'],
    label: 'Livre encaissé non payé',
    normalized: 'cash_collected',
    signal: 'delivered',
    terminal: true,
  },
  {
    key: 'paiement pret',
    keys: ['paiement pret', 'paiements prets'],
    label: 'Paiement prêt',
    normalized: 'settled',
    signal: 'delivered',
    terminal: true,
  },
  {
    key: 'paye et archive',
    keys: ['paye et archive', 'paiement archive'],
    label: 'Paiement archivé',
    normalized: 'settled',
    signal: 'delivered',
    terminal: true,
  },
  {
    key: 'retour chez livreur',
    keys: ['retour chez livreur'],
    label: 'Retours chez livreur',
    normalized: 'returned',
    signal: 'returned',
    terminal: true,
  },
  {
    key: 'retour transit entrepot',
    keys: ['retour transit entrepot', 'retour en transit stock'],
    label: 'Retours en transit stock',
    normalized: 'returned',
    signal: 'returned',
    terminal: true,
  },
  {
    key: 'retour en traitement',
    keys: ['retour en traitement'],
    label: 'Retours en traitement',
    normalized: 'returned',
    signal: 'returned',
    terminal: true,
  },
  {
    key: 'retour recu',
    keys: ['retour recu', 'retours recu'],
    label: 'Retours reçu',
    normalized: 'returned',
    signal: 'returned',
    terminal: true,
  },
  {
    key: 'retour archive',
    keys: ['retour archive', 'retours archive'],
    label: 'Retours archivé',
    normalized: 'returned',
    signal: 'returned',
    terminal: true,
  },
  {
    key: 'retour a dispatcher vers stock',
    keys: ['retour a dispatcher vers stock'],
    label: 'Retours à dispatcher vers stock',
    normalized: 'returned',
    signal: 'returned',
    terminal: true,
  },
  {
    key: 'retours prets',
    keys: ['retour prets', 'retours prets'],
    label: 'Retours prêts',
    normalized: 'returned',
    signal: 'returned',
    terminal: true,
  },
  {
    key: 'retour en stock',
    keys: ['retour en stock'],
    label: 'Retours en stock',
    normalized: 'returned',
    signal: 'returned',
    terminal: true,
  },
  {
    key: 'annule',
    keys: ['annule', 'annulee'],
    label: 'Annulé',
    normalized: 'cancelled',
    signal: 'cancelled',
    terminal: true,
  },
] as const;

export const DHD_STATUS_RULES_BY_KEY: Readonly<Record<string, DhdStatusRule>> =
  Object.fromEntries(
    DHD_STATUS_RULES.flatMap((rule) =>
      rule.keys.map((key) => [normalizeText(key), rule] as const),
    ),
  );

export interface DhdActivityRule {
  key: string;
  keys: readonly string[];
  label: string;
  normalized: NormalizedDeliveryStatus;
  signal: CarrierOrderSignal;
}

export const DHD_ACTIVITY_RULES: readonly DhdActivityRule[] = [
  {
    key: 'order information received by carrier',
    keys: ['order information received by carrier'],
    label: 'Order information received by carrier',
    normalized: 'received',
    signal: 'none',
  },
  {
    key: 'notification on order',
    keys: ['notification on order'],
    label: 'Notification on order',
    normalized: 'unknown',
    signal: 'none',
  },
  {
    key: 'picked',
    keys: ['picked'],
    label: 'Picked',
    normalized: 'dispatch_local',
    signal: 'in_transit',
  },
  {
    key: 'accepted by carrier',
    keys: ['accepted by carrier'],
    label: 'Accepted by carrier',
    normalized: 'dispatch_interwilaya',
    signal: 'in_transit',
  },
  {
    key: 'dispatched to driver',
    keys: ['dispatched to driver'],
    label: 'Dispatched to driver',
    normalized: 'out_for_delivery',
    signal: 'in_transit',
  },
  {
    key: 'attempt delivery',
    keys: ['attempt delivery'],
    label: 'Attempt delivery',
    normalized: 'out_for_delivery',
    signal: 'none',
  },
  {
    key: 'return asked',
    keys: ['return asked'],
    label: 'Return asked',
    normalized: 'returned',
    signal: 'returned',
  },
  {
    key: 'return in transit',
    keys: ['return in transit'],
    label: 'Return in transit',
    normalized: 'returned',
    signal: 'returned',
  },
  {
    key: 'return received',
    keys: ['return received'],
    label: 'Return received',
    normalized: 'returned',
    signal: 'returned',
  },
  {
    key: 'livred',
    keys: ['livred', 'delivered'],
    label: 'Livré',
    normalized: 'delivered',
    signal: 'delivered',
  },
  {
    key: 'encaissed',
    keys: ['encaissed', 'cash collected'],
    label: 'Encaissé',
    normalized: 'cash_collected',
    signal: 'delivered',
  },
  {
    key: 'payed',
    keys: ['payed', 'settled'],
    label: 'Payé',
    normalized: 'settled',
    signal: 'delivered',
  },
] as const;

export const DHD_ACTIVITY_RULES_BY_KEY: Readonly<Record<string, DhdActivityRule>> =
  Object.fromEntries(
    DHD_ACTIVITY_RULES.flatMap((rule) =>
      rule.keys.map((key) => [normalizeText(key), rule] as const),
    ),
  );

export const DHD_SITUATION_FLAG_BY_PHRASE: readonly {
  flag: SituationFlag;
  phrases: string[];
}[] = [
  { flag: 'no_answer', phrases: ['ne repond', 'pas de reponse', 'sans reponse'] },
  { flag: 'unreachable', phrases: ['injoignable', 'hors zone', 'telephone eteint'] },
  { flag: 'customer_cancelled', phrases: ['commande annulee', 'client annule'] },
  { flag: 'address_issue', phrases: ['adresse erronee', 'commune erronee'] },
  { flag: 'postponed', phrases: ['reporte', 'reportee', 'reporter'] },
  { flag: 'sms_sent', phrases: ['sms envoye', 'sms'] },
] as const;

const DHD_CANCELLED_PATTERNS = [...CANCELLED_STATE_PATTERNS, 'supprim'] as const;
const DHD_RETURN_PATTERNS = [...RETURN_STATE_PATTERNS, 'refus'] as const;

function matchesToken(value: unknown, patterns: readonly string[]): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  return patterns.some((pattern) => text.includes(normalizeText(pattern)));
}

export function dhdStatusRule(value: unknown): DhdStatusRule | null {
  const key = normalizeText(value);
  if (!key) return null;
  return DHD_STATUS_RULES_BY_KEY[key] ?? null;
}

export function dhdActivityRule(value: unknown): DhdActivityRule | null {
  const key = normalizeText(value);
  if (!key) return null;
  return DHD_ACTIVITY_RULES_BY_KEY[key] ?? null;
}

function overrideKeys(value: unknown): string[] {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  const keys = new Set<string>();
  if (raw) {
    keys.add(raw);
    keys.add(raw.toLowerCase());
  }
  const normalized = normalizeText(value);
  if (normalized) keys.add(normalized);
  return [...keys];
}

function lookupOverride(
  keys: readonly string[],
  overrides?: Readonly<Record<string, string>> | null,
): string | null {
  if (!overrides) return null;
  for (const key of keys) {
    const value = overrides[key];
    if (value !== undefined && value !== null) return String(value).trim().toLowerCase();
  }
  return null;
}

export function applyDhdStateOverride(
  label: unknown,
  overrides?: StateOverrides | null,
): NormalizedDeliveryStatus | null {
  const target = lookupOverride(overrideKeys(label), overrides);
  if (!target) return null;
  if (!NORMALIZED_STATUSES.includes(target as NormalizedDeliveryStatus)) return null;
  return target as NormalizedDeliveryStatus;
}

export function applyDhdSignalOverride(
  label: unknown,
  overrides?: SignalOverrides | null,
): CarrierOrderSignal | null {
  const target = lookupOverride(overrideKeys(label), overrides);
  if (!target) return null;
  if (!CARRIER_ORDER_SIGNALS.includes(target as CarrierOrderSignal)) return null;
  return target as CarrierOrderSignal;
}

export function normalizeDhdStatus(
  label: unknown,
  overrides?: StateOverrides | null,
): NormalizedDeliveryStatus {
  const override = applyDhdStateOverride(label, overrides);
  if (override) return override;
  if (matchesToken(label, DHD_RETURN_PATTERNS)) return 'returned';
  if (matchesToken(label, DHD_CANCELLED_PATTERNS)) return 'cancelled';
  return (
    dhdStatusRule(label)?.normalized ??
    dhdActivityRule(label)?.normalized ??
    'unknown'
  );
}

export function dhdSignalForLabel(label: unknown): CarrierOrderSignal {
  if (matchesToken(label, DHD_RETURN_PATTERNS)) return 'returned';
  if (matchesToken(label, DHD_CANCELLED_PATTERNS)) return 'cancelled';
  return dhdStatusRule(label)?.signal ?? 'none';
}

export function dhdActivitySignalForLabel(label: unknown): CarrierOrderSignal {
  if (matchesToken(label, DHD_RETURN_PATTERNS)) return 'returned';
  if (matchesToken(label, DHD_CANCELLED_PATTERNS)) return 'cancelled';
  return dhdActivityRule(label)?.signal ?? 'none';
}

export function isDhdTerminalStatus(status: unknown): boolean {
  return (
    status === 'delivered' ||
    status === 'cash_collected' ||
    status === 'settled' ||
    status === 'cancelled' ||
    status === 'returned'
  );
}

export function normalizeDhdOffset(value: unknown): string {
  const raw = String(value ?? '').trim();
  return /^[+-]\d{2}:\d{2}$/.test(raw) ? raw : '+01:00';
}

export function parseDhdInstant(
  date: unknown,
  time?: unknown,
  utcOffset?: unknown,
): Date | null {
  const rawDate = date === null || date === undefined ? '' : String(date).trim();
  if (!rawDate) return null;

  if (/t/i.test(rawDate) || /(?:z|[+-]\d{2}:?\d{2})$/i.test(rawDate)) {
    const direct = new Date(rawDate);
    return Number.isNaN(direct.getTime()) ? null : direct;
  }

  const rawTime = time === null || time === undefined || String(time).trim() === ''
    ? '00:00:00'
    : String(time).trim();
  const parsed = new Date(`${rawDate}T${rawTime}${normalizeDhdOffset(utcOffset)}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function dhdSituationFlags(
  value: unknown,
  comment?: unknown,
  activity?: DhdActivityDto | null,
): SituationFlag[] {
  const text = [
    normalizeText(value),
    normalizeText(comment),
    normalizeText(activity?.reason),
    normalizeText(activity?.details),
    normalizeText(activity?.status),
  ]
    .filter(Boolean)
    .join(' ');

  const flags: SituationFlag[] = [];
  if (normalizeText(value) === 'suspendu' || normalizeText(value) === 'suspendus') {
    flags.push('postponed');
  }
  if (activity?.postponed_to || activity?.postponedTo) flags.push('postponed');

  for (const rule of DHD_SITUATION_FLAG_BY_PHRASE) {
    if (
      !flags.includes(rule.flag) &&
      rule.phrases.some((phrase) => text.includes(normalizeText(phrase)))
    ) {
      flags.push(rule.flag);
    }
  }

  return [...new Set(flags)];
}

function entryAt(entry: DhdActivityDto, utcOffset?: unknown): Date | null {
  return parseDhdInstant(entry.date, entry.time, utcOffset);
}

export interface DhdSignalOptions {
  utcOffset?: string;
}

export function detectDhdOrderSignal(
  parcel: DhdParcelDto,
  history?: readonly DhdActivityDto[] | null,
  signalOverrides?: SignalOverrides | null,
  options: DhdSignalOptions = {},
): DetectedCarrierOrderSignal {
  const rawState = typeof parcel.status === 'string' ? parcel.status.trim() : '';
  if (normalizeText(rawState) === 'suspendu' || normalizeText(rawState) === 'suspendus') {
    return { signal: 'none', source: 'none' };
  }

  const candidates: DetectedCarrierOrderSignal[] = [];

  if (rawState) {
    const override = applyDhdSignalOverride(rawState, signalOverrides);
    if (override !== null) {
      if (override !== 'none') candidates.push({ signal: override, source: 'override' });
    } else {
      const signal = dhdSignalForLabel(rawState);
      if (signal !== 'none') candidates.push({ signal, source: 'state' });
    }
  }

  const activities = [...(history ?? []), ...(parcel.activity ?? [])]
    .map((entry, index) => ({ entry, index, at: entryAt(entry, options.utcOffset) }))
    .sort((left, right) => {
      const leftAt = left.at?.getTime() ?? Number.NEGATIVE_INFINITY;
      const rightAt = right.at?.getTime() ?? Number.NEGATIVE_INFINITY;
      return leftAt === rightAt ? left.index - right.index : leftAt - rightAt;
    })
    .reverse();

  for (const { entry } of activities) {
    const label = entry.status;
    const override = applyDhdSignalOverride(label, signalOverrides);
    if (override !== null) {
      if (override !== 'none') candidates.push({ signal: override, source: 'override' });
      break;
    }
    const signal = dhdActivitySignalForLabel(label);
    if (signal !== 'none') {
      candidates.push({ signal, source: 'situation' });
      break;
    }
  }

  for (const signal of CARRIER_SIGNAL_PRIORITY) {
    if (signal === 'none') continue;
    const match = candidates.find((candidate) => candidate.signal === signal);
    if (match) return match;
  }

  return { signal: 'none', source: 'none' };
}

export interface MappedDhdSituation {
  slug: string | null;
  name: string | null;
  description: string | null;
  flags: SituationFlag[];
  raw: DhdActivityDto;
}

export interface MappedDhdParcel {
  parcelId: string;
  externalId: string | null;
  trackingNumber: string | null;
  deliveryStatus: NormalizedDeliveryStatus;
  carrierStateId: string | null;
  carrierStateName: string | null;
  carrierStateDescription: string | null;
  carrierStateRank: number | null;
  carrierStateLocked: boolean | null;
  terminal: boolean;
  situationFlags: SituationFlag[];
  rawSituation: Record<string, unknown> | null;
  deliveryType: string | null;
  lastStateUpdateAt: Date | null;
  raw: DhdParcelDto;
}

export interface MappedDhdHistoryEntry {
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
  situations: MappedDhdSituation[];
  raw: DhdActivityDto;
}

function newestActivity(
  activities: readonly DhdActivityDto[] | null | undefined,
  utcOffset?: unknown,
): DhdActivityDto | null {
  let newest: DhdActivityDto | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const entry of activities ?? []) {
    const at = entryAt(entry, utcOffset)?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (newest === null || at >= newestAt) {
      newest = entry;
      newestAt = at;
    }
  }
  return newest;
}

function newestStateActivity(
  activities: readonly DhdActivityDto[] | null | undefined,
  utcOffset?: unknown,
): DhdActivityDto | null {
  let newest: DhdActivityDto | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const entry of activities ?? []) {
    if (normalizeText(entry.status) === 'notification on order') continue;
    const at = entryAt(entry, utcOffset)?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (newest === null || at >= newestAt) {
      newest = entry;
      newestAt = at;
    }
  }
  return newest;
}

export function mapDhdParcel(
  dto: DhdParcelDto,
  overrides?: StateOverrides | null,
  options: DhdSignalOptions = {},
): MappedDhdParcel {
  const newest = newestStateActivity(dto.activity, options.utcOffset);
  const rawStatus =
    (typeof dto.status === 'string' && dto.status.trim()) ||
    (typeof newest?.status === 'string' && newest.status.trim()) ||
    '';
  const deliveryStatus = normalizeDhdStatus(rawStatus, overrides);
  const rule = dhdStatusRule(rawStatus);
  const flags = dhdSituationFlags(rawStatus, newest?.reason, newest);
  if (!rule && rawStatus && deliveryStatus === 'unknown') flags.push('raw');

  const lastStateUpdateAt =
    newest && rule !== null
      ? entryAt(newest, options.utcOffset)
      : newest
        ? entryAt(newest, options.utcOffset)
        : null;

  return {
    parcelId: dto.tracking ? String(dto.tracking) : '',
    externalId: dto.reference ? String(dto.reference) : null,
    trackingNumber: dto.tracking ? String(dto.tracking) : null,
    deliveryStatus,
    carrierStateId: rawStatus || null,
    carrierStateName: normalizeText(rawStatus) || null,
    carrierStateDescription: rawStatus || null,
    carrierStateRank: null,
    carrierStateLocked: null,
    terminal: isDhdTerminalStatus(deliveryStatus),
    situationFlags: [...new Set(flags)],
    rawSituation: {
      status: dto.status ?? null,
      order_id: dto.order_id ?? null,
      desk_phone: dto.desk_phone ?? null,
      desk_commune: dto.desk_commune ?? null,
      desk_address: dto.desk_address ?? null,
      driver_phone: dto.driver_phone ?? null,
      activity: dto.activity ?? [],
    },
    deliveryType: null,
    lastStateUpdateAt,
    raw: dto,
  };
}

function providerEntryId(
  tracking: string | null,
  entry: DhdActivityDto,
  occurrence: number,
): string {
  return createHash('sha256')
    .update(
      [
        tracking ?? '',
        entry.date ?? '',
        entry.time ?? '',
        entry.status ?? '',
        entry.scanLocation ?? entry.scan_location ?? '',
        entry.station ?? '',
        entry.driver ?? '',
        entry.reason ?? '',
        entry.details ?? '',
        String(occurrence),
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 40);
}

export function mapDhdHistoryEntries(
  tracking: string | null,
  activity?: readonly DhdActivityDto[] | null,
  overrides?: StateOverrides | null,
  options: DhdSignalOptions = {},
): MappedDhdHistoryEntry[] {
  const ordered = (activity ?? [])
    .map((entry, index) => ({
      entry,
      index,
      at: entryAt(entry, options.utcOffset),
    }))
    .sort((left, right) => {
      const leftAt = left.at?.getTime() ?? Number.POSITIVE_INFINITY;
      const rightAt = right.at?.getTime() ?? Number.POSITIVE_INFINITY;
      return leftAt === rightAt ? left.index - right.index : leftAt - rightAt;
    });

  const occurrences = new Map<string, number>();
  let previousState: string | null = null;
  let previousStatus: NormalizedDeliveryStatus = 'unknown';
  const mapped: MappedDhdHistoryEntry[] = [];

  for (const { entry, at } of ordered) {
    const state = normalizeText(entry.status) || null;
    const status = normalizeDhdStatus(entry.status, overrides);
    const tuple = [
      entry.date ?? '',
      entry.time ?? '',
      entry.status ?? '',
      entry.scanLocation ?? entry.scan_location ?? '',
      entry.station ?? '',
      entry.driver ?? '',
      entry.reason ?? '',
      entry.details ?? '',
    ].join('|');
    const occurrence = occurrences.get(tuple) ?? 0;
    occurrences.set(tuple, occurrence + 1);

    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    const details = typeof entry.details === 'string' ? entry.details.trim() : '';
    const comment = [reason, details].filter(Boolean).join(' - ') || null;
    const flags = dhdSituationFlags(entry.status, comment, entry);
    if (!dhdActivityRule(entry.status) && state) flags.push('raw');

    const situations: MappedDhdSituation[] =
      entry.status || comment || entry.station
        ? [
            {
              slug: state,
              name: entry.status ?? null,
              description: comment,
              flags: [...new Set(flags)],
              raw: entry,
            },
          ]
        : [];

    mapped.push({
      providerEntryId: providerEntryId(tracking, entry, occurrence),
      parcelId: tracking,
      fromState: previousState,
      toState: state,
      fromStatus: previousStatus,
      toStatus: status,
      at,
      comment,
      hubName:
        (typeof entry.station === 'string' && entry.station) ||
        (typeof entry.scanLocation === 'string' && entry.scanLocation) ||
        (typeof entry.scan_location === 'string' && entry.scan_location) ||
        null,
      hubCity: null,
      hubDistrict: null,
      modifiedBy: typeof entry.driver === 'string' && entry.driver ? entry.driver : null,
      situations,
      raw: entry,
    });

    previousState = state;
    previousStatus = status;
  }

  return mapped;
}

export function validateDhdCatalogue(): string[] {
  const problems: string[] = [];
  const aliases = new Set<string>();

  for (const rule of DHD_STATUS_RULES) {
    if (rule.keys.length === 0) problems.push(`status "${rule.key}" has no aliases`);
    for (const alias of rule.keys) {
      const normalized = normalizeText(alias);
      if (!normalized) problems.push(`status "${rule.key}" has an empty alias`);
      if (aliases.has(normalized)) problems.push(`duplicate status alias "${alias}"`);
      aliases.add(normalized);
    }
    if (!NORMALIZED_STATUSES.includes(rule.normalized)) {
      problems.push(`status "${rule.key}" has an unknown normalized value`);
    }
    if (!CARRIER_ORDER_SIGNALS.includes(rule.signal)) {
      problems.push(`status "${rule.key}" has an unknown signal`);
    }
    const terminalExpected =
      DELIVERED_NORMALIZED_STATUSES.includes(rule.normalized) ||
      rule.normalized === 'cancelled' ||
      rule.normalized === 'returned';
    if (rule.terminal !== terminalExpected) {
      problems.push(`status "${rule.key}" has an inconsistent terminal flag`);
    }
    if (DELIVERED_NORMALIZED_STATUSES.includes(rule.normalized) && rule.signal !== 'delivered') {
      problems.push(`delivered-band status "${rule.key}" must signal delivered`);
    }
    if (rule.normalized === 'returned' && rule.signal !== 'returned') {
      problems.push(`returned status "${rule.key}" must signal returned`);
    }
    if (rule.normalized === 'cancelled' && rule.signal !== 'cancelled') {
      problems.push(`cancelled status "${rule.key}" must signal cancelled`);
    }
  }

  const activityAliases = new Set<string>();
  for (const rule of DHD_ACTIVITY_RULES) {
    for (const alias of rule.keys) {
      const normalized = normalizeText(alias);
      if (activityAliases.has(normalized)) {
        problems.push(`duplicate activity alias "${alias}"`);
      }
      activityAliases.add(normalized);
    }
    if (!NORMALIZED_STATUSES.includes(rule.normalized)) {
      problems.push(`activity "${rule.key}" has an unknown normalized value`);
    }
    if (!CARRIER_ORDER_SIGNALS.includes(rule.signal)) {
      problems.push(`activity "${rule.key}" has an unknown signal`);
    }
    if (DELIVERED_NORMALIZED_STATUSES.includes(rule.normalized) && rule.signal !== 'delivered') {
      problems.push(`delivered-band activity "${rule.key}" must signal delivered`);
    }
    if (rule.normalized === 'returned' && rule.signal !== 'returned') {
      problems.push(`returned activity "${rule.key}" must signal returned`);
    }
  }

  if (dhdSignalForLabel('attempt_delivery') !== 'none') {
    problems.push('attempt_delivery must never signal a delivery');
  }
  if (dhdSignalForLabel('suspendu') !== 'none') {
    problems.push('suspendu must never signal an order action');
  }
  if (dhdSignalForLabel('notification_on_order') !== 'none') {
    problems.push('notification_on_order must never signal an order action');
  }

  return problems;
}
