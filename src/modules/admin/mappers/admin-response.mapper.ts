import { AdminStatus } from '../../../common/constants/admin-status.enum';

export interface AdminResponseDto {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  status: AdminStatus;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
}

type AdminLike = {
  _id?: unknown;
  id?: unknown;
  firstName?: string;
  lastName?: string;
  email?: string;
  status?: AdminStatus;
  lastLoginAt?: Date | null;
  passwordChangedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  disabledAt?: Date | null;
};

/** Whitelisted projection: secrets (`passwordHash`, refresh hash/expiry, tokenVersion) never leave. */
export function toAdminResponse(admin: AdminLike): AdminResponseDto {
  const firstName = admin.firstName ?? '';
  const lastName = admin.lastName ?? '';
  return {
    id: String(admin._id ?? admin.id ?? ''),
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    email: admin.email ?? '',
    status: admin.status ?? AdminStatus.ACTIVE,
    lastLoginAt: admin.lastLoginAt ?? null,
    passwordChangedAt: admin.passwordChangedAt ?? null,
    createdAt: admin.createdAt ?? new Date(0),
    updatedAt: admin.updatedAt ?? admin.createdAt ?? new Date(0),
    disabledAt: admin.disabledAt ?? null,
  };
}
