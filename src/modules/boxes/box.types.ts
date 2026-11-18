/**
 * Wire shapes for the Boxes API. These mirror the frontend types and are the only shapes
 * the controller returns — never a raw Box document on a public route (it carries
 * `vendorEmail`, `archivedBy` and other-store data).
 */

export interface BoxListItem {
  _id: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  nameFr: string;
  descriptionEn?: string;
  descriptionAr?: string;
  descriptionFr?: string;
  image?: string;
  price: number;
  requiredQuantity: number;
  allowDuplicates: boolean;
  published: boolean;
  isArchived: boolean;
  eligibleProductCount: number;
  eligibleVariantCount: number;
  availableBoxes: number;
  updatedAt: string;
  createdAt: string;
}

export interface BoxSummary {
  _id: string;
  storeId: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  nameFr: string;
  image?: string;
  price: number;
  requiredQuantity: number;
  /** Cheapest in-stock composition of `requiredQuantity` units; `null` if impossible. */
  bestReferenceTotal: number | null;
  availableBoxes: number;
  isAvailable: boolean;
  eligibleVariantCount: number;
}

export interface BoxPublicEligibleVariant {
  productId: string;
  productSlug: string;
  productNameEn: string;
  productNameAr: string;
  productNameFr: string;
  productImage?: string;
  variantId: string;
  variantLabel: string;
  optionValueIds: string[];
  sku?: string | null;
  unitPrice: number;
  compareAtPrice: number | null;
  available: number;
  isAvailable: boolean;
}

export interface BoxPublicDetail extends BoxSummary {
  storeName: string;
  storeSlug: string;
  descriptionEn?: string;
  descriptionAr?: string;
  descriptionFr?: string;
  images: string[];
  worstReferenceTotal: number | null;
  allowDuplicates: boolean;
  eligibleItems: BoxPublicEligibleVariant[];
}

export interface BoxVendorVariant {
  variantId: string;
  label: string;
  sku?: string | null;
  unitPrice: number;
  compareAtPrice: number | null;
  available: number;
  isActive: boolean;
  isDeleted: boolean;
  isAvailable: boolean;
}

export interface BoxVendorEligibleItem {
  productId: string;
  productNameEn: string;
  productNameAr: string;
  productNameFr: string;
  productImage?: string;
  productPublished: boolean;
  productArchived: boolean;
  variants: BoxVendorVariant[];
}

export interface BoxPublishIssue {
  code: string;
  productId?: string;
  variantId?: string;
}

export interface BoxVendorDetail extends BoxListItem {
  images: string[];
  bestReferenceTotal: number | null;
  worstReferenceTotal: number | null;
  eligibleItems: BoxVendorEligibleItem[];
  publishIssues: BoxPublishIssue[];
}

export interface BoxSelection {
  variantId: string;
  quantity: number;
}

export interface BoxSelectionValidation {
  valid: boolean;
  requiredQuantity: number;
  selectedQuantity: number;
  boxPrice: number;
  referenceTotal: number;
  savings: number;
  availableBoxes: number;
  issues: string[];
}

/** Cart/checkout quote codes for a Box line (mirrored by `CartLineIssueCode`). */
export type BoxCartIssueCode =
  | 'BOX_UNAVAILABLE'
  | 'BOX_INACTIVE'
  | 'BOX_ARCHIVED'
  | 'BOX_NOT_FOUND'
  | 'BOX_STORE_MISMATCH'
  | 'BOX_SELECTION_INVALID'
  | 'BOX_SELECTION_UNAVAILABLE'
  | 'BOX_PRICE_CHANGED';

export interface BoxCartSelectionQuote {
  productId: string;
  variantId: string;
  productName: string;
  variantLabel: string;
  image: string | null;
  quantity: number;
  referenceUnitPrice: number;
  available: number;
}

export interface BoxCartLineQuote {
  lineKey: string;
  bundleId: string;
  bundleSlug: string;
  bundleName: string;
  image?: string;
  price: number;
  requiredQuantity: number;
  quantity: number;
  lineTotal: number;
  availableBoxes: number;
  isAvailable: boolean;
  issues: BoxCartIssueCode[];
  selections: BoxCartSelectionQuote[];
  referenceTotal: number;
  savings: number;
}

/** The full resolution the OrdersService needs for quote and strict create. */
export interface ResolvedCartBundles {
  bundleLines: BoxCartLineQuote[];
  /** Flat physical order lines (one variant each) with `bundleGroupId`. */
  componentLines: Array<Record<string, any>>;
  /** Immutable `Order.bundles[]` snapshots. */
  bundleSnapshots: Array<Record<string, any>>;
  bundlesTotal: number;
}

