import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ASSIGNABLE_STORE_ROLES,
  StoreMemberStatus,
  StoreRole,
} from '../../../common/constants/store-roles.enum';

/**
 * Change an employee's role and/or status. `OWNER` is intentionally not assignable, and the
 * target member is always scoped to the session store (never a client-supplied id).
 */
export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: ASSIGNABLE_STORE_ROLES })
  @IsOptional()
  @IsIn(ASSIGNABLE_STORE_ROLES)
  role?: StoreRole;

  @ApiPropertyOptional({ enum: [StoreMemberStatus.ACTIVE, StoreMemberStatus.DEACTIVATED] })
  @IsOptional()
  @IsIn([StoreMemberStatus.ACTIVE, StoreMemberStatus.DEACTIVATED])
  status?: StoreMemberStatus;
}
