import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { StoresService } from './stores.service';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import { Store } from './schemas/store.schema';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Role } from '../../common/constants/roles.enum';

@ApiTags('Stores')
@ApiBearerAuth()
@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  @Post('mine')
  @ApiOperation({ summary: 'Create own store' })
  @ApiResponse({ status: 201, description: 'Store created', type: Store })
  @ApiResponse({ status: 409, description: 'Store already exists' })
  createMine(@Body() createStoreDto: CreateStoreDto, @Req() req: any) {
    const user = req.user as { email: string };
    createStoreDto.vendorEmail = user.email;
    return this.storesService.create(createStoreDto);
  }

  @Roles(Role.VENDOR)
  @Get('mine')
  @ApiOperation({ summary: 'Get own store' })
  @ApiResponse({ status: 200, description: 'Store found', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  findMine(@Req() req: any) {
    const user = req.user as { email: string };
    return this.storesService.findByEmail(user.email, { skipStatusCheck: true });
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Patch('mine')
  @ApiOperation({ summary: 'Update own store' })
  @ApiResponse({ status: 200, description: 'Store updated', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async updateMine(@Body() updateStoreDto: UpdateStoreDto, @Req() req: any) {
    const user = req.user as { email: string };
    const store = await this.storesService.findByEmail(user.email, { skipStatusCheck: true }) as any;
    return this.storesService.update(store._id.toString(), updateStoreDto);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Patch('mine/toggle-status')
  @ApiOperation({ summary: 'Toggle own store status Active/Paused' })
  @ApiResponse({ status: 200, description: 'Status toggled', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async toggleStatus(@Req() req: any) {
    const user = req.user as { email: string };
    const store = await this.storesService.findByEmail(user.email, { skipStatusCheck: true }) as any;
    return this.storesService.toggleStatus(store._id.toString());
  }

  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  @Post()
  @ApiOperation({ summary: 'Create a new store' })
  @ApiResponse({ status: 201, description: 'Store created', type: Store })
  @ApiResponse({ status: 409, description: 'Store already exists for this vendor' })
  create(@Body() createStoreDto: CreateStoreDto) {
    return this.storesService.create(createStoreDto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'List all active stores (public, cursor-based pagination)' })
  @ApiQuery({ name: 'search', required: false, description: 'Full-text search' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page (default 10, max 100)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'JSON stringified cursor {createdAt, _id} from previous response' })
  @ApiResponse({ status: 200, description: 'Stores with cursor pagination' })
  findAll(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.storesService.findAll({
      search,
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }

  @Public()
  @Get('by-email/:email')
  @ApiOperation({ summary: 'Get store by vendor email (public)' })
  @ApiResponse({ status: 200, description: 'Store found', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  findByEmail(@Param('email') email: string) {
    return this.storesService.findByEmail(email);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get store by ID, slug, or vendor ID (public)' })
  @ApiQuery({
    name: 'by',
    required: false,
    enum: ['slug', 'vendor'],
    description: 'Lookup strategy',
  })
  @ApiResponse({ status: 200, description: 'Store found', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async findOne(
    @Param('id') id: string,
    @Query('by') by?: string,
  ) {
    if (by === 'slug') return this.storesService.findBySlug(id);
    if (by === 'vendor') return this.storesService.findByVendor(id);

    const isMongoId = /^[0-9a-fA-F]{24}$/.test(id);
    if (isMongoId) return this.storesService.findOne(id);

    return this.storesService.findBySlug(id);
  }

  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Patch(':id')
  @ApiOperation({ summary: 'Update store by ID (Admin only)' })
  @ApiResponse({ status: 200, description: 'Store updated', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  update(@Param('id') id: string, @Body() updateStoreDto: UpdateStoreDto) {
    return this.storesService.update(id, updateStoreDto);
  }

  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Delete(':id')
  @ApiOperation({ summary: 'Delete store by ID (Admin only)' })
  @ApiResponse({ status: 200, description: 'Store deleted' })
  @ApiResponse({ status: 404, description: 'Store not found' })
  remove(@Param('id') id: string) {
    return this.storesService.remove(id);
  }
}
