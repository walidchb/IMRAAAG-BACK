import { PDFDocument } from 'pdf-lib';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import type { DeliveryLabelDocument } from '../../delivery/delivery-companies/interfaces/delivery-company-handler.interface';
import { MAX_HTML_BYTES } from '../order-labels.constants';
import { LabelRendererService } from './label-renderer.service';

const MM_TO_PT = 72 / 25.4;

async function pdfBytes(widthMm = 100, heightMm = 150): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([widthMm * MM_TO_PT, heightMm * MM_TO_PT]);
  page.drawRectangle({ x: 0, y: 0, width: 4, height: 4 });
  return Buffer.from(await pdf.save());
}

function document(overrides: Partial<DeliveryLabelDocument> = {}): DeliveryLabelDocument {
  return {
    orderNo: 'ORD-1',
    bytes: Buffer.from(''),
    contentType: 'text/html',
    ...overrides,
  } as DeliveryLabelDocument;
}

function service(executablePath?: string): LabelRendererService {
  return new LabelRendererService({
    get: jest.fn((key: string) => {
      if (key === 'orderLabels.puppeteerExecutablePath') return executablePath ?? '';
      if (key === 'orderLabels.renderTimeoutMs') return 15000;
      return undefined;
    }),
  } as any);
}

const chromium = process.env.ORDER_LABEL_TEST_CHROMIUM;

describe('LabelRendererService', () => {
  it('passes a valid PDF through and reports its page geometry', async () => {
    const bytes = await pdfBytes(100, 150);
    const result = await service().render(
      document({ bytes, contentType: 'application/pdf' }),
    );

    expect(result.bytes).toBe(bytes);
    expect(result.pageCount).toBe(1);
    expect(result.pageWidthPt).toBeCloseTo(100 * MM_TO_PT, 2);
    expect(result.pageHeightPt).toBeCloseTo(150 * MM_TO_PT, 2);
  });

  it('rejects empty PDF bytes', async () => {
    await expect(
      service().render(document({ bytes: Buffer.alloc(0), contentType: 'application/pdf' })),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_LABEL_RENDER_FAILED });
  });

  it('rejects invalid PDF bytes', async () => {
    await expect(
      service().render(
        document({ bytes: Buffer.from('not a pdf'), contentType: 'application/pdf' }),
      ),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_LABEL_RENDER_FAILED });
  });

  it('rejects an oversized HTML document before launching a browser', async () => {
    await expect(
      service('missing-executable').render(
        document({ bytes: Buffer.alloc(MAX_HTML_BYTES + 1, 0x20) }),
      ),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_LABEL_RENDER_FAILED });
  });

  (chromium ? it : it.skip)(
    'renders HTML into a PDF honouring the carrier CSS page size',
    async () => {
      const renderer = service(chromium);
      const html = Buffer.from(
        `<!doctype html><html><head><style>
          @page { size: 100mm 150mm; margin: 0; }
          html, body { margin: 0; width: 100mm; height: 150mm; }
          .label { width: 100mm; height: 150mm; box-sizing: border-box; border: 1mm solid #000; }
        </style></head><body><div class="label">ORD-1</div></body></html>`,
      );

      try {
        const result = await renderer.render(document({ bytes: html }));

        expect(result.pageCount).toBe(1);
        expect(Math.abs(result.pageWidthPt - 100 * MM_TO_PT)).toBeLessThan(1.5);
        expect(Math.abs(result.pageHeightPt - 150 * MM_TO_PT)).toBeLessThan(1.5);
      } finally {
        await renderer.onModuleDestroy();
      }
    },
    60000,
  );

  (chromium ? it : it.skip)(
    'renders HTML at the fallback dimensions when CSS declares no page size',
    async () => {
      const renderer = service(chromium);
      const html = Buffer.from(
        '<!doctype html><html><body><div>ORD-2</div></body></html>',
      );

      try {
        const result = await renderer.render(
          document({ bytes: html, widthMm: 100, heightMm: 100 }),
        );

        expect(result.pageCount).toBe(1);
        expect(Math.abs(result.pageWidthPt - 100 * MM_TO_PT)).toBeLessThan(1.5);
        expect(Math.abs(result.pageHeightPt - 100 * MM_TO_PT)).toBeLessThan(1.5);
      } finally {
        await renderer.onModuleDestroy();
      }
    },
    60000,
  );
});
