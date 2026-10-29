import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { OrderLabelsService } from './order-labels.service';
import { GenerateOrderLabelsDto } from './dto/generate-order-labels.dto';

@ApiTags('Order Labels')
@Controller('orders/labels')
@Roles(Role.VENDOR, Role.ADMIN)
export class OrderLabelsController {
  constructor(private readonly orderLabelsService: OrderLabelsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  @ApiOperation({
    summary: 'Generate shipping labels for dispatched orders',
    description:
      'Fetches and composes carrier labels on the backend, stores them privately, and returns a manifest with a download URL.',
  })
  @ApiResponse({ status: 200, description: 'Label job manifest (may contain partial failures)' })
  @ApiResponse({ status: 400, description: 'No eligible orders or invalid request' })
  @ApiResponse({ status: 404, description: 'Order labels are disabled' })
  generate(@Body() dto: GenerateOrderLabelsDto, @Req() req: any) {
    return this.orderLabelsService.generate(dto, req.user);
  }

  @Get('availability')
  @ApiOperation({ summary: 'Report whether order-label printing is available to the caller' })
  @ApiResponse({ status: 200, description: 'Label printing availability for the current store' })
  availability(@Req() req: any) {
    return this.orderLabelsService.availability(req.user);
  }

  @Get(':jobId/:file')
  @ApiOperation({ summary: 'Download a generated label artifact' })
  async download(
    @Param('jobId') jobId: string,
    @Param('file') file: string,
    @Query('storeId') storeId: string | undefined,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const artifact = await this.orderLabelsService.download(jobId, file, req.user, storeId);
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Content-Disposition', artifact.contentDisposition);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (artifact.contentLength !== null) {
      res.setHeader('Content-Length', String(artifact.contentLength));
    }
    return new StreamableFile(artifact.body);
  }
}
