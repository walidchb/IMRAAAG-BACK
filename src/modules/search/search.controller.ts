import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ProductsService } from '../products/products.service';
import { StoresService } from '../stores/stores.service';
import { Public } from '../auth/decorators/public.decorator';
import { IsOptional, IsString, IsIn, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SearchQueryDto {
  @IsString()
  q: string;

  @IsOptional()
  @IsIn(['products', 'stores'])
  type?: 'products' | 'stores';

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  subCategory?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'newest', 'name'])
  sortBy?: string;
}

@ApiTags('Search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly storesService: StoresService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Unified search across products and stores' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'type', required: false, enum: ['products', 'stores'] })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'subCategory', required: false })
  @ApiQuery({ name: 'minPrice', required: false })
  @ApiQuery({ name: 'maxPrice', required: false })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['price_asc', 'price_desc', 'newest', 'name'] })
  async search(@Query() query: SearchQueryDto) {
    const results: Record<string, unknown> = {};

    if (!query.type || query.type === 'products') {
      const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = { $regex: escaped, $options: 'i' };

      const filter: Record<string, any> = {
        $or: [
          { nameEn: regex },
          { nameAr: regex },
          { nameFr: regex },
          { storyEn: regex },
          { storyAr: regex },
          { storyFr: regex },
          { slug: regex },
          { vendorEmail: regex },
          { 'variants.nameEn': regex },
          { 'variants.nameAr': regex },
          { 'variants.nameFr': regex },
          { 'variants.options.nameEn': regex },
          { 'variants.options.nameAr': regex },
          { 'variants.options.nameFr': regex },
        ],
        published: true,
        status: 'Active',
      };

      if (query.category) filter.category = query.category;
      if (query.subCategory) filter.subCategory = query.subCategory;
      if (query.minPrice !== undefined || query.maxPrice !== undefined) {
        filter.price = {};
        if (query.minPrice !== undefined) filter.price.$gte = query.minPrice;
        if (query.maxPrice !== undefined) filter.price.$lte = query.maxPrice;
      }

      const sortMapping: Record<string, any> = {
        price_asc: { price: 1 },
        price_desc: { price: -1 },
        newest: { createdAt: -1 },
        name: { nameEn: 1 },
      };
      const sortOption = sortMapping[query.sortBy || 'newest'] || { createdAt: -1 };

      const items = await this.productsService.findAllRaw(filter, sortOption);
      results.products = items;
    }

    if (!query.type || query.type === 'stores') {
      const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = { $regex: escaped, $options: 'i' };

      const filter: Record<string, any> = {
        $or: [
          { storeName: regex },
          { storeSlug: regex },
          { description: regex },
          { tagline: regex },
          { vendorEmail: regex },
          { contactEmail: regex },
          { contactPhone: regex },
          { 'address.city': regex },
          { 'address.street': regex },
          { wilaya: regex },
        ],
        status: 'Active',
      };

      if (query.minPrice !== undefined || query.maxPrice !== undefined) {
        filter.price = {};
        if (query.minPrice !== undefined) filter.price.$gte = query.minPrice;
        if (query.maxPrice !== undefined) filter.price.$lte = query.maxPrice;
      }

      const items = await this.storesService.findAllRaw(filter);
      results.stores = items;
    }

    results.maxProductPrice = await this.productsService.getMaxPrice();

    return results;
  }
}
