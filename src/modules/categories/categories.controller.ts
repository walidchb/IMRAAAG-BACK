import { Controller, Get, Post, Param, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Public()
  @Post('seed')
  @ApiOperation({ summary: 'Seed categories from static data' })
  @ApiResponse({ status: 201, description: 'Categories seeded' })
  async seed() {
    await this.categoriesService.seed();
    return { message: 'Categories seeded successfully' };
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'List all categories with subcategories' })
  @ApiResponse({ status: 200, description: 'List of categories' })
  findAll() {
    return this.categoriesService.findAll();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get category by ID with subcategories' })
  @ApiResponse({ status: 200, description: 'Category found' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete category and its subcategories' })
  @ApiResponse({ status: 200, description: 'Category deleted' })
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(id);
  }
}
