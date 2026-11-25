/**
 * Legacy, denormalised store status.
 *
 * `status` is kept as a derived compatibility mirror of the two authoritative statuses
 * (`ownerStatus` + `adminStatus`). It is never accepted from a client and must not be used
 * to decide availability: use `evaluateStoreAvailability()` instead. Existing rows and
 * older clients still read it, so every status write keeps it in sync.
 */
export enum StoreStatus {
  ACTIVE = 'Active',
  PAUSED = 'Paused',
  CLOSED = 'Closed',
}

/** Whether the seller wants the store to operate. Owner-controlled. */
export enum StoreOwnerStatus {
  ENABLED = 'Enabled',
  DISABLED = 'Disabled',
}

/** Whether IMRAAAH allows the store on the platform. Admin-controlled. */
export enum StoreAdminStatus {
  ACTIVE = 'Active',
  SUSPENDED = 'Suspended',
}
