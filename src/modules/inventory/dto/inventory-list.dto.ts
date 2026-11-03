import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { INVENTORY_MOVEMENT_TYPES } from '../schemas/inventory-movement.schema';
// Type-only: `InventoryMovementType` is referenced in a decorated signature, and under
// `isolatedModules` + `emitDecoratorMetadata` a value import of it cannot be emitted.
import type { InventoryMovementType } from '../schemas/inventory-movement.schema';

export const INVENTORY_LIST_STATUSES = [
  'all',
  'active',
  'inactive',
  'low',
  'out',
  'in_stock',
] as const;
export type InventoryListStatus = (typeof INVENTORY_LIST_STATUSES)[number];

/** Locales a seller-facing variant label can be rendered in. */
export const INVENTORY_LABEL_LOCALES = ['en', 'fr', 'ar'] as const;

/**
 * Query for the store-wide inventory list (spec §10.2).
 *
 * `page`/`limit` rather than a cursor: this view is a management grid that sellers page
 * through and jump around in, so stable page numbers matter more than infinite scroll.
 * The movement ledger below is the opposite and is cursor-paginated.
 */
export class ListInventoryQueryDto {
  @ApiPropertyOptional({ description: 'Matches product name in any language, or a SKU' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ description: 'Restrict to one product' })
  @IsOptional()
  @IsMongoId()
  productId?: string;

  @ApiPropertyOptional({ enum: INVENTORY_LIST_STATUSES, default: 'all' })
  @IsOptional()
  @IsIn(INVENTORY_LIST_STATUSES)
  status?: InventoryListStatus;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ enum: INVENTORY_LABEL_LOCALES, description: 'Locale for the variant label' })
  @IsOptional()
  @IsIn(INVENTORY_LABEL_LOCALES)
  locale?: string;
}

/** Locale for a seller-facing read that composes variant labels. */
export class LocaleQueryDto {
  @ApiPropertyOptional({ enum: INVENTORY_LABEL_LOCALES, description: 'Locale for the variant label' })
  @IsOptional()
  @IsIn(INVENTORY_LABEL_LOCALES)
  locale?: string;
}

/**
 * Query for the store-wide ledger (spec §10.4).
 *
 * `productId` is resolved to that product's variant ids before the read rather than being
 * joined per row: a movement does not carry a product id, and the join index would not be
 * store-scoped anyway.
 */
export class ListStoreMovementsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  variantId?: string;

  @ApiPropertyOptional({ enum: INVENTORY_MOVEMENT_TYPES })
  @IsOptional()
  @IsIn(INVENTORY_MOVEMENT_TYPES)
  type?: InventoryMovementType;

  @ApiPropertyOptional({ description: 'ISO date, inclusive lower bound' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date, exclusive upper bound' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ description: 'Free text over reason and note' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Movement id to page backwards from' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ enum: INVENTORY_LABEL_LOCALES, description: 'Locale for the variant label' })
  @IsOptional()
  @IsIn(INVENTORY_LABEL_LOCALES)
  locale?: string;
}

/**
 * Sets the low-stock threshold for a variant override or a product default (spec §6.3).
 *
 * Exactly one target is required. `null` clears the override so the level below it applies
 * again, which is the only way to undo one without guessing what it used to be.
 */
export class SetThresholdDto {
  @ApiPropertyOptional({ description: 'Variant whose override is being set' })
  @IsOptional()
  @IsMongoId()
  variantId?: string;

  @ApiPropertyOptional({ description: 'Product whose default is being set' })
  @IsOptional()
  @IsMongoId()
  productId?: string;

  @ApiPropertyOptional({
    description: 'Units of availability at or below which the variant is low. Null clears the override.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  threshold?: number | null;

  @ApiPropertyOptional({ description: 'Must accompany an explicit null threshold' })
  @IsOptional()
  @IsBoolean()
  clear?: boolean;
}