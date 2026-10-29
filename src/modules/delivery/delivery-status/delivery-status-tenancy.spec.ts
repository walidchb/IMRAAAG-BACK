import { DeliveryStatusService } from './delivery-status.service';
import { DeliveryStatusLeaseService } from './delivery-status-lease.service';
import { DELIVERY_STATUS_LEASE_KEY } from '../../../common/constants/delivery-status.const';
import { registerCarrierProfile } from './carrier/carrier-profiles';
import type { CarrierStatusProfile } from './carrier/carrier-profile';

const STORE_A = '6ac400e26b1b2c3d4e5f6a71';
const STORE_B = '6ac400e26b1b2c3d4e5f6a72';
const ORDER_A = '6ac400e26b1b2c3d4e5f6a73';
const PARCEL_A = 'parcel-a';

/** A second provider proves the engine is no longer hard-wired to ZR Express (Phase E1). */
const ECOM_PROFILE: CarrierStatusProfile = {
  companyId: 'ecom-delivery',
  displayName: 'Ecom Delivery',
  historyUser: 'Ecom Delivery',
  systemActor: 'ecom-delivery-sync',
  normalizeState: () => 'processing',
  isTerminalState: () => false,
  detectSignal: () => ({ signal: 'none', source: 'none', at: null }),
  flagsForSituations: () => [],
};
registerCarrierProfile(ECOM_PROFILE);

/**
 * Tenancy of the status poller (roadmap §18.3).
 *
 * The poller is the one part of the platform that talks to a carrier **on its own**, with no
 * client in the loop. There is therefore no request to scope — the scope is the poller's own
 * discipline: every order, every parcel record and every write belongs to exactly one store,
 * and the store is always the one the configuration pointed at.
 */
describe('DeliveryStatus — tenancy (Phase 3, §18.3)', () => {
  function query<T>(result: T) {
    const q: Record<string, unknown> = {};
    q.exec = jest.fn().mockResolvedValue(result);
    q.select = jest.fn().mockReturnValue(q);
    q.lean = jest.fn().mockReturnValue(q);
    return q;
  }

  const build = (overrides: {
    configs?: Record<string, unknown>[];
    records?: Record<string, unknown>[];
    orders?: Record<string, unknown>[];
  } = {}) => {
    const parcelStatus = {
      upsertStatus: jest.fn().mockResolvedValue({}),
      patchStatus: jest.fn().mockResolvedValue({}),
      appendTimelineEntry: jest.fn().mockResolvedValue(true),
      compactTimeline: jest.fn().mockResolvedValue(false),
      listForStore: jest.fn().mockResolvedValue(overrides.records ?? []),
      findOne: jest.fn().mockResolvedValue(null),
    };

    const orderModel = {
      find: jest.fn().mockReturnValue(
        query(
          overrides.orders ?? [
            {
              _id: ORDER_A,
              orderNo: 'ORD-A',
              storeId: STORE_A,
              deliveryParcelId: PARCEL_A,
              deliveryCompanyId: 'zr-express',
              status: { slug: 'dispatched' },
            },
          ],
        ),
      ),
      findOne: jest.fn().mockReturnValue(query({ _id: ORDER_A })),
      updateOne: jest.fn().mockReturnValue(query({ modifiedCount: 1 })),
      // The poller commits one parcel's record and its order advance in one transaction.
      startSession: jest.fn().mockImplementation(async () => {
        const session: Record<string, unknown> = {};
        session.startTransaction = jest.fn().mockResolvedValue(undefined);
        session.abortTransaction = jest.fn().mockResolvedValue(undefined);
        session.endSession = jest.fn().mockResolvedValue(undefined);
        session.withTransaction = jest.fn(async (work: (given: unknown) => Promise<unknown>) => work(session));
        return session;
      }),
    };

    const configModel = {
      find: jest.fn().mockReturnValue(
        query(
          overrides.configs ?? [
            {
              storeId: STORE_A,
              vendorEmail: 'a@example.com',
              companies: { 'zr-express': { status: 'enabled' } },
            },
          ],
        ),
      ),
    };

    const handler = {
      searchStatusParcels: jest.fn().mockResolvedValue({
        parcels: [
          {
            parcelId: PARCEL_A,
            externalId: 'ORD-A',
            trackingNumber: 'T-A',
            deliveryStatus: 'in_transit',
            carrierStateId: 's1',
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
          },
        ],
        totalCount: 1,
        hasNext: false,
      }),
      fetchStatusHistory: jest.fn().mockResolvedValue([
        {
          providerEntryId: 'e1',
          parcelId: PARCEL_A,
          fromState: 'pret_a_expedier',
          toState: 'en_transit',
          fromStatus: 'ready_for_pickup',
          toStatus: 'in_transit',
          at: new Date('2026-10-21T10:00:00.000Z'),
          comment: null,
          hubName: 'Hub',
          hubCity: 'Alger',
          hubDistrict: null,
          modifiedBy: null,
          situationFlags: [],
          situations: [],
          raw: {},
        },
      ]),
      resolveStatusTenant: jest.fn().mockResolvedValue('tenant-a'),
    };

    const service = new DeliveryStatusService(
      {
        get: (key: string) =>
          ({
            'zrStatusSync.enabled': true,
            'zrStatusSync.intervalMinutes': 15,
            'zrStatusSync.maxCallsPerMinute': 20,
            'zrStatusSync.jitterRatio': 0.2,
            'zrStatusSync.terminalConfirmations': 3,
            'zrStatusSync.leaseSeconds': 120,
          })[key],
      } as never,
      { getHandler: () => handler } as never,
      parcelStatus as never,
      { resolveStoreIdByEmail: jest.fn().mockResolvedValue(null) } as never,
      configModel as never,
      orderModel as never,
    );

    return { service, parcelStatus, orderModel, configModel, handler };
  };

  it('asks for the store’s own orders — the query carries the store id', async () => {
    const { service, orderModel } = build();

    await service.runCycle();

    const [filter] = orderModel.find.mock.calls[0];
    expect(String(filter.storeId)).toBe(STORE_A);
  });

  it('never writes a parcel record outside the store it polled', async () => {
    const { service, parcelStatus } = build();

    await service.runCycle();

    expect(parcelStatus.upsertStatus).toHaveBeenCalledTimes(1);
    const [written] = parcelStatus.upsertStatus.mock.calls[0];
    expect(written.storeId).toBe(STORE_A);
    expect(written.storeId).not.toBe(STORE_B);
  });

  it('never appends a timeline entry outside the store it polled', async () => {
    const { service, parcelStatus } = build();

    await service.runCycle();

    for (const [scope] of parcelStatus.appendTimelineEntry.mock.calls) {
      expect(scope).toBe(STORE_A);
      expect(scope).not.toBe(STORE_B);
    }
  });

  it('reads the parcel records of that store only', async () => {
    const { service, parcelStatus } = build();

    await service.runCycle();

    for (const [scope] of parcelStatus.listForStore.mock.calls) {
      expect(scope).toBe(STORE_A);
    }
  });

  it('writes the order chip with a store-scoped filter', async () => {
    const { service, orderModel } = build();

    await service.runCycle();

    const [filter] = orderModel.updateOne.mock.calls[0];
    expect(String(filter.storeId)).toBe(STORE_A);
    expect(String(filter._id)).toBe(ORDER_A);
  });

  it('polls only the stores whose configuration names ZR Express', async () => {
    const { service, handler } = build({
      configs: [
        {
          storeId: STORE_A,
          vendorEmail: 'a@example.com',
          companies: { 'zr-express': { status: 'enabled' } },
        },
        {
          storeId: STORE_B,
          vendorEmail: 'b@example.com',
          companies: { noest: { status: 'enabled' } },
        },
      ],
    });

    const summary = await service.runCycle();

    expect(summary.stores).toBe(1);
    expect(handler.resolveStatusTenant).toHaveBeenCalledWith({ storeId: STORE_A });
  });

  it('never polls a store that has no ZR Express configuration at all', async () => {
    const { service, handler } = build({ configs: [] });

    const summary = await service.runCycle();

    expect(summary.stores).toBe(0);
    expect(handler.searchStatusParcels).not.toHaveBeenCalled();
  });

  it('polls only the stores configured for the requested provider', async () => {
    const { service, configModel, orderModel } = build({
      configs: [
        {
          storeId: STORE_A,
          vendorEmail: 'a@example.com',
          companies: { 'ecom-delivery': { status: 'enabled' } },
        },
        {
          storeId: STORE_B,
          vendorEmail: 'b@example.com',
          companies: { 'zr-express': { status: 'enabled' } },
        },
      ],
    });

    await service.runCycle({ companyId: 'ecom-delivery' });

    const [configFilter] = configModel.find.mock.calls[0];
    expect(configFilter['companies.ecom-delivery']).toEqual({ $exists: true });

    const [orderFilter] = orderModel.find.mock.calls[0];
    expect(orderFilter.deliveryCompanyId).toBe('ecom-delivery');
  });

  it('never mixes one provider’s records into another provider’s cycle', async () => {
    const { service, handler } = build({
      records: [
        {
          parcelId: PARCEL_A,
          companyId: 'ecom-delivery',
          deliveryStatus: 'in_transit',
          lastCarrierStateAt: new Date(),
          terminal: false,
          nextEligiblePollAt: null,
        },
      ],
    });

    await service.runCycle({ companyId: 'zr-express' });

    // The ZR cycle ignored the Ecom record, so it had to ask the carrier for the history.
    expect(handler.fetchStatusHistory).toHaveBeenCalled();
  });

  it('keeps the lease global — one poller for the whole platform', async () => {
    const model = {
      findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      create: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
      findOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
    };
    const lease = new DeliveryStatusLeaseService(model as never);

    await lease.acquire(120);

    const [document] = model.create.mock.calls[0];
    expect(document.key).toBe(DELIVERY_STATUS_LEASE_KEY);
    // The lease is not scoped by a store — the poller is platform-wide.
    expect(document.storeId).toBeUndefined();
  });
});
