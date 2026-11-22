import { StoreMemberStatus, StoreRole } from '../../../common/constants/store-roles.enum';
import {
  TeamMemberAttribution,
  TeamOrderAttribution,
  buildTeamPerformance,
  classifyOutcome,
  extractConfirmerEmail,
} from './team-attribution';

function member(overrides: Partial<TeamMemberAttribution> = {}): TeamMemberAttribution {
  return {
    memberId: 'm1',
    userId: 'u1',
    fullName: 'Nadia Benali',
    email: 'nadia@shop.test',
    role: StoreRole.ORDER_CONFIRMER,
    status: StoreMemberStatus.ACTIVE,
    ...overrides,
  };
}

function order(overrides: Partial<TeamOrderAttribution> = {}): TeamOrderAttribution {
  return {
    _id: 'o1',
    confirmerLabel: 'Nadia Benali (nadia@shop.test)',
    ...overrides,
  };
}

describe('extractConfirmerEmail', () => {
  it('parses Name (email) and a bare email', () => {
    expect(extractConfirmerEmail('Nadia Benali (nadia@shop.test)')).toBe('nadia@shop.test');
    expect(extractConfirmerEmail('nadia@shop.test')).toBe('nadia@shop.test');
  });

  it('prefers the last balanced parentheses that is an email', () => {
    expect(extractConfirmerEmail('Nadia (Ops) (nadia@shop.test)')).toBe('nadia@shop.test');
  });

  it('returns null for names without an email', () => {
    expect(extractConfirmerEmail('Vendor')).toBeNull();
    expect(extractConfirmerEmail('Nadia (Ops)')).toBeNull();
    expect(extractConfirmerEmail(null)).toBeNull();
  });
});

describe('classifyOutcome', () => {
  it('reads delivered from history', () => {
    expect(classifyOutcome({ statusSlug: 'delivered', historySlugs: ['confirmed', 'delivered'] })).toBe(
      'delivered',
    );
  });

  it('treats returned as terminal even when delivered was recorded', () => {
    expect(
      classifyOutcome({ statusSlug: 'returned', historySlugs: ['confirmed', 'delivered', 'returned'] }),
    ).toBe('returned');
  });

  it('falls back to the bare status slug for returned', () => {
    expect(classifyOutcome({ statusSlug: 'returned', historySlugs: [] })).toBe('returned');
  });

  it('returns neither for a confirmed-only order', () => {
    expect(classifyOutcome({ statusSlug: 'confirmed', historySlugs: ['placed', 'confirmed'] })).toBe(
      'neither',
    );
  });
});

describe('buildTeamPerformance', () => {
  it('counts an order once despite duplicate confirmed history entries', () => {
    const rows = buildTeamPerformance(
      [order({ historySlugs: ['confirmed', 'confirmed'] })],
      [member()],
    );
    expect(rows[0].confirmed).toBe(1);
    expect(rows[0].delivered).toBe(0);
    expect(rows[0].returned).toBe(0);
  });

  it('dedupes the same order id', () => {
    const rows = buildTeamPerformance([order(), order()], [member()]);
    expect(rows[0].confirmed).toBe(1);
  });

  it('credits the confirmer even when another actor delivered', () => {
    const rows = buildTeamPerformance(
      [
        order({
          confirmerLabel: 'Nadia Benali (nadia@shop.test)',
          historySlugs: ['confirmed', 'delivered'],
        }),
      ],
      [member(), member({ memberId: 'm2', userId: 'u2', fullName: 'Karim', email: 'karim@shop.test' })],
    );
    const nadia = rows.find((r) => r.email === 'nadia@shop.test')!;
    const karim = rows.find((r) => r.email === 'karim@shop.test')!;
    expect(nadia.confirmed).toBe(1);
    expect(nadia.delivered).toBe(1);
    expect(karim.confirmed).toBe(0);
  });

  it('counts a POS sale (delivered + synthetic confirmed) as confirmed and delivered', () => {
    const rows = buildTeamPerformance(
      [order({ statusSlug: 'delivered', historySlugs: ['placed', 'confirmed', 'dispatched', 'delivered'] })],
      [member()],
    );
    expect(rows[0]).toMatchObject({ confirmed: 1, delivered: 1, returned: 0 });
  });

  it('honours delivered + returned <= confirmed and returned beats delivered', () => {
    const rows = buildTeamPerformance(
      [
        order({ _id: 'a', statusSlug: 'delivered', historySlugs: ['confirmed', 'delivered'] }),
        order({ _id: 'b', statusSlug: 'returned', historySlugs: ['confirmed', 'delivered', 'returned'] }),
        order({ _id: 'c', historySlugs: ['confirmed'] }),
      ],
      [member()],
    );
    expect(rows[0]).toMatchObject({ confirmed: 3, delivered: 1, returned: 1 });
  });

  it('returns zero-filled rows for eligible members only', () => {
    const rows = buildTeamPerformance(
      [order({ confirmerLabel: 'Vendor' })],
      [
        member({ memberId: 'owner', userId: 'u-owner', role: StoreRole.OWNER }),
        member({ memberId: 'inv', userId: 'u-inv', role: StoreRole.INVENTORY_STAFF }),
        member({ memberId: 'part', userId: 'u-part', fullName: 'Partner', email: 'p@shop.test', role: StoreRole.PARTNER }),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberId: 'part', confirmed: 0, delivered: 0, returned: 0 });
  });

  it('prefers confirmedByUserId over the label', () => {
    const rows = buildTeamPerformance(
      [order({ confirmerLabel: 'Someone Else (other@shop.test)', confirmedByUserId: 'u1' })],
      [member()],
    );
    expect(rows[0].confirmed).toBe(1);
  });
});
