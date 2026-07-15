import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  ValidateNested,
  IsArray,
  IsIn,
  Min,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
  @IsNumber()
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
  @ApiProperty({ description: 'Vendor email' })
  @IsString()
  @IsNotEmpty()
  vendorEmail: string;

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

  @ApiProperty({ enum: ['stopdesk', 'home'], description: 'Shipping method' })
  @IsString()
  @IsNotEmpty()
  @IsIn(['stopdesk', 'home'])
  shippingMethod: string;

  @ApiPropertyOptional({ description: 'Bureau / branch' })
  @IsOptional()
  @IsString()
  bureau?: string;

  @ApiPropertyOptional({ description: 'Shipping fee' })
  @IsOptional()
  @IsNumber()
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

  @ApiPropertyOptional({ description: 'Status ID (MongoDB ObjectId)' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ default: 'COD' })
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
