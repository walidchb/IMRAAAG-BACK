import { buildVariantLabel, LabelOption, LabelValue } from './variant-label';

/**
 * The label is the single string three screens (matrix, inventory list, ledger) and POS all
 * render for a variant, so this covers the composition rule and the one special case: the
 * auto-seeded scaffold names itself with the option alone.
 */
describe('buildVariantLabel', () => {
  const options = (...items: LabelOption[]) =>
    new Map(items.map((o) => [String(o._id), o]));
  const values = (...items: LabelValue[]) =>
    new Map(items.map((v) => [String(v._id), v]));

  it('renders "<option>: <value>" for a real option', () => {
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameEn: 'Size', key: 'size' }),
      values({ _id: 'v1', optionId: 'o1', value: 'small', valueEn: 'Small' }),
    );
    expect(label).toBe('Size: Small');
  });

  it('orders parts by id and joins with " / "', () => {
    const label = buildVariantLabel(
      ['b', 'a'],
      options(
        { _id: 'o1', nameEn: 'Colour', key: 'colour' },
        { _id: 'o2', nameEn: 'Size', key: 'size' },
      ),
      values(
        { _id: 'a', optionId: 'o1', value: 'red', valueEn: 'Red' },
        { _id: 'b', optionId: 'o2', value: 's', valueEn: 'S' },
      ),
    );
    expect(label).toBe('Colour: Red / Size: S');
  });

  it('names the auto-seeded scaffold with the option alone', () => {
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameEn: 'Default', key: 'default', isDefault: true }),
      values({ _id: 'v1', optionId: 'o1', value: 'default', valueEn: 'One Size' }),
    );
    expect(label).toBe('Default');
  });

  it("keeps the value for a seller's own option named Default", () => {
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameEn: 'Default', key: 'default' }),
      values({ _id: 'v1', optionId: 'o1', value: 'a', valueEn: 'A' }),
    );
    expect(label).toBe('Default: A');
  });

  it('falls back to the raw value slug and skips unknown ids', () => {
    const label = buildVariantLabel(
      ['v1', 'missing'],
      options({ _id: 'o1', nameEn: '', key: 'size' }),
      values({ _id: 'v1', optionId: 'o1', value: 'small', valueEn: null }),
    );
    expect(label).toBe('size: small');
  });
});
