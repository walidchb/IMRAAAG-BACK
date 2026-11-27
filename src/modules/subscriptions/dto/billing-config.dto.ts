import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const SUPPORTED = [1, 3, 6, 12];

export class UpdateBillingConfigDto {
  @ApiProperty({
    type: [Number],
    enum: SUPPORTED,
    description:
      'Globally enabled monthly durations. Only 1/3/6/12 are accepted; 1 is always enabled.',
  })
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsIn(SUPPORTED, { each: true })
  enabledDurations: number[];
}
