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

  it('renders the value only (option names omitted) for a real option', () => {
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameEn: 'Size', key: 'size' }),
      values({ _id: 'v1', optionId: 'o1', value: 'small', valueEn: 'Small' }),
    );
    expect(label).toBe('Small');
  });

  it('orders parts by id and joins with " / ", option names omitted', () => {
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
    expect(label).toBe('Red / S');
  });

  it('names the auto-seeded scaffold with the option alone', () => {
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameEn: 'Default', key: 'default', isDefault: true }),
      values({ _id: 'v1', optionId: 'o1', value: 'default', valueEn: 'One Size' }),
    );
    expect(label).toBe('Default');
  });

  it('renders the value when a default scaffold was repurposed as a real option', () => {
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameEn: 'size', nameAr: 'القياس', key: 'default', isDefault: true }),
      values({ _id: 'v1', optionId: 'o1', value: 'default', valueEn: 'S' }),
      'ar',
    );
    // Repurposed scaffold: value is no longer the untouched One Size combo.
    expect(label).toBe('S');
  });

  it("keeps the value for a seller's own option named Default", () => {
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameEn: 'Default', key: 'default' }),
      values({ _id: 'v1', optionId: 'o1', value: 'a', valueEn: 'A' }),
    );
    // Option names are omitted across the board; option key alone wins only for the untouched scaffold.
    expect(label).toBe('A');
  });

  it('falls back to the raw value slug and skips unknown ids', () => {
    const label = buildVariantLabel(
      ['v1', 'missing'],
      options({ _id: 'o1', nameEn: '', key: 'size' }),
      values({ _id: 'v1', optionId: 'o1', value: 'small', valueEn: null }),
    );
    // Option name is omitted; the value falls back to its raw slug "small".
    expect(label).toBe('small');
  });

  it('renders the requested locale for the value (option name omitted)', () => {
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameEn: 'Size', nameFr: 'Taille', nameAr: 'المقاس', key: 'size' }),
      values({
        _id: 'v1',
        optionId: 'o1',
        value: 'small',
        valueEn: 'Small',
        valueFr: 'Petit',
        valueAr: 'صغير',
      }),
      'ar',
    );
    // Option names are now omitted, so the Arabic value is rendered on its own.
    expect(label).toBe('صغير');
  });

  it('renders the requested locale for both the option and the value', () => {
    // Deprecated alias kept only so caller code that still names the option in a custom
    // view does not break; the shared inventory list no longer depends on it.
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameEn: 'Size', nameFr: 'Taille', nameAr: 'المقاس', key: 'size' }),
      values({
        _id: 'v1',
        optionId: 'o1',
        value: 'small',
        valueEn: 'Small',
        valueFr: 'Petit',
        valueAr: 'صغير',
      }),
      'ar',
    );
    expect(label).toBe('صغير');
  });

  it('falls back to translated value names (option names omitted) when a locale is missing', () => {
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameEn: 'Size', nameFr: 'Taille', key: 'size' }),
      values({ _id: 'v1', optionId: 'o1', value: 'small', valueEn: 'Small' }),
      'ar',
    );
    // No Arabic value name, so it falls back to English "Small" — option name is omitted.
    expect(label).toBe('Small');
  });

  it('falls back across locales before the raw slug, option name omitted', () => {
    const label = buildVariantLabel(
      ['v1'],
      options({ _id: 'o1', nameAr: 'المقاس', key: 'size' }),
      values({ _id: 'v1', optionId: 'o1', value: 'small', valueFr: 'Petit' }),
      'fr',
    );
    // Arabic option name is skipped (option names omitted); value falls back Arabic → English → French "Petit".
    expect(label).toBe('Petit');
  });
});
