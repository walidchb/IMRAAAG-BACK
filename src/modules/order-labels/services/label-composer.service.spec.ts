import { PDFDocument } from 'pdf-lib';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import type { DeliveryLabelDocument, OrderLabelFormat } from '../../delivery/delivery-companies/interfaces/delivery-company-handler.interface';
import { LabelComposerService, type ComposableLabel } from './label-composer.service';

const MM_TO_PT = 72 / 25.4;

async function sourcePdf(
  widthMm: number,
  heightMm: number,
  pages = 1,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = pdf.addPage([widthMm * MM_TO_PT, heightMm * MM_TO_PT]);
    page.drawRectangle({ x: 0, y: 0, width: 2, height: 2 });
  }
  return Buffer.from(await pdf.save());
}

function label(
  orderNo: string,
  bytes: Buffer,
  document: Partial<DeliveryLabelDocument> = {},
): ComposableLabel {
  return {
    orderNo,
    document: {
      orderNo,
      trackingNumber: `TRK-${orderNo}`,
      bytes,
      contentType: 'application/pdf',
      ...document,
    },
    rendered: {
      bytes,
      pageCount: 1,
      pageWidthPt: 100 * MM_TO_PT,
      pageHeightPt: 100 * MM_TO_PT,
    },
  };
}

async function sizeOf(bytes: Buffer): Promise<Array<{ width: number; height: number }>> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => ({ width: page.getWidth(), height: page.getHeight() }));
}

describe('LabelComposerService', () => {
  let composer: LabelComposerService;

  beforeEach(() => {
    composer = new LabelComposerService();
  });

  describe.each([
    ['10x13', 100, 130],
    ['10x15', 100, 150],
    ['15x20', 150, 200],
    ['10x10', 100, 100],
  ] as Array<[OrderLabelFormat, number, number]>)(
    'one-up %s',
    (format, widthMm, heightMm) => {
      it('creates an exact-size page and records one page for the order', async () => {
        const bytes = await sourcePdf(widthMm, heightMm);
        const result = await composer.compose(format, [label('ORD-1', bytes)]);

        expect(result.pageCount).toBe(1);
        expect(result.pagesByOrder.get('ORD-1')).toBe(1);
        expect(result.warnings).toEqual([]);
        const [page] = await sizeOf(result.bytes);
        expect(page.width).toBeCloseTo(widthMm * MM_TO_PT, 2);
        expect(page.height).toBeCloseTo(heightMm * MM_TO_PT, 2);
      });
    },
  );

  it('creates an A4 page for a4_1up, contains the source, and warns when it is upscaled', async () => {
    const bytes = await sourcePdf(100, 130);
    const result = await composer.compose('a4_1up', [label('ORD-1', bytes)]);

    const [page] = await sizeOf(result.bytes);
    expect(page.width).toBeCloseTo(210 * MM_TO_PT, 2);
    expect(page.height).toBeCloseTo(297 * MM_TO_PT, 2);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        orderNo: 'ORD-1',
        code: 'ORDER_LABEL_SCALE_WARNING',
      }),
    ]);
  });

  it('puts four labels on one A4 page and starts a second sheet for the fifth', async () => {
    const bytes = await sourcePdf(100, 130);
    const labels = Array.from({ length: 5 }, (_, index) =>
      label(`ORD-${index + 1}`, bytes),
    );

    const result = await composer.compose('a4_4up', labels);

    expect(result.pageCount).toBe(2);
    for (let index = 0; index < labels.length; index += 1) {
      expect(result.pagesByOrder.get(`ORD-${index + 1}`)).toBe(1);
    }
    const pages = await sizeOf(result.bytes);
    for (const page of pages) {
      expect(page.width).toBeCloseTo(210 * MM_TO_PT, 2);
      expect(page.height).toBeCloseTo(297 * MM_TO_PT, 2);
    }
  });

  it('does not reject a 15x20 label on a4_4up; it fits and warns instead of cropping', async () => {
    const bytes = await sourcePdf(150, 200);
    const result = await composer.compose('a4_4up', [label('ORD-1', bytes)]);

    expect(result.pageCount).toBe(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        orderNo: 'ORD-1',
        code: 'ORDER_LABEL_SCALE_WARNING',
      }),
    ]);
    expect(result.warnings[0].scale).toBeLessThan(0.95);
  });

  it('passes native pages through unchanged', async () => {
    const bytes = await sourcePdf(210, 297, 2);
    const result = await composer.compose('native', [label('ORD-1', bytes)]);

    expect(result.pageCount).toBe(2);
    expect(result.pagesByOrder.get('ORD-1')).toBe(2);
    expect(result.warnings).toEqual([]);
    const pages = await sizeOf(result.bytes);
    expect(pages[0].width).toBeCloseTo(210 * MM_TO_PT, 2);
    expect(pages[0].height).toBeCloseTo(297 * MM_TO_PT, 2);
  });

  it('passes a carrier sheet through for a4_4up and counts each covered order once', async () => {
    const bytes = await sourcePdf(210, 297);
    const result = await composer.compose('a4_4up', [
      label('ORD-1', bytes, {
        sheet: true,
        orderNos: ['ORD-1', 'ORD-2', 'ORD-3'],
        trackingNumbers: ['T1', 'T2', 'T3'],
      }),
    ]);

    expect(result.pageCount).toBe(1);
    expect(result.pagesByOrder.get('ORD-1')).toBe(1);
    expect(result.pagesByOrder.get('ORD-2')).toBe(1);
    expect(result.pagesByOrder.get('ORD-3')).toBe(1);
  });

  it('crops using the document cropBox before fitting', async () => {
    const bytes = await sourcePdf(100, 200);
    const result = await composer.compose('10x10', [
      label('ORD-1', bytes, {
        cropBox: { x: 0, y: 100 * MM_TO_PT, width: 100 * MM_TO_PT, height: 100 * MM_TO_PT },
      }),
    ]);

    const [page] = await sizeOf(result.bytes);
    expect(page.width).toBeCloseTo(100 * MM_TO_PT, 2);
    expect(page.height).toBeCloseTo(100 * MM_TO_PT, 2);
    expect(result.warnings).toEqual([]);
  });

  it('fits the verified Noest A4 crop into 10x15 without a scale warning', async () => {
    const bytes = await sourcePdf(210, 297);
    const result = await composer.compose('10x15', [
      label('ORD-NOEST', bytes, {
        cropBox: { x: 7.5, y: 427.714, width: 285.837, height: 406.676 },
        widthMm: 100.8,
        heightMm: 143.5,
      }),
    ]);

    const [page] = await sizeOf(result.bytes);
    expect(page.width).toBeCloseTo(100 * MM_TO_PT, 2);
    expect(page.height).toBeCloseTo(150 * MM_TO_PT, 2);
    expect(result.warnings).toEqual([]);
  });

  it('warns when the Noest crop is taller than 10x13 paper', async () => {
    const bytes = await sourcePdf(210, 297);
    const result = await composer.compose('10x13', [
      label('ORD-NOEST', bytes, {
        cropBox: { x: 7.5, y: 427.714, width: 285.837, height: 406.676 },
        widthMm: 100.8,
        heightMm: 143.5,
      }),
    ]);

    expect(result.warnings).toEqual([
      expect.objectContaining({
        orderNo: 'ORD-NOEST',
        code: 'ORDER_LABEL_SCALE_WARNING',
      }),
    ]);
  });

  it('records every page of a multi-page source and warns when a page is tiny', async () => {
    const bytes = await sourcePdf(50, 50, 2);
    const result = await composer.compose('10x13', [label('ORD-1', bytes)]);

    expect(result.pagesByOrder.get('ORD-1')).toBe(2);
    expect(result.warnings).toHaveLength(2);
  });

  it('rejects invalid PDF bytes with ORDER_LABEL_RENDER_FAILED', async () => {
    await expect(
      composer.compose('10x13', [label('ORD-1', Buffer.from('not a pdf'))]),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.ORDER_LABEL_RENDER_FAILED,
    });
    await expect(
      composer.compose('10x13', [label('ORD-1', Buffer.from('not a pdf'))]),
    ).rejects.toBeInstanceOf(AppException);
  });
});
