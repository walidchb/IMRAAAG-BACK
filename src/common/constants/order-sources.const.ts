/**
 * Sales channel for an order.
 *
 * `ONLINE`  - placed through the storefront (guest or signed-in customer).
 * `MANUAL`  - entered by the vendor from the dashboard order form.
 * `POS`     - an in-store, over-the-counter sale (see the POS module).
 *
 * The value is always set by the server from the request context; it is never taken from the
 * client, so a caller cannot label an order as belonging to a channel it did not use.
 */
export enum OrderSource {
  ONLINE = 'ONLINE',
  POS = 'POS',
  MANUAL = 'MANUAL',
}

export const ORDER_SOURCE_VALUES: string[] = Object.values(OrderSource);
