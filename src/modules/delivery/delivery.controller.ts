import { Controller, Get, Post, Patch, Body, Query, Req, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { DeliveryService } from './delivery.service';
import { DeliveryCompaniesService } from './delivery-companies.service';
import { SaveDeliveryConfigDto, SaveAttributionsDto } from './dto/save-delivery-config.dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';

@ApiTags('Delivery')
@ApiBearerAuth()
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

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('configs')
  @ApiOperation({ summary: 'Get delivery configs for current vendor' })
  getConfigs(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.deliveryService.getConfigs(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Patch('configs')
  @ApiOperation({ summary: 'Save delivery config for a company' })
  saveConfig(@Req() req: any, @Body() dto: SaveDeliveryConfigDto) {
    const vendorEmail = req.user.email;
    return this.deliveryService.saveConfig(vendorEmail, dto);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('attributions')
  @ApiOperation({ summary: 'Get wilaya-to-company attributions for current vendor' })
  getAttributions(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.deliveryService.getAttributions(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Patch('attributions')
  @ApiOperation({ summary: 'Save wilaya-to-company attributions' })
  saveAttributions(@Req() req: any, @Body() dto: SaveAttributionsDto) {
    const vendorEmail = req.user.email;
    return this.deliveryService.saveAttributions(vendorEmail, dto);
  }

  @Public()
  @Get('noest-desks')
  @ApiOperation({ summary: 'Get Noest stop desks (pickup points)' })
  @ApiQuery({ name: 'wilayaCode', required: false })
  getNoestDesks(@Query('wilayaCode') wilayaCode?: string) {
    return this.deliveryService.getNoestDesks(wilayaCode);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('noest-desks/sync')
  @ApiOperation({ summary: 'Sync Noest stop desks from API' })
  syncNoestDesks(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.deliveryService.syncNoestDesks(vendorEmail);
  }

  @Public()
  @Get('ecom-desks')
  @ApiOperation({ summary: 'Get Ecom Delivery stop desks (relay points)' })
  @ApiQuery({ name: 'wilayaCode', required: false })
  getEcomDesks(@Query('wilayaCode') wilayaCode?: string) {
    return this.deliveryService.getEcomDesks(wilayaCode);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('ecom-desks/sync')
  @ApiOperation({ summary: 'Sync Ecom Delivery stop desks from API' })
  syncEcomDesks(@Req() req: any) {
    const vendorEmail = req.user.email;
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

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('zr-hubs/sync')
  @ApiOperation({ summary: 'Sync ZR Express hubs from API' })
  syncZRHubs(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.deliveryService.syncZRHubs(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('zr-territories/sync')
  @ApiOperation({ summary: 'Sync ZR Express territories and update Wilaya/Commune UUIDs' })
  syncZRTerritories(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.deliveryService.syncZRTerritories(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('zr-territories')
  @ApiOperation({ summary: 'Fetch ZR Express territories' })
  getZRTerritories(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.deliveryService.getTerritories(vendorEmail);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('public/attributions/:vendorEmail')
  @ApiOperation({ summary: 'Get wilaya-to-company attributions for a vendor (public)' })
  getPublicAttributions(@Param('vendorEmail') vendorEmail: string) {
    return this.deliveryService.getAttributions(vendorEmail);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('public/configs/:vendorEmail')
  @ApiOperation({ summary: 'Get delivery configs for a vendor (public)' })
  getPublicConfigs(@Param('vendorEmail') vendorEmail: string) {
    return this.deliveryService.getConfigs(vendorEmail);
  }
}
