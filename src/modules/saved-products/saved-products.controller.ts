import { Controller, Get, Post, Param, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SavedProductsService } from './saved-products.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import type { Request } from 'express';

/**
 * Uses the global `JwtAuthGuard` + `RolesGuard` rather than a route-local `AuthGuard('jwt')`.
 * The local guard bypassed the project's guard contract entirely: it never consulted `@Roles`,
 * and it would have accepted the old OTP-verification token as a session (M16/H3).
 */
@ApiTags('Saved Products')
@Controller('saved-products')
@Roles(Role.CUSTOMER, Role.VENDOR, Role.ADMIN)
export class SavedProductsController {
  constructor(private readonly savedProductsService: SavedProductsService) {}

  @Get()
  @ApiOperation({ summary: 'List user saved products' })
  @ApiResponse({ status: 200, description: 'List of saved products' })
  findAll(@Req() req: Request) {
    const userId = (req.user as any)?.id;
    if (!userId) throw new AppException(AppErrorCode.AUTH_UNAUTHORIZED);
    return this.savedProductsService.findAll(userId);
  }

  @Post(':productId')
  @ApiOperation({ summary: 'Toggle save/un-save a product' })
  @ApiResponse({ status: 201, description: 'Product save toggled' })
  toggle(@Req() req: Request, @Param('productId') productId: string) {
    const userId = (req.user as any)?.id;
    if (!userId) throw new AppException(AppErrorCode.AUTH_UNAUTHORIZED);
    return this.savedProductsService.toggle(userId, productId);
  }
}
