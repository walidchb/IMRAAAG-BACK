import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class BoxSelectionDto {
  @ApiProperty({ description: 'Eligible variant id' })
  @IsString()
  @IsNotEmpty()
  @IsMongoId()
  variantId: string;

  @ApiProperty({ description: 'Units of this variant inside one Box' })
  @IsInt()
  @Min(1)
  @Max(50)
  quantity: number;
}

/** Read-only selection validation for the storefront builder. Never writes. */
export class ValidateBoxSelectionDto {
  @ApiProperty({ description: 'Selected units (sum must equal requiredQuantity)', type: [BoxSelectionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BoxSelectionDto)
  selections: BoxSelectionDto[];
}
