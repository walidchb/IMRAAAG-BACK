import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DeliveryConfig, DeliveryConfigSchema } from './schemas/delivery-config.schema';
import { DeliveryAttribution, DeliveryAttributionSchema } from './schemas/delivery-attribution.schema';
import { DeliveryCompany, DeliveryCompanySchema } from './schemas/delivery-company.schema';
import { NoestDesk, NoestDeskSchema } from './schemas/noest-desk.schema';
import { EcomDesk, EcomDeskSchema } from './schemas/ecom-desk.schema';
import { ZrHub, ZrHubSchema } from './schemas/zr-hub.schema';
import { DhdDesk, DhdDeskSchema } from './schemas/dhd-desk.schema';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DeliveryCompaniesService } from './delivery-companies.service';
import { DeliveryFeesModule } from '../delivery-fees/delivery-fees.module';
import { TerritoriesModule } from '../territories/territories.module';
import { DeliveryCompanyRegistry } from './delivery-companies/delivery-company-registry.service';
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
    ]),
    DeliveryFeesModule,
    TerritoriesModule,
  ],
  controllers: [DeliveryController],
  providers: [
    DeliveryService,
    DeliveryCompaniesService,
    DeliveryCompanyRegistry,
    NoestHandler,
    EcomHandler,
    ZrExpressHandler,
    DhdHandler,
  ],
  exports: [DeliveryService, DeliveryCompaniesService, MongooseModule],
})
export class DeliveryModule {}
