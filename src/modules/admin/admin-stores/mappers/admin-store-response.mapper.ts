import {
  StoreAdminStatus,
  StoreOwnerStatus,
  StoreStatus,
} from '../../../stores/schemas/store-status.enum';
import { evaluateStoreAvailability } from '../../../stores/store-availability';

export interface AdminStoreOwnerDto {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string | null;
  role: string;
  isActive: boolean;
  createdAt: Date | null;
  lastLogin: Date | null;
}

export interface AdminStoreListItemDto {
  id: string;
  storeName: string;
  storeSlug: string;
  subdomain: string | null;
  vendorEmail: string;
  /** Legacy mirror kept for older clients; use the two statuses below. */
  status: StoreStatus;
  ownerStatus: StoreOwnerStatus;
  adminStatus: StoreAdminStatus;
  isAvailable: boolean;
  wilaya: string | null;
  commune: string | null;
  owner: AdminStoreOwnerDto | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminStoreDetailDto {
  id: string;
  storeName: string;
  storeSlug: string;
  subdomain: string | null;
  vendorEmail: string;
  description: string | null;
  storeLogo: string | null;
  coverImage: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPhones: string[];
  wilaya: string | null;
  commune: string | null;
  streetAddress: string | null;
  googleMapsUrl: string | null;
  categories: string[];
  tagline: string | null;
  socialMedia: Record<string, string>;
  status: StoreStatus;
  ownerStatus: StoreOwnerStatus;
  adminStatus: StoreAdminStatus;
  isAvailable: boolean;
  adminStatusReason: string | null;
  adminStatusChangedAt: Date | null;
  adminStatusChangedBy: string | null;
  adminStatusChangedByEmail: string | null;
  inventoryEnabled: boolean;
  totalProducts: number;
  totalOrders: number;
  address: Record<string, string> | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A lean `users` document; only safe, whitelisted fields are read from it. */
export interface AdminStoreOwnerSource {
  _id?: unknown;
  id?: unknown;
  fullName?: string;
  email?: string;
  phoneNumber?: string | null;
  role?: string;
  isActive?: boolean;
  createdAt?: Date | null;
  lastLogin?: Date | null;
}

/** A lean `stores` document. `vendorId`, `barcodeSeq` etc. are deliberately not mapped. */
export interface AdminStoreSource {
  _id?: unknown;
  id?: unknown;
  storeName?: string;
  storeSlug?: string;
  subdomain?: string | null;
  vendorEmail?: string;
  description?: string | null;
  storeLogo?: string | null;
  coverImage?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  contactPhones?: string[] | null;
  wilaya?: string | null;
  commune?: string | null;
  streetAddress?: string | null;
  googleMapsUrl?: string | null;
  categories?: string[] | null;
  tagline?: string | null;
  socialMedia?: Record<string, string> | null;
  status?: StoreStatus;
  ownerStatus?: StoreOwnerStatus;
  adminStatus?: StoreAdminStatus;
  adminStatusReason?: string | null;
  adminStatusChangedAt?: Date | null;
  adminStatusChangedBy?: unknown;
  adminStatusChangedByEmail?: string | null;
  inventoryEnabled?: boolean;
  totalProducts?: number;
  totalOrders?: number;
  address?: Record<string, string> | null;
  createdAt?: Date;
  updatedAt?: Date;
}

function text(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Whitelisted owner projection. Never returns password, refresh tokens or seller secrets. */
export function toAdminStoreOwner(
  user: AdminStoreOwnerSource | null | undefined,
): AdminStoreOwnerDto | null {
  if (!user) return null;
  return {
    id: String(user._id ?? user.id ?? ''),
    fullName: user.fullName ?? '',
    email: user.email ?? '',
    phoneNumber: text(user.phoneNumber),
    role: user.role ?? 'CUSTOMER',
    isActive: user.isActive ?? true,
    createdAt: user.createdAt ?? null,
    lastLogin: user.lastLogin ?? null,
  };
}

function statusFields(store: AdminStoreSource) {
  const availability = evaluateStoreAvailability(store);
  return {
    status: store.status ?? StoreStatus.ACTIVE,
    ownerStatus: availability.ownerStatus,
    adminStatus: availability.adminStatus,
    isAvailable: availability.available,
  };
}

export function toAdminStoreListItem(
  store: AdminStoreSource,
  owner: AdminStoreOwnerDto | null,
): AdminStoreListItemDto {
  return {
    id: String(store._id ?? store.id ?? ''),
    storeName: store.storeName ?? '',
    storeSlug: store.storeSlug ?? '',
    subdomain: text(store.subdomain),
    vendorEmail: store.vendorEmail ?? '',
    ...statusFields(store),
    wilaya: text(store.wilaya),
    commune: text(store.commune),
    owner,
    createdAt: store.createdAt ?? new Date(0),
    updatedAt: store.updatedAt ?? store.createdAt ?? new Date(0),
  };
}

/** Whitelisted detail projection. `barcodeSeq`, `vendorId` and owner secrets never leave. */
export function toAdminStoreDetail(store: AdminStoreSource): AdminStoreDetailDto {
  return {
    id: String(store._id ?? store.id ?? ''),
    storeName: store.storeName ?? '',
    storeSlug: store.storeSlug ?? '',
    subdomain: text(store.subdomain),
    vendorEmail: store.vendorEmail ?? '',
    description: text(store.description),
    storeLogo: text(store.storeLogo),
    coverImage: text(store.coverImage),
    contactEmail: text(store.contactEmail),
    contactPhone: text(store.contactPhone),
    contactPhones: Array.isArray(store.contactPhones)
      ? store.contactPhones.filter((value): value is string => typeof value === 'string')
      : [],
    wilaya: text(store.wilaya),
    commune: text(store.commune),
    streetAddress: text(store.streetAddress),
    googleMapsUrl: text(store.googleMapsUrl),
    categories: Array.isArray(store.categories)
      ? store.categories.filter((value): value is string => typeof value === 'string')
      : [],
    tagline: text(store.tagline),
    socialMedia:
      store.socialMedia && typeof store.socialMedia === 'object' ? store.socialMedia : {},
    ...statusFields(store),
    adminStatusReason: text(store.adminStatusReason),
    adminStatusChangedAt: store.adminStatusChangedAt ?? null,
    adminStatusChangedBy: store.adminStatusChangedBy
      ? String(store.adminStatusChangedBy)
      : null,
    adminStatusChangedByEmail: text(store.adminStatusChangedByEmail),
    inventoryEnabled: store.inventoryEnabled ?? false,
    totalProducts: store.totalProducts ?? 0,
    totalOrders: store.totalOrders ?? 0,
    address: store.address && typeof store.address === 'object' ? store.address : null,
    createdAt: store.createdAt ?? new Date(0),
    updatedAt: store.updatedAt ?? store.createdAt ?? new Date(0),
  };
}
