import { ProductSalesLine, rankProducts } from './product-ranking';

function line(overrides: Partial<ProductSalesLine> = {}): ProductSalesLine {
  return {
    orderId: 'order-1',
    productId: 'product-a',
    productName: 'Product A',
    image: null,
    quantity: 1,
    price: 100,
    ...overrides,
  };
}

describe('rankProducts', () => {
  it('returns nothing for an empty set', () => {
    expect(rankProducts([], { metric: 'units', limit: 5 })).toEqual({ items: [], total: 0 });
  });

  it('ranks a single line', () => {
    const result = rankProducts([line({ quantity: 3, price: 50 })], { metric: 'units', limit: 5 });
    expect(result.total).toBe(1);
    expect(result.items).toEqual([
      {
        productId: 'product-a',
        units: 3,
        sales: 150,
        orders: 1,
        snapshotName: 'Product A',
        snapshotImage: null,
      },
    ]);
  });

  it('rolls two variants of one product in one order into one row with orders = 1', () => {
    const result = rankProducts(
      [
        line({ orderId: 'order-1', quantity: 2, price: 100 }),
        line({ orderId: 'order-1', quantity: 3, price: 100 }),
      ],
      { metric: 'units', limit: 5 },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ units: 5, sales: 500, orders: 1 });
  });

  it('counts the same product in two orders as orders = 2', () => {
    const result = rankProducts(
      [line({ orderId: 'order-1' }), line({ orderId: 'order-2' })],
      { metric: 'units', limit: 5 },
    );
    expect(result.items[0]).toMatchObject({ units: 2, orders: 2 });
  });

  it('excludes lines with a missing or empty productId', () => {
    const result = rankProducts(
      [
        line({ productId: null }),
        line({ productId: '' }),
        line({ productId: 'product-b', quantity: 1 }),
      ],
      { metric: 'units', limit: 5 },
    );
    expect(result.total).toBe(1);
    expect(result.items[0].productId).toBe('product-b');
  });

  it('breaks a units tie by sales, then orders, then productId', () => {
    const result = rankProducts(
      [
        line({ productId: 'product-b', quantity: 2, price: 100, orderId: 'order-1' }),
        line({ productId: 'product-a', quantity: 2, price: 100, orderId: 'order-2' }),
        line({ productId: 'product-c', quantity: 2, price: 50, orderId: 'order-3' }),
      ],
      { metric: 'units', limit: 5 },
    );
    expect(result.items.map((row) => row.productId)).toEqual([
      'product-a',
      'product-b',
      'product-c',
    ]);
  });

  it('sorts by sales when the metric is sales', () => {
    const result = rankProducts(
      [
        line({ productId: 'product-a', quantity: 10, price: 10 }),
        line({ productId: 'product-b', quantity: 1, price: 500 }),
      ],
      { metric: 'sales', limit: 5 },
    );
    expect(result.items.map((row) => row.productId)).toEqual(['product-b', 'product-a']);
  });

  it('cuts to the limit while reporting the distinct total', () => {
    const result = rankProducts(
      [
        line({ productId: 'product-a', quantity: 3 }),
        line({ productId: 'product-b', quantity: 2 }),
        line({ productId: 'product-c', quantity: 1 }),
      ],
      { metric: 'units', limit: 2 },
    );
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((row) => row.productId)).toEqual(['product-a', 'product-b']);
  });
});
