import { Controller, Get, Patch, Post, Param, Body, Query, Req, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { DeliveryFeesService } from './delivery-fees.service';
import { UpdateDeliveryFeeDto, BulkUpdateDeliveryFeeDto } from './dto/manage-delivery-fees.dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';

@ApiTags('Delivery Fees')
@ApiBearerAuth()
@Controller('delivery-fees')
export class DeliveryFeesController {
  constructor(private readonly feesService: DeliveryFeesService) {}

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get()
  @ApiOperation({ summary: 'Get all delivery fees for current vendor' })
  getFees(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.feesService.getFees(vendorEmail);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('by-wilaya')
  @ApiOperation({ summary: 'Get delivery fee for a specific wilaya (public)' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  @ApiQuery({ name: 'wilayaCode', required: true })
  getFee(
    @Query('vendorEmail') vendorEmail: string,
    @Query('wilayaCode') wilayaCode: string,
  ) {
    return this.feesService.getFee(vendorEmail, wilayaCode);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Patch(':wilayaCode')
  @ApiOperation({ summary: 'Update delivery fee for a wilaya' })
  updateFee(
    @Req() req: any,
    @Param('wilayaCode') wilayaCode: string,
    @Body() dto: UpdateDeliveryFeeDto,
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.updateFee(vendorEmail, wilayaCode, dto);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('bulk')
  @ApiOperation({ summary: 'Bulk update delivery fees' })
  bulkUpdate(
    @Req() req: any,
    @Body() dto: BulkUpdateDeliveryFeeDto,
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.bulkUpdate(vendorEmail, dto);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('seed')
  @ApiOperation({ summary: 'Seed default fees (0 DA) for missing wilayas' })
  seed(
    @Req() req: any,
    @Body() body: { wilayaCodes: string[] },
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.seedDefaults(vendorEmail, body.wilayaCodes);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-noest')
  @ApiOperation({ summary: 'Fetch delivery fees from Noest Express API' })
  fetchFromNoest(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.feesService.fetchNoestFees(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-noest/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from Noest Express API' })
  fetchFromNoestForWilaya(
    @Req() req: any,
    @Param('wilayaCode') wilayaCode: string,
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.fetchNoestFeeForWilaya(vendorEmail, wilayaCode);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-ecom')
  @ApiOperation({ summary: 'Fetch delivery fees from Ecom Delivery API' })
  fetchFromEcom(
    @Req() req: any,
    @Body() body: { apiKey: string; apiToken: string },
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.fetchEcomFees(vendorEmail, body.apiKey, body.apiToken);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-ecom/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from Ecom Delivery API' })
  fetchFromEcomForWilaya(
    @Req() req: any,
    @Param('wilayaCode') wilayaCode: string,
    @Body() body: { apiKey: string; apiToken: string },
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.fetchEcomFeeForWilaya(vendorEmail, wilayaCode, body.apiKey, body.apiToken);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-zr-express')
  @ApiOperation({ summary: 'Fetch delivery fees from ZR Express API' })
  fetchFromZr(
    @Req() req: any,
    @Body() body: { apiKey: string; tenantId: string },
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.fetchZrFees(vendorEmail, body.apiKey, body.tenantId);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-zr-express/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from ZR Express API' })
  fetchFromZrForWilaya(
    @Req() req: any,
    @Param('wilayaCode') wilayaCode: string,
    @Body() body: { apiKey: string; tenantId: string },
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.fetchZrFeeForWilaya(vendorEmail, wilayaCode, body.apiKey, body.tenantId);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-dhd')
  @ApiOperation({ summary: 'Fetch delivery fees from DHD API' })
  fetchFromDhd(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.feesService.fetchDhdFees(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-dhd/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from DHD API' })
  fetchFromDhdForWilaya(
    @Req() req: any,
    @Param('wilayaCode') wilayaCode: string,
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.fetchDhdFeeForWilaya(vendorEmail, wilayaCode);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-noest/async')
  @HttpCode(202)
  @ApiOperation({ summary: 'Fetch Noest fees asynchronously (poll GET jobs/:jobId for result)' })
  async fetchFromNoestAsync(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.feesService.startFetchNoest(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-ecom/async')
  @HttpCode(202)
  @ApiOperation({ summary: 'Fetch Ecom fees asynchronously (poll GET jobs/:jobId for result)' })
  async fetchFromEcomAsync(
    @Req() req: any,
    @Body() body: { apiKey: string; apiToken: string },
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.startFetchEcom(vendorEmail, body.apiKey, body.apiToken);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-zr-express/async')
  @HttpCode(202)
  @ApiOperation({ summary: 'Fetch ZR Express fees asynchronously (poll GET jobs/:jobId for result)' })
  async fetchFromZrAsync(
    @Req() req: any,
    @Body() body: { apiKey: string; tenantId: string },
  ) {
    const vendorEmail = req.user.email;
    return this.feesService.startFetchZr(vendorEmail, body.apiKey, body.tenantId);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('fetch-from-dhd/async')
  @HttpCode(202)
  @ApiOperation({ summary: 'Fetch DHD fees asynchronously (poll GET jobs/:jobId for result)' })
  async fetchFromDhdAsync(@Req() req: any) {
    const vendorEmail = req.user.email;
    return this.feesService.startFetchDhd(vendorEmail);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Get async fee-fetch job status and result' })
  getJobStatus(@Param('jobId') jobId: string) {
    const job = this.feesService.getFetchJobStatus(jobId);
    if (!job) {
      return { status: 'not_found' };
    }
    const { createdAt, ...rest } = job;
    return rest;
  }
}
