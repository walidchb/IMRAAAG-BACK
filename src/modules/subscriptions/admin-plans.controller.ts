import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminProtected } from '../admin/decorators/admin-protected.decorator';
import { CurrentAdmin } from '../admin/decorators/current-admin.decorator';
import type { AdminPrincipal } from '../admin/decorators/current-admin.decorator';
import { AdminIdParamDto } from '../admin/dto/admin-id-param.dto';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { IMAGE_CONFIG } from '../upload/image.config';
import { UploadService } from '../upload/upload.service';
import { PlansService } from './plans.service';
import {
  CreatePlanDto,
  PlanQueryDto,
  UpdatePlanAvailabilityDto,
  UpdatePlanDto,
} from './dto/plan.dto';

@ApiTags('Admin Plans')
@AdminProtected()
@Controller('admin/plans')
export class AdminPlansController {
  constructor(
    private readonly plansService: PlansService,
    private readonly uploadService: UploadService,
  ) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'List, search, filter and paginate plans' })
  list(@Query() query: PlanQueryDto) {
    return this.plansService.list(query);
  }

  @Get(':id')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'Plan detail with subscriber summary' })
  get(@Param() params: AdminIdParamDto) {
    return this.plansService.get(params.id);
  }

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Create a plan (affects future assignments only)' })
  create(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreatePlanDto) {
    return this.plansService.create(dto, { id: admin.id, email: admin.email });
  }

  @Post('image')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_CONFIG.maxFileSize } }))
  @ApiOperation({ summary: 'Upload a plan icon' })
  @ApiConsumes('multipart/form-data')
  async uploadImage(
    @CurrentAdmin() admin: AdminPrincipal,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    return this.uploadService.uploadPlanImage(file, `admin/${admin.id}`);
  }

  @Patch(':id')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Edit a plan; increments version, never touches subscriptions' })
  update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.plansService.update(params.id, dto, { id: admin.id, email: admin.email });
  }

  @Patch(':id/availability')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Activate or deactivate a plan' })
  setAvailability(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
    @Body() dto: UpdatePlanAvailabilityDto,
  ) {
    return this.plansService.setAvailability(params.id, dto.isActive, {
      id: admin.id,
      email: admin.email,
    });
  }
}
