import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AdminStatus } from '../../../common/constants/admin-status.enum';

export class UpdateAdminStatusDto {
  @ApiProperty({ enum: [AdminStatus.ACTIVE, AdminStatus.DISABLED] })
  @IsIn([AdminStatus.ACTIVE, AdminStatus.DISABLED])
  status: AdminStatus;
}
