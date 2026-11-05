import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import archiver from 'archiver';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Role } from '../../common/constants/roles.enum';
import { OrderStatus } from '../../common/constants/order-statuses.const';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import type { RequestUser } from '../orders/orders.service';
import { StoresService } from '../stores/stores.service';
import { DeliveryCompanyRegistry } from '../delivery/delivery-companies/delivery-company-registry.service';
import type {
  DeliveryLabelDocument,
  DeliveryLabelFailure,
  DeliveryLabelOrder,
} from '../delivery/delivery-companies/interfaces/delivery-company-handler.interface';
import {
  ORDER_LABEL_ELIGIBLE_STATUSES,
  ORDER_LABEL_FORMATS,
  ORDER_LABEL_GROUPINGS,
  OrderLabelArtifactFile,
} from './order-labels.constants';
import type { GenerateOrderLabelsDto } from './dto/generate-order-labels.dto';
import { LabelRendererService } from './services/label-renderer.service';
import type { ComposableLabel } from './services/label-composer.service';
import { LabelComposerService } from './services/label-composer.service';
import { LabelArtifactService } from './services/label-artifact.service';
import type {
  LabelArtifactStream,
  OrderLabelAvailability,
  OrderLabelJobResponse,
  OrderLabelPrintedEntry,
  OrderLabelSkippedEntry,
  OrderLabelSummary,
  OrderLabelManifestWarning,
} from './types';

interface ScopedOrder {
  id: string;
  orderNo: string;
  companyId: string;
  parcelId: string;
  trackingNumber: string | null;
  statusSlug: string;
}

interface ScopedLoad {
  storeId: string;
  vendorEmail: string | null;
  orders: Map<string, any>;
  skipped: OrderLabelSkippedEntry[];
}

interface RenderedDocument extends ComposableLabel {
  companyId: string;
}

@Injectable()
export class OrderLabelsService {
  private readonly logger = new Logger(OrderLabelsService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly storesService: StoresService,
    private readonly registry: DeliveryCompanyRegistry,
    private readonly renderer: LabelRendererService,
    private readonly composer: LabelComposerService,
    private readonly artifact: LabelArtifactService,
    private readonly config: ConfigService,
  ) {}

  async availability(_user: RequestUser): Promise<OrderLabelAvailability> {
    const carriers = this.registry.getLabelCapableCompanyIds();
    if (!this.config.get<boolean>('orderLabels.enabled')) {
      return { enabled: false, carriers: [] };
    }
    return { enabled: true, carriers };
  }

  async generate(
    dto: GenerateOrderLabelsDto,
    user: RequestUser,
  ): Promise<OrderLabelJobResponse> {
    this.assertEnabled();
    this.validateRequest(dto);

    const requestedIds = [...new Set(dto.ids)];
    const requested = requestedIds.length;
    const maxOrders = this.maxOrders();
    if (requested > maxOrders) {
      throw new AppException(AppErrorCode.ORDER_LABEL_TOO_MANY_ORDERS, {
        max: maxOrders,
        requested,
      });
    }

    this.artifact.assertConfigured();

    const loaded = await this.loadScopedOrders(requestedIds, user);

    const skipped: OrderLabelSkippedEntry[] = [...loaded.skipped];
    const failed: Array<DeliveryLabelFailure & { orderId: string; companyId: string }> = [];
    const warnings: OrderLabelManifestWarning[] = [];

    let eligible: ScopedOrder[] = [];
    for (const id of requestedIds) {
      const order = loaded.orders.get(id);
      if (!order) continue; // already reported by loadScopedOrders

      const companyId = String(order.deliveryCompanyId ?? '').trim();
      const parcelId = String(order.deliveryParcelId ?? '').trim();
      const statusSlug = this.statusSlug(order.status);
      const base = {
        id,
        orderNo: String(order.orderNo ?? ''),
        companyId,
        parcelId,
        trackingNumber: null,
        statusSlug,
      };

      if (statusSlug === OrderStatus.CANCELLED) {
        skipped.push(this.skip(base, 'ORDER_LABEL_CANCELLED', 'This order was cancelled.'));
        continue;
      }
      if (!ORDER_LABEL_ELIGIBLE_STATUSES.has(statusSlug)) {
        skipped.push(
          this.skip(
            base,
            'ORDER_LABEL_PRE_DISPATCH',
            'The order has not been dispatched, so there is no carrier label yet.',
          ),
        );
        continue;
      }
      if (!companyId) {
        skipped.push(
          this.skip(
            base,
            'ORDER_LABEL_NO_DELIVERY_COMPANY',
            'This order has no delivery company.',
          ),
        );
        continue;
      }
      const handler = this.registry.getHandler(companyId);
      if (!handler?.createLabels) {
        skipped.push(
          this.skip(
            base,
            'ORDER_LABEL_UNSUPPORTED_CARRIER',
            'Label printing is not supported for this carrier.',
          ),
        );
        continue;
      }
      if (!parcelId) {
        skipped.push(
          this.skip(
            base,
            'ORDER_LABEL_MISSING_PARCEL',
            'This order has no carrier parcel.',
          ),
        );
        continue;
      }

      eligible.push(base);
    }

    const deadline = Date.now() + this.jobTimeoutMs();
    eligible = await this.prepareEligibleOrders(eligible, loaded, failed, skipped, deadline);

    // Collapse identical tracking numbers to one label. The first requested order wins.
    const firstByTracking = new Map<string, ScopedOrder>();
    const unique: ScopedOrder[] = [];
    for (const order of eligible) {
      const key = `${order.companyId}:${order.trackingNumber}`;
      const first = firstByTracking.get(key);
      if (first) {
        skipped.push({
          ...this.skip(
            order,
            'ORDER_LABEL_DUPLICATE_TRACKING',
            'Another selected order already uses this tracking number.',
          ),
          printedByOrderNo: first.orderNo,
        });
        continue;
      }
      firstByTracking.set(key, order);
      unique.push(order);
    }

    if (unique.length === 0 && failed.length === 0) {
      throw new AppException(
        AppErrorCode.ORDER_LABEL_NOTHING_ELIGIBLE,
        { skipped, failed },
        undefined,
        'No selected order is eligible for label printing.',
      );
    }

    const groups = new Map<string, ScopedOrder[]>();
    for (const order of unique) {
      const group = groups.get(order.companyId) ?? [];
      group.push(order);
      groups.set(order.companyId, group);
    }

    const documents: Array<{ companyId: string; document: DeliveryLabelDocument }> = [];
    const allSameCarrier = groups.size === 1;

    for (const companyId of [...groups.keys()].sort()) {
      const group = groups.get(companyId)!;
      const handler = this.registry.getHandler(companyId);
      if (!handler?.createLabels) {
        for (const order of group) {
          failed.push({
            ...this.failure(
              order,
              'ORDER_LABEL_UNSUPPORTED_CARRIER',
              'Label printing is not supported for this carrier.',
              false,
            ),
            orderId: order.id,
            companyId,
          });
        }
        continue;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        for (const order of group) {
          failed.push({
            ...this.failure(
              order,
              'ORDER_LABEL_JOB_TIMEOUT',
              'Label generation took too long. Retry with a smaller selection.',
              true,
            ),
            orderId: order.id,
            companyId,
          });
        }
        continue;
      }

      try {
        const result = await handler.createLabels(
          group.map((order): DeliveryLabelOrder => ({
            orderNo: order.orderNo,
            parcelId: order.parcelId,
            trackingNumber: order.trackingNumber,
          })),
          {
            storeId: loaded.storeId,
            vendorEmail: loaded.vendorEmail,
            format: dto.format,
            timeoutMs: Math.min(remaining, 15000),
            allOrdersSameCarrier: allSameCarrier,
          },
        );

        const groupByOrderNo = new Map(group.map((order) => [order.orderNo, order]));
        const covered = new Set<string>();

        for (const document of result.documents ?? []) {
          const orderNos = document.orderNos?.length ? document.orderNos : [document.orderNo];
          for (const orderNo of orderNos) {
            const order = groupByOrderNo.get(orderNo);
            if (order) covered.add(order.id);
          }
          documents.push({ companyId, document });
        }

        for (const failure of result.failures ?? []) {
          const order = groupByOrderNo.get(failure.orderNo);
          if (!order) continue;
          covered.add(order.id);
          failed.push({
            orderId: order.id,
            companyId,
            orderNo: failure.orderNo,
            trackingNumber: failure.trackingNumber ?? order.trackingNumber,
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
          });
        }

        for (const warning of result.warnings ?? []) {
          const order = groupByOrderNo.get(warning.orderNo);
          warnings.push({
            orderId: order?.id,
            orderNo: warning.orderNo,
            code: warning.code,
            message: warning.message,
          });
        }

        for (const order of group) {
          if (!covered.has(order.id)) {
            failed.push({
              ...this.failure(
                order,
                'ORDER_LABEL_CARRIER_FAILED',
                'The carrier did not return a label for this order.',
                true,
              ),
              orderId: order.id,
              companyId,
            });
          }
        }
      } catch (err) {
        const message = this.carrierErrorMessage(err);
        for (const order of group) {
          failed.push({
            ...this.failure(order, 'ORDER_LABEL_CARRIER_FAILED', message, true),
            orderId: order.id,
            companyId,
          });
        }
      }
    }

    const renderItems = await this.renderDocuments(documents, unique, failed, deadline);

    let file: OrderLabelArtifactFile | null = null;
    let bytes: Buffer | null = null;
    let contentType: 'application/pdf' | 'application/zip' | null = null;
    const successful: RenderedDocument[] = [];
    const pagesByOrder = new Map<string, number>();
    const pdfEntries: Array<{ name: string; bytes: Buffer }> = [];

    if (renderItems.length > 0) {
      if (dto.grouping === 'combined') {
        try {
          const composed = await this.composer.compose(dto.format, renderItems);
          successful.push(...renderItems);
          this.mergePages(pagesByOrder, composed.pagesByOrder);
          warnings.push(...this.mapScaleWarnings(composed.warnings, unique));
          file = 'labels.pdf';
          bytes = composed.bytes;
          contentType = 'application/pdf';
        } catch {
          for (const item of renderItems) {
            this.failDocumentOrders(item, unique, failed, 'ORDER_LABEL_RENDER_FAILED', 'The label could not be composed.');
          }
        }
      } else {
        const companyGroups = new Map<string, RenderedDocument[]>();
        for (const item of renderItems) {
          const list = companyGroups.get(item.companyId) ?? [];
          list.push(item);
          companyGroups.set(item.companyId, list);
        }

        for (const companyId of [...companyGroups.keys()].sort()) {
          const items = companyGroups.get(companyId)!;
          try {
            const composed = await this.composer.compose(dto.format, items);
            successful.push(...items);
            this.mergePages(pagesByOrder, composed.pagesByOrder);
            warnings.push(...this.mapScaleWarnings(composed.warnings, unique));
            pdfEntries.push({ name: `${this.safeFileName(companyId)}-labels.pdf`, bytes: composed.bytes });
          } catch {
            for (const item of items) {
              this.failDocumentOrders(
                item,
                unique,
                failed,
                'ORDER_LABEL_RENDER_FAILED',
                'The label could not be composed.',
              );
            }
          }
        }

        if (pdfEntries.length > 0) {
          file = 'labels.zip';
          contentType = 'application/zip';
        }
      }
    }

    const jobId = randomUUID();
    const expiresAt = new Date(Date.now() + this.artifactTtlHours() * 3600_000);
    const storedFile = file;
    const adminStoreSuffix =
      user.role === Role.ADMIN && storedFile
        ? `?storeId=${encodeURIComponent(loaded.storeId)}`
        : '';
    const downloadUrl = storedFile
      ? `/api/orders/labels/${jobId}/${storedFile}${adminStoreSuffix}`
      : null;
    const fileName = storedFile ? this.artifactName(storedFile) : null;

    const printed = this.buildPrinted(successful, unique, pagesByOrder);
    const summary: OrderLabelSummary = {
      requested,
      printed: printed.length,
      failed: failed.length,
      skipped: skipped.length,
      warnings: warnings.length,
    };

    const response: OrderLabelJobResponse = {
      jobId,
      expiresAt: expiresAt.toISOString(),
      format: dto.format,
      grouping: dto.grouping,
      downloadUrl,
      fileName,
      contentType,
      summary,
      printed,
      failed,
      skipped,
      warnings,
    };

    if (file === 'labels.zip' && bytes === null && pdfEntries.length > 0) {
      const manifest = Buffer.from(JSON.stringify(response, null, 2), 'utf8');
      bytes = await this.zip([
        ...pdfEntries.map((entry) => ({ ...entry, buffer: entry.bytes })),
        { name: 'manifest.json', buffer: manifest },
      ]);
    }

    if (file && bytes && contentType) {
      await this.artifact.put(loaded.storeId, jobId, file, bytes, contentType);
    } else {
      response.downloadUrl = null;
      response.fileName = null;
      response.contentType = null;
      response.summary.failed = failed.length;
      response.summary.warnings = warnings.length;
    }

    this.logger.log(
      `Order labels ${jobId}: requested=${requested} printed=${response.summary.printed} failed=${response.summary.failed} skipped=${response.summary.skipped} warnings=${response.summary.warnings}`,
    );

    return response;
  }

  async download(
    jobId: string,
    file: string,
    user: RequestUser,
    storeId?: string,
  ): Promise<LabelArtifactStream> {
    this.assertEnabled();
    const store = await this.resolveDownloadStore(user, storeId);
    return this.artifact.stream(
      String(store._id),
      jobId,
      file as OrderLabelArtifactFile,
    );
  }

  private async loadScopedOrders(
    requestedIds: string[],
    user: RequestUser,
  ): Promise<ScopedLoad> {
    const objectIds = requestedIds.map((id) => new Types.ObjectId(id));
    const skipped: OrderLabelSkippedEntry[] = [];
    let store: { _id: any; vendorEmail?: string | null } | null = null;

    if (user.role === Role.ADMIN) {
      const docs = await this.orderModel
        .find({ _id: { $in: objectIds }, isDeleted: { $ne: true } })
        .lean()
        .exec();
      const resolved = await this.resolveAdminStore(docs);
      store = resolved.store;
      if (!store) {
        for (const id of requestedIds) {
          skipped.push({
            orderId: id,
            orderNo: '',
            companyId: null,
            code: 'ORDER_LABEL_ORDER_NOT_FOUND',
            message: 'The order was not found in the selected store.',
          });
        }
        return { storeId: '', vendorEmail: null, orders: new Map(), skipped };
      }
      const orders = new Map<string, any>();
      for (const order of docs) {
        const id = String(order._id);
        if (
          String(order.storeId ?? '') === String(store._id) ||
          String(order.vendorEmail ?? '').toLowerCase() ===
            String(store.vendorEmail ?? '').toLowerCase()
        ) {
          orders.set(id, order);
        }
      }
      this.markMissing(requestedIds, orders, skipped);
      return {
        storeId: String(store._id),
        vendorEmail: store.vendorEmail ?? null,
        orders,
        skipped,
      };
    }

    store = await this.storesService.findByVendorIdOrThrow(user.id);
    const filter: Record<string, any> = {
      _id: { $in: objectIds },
      isDeleted: { $ne: true },
    };
    if (store.vendorEmail) {
      filter.$or = [{ storeId: store._id }, { vendorEmail: store.vendorEmail }];
    } else {
      filter.storeId = store._id;
    }

    const docs = await this.orderModel.find(filter).lean().exec();
    const orders = new Map(docs.map((order) => [String(order._id), order]));
    this.markMissing(requestedIds, orders, skipped);
    return {
      storeId: String(store._id),
      vendorEmail: store.vendorEmail ?? null,
      orders,
      skipped,
    };
  }

  /**
   * Gives each carrier a chance to resolve the reference its label endpoint needs. A provider
   * that does not implement `prepareLabels` keeps the platform default: the parcel id itself is
   * printable. ZR, whose tracking number only appears in status discovery, implements the hook.
   */
  private async prepareEligibleOrders(
    orders: ScopedOrder[],
    loaded: ScopedLoad,
    failed: Array<DeliveryLabelFailure & { orderId: string; companyId: string }>,
    skipped: OrderLabelSkippedEntry[],
    deadline: number,
  ): Promise<ScopedOrder[]> {
    const groups = new Map<string, ScopedOrder[]>();
    for (const order of orders) {
      const group = groups.get(order.companyId) ?? [];
      group.push(order);
      groups.set(order.companyId, group);
    }

    const prepared: ScopedOrder[] = [];
    for (const [companyId, group] of groups) {
      const handler = this.registry.getHandler(companyId);
      if (!handler?.createLabels) {
        for (const order of group) {
          failed.push({
            ...this.failure(
              order,
              'ORDER_LABEL_UNSUPPORTED_CARRIER',
              'Label printing is not supported for this carrier.',
              false,
            ),
            orderId: order.id,
            companyId,
          });
        }
        continue;
      }

      if (!handler.prepareLabels) {
        for (const order of group) {
          order.trackingNumber = String(order.trackingNumber ?? order.parcelId);
          prepared.push(order);
        }
        continue;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        for (const order of group) {
          failed.push({
            ...this.failure(
              order,
              'ORDER_LABEL_JOB_TIMEOUT',
              'Label generation took too long. Retry with a smaller selection.',
              true,
            ),
            orderId: order.id,
            companyId,
          });
        }
        continue;
      }

      try {
        const result = await handler.prepareLabels(
          group.map((order): DeliveryLabelOrder => ({
            orderNo: order.orderNo,
            parcelId: order.parcelId,
            trackingNumber: order.trackingNumber,
          })),
          {
            storeId: loaded.storeId,
            vendorEmail: loaded.vendorEmail,
            timeoutMs: Math.min(remaining, 15000),
          },
        );

        const groupByOrderNo = new Map(group.map((order) => [order.orderNo, order]));
        const failedIds = new Set<string>();
        for (const failure of result.failures ?? []) {
          const order = groupByOrderNo.get(failure.orderNo);
          if (!order || failedIds.has(order.id)) continue;
          failedIds.add(order.id);
          failed.push({
            orderId: order.id,
            companyId,
            orderNo: failure.orderNo,
            trackingNumber: failure.trackingNumber ?? order.trackingNumber,
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
          });
        }

        const preparedByOrderNo = new Map(
          (result.orders ?? []).map((order) => [order.orderNo, order]),
        );
        for (const order of group) {
          if (failedIds.has(order.id)) continue;
          const resolved = preparedByOrderNo.get(order.orderNo);
          if (!resolved) {
            failed.push({
              ...this.failure(
                order,
                'ORDER_LABEL_CARRIER_FAILED',
                'The carrier did not return a printable reference for this order.',
                true,
              ),
              orderId: order.id,
              companyId,
            });
            continue;
          }
          const trackingNumber = String(resolved.trackingNumber ?? '').trim();
          if (!trackingNumber) {
            skipped.push(
              this.skip(
                order,
                'ORDER_LABEL_TRACKING_UNAVAILABLE',
                'The carrier did not return a tracking number for this parcel.',
              ),
            );
            continue;
          }
          order.trackingNumber = trackingNumber;
          prepared.push(order);
        }
      } catch (err) {
        const message = this.carrierErrorMessage(err);
        for (const order of group) {
          failed.push({
            ...this.failure(order, 'ORDER_LABEL_CARRIER_FAILED', message, true),
            orderId: order.id,
            companyId,
          });
        }
      }
    }

    return prepared;
  }

  private async resolveAdminStore(docs: any[]): Promise<{ store: any | null }> {
    const storeIds = new Set<string>();
    for (const order of docs) {
      const direct = String(order.storeId ?? '').trim();
      if (direct) {
        storeIds.add(direct);
        continue;
      }
      const email = String(order.vendorEmail ?? '').trim();
      if (email) {
        const resolved = await this.storesService.resolveStoreIdByEmail(email).catch(() => null);
        if (resolved) storeIds.add(String(resolved));
      }
    }

    if (storeIds.size > 1) {
      throw new AppException(AppErrorCode.ORDER_LABEL_MIXED_STORES);
    }
    const storeId = [...storeIds][0];
    if (!storeId) return { store: null };
    try {
      return { store: await this.storesService.findOne(storeId, { skipStatusCheck: true }) };
    } catch {
      return { store: null };
    }
  }

  private markMissing(
    requestedIds: string[],
    orders: Map<string, any>,
    skipped: OrderLabelSkippedEntry[],
  ): void {
    for (const id of requestedIds) {
      if (orders.has(id)) continue;
      skipped.push({
        orderId: id,
        orderNo: '',
        companyId: null,
        code: 'ORDER_LABEL_ORDER_NOT_FOUND',
        message: 'The order was not found in this store.',
      });
    }
  }

  private async renderDocuments(
    documents: Array<{ companyId: string; document: DeliveryLabelDocument }>,
    eligible: ScopedOrder[],
    failed: Array<DeliveryLabelFailure & { orderId: string; companyId: string }>,
    deadline: number,
  ): Promise<RenderedDocument[]> {
    const results: RenderedDocument[] = [];
    const concurrency = this.renderConcurrency();

    for (let start = 0; start < documents.length; start += concurrency) {
      if (Date.now() > deadline) {
        for (const item of documents.slice(start)) {
          this.failDocument(
            item.companyId,
            item.document,
            eligible,
            failed,
            'ORDER_LABEL_JOB_TIMEOUT',
            'Label generation took too long. Retry with a smaller selection.',
          );
        }
        break;
      }
      const chunk = documents.slice(start, start + concurrency);
      const rendered = await Promise.all(
        chunk.map(async (item) => {
          try {
            return {
              ...item,
              orderNo: item.document.orderNo,
              rendered: await this.renderer.render(item.document),
            } satisfies RenderedDocument;
          } catch {
            return { ...item, rendered: null };
          }
        }),
      );

      for (const item of rendered) {
        if (item.rendered) {
          results.push(item);
        } else {
          this.failDocument(
            item.companyId,
            item.document,
            eligible,
            failed,
            'ORDER_LABEL_RENDER_FAILED',
            'The label could not be rendered.',
          );
        }
      }
    }

    return results;
  }

  private buildPrinted(
    successful: RenderedDocument[],
    eligible: ScopedOrder[],
    pagesByOrder: Map<string, number>,
  ): OrderLabelPrintedEntry[] {
    const byOrderNo = new Map(eligible.map((order) => [order.orderNo, order]));
    const printed = new Map<string, OrderLabelPrintedEntry>();

    for (const item of successful) {
      const orderNos = item.document.orderNos?.length
        ? item.document.orderNos
        : [item.document.orderNo];
      const trackings = item.document.trackingNumbers?.length
        ? item.document.trackingNumbers
        : [item.document.trackingNumber];

      orderNos.forEach((orderNo, index) => {
        const order = byOrderNo.get(orderNo);
        if (!order || printed.has(orderNo)) return;
        printed.set(orderNo, {
          orderId: order.id,
          orderNo,
          companyId: item.companyId,
          trackingNumber: trackings[index] ?? trackings[0] ?? '',
          pages: Math.max(1, pagesByOrder.get(orderNo) ?? 1),
        });
      });
    }

    return [...printed.values()].sort((a, b) => a.orderNo.localeCompare(b.orderNo));
  }

  private mapScaleWarnings(
    warnings: Array<{ orderNo: string; code: string; message: string; scale?: number }>,
    eligible: ScopedOrder[],
  ): OrderLabelManifestWarning[] {
    const byOrderNo = new Map(eligible.map((order) => [order.orderNo, order]));
    return warnings.map((warning) => ({
      orderId: byOrderNo.get(warning.orderNo)?.id,
      orderNo: warning.orderNo,
      code: warning.code,
      message: warning.message,
    }));
  }

  private failDocument(
    companyId: string,
    document: DeliveryLabelDocument,
    eligible: ScopedOrder[],
    failed: Array<DeliveryLabelFailure & { orderId: string; companyId: string }>,
    code: string,
    message: string,
  ): void {
    const orderNos = document.orderNos?.length ? document.orderNos : [document.orderNo];
    for (const orderNo of orderNos) {
      const order = eligible.find((candidate) => candidate.orderNo === orderNo);
      if (!order) continue;
      failed.push({
        ...this.failure(order, code, message, true),
        orderId: order.id,
        companyId,
      });
    }
  }

  private failDocumentOrders(
    item: RenderedDocument,
    eligible: ScopedOrder[],
    failed: Array<DeliveryLabelFailure & { orderId: string; companyId: string }>,
    code: string,
    message: string,
  ): void {
    this.failDocument(item.companyId, item.document, eligible, failed, code, message);
  }

  private mergePages(target: Map<string, number>, source: Map<string, number>): void {
    for (const [orderNo, pages] of source) {
      target.set(orderNo, (target.get(orderNo) ?? 0) + pages);
    }
  }

  private skip(
    order: Pick<ScopedOrder, 'id' | 'orderNo' | 'companyId'>,
    code: string,
    message: string,
  ): OrderLabelSkippedEntry {
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      companyId: order.companyId || null,
      code,
      message,
    };
  }

  private failure(
    order: Pick<ScopedOrder, 'orderNo' | 'trackingNumber'>,
    code: string,
    message: string,
    retryable: boolean,
  ): DeliveryLabelFailure {
    return {
      orderNo: order.orderNo,
      trackingNumber: order.trackingNumber,
      code,
      message,
      retryable,
    };
  }

  private statusSlug(status: any): string {
    if (!status) return OrderStatus.PLACED;
    if (typeof status === 'string') return status;
    return String(status.slug ?? OrderStatus.PLACED);
  }

  private async resolveDownloadStore(user: RequestUser, storeId?: string): Promise<any> {
    if (user.role === Role.ADMIN) {
      if (!storeId || !Types.ObjectId.isValid(storeId)) {
        throw new AppException(AppErrorCode.ORDER_LABEL_ARTIFACT_NOT_FOUND);
      }
      const store = await this.storesService
        .findOne(storeId, { skipStatusCheck: true })
        .catch(() => null);
      if (!store) {
        throw new AppException(AppErrorCode.ORDER_LABEL_ARTIFACT_NOT_FOUND);
      }
      return store;
    }
    return this.storesService.findByVendorIdOrThrow(user.id);
  }

  private validateRequest(dto: GenerateOrderLabelsDto): void {
    if (!ORDER_LABEL_FORMATS.includes(dto.format)) {
      throw new AppException(AppErrorCode.ORDER_LABEL_INVALID_FORMAT, { format: dto.format });
    }
    if (!ORDER_LABEL_GROUPINGS.includes(dto.grouping)) {
      throw new AppException(AppErrorCode.ORDER_LABEL_INVALID_GROUPING, {
        grouping: dto.grouping,
      });
    }
  }

  private assertEnabled(): void {
    if (!this.config.get<boolean>('orderLabels.enabled')) {
      throw new AppException(AppErrorCode.ORDER_LABEL_DISABLED);
    }
  }

  private maxOrders(): number {
    return this.numberConfig('orderLabels.maxOrders', 100, 1, 100);
  }

  private renderConcurrency(): number {
    return this.numberConfig('orderLabels.renderConcurrency', 2, 1, 5);
  }

  private jobTimeoutMs(): number {
    return this.numberConfig('orderLabels.jobTimeoutMs', 90000, 1000, 300000);
  }

  private artifactTtlHours(): number {
    return this.numberConfig('orderLabels.artifactTtlHours', 24, 1, 168);
  }

  private numberConfig(key: string, fallback: number, min: number, max: number): number {
    const value = Number(this.config.get(key));
    if (!Number.isFinite(value) || value < min || value > max) return fallback;
    return Math.floor(value);
  }

  private carrierErrorMessage(err: unknown): string {
    if (err instanceof AppException) {
      switch (err.errorCode) {
        case AppErrorCode.DELIVERY_API_TIMEOUT:
          return 'The carrier timed out while generating labels.';
        case AppErrorCode.DELIVERY_API_RATE_LIMITED:
          return 'The carrier rate limit was reached. Retry in a few minutes.';
        case AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED:
          return 'Carrier credentials are not configured for this store.';
        case AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER:
          return 'The carrier could not find one of the parcels.';
        default:
          return 'The carrier could not generate the labels.';
      }
    }
    return 'The carrier could not generate the labels.';
  }

  private artifactName(file: OrderLabelArtifactFile): string {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 14);
    return `order-labels-${stamp}.${file === 'labels.zip' ? 'zip' : 'pdf'}`;
  }

  private safeFileName(value: string): string {
    return value.replace(/[^a-z0-9._-]+/gi, '-');
  }

  private zip(entries: Array<{ name: string; buffer: Buffer }>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const createArchive = archiver as unknown as (
        format: string,
        options?: Record<string, unknown>,
      ) => any;
      const archive = createArchive('zip', { zlib: { level: 9 } });
      const chunks: Buffer[] = [];
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('warning', (err) => {
        if ((err as { code?: string }).code !== 'ENOENT') reject(err);
      });
      archive.on('error', reject);
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      for (const entry of entries) {
        archive.append(entry.buffer, { name: entry.name });
      }
      void archive.finalize();
    });
  }
}
