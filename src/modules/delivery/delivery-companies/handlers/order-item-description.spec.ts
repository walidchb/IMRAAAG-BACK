import { describeOrderItem, describeOrderItems } from './order-item-description';

function item(overrides: Record<string, unknown> = {}): any {
  return {
    productId: 'p-1',
    productName: 'Robe',
    quantity: 2,
    price: 1200,
    ...overrides,
  };
}

function snapshotOptions(values: string[]): any {
  return {
    options: values.map((valueName) => ({
      optionKey: valueName.toLowerCase(),
      optionName: valueName,
      value: valueName.toLowerCase(),
      valueName,
    })),
    label: values.join(' / '),
  };
}

describe('describeOrderItem', () => {
  it('prefixes the quantity and keeps the product name when there is no variant', () => {
    expect(describeOrderItem(item())).toBe('2 x Robe');
  });

  it('appends each variant value in its own parentheses from the snapshot', () => {
    expect(
      describeOrderItem(item({ variantSnapshot: snapshotOptions(['Rouge', 'M']) })),
    ).toBe('2 x Robe (Rouge) (M)');
  });

  it('falls back to the legacy variantDetails label when there is no snapshot', () => {
    expect(describeOrderItem(item({ variantDetails: 'Noir / 42' }))).toBe(
      '2 x Robe (Noir) (42)',
    );
  });

  it('prefers the structured snapshot when both shapes are present', () => {
    expect(
      describeOrderItem(
        item({ variantDetails: 'ignored', variantSnapshot: snapshotOptions(['Bleu']) }),
      ),
    ).toBe('2 x Robe (Bleu)');
  });

  it('falls back to the product id when the line has no product name', () => {
    expect(describeOrderItem(item({ productName: '', productId: 'p-9' }))).toBe(
      '2 x Product p-9',
    );
  });

  it('defaults a missing quantity to one', () => {
    expect(describeOrderItem(item({ quantity: undefined }))).toBe('1 x Robe');
  });
});

describe('describeOrderItems', () => {
  it('joins every line with a comma', () => {
    const order = {
      orderNo: '000001',
      items: [
        item({ variantSnapshot: snapshotOptions(['Rouge', 'M']) }),
        item({ productName: 'Chaussures', quantity: 1, variantDetails: 'Noir' }),
      ],
    } as any;

    expect(describeOrderItems(order)).toBe('2 x Robe (Rouge) (M), 1 x Chaussures (Noir)');
  });

  it('falls back to the order number when there are no lines', () => {
    expect(describeOrderItems({ orderNo: '000002', items: [] } as any)).toBe('Order 000002');
  });
});
