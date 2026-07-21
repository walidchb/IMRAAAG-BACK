import { Injectable, BadRequestException } from '@nestjs/common';
import { ORDER_STATUSES, ORDER_STATUS_TRANSITIONS, ORDER_STATUS_VALUES, StatusConfig } from '../../common/constants/order-statuses.const';

@Injectable()
export class OrderStatusesService {
  getAll(): StatusConfig[] {
    return ORDER_STATUSES;
  }

  getBySlug(slug: string): StatusConfig | undefined {
    return ORDER_STATUSES.find(s => s.slug === slug);
  }

  getById(id: string): StatusConfig | undefined {
    return ORDER_STATUSES.find(s => s._id === id || s.slug === id);
  }

  getAllAsMap(): { slugToId: Map<string, string>; idToSlug: Map<string, string> } {
    const slugToId = new Map<string, string>();
    const idToSlug = new Map<string, string>();
    for (const s of ORDER_STATUSES) {
      slugToId.set(s.slug, s._id);
      idToSlug.set(s._id, s.slug);
    }
    return { slugToId, idToSlug };
  }

  getTransitions(): Record<string, string[]> {
    return ORDER_STATUS_TRANSITIONS;
  }

  validateTransition(currentSlug: string, nextSlug: string): void {
    const allowed = ORDER_STATUS_TRANSITIONS[currentSlug];
    if (!allowed || !allowed.includes(nextSlug)) {
      throw new BadRequestException(
        `Cannot transition order from '${currentSlug}' to '${nextSlug}'. Allowed transitions: ${(allowed || []).join(', ') || 'none'}`,
      );
    }
  }
}
