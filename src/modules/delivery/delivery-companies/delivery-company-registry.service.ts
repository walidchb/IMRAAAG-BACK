import { Injectable } from '@nestjs/common';
import { DeliveryCompanyHandler } from './interfaces/delivery-company-handler.interface';
import { NoestHandler } from './handlers/noest.handler';
import { EcomHandler } from './handlers/ecom.handler';
import { ZrExpressHandler } from './handlers/zr-express.handler';
import { DhdHandler } from './handlers/dhd.handler';

@Injectable()
export class DeliveryCompanyRegistry {
  private readonly handlers = new Map<string, DeliveryCompanyHandler>();

  constructor(
    noestHandler: NoestHandler,
    ecomHandler: EcomHandler,
    zrExpressHandler: ZrExpressHandler,
    dhdHandler: DhdHandler,
  ) {
    this.register(noestHandler);
    this.register(ecomHandler);
    this.register(zrExpressHandler);
    this.register(dhdHandler);
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
}
