import { StoreMemberStatus, StoreRole } from '../../../common/constants/store-roles.enum';

/**
 * Pure Team Analytics rules.
 *
 * The cohort is defined by the **confirmation** event: an order is credited to the member who
 * confirmed it, and delivered/returned are eventual outcomes of that cohort. Outcomes are read
 * from the order history (current status only as the `returned` fallback) so a POS sale that is
 * created at `delivered` still counts as confirmed, and a delivered-then-returned order counts
 * as returned only. Each order contributes at most once to each counter.
 */

/** Roles that appear as subjects of the report. `OWNER` and `INVENTORY_STAFF` are excluded. */
export const TEAM_REPORT_ROLES: readonly StoreRole[] = [
  StoreRole.PARTNER,
  StoreRole.ORDER_CONFIRMER,
  StoreRole.CASHIER,
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type TeamOrderOutcome = 'delivered' | 'returned' | 'neither';

export interface TeamOutcomeInput {
  statusSlug?: string | null;
  historySlugs?: readonly (string | null | undefined)[] | null;
}

export interface TeamOrderAttribution {
  _id: string;
  /** `confirmedBy` or the first `confirmed` history actor: `Name (email)` or bare email. */
  confirmerLabel?: string | null;
  /** Optional hardened attribution key (Phase 4); absent on legacy orders. */
  confirmedByUserId?: string | null;
  statusSlug?: string | null;
  historySlugs?: readonly (string | null | undefined)[] | null;
}

export interface TeamMemberAttribution {
  memberId: string;
  userId: string;
  fullName: string;
  email: string | null;
  role: StoreRole;
  status: StoreMemberStatus;
}

export interface TeamMemberPerformance extends TeamMemberAttribution {
  confirmed: number;
  delivered: number;
  returned: number;
}

/**
 * Parse the login email out of an actor label.
 *
 * Accepts `Name (email)`, a bare `email`, and names that themselves contain parentheses — the
 * last balanced `(...)` that parses as an email wins. Returns `null` for `'Vendor'`, carrier
 * names, and anything else that carries no email.
 */
export function extractConfirmerEmail(label?: string | null): string | null {
  if (!label) return null;
  const text = String(label).trim();
  if (!text) return null;

  const candidates: string[] = [];
  const pattern = /\(([^()]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    candidates.push(match[1].trim());
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (EMAIL_PATTERN.test(candidates[i])) return candidates[i];
  }

  return EMAIL_PATTERN.test(text) ? text : null;
}

/** `returned` beats `delivered`; delivered is read from history, never from current status. */
export function classifyOutcome(input: TeamOutcomeInput): TeamOrderOutcome {
  const history = (input.historySlugs ?? []).filter(
    (slug): slug is string => typeof slug === 'string' && slug.length > 0,
  );
  const hasReturned = input.statusSlug === 'returned' || history.includes('returned');
  if (hasReturned) return 'returned';
  return history.includes('delivered') ? 'delivered' : 'neither';
}

/**
 * Reduce the cohort orders to one zero-filled row per eligible member.
 *
 * Attribution prefers `confirmedByUserId`, then the email embedded in the label, then an exact
 * (case-insensitive) label match. Unresolvable labels are not attributed. Input order rows are
 * deduped by `_id`.
 */
export function buildTeamPerformance(
  orders: readonly TeamOrderAttribution[],
  members: readonly TeamMemberAttribution[],
): TeamMemberPerformance[] {
  const rows = members
    .filter((member) => TEAM_REPORT_ROLES.includes(member.role))
    .map<TeamMemberPerformance>((member) => ({
      ...member,
      confirmed: 0,
      delivered: 0,
      returned: 0,
    }));

  const byUserId = new Map<string, TeamMemberPerformance>();
  const byEmail = new Map<string, TeamMemberPerformance>();
  const byLabel = new Map<string, TeamMemberPerformance>();

  for (const row of rows) {
    byUserId.set(String(row.userId), row);
    const name = (row.fullName ?? '').trim().toLowerCase();
    if (name) byLabel.set(name, row);
    const email = (row.email ?? '').trim().toLowerCase();
    if (email) {
      byEmail.set(email, row);
      byLabel.set(email, row);
    }
  }

  const seen = new Set<string>();
  for (const order of orders) {
    const key = String(order._id);
    if (seen.has(key)) continue;
    seen.add(key);

    const member = resolveMember(order, byUserId, byEmail, byLabel);
    if (!member) continue;

    member.confirmed += 1;
    const outcome = classifyOutcome(order);
    if (outcome === 'delivered') member.delivered += 1;
    else if (outcome === 'returned') member.returned += 1;
  }

  return rows.sort(
    (a, b) =>
      b.confirmed - a.confirmed ||
      b.delivered - a.delivered ||
      a.fullName.localeCompare(b.fullName),
  );
}

function resolveMember(
  order: TeamOrderAttribution,
  byUserId: Map<string, TeamMemberPerformance>,
  byEmail: Map<string, TeamMemberPerformance>,
  byLabel: Map<string, TeamMemberPerformance>,
): TeamMemberPerformance | null {
  if (order.confirmedByUserId) {
    const byId = byUserId.get(String(order.confirmedByUserId));
    if (byId) return byId;
  }

  const email = extractConfirmerEmail(order.confirmerLabel);
  if (email) {
    const byMail = byEmail.get(email.toLowerCase());
    if (byMail) return byMail;
  }

  const label = (order.confirmerLabel ?? '').trim().toLowerCase();
  return label ? byLabel.get(label) ?? null : null;
}
