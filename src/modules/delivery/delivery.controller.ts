import { Controller, Get, Post, Patch, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { DeliveryService } from './delivery.service';
import { DeliveryCompaniesService } from './delivery-companies.service';
import { SaveDeliveryConfigDto, SaveAttributionsDto } from './dto/save-delivery-config.dto';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Delivery')
@Controller('delivery')
export class DeliveryController {
  constructor(
    private readonly deliveryService: DeliveryService,
    private readonly deliveryCompaniesService: DeliveryCompaniesService,
  ) {}

  @Public()
  @Get('companies')
  @ApiOperation({ summary: 'Get all delivery companies with metadata' })
  getCompanies() {
    return this.deliveryCompaniesService.getAll();
  }

  @Get('configs')
  @ApiOperation({ summary: 'Get delivery configs for a vendor' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  getConfigs(@Query('vendorEmail') vendorEmail: string) {
    return this.deliveryService.getConfigs(vendorEmail);
  }

  @Patch('configs')
  @ApiOperation({ summary: 'Save delivery config for a company' })
  saveConfig(@Query('vendorEmail') vendorEmail: string, @Body() dto: SaveDeliveryConfigDto) {
    return this.deliveryService.saveConfig(vendorEmail, dto);
  }

  @Get('attributions')
  @ApiOperation({ summary: 'Get wilaya-to-company attributions' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  getAttributions(@Query('vendorEmail') vendorEmail: string) {
    return this.deliveryService.getAttributions(vendorEmail);
  }

  @Patch('attributions')
  @ApiOperation({ summary: 'Save wilaya-to-company attributions' })
  saveAttributions(@Query('vendorEmail') vendorEmail: string, @Body() dto: SaveAttributionsDto) {
    return this.deliveryService.saveAttributions(vendorEmail, dto);
  }

  @Public()
  @Get('noest-desks')
  @ApiOperation({ summary: 'Get Noest stop desks (pickup points)' })
  @ApiQuery({ name: 'wilayaCode', required: false })
  getNoestDesks(@Query('wilayaCode') wilayaCode?: string) {
    return this.deliveryService.getNoestDesks(wilayaCode);
  }

  @Post('noest-desks/sync')
  @ApiOperation({ summary: 'Sync Noest stop desks from API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  syncNoestDesks(@Query('vendorEmail') vendorEmail: string) {
    return this.deliveryService.syncNoestDesks(vendorEmail);
  }

  @Public()
  @Get('ecom-desks')
  @ApiOperation({ summary: 'Get Ecom Delivery stop desks (relay points)' })
  @ApiQuery({ name: 'wilayaCode', required: false })
  getEcomDesks(@Query('wilayaCode') wilayaCode?: string) {
    return this.deliveryService.getEcomDesks(wilayaCode);
  }

  @Post('ecom-desks/sync')
  @ApiOperation({ summary: 'Sync Ecom Delivery stop desks from API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  syncEcomDesks(@Query('vendorEmail') vendorEmail: string) {
    return this.deliveryService.syncEcomDesks(vendorEmail);
  }

  @Public()
  @Get('dhd-desks')
  @ApiOperation({ summary: 'Get DHD stop desks (pickup points)' })
  @ApiQuery({ name: 'wilayaCode', required: false })
  getDhdDesks(@Query('wilayaCode') wilayaCode?: string) {
    return this.deliveryService.getDhdDesks(wilayaCode);
  }

  @Public()
  @Get('zr-hubs')
  @ApiOperation({ summary: 'Get ZR Express hubs (pickup points)' })
  @ApiQuery({ name: 'wilayaCode', required: false })
  getZRHubs(@Query('wilayaCode') wilayaCode?: string) {
    return this.deliveryService.getZRHubs(wilayaCode);
  }

  @Post('zr-hubs/sync')
  @ApiOperation({ summary: 'Sync ZR Express hubs from API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  syncZRHubs(@Query('vendorEmail') vendorEmail: string) {
    return this.deliveryService.syncZRHubs(vendorEmail);
  }

  @Post('zr-territories/sync')
  @ApiOperation({ summary: 'Sync ZR Express territories and update Wilaya/Commune UUIDs' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  syncZRTerritories(@Query('vendorEmail') vendorEmail: string) {
    return this.deliveryService.syncZRTerritories(vendorEmail);
  }

  @Get('zr-territories')
  @ApiOperation({ summary: 'Fetch ZR Express territories' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  getZRTerritories(@Query('vendorEmail') vendorEmail: string) {
    return this.deliveryService.getTerritories(vendorEmail);
  }
}
