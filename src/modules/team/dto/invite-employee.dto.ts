import { IsEmail, IsIn, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ASSIGNABLE_STORE_ROLES, StoreRole } from '../../../common/constants/store-roles.enum';
import { SUPPORTED_LOCALES } from '../../../common/constants/locales.const';
import type { AppLocale } from '../../../common/constants/locales.const';

/**
 * Invitation creation. Deliberately contains no `storeId`, `userId` or `permissions`:
 * ownership, actor and tenant all come from the session, and `forbidNonWhitelisted` rejects
 * any client attempt to supply them.
 */
export class InviteEmployeeDto {
  @ApiProperty({ example: 'employee@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ enum: ASSIGNABLE_STORE_ROLES, example: StoreRole.ORDER_CONFIRMER })
  @IsIn(ASSIGNABLE_STORE_ROLES)
  role: StoreRole;

  /** Language of the page the invitation was sent from; selects the email copy. */
  @ApiPropertyOptional({ enum: SUPPORTED_LOCALES, example: 'fr' })
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES)
  locale?: AppLocale;
}
