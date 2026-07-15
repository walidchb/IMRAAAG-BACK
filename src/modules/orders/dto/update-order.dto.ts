import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  Min,
  ValidateNested,
  IsArray,
  IsNotEmpty,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

class UpdateOrderItemDto {
  @ApiPropertyOptional() @IsOptional() @IsString()
  productId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  productName?: string;

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(1)
  quantity?: number;

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0)
  price?: number;

  @ApiPropertyOptional() @IsOptional() @IsString()
  variantDetails?: string;

  @ApiPropertyOptional() @IsOptional() @IsNumber()
  weight?: number;
}

class UpdateCustomerDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty()
  phone?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  email?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty()
  wilaya?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty()
  commune?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  address?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  note?: string;
}

export class UpdateOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsString()
  vendorEmail?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  date?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  createdAt?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  createdBy?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  confirmedAt?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  confirmedBy?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  dispatchedAt?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  statusConfirmation?: string;

  @ApiPropertyOptional({ enum: ['stopdesk', 'home'] }) @IsOptional() @IsString() @IsIn(['stopdesk', 'home'])
  shippingMethod?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  bureau?: string;

  @ApiPropertyOptional() @IsOptional() @IsNumber()
  shippingFee?: number;

  @ApiPropertyOptional() @IsOptional() @ValidateNested() @Type(() => UpdateCustomerDto)
  customer?: UpdateCustomerDto;

  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => UpdateOrderItemDto)
  items?: UpdateOrderItemDto[];

  @ApiPropertyOptional({ type: [Object], description: 'Status history entries' })
  @IsOptional()
  @IsArray()
  history?: Array<{ status: string; date: string; user: string }>;

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0)
  total?: number;

  @ApiPropertyOptional({ description: 'Status ID (MongoDB ObjectId)' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  paymentMethod?: string;

  @ApiPropertyOptional({ description: 'Delivery company ID' })
  @IsOptional()
  @IsString()
  deliveryCompanyId?: string;

  @ApiPropertyOptional({ description: 'Stop desk / pickup point code' })
  @IsOptional()
  @IsString()
  stopDeskCode?: string;
}
