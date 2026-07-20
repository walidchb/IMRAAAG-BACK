import { Controller, Get, Post, Patch, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBody } from '@nestjs/swagger';
import { TerritoriesService } from './territories.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Territories')
@Controller('territories')
export class TerritoriesController {
  constructor(private readonly territoriesService: TerritoriesService) {}

  @Public()
  @Get('wilayas')
  @ApiOperation({ summary: 'Get all wilayas (public)' })
  getWilayas() {
    return this.territoriesService.getWilayas();
  }

  @Public()
  @Get('communes')
  @ApiOperation({ summary: 'Get communes, optionally filtered by wilaya code (public)' })
  @ApiQuery({ name: 'wilayaCode', required: false })
  getCommunes(@Query('wilayaCode') wilayaCode?: string) {
    return this.territoriesService.getCommunes(wilayaCode);
  }

  @Patch('wilayas/uuid')
  @ApiOperation({ summary: 'Update delivery company UUID for a wilaya' })
  @ApiBody({ schema: { example: { code: '16', zrexpress_uuid: 'uuid-here', yalidine_uuid: 'uuid-here', ecomdelivery_uuid: 'uuid-here' } } })
  updateWilayaUuid(@Body() body: { code: string; zrexpress_uuid?: string; yalidine_uuid?: string; ecomdelivery_uuid?: string }) {
    return this.territoriesService.updateWilayaUuid(body.code, body.zrexpress_uuid, body.yalidine_uuid, body.ecomdelivery_uuid);
  }

  @Patch('communes/uuid')
  @ApiOperation({ summary: 'Update delivery company UUID for a commune' })
  @ApiBody({ schema: { example: { post_code: '16001', zrexpress_uuid: 'uuid-here', yalidine_uuid: 'uuid-here', ecomdelivery_uuid: 'uuid-here' } } })
  updateCommuneUuid(@Body() body: { post_code: string; zrexpress_uuid?: string; yalidine_uuid?: string; ecomdelivery_uuid?: string }) {
    return this.territoriesService.updateCommuneUuid(body.post_code, body.zrexpress_uuid, body.yalidine_uuid, body.ecomdelivery_uuid);
  }

  @Post('seed')
  @ApiOperation({ summary: 'Seed wilayas and communes from JSON files' })
  seed() {
    return this.territoriesService.seed();
  }

  @Post('migrate')
  @ApiOperation({ summary: 'Migrate communes from old wilayas to new wilayas (49-58)' })
  migrate() {
    return this.territoriesService.migrateNewWilayas();
  }
}
