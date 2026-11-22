import {
  Allow,
  IsString,
  IsOptional,
  IsNumber,
  IsInt,
  IsIn,
  Min,
  ValidateNested,
  ValidateIf,
  IsArray,
  IsNotEmpty,
  ArrayMinSize,
  Matches,
  IsMongoId,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ORDER_STATUS_VALUES } from '../../../common/constants/order-statuses.const';
import { ALGERIAN_PHONE_REGEX, ALGERIAN_PHONE_MESSAGE } from '../../../common/constants/regex.const';

class UpdateOrderItemDto {
  @ApiPropertyOptional() @Allow()
  _id?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  productId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  productName?: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1)
  quantity?: number;

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0)
  price?: number;

  @ApiPropertyOptional() @IsOptional() @IsString()
  variantDetails?: string;

  /** Phase 4 (roadmap 4.6) - see `CreateOrderDto`'s item DTO. */
  @ApiPropertyOptional() @IsOptional() @IsString() @IsMongoId()
  variantId?: string;

  @ApiPropertyOptional() @IsOptional() @IsNumber()
  weight?: number;

  /** Immutable snapshot fields echoed back from the order document. Idempotent — never
   *  used by `update()`, but the storefront sends the full mapped order, so they must
   *  survive whitelist validation. */
  @ApiPropertyOptional() @Allow()
  lineId?: string;

  @ApiPropertyOptional() @Allow()
  sku?: string;

  @ApiPropertyOptional() @Allow()
  variantSnapshot?: unknown;

  @ApiPropertyOptional() @Allow()
  image?: string;
}

class UpdateCustomerDto {
  @ApiPropertyOptional() @Allow()
  _id?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @Matches(ALGERIAN_PHONE_REGEX, { message: ALGERIAN_PHONE_MESSAGE })
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

export class DhdCommuneDto {
  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @Matches(/^\d{1,2}$/)
  wilayaId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  postalCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasStopDesk?: boolean;
}

/**
 * A Noest Express commune selection. Noest identifies communes by `{ nom, wilaya_id }` and
 * publishes no stop-desk capability, so there is no `hasStopDesk` field. `selectedAt`/`selectedBy`
 * are server-stamped and are deliberately not accepted here.
 */
export class NoestCommuneDto {
  @ApiPropertyOptional({ example: 'Batna' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: '5' })
  @IsString()
  @Matches(/^\d{1,2}$/)
  wilayaId: string;

  @ApiPropertyOptional({ example: '05001', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  postalCode?: string | null;
}

export class UpdateOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsString()
  vendorEmail?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  date?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  createdAt?: string;

  /**
   * @deprecated Accepted for backwards compatibility only. Attribution is resolved from the
   * authenticated session — the acting team member — never from the request body. A dashboard
   * echoes the stored order verbatim, so trusting this field credited the wrong person.
   */
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

  // `pickup` is the in-store/POS channel. Without it, editing (or returning) a POS order
  // fails validation on the channel it was created with.
  @ApiPropertyOptional({ enum: ['stopdesk', 'home', 'pickup'] }) @IsOptional() @IsString() @IsIn(['stopdesk', 'home', 'pickup'])
  shippingMethod?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  bureau?: string;

  @ApiPropertyOptional() @IsOptional() @IsNumber()
  shippingFee?: number;

  // A `pickup` (in-store/POS) sale may be anonymous, so its customer contact fields are
  // intentionally empty. Mirror the order schema's pickup exemption here: the nested
  // `UpdateCustomerDto` requires name/phone/wilaya/commune whenever it validates, and a POS
  // edit sends all four (empty ones included), which would otherwise 400.
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((o: UpdateOrderDto) => o.shippingMethod !== 'pickup')
  @ValidateNested()
  @Type(() => UpdateCustomerDto)
  customer?: UpdateCustomerDto;

  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => UpdateOrderItemDto)
  items?: UpdateOrderItemDto[];

  @ApiPropertyOptional({ type: [Object], description: 'Status history entries' })
  @IsOptional()
  @IsArray()
  history?: Array<{ status: string; date: string; user: string }>;

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0)
  total?: number;

  @ApiPropertyOptional({ description: 'Order status', enum: ORDER_STATUS_VALUES })
  @IsOptional()
  @IsString()
  @IsIn(ORDER_STATUS_VALUES)
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

  @ApiPropertyOptional({ type: () => DhdCommuneDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => DhdCommuneDto)
  dhdCommune?: DhdCommuneDto | null;

  @ApiPropertyOptional({ type: () => NoestCommuneDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => NoestCommuneDto)
  noestCommune?: NoestCommuneDto | null;

  @ApiPropertyOptional({ description: 'Expected updatedAt timestamp for conflict detection' })
  @IsOptional()
  @IsString()
  expectedUpdatedAt?: string;
}
