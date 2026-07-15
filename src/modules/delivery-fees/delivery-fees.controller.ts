import { Controller, Get, Patch, Post, Param, Body, Query, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { DeliveryFeesService } from './delivery-fees.service';
import { UpdateDeliveryFeeDto, BulkUpdateDeliveryFeeDto } from './dto/manage-delivery-fees.dto';

@ApiTags('Delivery Fees')
@Controller('delivery-fees')
export class DeliveryFeesController {
  constructor(private readonly feesService: DeliveryFeesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all delivery fees for a vendor' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  getFees(@Query('vendorEmail') vendorEmail: string) {
    return this.feesService.getFees(vendorEmail);
  }

  @Get('by-wilaya')
  @ApiOperation({ summary: 'Get delivery fee for a specific wilaya' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  @ApiQuery({ name: 'wilayaCode', required: true })
  getFee(
    @Query('vendorEmail') vendorEmail: string,
    @Query('wilayaCode') wilayaCode: string,
  ) {
    return this.feesService.getFee(vendorEmail, wilayaCode);
  }

  @Patch(':wilayaCode')
  @ApiOperation({ summary: 'Update delivery fee for a wilaya' })
  updateFee(
    @Query('vendorEmail') vendorEmail: string,
    @Param('wilayaCode') wilayaCode: string,
    @Body() dto: UpdateDeliveryFeeDto,
  ) {
    return this.feesService.updateFee(vendorEmail, wilayaCode, dto);
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Bulk update delivery fees' })
  bulkUpdate(
    @Query('vendorEmail') vendorEmail: string,
    @Body() dto: BulkUpdateDeliveryFeeDto,
  ) {
    return this.feesService.bulkUpdate(vendorEmail, dto);
  }

  @Post('seed')
  @ApiOperation({ summary: 'Seed default fees (0 DA) for missing wilayas' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  seed(
    @Query('vendorEmail') vendorEmail: string,
    @Body() body: { wilayaCodes: string[] },
  ) {
    return this.feesService.seedDefaults(vendorEmail, body.wilayaCodes);
  }

  @Post('fetch-from-noest')
  @ApiOperation({ summary: 'Fetch delivery fees from Noest Express API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  fetchFromNoest(@Query('vendorEmail') vendorEmail: string) {
    return this.feesService.fetchNoestFees(vendorEmail);
  }

  @Post('fetch-from-noest/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from Noest Express API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  fetchFromNoestForWilaya(
    @Query('vendorEmail') vendorEmail: string,
    @Param('wilayaCode') wilayaCode: string,
  ) {
    return this.feesService.fetchNoestFeeForWilaya(vendorEmail, wilayaCode);
  }

  @Post('fetch-from-ecom')
  @ApiOperation({ summary: 'Fetch delivery fees from Ecom Delivery API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  fetchFromEcom(
    @Query('vendorEmail') vendorEmail: string,
    @Body() body: { apiKey: string; apiToken: string },
  ) {
    return this.feesService.fetchEcomFees(vendorEmail, body.apiKey, body.apiToken);
  }

  @Post('fetch-from-ecom/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from Ecom Delivery API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  fetchFromEcomForWilaya(
    @Query('vendorEmail') vendorEmail: string,
    @Param('wilayaCode') wilayaCode: string,
    @Body() body: { apiKey: string; apiToken: string },
  ) {
    return this.feesService.fetchEcomFeeForWilaya(vendorEmail, wilayaCode, body.apiKey, body.apiToken);
  }

  @Post('fetch-from-zr-express')
  @ApiOperation({ summary: 'Fetch delivery fees from ZR Express API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  fetchFromZr(
    @Query('vendorEmail') vendorEmail: string,
    @Body() body: { apiKey: string; tenantId: string },
  ) {
    return this.feesService.fetchZrFees(vendorEmail, body.apiKey, body.tenantId);
  }

  @Post('fetch-from-zr-express/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from ZR Express API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  fetchFromZrForWilaya(
    @Query('vendorEmail') vendorEmail: string,
    @Param('wilayaCode') wilayaCode: string,
    @Body() body: { apiKey: string; tenantId: string },
  ) {
    return this.feesService.fetchZrFeeForWilaya(vendorEmail, wilayaCode, body.apiKey, body.tenantId);
  }

  @Post('fetch-from-dhd')
  @ApiOperation({ summary: 'Fetch delivery fees from DHD API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  fetchFromDhd(
    @Query('vendorEmail') vendorEmail: string,
  ) {
    return this.feesService.fetchDhdFees(vendorEmail);
  }

  @Post('fetch-from-dhd/:wilayaCode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fetch delivery fee for a specific wilaya from DHD API' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  fetchFromDhdForWilaya(
    @Query('vendorEmail') vendorEmail: string,
    @Param('wilayaCode') wilayaCode: string,
  ) {
    return this.feesService.fetchDhdFeeForWilaya(vendorEmail, wilayaCode);
  }
}
