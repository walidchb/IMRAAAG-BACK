import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Wilaya, WilayaSchema } from './schemas/wilaya.schema';
import { Commune, CommuneSchema } from './schemas/commune.schema';
import { TerritoriesController } from './territories.controller';
import { TerritoriesService } from './territories.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Wilaya.name, schema: WilayaSchema },
      { name: Commune.name, schema: CommuneSchema },
    ])
  ],
  controllers: [TerritoriesController],
  providers: [TerritoriesService],
  exports: [MongooseModule, TerritoriesService]
})
export class TerritoriesModule {}
