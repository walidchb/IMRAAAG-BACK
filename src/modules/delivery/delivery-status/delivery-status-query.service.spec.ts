import { DeliveryStatusQueryService } from './delivery-status-query.service';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { DeliverySyncState } from '../../../common/constants/delivery-status.const';
import type {
  DeliveryCompanyHandler,
  DeliveryStatusEntry,
  DeliveryStatusParcel,
} from '../delivery-companies/interfaces/delivery-company-handler.interface';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const OTHER_STORE_ID = '6ac400e26b1b2c3d4e5f6a72';
const ORDER_ID = '6ac400e26b1b2c3d4e5f6a73';
const PARCEL_ID = 'parcel-1';
const VENDOR_EMAIL = 'vendor@example.com';

/** A chainable query stub — the service uses `.lean()` and `.exec()`. */
function query<T>(result: T) {
  const q: Record<string, unknown> = {};
  q.exec = jest.fn().mockResolvedValue(result);
  q.lean = jest.fn().mockReturnValue(q);
  q.select = jest.fn().mockReturnValue(q);
  return q;
}

const parcelRecord = (overrides: Record<string, unknown> = {}) => ({
  storeId: STORE_ID,
  parcelId: PARCEL_ID,
  companyId: 'zr-express',
  orderId: ORDER_ID,
  orderNo: 'ORD-1',
  trackingNumber: 'TRACK-1',
  deliveryStatus: 'out_for_delivery',
  terminal: false,
  deliveryType: 'home',
  carrierStateId: 'state-9',
  carrierStateName: 'en_livraison',
  carrierStateDesc: 'En livraison',
  carrierStateRank: 9,
  carrierStateLocked: false,
  situationFlags: ['call_attempt'],
  rawSituation: { slug: 'situation-1', name: 'Appel', description: 'Appel telephonique' },
  hubName: 'Hub Alger',
  hubCity: 'Alger',
  hubDistrict: 'Alger Centre',
  syncState: DeliverySyncState.SYNCED,
  lastPolledAt: new Date('2026-10-21T10:00:00.000Z'),
  lastChangedAt: new Date('2026-10-21T09:00:00.000Z'),
  nextEligiblePollAt: null,
  lastError: null,
  consecutiveFailures: 0,
  conflict: null,
  conflictAt: null,
  timelineTruncated: false,
  terminalConfirmations: 0,
  timeline: [
    {
      providerEntryId: 'entry-1',
      fromState: 'pret_a_expedier',
      toState: 'en_livraison',
      at: new Date('2026-10-21T09:00:00.000Z'),
      comment: null,
      hubName: 'Hub Alger',
      situations: [],
    },
  ],
  ...overrides,
});

const order = (overrides: Record<string, unknown> = {}) => ({
  _id: ORDER_ID,
  orderNo: 'ORD-1',
  storeId: STORE_ID,
  vendorEmail: VENDOR_EMAIL,
  deliveryParcelId: PARCEL_ID,
  deliveryCompanyId: 'zr-express',
  status: {
    slug: 'dispatched',
    displayName: 'Dispatched',
    nameEn: 'Dispatched',
    nameFr: 'Expédié',
    nameAr: 'تم الشحن',
    color: '#2563eb',
  },
  history: [
    { status: { slug: 'placed', displayName: 'Placed' }, date: new Date('2026-10-20T08:00:00Z'), user: 'Customer' },
    { status: { slug: 'dispatched', displayName: 'Dispatched' }, date: new Date('2026-10-20T12:00:00Z'), user: 'Vendor' },
  ],
  ...overrides,
});

const carrierParcel = (overrides: Partial<DeliveryStatusParcel> = {}): DeliveryStatusParcel =>
  ({
    parcelId: PARCEL_ID,
    externalId: 'ORD-1',
    trackingNumber: 'TRACK-1',
    deliveryStatus: 'delivered',
    carrierStateId: 'state-11',
    carrierStateName: 'livre',
    carrierStateDescription: 'Livre',
    carrierStateRank: 11,
    carrierStateLocked: false,
    terminal: true,
    situationFlags: [],
    lastStateUpdateAt: new Date('2026-10-22T08:00:00.000Z'),
    deliveryType: 'home',
    situation: null,
    rawSituation: null,
    raw: {},
    ...overrides,
  }) as DeliveryStatusParcel;

const carrierEntry = (overrides: Partial<DeliveryStatusEntry> = {}): DeliveryStatusEntry =>
  ({
    providerEntryId: 'entry-2',
    parcelId: PARCEL_ID,
    fromState: 'en_livraison',
    toState: 'livre',
    at: new Date('2026-10-22T08:00:00.000Z'),
    comment: 'Livre',
    hubName: 'Hub Alger',
    modifiedBy: 'carrier',
    situationFlags: [],
    situations: [],
    raw: {},
    ...overrides,
  }) as DeliveryStatusEntry;

describe('DeliveryStatusQueryService — the read surface (Phase 5)', () => {
  let service: DeliveryStatusQueryService;
  let parcelStatus: {
    findOne: jest.Mock;
    upsertStatus: jest.Mock;
    appendTimelineEntry: jest.Mock;
    compactTimeline: jest.Mock;
    listSummariesForStore: jest.Mock;
    listSummariesForStores: jest.Mock;
    listStoreIds: jest.Mock;
  };
  let handler: jest.Mocked<Partial<DeliveryCompanyHandler>>;
  let orderModel: { findOne: jest.Mock; updateOne: jest.Mock };
  let configModel: { findOne: jest.Mock; find: jest.Mock };
  let registry: { getHandler: jest.Mock };

  const build = () => {
    parcelStatus = {
      findOne: jest.fn().mockResolvedValue(parcelRecord()),
      upsertStatus: jest.fn().mockResolvedValue(undefined),
      appendTimelineEntry: jest.fn().mockResolvedValue(undefined),
      compactTimeline: jest.fn().mockResolvedValue(undefined),
      listSummariesForStore: jest.fn().mockResolvedValue([]),
      listSummariesForStores: jest.fn().mockResolvedValue([]),
      listStoreIds: jest.fn().mockResolvedValue([]),
    };

    handler = {
      searchStatusParcels: jest.fn().mockResolvedValue({ parcels: [carrierParcel()], hasNext: false }),
      fetchStatusHistory: jest.fn().mockResolvedValue([carrierEntry()]),
      resolveStatusTenant: jest.fn().mockResolvedValue('tenant-1'),
    } as unknown as jest.Mocked<Partial<DeliveryCompanyHandler>>;

    orderModel = {
      findOne: jest.fn().mockReturnValue(query(order())),
      updateOne: jest.fn().mockReturnValue(query({ acknowledged: true })),
    };

    configModel = {
      findOne: jest.fn().mockReturnValue(query(null)),
      find: jest.fn().mockReturnValue(query([])),
    };

    registry = { getHandler: jest.fn(() => handler) };

    service = new DeliveryStatusQueryService(
      parcelStatus as never,
      registry as never,
      { resolveStoreIdByEmail: jest.fn().mockResolvedValue(null) } as never,
      orderModel as never,
      configModel as never,
    );
  };

  beforeEach(build);

  describe('the order view', () => {
    it('answers null for an order that does not exist', async () => {
      orderModel.findOne.mockReturnValue(query(null));

      await expect(service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL)).resolves.toBeNull();
    });

    it('answers null for an order that belongs to another store', async () => {
      orderModel.findOne.mockReturnValue(query(order({ storeId: OTHER_STORE_ID })));

      await expect(service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL)).resolves.toBeNull();
    });

    it('accepts a pre-migration order that only carries the legacy vendor email', async () => {
      orderModel.findOne.mockReturnValue(
        query(order({ storeId: undefined, vendorEmail: 'Vendor@Example.com' })),
      );

      const view = await service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL);

      expect(view).not.toBeNull();
      expect(view?.order?.orderNo).toBe('ORD-1');
    });

    it('refuses a pre-migration order whose vendor email is somebody else’s', async () => {
      orderModel.findOne.mockReturnValue(
        query(order({ storeId: undefined, vendorEmail: 'other@example.com' })),
      );

      await expect(service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL)).resolves.toBeNull();
    });

    it('returns the order, the parcel and the sync state of the store’s own order', async () => {
      const view = await service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL);

      expect(view?.order?.status?.slug).toBe('dispatched');
      expect(view?.order?.deliveryParcelId).toBe(PARCEL_ID);
      expect(view?.parcel?.deliveryStatus).toBe('out_for_delivery');
      expect(view?.parcel?.carrierState?.name).toBe('en_livraison');
      expect(view?.parcel?.hub?.name).toBe('Hub Alger');
      expect(view?.parcel?.situationFlags).toEqual(['call_attempt']);
      expect(view?.sync?.state).toBe(DeliverySyncState.SYNCED);
      expect(view?.sync?.lastError).toBeNull();
    });

    it('merges our own order events with the carrier’s transitions', async () => {
      const view = await service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL);

      expect(view?.timeline.map((item) => item.kind)).toEqual(['order', 'order', 'carrier']);
      expect(view?.timeline[2].toStatus).toBe('out_for_delivery');
    });

    it('reads the carrier state through the store’s own override', async () => {
      configModel.findOne.mockReturnValue(
        query({ statusStateOverrides: { 'zr-express': { en_livraison: 'livre' } } }),
      );

      const view = await service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL);

      expect(view?.timeline[2].toStatus).toBe('delivered');
    });

    it('explains the status the carrier would move the order to', async () => {
      parcelStatus.findOne.mockResolvedValue(
        parcelRecord({
          deliveryStatus: 'delivered',
          orderSignal: 'delivered',
          signalSource: 'state',
          lastOrderActionAt: new Date('2026-10-22T08:00:00.000Z'),
        }),
      );

      const view = await service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL);

      // The carrier says "delivered" — the order will end up delivered…
      expect(view?.impliedOrderStatus).toBe('delivered');
      // …but a `dispatched` order takes one legal step first.
      expect(view?.nextOrderStatus).toBe('in-transit');
      expect(view?.orderSignal).toBe('delivered');
      expect(view?.signalSource).toBe('state');
      expect(view?.lastOrderActionAt).toEqual(new Date('2026-10-22T08:00:00.000Z'));
    });

    it('explains a carrier cancellation with its target action', async () => {
      parcelStatus.findOne.mockResolvedValue(
        parcelRecord({
          deliveryStatus: 'cancelled',
          terminal: true,
          orderSignal: 'cancelled',
          signalSource: 'situation',
        }),
      );

      const view = await service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL);

      expect(view?.impliedOrderStatus).toBe('cancelled');
      expect(view?.nextOrderStatus).toBe('cancelled');
      expect(view?.orderSignal).toBe('cancelled');
      expect(view?.signalSource).toBe('situation');
    });

    it('shows the return watch while a delivered parcel is still watched', async () => {
      parcelStatus.findOne.mockResolvedValue(
        parcelRecord({
          deliveryStatus: 'delivered',
          orderSignal: 'delivered',
          returnWatchUntil: new Date('2026-11-05T08:00:00.000Z'),
        }),
      );

      const view = await service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL);

      expect(view?.returnWatchUntil).toEqual(new Date('2026-11-05T08:00:00.000Z'));
    });

    it('implies nothing when the record carries no signal', async () => {
      const view = await service.getOrderView(STORE_ID, ORDER_ID, VENDOR_EMAIL);

      expect(view?.impliedOrderStatus).toBeNull();
      expect(view?.nextOrderStatus).toBeNull();
      expect(view?.orderSignal).toBeNull();
    });
  });

  describe('the parcel view', () => {
    it('answers null when the store does not own the parcel', async () => {
      parcelStatus.findOne.mockResolvedValue(null);

      await expect(service.getParcelView(STORE_ID, PARCEL_ID, VENDOR_EMAIL)).resolves.toBeNull();
    });

    it('looks the parcel up by (store, parcel) — never by the parcel alone', async () => {
      await service.getParcelView(STORE_ID, PARCEL_ID, VENDOR_EMAIL);

      expect(parcelStatus.findOne).toHaveBeenCalledWith(STORE_ID, PARCEL_ID);
    });

    it('still shows the carrier’s view when the order is gone', async () => {
      parcelStatus.findOne.mockResolvedValue(parcelRecord());
      orderModel.findOne.mockReturnValue(query(null));

      const view = await service.getParcelView(STORE_ID, PARCEL_ID, VENDOR_EMAIL);

      expect(view?.order).toBeNull();
      expect(view?.parcel?.parcelId).toBe(PARCEL_ID);
    });
  });

  describe('the manual refresh', () => {
    it('answers null for a parcel the store does not own', async () => {
      parcelStatus.findOne.mockResolvedValue(null);

      await expect(service.refreshParcel(STORE_ID, PARCEL_ID, VENDOR_EMAIL)).resolves.toBeNull();
      expect(handler.searchStatusParcels).not.toHaveBeenCalled();
    });

    it('never advances the order — it only records the carrier’s state', async () => {
      await service.refreshParcel(STORE_ID, PARCEL_ID, VENDOR_EMAIL);

      expect(orderModel.updateOne).toHaveBeenCalledTimes(1);
      const [filter, update] = orderModel.updateOne.mock.calls[0];
      expect(filter._id).toBe(ORDER_ID);
      expect(Object.keys(update.$set)).toEqual(['deliveryStatus']);
    });

    it('refreshes an Ecom record through the Ecom handler and never moves the order (§E5)', async () => {
      parcelStatus.findOne.mockResolvedValue(
        parcelRecord({
          companyId: 'ecom-delivery',
          deliveryStatus: 'in_transit',
          lastCarrierStateAt: new Date('2026-10-21T10:00:00.000Z'),
        }),
      );

      await service.refreshParcel(STORE_ID, PARCEL_ID, VENDOR_EMAIL);

      expect(registry.getHandler).toHaveBeenCalledWith('ecom-delivery');
      expect(parcelStatus.upsertStatus.mock.calls[0][0]).toMatchObject({
        companyId: 'ecom-delivery',
        storeId: STORE_ID,
        parcelId: PARCEL_ID,
      });
      // The refresh only writes the carrier chip; the order's own status is untouched.
      const [filter, update] = orderModel.updateOne.mock.calls[0];
      expect(Object.keys(update.$set)).toEqual(['deliveryStatus']);
      expect(filter).toEqual({ storeId: expect.anything(), _id: ORDER_ID });
    });

    it('writes the carrier’s state and appends the timeline idempotently', async () => {
      await service.refreshParcel(STORE_ID, PARCEL_ID, VENDOR_EMAIL);

      expect(parcelStatus.upsertStatus).toHaveBeenCalledTimes(1);
      expect(parcelStatus.upsertStatus.mock.calls[0][0]).toMatchObject({
        storeId: STORE_ID,
        parcelId: PARCEL_ID,
        deliveryStatus: 'delivered',
        syncState: DeliverySyncState.SYNCED,
      });

      expect(parcelStatus.appendTimelineEntry).toHaveBeenCalledTimes(1);
      expect(parcelStatus.appendTimelineEntry.mock.calls[0][2]).toMatchObject({
        providerEntryId: 'entry-2',
        toState: 'livre',
      });
      expect(parcelStatus.compactTimeline).toHaveBeenCalledWith(STORE_ID, PARCEL_ID);
    });

    it('never closes the poller’s delivered return watch or blanks its bookkeeping', async () => {
      const returnWatchUntil = new Date(Date.now() + 7 * 86_400_000);
      const lastOrderActionAt = new Date('2026-10-22T08:00:00.000Z');
      parcelStatus.findOne.mockResolvedValue(
        parcelRecord({
          deliveryStatus: 'delivered',
          terminal: false,
          terminalConfirmations: 2,
          orderSignal: 'delivered',
          signalSource: 'state',
          returnWatchUntil,
          lastOrderActionAt,
          nextEligiblePollAt: new Date(Date.now() + 30 * 60_000),
        }),
      );

      await service.refreshParcel(STORE_ID, PARCEL_ID, VENDOR_EMAIL);

      expect(parcelStatus.upsertStatus.mock.calls[0][0]).toMatchObject({
        deliveryStatus: 'delivered',
        terminal: false,
        terminalConfirmations: 2,
        orderSignal: 'delivered',
        signalSource: 'state',
        returnWatchUntil,
        lastOrderActionAt,
        nextEligiblePollAt: expect.any(Date),
      });
    });

    it('fails loudly when the carrier cannot answer', async () => {
      (handler as { searchStatusParcels?: unknown }).searchStatusParcels = undefined;

      await expect(service.refreshParcel(STORE_ID, PARCEL_ID, VENDOR_EMAIL)).rejects.toBeInstanceOf(
        AppException,
      );

      try {
        await service.refreshParcel(STORE_ID, PARCEL_ID, VENDOR_EMAIL);
      } catch (error) {
        expect((error as AppException).errorCode).toBe(AppErrorCode.DELIVERY_STATUS_SYNC_FAILED);
      }
    });

    it('fails when the carrier no longer knows the parcel', async () => {
      (handler.searchStatusParcels as jest.Mock).mockResolvedValue({ parcels: [], hasNext: false } as never);

      await expect(service.refreshParcel(STORE_ID, PARCEL_ID, VENDOR_EMAIL)).rejects.toBeInstanceOf(
        AppException,
      );
    });
  });

  describe('the sync health', () => {
    const options = {
      enabled: true,
      intervalMinutes: 15,
      lastCycleAt: new Date('2026-10-22T09:00:00.000Z'),
      nextCycleAt: new Date('2026-10-22T09:15:00.000Z'),
    };

    it('covers only the stores it was scoped to', async () => {
      configModel.find.mockReturnValue(
        query([
          {
            storeId: OTHER_STORE_ID,
            vendorEmail: 'other@example.com',
            companies: { 'zr-express': { status: 'enabled' } },
          },
        ]),
      );
      parcelStatus.listStoreIds.mockResolvedValue([OTHER_STORE_ID]);

      const health = await service.getHealth([STORE_ID], options);

      expect(health.stores.map((store) => store.storeId)).toEqual([STORE_ID]);
    });

    it('covers every store for an operator who did not narrow the scope', async () => {
      configModel.find.mockReturnValue(
        query([
          {
            storeId: OTHER_STORE_ID,
            vendorEmail: 'other@example.com',
            companies: { 'zr-express': { status: 'enabled' } },
          },
        ]),
      );
      parcelStatus.listStoreIds.mockResolvedValue([OTHER_STORE_ID]);

      const health = await service.getHealth(null, options);

      expect(health.stores.map((store) => store.storeId)).toEqual([OTHER_STORE_ID]);
    });

    it('reports the master switch and the cycle window', async () => {
      const health = await service.getHealth([STORE_ID], options);

      expect(health.enabled).toBe(true);
      expect(health.intervalMinutes).toBe(15);
      expect(health.lastCycleAt).toEqual(options.lastCycleAt);
      expect(health.nextCycleAt).toEqual(options.nextCycleAt);
    });

    it('names the provider it describes (§E5)', async () => {
      const health = await service.getHealth([STORE_ID], { ...options, companyId: 'ecom-delivery' });

      expect(health.provider).toBe('ecom-delivery');
      expect(health.totals.provider).toBe('ecom-delivery');
      expect(health.stores[0].provider).toBe('ecom-delivery');
    });

    it('counts not-found parcels separately from errors (§E3/E5)', async () => {
      parcelStatus.listSummariesForStore.mockResolvedValue([
        {
          storeId: STORE_ID,
          parcelId: 'p1',
          deliveryStatus: 'in_transit',
          syncState: DeliverySyncState.NOT_FOUND,
          lastPolledAt: new Date(),
          lastChangedAt: null,
          nextEligiblePollAt: null,
          carrierStateLocked: false,
          carrierStateName: 'en_transit',
          terminal: false,
          consecutiveFailures: 0,
        },
        {
          storeId: STORE_ID,
          parcelId: 'p2',
          deliveryStatus: 'in_transit',
          syncState: DeliverySyncState.ERROR,
          lastPolledAt: new Date(),
          lastChangedAt: null,
          nextEligiblePollAt: null,
          carrierStateLocked: false,
          carrierStateName: 'en_transit',
          terminal: false,
          consecutiveFailures: 1,
        },
      ]);

      const health = await service.getHealth([STORE_ID], options);

      expect(health.stores[0].notFoundParcels).toBe(1);
      expect(health.stores[0].errors24h).toBe(1);
      expect(health.totals.notFound).toBe(1);
    });

    it('reports a paused provider as disabled but still shows its records (§E5)', async () => {
      configModel.findOne.mockReturnValue(
        query({
          storeId: STORE_ID,
          companies: { 'ecom-delivery': { status: 'enabled', statusSyncEnabled: false } },
        }),
      );

      const health = await service.getHealth([STORE_ID], {
        ...options,
        companyId: 'ecom-delivery',
      });

      expect(health.stores[0].enabled).toBe(false);
    });

    it('counts the parcels by their carrier status', async () => {
      parcelStatus.listSummariesForStore.mockResolvedValue([
        {
          storeId: STORE_ID,
          parcelId: 'p1',
          deliveryStatus: 'out_for_delivery',
          syncState: DeliverySyncState.SYNCED,
          lastPolledAt: new Date(),
          lastChangedAt: new Date(),
          nextEligiblePollAt: null,
          carrierStateLocked: false,
          carrierStateName: 'en_livraison',
          terminal: false,
          consecutiveFailures: 0,
        },
        {
          storeId: STORE_ID,
          parcelId: 'p2',
          deliveryStatus: 'out_for_delivery',
          syncState: DeliverySyncState.SYNCED,
          lastPolledAt: new Date(),
          lastChangedAt: new Date(),
          nextEligiblePollAt: null,
          carrierStateLocked: false,
          carrierStateName: 'en_livraison',
          terminal: false,
          consecutiveFailures: 0,
        },
      ]);

      const health = await service.getHealth([STORE_ID], options);

      expect(health.stores[0].trackedParcels).toBe(2);
      expect(health.stores[0].byDeliveryStatus).toEqual({ out_for_delivery: 2 });
      expect(health.totals.trackedParcels).toBe(2);
    });

    it('counts the errors, the unknown states and the locked parcels of the last day', async () => {
      const polledRecently = new Date();
      parcelStatus.listSummariesForStore.mockResolvedValue([
        {
          storeId: STORE_ID,
          parcelId: 'p1',
          deliveryStatus: 'unknown',
          syncState: DeliverySyncState.ERROR,
          lastPolledAt: polledRecently,
          lastChangedAt: polledRecently,
          nextEligiblePollAt: null,
          carrierStateLocked: true,
          carrierStateName: 'weird_state',
          terminal: false,
          consecutiveFailures: 2,
        },
        {
          storeId: STORE_ID,
          parcelId: 'p2',
          deliveryStatus: 'unknown',
          syncState: DeliverySyncState.ERROR,
          lastPolledAt: new Date('2026-01-01T00:00:00.000Z'),
          lastChangedAt: null,
          nextEligiblePollAt: null,
          carrierStateLocked: false,
          carrierStateName: null,
          terminal: false,
          consecutiveFailures: 9,
        },
      ]);

      const health = await service.getHealth([STORE_ID], options);

      expect(health.stores[0].errors24h).toBe(1);
      expect(health.stores[0].unknownStates24h).toBe(1);
      expect(health.stores[0].lockedParcels).toBe(1);
    });

    it('counts a parcel as stalled when it stopped moving for too long', async () => {
      parcelStatus.listSummariesForStore.mockResolvedValue([
        {
          storeId: STORE_ID,
          parcelId: 'p1',
          deliveryStatus: 'out_for_delivery',
          syncState: DeliverySyncState.SYNCED,
          lastPolledAt: new Date(Date.now() - 60 * 60 * 1000),
          lastChangedAt: null,
          nextEligiblePollAt: null,
          carrierStateLocked: false,
          carrierStateName: 'en_livraison',
          terminal: false,
          consecutiveFailures: 0,
        },
      ]);

      const health = await service.getHealth([STORE_ID], options);

      expect(health.stores[0].stalledParcels).toBe(1);
    });

    it('never leaks a credential — only the tenant id', async () => {
      parcelStatus.listSummariesForStore.mockResolvedValue([]);
      (handler.resolveStatusTenant as jest.Mock).mockResolvedValue('tenant-1' as never);

      const health = await service.getHealth([STORE_ID], options);

      expect(health.stores[0].tenantId).toBe('tenant-1');
      expect(JSON.stringify(health)).not.toMatch(/apiKey|secret|password/i);
    });
  });
});
