import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Browser,
  PDFOptions,
  Page,
  launch,
} from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import type { DeliveryLabelDocument } from '../../delivery/delivery-companies/interfaces/delivery-company-handler.interface';
import {
  A4_MM,
  MAX_HTML_BYTES,
  MAX_PDF_BYTES,
} from '../order-labels.constants';

export interface RenderedLabelDocument {
  bytes: Buffer;
  pageCount: number;
  pageWidthPt: number;
  pageHeightPt: number;
}

const HTML_TIMEOUT_FALLBACK_MS = 15000;
const PDF_LOAD_OPTIONS = { updateMetadata: false } as const;

@Injectable()
export class LabelRendererService implements OnModuleDestroy {
  private readonly logger = new Logger(LabelRendererService.name);
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    const pending = this.browserPromise;
    this.browserPromise = null;
    if (!pending) return;
    try {
      const browser = await pending;
      await browser.close();
    } catch {
      // A browser that failed to launch has nothing to close.
    }
  }

  async render(document: DeliveryLabelDocument): Promise<RenderedLabelDocument> {
    if (!document.bytes?.length) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        orderNo: document.orderNo,
        reason: 'empty_document',
      });
    }

    if (document.contentType === 'application/pdf') {
      return this.readPdf(document);
    }

    if (document.bytes.length > MAX_HTML_BYTES) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        orderNo: document.orderNo,
        reason: 'html_too_large',
      });
    }

    return this.renderHtml(document);
  }

  private async readPdf(document: DeliveryLabelDocument): Promise<RenderedLabelDocument> {
    if (document.bytes.length > MAX_PDF_BYTES) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        orderNo: document.orderNo,
        reason: 'pdf_too_large',
      });
    }

    try {
      const pdf = await PDFDocument.load(document.bytes, PDF_LOAD_OPTIONS);
      const pages = pdf.getPages();
      if (pages.length === 0) throw new Error('PDF has no pages');
      const first = pages[0];
      return {
        bytes: document.bytes,
        pageCount: pages.length,
        pageWidthPt: first.getWidth(),
        pageHeightPt: first.getHeight(),
      };
    } catch (err) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        orderNo: document.orderNo,
        reason: 'invalid_pdf',
      });
    }
  }

  private async renderHtml(document: DeliveryLabelDocument): Promise<RenderedLabelDocument> {
    const timeoutMs = this.renderTimeout();
    const source = document.sheet
      ? A4_MM
      : {
          width: document.widthMm ?? A4_MM.width,
          height: document.heightMm ?? A4_MM.height,
        };

    const html = document.bytes.toString('utf8');
    const browser = await this.getBrowser();
    let page: Page | null = null;

    try {
      page = await browser.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = request.url();
        if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) {
          void request.continue();
        } else {
          void request.abort();
        }
      });
      page.setDefaultTimeout(timeoutMs);
      await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
      await page
        .evaluate(
          () =>
            Promise.race([
              globalThis.document.fonts.ready.then(() => undefined),
              new Promise<void>((resolve) => setTimeout(resolve, 1500)),
            ]),
        )
        .catch(() => undefined);
      await page.emulateMediaType('print');

      // Prefer the carrier's CSS page size; the explicit dimensions are a fallback for HTML
      // that does not declare one.
      const options: PDFOptions = {
        printBackground: true,
        preferCSSPageSize: true,
        width: `${source.width}mm`,
        height: `${source.height}mm`,
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
        timeout: timeoutMs,
      };

      const bytes = Buffer.from(await page.pdf(options));
      if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES) {
        throw new Error('The rendering engine returned an empty or oversized PDF.');
      }

      const pdf = await PDFDocument.load(bytes, PDF_LOAD_OPTIONS);
      const pages = pdf.getPages();
      if (pages.length === 0) throw new Error('The rendering engine returned no pages.');
      const first = pages[0];

      return {
        bytes,
        pageCount: pages.length,
        pageWidthPt: first.getWidth(),
        pageHeightPt: first.getHeight(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown rendering error';
      this.logger.warn(`Label render failed (${document.orderNo}): ${message}`);
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        orderNo: document.orderNo,
      });
    } finally {
      if (page) {
        await page.close().catch(() => undefined);
      }
    }
  }

  private renderTimeout(): number {
    const configured = Number(this.configService.get<number>('orderLabels.renderTimeoutMs'));
    return Number.isFinite(configured) && configured > 0
      ? configured
      : HTML_TIMEOUT_FALLBACK_MS;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browserPromise) {
      const existing = await this.browserPromise.catch(() => null);
      if (existing?.connected) return existing;
      this.browserPromise = null;
    }

    const executablePath =
      this.configService.get<string>('orderLabels.puppeteerExecutablePath') || undefined;

    this.browserPromise = launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none',
      ],
    }).catch((err) => {
      this.logger.error(
        `Unable to launch the label renderer: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        reason: 'renderer_unavailable',
      });
    });

    return this.browserPromise;
  }
}
