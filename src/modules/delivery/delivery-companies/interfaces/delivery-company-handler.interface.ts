import { Order } from '../../../orders/schemas/order.schema';

export interface BulkOrderResult {
  orderNo: string;
  success: boolean;
  parcelId?: string;
  error?: string;
}

/**
 * Everything a provider needs to answer a status query, and nothing more.
 *
 * The context is deliberately **provider-neutral**: the platform resolves the store and hands
 * the provider an identity, never a document. A provider that needs the store's credentials
 * resolves them itself, store-first.
 */
export interface DeliveryStatusContext {
  /**
   * The canonical seller identity. Preferred. When present, the provider resolves the store's
   * configuration by `storeId` and falls back to `vendorEmail` only for configuration rows
   * written before the store-id migration.
   */
  storeId?: string | null;
  /** The legacy seller identifier — a read fallback for pre-migration configuration rows only. */
  vendorEmail?: string | null;
  /** How many parcels a discovery call should return. */
  limit?: number;
  /** The 1-based page a discovery call should return. */
  page?: number;
  /**
   * Restrict the result to these carrier-side external references (our `order.orderNo`).
   * Applied by the provider where the carrier supports it, and client-side otherwise.
   */
  externalIds?: string[];
  /** Restrict the result to these carrier parcel ids, where the carrier supports it. */
  parcelIds?: string[];
  /** Only return parcels whose carrier state changed strictly after this instant. */
  updatedAfter?: Date | null;
}

/** A carrier sub-state (a "situation"), normalized to the platform's vocabulary. */
export interface DeliveryStatusSituation {
  /** The carrier's own slug, when it publishes one. */
  slug: string | null;
  /** The carrier's own label, in the carrier's language. */
  name: string | null;
  /** The carrier's own description, in the carrier's language. */
  description: string | null;
  /** The normalized flags this situation produced (roadmap §8.3). */
  flags: string[];
}

/** A carrier parcel, normalized to the platform's vocabulary. */
export interface DeliveryStatusParcel {
  /** The carrier's parcel id. */
  parcelId: string;
  /** The reference the platform sent at creation — our `order.orderNo`. */
  externalId: string | null;
  /** The carrier's tracking number. */
  trackingNumber: string | null;
  /** The normalized delivery status. */
  deliveryStatus: string;
  /** The raw carrier state id (diagnostic only — it is workflow-scoped). */
  carrierStateId: string | null;
  /** The raw carrier state slug. */
  carrierStateName: string | null;
  /** The raw carrier state description. */
  carrierStateDescription: string | null;
  /** The carrier's state ranking, when the provider exposes it. */
  carrierStateRank: number | null;
  /** The carrier says the parcel is locked in this state. */
  carrierStateLocked: boolean | null;
  /** The carrier state is in the terminal band. */
  terminal: boolean;
  /** The normalized situation flags currently attached to the parcel. */
  situationFlags: string[];
  /**
   * The carrier's `lastStateUpdateAt` — the watermark the poller compares against the stored
   * value so an unchanged parcel is never detail-polled (roadmap §12.4).
   */
  lastStateUpdateAt: Date | null;
  /** The carrier's delivery type — `home`, `pickup-point`, … */
  deliveryType: string | null;
  /** The carrier's current sub-state, normalized. */
  situation: DeliveryStatusSituation | null;
  /** The carrier's current sub-state, verbatim — stored even when it was not recognised. */
  rawSituation: unknown;
  /** The raw carrier payload, stored verbatim for diagnostics. */
  raw: unknown;
}

/** One carrier transition, normalized to the platform's vocabulary. */
export interface DeliveryStatusEntry {
  /** The carrier's history entry id — the idempotency key for the timeline. */
  providerEntryId: string;
  /** The carrier's parcel id. */
  parcelId: string | null;
  /** The raw carrier state slug the parcel left. */
  fromState: string | null;
  /** The raw carrier state slug the parcel entered. */
  toState: string | null;
  /** The normalized status the parcel left. */
  fromStatus: string;
  /** The normalized status the parcel entered. */
  toStatus: string;
  /** When the transition happened on the carrier side. */
  at: Date | null;
  /** The carrier's free-text comment. */
  comment: string | null;
  /** The hub / stopdesk the transition happened at. */
  hubName: string | null;
  /** The hub's city, when the carrier reports it. */
  hubCity: string | null;
  /** The hub's district, when the carrier reports it. */
  hubDistrict: string | null;
  /** Who performed the change on the carrier side. Diagnostic only — never shown to a customer. */
  modifiedBy: string | null;
  /** The normalized situation flags attached to this transition. */
  situationFlags: string[];
  /** The carrier's sub-states attached to this transition, normalized. */
  situations: DeliveryStatusSituation[];
  /** The raw carrier payload, stored verbatim for diagnostics. */
  raw: unknown;
}

/** The result of a discovery call. */
export interface DeliveryStatusSearchResult {
  parcels: DeliveryStatusParcel[];
  /** The carrier's total parcel count, when it reports one. */
  totalCount: number | null;
  /** Whether the carrier has more pages. */
  hasNext: boolean;
  /** Requested parcel ids the carrier did not report, when the provider can tell. */
  missingParcelIds?: string[];
}

/** The layouts a seller can request for a carrier label batch. */
export type OrderLabelFormat =
  | '10x13'
  | '10x15'
  | '15x20'
  | '10x10'
  | 'a4_1up'
  | 'a4_4up'
  | 'native';

export type OrderLabelGrouping = 'combined' | 'per_carrier';

/** One order handed to a carrier label adapter. */
export interface DeliveryLabelOrder {
  orderNo: string;
  parcelId: string;
  trackingNumber?: string | null;
}

export interface DeliveryLabelContext {
  storeId: string;
  vendorEmail?: string | null;
  format: OrderLabelFormat;
  timeoutMs: number;
  /**
   * True when every order in the batch uses this carrier. Only then may a provider that
   * produces a multi-label A4 sheet (ZR's `multiple` endpoint) return that sheet for a
   * 4-up request; a mixed-carrier batch must hand back per-order labels.
   */
  allOrdersSameCarrier: boolean;
}

/** The batch-level inputs a carrier may need before it can print labels. */
export interface DeliveryLabelPreparationContext {
  storeId: string;
  vendorEmail?: string | null;
  timeoutMs: number;
}

/**
 * The result of asking a carrier to turn our parcel references into printable order
 * references. Orders omitted from `orders` are treated as failures by the platform, so a
 * provider must return every order it can print and report the rest explicitly.
 */
export interface DeliveryLabelPreparation {
  orders: DeliveryLabelOrder[];
  failures?: DeliveryLabelFailure[];
}

/**
 * A carrier label source document.
 *
 * Most providers return one label-sized document per order. A carrier that only produces an A4
 * sheet returns a single `sheet` document; `orderNos`/`trackingNumbers` then name every order the
 * sheet covers so the manifest stays truthful. `cropBox` is the verified label region inside a
 * sheet (PDF coordinates, points) and is never guessed by the composer.
 */
export interface DeliveryLabelDocument {
  orderNo: string;
  orderNos?: string[];
  trackingNumber: string;
  trackingNumbers?: string[];
  contentType: 'text/html' | 'application/pdf';
  bytes: Buffer;
  /** Native label size when the document is a single label page. */
  widthMm?: number;
  heightMm?: number;
  /** True when the document is an A4 sheet containing several labels. */
  sheet?: boolean;
  /** The verified label crop inside `bytes`, in PDF points from the bottom-left. */
  cropBox?: { x: number; y: number; width: number; height: number };
}

export interface DeliveryLabelFailure {
  orderNo: string;
  trackingNumber?: string | null;
  code: string;
  message: string;
  retryable: boolean;
}

export interface DeliveryLabelWarning {
  orderNo: string;
  code: string;
  message: string;
  /** Present on fit warnings: the scale applied to the source label. */
  scale?: number;
}

export interface DeliveryLabelResult {
  documents: DeliveryLabelDocument[];
  failures: DeliveryLabelFailure[];
  warnings?: DeliveryLabelWarning[];
}

export interface DeliveryCompanyHandler {
  readonly companyId: string;
  createOrder(order: Order): Promise<{ parcelId: string }>;
  createBulkOrders?(orders: Order[]): Promise<BulkOrderResult[]>;

  /**
   * **Optional** status capability — discovery.
   *
   * Lists the carrier's parcels for a store so the platform can tell which ones changed. A
   * provider that does not implement it simply does not expose status sync; the other providers
   * (Noest, Ecom, DHD) are unaffected.
   */
  searchStatusParcels?(context: DeliveryStatusContext): Promise<DeliveryStatusSearchResult>;

  /**
   * **Optional** status capability — detail.
   *
   * Returns the full transition timeline of one carrier parcel, oldest first.
   */
  fetchStatusHistory?(context: DeliveryStatusContext, parcelId: string): Promise<DeliveryStatusEntry[]>;

  /**
   * **Optional** status capability — batched detail.
   *
   * A carrier that accepts several tracking numbers per call (Ecom accepts 40) can answer a
   * whole page of changed parcels at once. The poller prefers this method when present and
   * falls back to `fetchStatusHistory` one parcel at a time.
   */
  fetchStatusHistories?(
    context: DeliveryStatusContext,
    parcelIds: string[],
  ): Promise<Record<string, DeliveryStatusEntry[]>>;

  /**
   * **Optional** status capability — the tenant identity.
   *
   * Returns the carrier tenant the store's configuration points at, or `null` when the store has
   * no usable credentials. The poller uses it to group stores per tenant (one call budget per
   * tenant) and to name its circuit breaker. It never returns the API key.
   */
  resolveStatusTenant?(context: DeliveryStatusContext): Promise<string | null>;

  /**
   * **Optional** label capability — preparation.
   *
   * Some carriers do not expose the printable tracking number at dispatch (ZR needs a status
   * lookup). A provider implements this to resolve its own references before the platform
   * deduplicates and groups the batch. Providers whose parcel id is already printable simply
   * omit this method; the platform falls back to `parcelId`.
   *
   * The platform applies the same timeout and per-order failure isolation to this call as it
   * does to `createLabels`, so a preparation failure never fails the whole carrier group.
   */
  prepareLabels?(
    orders: DeliveryLabelOrder[],
    context: DeliveryLabelPreparationContext,
  ): Promise<DeliveryLabelPreparation>;

  /**
   * **Optional** label capability.
   *
   * A provider that does not implement this is reported as an unsupported carrier; the batch is
   * never failed as a whole. Implementations must isolate per-order failures and must never
   * return carrier SAS URLs, credentials, or raw HTML to the caller.
   */
  createLabels?(
    orders: DeliveryLabelOrder[],
    context: DeliveryLabelContext,
  ): Promise<DeliveryLabelResult>;
}
