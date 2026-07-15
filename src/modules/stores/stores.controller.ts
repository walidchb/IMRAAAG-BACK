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
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { StoresService } from './stores.service';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import { Store } from './schemas/store.schema';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';

@ApiTags('Stores')
@ApiBearerAuth()
@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Roles(Role.VENDOR)
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
    return this.storesService.findByEmail(user.email);
  }

  @Roles(Role.VENDOR)
  @Patch('mine')
  @ApiOperation({ summary: 'Update own store' })
  @ApiResponse({ status: 200, description: 'Store updated', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async updateMine(@Body() updateStoreDto: UpdateStoreDto, @Req() req: any) {
    const user = req.user as { email: string };
    const store = await this.storesService.findByEmail(user.email) as any;
    return this.storesService.update(store._id.toString(), updateStoreDto);
  }

  @Roles(Role.VENDOR)
  @Patch('mine/toggle-status')
  @ApiOperation({ summary: 'Toggle own store status Active/Paused' })
  @ApiResponse({ status: 200, description: 'Status toggled', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async toggleStatus(@Req() req: any) {
    const user = req.user as { email: string };
    const store = await this.storesService.findByEmail(user.email) as any;
    return this.storesService.toggleStatus(store._id.toString());
  }

  @Post()
  @ApiOperation({ summary: 'Create a new store' })
  @ApiResponse({ status: 201, description: 'Store created', type: Store })
  @ApiResponse({ status: 409, description: 'Store already exists for this vendor' })
  create(@Body() createStoreDto: CreateStoreDto) {
    return this.storesService.create(createStoreDto);
  }

  @Get()
  @ApiOperation({ summary: 'List all stores' })
  @ApiQuery({ name: 'isActive', required: false })
  @ApiQuery({ name: 'isVerified', required: false })
  @ApiQuery({ name: 'search', required: false, description: 'Full-text search' })
  @ApiResponse({ status: 200, description: 'List of stores', type: [Store] })
  findAll(
    @Query('isActive') isActive?: string,
    @Query('isVerified') isVerified?: string,
    @Query('search') search?: string,
  ) {
    return this.storesService.findAll({ isActive, isVerified, search });
  }

  @Get('by-email/:email')
  @ApiOperation({ summary: 'Get store by vendor email' })
  @ApiResponse({ status: 200, description: 'Store found', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  findByEmail(@Param('email') email: string) {
    return this.storesService.findByEmail(email);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get store by ID, slug, or vendor ID' })
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

  @Patch(':id')
  @ApiOperation({ summary: 'Update store by ID' })
  @ApiResponse({ status: 200, description: 'Store updated', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  update(@Param('id') id: string, @Body() updateStoreDto: UpdateStoreDto) {
    return this.storesService.update(id, updateStoreDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete store by ID' })
  @ApiResponse({ status: 200, description: 'Store deleted' })
  @ApiResponse({ status: 404, description: 'Store not found' })
  remove(@Param('id') id: string) {
    return this.storesService.remove(id);
  }
}
