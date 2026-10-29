import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsMongoId,
} from 'class-validator';
import {
  ORDER_LABEL_FORMATS,
  ORDER_LABEL_GROUPINGS,
} from '../order-labels.constants';
import type {
  OrderLabelFormat,
  OrderLabelGrouping,
} from '../../delivery/delivery-companies/interfaces/delivery-company-handler.interface';

export class GenerateOrderLabelsDto {
  @ApiProperty({
    type: [String],
    description: 'Order ids. The store is always resolved from the session.',
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  ids: string[];

  @ApiProperty({ enum: ORDER_LABEL_FORMATS })
  @IsIn(ORDER_LABEL_FORMATS)
  format: OrderLabelFormat;

  @ApiProperty({ enum: ORDER_LABEL_GROUPINGS })
  @IsIn(ORDER_LABEL_GROUPINGS)
  grouping: OrderLabelGrouping;
}
