/**
 * The Needs-you list's shape, order and words [FPL:REQ-011, REQ-012, REQ-018, REQ-036]: what every surface (the terminal,
 * `/sf-inbox`, the VS Code tab and its badge) reads the same way. No I/O and no engine imports, so painting from what is
 * kept loads nothing else (src/needs-you.mjs `--offline`).
 */

export const NEEDS_YOU_RESULT = 'sflow-needs-you';
export const NEEDS_YOU_CARD_RESULT = 'sflow-needs-you-card';
export const NEEDS_YOU_KINDS = Object.freeze(['step-approval', 'workflow-decision', 'decision', 'next-version', 'intake', 'review',
  'initiative-approval']);
/** In this order: what holds work, then what the team's configuration waits for, then what can wait [FPL:REQ-011]. */
export const NEEDS_YOU_GROUPS = Object.freeze(['holds-work', 'reviews', 'later']);
/** The badge counts these; Later is not counted [FPL:REQ-018]. */
export const BADGE_GROUPS = Object.freeze(['holds-work', 'reviews']);
/** More than this shows the first ones and "Show N more" [FPL:REQ-017]. */
export const LIST_LIMIT = 50;

/**
 * The decision-list kinds that wait for the step's approval, never its submission (decision-list.mjs LATER_KINDS): they
 * go to Later. A copy so this module loads nothing; test/fpl-needs-you.test.mjs holds it equal to the list's own.
 */
export const LATER_DECISION_KINDS = Object.freeze(['owed-decision', 'departure', 'asked-for']);

export const COULD_NOT_TELL = 'SFlow could not tell whether this one is yours';

/** A key that names the item the same way on every read: repository, Story, kind and what it is about. */
export function itemKey(...parts) {
  return parts.filter((part) => part != null && part !== '').map((part) => String(part).replace(/[^A-Za-z0-9._/@-]+/gu, '-')).join(':');
}

/** "version 2" from the second version on: the first is just the step. */
export function stepWords(label, version) {
  return Number(version) > 1 ? `${label} version ${Number(version)}` : label;
}

/** Times a person reads aloud [FPL:REQ-036]: "10:42" today, "yesterday", "Monday" this week, else "12 Nov". */
export function timeWords(at, now = new Date()) {
  const when = new Date(at ?? '');
  if (Number.isNaN(when.getTime())) return null;
  const day = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(when)) / 86_400_000);
  if (days <= 0) return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  if (days === 1) return 'yesterday';
  if (days < 7) return when.toLocaleDateString('en-GB', { weekday: 'long' });
  return when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** A count a person reads aloud: "1 thing needs you", "3 things need you". */
export function countWords(count) {
  return count === 1 ? '1 thing needs you' : `${count} things need you`;
}

/**
 * The one order [FPL:REQ-011]: Holds work, then Reviews, then Later. Holds work and Reviews oldest first; Later soonest
 * expiry first, then oldest. Ties by repository name, then Story ID, then the item's key.
 */
export function orderItems(items) {
  const rank = (item) => NEEDS_YOU_GROUPS.indexOf(item.group);
  const time = (value) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER; };
  return [...items].sort((left, right) => rank(left) - rank(right)
    || (left.group === 'later' ? time(left.expires) - time(right.expires) : 0)
    || time(left.waitingSince) - time(right.waitingSince)
    || String(left.repository?.name ?? '').localeCompare(String(right.repository?.name ?? ''))
    || String(left.story?.id ?? '').localeCompare(String(right.story?.id ?? ''))
    || left.key.localeCompare(right.key));
}

/** The counts every surface shows: each group, and the badge (Holds work plus Reviews) [FPL:REQ-018]. */
export function itemCounts(items) {
  const counts = Object.fromEntries(NEEDS_YOU_GROUPS.map((group) => [group, items.filter((item) => item.group === group).length]));
  const badge = BADGE_GROUPS.reduce((total, group) => total + counts[group], 0);
  return { ...counts, badge, total: items.length,
    badgeTooltip: countWords(badge), badgeLabel: `Needs you: ${badge} waiting` };
}
