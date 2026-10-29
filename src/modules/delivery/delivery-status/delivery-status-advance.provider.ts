import { Injectable, Logger } from '@nestjs/common';
import { ClientSession } from 'mongoose';
import { OrdersService } from '../../orders/orders.service';
import type {
  DeliveryStatusAdvance,
  DeliveryStatusAdvanceRequest,
  DeliveryStatusAdvanceResult,
} from './delivery-status-advance.interface';
import { DEFAULT_CARRIER_COMPANY_ID, getCarrierProfile } from './carrier/carrier-profiles';

/** The fallback attribution, used by a request written before `companyId` existed. */
const DEFAULT_HISTORY_USER = 'ZR Express';
const DEFAULT_ADVANCE_SYSTEM = 'zr-express-sync';

/**
 * The advance provider: the carrier's signal, applied to the order (roadmap Phase 4).
 *
 * This is the only place where the sync touches an order, and it does so through
 * `OrdersService.applyCarrierOrderAction` — the platform's own conditional-claim discipline,
 * not a direct write to `Order.status`. The sync module therefore never reaches into the
 * order model, and the order module keeps ownership of its own state machine.
 *
 * The provider is deliberately thin: it translates the seam's vocabulary into the orders
 * module's, and reports the outcome back. Every rule (the conditional claim, the transition
 * map, the tenancy, the conflict codes) lives in `OrdersService`, where it can be tested
 * without a carrier, a poller or a database.
 */
@Injectable()
export class OrdersCarrierStatusAdvance implements DeliveryStatusAdvance {
  private readonly logger = new Logger(OrdersCarrierStatusAdvance.name);

  constructor(private readonly ordersService: OrdersService) {}

  async advance(
    request: DeliveryStatusAdvanceRequest,
    session?: ClientSession,
  ): Promise<DeliveryStatusAdvanceResult> {
    const profile = getCarrierProfile(request.companyId ?? DEFAULT_CARRIER_COMPANY_ID);
    const result = await this.ordersService.applyCarrierOrderAction(
      request.orderId,
      { target: request.target, steps: request.steps },
      request.fromStatus,
      {
        system: profile?.systemActor ?? DEFAULT_ADVANCE_SYSTEM,
        user: profile?.historyUser ?? DEFAULT_HISTORY_USER,
      },
      { storeId: request.storeId, session },
    );

    if (result.applied) {
      this.logger.log(
        `Advanced order ${request.orderNo} (${request.storeId}) from ${request.fromStatus} to ${request.toStatus}.`,
      );
      return {
        outcome: 'advanced',
        fromStatus: result.fromStatus,
        toStatus: result.toStatus,
      };
    }

    if (result.conflict) {
      // §10.4 — a conflict is a disagreement between the carrier and the vendor, not a
      // failure. It is reported so the poller can record it; the order keeps its own status.
      this.logger.warn(
        `The advance of order ${request.orderNo} (${request.storeId}) conflicted: ${result.reason ?? 'unknown'}.`,
      );
      return {
        outcome: 'conflict',
        reason: result.reason,
        fromStatus: result.fromStatus,
        toStatus: result.toStatus,
      };
    }

    return {
      outcome: 'skipped',
      reason: result.reason,
      fromStatus: result.fromStatus,
      toStatus: result.toStatus,
    };
  }
}
