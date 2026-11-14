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
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductQueryDto, VendorProductQueryDto, ProductSuggestionQueryDto } from './dto/product-query.dto';
import { Product } from './schemas/product.schema';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { StoresService } from '../stores/stores.service';

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly storesService: StoresService,
  ) {}

  /**
   * Email-keyed service paths use the store's canonical `vendorEmail`; an employee's login
   * email is not the tenant key. The store is resolved from the session exactly once here.
   */
  private async storeEmailFor(req: any): Promise<{ email: string; id: string }> {
    const user = req.user as { id: string };
    const store = await this.storesService.findByMemberIdOrThrow(user.id);
    return { email: store.vendorEmail, id: user.id };
  }

  // D-7: `RolesGuard` is a strict allowlist, so listing ADMIN alongside VENDOR mirrors
  // `ProductsService.assertVendorOrAdmin` exactly. The point of the guard is to stop a
  // CUSTOMER reaching these routes at all - they previously could, and only the
  // service's ownership check stood between them and another vendor's catalogue.
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_CREATE)
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  @Post()
  @ApiOperation({ summary: 'Create a new product' })
  @ApiResponse({ status: 201, description: 'Product created', type: Product })
  async create(@Body() createProductDto: CreateProductDto, @Req() req: any) {
    // D-7: this used to read `user.sub`, which the JWT strategy has never populated - it
    // returns `{ id, email, role }`. So `vendorId` was always `undefined`, and the field
    // was nonetheless client-settable through the body, which is a privilege-escalation
    // hole of the same shape as the one closed on `CreateStoreDto.vendorId`. Seller
    // identity is `storeId`, resolved from the session by the service.
    const store = await this.storeEmailFor(req);
    return this.productsService.create(createProductDto, store.email, store.id);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'List all products (public, cursor-based pagination)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page (default 20, max 100)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'JSON stringified cursor {createdAt, _id} from previous response' })
  @ApiQuery({ name: 'vendorEmail', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'subCategory', required: false })
  @ApiQuery({ name: 'search', required: false, description: 'Full-text search' })
  @ApiQuery({ name: 'minPrice', required: false })
  @ApiQuery({ name: 'maxPrice', required: false })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['price_asc', 'price_desc', 'newest', 'name'] })
  @ApiResponse({ status: 200, description: 'Products with cursor pagination' })
  findAll(@Query() query: ProductQueryDto) {
    return this.productsService.findAll(query);
  }

  @Get('vendor')
  @RequirePermissions(StorePermission.PRODUCTS_BROWSE)
  @ApiOperation({ summary: 'List vendor\'s own products (protected, offset pagination)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page (default 20, max 100)' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'subCategory', required: false })
  @ApiQuery({ name: 'minPrice', required: false })
  @ApiQuery({ name: 'maxPrice', required: false })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['price_asc', 'price_desc', 'newest', 'name'] })
  @ApiQuery({ name: 'published', required: false })
  @ApiResponse({ status: 200, description: 'Vendor products with offset pagination' })
  async findVendorProducts(@Query() query: VendorProductQueryDto, @Req() req: any) {
    const store = await this.storeEmailFor(req);
    return this.productsService.findVendorProducts(store.email, query);
  }

  /**
   * Product suggestions for the inventory search box's autocomplete.
   *
   * Three properties matter and are why this is not another use of `GET /products/vendor`:
   *  - the store is resolved from the session (the service takes the vendor id), so a
   *    caller can only ever be shown their own catalogue;
   *  - the response is a handful of projected fields, sized for a dropdown;
   *  - it never touches variant stock or the `GET /inventory` listing, so typing here
   *    cannot move the grid.
   *
   * Declared before `GET :id` on purpose: Express matches routes in declaration order,
   * and `search` would otherwise be swallowed by the `:id` parameter route.
   */
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_BROWSE)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('search')
  @ApiOperation({ summary: 'Lightweight product suggestions for the current store (inventory search)' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'limit', required: false })
  searchSuggestions(@Query() query: ProductSuggestionQueryDto, @Req() req: any) {
    const user = req.user as { id: string };
    return this.productsService.searchSuggestions(user.id, query);
  }

  @Public()
  @Get('slug-id/:slugId')
  @ApiOperation({ summary: 'Get product by slug-ID (public)' })
  @ApiResponse({ status: 200, description: 'Product found', type: Product })
  @ApiResponse({ status: 404, description: 'Product not found' })
  findBySlugId(@Param('slugId') slugId: string) {
    return this.productsService.findBySlugId(slugId);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get product by ID (public)' })
  @ApiResponse({ status: 200, description: 'Product found', type: Product })
  @ApiResponse({ status: 404, description: 'Product not found' })
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_UPDATE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Patch(':id')
  @ApiOperation({ summary: 'Update product by ID' })
  @ApiResponse({ status: 200, description: 'Product updated', type: Product })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async update(@Param('id') id: string, @Body() updateProductDto: UpdateProductDto, @Req() req: any) {
    const store = await this.storeEmailFor(req);
    return this.productsService.update(id, updateProductDto, store.email, store.id);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_DELETE)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Delete(':id')
  @ApiOperation({ summary: 'Delete product by ID' })
  @ApiResponse({ status: 200, description: 'Product deleted' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async remove(@Param('id') id: string, @Req() req: any) {
    const store = await this.storeEmailFor(req);
    return this.productsService.remove(id, store.email, store.id);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.PRODUCTS_DUPLICATE)
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Duplicate a product' })
  @ApiResponse({ status: 201, description: 'Product duplicated', type: Product })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async duplicate(@Param('id') id: string, @Req() req: any) {
    const store = await this.storeEmailFor(req);
    return this.productsService.duplicate(id, store.email, store.id);
  }
}
