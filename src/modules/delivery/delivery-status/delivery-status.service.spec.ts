import { DeliveryStatusService } from './delivery-status.service';
import { DeliveryStatusLeaseService } from './delivery-status-lease.service';
import { DeliveryStatusScheduler } from './delivery-status.scheduler';
import { TokenBucket } from './token-bucket';
import { DeliverySyncState } from '../../../common/constants/delivery-status.const';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import type {
  DeliveryCompanyHandler,
  DeliveryStatusEntry,
  DeliveryStatusParcel,
} from '../delivery-companies/interfaces/delivery-company-handler.interface';
import type { DeliveryStatusAdvance } from './delivery-status-advance.interface';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const OTHER_STORE_ID = '6ac400e26b1b2c3d4e5f6a72';
const ORDER_ID = '6ac400e26b1b2c3d4e5f6a73';
const PARCEL_ID = 'parcel-1';
const TENANT = 'tenant-1';

/** A chainable query stub — the poller uses `.exec()`, `.select()` and `.lean()`. */
function query<T>(result: T) {
  const q: Record<string, unknown> = {};
  q.exec = jest.fn().mockResolvedValue(result);
  q.select = jest.fn().mockReturnValue(q);
  q.lean = jest.fn().mockReturnValue(q);
  return q;
}

const parcel = (overrides: Partial<DeliveryStatusParcel> = {}): DeliveryStatusParcel => ({
  parcelId: PARCEL_ID,
  externalId: 'ORD-1',
  trackingNumber: 'TRACK-1',
  deliveryStatus: 'in_transit',
  carrierStateId: 'state-1',
  carrierStateName: 'en_transit',
  carrierStateDescription: 'En transit',
  carrierStateRank: 5,
  carrierStateLocked: false,
  terminal: false,
  situationFlags: [],
  lastStateUpdateAt: new Date('2026-10-21T10:00:00.000Z'),
  deliveryType: 'home',
  situation: null,
  rawSituation: null,
  raw: {},
  ...overrides,
});

const entry = (overrides: Partial<DeliveryStatusEntry> = {}): DeliveryStatusEntry => ({
  providerEntryId: 'entry-1',
  parcelId: PARCEL_ID,
  fromState: 'pret_a_expedier',
  toState: 'en_transit',
  fromStatus: 'ready_for_pickup',
  toStatus: 'in_transit',
  at: new Date('2026-10-21T10:00:00.000Z'),
  comment: null,
  hubName: 'Hub Alger',
  hubCity: 'Alger',
  hubDistrict: 'Alger Centre',
  modifiedBy: 'carrier',
  situationFlags: [],
  situations: [],
  raw: {},
  ...overrides,
});

const order = (overrides: Record<string, unknown> = {}) => ({
  _id: ORDER_ID,
  orderNo: 'ORD-1',
  storeId: STORE_ID,
  deliveryParcelId: PARCEL_ID,
  deliveryCompanyId: 'zr-express',
  status: { slug: 'dispatched' },
  ...overrides,
});

/** A transaction stub — the poller opens a session and commits one parcel's writes in it. */
function sessionStub() {
  const s: Record<string, unknown> = {};
  s.startTransaction = jest.fn().mockResolvedValue(undefined);
  s.abortTransaction = jest.fn().mockResolvedValue(undefined);
  s.commitTransaction = jest.fn().mockResolvedValue(undefined);
  s.endSession = jest.fn().mockResolvedValue(undefined);
  s.withTransaction = jest.fn(async (work: (given: unknown) => Promise<unknown>) => work(s));
  return s;
}

describe('DeliveryStatusService — the cycle (Phase 3, §12.2)', () => {
  let service: DeliveryStatusService;
  let handler: jest.Mocked<Partial<DeliveryCompanyHandler>>;
  let parcelStatus: {
    upsertStatus: jest.Mock;
    appendTimelineEntry: jest.Mock;
    compactTimeline: jest.Mock;
    listForStore: jest.Mock;
    findOne: jest.Mock;
    patchStatus: jest.Mock;
  };
  let configModel: { find: jest.Mock };
  let orderModel: { find: jest.Mock; findOne: jest.Mock; updateOne: jest.Mock; startSession: jest.Mock };
  let storesService: { resolveStoreIdByEmail: jest.Mock };
  let advance: { advance: jest.Mock };
  let sessions: any[];
  const build = (options: { advance?: DeliveryStatusAdvance } = {}) => {
    const configService = {
      get: (key: string) => {
        const values: Record<string, unknown> = {
          'zrStatusSync.enabled': true,
          'zrStatusSync.intervalMinutes': 15,
          'zrStatusSync.maxCallsPerMinute': 20,
          'zrStatusSync.jitterRatio': 0.2,
          'zrStatusSync.terminalConfirmations': 3,
          'zrStatusSync.leaseSeconds': 120,
        };
        return values[key];
      },
    };

    return new DeliveryStatusService(
      configService as never,
      { getHandler: () => handler } as never,
      parcelStatus as never,
      storesService as never,
      configModel as never,
      orderModel as never,
      options.advance,
    );
  };

  beforeEach(() => {
    handler = {
      searchStatusParcels: jest.fn().mockResolvedValue({
        parcels: [parcel()],
        totalCount: 1,
        hasNext: false,
      }),
      fetchStatusHistory: jest.fn().mockResolvedValue([entry()]),
      resolveStatusTenant: jest.fn().mockResolvedValue(TENANT),
    };

    parcelStatus = {
      upsertStatus: jest.fn().mockResolvedValue({}),
      appendTimelineEntry: jest.fn().mockResolvedValue(true),
      compactTimeline: jest.fn().mockResolvedValue(false),
      listForStore: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      patchStatus: jest.fn().mockResolvedValue({}),
    };

    configModel = {
      find: jest.fn().mockReturnValue(
        query([
          {
            storeId: STORE_ID,
            vendorEmail: 'vendor@example.com',
            companies: { 'zr-express': { status: 'enabled' } },
          },
        ]),
      ),
    };

    orderModel = {
      find: jest.fn().mockReturnValue(query([order()])),
      findOne: jest.fn().mockReturnValue(query({ _id: ORDER_ID })),
      updateOne: jest.fn().mockReturnValue(query({ modifiedCount: 1 })),
      startSession: jest.fn(),
    };

    sessions = [];
    orderModel.startSession.mockImplementation(async () => {
      const session = sessionStub();
      sessions.push(session);
      return session;
    });

    storesService = { resolveStoreIdByEmail: jest.fn().mockResolvedValue(null) };
    advance = { advance: jest.fn().mockResolvedValue({ outcome: 'advanced' }) };

    service = build();
  });

  it('polls the store that has a ZR Express configuration', async () => {
    const summary = await service.runCycle();

    expect(summary.stores).toBe(1);
    expect(summary.discovered).toBe(1);
    expect(summary.detailCalls).toBe(1);
    expect(handler.searchStatusParcels).toHaveBeenCalledTimes(1);
  });

  it('skips a configuration without a ZR Express company', async () => {
    configModel.find.mockReturnValue(
      query([
        {
          storeId: STORE_ID,
          vendorEmail: 'a@example.com',
          companies: { noest: { status: 'enabled' } },
        },
      ]),
    );

    const summary = await service.runCycle();

    expect(summary.stores).toBe(0);
    expect(handler.searchStatusParcels).not.toHaveBeenCalled();
  });

  it('skips a configuration whose ZR Express company is disabled', async () => {
    configModel.find.mockReturnValue(
      query([
        {
          storeId: STORE_ID,
          vendorEmail: 'a@example.com',
          companies: { 'zr-express': { status: 'disabled' } },
        },
      ]),
    );

    const summary = await service.runCycle();

    expect(summary.stores).toBe(0);
  });

  it('resolves a legacy configuration through the vendor email', async () => {
    configModel.find.mockReturnValue(
      query([
        {
          storeId: null,
          vendorEmail: 'legacy@example.com',
          companies: { 'zr-express': { status: 'enabled' } },
        },
      ]),
    );
    storesService.resolveStoreIdByEmail.mockResolvedValue(OTHER_STORE_ID);

    const summary = await service.runCycle();

    expect(storesService.resolveStoreIdByEmail).toHaveBeenCalledWith('legacy@example.com');
    expect(summary.stores).toBe(1);
    // The legacy configuration's resolved store is the one that is polled.
    const [written] = parcelStatus.upsertStatus.mock.calls[0];
    expect(written.storeId).toBe(OTHER_STORE_ID);
  });

  it('skips a store whose credentials cannot be resolved — silently', async () => {
    handler.resolveStatusTenant = jest.fn().mockResolvedValue(null);

    const summary = await service.runCycle();

    expect(summary.stores).toBe(1);
    expect(summary.discovered).toBe(0);
    expect(handler.searchStatusParcels).not.toHaveBeenCalled();
  });

  it('writes the parcel record, the timeline and the order chip', async () => {
    await service.runCycle();

    expect(parcelStatus.upsertStatus).toHaveBeenCalledTimes(1);
    const [written] = parcelStatus.upsertStatus.mock.calls[0];
    expect(written).toMatchObject({
      storeId: STORE_ID,
      companyId: 'zr-express',
      parcelId: PARCEL_ID,
      orderNo: 'ORD-1',
      deliveryStatus: 'in_transit',
      carrierStateName: 'en_transit',
      hubName: 'Hub Alger',
      hubCity: 'Alger',
      hubDistrict: 'Alger Centre',
      syncState: DeliverySyncState.SYNCED,
      consecutiveFailures: 0,
    });

    expect(parcelStatus.appendTimelineEntry).toHaveBeenCalledTimes(1);
    const [scope, parcelId, timelineEntry] = parcelStatus.appendTimelineEntry.mock.calls[0];
    expect(scope).toBe(STORE_ID);
    expect(parcelId).toBe(PARCEL_ID);
    expect(timelineEntry).toMatchObject({
      providerEntryId: 'entry-1',
      toState: 'en_transit',
      hubName: 'Hub Alger',
      modifiedBy: 'carrier',
    });

    // The order carries a denormalised copy of the status (§11.5).
    expect(orderModel.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = orderModel.updateOne.mock.calls[0];
    expect(String(filter.storeId)).toBe(STORE_ID);
    expect(String(filter._id)).toBe(ORDER_ID);
    expect(update.$set).toEqual({ deliveryStatus: 'in_transit' });
  });

  it('never detail-polls a parcel whose carrier state has not moved (§12.4)', async () => {
    parcelStatus.listForStore.mockResolvedValue([
      {
        parcelId: PARCEL_ID,
        deliveryStatus: 'in_transit',
        lastCarrierStateAt: new Date('2026-10-21T12:00:00.000Z'),
        terminal: false,
        nextEligiblePollAt: null,
      },
    ]);

    await service.runCycle();

    expect(handler.fetchStatusHistory).not.toHaveBeenCalled();
    expect(parcelStatus.upsertStatus).not.toHaveBeenCalled();
  });

  it('stops polling a parcel that reached a terminal state (§12.3)', async () => {
    parcelStatus.listForStore.mockResolvedValue([
      {
        parcelId: PARCEL_ID,
        deliveryStatus: 'delivered',
        lastCarrierStateAt: new Date('2026-10-20T10:00:00.000Z'),
        terminal: true,
        terminalConfirmations: 3,
        nextEligiblePollAt: null,
      },
    ]);

    await service.runCycle();

    expect(handler.fetchStatusHistory).not.toHaveBeenCalled();
  });

  it('keeps a delivered parcel on the return watch instead of stopping immediately (§7.3)', async () => {
    handler.searchStatusParcels = jest.fn().mockResolvedValue({
      parcels: [parcel({ deliveryStatus: 'delivered', terminal: true })],
      totalCount: 1,
      hasNext: false,
    });

    parcelStatus.listForStore.mockResolvedValue([
      {
        parcelId: PARCEL_ID,
        deliveryStatus: 'delivered',
        lastCarrierStateAt: new Date('2026-10-20T10:00:00.000Z'),
        terminal: false,
        terminalConfirmations: 2,
        nextEligiblePollAt: null,
      },
    ]);

    await service.runCycle();

    const [written] = parcelStatus.upsertStatus.mock.calls[0];
    expect(written.terminalConfirmations).toBe(3);
    expect(written.terminal).toBe(false);
    expect(written.returnWatchUntil).toBeInstanceOf(Date);
    const watchDays = Math.round(
      (written.returnWatchUntil.getTime() - Date.now()) / 86_400_000,
    );
    expect(watchDays).toBe(14);
    const pollMinutes = Math.round(
      (written.nextEligiblePollAt.getTime() - Date.now()) / 60_000,
    );
    expect(pollMinutes).toBe(60);
  });

  it('stops polling a delivered parcel once the return watch has elapsed (§7.3)', async () => {
    handler.searchStatusParcels = jest.fn().mockResolvedValue({
      parcels: [parcel({ deliveryStatus: 'delivered', terminal: true })],
      totalCount: 1,
      hasNext: false,
    });

    parcelStatus.listForStore.mockResolvedValue([
      {
        parcelId: PARCEL_ID,
        deliveryStatus: 'delivered',
        lastCarrierStateAt: new Date('2026-10-01T10:00:00.000Z'),
        terminal: false,
        terminalConfirmations: 2,
        returnWatchUntil: new Date(Date.now() - 60_000),
        nextEligiblePollAt: null,
      },
    ]);

    await service.runCycle();

    const [written] = parcelStatus.upsertStatus.mock.calls[0];
    expect(written.terminal).toBe(true);
    expect(written.nextEligiblePollAt).toBeNull();
  });

  it('honours a backoff window that has not expired', async () => {
    parcelStatus.listForStore.mockResolvedValue([
      {
        parcelId: PARCEL_ID,
        deliveryStatus: 'in_transit',
        lastCarrierStateAt: new Date('2026-10-20T10:00:00.000Z'),
        terminal: false,
        nextEligiblePollAt: new Date(Date.now() + 10 * 60_000),
      },
    ]);

    await service.runCycle();

    expect(handler.fetchStatusHistory).not.toHaveBeenCalled();
  });

  it('a failing parcel never aborts the cycle (§14.5)', async () => {
    handler.searchStatusParcels = jest.fn().mockResolvedValue({
      parcels: [parcel(), parcel({ parcelId: 'parcel-2' })],
      totalCount: 2,
      hasNext: false,
    });
    orderModel.find.mockReturnValue(
      query([
        order(),
        order({ _id: '6ac400e26b1b2c3d4e5f6a74', orderNo: 'ORD-2', deliveryParcelId: 'parcel-2' }),
      ]),
    );
    handler.fetchStatusHistory = jest
      .fn()
      .mockRejectedValueOnce(new Error('carrier timeout'))
      .mockResolvedValueOnce([entry({ providerEntryId: 'entry-2' })]);

    const summary = await service.runCycle();

    expect(summary.failed).toBe(1);
    expect(summary.changed).toBe(1);
    expect(handler.fetchStatusHistory).toHaveBeenCalledTimes(2);
  });

  it('backs a failed parcel off on the ladder (§14.3)', async () => {
    handler.fetchStatusHistory = jest.fn().mockRejectedValue(new Error('carrier timeout'));

    await service.runCycle();

    const [written] = parcelStatus.upsertStatus.mock.calls[0];
    expect(written.syncState).toBe(DeliverySyncState.ERROR);
    expect(written.consecutiveFailures).toBe(1);
    expect(written.lastError).toBeTruthy();

    const waitMinutes = Math.round(
      (new Date(written.nextEligiblePollAt).getTime() - Date.now()) / 60_000,
    );
    expect(waitMinutes).toBeGreaterThanOrEqual(4);
    expect(waitMinutes).toBeLessThanOrEqual(5);
  });

  it('honours a Retry-After header, capped at 60 minutes (§14.3)', async () => {
    handler.fetchStatusHistory = jest.fn().mockRejectedValue(
      new AppException(AppErrorCode.DELIVERY_STATUS_SYNC_FAILED, {
        retryAfterSeconds: 300,
      }),
    );

    await service.runCycle();

    const [written] = parcelStatus.upsertStatus.mock.calls[0];
    const waitMinutes = Math.round(
      (new Date(written.nextEligiblePollAt).getTime() - Date.now()) / 60_000,
    );
    expect(waitMinutes).toBeGreaterThanOrEqual(4);
    expect(waitMinutes).toBeLessThanOrEqual(5);
  });

  it('stops calling the carrier when the call budget is exhausted (§12.5)', async () => {
    const configService = {
      get: (key: string) =>
        ({
          'zrStatusSync.enabled': true,
          'zrStatusSync.intervalMinutes': 15,
          'zrStatusSync.maxCallsPerMinute': 1,
          'zrStatusSync.jitterRatio': 0.2,
          'zrStatusSync.terminalConfirmations': 3,
          'zrStatusSync.leaseSeconds': 120,
        })[key],
    };
    service = new DeliveryStatusService(
      configService as never,
      { getHandler: () => handler } as never,
      parcelStatus as never,
      storesService as never,
      configModel as never,
      orderModel as never,
    );

    handler.searchStatusParcels = jest.fn().mockResolvedValue({
      parcels: [parcel()],
      totalCount: 1,
      hasNext: true,
    });

    const summary = await service.runCycle();

    // One discovery call spent the only token; the detail call is never made.
    expect(handler.searchStatusParcels).toHaveBeenCalledTimes(1);
    expect(handler.fetchStatusHistory).not.toHaveBeenCalled();
    expect(summary.detailCalls).toBe(0);
  });

  it('requests the advance through the seam rather than writing the order (§12.2)', async () => {
    service = build({ advance: advance as unknown as DeliveryStatusAdvance });
    handler.searchStatusParcels = jest.fn().mockResolvedValue({
      parcels: [parcel({ deliveryStatus: 'delivered' })],
      totalCount: 1,
      hasNext: false,
    });

    await service.runCycle();

    expect(advance.advance).toHaveBeenCalledTimes(1);
    const [request] = advance.advance.mock.calls[0];
    expect(request).toMatchObject({
      storeId: STORE_ID,
      orderNo: 'ORD-1',
      parcelId: PARCEL_ID,
      fromStatus: 'dispatched',
      toStatus: 'delivered',
      deliveryStatus: 'delivered',
      signal: 'delivered',
      target: 'delivered',
      steps: ['in-transit', 'delivered'],
      inventoryAware: false,
    });
  });

  it('asks for an inventory-aware cancellation when the carrier cancels (§6.1)', async () => {
    service = build({ advance: advance as unknown as DeliveryStatusAdvance });
    orderModel.find.mockReturnValue(query([order({ status: { slug: 'confirmed' } })]));
    handler.searchStatusParcels = jest.fn().mockResolvedValue({
      parcels: [
        parcel({ deliveryStatus: 'cancelled', carrierStateName: 'annule', carrierStateDescription: 'Annulé' }),
      ],
      totalCount: 1,
      hasNext: false,
    });

    await service.runCycle();

    const [request] = advance.advance.mock.calls[0];
    expect(request).toMatchObject({
      fromStatus: 'confirmed',
      toStatus: 'cancelled',
      signal: 'cancelled',
      target: 'cancelled',
      steps: ['cancelled'],
      inventoryAware: true,
    });
    const [written] = parcelStatus.upsertStatus.mock.calls[0];
    expect(written.terminal).toBe(true);
    expect(written.nextEligiblePollAt).toBeNull();
  });

  it('asks for a carrier return from a delivered order without touching inventory (§6.1)', async () => {
    service = build({ advance: advance as unknown as DeliveryStatusAdvance });
    orderModel.find.mockReturnValue(query([order({ status: { slug: 'delivered' } })]));
    handler.searchStatusParcels = jest.fn().mockResolvedValue({
      parcels: [
        parcel({ deliveryStatus: 'returned', carrierStateName: 'retour', carrierStateDescription: 'Retour' }),
      ],
      totalCount: 1,
      hasNext: false,
    });

    await service.runCycle();

    const [request] = advance.advance.mock.calls[0];
    expect(request).toMatchObject({
      fromStatus: 'delivered',
      toStatus: 'returned',
      signal: 'returned',
      target: 'returned',
      steps: ['returned'],
      inventoryAware: false,
    });
    const [written] = parcelStatus.upsertStatus.mock.calls[0];
    expect(written.terminal).toBe(true);
    expect(written.nextEligiblePollAt).toBeNull();
  });

  it('does not advance when the provider is not bound yet', async () => {
    handler.searchStatusParcels = jest.fn().mockResolvedValue({
      parcels: [parcel({ deliveryStatus: 'delivered' })],
      totalCount: 1,
      hasNext: false,
    });

    const summary = await service.runCycle();

    expect(summary.advanced).toBe(0);
    // The timeline is still written — the vendor never sees the carrier and the order disagree.
    expect(parcelStatus.upsertStatus).toHaveBeenCalledTimes(1);
  });

  /**
   * Phase 4 (roadmap §10.3 item 4, §10.4).
   *
   * The carrier's record and the order's own status must commit together, and a disagreement
   * must be visible on the record instead of being swallowed.
   */
  describe('the carrier advance (Phase 4)', () => {
    it('writes the record and advances the order inside one transaction', async () => {
      service = build({ advance: advance as unknown as DeliveryStatusAdvance });
      handler.searchStatusParcels = jest.fn().mockResolvedValue({
        parcels: [parcel({ deliveryStatus: 'delivered' })],
        totalCount: 1,
        hasNext: false,
      });

      await service.runCycle();

      const session = sessions[sessions.length - 1];
      expect(parcelStatus.upsertStatus.mock.calls[0][1]).toBe(session);
      expect(advance.advance.mock.calls[0][1]).toBe(session);
      expect(session.withTransaction).toHaveBeenCalledTimes(1);
    });

    it('records the conflict when the order refuses to follow the carrier', async () => {
      service = build({ advance: advance as unknown as DeliveryStatusAdvance });
      advance.advance.mockResolvedValue({
        outcome: 'conflict',
        reason: 'order_cancelled_before_delivery',
      });
      handler.searchStatusParcels = jest.fn().mockResolvedValue({
        parcels: [parcel({ deliveryStatus: 'delivered' })],
        totalCount: 1,
        hasNext: false,
      });

      const summary = await service.runCycle();

      expect(summary.conflicts).toBe(1);
      expect(summary.advanced).toBe(0);
      const conflictPatch = parcelStatus.patchStatus.mock.calls.find(
        (call) => (call[2] as Record<string, unknown>)?.conflict !== undefined,
      );
      expect(conflictPatch?.[2]).toMatchObject({ conflict: 'order_cancelled_before_delivery' });
      expect((conflictPatch?.[2] as Record<string, unknown>).conflictAt).toBeInstanceOf(Date);
    });

    it('falls back to a known conflict code when the reason is not one of ours', async () => {
      service = build({ advance: advance as unknown as DeliveryStatusAdvance });
      advance.advance.mockResolvedValue({ outcome: 'conflict', reason: 'something-else' });
      handler.searchStatusParcels = jest.fn().mockResolvedValue({
        parcels: [parcel({ deliveryStatus: 'delivered' })],
        totalCount: 1,
        hasNext: false,
      });

      await service.runCycle();

      const conflictPatch = parcelStatus.patchStatus.mock.calls.find(
        (call) => (call[2] as Record<string, unknown>)?.conflict !== undefined,
      );
      expect((conflictPatch?.[2] as Record<string, unknown>).conflict).toBe('order_status_moved');
    });

    it('clears a stale conflict once the order follows the carrier', async () => {
      service = build({ advance: advance as unknown as DeliveryStatusAdvance });
      handler.searchStatusParcels = jest.fn().mockResolvedValue({
        parcels: [parcel({ deliveryStatus: 'delivered' })],
        totalCount: 1,
        hasNext: false,
      });

      const summary = await service.runCycle();

      expect(summary.advanced).toBe(1);
      const clear = parcelStatus.patchStatus.mock.calls.find(
        (call) => (call[2] as Record<string, unknown>)?.conflict === null,
      );
      expect(clear?.[2]).toMatchObject({ conflict: null, conflictAt: null });
    });

    it('keeps the record and the order in step when the datastore has no transactions', async () => {
      service = build({ advance: advance as unknown as DeliveryStatusAdvance });
      orderModel.startSession.mockRejectedValue(
        new AppException(AppErrorCode.INVALID_COMBINATION, { reason: 'transactions_unavailable' }),
      );
      handler.searchStatusParcels = jest.fn().mockResolvedValue({
        parcels: [parcel({ deliveryStatus: 'delivered' })],
        totalCount: 1,
        hasNext: false,
      });

      const summary = await service.runCycle();

      expect(summary.advanced).toBe(1);
      expect(parcelStatus.upsertStatus.mock.calls[0][1]).toBeUndefined();
      expect(advance.advance.mock.calls[0][1]).toBeUndefined();
    });

    it('never advances an order that is already where the carrier says it is', async () => {
      service = build({ advance: advance as unknown as DeliveryStatusAdvance });
      orderModel.find.mockReturnValue(query([order({ status: { slug: 'in-transit' } })]));
      handler.searchStatusParcels = jest.fn().mockResolvedValue({
        parcels: [parcel({ deliveryStatus: 'in_transit' })],
        totalCount: 1,
        hasNext: false,
      });

      const summary = await service.runCycle();

      expect(advance.advance).not.toHaveBeenCalled();
      expect(summary.advanced).toBe(0);
    });

    it('counts a failed advance without losing the carrier’s record', async () => {
      service = build({ advance: advance as unknown as DeliveryStatusAdvance });
      advance.advance.mockRejectedValue(new Error('the orders module is down'));
      handler.searchStatusParcels = jest.fn().mockResolvedValue({
        parcels: [parcel({ deliveryStatus: 'delivered' })],
        totalCount: 1,
        hasNext: false,
      });

      const summary = await service.runCycle();

      expect(summary.failed).toBe(1);
      expect(summary.advanced).toBe(0);
      expect(parcelStatus.upsertStatus).toHaveBeenCalledTimes(1);
    });
  });

  it('does not advance an order that is not on a legal edge', async () => {
    service = build({ advance: advance as unknown as DeliveryStatusAdvance });
    orderModel.find.mockReturnValue(
      query([order({ status: { slug: 'placed' } })]),
    );

    await service.runCycle();

    expect(advance.advance).not.toHaveBeenCalled();
  });

  it('scopes every write to the store it polled (§18.3)', async () => {
    await service.runCycle();

    for (const call of parcelStatus.upsertStatus.mock.calls) {
      expect(call[0].storeId).toBe(STORE_ID);
      expect(call[0].storeId).not.toBe(OTHER_STORE_ID);
    }
    for (const call of parcelStatus.appendTimelineEntry.mock.calls) {
      expect(call[0]).toBe(STORE_ID);
    }
  });

  describe('a parcel the carrier no longer knows (§E3)', () => {
    const record = (overrides: Record<string, unknown> = {}) => ({
      parcelId: PARCEL_ID,
      companyId: 'zr-express',
      consecutiveMisses: 0,
      syncState: DeliverySyncState.SYNCED,
      ...overrides,
    });

    it('counts a miss without treating it as a transport failure', async () => {
      parcelStatus.listForStore.mockResolvedValue([record()]);
      handler.searchStatusParcels = jest.fn().mockResolvedValue({
        parcels: [],
        totalCount: 0,
        hasNext: false,
        missingParcelIds: [PARCEL_ID],
      });

      await service.runCycle();

      expect(handler.fetchStatusHistory).not.toHaveBeenCalled();
      expect(parcelStatus.patchStatus).toHaveBeenCalledWith(
        STORE_ID,
        PARCEL_ID,
        expect.objectContaining({
          consecutiveMisses: 1,
          syncState: DeliverySyncState.SYNCED,
        }),
      );
      // A miss is a valid answer, not an error: the failure counter and lastError are untouched.
      const patch = parcelStatus.patchStatus.mock.calls[0][2];
      expect(patch).not.toHaveProperty('lastError');
      expect(patch).not.toHaveProperty('consecutiveFailures');
    });

    it('parks a parcel as not_found after three consecutive misses', async () => {
      parcelStatus.listForStore.mockResolvedValue([record({ consecutiveMisses: 2 })]);
      handler.searchStatusParcels = jest.fn().mockResolvedValue({
        parcels: [],
        totalCount: 0,
        hasNext: false,
        missingParcelIds: [PARCEL_ID],
      });

      await service.runCycle();

      expect(parcelStatus.patchStatus).toHaveBeenCalledWith(
        STORE_ID,
        PARCEL_ID,
        expect.objectContaining({
          consecutiveMisses: 3,
          syncState: DeliverySyncState.NOT_FOUND,
          nextEligiblePollAt: null,
        }),
      );
    });

    it('never counts a miss for a parcel the store does not track', async () => {
      parcelStatus.listForStore.mockResolvedValue([]);
      handler.searchStatusParcels = jest.fn().mockResolvedValue({
        parcels: [],
        totalCount: 0,
        hasNext: false,
        missingParcelIds: ['foreign-parcel'],
      });

      await service.runCycle();

      expect(parcelStatus.patchStatus).not.toHaveBeenCalled();
      expect(parcelStatus.upsertStatus).not.toHaveBeenCalled();
    });

    it('resets the miss counter when the carrier recognises the parcel again', async () => {
      parcelStatus.listForStore.mockResolvedValue([record({ consecutiveMisses: 2 })]);

      await service.runCycle();

      expect(parcelStatus.upsertStatus).toHaveBeenCalledWith(
        expect.objectContaining({ consecutiveMisses: 0 }),
        expect.anything(),
      );
    });
  });

  it('skips a paused store but keeps polling the others (§E3/E5)', async () => {
    configModel.find.mockReturnValue(
      query([
        {
          storeId: STORE_ID,
          vendorEmail: 'vendor@example.com',
          companies: { 'zr-express': { status: 'enabled' } },
          statusSyncEnabled: false,
        },
      ]),
    );

    const summary = await service.runCycle();

    expect(summary.stores).toBe(0);
    expect(handler.searchStatusParcels).not.toHaveBeenCalled();
  });

  it('skips a provider paused for one store only (§E3)', async () => {
    configModel.find.mockReturnValue(
      query([
        {
          storeId: STORE_ID,
          vendorEmail: 'vendor@example.com',
          companies: { 'zr-express': { status: 'enabled', statusSyncEnabled: false } },
        },
      ]),
    );

    const summary = await service.runCycle();

    expect(summary.stores).toBe(0);
    expect(handler.searchStatusParcels).not.toHaveBeenCalled();
  });

  it('runs only one cycle at a time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handler.searchStatusParcels = jest.fn().mockImplementation(async () => {
      await gate;
      return { parcels: [], totalCount: 0, hasNext: false };
    });

    const first = service.runCycle();
    const second = await service.runCycle();

    expect(second.skipped).toBe('in_flight');

    release();
    await first;
  });
});

describe('DeliveryStatusService — the reconciliation sweep (Phase 3, §15.3, §15.4)', () => {
  let service: DeliveryStatusService;
  let parcelStatus: {
    upsertStatus: jest.Mock;
    patchStatus: jest.Mock;
    listForStore: jest.Mock;
  };
  let orderModel: { find: jest.Mock; findOne: jest.Mock; updateOne: jest.Mock };

  beforeEach(() => {
    parcelStatus = {
      upsertStatus: jest.fn().mockResolvedValue({}),
      patchStatus: jest.fn().mockResolvedValue({}),
      listForStore: jest.fn().mockResolvedValue([]),
    };
    orderModel = {
      find: jest.fn().mockReturnValue(query([])),
      findOne: jest.fn().mockReturnValue(query(null)),
      updateOne: jest.fn().mockReturnValue(query({})),
    };

    const configService = {
      get: (key: string) =>
        ({
          'zrStatusSync.enabled': true,
          'zrStatusSync.intervalMinutes': 15,
          'zrStatusSync.maxCallsPerMinute': 20,
          'zrStatusSync.jitterRatio': 0.2,
          'zrStatusSync.terminalConfirmations': 3,
          'zrStatusSync.leaseSeconds': 120,
        })[key],
    };

    service = new DeliveryStatusService(
      configService as never,
      { getHandler: () => null } as never,
      parcelStatus as never,
      { resolveStoreIdByEmail: jest.fn() } as never,
      {
        find: jest.fn().mockReturnValue(
          query([
            {
              storeId: STORE_ID,
              vendorEmail: 'vendor@example.com',
              companies: { 'zr-express': { status: 'enabled' } },
            },
          ]),
        ),
      } as never,
      orderModel as never,
    );
  });

  it('creates the missing record for an open parcel (§15.4)', async () => {
    orderModel.find.mockReturnValue(
      query([
        {
          _id: ORDER_ID,
          orderNo: 'ORD-1',
          storeId: STORE_ID,
          deliveryParcelId: PARCEL_ID,
          deliveryCompanyId: 'zr-express',
          status: { slug: 'dispatched' },
        },
      ]),
    );

    const summary = await service.runSweep();

    expect(summary.backfilled).toBe(1);
    const [written] = parcelStatus.upsertStatus.mock.calls[0];
    expect(written).toMatchObject({ storeId: STORE_ID, parcelId: PARCEL_ID });
  });

  it('marks a record whose order no longer exists as superseded', async () => {
    parcelStatus.listForStore.mockResolvedValue([
      { parcelId: PARCEL_ID, orderId: ORDER_ID, syncState: DeliverySyncState.SYNCED },
    ]);
    orderModel.findOne.mockReturnValue(query(null));

    const summary = await service.runSweep();

    expect(summary.orphaned).toBe(1);
    const [scope, parcelId, patch] = parcelStatus.patchStatus.mock.calls[0];
    expect(scope).toBe(STORE_ID);
    expect(parcelId).toBe(PARCEL_ID);
    expect(patch.syncState).toBe(DeliverySyncState.SUPERSEDED);
  });

  it('retires the old parcel when the order was re-dispatched (§10.4)', async () => {
    parcelStatus.listForStore.mockResolvedValue([
      { parcelId: PARCEL_ID, orderId: ORDER_ID, syncState: DeliverySyncState.SYNCED },
    ]);
    orderModel.findOne.mockReturnValue(
      query({ _id: ORDER_ID, deliveryParcelId: 'parcel-2' }),
    );

    const summary = await service.runSweep();

    expect(summary.orphaned).toBe(1);
    const [, parcelId, patch] = parcelStatus.patchStatus.mock.calls[0];
    expect(parcelId).toBe(PARCEL_ID);
    expect(patch.syncState).toBe(DeliverySyncState.SUPERSEDED);
  });

  it('keeps the record of a parcel the order still carries', async () => {
    parcelStatus.listForStore.mockResolvedValue([
      { parcelId: PARCEL_ID, orderId: ORDER_ID, syncState: DeliverySyncState.SYNCED },
    ]);
    orderModel.findOne.mockReturnValue(
      query({ _id: ORDER_ID, deliveryParcelId: PARCEL_ID }),
    );

    const summary = await service.runSweep();

    expect(summary.orphaned).toBe(0);
    const superseded = parcelStatus.patchStatus.mock.calls.filter(
      (call) => (call[2] as Record<string, unknown>)?.syncState === DeliverySyncState.SUPERSEDED,
    );
    expect(superseded).toHaveLength(0);
  });

  it('re-queues a record whose backoff has expired', async () => {
    parcelStatus.listForStore.mockResolvedValue([
      {
        parcelId: PARCEL_ID,
        orderId: ORDER_ID,
        syncState: DeliverySyncState.ERROR,
        lastPolledAt: new Date(Date.now() - 60 * 60_000),
        nextEligiblePollAt: new Date(Date.now() - 1000),
      },
    ]);
    orderModel.findOne.mockReturnValue(query({ _id: ORDER_ID }));

    const summary = await service.runSweep();

    expect(summary.requeued).toBe(1);
    const [, , patch] = parcelStatus.patchStatus.mock.calls[0];
    expect(patch.syncState).toBe(DeliverySyncState.IDLE);
    expect(patch.nextEligiblePollAt).toBeNull();
  });

  it('never writes outside the store it swept', async () => {
    orderModel.find.mockReturnValue(
      query([
        {
          _id: ORDER_ID,
          orderNo: 'ORD-1',
          storeId: STORE_ID,
          deliveryParcelId: PARCEL_ID,
          deliveryCompanyId: 'zr-express',
          status: { slug: 'dispatched' },
        },
      ]),
    );

    await service.runSweep();

    for (const call of parcelStatus.upsertStatus.mock.calls) {
      expect(call[0].storeId).toBe(STORE_ID);
    }
  });
});

describe('DeliveryStatusLeaseService — the single-instance guard (§12.5)', () => {
  let service: DeliveryStatusLeaseService;
  let model: {
    findOneAndUpdate: jest.Mock;
    create: jest.Mock;
    updateOne: jest.Mock;
    findOne: jest.Mock;
  };

  beforeEach(() => {
    model = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ owner: 'someone' }),
      }),
      create: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
      findOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
    };
    service = new DeliveryStatusLeaseService(model as never);
  });

  it('takes over an expired lease', async () => {
    model.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ owner: 'me' }),
    });

    await expect(service.acquire(120)).resolves.toBe(true);
    expect(service.isHeld).toBe(true);
  });

  it('stands down when another instance holds a live lease', async () => {
    model.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
    model.create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));

    await expect(service.acquire(120)).resolves.toBe(false);
    expect(service.isHeld).toBe(false);
  });

  it('creates the lease when there is none', async () => {
    model.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });

    await expect(service.acquire(120)).resolves.toBe(true);
    expect(model.create).toHaveBeenCalledTimes(1);
  });

  it('releases the lease by expiring it, never by deleting it', async () => {
    model.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ owner: 'me' }),
    });
    await service.acquire(120);

    await service.release();

    expect(model.updateOne).toHaveBeenCalledTimes(1);
    expect(service.isHeld).toBe(false);
  });

  it('keeps one independent lease per provider', async () => {
    model.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ owner: 'me' }),
    });

    await service.acquire(120, 'delivery-status-sync:zr-express');
    await service.acquire(120, 'delivery-status-sync:ecom-delivery');

    expect(service.isHeldForKey('delivery-status-sync:zr-express')).toBe(true);
    expect(service.isHeldForKey('delivery-status-sync:ecom-delivery')).toBe(true);

    await service.release('delivery-status-sync:zr-express');

    expect(service.isHeldForKey('delivery-status-sync:zr-express')).toBe(false);
    expect(service.isHeldForKey('delivery-status-sync:ecom-delivery')).toBe(true);
    expect(service.isHeld).toBe(true);
  });
});

describe('DeliveryStatusScheduler — the interval provider (§12.1)', () => {
  it('does not schedule anything while the feature is off', async () => {
    const runCycle = jest.fn();
    const settings = { enabled: false, intervalMinutes: 15, jitterRatio: 0.2 };
    const service = {
      settings,
      enabledProviders: jest.fn().mockReturnValue([]),
      settingsFor: jest.fn().mockReturnValue(settings),
      runCycle,
    };
    const lease = { acquire: jest.fn(), release: jest.fn() };
    const scheduler = new DeliveryStatusScheduler(service as never, lease as never);

    scheduler.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    scheduler.onModuleDestroy();

    expect(lease.acquire).not.toHaveBeenCalled();
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('takes the lease, runs a cycle and releases the lease', async () => {
    const runCycle = jest.fn().mockResolvedValue({});
    const settings = { enabled: true, intervalMinutes: 15, jitterRatio: 0, leaseSeconds: 120 };
    const service = {
      settings,
      enabledProviders: jest
        .fn()
        .mockReturnValue([{ companyId: 'zr-express', displayName: 'ZR Express' }]),
      settingsFor: jest.fn().mockReturnValue(settings),
      runCycle,
    };
    const lease = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };
    const scheduler = new DeliveryStatusScheduler(service as never, lease as never);

    scheduler.onModuleInit();
    // The first tick is scheduled immediately.
    await new Promise((resolve) => setTimeout(resolve, 10));
    scheduler.onModuleDestroy();

    expect(lease.acquire).toHaveBeenCalledWith(120, 'delivery-status-sync:zr-express');
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledWith('delivery-status-sync:zr-express');
  });

  it('stands down when another instance holds the lease', async () => {
    const runCycle = jest.fn();
    const settings = { enabled: true, intervalMinutes: 15, jitterRatio: 0, leaseSeconds: 120 };
    const service = {
      settings,
      enabledProviders: jest
        .fn()
        .mockReturnValue([{ companyId: 'zr-express', displayName: 'ZR Express' }]),
      settingsFor: jest.fn().mockReturnValue(settings),
      runCycle,
    };
    const lease = { acquire: jest.fn().mockResolvedValue(false), release: jest.fn() };
    const scheduler = new DeliveryStatusScheduler(service as never, lease as never);

    scheduler.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    scheduler.onModuleDestroy();

    expect(runCycle).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('one provider failing never stops the other provider', async () => {
    const settings = { enabled: true, intervalMinutes: 15, jitterRatio: 0, leaseSeconds: 120 };
    const runCycle = jest.fn().mockImplementation(async ({ companyId }: { companyId: string }) => {
      if (companyId === 'zr-express') throw new Error('ZR is down');
      return {};
    });
    const service = {
      enabledProviders: jest.fn().mockReturnValue([
        { companyId: 'zr-express', displayName: 'ZR Express' },
        { companyId: 'ecom-delivery', displayName: 'Ecom Delivery' },
      ]),
      settingsFor: jest.fn().mockReturnValue(settings),
      runCycle,
    };
    const lease = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };
    const scheduler = new DeliveryStatusScheduler(service as never, lease as never);

    scheduler.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    scheduler.onModuleDestroy();

    expect(runCycle).toHaveBeenCalledWith({ companyId: 'zr-express' });
    expect(runCycle).toHaveBeenCalledWith({ companyId: 'ecom-delivery' });
    expect(lease.acquire).toHaveBeenCalledWith(120, 'delivery-status-sync:zr-express');
    expect(lease.acquire).toHaveBeenCalledWith(120, 'delivery-status-sync:ecom-delivery');
  });
});

describe('TokenBucket — the per-tenant call budget (§12.5)', () => {
  it('allows a burst, then refuses', () => {
    const bucket = new TokenBucket(3);

    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('refills over the window', () => {
    const bucket = new TokenBucket(1, 1000);
    const now = Date.now();

    expect(bucket.tryConsume(now)).toBe(true);
    expect(bucket.tryConsume(now)).toBe(false);
    expect(bucket.tryConsume(now + 1001)).toBe(true);
  });
});

describe('DeliveryStatusService settingsFor', () => {
  function serviceWith(values: Record<string, unknown>) {
    return new DeliveryStatusService(
      { get: (key: string) => values[key] } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('uses the DHD block and never inherits the shared enabled flag', () => {
    const service = serviceWith({
      'deliveryStatusSync.enabled': true,
      'dhdStatusSync.enabled': false,
      'dhdStatusSync.intervalMinutes': 7,
      'dhdStatusSync.maxCallsPerMinute': 35,
    });

    expect(service.settingsFor('dhd')).toMatchObject({
      enabled: false,
      intervalMinutes: 7,
      maxCallsPerMinute: 35,
    });
  });

  it('falls back to the shared block only for a value DHD does not define', () => {
    const service = serviceWith({
      'deliveryStatusSync.enabled': true,
      'deliveryStatusSync.intervalMinutes': 9,
      'deliveryStatusSync.jitterRatio': 0.4,
      'dhdStatusSync.enabled': false,
      'dhdStatusSync.intervalMinutes': null,
    });

    expect(service.settingsFor('dhd')).toMatchObject({
      enabled: false,
      intervalMinutes: 9,
      jitterRatio: 0.4,
    });
  });

  it('keeps the historical defaults when neither block defines a value', () => {
    const service = serviceWith({});

    expect(service.settingsFor('dhd')).toEqual({
      enabled: false,
      intervalMinutes: 15,
      maxCallsPerMinute: 20,
      jitterRatio: 0.2,
      terminalConfirmations: 3,
      leaseSeconds: 120,
      deliveredWatchDays: 14,
      deliveredPollMinutes: 60,
    });
  });
});
