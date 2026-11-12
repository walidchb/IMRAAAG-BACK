import { Controller, Get, Patch, Post, Param, Body, Query, Req, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { DeliveryFeesService } from './delivery-fees.service';
import { UpdateDeliveryFeeDto, BulkUpdateDeliveryFeeDto } from './dto/manage-delivery-fees.dto';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { StoresService } from '../stores/stores.service';

@ApiTags('Delivery Fees')
@ApiBearerAuth()
@Controller('delivery-fees')
export class DeliveryFeesController {
  constructor(
    private readonly feesService: DeliveryFeesService,
    private readonly storesService: StoresService,
  ) {}

  /** Fees are keyed on the store's `vendorEmail`; resolve the session store first. */
  private async storeEmailFor(req: any): Promise<string> {
    const user = req.user as { id: string };
    const store = await this.storesService.findByMemberIdOrThrow(user.id);
    return store.vendorEmail;
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_VIEW)
  @Get()
  @ApiOperation({ summary: 'Get all delivery fees for current vendor' })
  async getFees(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.getFees(vendorEmail);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('by-wilaya')
  @ApiOperation({ summary: 'Get delivery fee for a specific wilaya (public)' })
  @ApiQuery({ name: 'storeId', required: false, description: 'Preferred. Stable store identifier.' })
  @ApiQuery({ name: 'vendorEmail', required: false, deprecated: true, description: 'Legacy. Use storeId.' })
  @ApiQuery({ name: 'wilayaCode', required: true })
  async getFee(
    @Query('storeId') storeId: string | undefined,
    @Query('vendorEmail') vendorEmail: string | undefined,
    @Query('wilayaCode') wilayaCode: string,
  ) {
    if (storeId) return this.feesService.getFeeByStoreId(storeId, wilayaCode);
    if (vendorEmail) return this.feesService.getFee(vendorEmail, wilayaCode);
    throw new AppException(AppErrorCode.VALIDATION_REQUIRED, { field: 'storeId' });
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Patch(':wilayaCode')
  @ApiOperation({ summary: 'Update delivery fee for a wilaya' })
  async updateFee(
    @Req() req: any,
    @Param('wilayaCode') wilayaCode: string,
    @Body() dto: UpdateDeliveryFeeDto,
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.updateFee(vendorEmail, wilayaCode, dto);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('bulk')
  @ApiOperation({ summary: 'Bulk update delivery fees' })
  async bulkUpdate(
    @Req() req: any,
    @Body() dto: BulkUpdateDeliveryFeeDto,
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.bulkUpdate(vendorEmail, dto);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('seed')
  @ApiOperation({ summary: 'Seed default fees (0 DA) for missing wilayas' })
  async seed(
    @Req() req: any,
    @Body() body: { wilayaCodes: string[] },
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.seedDefaults(vendorEmail, body.wilayaCodes);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-noest')
  @ApiOperation({ summary: 'Fetch delivery fees from Noest Express API' })
  async fetchFromNoest(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.fetchNoestFees(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-noest/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from Noest Express API' })
  async fetchFromNoestForWilaya(
    @Req() req: any,
    @Param('wilayaCode') wilayaCode: string,
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.fetchNoestFeeForWilaya(vendorEmail, wilayaCode);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-ecom')
  @ApiOperation({ summary: 'Fetch delivery fees from Ecom Delivery API' })
  async fetchFromEcom(
    @Req() req: any,
    @Body() body: { apiKey: string; apiToken: string },
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.fetchEcomFees(vendorEmail, body.apiKey, body.apiToken);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-ecom/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from Ecom Delivery API' })
  async fetchFromEcomForWilaya(
    @Req() req: any,
    @Param('wilayaCode') wilayaCode: string,
    @Body() body: { apiKey: string; apiToken: string },
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.fetchEcomFeeForWilaya(vendorEmail, wilayaCode, body.apiKey, body.apiToken);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-zr-express')
  @ApiOperation({ summary: 'Fetch delivery fees from ZR Express API' })
  async fetchFromZr(
    @Req() req: any,
    @Body() body: { apiKey: string; tenantId: string },
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.fetchZrFees(vendorEmail, body.apiKey, body.tenantId);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-zr-express/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from ZR Express API' })
  async fetchFromZrForWilaya(
    @Req() req: any,
    @Param('wilayaCode') wilayaCode: string,
    @Body() body: { apiKey: string; tenantId: string },
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.fetchZrFeeForWilaya(vendorEmail, wilayaCode, body.apiKey, body.tenantId);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-dhd')
  @ApiOperation({ summary: 'Fetch delivery fees from DHD API' })
  async fetchFromDhd(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.fetchDhdFees(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-dhd/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from DHD API' })
  async fetchFromDhdForWilaya(
    @Req() req: any,
    @Param('wilayaCode') wilayaCode: string,
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.fetchDhdFeeForWilaya(vendorEmail, wilayaCode);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-noest/async')
  @HttpCode(202)
  @ApiOperation({ summary: 'Fetch Noest fees asynchronously (poll GET jobs/:jobId for result)' })
  async fetchFromNoestAsync(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.startFetchNoest(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-ecom/async')
  @HttpCode(202)
  @ApiOperation({ summary: 'Fetch Ecom fees asynchronously (poll GET jobs/:jobId for result)' })
  async fetchFromEcomAsync(
    @Req() req: any,
    @Body() body: { apiKey: string; apiToken: string },
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.startFetchEcom(vendorEmail, body.apiKey, body.apiToken);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-zr-express/async')
  @HttpCode(202)
  @ApiOperation({ summary: 'Fetch ZR Express fees asynchronously (poll GET jobs/:jobId for result)' })
  async fetchFromZrAsync(
    @Req() req: any,
    @Body() body: { apiKey: string; tenantId: string },
  ) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.startFetchZr(vendorEmail, body.apiKey, body.tenantId);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_UPDATE)
  @Post('fetch-from-dhd/async')
  @HttpCode(202)
  @ApiOperation({ summary: 'Fetch DHD fees asynchronously (poll GET jobs/:jobId for result)' })
  async fetchFromDhdAsync(@Req() req: any) {
    const vendorEmail = await this.storeEmailFor(req);
    return this.feesService.startFetchDhd(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @RequirePermissions(StorePermission.DELIVERY_FEES_VIEW)
  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Get async fee-fetch job status and result' })
  async getJobStatus(@Req() req: any, @Param('jobId') jobId: string) {
    // Scoped to the caller: another vendor's job id answers `not_found` (H13).
    const job = this.feesService.getFetchJobStatus(jobId, await this.storeEmailFor(req));
    if (!job) {
      return { status: 'not_found' };
    }
    const { createdAt, ...rest } = job;
    return rest;
  }
}
