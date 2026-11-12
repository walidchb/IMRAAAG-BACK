import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CategoriesService } from './categories.service';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { StoresService } from '../stores/stores.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateSubCategoryDto } from './dto/create-sub-category.dto';
import { UpdateSubCategoryDto } from './dto/update-sub-category.dto';
import { CategoryQueryDto } from './dto/category-query.dto';

@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly storesService: StoresService,
  ) {}

  /** Resolves the owning store from the session only; a body/query `storeId` is ignored. */
  private async storeFor(req: any) {
    return this.storesService.findByMemberIdOrThrow(String(req.user.id));
  }

  // Declared before `GET :id` so Express does not treat `mine` as a category id.
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_VIEW)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('mine')
  @ApiOperation({ summary: "List the session store's categories with all-product counts" })
  async findMine(@Req() req: any) {
    const store = await this.storeFor(req);
    return this.categoriesService.findMine(store._id);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List published categories for one store' })
  findPublicByStore(@Query() query: CategoryQueryDto) {
    return this.categoriesService.findPublicByStore(query);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get a published category and its published subcategories' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  findOne(@Param('id') id: string) {
    return this.categoriesService.findPublicById(id);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_CATEGORIES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post()
  @ApiOperation({ summary: 'Create a category (optionally with nested subcategories)' })
  async create(@Body() dto: CreateCategoryDto, @Req() req: any) {
    const store = await this.storeFor(req);
    return this.categoriesService.createCategory(store._id, dto, String(req.user.id));
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_CATEGORIES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a category / publish toggle' })
  async update(@Param('id') id: string, @Body() dto: UpdateCategoryDto, @Req() req: any) {
    const store = await this.storeFor(req);
    return this.categoriesService.updateCategory(store._id, id, dto, String(req.user.id));
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_CATEGORIES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a category and its subcategories' })
  async remove(@Param('id') id: string, @Req() req: any) {
    const store = await this.storeFor(req);
    return this.categoriesService.removeCategory(store._id, id, String(req.user.id));
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_CATEGORIES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post(':id/subcategories')
  @ApiOperation({ summary: 'Create a subcategory under a category' })
  async createSubCategory(
    @Param('id') id: string,
    @Body() dto: CreateSubCategoryDto,
    @Req() req: any,
  ) {
    const store = await this.storeFor(req);
    return this.categoriesService.createSubCategory(store._id, id, dto, String(req.user.id));
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_CATEGORIES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Patch(':id/subcategories/:subId')
  @ApiOperation({ summary: 'Edit a subcategory / publish toggle' })
  async updateSubCategory(
    @Param('id') id: string,
    @Param('subId') subId: string,
    @Body() dto: UpdateSubCategoryDto,
    @Req() req: any,
  ) {
    const store = await this.storeFor(req);
    return this.categoriesService.updateSubCategory(
      store._id,
      id,
      subId,
      dto,
      String(req.user.id),
    );
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_CATEGORIES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Delete(':id/subcategories/:subId')
  @ApiOperation({ summary: 'Soft-delete a subcategory' })
  async removeSubCategory(
    @Param('id') id: string,
    @Param('subId') subId: string,
    @Req() req: any,
  ) {
    const store = await this.storeFor(req);
    return this.categoriesService.removeSubCategory(
      store._id,
      id,
      subId,
      String(req.user.id),
    );
  }
}
