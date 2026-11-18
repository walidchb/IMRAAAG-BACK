import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PosCartDto } from './create-pos-sale.dto';

/**
 * The two kinds of parked-sale note. `payment` is the "versement" case: the customer left a
 * deposit or prepaid part of the amount, so the note explains what the money is for.
 */
export const POS_HOLD_NOTE_TYPES = ['general', 'payment'] as const;
export type PosHoldNoteType = (typeof POS_HOLD_NOTE_TYPES)[number];

/**
 * Body of `POST /pos/holds` and `PATCH /pos/holds/:id`. A held sale is a *whole* cart, so an
 * update replaces its lines rather than patching one line; the inventory reservation is
 * reconciled against the new set of lines in the same transaction.
 *
 * It is the same cart contract as an immediate sale because a hold is simply a sale that has
 * not been completed yet: the server re-prices every line and reserves the stock at hold time.
 * `barcode`/`available` on the items are accepted for display and ignored for money/stock.
 *
 * Deliberately extends `PosCartDto`, not `CreatePosSaleDto`: a custom final price is a
 * checkout-stage decision and is not stored on a hold, so a stray `customFinalPrice` is
 * rejected by the whitelist pipe.
 */
export class CreatePosHoldDto extends PosCartDto {
  /** Short note heading, rendered as `title (type)` in the held-sales list. */
  @ApiPropertyOptional({ description: 'Short note title', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  noteTitle?: string;

  /** `payment` = "versement" (deposit/part payment); `general` = any other note. */
  @ApiPropertyOptional({ description: 'Note kind', enum: POS_HOLD_NOTE_TYPES })
  @IsOptional()
  @IsIn(POS_HOLD_NOTE_TYPES)
  noteType?: PosHoldNoteType;
}

export class UpdatePosHoldDto extends CreatePosHoldDto {}
