import { Controller, Get, Post, Patch, Body, Query, Req, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { DeliveryService } from './delivery.service';
import { DeliveryCompaniesService } from './delivery-companies.service';
import { SaveDeliveryConfigDto, SaveAttributionsDto } from './dto/save-delivery-config.dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { StoresService } from '../stores/stores.service';

@ApiTags('Delivery')
@ApiBearerAuth()
@Controller('delivery')
export class DeliveryController {
  constructor(
    private readonly deliveryService: DeliveryService,
    private readonly deliveryCompaniesService: DeliveryCompaniesService,
    private readonly storesService: StoresService,
  ) {}

  /**
   * Delivery configs/fees are keyed on the store's `vendorEmail`. An employee's login email is
   * not that key, so resolve the store first and use its canonical email everywhere.
   */
  private async storeEmailFor(req: any): Promise<string> {
    const user = req.user as { id: string };
    const store = await this.storesService.findByMemberIdOrThrow(user.id);
    return store.vendorEmail;
  }

  @Public()
  @Get('companies')
  @ApiOperation({ summary: 'Get all delivery companies with metadata' })
  getCompanies() {
    return this.deliveryCompaniesService.getAll();
  }

  @Roles(Role.VENDOR)
  @RequirePermissions(StorePermission.DELIVERY_VIEW)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('configs')
  @ApiOperation({ summary: 'Get delivery configs for current vendor' })
  async getConfigs(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.deliveryService.getConfigs(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @RequirePermissions(StorePermission.DELIVERY_CONFIGURE)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Patch('configs')
  @ApiOperation({ summary: 'Save delivery config for a company' })
  async saveConfig(@Req() req: any, @Body() dto: SaveDeliveryConfigDto) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.deliveryService.saveConfig(vendorEmail, dto);
  }

  @Roles(Role.VENDOR)
  @RequirePermissions(StorePermission.DELIVERY_VIEW)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('attributions')
  @ApiOperation({ summary: 'Get wilaya-to-company attributions for current vendor' })
  async getAttributions(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    // A vendor with no attributions document has none — answer `{ attributions: {} }`, never an
    // empty 200 body (which the client's `res.json()` cannot parse).
    return this.deliveryService.getAttributions(vendorEmail).then((doc) => doc ?? { attributions: {} });
  }

  @Roles(Role.VENDOR)
  @RequirePermissions(StorePermission.DELIVERY_ATTRIBUTIONS_UPDATE)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Patch('attributions')
  @ApiOperation({ summary: 'Save wilaya-to-company attributions' })
  async saveAttributions(@Req() req: any, @Body() dto: SaveAttributionsDto) {
    const vendorEmail = await this.storeEmailFor(req);
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
  @RequirePermissions(StorePermission.DELIVERY_SYNC)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('noest-desks/sync')
  @ApiOperation({ summary: 'Sync Noest stop desks from API' })
  async syncNoestDesks(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
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
  @RequirePermissions(StorePermission.DELIVERY_SYNC)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('ecom-desks/sync')
  @ApiOperation({ summary: 'Sync Ecom Delivery stop desks from API' })
  async syncEcomDesks(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.deliveryService.syncEcomDesks(vendorEmail);
  }

  @Public()
  @Get('dhd-desks')
  @ApiOperation({ summary: 'Get DHD stop desks (pickup points)' })
  @ApiQuery({ name: 'wilayaCode', required: false })
  getDhdDesks(@Query('wilayaCode') wilayaCode?: string) {
    return this.deliveryService.getDhdDesks(wilayaCode);
  }

  @Roles(Role.VENDOR)
  @RequirePermissions(StorePermission.DELIVERY_VIEW)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('dhd-communes')
  @ApiOperation({ summary: 'Get DHD communes for a wilaya' })
  @ApiQuery({ name: 'wilayaCode', required: true, description: 'Wilaya numeric code (1-58)' })
  async getDhdCommunes(@Req() req: any, @Query('wilayaCode') wilayaCode: string) {
    const communes = await this.deliveryService.getDhdCommunes(await this.storeEmailFor(req), wilayaCode);
    return { wilayaCode, communes };
  }

  @Roles(Role.VENDOR)
  @RequirePermissions(StorePermission.DELIVERY_VIEW)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('noest-communes')
  @ApiOperation({ summary: 'Get Noest communes for a wilaya' })
  @ApiQuery({ name: 'wilayaCode', required: true, description: 'Wilaya numeric code (1-58)' })
  async getNoestCommunes(@Req() req: any, @Query('wilayaCode') wilayaCode: string) {
    const communes = await this.deliveryService.getNoestCommunes(await this.storeEmailFor(req), wilayaCode);
    return { wilayaCode, communes };
  }

  @Public()
  @Get('zr-hubs')
  @ApiOperation({ summary: 'Get ZR Express hubs (pickup points)' })
  @ApiQuery({ name: 'wilayaCode', required: false })
  getZRHubs(@Query('wilayaCode') wilayaCode?: string) {
    return this.deliveryService.getZRHubs(wilayaCode);
  }

  @Roles(Role.VENDOR)
  @RequirePermissions(StorePermission.DELIVERY_SYNC)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('zr-hubs/sync')
  @ApiOperation({ summary: 'Sync ZR Express hubs from API' })
  async syncZRHubs(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.deliveryService.syncZRHubs(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @RequirePermissions(StorePermission.DELIVERY_SYNC)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('zr-territories/sync')
  @ApiOperation({ summary: 'Sync ZR Express territories and update Wilaya/Commune UUIDs' })
  async syncZRTerritories(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.deliveryService.syncZRTerritories(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @RequirePermissions(StorePermission.DELIVERY_VIEW)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('zr-territories')
  @ApiOperation({ summary: 'Fetch ZR Express territories' })
  async getZRTerritories(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.deliveryService.getTerritories(vendorEmail);
  }

  // The legacy `public/attributions/:vendorEmail` and `public/configs/:vendorEmail` routes are
  // gone: a vendor email is enumerable from the public catalogue, and the store-keyed routes
  // below cover every caller (they are 1:1 with the email). Public config reads are sanitised
  // by the service and never include carrier credentials.

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('public/attributions/store/:storeId')
  @ApiOperation({ summary: 'Get wilaya-to-company attributions for a store (public)' })
  @ApiParam({ name: 'storeId', description: 'Stable store identifier.' })
  getPublicAttributionsByStore(@Param('storeId') storeId: string) {
    return this.deliveryService.getAttributionsByStoreId(storeId).then((doc) => doc ?? { attributions: {} });
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('public/configs/store/:storeId')
  @ApiOperation({ summary: 'Get delivery configs for a store (public)' })
  @ApiParam({ name: 'storeId', description: 'Stable store identifier.' })
  getPublicConfigsByStore(@Param('storeId') storeId: string) {
    return this.deliveryService.getConfigsByStoreId(storeId);
  }
}
