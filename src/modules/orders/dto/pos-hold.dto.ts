import { CreatePosSaleDto } from './create-pos-sale.dto';

/**
 * Body of `POST /pos/holds` and `PATCH /pos/holds/:id`. A held sale is a *whole* cart, so an
 * update replaces its lines rather than patching one line; the inventory reservation is
 * reconciled against the new set of lines in the same transaction.
 *
 * It is the same contract as an immediate sale because a hold is simply a sale that has not
 * been completed yet: the server re-prices every line and reserves the stock at hold time.
 * `barcode`/`available` on the items are accepted for display and ignored for money/stock.
 */
export class CreatePosHoldDto extends CreatePosSaleDto {}

export class UpdatePosHoldDto extends CreatePosSaleDto {}
