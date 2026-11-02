import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsInt,
  ValidateNested,
  IsArray,
  IsIn,
  Min,
  ArrayMinSize,
  Matches,
  IsMongoId,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ORDER_STATUS_VALUES } from '../../../common/constants/order-statuses.const';
import { ALGERIAN_PHONE_REGEX, ALGERIAN_PHONE_MESSAGE } from '../../../common/constants/regex.const';

class OrderItemDto {
  @ApiPropertyOptional({ description: 'Product ID' })
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiProperty({ description: 'Product name' })
  @IsString()
  @IsNotEmpty()
  productName: string;

  @ApiProperty({ description: 'Quantity', minimum: 1 })
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiProperty({ description: 'Price per unit' })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiPropertyOptional({ description: 'Variant details' })
  @IsOptional()
  @IsString()
  variantDetails?: string;

  /**
   * The variant actually bought. The reservation, the ledger, and the whole per-variant
   * stock model key off this id, and every product is a variant product - so a line
   * without one could never be reserved or fulfilled against anything. Required since the
   * universal-variant change; `productId` remains optional because a variant id alone
   * already identifies the item unambiguously.
   */
  @ApiProperty({ description: 'Ordered variant id (required on every line)' })
  @IsString()
  @IsNotEmpty()
  @IsMongoId()
  variantId: string;

  @ApiPropertyOptional({ description: 'Item weight in kg' })
  @IsOptional()
  @IsNumber()
  weight?: number;
}

class CustomerDto {
  @ApiProperty({ description: 'Customer name' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'Phone number' })
  @IsString()
  @IsNotEmpty()
  @Matches(ALGERIAN_PHONE_REGEX, { message: ALGERIAN_PHONE_MESSAGE })
  phone: string;

  @ApiPropertyOptional({ description: 'Email' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ description: 'Wilaya ID' })
  @IsString()
  @IsNotEmpty()
  wilaya: string;

  @ApiProperty({ description: 'Commune ID' })
  @IsString()
  @IsNotEmpty()
  commune: string;

  @ApiPropertyOptional({ description: 'Delivery address' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ description: 'Customer note' })
  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateOrderDto {
  @ApiPropertyOptional({ description: 'Legacy vendor email. Prefer storeId.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  vendorEmail?: string;

  @ApiPropertyOptional({ description: 'Preferred. Stable store identifier.' })
  @IsOptional()
  @IsString()
  @IsMongoId()
  storeId?: string;

  @ApiPropertyOptional({ description: 'Order date' })
  @IsOptional()
  @IsString()
  date?: string;

  @ApiPropertyOptional({ description: 'Created at timestamp' })
  @IsOptional()
  @IsString()
  createdAt?: string;

  @ApiPropertyOptional({ description: 'Created by' })
  @IsOptional()
  @IsString()
  createdBy?: string;

  @ApiPropertyOptional({ description: 'Confirmed at timestamp' })
  @IsOptional()
  @IsString()
  confirmedAt?: string;

  @ApiPropertyOptional({ description: 'Confirmed by' })
  @IsOptional()
  @IsString()
  confirmedBy?: string;

  @ApiPropertyOptional({ description: 'Dispatched at timestamp' })
  @IsOptional()
  @IsString()
  dispatchedAt?: string;

  @ApiPropertyOptional({ description: 'Status confirmation' })
  @IsOptional()
  @IsString()
  statusConfirmation?: string;

  @ApiProperty({ enum: ['stopdesk', 'home', 'pickup'], description: 'Shipping method' })
  @IsString()
  @IsNotEmpty()
  @IsIn(['stopdesk', 'home', 'pickup'])
  shippingMethod: string;

  @ApiPropertyOptional({ description: 'Bureau / branch' })
  @IsOptional()
  @IsString()
  bureau?: string;

  @ApiPropertyOptional({ description: 'Shipping fee' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  shippingFee?: number;

  @ApiProperty({ description: 'Customer details' })
  @ValidateNested()
  @Type(() => CustomerDto)
  customer: CustomerDto;

  @ApiProperty({ description: 'Order items', type: [OrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ApiProperty({ description: 'Total amount' })
  @IsNumber()
  @Min(0)
  total: number;

  @ApiPropertyOptional({ description: 'Order status', enum: ORDER_STATUS_VALUES })
  @IsOptional()
  @IsString()
  @IsIn(ORDER_STATUS_VALUES)
  status?: string;

  @ApiPropertyOptional({ default: 'COD', enum: ['COD', 'CASH'], description: "'COD' for delivery, 'CASH' for in-store/POS" })
  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @ApiPropertyOptional({ description: 'Delivery company ID (auto-resolved if omitted)' })
  @IsOptional()
  @IsString()
  deliveryCompanyId?: string;

  @ApiPropertyOptional({ description: 'Stop desk / pickup point code' })
  @IsOptional()
  @IsString()
  stopDeskCode?: string;
}
