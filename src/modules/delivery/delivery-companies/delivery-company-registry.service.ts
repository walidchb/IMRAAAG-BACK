import { Inject, Injectable } from '@nestjs/common';
import { DeliveryCompanyHandler } from './interfaces/delivery-company-handler.interface';

/** Injection token for the ordered list of carrier handlers, owned by `DeliveryModule`. */
export const DELIVERY_COMPANY_HANDLERS = Symbol('DELIVERY_COMPANY_HANDLERS');

@Injectable()
export class DeliveryCompanyRegistry {
  private readonly handlers = new Map<string, DeliveryCompanyHandler>();

  constructor(
    @Inject(DELIVERY_COMPANY_HANDLERS)
    handlers: DeliveryCompanyHandler[],
  ) {
    for (const handler of handlers) this.register(handler);
  }

  private register(handler: DeliveryCompanyHandler): void {
    this.handlers.set(handler.companyId, handler);
  }

  getHandler(companyId: string): DeliveryCompanyHandler | null {
    return this.handlers.get(companyId) ?? null;
  }

  getRegisteredCompanyIds(): string[] {
    return Array.from(this.handlers.keys());
  }

  /** Company slugs whose handler can produce labels. Drives the vendor UI capability list. */
  getLabelCapableCompanyIds(): string[] {
    return Array.from(this.handlers.values())
      .filter((handler) => typeof handler.createLabels === 'function')
      .map((handler) => handler.companyId)
      .sort();
  }
}
