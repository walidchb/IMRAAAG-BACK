import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Types } from 'mongoose';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Public } from '../auth/decorators/public.decorator';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { StoresService } from '../stores/stores.service';
import { VariantsService } from './services/variants.service';
import { BarcodeService } from './services/barcode.service';
import {
  CreateOptionDto,
  CreateOptionValueDto,
  CreateVariantsDto,
  DeactivateVariantDto,
  GenerateCodesDto,
  PreviewCombinationsDto,
  SetOptionValueImagesDto,
  UpdateOptionDto,
  UpdateOptionValueDto,
  UpdateVariantDto,
} from './dto/variants.dto';
import { LocaleQueryDto } from './dto/inventory-list.dto';

/**
 * Option, value and variant management, always nested under the product that owns them.
 *
 * The store comes from the session and is never accepted from the request: a seller must
 * not be able to reach another store's matrix by editing a product id (§9.4).
 *
 * The class-level `@Roles` therefore covers everything *except* the two buyer-facing reads,
 * `variants/public-matrix` and `variants/availability`, which opt out with `@Public()`. The
 * storefront has to be able to show a customer which variants exist (and what is orderable),
 * and it cannot use `variants/matrix` - that one is a seller's view, carrying SKUs, barcodes
 * and reserved quantities.
 */
@ApiTags('variants')
@Controller('products/:productId')
@UseGuards(RolesGuard)
@Roles(Role.VENDOR, Role.ADMIN)
@RequirePermissions(StorePermission.PRODUCTS_VARIANTS_MANAGE)
export class VariantsController {
  constructor(
    private readonly variantsService: VariantsService,
    private readonly barcodeService: BarcodeService,
    private readonly storesService: StoresService,
  ) {}

  // --------------------------------------------------------------------- matrix

  /**
   * Buyer-facing variant matrix for the storefront.
   *
   * Public and unauthenticated by necessity, so it is throttled like the other public reads and
   * returns only what a shopper needs: active options, active variants, the price they pay and
   * what is orderable. SKUs, barcodes, reserved counts and draft products are not in the payload.
   */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('variants/public-matrix')
  async publicMatrix(@Param('productId') productId: string) {
    return this.variantsService.getPublicMatrix(productId);
  }

  /**
   * Slim buyer-facing availability for the storefront's sold-out refresh (roadmap 4.1).
   *
   * Public for the same reason the matrix is - the customer has no token - and throttled the
   * same way. Carries only `{ variantId, available }` per active variant, so polling it is
   * cheaper than re-fetching the full matrix and does not share its label payload. Availability
   * comes from the same variant set and balance math as `public-matrix`, so the two can never
   * disagree: a checkmark here and a selectable row there always match.
   */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('variants/availability')
  async availability(@Param('productId') productId: string) {
    return this.variantsService.getAvailability(productId);
  }

  /** Options, values and every offered combination with its stock. */
  @Get('variants/matrix')
  @RequirePermissions(StorePermission.PRODUCTS_VIEW)
  async matrix(
    @Param('productId') productId: string,
    @Query() query: LocaleQueryDto,
    @Req() req: any,
  ) {
    return this.variantsService.getMatrix(
      productId,
      await this.storeIdFor(req),
      query.locale,
    );
  }

  @Get('options')
  @RequirePermissions(StorePermission.PRODUCTS_VIEW)
  async options(@Param('productId') productId: string, @Req() req: any) {
    return this.variantsService.listOptions(productId, await this.storeIdFor(req));
  }

  // -------------------------------------------------------------------- options

  @Post('options')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async createOption(
    @Param('productId') productId: string,
    @Body() dto: CreateOptionDto,
    @Req() req: any,
  ) {
    return this.variantsService.createOption(productId, await this.storeIdFor(req), dto);
  }

  @Patch('options/:optionId')
  async updateOption(
    @Param('productId') productId: string,
    @Param('optionId') optionId: string,
    @Body() dto: UpdateOptionDto,
    @Req() req: any,
  ) {
    return this.variantsService.updateOption(productId, await this.storeIdFor(req), optionId, dto);
  }

  // --------------------------------------------------------------------- values

  @Post('options/:optionId/values')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async createValue(
    @Param('productId') productId: string,
    @Param('optionId') optionId: string,
    @Body() dto: CreateOptionValueDto,
    @Req() req: any,
  ) {
    return this.variantsService.createValue(productId, await this.storeIdFor(req), optionId, dto);
  }

  @Patch('options/:optionId/values/:valueId')
  async updateValue(
    @Param('productId') productId: string,
    @Param('optionId') optionId: string,
    @Param('valueId') valueId: string,
    @Body() dto: UpdateOptionValueDto,
    @Req() req: any,
  ) {
    return this.variantsService.updateValue(
      productId,
      await this.storeIdFor(req),
      optionId,
      valueId,
      dto,
    );
  }

  /** Deactivates. Values are never hard-deleted — see spec §5.2. */
  @Delete('options/:optionId/values/:valueId')
  async deactivateValue(
    @Param('productId') productId: string,
    @Param('optionId') optionId: string,
    @Param('valueId') valueId: string,
    @Req() req: any,
  ) {
    return this.variantsService.deactivateValue(
      productId,
      await this.storeIdFor(req),
      optionId,
      valueId,
    );
  }

  // --------------------------------------------------------- preview and create

  /**
   * Links product-gallery images to option values (one image → one value per product).
   *
   * The store comes from the session; the gallery is validated against the product itself, so a
   * seller cannot point a value at another store's image. Links are additive to the product's
   * normal gallery behaviour: `null` clears a link and restores the default.
   */
  @Patch('option-value-images')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async setOptionValueImages(
    @Param('productId') productId: string,
    @Body() dto: SetOptionValueImagesDto,
    @Req() req: any,
  ) {
    return this.variantsService.setOptionValueImages(
      productId,
      await this.storeIdFor(req),
      dto,
    );
  }

  /** Cartesian preview. Creates nothing. */
  @Post('variants/preview')
  async preview(
    @Param('productId') productId: string,
    @Body() dto: PreviewCombinationsDto,
    @Req() req: any,
  ) {
    return this.variantsService.previewCombinations(
      productId,
      await this.storeIdFor(req),
      dto,
    );
  }

  /** Creates variants for the submitted subset only. */
  @Post('variants')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async createVariants(
    @Param('productId') productId: string,
    @Body() dto: CreateVariantsDto,
    @Req() req: any,
  ) {
    return this.variantsService.createVariants(
      productId,
      await this.storeIdFor(req),
      dto,
      userIdOrNull(req.user?.id),
    );
  }

  /**
   * Generates barcodes and SKUs for the product's variants.
   *
   * Non-destructive unless `overwrite: true` is passed explicitly: a variant that already has a
   * code keeps it. The store — the barcode namespace — is resolved from the session, never the
   * body, so a seller cannot mint codes into another store's series (§9.4).
   */
  @Post('variants/generate-codes')
  @RequirePermissions(StorePermission.PRODUCTS_BARCODES_GENERATE)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async generateCodes(
    @Param('productId') productId: string,
    @Body() dto: GenerateCodesDto,
    @Req() req: any,
  ) {
    return this.barcodeService.generateCodes(productId, await this.storeIdFor(req), dto);
  }

  // -------------------------------------------------------------------- variants

  @Patch('variants/:variantId')
  async updateVariant(
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body() dto: UpdateVariantDto,
    @Req() req: any,
  ) {
    return this.variantsService.updateVariant(
      productId,
      await this.storeIdFor(req),
      variantId,
      dto,
    );
  }

  @Post('variants/:variantId/activate')
  async activate(
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Req() req: any,
  ) {
    return this.variantsService.activateVariant(productId, await this.storeIdFor(req), variantId);
  }

  /**
   * Deactivation is guarded: blocked while stock is reserved, and while stock is on hand the
   * caller must state explicitly what happens to the quantity (spec §5.2).
   */
  @Post('variants/:variantId/deactivate')
  async deactivate(
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body() dto: DeactivateVariantDto,
    @Req() req: any,
  ) {
    return this.variantsService.deactivateVariant(
      productId,
      await this.storeIdFor(req),
      variantId,
      dto,
      userIdOrNull(req.user?.id),
    );
  }

  private async storeIdFor(req: any): Promise<Types.ObjectId> {
    const store = await this.storesService.findByMemberIdOrThrow(req.user?.id);
    return store._id as Types.ObjectId;
  }
}

function userIdOrNull(raw?: string): Types.ObjectId | null {
  return raw && Types.ObjectId.isValid(raw) ? new Types.ObjectId(raw) : null;
}