import { Controller, Get, Post, Param, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { SavedProductsService } from './saved-products.service';
import type { Request } from 'express';

@ApiTags('Saved Products')
@Controller('saved-products')
@UseGuards(AuthGuard('jwt'))
export class SavedProductsController {
  constructor(private readonly savedProductsService: SavedProductsService) {}

  @Get()
  @ApiOperation({ summary: 'List user saved products' })
  @ApiResponse({ status: 200, description: 'List of saved products' })
  findAll(@Req() req: Request) {
    const userId = (req.user as any).id;
    return this.savedProductsService.findAll(userId);
  }

  @Post(':productId')
  @ApiOperation({ summary: 'Toggle save/un-save a product' })
  @ApiResponse({ status: 201, description: 'Product save toggled' })
  toggle(@Req() req: Request, @Param('productId') productId: string) {
    const userId = (req.user as any).id;
    return this.savedProductsService.toggle(userId, productId);
  }
}
