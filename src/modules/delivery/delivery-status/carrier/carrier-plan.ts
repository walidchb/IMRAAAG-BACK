import type { CarrierOrderSignal, DetectedCarrierOrderSignal } from './carrier-signal';

export type CarrierOrderTarget = 'in-transit' | 'delivered' | 'cancelled' | 'returned';

export interface CarrierOrderPlan {
  signal: CarrierOrderSignal;
  target: CarrierOrderTarget | null;
  steps: string[];
  inventoryAware: boolean;
}

export function planCarrierOrderAction(
  currentOrderSlug: unknown,
  signalOrDetection: CarrierOrderSignal | DetectedCarrierOrderSignal,
): CarrierOrderPlan {
  const signal =
    typeof signalOrDetection === 'string' ? signalOrDetection : signalOrDetection.signal;
  const current = String(currentOrderSlug ?? '').trim().toLowerCase();

  switch (signal) {
    case 'in_transit':
      return current === 'dispatched'
        ? { signal, target: 'in-transit', steps: ['in-transit'], inventoryAware: false }
        : { signal, target: null, steps: [], inventoryAware: false };

    case 'delivered':
      if (current === 'dispatched') {
        return {
          signal,
          target: 'delivered',
          steps: ['in-transit', 'delivered'],
          inventoryAware: false,
        };
      }
      if (current === 'in-transit') {
        return { signal, target: 'delivered', steps: ['delivered'], inventoryAware: false };
      }
      return { signal, target: null, steps: [], inventoryAware: false };

    case 'cancelled':
      if (['placed', 'confirmed', 'dispatched', 'in-transit'].includes(current)) {
        return { signal, target: 'cancelled', steps: ['cancelled'], inventoryAware: true };
      }
      return { signal, target: null, steps: [], inventoryAware: signal === 'cancelled' };

    case 'returned':
      if (['dispatched', 'in-transit', 'delivered'].includes(current)) {
        return { signal, target: 'returned', steps: ['returned'], inventoryAware: false };
      }
      return { signal, target: null, steps: [], inventoryAware: false };

    case 'none':
    default:
      return { signal: 'none', target: null, steps: [], inventoryAware: false };
  }
}
