import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const OPTION_TYPES = ['text', 'color'] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

/**
 * The seller-facing labels. At least one must be present; the service enforces that
 * rather than the DTO, because the rule is "not all empty", not "one required".
 *
 * `key` and `value` are identity/derivable fields: the service derives them from the
 * names when omitted, so the UI never has to invent slugs.
 */
export class CreateOptionDto {
  @ApiPropertyOptional({
    description:
      'Machine key, slugified, derived from the English name when omitted. Identity - never shown to buyers, never renamed after creation.',
    example: 'size',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameFr?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  @ApiPropertyOptional({ enum: OPTION_TYPES, default: 'text' })
  @IsOptional()
  @IsIn(OPTION_TYPES)
  type?: OptionType;
}

/**
 * `key` is intentionally absent. The machine key is the option's identity for join rows
 * and previews; renaming a human label must never be able to change it (spec §5.2).
 */
export class UpdateOptionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameFr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  @ApiPropertyOptional({ enum: OPTION_TYPES })
  @IsOptional()
  @IsIn(OPTION_TYPES)
  type?: OptionType;
}

export class CreateOptionValueDto {
  @ApiPropertyOptional({
    description:
      'Canonical machine value, unique per option, derived from the English label when omitted. Identity - never renames after creation.',
    example: 'xl',
  })
  @IsOptional()
  @IsString()
  value?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  valueEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  valueAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  valueFr?: string;

  @ApiPropertyOptional({
    description:
      'Display-only hex colour, used as a swatch when the owning option type is `color`. The real value of the option is its multilingual text name.',
    example: '#FF0000',
  })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class UpdateOptionValueDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  valueEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  valueAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  valueFr?: string;

  @ApiPropertyOptional({
    description:
      'Empty string clears the swatch. Only meaningful when the owning option type is `color`.',
  })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  /**
   * Reactivation — the counterpart to the `DELETE` deactivation route.
   *
   * Setting `isActive: true` brings a retired value back and re-activates the variants
   * that were deactivated alongside it (stock is untouched). Setting `isActive: false`
   * takes the exact deactivation path (`DELETE`): blocked while stock is reserved, and
   * it also deactivates every non-deleted variant that uses the value. When present, this
   * field wins and any label changes in the same request are ignored — activation state
   * and label edits are deliberately not mixed.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** One row of the matrix preview the seller ticks. */
export class PreviewCombinationDto {
  @ApiProperty({ description: 'Combination key of the row, from preview', example: 'a1b2...' })
  @IsString()
  @IsNotEmpty()
  combinationKey: string;

  @ApiProperty({ description: 'The option values making up this row' })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  optionValueIds: string[];
}

export class PreviewCombinationsDto {
  @ApiPropertyOptional({
    description: 'Include deactivated values in the Cartesian product. Preview only.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  includeInactive?: boolean;
}

export class SelectedCombinationDto {
  @ApiProperty({ description: 'combinationKey returned by preview' })
  @IsString()
  @IsNotEmpty()
  combinationKey: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  optionValueIds: string[];

  @ApiPropertyOptional({ description: 'Must be unique within this store' })
  @IsOptional()
  @IsString()
  sku?: string;

  @ApiPropertyOptional({ description: 'Falls back to Product.price when omitted or null' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceOverride?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  compareAtPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  lowStockThreshold?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;
}

export class CreateVariantsDto {
  @ApiProperty({ type: [SelectedCombinationDto] })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => SelectedCombinationDto)
  selections: SelectedCombinationDto[];

  @ApiPropertyOptional({
    description: 'Reason recorded on every initial_stock movement. Defaults when omitted.',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class UpdateVariantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sku?: string;

  /**
   * EAN-13 barcode. The regex accepts either empty (which clears the barcode) or 13 digits;
   * the checksum itself is validated in the service (`isValidEan13`), because a mod-10 check is
   * not expressible as a class-validator rule.
   */
  @ApiPropertyOptional({
    description: 'EAN-13 barcode (13 digits). Empty string clears it.',
    example: '2000000000053',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(\d{13})?$/, { message: 'barcode must be a 13-digit EAN-13' })
  barcode?: string | null;

  @ApiPropertyOptional({ description: 'null clears the override and inherits Product.price' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceOverride?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  compareAtPrice?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  lowStockThreshold?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  position?: number;
}

export class DeactivateVariantDto {
  @ApiPropertyOptional({
    enum: ['keep', 'zero', 'stay_active'],
    description:
      'Required when the variant still holds stock: `keep` deactivates with the quantity intact, ' +
      '`zero` writes it off with a movement, `stay_active` aborts the request. ' +
      'Omitted is rejected while onHand > 0 so quantity is never discarded silently (spec §5.2).',
  })
  @IsOptional()
  @IsIn(['keep', 'zero', 'stay_active'])
  choice?: 'keep' | 'zero' | 'stay_active';

  @ApiPropertyOptional({ description: 'Reason, required when choice is `zero`' })
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * Bulk code generation for a product's variants.
 *
 * Both halves default to on, so an omitted body generates an EAN-13 and a SKU for every variant
 * that lacks one. `overwrite` is the only destructive switch and defaults to false — a seller who
 * has already printed and stuck labels must never lose them by clicking Generate.
 */
export class GenerateCodesDto {
  @ApiPropertyOptional({
    description: 'Limit generation to these variants. Omitted = every non-deleted variant.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  variantIds?: string[];

  @ApiPropertyOptional({ description: 'Generate SKUs for variants missing one (default true).' })
  @IsOptional()
  @IsBoolean()
  includeSku?: boolean;

  @ApiPropertyOptional({ description: 'Generate EAN-13 barcodes for variants missing one (default true).' })
  @IsOptional()
  @IsBoolean()
  includeBarcode?: boolean;

  @ApiPropertyOptional({ description: 'Replace codes that already exist (default false). Never silent.' })
  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;
}