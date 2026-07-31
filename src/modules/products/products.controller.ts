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
import { ProductQueryDto, VendorProductQueryDto } from './dto/product-query.dto';
import { Product } from './schemas/product.schema';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  @Post()
  @ApiOperation({ summary: 'Create a new product' })
  @ApiResponse({ status: 201, description: 'Product created', type: Product })
  create(@Body() createProductDto: CreateProductDto, @Req() req: any) {
    const user = req.user as { email: string; sub: string };
    createProductDto.vendorId = user.sub;
    return this.productsService.create(createProductDto, user.email);
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
  @ApiOperation({ summary: 'List vendor\'s own products (protected, cursor-based pagination)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'subCategory', required: false })
  @ApiQuery({ name: 'minPrice', required: false })
  @ApiQuery({ name: 'maxPrice', required: false })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['price_asc', 'price_desc', 'newest', 'name'] })
  @ApiQuery({ name: 'published', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiResponse({ status: 200, description: 'Vendor products with cursor pagination' })
  findVendorProducts(@Query() query: VendorProductQueryDto, @Req() req: any) {
    const user = req.user as { email: string };
    return this.productsService.findVendorProducts(user.email, query);
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

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Patch(':id')
  @ApiOperation({ summary: 'Update product by ID' })
  @ApiResponse({ status: 200, description: 'Product updated', type: Product })
  @ApiResponse({ status: 404, description: 'Product not found' })
  update(@Param('id') id: string, @Body() updateProductDto: UpdateProductDto, @Req() req: any) {
    const user = req.user as { email: string };
    return this.productsService.update(id, updateProductDto, user.email);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Delete(':id')
  @ApiOperation({ summary: 'Delete product by ID' })
  @ApiResponse({ status: 200, description: 'Product deleted' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  remove(@Param('id') id: string, @Req() req: any) {
    const user = req.user as { email: string };
    return this.productsService.remove(id, user.email);
  }

  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Duplicate a product' })
  @ApiResponse({ status: 201, description: 'Product duplicated', type: Product })
  @ApiResponse({ status: 404, description: 'Product not found' })
  duplicate(@Param('id') id: string, @Req() req: any) {
    const user = req.user as { email: string };
    return this.productsService.duplicate(id, user.email);
  }
}
