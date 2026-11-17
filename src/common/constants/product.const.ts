/**
 * Matches products that have not been archived.
 *
 * Uses `$ne: true` rather than `false` so legacy documents without the `isArchived` field
 * (created before archiving existed) are treated as active.
 */
export const NOT_ARCHIVED_PRODUCT_FILTER = { isArchived: { $ne: true } } as const;
