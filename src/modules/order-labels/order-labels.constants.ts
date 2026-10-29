import { OrderStatus } from '../../common/constants/order-statuses.const';
import type {
  OrderLabelFormat,
  OrderLabelGrouping,
} from '../delivery/delivery-companies/interfaces/delivery-company-handler.interface';

export const ORDER_LABEL_FORMATS: readonly OrderLabelFormat[] = [
  '10x13',
  '10x15',
  '15x20',
  '10x10',
  'a4_1up',
  'a4_4up',
  'native',
];

export const ORDER_LABEL_GROUPINGS: readonly OrderLabelGrouping[] = [
  'combined',
  'per_carrier',
];

/** A reprint is allowed because the order was dispatched; cancelled and pre-dispatch are not. */
export const ORDER_LABEL_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set([
  OrderStatus.DISPATCHED,
  OrderStatus.IN_TRANSIT,
  OrderStatus.DELIVERED,
  OrderStatus.RETURNED,
]);

export const ORDER_LABEL_PRE_DISPATCH_STATUSES: ReadonlySet<string> = new Set([
  OrderStatus.PLACED,
  OrderStatus.CONFIRMED,
]);

/** Exact one-up page sizes in millimetres. */
export const ORDER_LABEL_PAGE_MM: Record<
  Exclude<OrderLabelFormat, 'a4_1up' | 'a4_4up' | 'native'>,
  { width: number; height: number }
> = {
  '10x13': { width: 100, height: 130 },
  '10x15': { width: 100, height: 150 },
  '15x20': { width: 150, height: 200 },
  '10x10': { width: 100, height: 100 },
};

export const A4_MM = { width: 210, height: 297 } as const;
export const A4_MARGIN_MM = 5;
export const A4_GUTTER_MM = 5;
export const A4_CELL_MM = {
  width: (A4_MM.width - A4_MARGIN_MM * 2 - A4_GUTTER_MM) / 2,
  height: (A4_MM.height - A4_MARGIN_MM * 2 - A4_GUTTER_MM) / 2,
} as const;

export const MM_TO_PT = 72 / 25.4;
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_LABEL_SCALE = 1.5;
export const MIN_COMFORTABLE_SCALE = 0.95;
export const MAX_COMFORTABLE_SCALE = 1.25;

export const ORDER_LABEL_ARTIFACT_PREFIX = 'order-labels';
export const ORDER_LABEL_ARTIFACT_FILES = ['labels.pdf', 'labels.zip'] as const;
export type OrderLabelArtifactFile = (typeof ORDER_LABEL_ARTIFACT_FILES)[number];

export const ORDER_LABEL_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
