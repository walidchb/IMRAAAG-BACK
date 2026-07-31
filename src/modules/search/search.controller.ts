import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ProductsService } from '../products/products.service';
import { ProductQueryDto } from '../products/dto/product-query.dto';
import { StoresService } from '../stores/stores.service';
import { StoreStatus } from '../stores/schemas/store-status.enum';
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

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 20;
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
      const productQuery: ProductQueryDto = {
        search: query.q,
        category: query.category,
        subCategory: query.subCategory,
        minPrice: query.minPrice,
        maxPrice: query.maxPrice,
        sortBy: query.sortBy,
        cursor: query.cursor,
        limit: query.limit,
      };
      const result = await this.productsService.findAll(productQuery);
      results.products = result.products;
      results.nextCursor = result.nextCursor;
      results.hasMore = result.hasMore;
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
          { wilaya: regex },
        ],
        status: StoreStatus.ACTIVE,
      };

      const items = await this.storesService.findAllRaw(filter);
      results.stores = items;
    }

    results.maxProductPrice = await this.productsService.getMaxPrice();

    return results;
  }
}
