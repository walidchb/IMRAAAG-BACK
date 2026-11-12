import { IsEmail, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ASSIGNABLE_STORE_ROLES, StoreRole } from '../../../common/constants/store-roles.enum';

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
}
