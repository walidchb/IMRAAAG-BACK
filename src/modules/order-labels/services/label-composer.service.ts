import { Injectable } from '@nestjs/common';
import {
  PDFDocument,
  PDFEmbeddedPage,
  PDFPage,
} from 'pdf-lib';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import type {
  DeliveryLabelDocument,
  DeliveryLabelWarning,
  OrderLabelFormat,
} from '../../delivery/delivery-companies/interfaces/delivery-company-handler.interface';
import {
  A4_CELL_MM,
  A4_GUTTER_MM,
  A4_MARGIN_MM,
  A4_MM,
  MAX_COMFORTABLE_SCALE,
  MAX_LABEL_SCALE,
  MIN_COMFORTABLE_SCALE,
  MM_TO_PT,
  ORDER_LABEL_PAGE_MM,
} from '../order-labels.constants';
import type { RenderedLabelDocument } from './label-renderer.service';

export interface ComposableLabel {
  orderNo: string;
  document: DeliveryLabelDocument;
  rendered: RenderedLabelDocument;
}

export interface ComposedPdf {
  bytes: Buffer;
  pageCount: number;
  pagesByOrder: Map<string, number>;
  warnings: Array<DeliveryLabelWarning & { orderNo: string }>;
}

const PDF_LOAD_OPTIONS = { updateMetadata: false } as const;

@Injectable()
export class LabelComposerService {
  async compose(format: OrderLabelFormat, labels: ComposableLabel[]): Promise<ComposedPdf> {
    const target = await PDFDocument.create();
    const pagesByOrder = new Map<string, number>();
    const warnings: DeliveryLabelWarning[] = [];
    let fourUpPage: PDFPage | null = null;
    let fourUpSlot = 0;

    for (const label of labels) {
      let source: PDFDocument;
      try {
        source = await PDFDocument.load(label.rendered.bytes, PDF_LOAD_OPTIONS);
      } catch {
        throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
          orderNo: label.orderNo,
          reason: 'invalid_pdf',
        });
      }

      const sourcePages = source.getPages();
      if (sourcePages.length === 0) {
        throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
          orderNo: label.orderNo,
          reason: 'no_pages',
        });
      }

      const passthroughSheet =
        label.document.sheet === true && !label.document.cropBox && format === 'a4_4up';
      if (format === 'native' || passthroughSheet) {
        const copied = await target.copyPages(source, source.getPageIndices());
        for (const page of copied) target.addPage(page);

        // A carrier sheet may contain labels for several orders. Page order is not guaranteed,
        // so each covered order records one page (the page its label appears on) rather than
        // pretending we can map individual pages.
        if (label.document.orderNos && label.document.orderNos.length > 1) {
          for (const orderNo of label.document.orderNos) {
            pagesByOrder.set(orderNo, Math.max(1, pagesByOrder.get(orderNo) ?? 0));
          }
        } else {
          pagesByOrder.set(
            label.orderNo,
            (pagesByOrder.get(label.orderNo) ?? 0) + copied.length,
          );
        }
        continue;
      }

      for (const sourcePage of sourcePages) {
        const embedding = await this.embedSource(target, sourcePage, label.document);

        if (format === 'a4_1up') {
          const page = target.addPage([
            A4_MM.width * MM_TO_PT,
            A4_MM.height * MM_TO_PT,
          ]);
          const placed = this.drawContained(page, embedding, {
            x: A4_MARGIN_MM * MM_TO_PT,
            y: A4_MARGIN_MM * MM_TO_PT,
            width: (A4_MM.width - A4_MARGIN_MM * 2) * MM_TO_PT,
            height: (A4_MM.height - A4_MARGIN_MM * 2) * MM_TO_PT,
          });
          this.maybeWarn(warnings, label.orderNo, placed);
        } else if (format === 'a4_4up') {
          if (!fourUpPage || fourUpSlot >= 4) {
            fourUpPage = target.addPage([
              A4_MM.width * MM_TO_PT,
              A4_MM.height * MM_TO_PT,
            ]);
            fourUpSlot = 0;
          }
          const placed = this.drawContained(
            fourUpPage,
            embedding,
            this.a4Cell(fourUpSlot),
          );
          fourUpSlot += 1;
          this.maybeWarn(warnings, label.orderNo, placed);
        } else {
          const size = ORDER_LABEL_PAGE_MM[format];
          const page = target.addPage([
            size.width * MM_TO_PT,
            size.height * MM_TO_PT,
          ]);
          const placed = this.drawContained(page, embedding, {
            x: 0,
            y: 0,
            width: size.width * MM_TO_PT,
            height: size.height * MM_TO_PT,
          });
          this.maybeWarn(warnings, label.orderNo, placed);
        }

        pagesByOrder.set(label.orderNo, (pagesByOrder.get(label.orderNo) ?? 0) + 1);
      }
    }

    return {
      bytes: Buffer.from(await target.save()),
      pageCount: target.getPageCount(),
      pagesByOrder,
      warnings,
    };
  }

  private async embedSource(
    target: PDFDocument,
    page: PDFPage,
    document: DeliveryLabelDocument,
  ): Promise<PDFEmbeddedPage> {
    const crop = document.cropBox;
    const box = crop
      ? {
          left: crop.x,
          bottom: crop.y,
          right: crop.x + crop.width,
          top: crop.y + crop.height,
        }
      : undefined;
    return target.embedPage(page, box);
  }

  /** Draws the entire source page inside the cell, centred, preserving its aspect ratio. */
  private drawContained(
    page: PDFPage,
    source: PDFEmbeddedPage,
    cell: { x: number; y: number; width: number; height: number },
  ): number {
    const scale = Math.min(
      cell.width / source.width,
      cell.height / source.height,
      MAX_LABEL_SCALE,
    );
    const width = source.width * scale;
    const height = source.height * scale;

    page.drawPage(source, {
      x: cell.x + (cell.width - width) / 2,
      y: cell.y + (cell.height - height) / 2,
      width,
      height,
    });

    return scale;
  }

  private maybeWarn(
    warnings: DeliveryLabelWarning[],
    orderNo: string,
    scale: number,
  ): void {
    if (scale >= MIN_COMFORTABLE_SCALE && scale <= MAX_COMFORTABLE_SCALE) return;
    warnings.push({
      orderNo,
      code: 'ORDER_LABEL_SCALE_WARNING',
      message:
        'The source label does not match the requested paper size; it was fitted without cropping and may print smaller or larger than intended.',
      scale: Number(scale.toFixed(3)),
    });
  }

  private a4Cell(slot: number): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const column = slot % 2;
    const row = Math.floor(slot / 2);
    const width = A4_CELL_MM.width * MM_TO_PT;
    const height = A4_CELL_MM.height * MM_TO_PT;
    const x = (A4_MARGIN_MM + column * (A4_CELL_MM.width + A4_GUTTER_MM)) * MM_TO_PT;
    const y =
      (A4_MM.height -
        A4_MARGIN_MM -
        (row + 1) * A4_CELL_MM.height -
        row * A4_GUTTER_MM) *
      MM_TO_PT;
    return { x, y, width, height };
  }
}
