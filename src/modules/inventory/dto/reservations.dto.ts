import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const RETURN_DISPOSITIONS = ['restock', 'write_off'] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

export class ReceiveReturnLineDto {
  /**
   * Index of the line within `Order.items[]`.
   *
   * An index rather than a `variantId`, because a return answers a line of *this* order: the
   * same variant can legitimately appear on two lines with different quantities, and only
   * the line knows which receipt it refers to.
   */
  @ApiProperty({ description: 'Index of the order line being received' })
  @IsInt()
  @Min(0)
  orderItemIndex: number;

  @ApiPropertyOptional({
    description: 'Units received. Defaults to the full quantity that was dispatched.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  /**
   * `restock` puts the units back into on-hand stock. `write_off` records them as damaged and
   * leaves on-hand alone - damaged goods must not become sellable again (spec §7.1 rule 7),
   * which is why this is the seller's choice rather than a default.
   */
  @ApiProperty({ enum: RETURN_DISPOSITIONS })
  @IsIn(RETURN_DISPOSITIONS)
  disposition: ReturnDisposition;
}

export class ReceiveReturnDto {
  @ApiProperty({ type: [ReceiveReturnLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiveReturnLineDto)
  items: ReceiveReturnLineDto[];

  @ApiPropertyOptional({ description: 'Optional note recorded against the movement' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * Moves the order to `returned` in the same request.
   *
   * Off by default: receiving goods back is a physical fact, while changing the order's
   * status is a commercial decision (it implies the customer kept it), and conflating the two
   * would make a returned-but-kept parcel look like a refund.
   */
  @ApiPropertyOptional({ description: 'Also transition the order to returned' })
  @IsOptional()
  @IsBoolean()
  markOrderReturned?: boolean;
}