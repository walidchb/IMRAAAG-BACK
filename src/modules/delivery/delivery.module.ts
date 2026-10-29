import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DeliveryConfig, DeliveryConfigSchema } from './schemas/delivery-config.schema';
import { DeliveryAttribution, DeliveryAttributionSchema } from './schemas/delivery-attribution.schema';
import { DeliveryCompany, DeliveryCompanySchema } from './schemas/delivery-company.schema';
import { NoestDesk, NoestDeskSchema } from './schemas/noest-desk.schema';
import { EcomDesk, EcomDeskSchema } from './schemas/ecom-desk.schema';
import { ZrHub, ZrHubSchema } from './schemas/zr-hub.schema';
import { DhdDesk, DhdDeskSchema } from './schemas/dhd-desk.schema';
import {
  DeliveryParcelStatus,
  DeliveryParcelStatusSchema,
} from './schemas/delivery-parcel-status.schema';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DeliveryCompaniesService } from './delivery-companies.service';
import { DeliveryParcelStatusService } from './delivery-parcel-status.service';
import { DeliveryFeesModule } from '../delivery-fees/delivery-fees.module';
import { TerritoriesModule } from '../territories/territories.module';
import { StoresModule } from '../stores/stores.module';
import {
  DELIVERY_COMPANY_HANDLERS,
  DeliveryCompanyRegistry,
} from './delivery-companies/delivery-company-registry.service';
import { DeliveryCompanyHandler } from './delivery-companies/interfaces/delivery-company-handler.interface';
import { NoestHandler } from './delivery-companies/handlers/noest.handler';
import { EcomHandler } from './delivery-companies/handlers/ecom.handler';
import { ZrExpressHandler } from './delivery-companies/handlers/zr-express.handler';
import { DhdHandler } from './delivery-companies/handlers/dhd.handler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DeliveryConfig.name, schema: DeliveryConfigSchema },
      { name: DeliveryAttribution.name, schema: DeliveryAttributionSchema },
      { name: DeliveryCompany.name, schema: DeliveryCompanySchema },
      { name: NoestDesk.name, schema: NoestDeskSchema },
      { name: EcomDesk.name, schema: EcomDeskSchema },
      { name: ZrHub.name, schema: ZrHubSchema },
      { name: DhdDesk.name, schema: DhdDeskSchema },
      { name: DeliveryParcelStatus.name, schema: DeliveryParcelStatusSchema },
    ]),
    DeliveryFeesModule,
    TerritoriesModule,
    StoresModule,
  ],
  controllers: [DeliveryController],
  providers: [
    DeliveryService,
    DeliveryCompaniesService,
    DeliveryParcelStatusService,
    NoestHandler,
    EcomHandler,
    ZrExpressHandler,
    DhdHandler,
    {
      provide: DELIVERY_COMPANY_HANDLERS,
      useFactory: (...handlers: DeliveryCompanyHandler[]) => handlers,
      inject: [NoestHandler, EcomHandler, ZrExpressHandler, DhdHandler],
    },
    DeliveryCompanyRegistry,
  ],
  exports: [
    DeliveryService,
    DeliveryCompaniesService,
    DeliveryCompanyRegistry,
    DeliveryParcelStatusService,
    MongooseModule,
  ],
})
export class DeliveryModule {}
