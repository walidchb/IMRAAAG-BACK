/**
 * The ZR Express wire shapes used by the status sync.
 *
 * Every field is optional unless the official OpenAPI marks it required. ZR omits optional
 * fields from the JSON entirely when their value is `null` ("Optional fields are omitted from
 * JSON responses when their value is null" — the state-history reference), so every consumer
 * must treat a missing key as "absent", never as "the previous value".
 *
 * Source of truth: the official OpenAPI definition shipped with the platform at
 * `IMRAAAH-BACK/updates-zrexpress.md` (`components.schemas`), cross-checked against
 * `https://docs.zrexpress.app/reference/getparcelstatehistorysupplierendpoint.md`.
 *
 * This file is ZR-specific and is imported by the ZR handler and the ZR mapper only.
 */

/** The actor bitmask ZR uses for `visibleFor` / `editableBy`. */
export const ZR_ACTOR_BITMASK = {
  /** The merchant/client. */
  supplier: 1,
  /** Admin, Hub Agents and Backoffice. */
  proDelivery: 2,
  /** Drivers and couriers. */
  deliveryPerson: 4,
  /** The recipient (tracking view). */
  customer: 8,
} as const;

/** `StateDto` — a workflow state. `id` is workflow-scoped, `name` is the stable slug. */
export interface ZrStateDto {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  isBlocking?: boolean | null;
  isLocked?: boolean | null;
  visibleFor?: number | null;
  editableBy?: number | null;
  color?: string | null;
  /** Present on the workflow catalogue (`POST /workflows/search`); not on the state history. */
  ranking?: number | null;
}

/** `SituationDto` — the current sub-state of a parcel. */
export interface ZrSituationDto {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  slug?: string | null;
  metadata?: unknown;
}

/** `ParcelStateSituationHistoryDto` — a situation attached to one transition. */
export interface ZrSituationHistoryDto {
  situationName?: string | null;
  situationSlug?: string | null;
  situationDescription?: string | null;
  createdAt?: string | null;
  modifiedBy?: ZrUserSnapshotDto | null;
  metadata?: unknown;
}

/** `UserSnapshot` — who performed the change. */
export interface ZrUserSnapshotDto {
  id?: string | null;
  fullName?: string | null;
}

/** `LocationSnapshot` — where the change happened. */
export interface ZrLocationSnapshotDto {
  hubId?: string | null;
  hubName?: string | null;
  hubCity?: string | null;
  hubDistrict?: string | null;
  type?: string | null;
  membership?: string | null;
  hubTerritoryCityId?: string | null;
}

/** `HubSnapshot` — the arrival hub of a transition. */
export interface ZrHubSnapshotDto {
  hubId?: string | null;
  hubName?: string | null;
  hubCity?: string | null;
  hubCityTerritoryId?: string | null;
  hubDistrict?: string | null;
  hubDistrictTerritoryId?: string | null;
  hubType?: string | null;
}

/** `ParcelStateHistoryDto` — one transition. */
export interface ZrStateHistoryEntryDto {
  id?: string | null;
  parcelId?: string | null;
  createdAt?: string | null;
  previousState?: ZrStateDto | null;
  newState?: ZrStateDto | null;
  modifiedBy?: ZrUserSnapshotDto | null;
  location?: ZrLocationSnapshotDto | null;
  arrivalHub?: ZrHubSnapshotDto | null;
  comment?: string | null;
  situations?: ZrSituationHistoryDto[] | null;
}

/** One parcel as returned by `POST /parcels/search`. */
export interface ZrParcelDto {
  id?: string | null;
  /** The reference the platform sent at creation — our `order.orderNo`. */
  externalId?: string | null;
  trackingNumber?: string | null;
  state?: ZrStateDto | null;
  situation?: ZrSituationDto | null;
  lastStateUpdateAt?: string | null;
  lastSituationUpdateAt?: string | null;
  deliveryType?: string | null;
  createdAt?: string | null;
  lastLocationHubId?: string | null;
  isReturn?: boolean | null;
  isExchange?: boolean | null;
  isExchanged?: boolean | null;
  originalParcelId?: string | null;
  returnParcelId?: string | null;
  type?: string | null;
  [key: string]: unknown;
}

/** The `POST /parcels/search` response envelope. */
export interface ZrSearchParcelsResponse {
  items?: ZrParcelDto[] | null;
  pageNumber?: number | null;
  pageSize?: number | null;
  totalCount?: number | null;
  totalPages?: number | null;
  hasPrevious?: boolean | null;
  hasNext?: boolean | null;
}

/** The request body of `POST /parcels/search`. */
export interface ZrSearchParcelsRequest {
  pageNumber: number;
  pageSize: number;
  orderBy?: string[];
  advancedFilter?: {
    logic: 'and' | 'or';
    filters: Array<{ field: string; operator: string; value: unknown }>;
  };
}
