import type { Readable } from 'node:stream';
import type {
  DeliveryLabelFailure,
  DeliveryLabelWarning,
  OrderLabelFormat,
  OrderLabelGrouping,
} from '../delivery/delivery-companies/interfaces/delivery-company-handler.interface';

export interface OrderLabelAvailability {
  enabled: boolean;
  /** Carrier slugs whose registered handler can produce labels for this deployment. */
  carriers: string[];
}

export interface OrderLabelPrintedEntry {
  orderId: string;
  orderNo: string;
  companyId: string;
  trackingNumber: string;
  pages: number;
}

export interface OrderLabelSkippedEntry {
  orderId: string;
  orderNo: string;
  companyId: string | null;
  code: string;
  message: string;
  /** When a duplicate tracking number was already printed for another order. */
  printedByOrderNo?: string;
}

export interface OrderLabelManifestWarning {
  orderId?: string;
  orderNo?: string;
  code: string;
  message: string;
}

export interface OrderLabelSummary {
  requested: number;
  printed: number;
  failed: number;
  skipped: number;
  warnings: number;
}

export interface OrderLabelJobResponse {
  jobId: string;
  expiresAt: string;
  format: OrderLabelFormat;
  grouping: OrderLabelGrouping;
  downloadUrl: string | null;
  fileName: string | null;
  contentType: 'application/pdf' | 'application/zip' | null;
  summary: OrderLabelSummary;
  printed: OrderLabelPrintedEntry[];
  failed: Array<DeliveryLabelFailure & { orderId: string; companyId: string }>;
  skipped: OrderLabelSkippedEntry[];
  warnings: OrderLabelManifestWarning[];
}

export interface ComposedLabelResult {
  bytes: Buffer;
  contentType: 'application/pdf' | 'application/zip';
  pageCount: number;
  pagesByOrder: Map<string, number>;
  warnings: Array<DeliveryLabelWarning & { orderNo: string }>;
}

export interface StoredLabelArtifact {
  key: string;
  fileName: string;
  contentType: 'application/pdf' | 'application/zip';
}

export interface LabelArtifactStream {
  body: Readable;
  contentLength: number | null;
  contentType: string;
  contentDisposition: string;
}

export type OrderLabelErrorDetails = {
  code: string;
  message: string;
  retryable?: boolean;
};
