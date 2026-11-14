import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ALGERIAN_PHONE_REGEX, ALGERIAN_PHONE_MESSAGE } from '../../../common/constants/regex.const';

/**
 * One cart line. The client only names *what* it wants and *how many*; price, name, image,
 * shipping and totals are resolved server-side. `forbidNonWhitelisted` is global, so sending a
 * price/name/productId/total here is a 400 — exactly the guarantee the cart contract needs.
 */
export class CartItemDto {
  @ApiProperty({ description: 'Variant id' })
  @IsString()
  @IsNotEmpty()
  @IsMongoId()
  variantId: string;

  @ApiProperty({ description: 'Quantity', minimum: 1, maximum: 99 })
  @IsInt()
  @Min(1)
  @Max(99)
  quantity: number;
}

/** Ground truth for a cart: one store, many variant lines. */
export class CartValidationDto {
  @ApiProperty({ description: 'Store id' })
  @IsString()
  @IsNotEmpty()
  @IsMongoId()
  storeId: string;

  @ApiPropertyOptional({ enum: ['en', 'ar', 'fr'], description: 'Display locale for names/labels' })
  @IsOptional()
  @IsIn(['en', 'ar', 'fr'])
  locale?: 'en' | 'ar' | 'fr';

  @ApiProperty({ description: 'Cart lines', type: [CartItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];
}

export class CartCustomerDto {
  @ApiProperty({ description: 'Customer name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ description: 'Phone number' })
  @IsString()
  @IsNotEmpty()
  @Matches(ALGERIAN_PHONE_REGEX, { message: ALGERIAN_PHONE_MESSAGE })
  phone: string;

  @ApiPropertyOptional({ description: 'Email' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @ApiProperty({ description: 'Wilaya code' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  wilaya: string;

  @ApiProperty({ description: 'Commune id' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  commune: string;

  @ApiPropertyOptional({ description: 'Delivery address (required for home delivery)' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ description: 'Customer note' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Strict cart order creation. Client-supplied price/name/total/source are never accepted. */
export class CreateCartOrderDto {
  @ApiProperty({ description: 'Store id' })
  @IsString()
  @IsNotEmpty()
  @IsMongoId()
  storeId: string;

  @ApiProperty({ description: 'Client-generated idempotency key (8–64 url-safe chars)' })
  @IsString()
  @Length(8, 64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  idempotencyKey: string;

  @ApiPropertyOptional({ enum: ['en', 'ar', 'fr'], description: 'Display locale for names/labels' })
  @IsOptional()
  @IsIn(['en', 'ar', 'fr'])
  locale?: 'en' | 'ar' | 'fr';

  @ApiProperty({ description: 'Cart lines', type: [CartItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];

  @ApiProperty({ description: 'Customer details', type: CartCustomerDto })
  @ValidateNested()
  @Type(() => CartCustomerDto)
  customer: CartCustomerDto;

  @ApiProperty({ enum: ['home', 'stopdesk'], description: 'Shipping method' })
  @IsIn(['home', 'stopdesk'])
  shippingMethod: 'home' | 'stopdesk';

  @ApiPropertyOptional({ description: 'Stop desk / pickup point code' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  stopDeskCode?: string;

  @ApiPropertyOptional({ enum: ['COD'], description: 'Forced to COD server-side' })
  @IsOptional()
  @IsIn(['COD'])
  paymentMethod?: 'COD';
}
