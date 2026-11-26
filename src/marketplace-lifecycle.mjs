/**
 * One lifecycle vocabulary for marketplace items [OMK:REQ-002, REQ-003, REQ-010, docs/SPEC-OMK-ORG-MARKETPLACE-v1.md
 * §4.2, §5.1]: its states, the marketplace's own words for each, the moves allowed between them, what a task and an
 * install do in each, the words a person reads, and the checks on a lifecycle record.
 *
 * | State      | The marketplace's words                     | A task offers it      | Installed |
 * |------------|---------------------------------------------|-----------------------|-----------|
 * | proposed   | proposed, draft, submitted                  | after the person's yes | yes      |
 * | early      | experimental, beta, alpha, preview, early   | after the person's yes | yes      |
 * | approved   | approved                                    | yes                   | yes       |
 * | ga         | ga, released, stable, generally-available   | yes                   | yes       |
 * | deprecated | deprecated                                  | never                 | yes       |
 * | retired    | retired, withdrawn, archived                | never                 | no        |
 * | unmarked   | (none)                                      | a marketplace item after a yes; a library skill written here as it is | yes |
 *
 * An item's lifecycle comes from the first of: `lifecycle.yml` beside its apm.yml, a `lifecycle:` mapping in its
 * apm.yml, its apm.yml's `lifecycle-state`, a `lifecycle:` tag, or nothing. A record is data: SFlow checks that it holds
 * together and never refuses an item for it; each problem is a marketplace-owned finding (MCR's shape).
 *
 * task-skills.mjs, task-agents.mjs, marketplace-catalog.mjs, skill-catalog.mjs, conversion-review.mjs and
 * agent-workflow.mjs all read this module. Pure.
 */

export const LIFECYCLE_STATES = Object.freeze(['proposed', 'early', 'approved', 'ga', 'deprecated', 'retired']);
export const LIFECYCLE_RECORD_FILE = 'lifecycle.yml';
export const LIFECYCLE_LIMITS = Object.freeze({ entries: 50, entry: 1000, bytes: 64 * 1024 });

const WORDS = Object.freeze({
  proposed: ['proposed', 'draft', 'submitted'],
  early: ['early', 'experimental', 'beta', 'alpha', 'preview'],
  approved: ['approved'],
  ga: ['ga', 'released', 'stable', 'generally-available'],
  deprecated: ['deprecated'],
  retired: ['retired', 'withdrawn', 'archived']
});
const STATE_OF = new Map(Object.entries(WORDS).flatMap(([state, words]) => words.map((word) => [word, state])));
/** The moves a record may make; early moves as proposed does [§5.1]. */
const MOVES = Object.freeze({ proposed: ['approved', 'retired'], approved: ['ga', 'deprecated', 'proposed'], ga: ['deprecated'],
  deprecated: ['ga', 'retired'], retired: [] });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const HTTPS = /^https:\/\/[^\s/@?#]+(?::\d+)?(?:\/[^\s]*)?$/u;
const listWords = (items, last = 'and') => (items.length > 1 ? `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}` : items[0] ?? '');

/** The state a marketplace's word means, or null for none or a word SFlow does not know. */
export function lifecycleStateOf(word) {
  const key = String(word ?? '').trim().toLowerCase();
  return LIFECYCLE_STATES.includes(key) ? key : STATE_OF.get(key) ?? null;
}

/** Whether a tag or word is one of the lifecycle words (so a tag `beta` is a mark, not what a skill is about). */
export const isLifecycleWord = (word) => lifecycleStateOf(word) !== null;

/**
 * What a task does with an item in `state`: offers it (`ready`), only after the person's yes (`unreviewed`), or never
 * (`retired`, which deprecated is too). An unmarked item from a marketplace needs a yes; a library skill written here,
 * or an agent (whose plan is always asked), is used as it is, as before [§5.1].
 */
export function lifecycleReadiness(state, { unmarked = 'unreviewed' } = {}) {
  const known = lifecycleStateOf(state);
  if (known === 'deprecated' || known === 'retired') return 'retired';
  if (known === 'approved' || known === 'ga') return 'ready';
  if (known === 'proposed' || known === 'early') return 'unreviewed';
  return unmarked;
}

/** Whether an item in this state can be installed: all but a retired one [§5.1]. */
export const lifecycleInstallable = (state) => lifecycleStateOf(state) !== 'retired';

/** Whether a record may move from `from` to `to`; any other move is a jump, shown and never refused [§5.1]. */
export function lifecycleMoveAllowed(from, to) {
  const as = (state) => (state === 'early' ? 'proposed' : state);
  const left = as(lifecycleStateOf(from)); const right = as(lifecycleStateOf(to));
  if (!left || !right) return true;
  return left === right || (MOVES[left] ?? []).includes(right);
}

/** A date as a person reads it: 14 Sep 2026. */
export function dayWords(date) {
  const match = DATE.exec(String(date ?? ''));
  return match ? `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}` : null;
}

// ---------------------------------------------------------------------------------------------- reading a record

const text = (value, max = LIFECYCLE_LIMITS.entry) => {
  if (value == null || typeof value === 'object') return null;
  const result = String(value).replace(/\s+/gu, ' ').trim();
  return result ? result.slice(0, max) : null;
};
const names = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]).map((entry) => text(entry, 200)).filter(Boolean).slice(0, 20);
/** A date as YAML 1.1 or a string writes it, or null. */
function dateOf(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = text(value, 40);
  const match = raw ? /^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/u.exec(raw) : null;
  return match && !Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`)) ? match[1] : null;
}
const httpsAddress = (value) => { const raw = text(value, 500); return raw && HTTPS.test(raw) ? raw : null; };

/**
 * A lifecycle record as data: `{ word, state, history, deprecation, problems }`, or null when `value` is not a mapping.
 * `camel` reads an index's keys (approvedBy, replacedBy). Only the last 50 history entries are read; an entry's
 * text is cut to 1,000 characters. A problem is words; the checks below turn them into findings.
 */
export function parseLifecycleRecord(value, { camel = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const problems = [];
  const key = (kebab, camelKey) => value[camel ? camelKey : kebab] ?? value[kebab] ?? value[camelKey];
  const word = text(value.state, 40);
  const listed = Array.isArray(value.history) ? value.history : value.history == null ? [] : null;
  if (listed === null) problems.push('its history is not a list, so it is not read');
  if ((listed ?? []).length > LIFECYCLE_LIMITS.entries) problems.push(`it has ${listed.length} history entries; only the last ${LIFECYCLE_LIMITS.entries} are read`);
  const history = [];
  for (const raw of (listed ?? []).slice(-LIFECYCLE_LIMITS.entries)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push('a history entry is not a mapping, so it is left out'); continue; }
    const at = dateOf(raw.at);
    if (raw.at != null && !at) problems.push(`a history entry's date '${text(raw.at, 40)}' is not a date (YYYY-MM-DD)`);
    const change = text(raw.change, 500);
    if (change && !httpsAddress(change)) problems.push(`a history entry's change '${change.slice(0, 80)}' is not an https address, so it is not shown as a link`);
    const entry = {
      from: text(raw.from, 40), to: text(raw.to, 40), at,
      by: text(raw.by, 200), approvedBy: names(camel ? raw.approvedBy ?? raw['approved-by'] : raw['approved-by'] ?? raw.approvedBy),
      change: httpsAddress(change), note: text(raw.note)
    };
    // An entry is read at most 1,000 characters long: its note gives way first.
    if (JSON.stringify(entry).length > LIFECYCLE_LIMITS.entry) entry.note = entry.note ? entry.note.slice(0, Math.max(0, LIFECYCLE_LIMITS.entry - (JSON.stringify(entry).length - entry.note.length))) || null : null;
    history.push(entry);
  }
  const rawDeprecation = key('deprecation', 'deprecation');
  const deprecation = rawDeprecation && typeof rawDeprecation === 'object' && !Array.isArray(rawDeprecation) ? {
    replacedBy: text(camel ? rawDeprecation.replacedBy ?? rawDeprecation['replaced-by'] : rawDeprecation['replaced-by'] ?? rawDeprecation.replacedBy, 100),
    reason: text(rawDeprecation.reason), sunset: dateOf(rawDeprecation.sunset)
  } : null;
  return { word, state: lifecycleStateOf(word), history, deprecation, problems };
}

/** The entry that moved the record into its present state: the last whose `to` is that state. */
function arrival(record) {
  return [...(record?.history ?? [])].reverse().find((entry) => lifecycleStateOf(entry.to) === record.state) ?? null;
}

/**
 * An item's lifecycle as every surface shows it [OMK:REQ-002, REQ-015]: `{ state, word, source, since, by, change,
 * guarded, approvers, deprecation, words, guardWords }`, or null when nothing marks it. `file` is the parsed
 * lifecycle.yml, `mapping` an apm.yml `lifecycle:` mapping (both from parseLifecycleRecord), `state` its apm.yml's
 * lifecycle-state, `tags` its tags; `guard` is `{ covered, owners }` for the record's own file (codeowners.mjs), or null
 * when the marketplace cannot have code owners (an index). `owner` names who proposed it.
 */
export function itemLifecycle({ file = null, mapping = null, state = null, tags = [], index = null, guard = undefined, owner = null } = {}) {
  const tagged = (tags ?? []).map((tag) => String(tag)).find((tag) => /^lifecycle:/iu.test(tag))?.slice('lifecycle:'.length) ?? null;
  const [record, source] = index ? [index, 'index'] : file ? [file, 'lifecycle.yml'] : mapping ? [mapping, 'apm.yml'] : state ? [{ word: text(state, 40), state: lifecycleStateOf(state), history: [], deprecation: null }, 'lifecycle-state']
    : tagged ? [{ word: text(tagged, 40), state: lifecycleStateOf(tagged), history: [], deprecation: null }, 'tag'] : [null, null];
  if (!record || !record.word) return null;
  const moved = arrival(record);
  const by = moved ? (moved.approvedBy.length ? moved.approvedBy : moved.by ? [moved.by] : []) : [];
  // An index has no code owners to read, a tag is no record to guard, and a guard not read is not known.
  const guarded = source === 'index' || source === 'tag' || guard === null ? null : Boolean(guard?.covered);
  const approvers = guarded ? [...(guard.owners ?? [])] : [];
  const shape = { state: record.state, word: record.word, source, since: moved?.at ?? null, by, change: moved?.change ?? null, guarded, approvers,
    deprecation: record.deprecation ?? null, history: record.history ?? [] };
  return { ...shape, words: lifecycleWords(shape, { owner }), guardWords: guardWords(shape) };
}

/** The words a person reads for an item's lifecycle (§5.1's "A person sees"), with who and when where the record says. */
export function lifecycleWords(lifecycle, { owner = null } = {}) {
  if (!lifecycle?.word) return 'No lifecycle recorded';
  const since = dayWords(lifecycle.since);
  const on = since ? ` on ${since}` : '';
  const by = lifecycle.by ?? [];
  switch (lifecycle.state) {
    case 'proposed': {
      const who = owner?.name && (!by.length || by.some((name) => name.toLowerCase() === String(owner.handle ?? '').toLowerCase())) ? owner.name : by.length ? listWords(by) : null;
      return `Proposed${who ? ` by ${who}` : ''}${on}; not yet approved`;
    }
    case 'early': return `${lifecycle.word === 'early' ? 'Early' : `${lifecycle.word[0].toUpperCase()}${lifecycle.word.slice(1)}`}: approved for early use; it may still change`;
    case 'approved': {
      const guardedBy = lifecycle.guarded && by.length && by.every((name) => lifecycle.approvers.some((owner_) => owner_.toLowerCase() === name.toLowerCase()));
      return `Approved${by.length ? ` by ${listWords(by)}${guardedBy ? `, the code owners of its lifecycle record${on ? ',' : ''}` : ''}` : ''}${on}`;
    }
    case 'ga': return `Generally available${since ? ` since ${since}` : ''}`;
    case 'deprecated': {
      const replaced = lifecycle.deprecation?.replacedBy;
      const sunset = dayWords(lifecycle.deprecation?.sunset);
      return `Deprecated${on}${replaced ? `: use ${replaced}` : ''}${sunset ? ` (supported until ${sunset})` : ''}`;
    }
    case 'retired': return 'Retired: no longer supported';
    default: return `Marked ${lifecycle.word}, which SFlow does not know as a lifecycle state`;
  }
}

/**
 * What guards it, in words [OMK:REQ-013, REQ-014]: "declares", never "enforced", since SFlow cannot see the host's
 * branch protection. Null when there is nothing to guard yet (no state, or one read from a tag).
 */
export function guardWords(lifecycle) {
  if (!lifecycle?.word || lifecycle.source === 'tag') return null;
  if (lifecycle.source === 'index') return 'Lifecycle as the index states it: an index has no code owners SFlow can read.';
  if (lifecycle.guarded === null) return null;
  if (lifecycle.guarded) return `The marketplace declares ${listWords(lifecycle.approvers)} as the code owners of its lifecycle record.`;
  return 'Lifecycle not guarded by code owners: anyone who can merge to the marketplace can change it.';
}

/** Whether a row shows **Not guarded**: an approval (approved or ga) whose record no code owner guards [REQ-014]. */
export const unguardedApproval = (lifecycle) => Boolean(lifecycle && ['approved', 'ga'].includes(lifecycle.state) && lifecycle.guarded === false);

// ---------------------------------------------------------------------------------------------- checking a record

const finding = (kind, words, fix, extra = {}) => ({ class: kind, owner: 'marketplace', words, fix, ...extra });

/**
 * The marketplace-owned findings on an item's lifecycle [OMK:REQ-002, REQ-003]: the record against its apm.yml's
 * lifecycle-state, its last entry against its state, each entry against the one before, each move against the allowed
 * moves, its dates against each other and the commit's own date, its approvers against the code owners of its file, and
 * whether code owners guard it at all. `parsed` is the record as parseLifecycleRecord read it (with its problems),
 * `lifecycle` the item's lifecycle (itemLifecycle), `name` the item, `file` where the record is, `apmState` its
 * apm.yml's lifecycle-state, `commitDate` (YYYY-MM-DD) the date of the commit read.
 */
export function lifecycleFindings({ name, parsed = null, lifecycle = null, file = LIFECYCLE_RECORD_FILE, apmState = null, commitDate = null } = {}) {
  const found = [];
  if (!lifecycle || !['lifecycle.yml', 'apm.yml', 'index'].includes(lifecycle.source)) return found;
  const where = lifecycle.source === 'lifecycle.yml' ? `${name}'s ${file}` : lifecycle.source === 'apm.yml' ? `The lifecycle mapping in ${name}'s apm.yml` : `${name}'s lifecycle in the index`;
  for (const problem of parsed?.problems ?? []) {
    found.push(finding('marketplace-lifecycle-record', `${where}: ${problem}.`, `Correct ${where.replace(/^The/u, 'the')} so that every entry has from, to, an at date (YYYY-MM-DD) and its change's https address.`, { item: name }));
  }
  if (!lifecycle.state) {
    found.push(finding('marketplace-lifecycle-record', `${where} says its state is ${lifecycle.word}, which is not a lifecycle state SFlow knows.`,
      `Use one of ${listWords(LIFECYCLE_STATES, 'or')} for ${name}'s state.`, { item: name }));
  }
  const declared = lifecycleStateOf(apmState);
  if (apmState && lifecycle.source !== 'index' && lifecycle.state && declared !== lifecycle.state) {
    found.push(finding('marketplace-lifecycle-mismatch', `${where} says ${lifecycle.word}, but its apm.yml's lifecycle-state says ${apmState}; SFlow uses ${lifecycle.word}.`,
      `Set lifecycle-state in ${name}'s apm.yml to ${lifecycle.word}, or remove it.`, { item: name }));
  }
  const history = lifecycle.history ?? [];
  const last = history.at(-1);
  if (last && lifecycle.state && lifecycleStateOf(last.to) !== lifecycle.state) {
    found.push(finding('marketplace-lifecycle-record', `${where}: its last history entry moves it to ${last.to ?? 'nothing'}, but its state is ${lifecycle.word}.`,
      `Add the history entry, with its reviewed change, that moved ${name} to ${lifecycle.word}.`, { item: name }));
  }
  let previous = null;
  for (const [position, entry] of history.entries()) {
    const number = position + 1;
    if (previous && entry.from && lifecycleStateOf(entry.from) !== lifecycleStateOf(previous.to)) {
      found.push(finding('marketplace-lifecycle-record', `${where}: history entry ${number} moves it from ${entry.from}, but the entry before moved it to ${previous.to}.`,
        `Make entry ${number}'s from ${previous.to}, or add the entry that is missing between them.`, { item: name }));
    }
    const from = entry.from ?? previous?.to ?? null;
    if (from && entry.to && !lifecycleMoveAllowed(from, entry.to)) {
      const allowed = MOVES[lifecycleStateOf(from) === 'early' ? 'proposed' : lifecycleStateOf(from)] ?? [];
      found.push(finding('marketplace-lifecycle-jump', `${where}: history entry ${number} moves it from ${from} straight to ${entry.to}${entry.at ? ` (${entry.at})` : ''}, which is not one of the moves a lifecycle makes.`,
        allowed.length ? `Move ${name} from ${from} only to ${listWords(allowed, 'or')}, each move in its own reviewed change.` : `${name} stays ${from}: a retired item moves no further.`,
        { item: name, from, to: entry.to }));
    }
    if (previous?.at && entry.at && entry.at < previous.at) {
      found.push(finding('marketplace-lifecycle-record', `${where}: history entry ${number} is dated ${entry.at}, before the entry before it (${previous.at}).`,
        `Keep ${name}'s history in date order.`, { item: name }));
    }
    if (commitDate && entry.at && entry.at > commitDate) {
      found.push(finding('marketplace-lifecycle-record', `${where}: history entry ${number} is dated ${entry.at}, after the commit that holds it.`,
        `Date entry ${number} on the day its change merged.`, { item: name }));
    }
    if (lifecycle.guarded && entry.approvedBy.length) {
      const strangers = entry.approvedBy.filter((who) => !lifecycle.approvers.some((owner) => owner.toLowerCase() === who.toLowerCase()));
      if (strangers.length) {
        found.push(finding('marketplace-lifecycle-approver', `${where}: history entry ${number} names ${listWords(strangers)} as approving it, who ${strangers.length === 1 ? 'is not a code owner' : 'are not code owners'} of the record.`,
          `Name in approved-by only the code owners of ${file} (${listWords(lifecycle.approvers)}), or make them its code owners in CODEOWNERS.`, { item: name }));
      }
    }
    previous = entry;
  }
  if (lifecycle.guarded === false && lifecycle.source !== 'index') {
    found.push(finding('marketplace-lifecycle-unguarded', `${where} is not guarded by code owners: anyone who can merge to the marketplace can change ${name}'s lifecycle.`,
      `Add a CODEOWNERS rule, last in the file, that names the marketplace's stewards for ${lifecycle.source === 'lifecycle.yml' ? `**/${LIFECYCLE_RECORD_FILE}` : `${name}'s apm.yml`}.`, { item: name }));
  }
  return found;
}

/**
 * An item's lifecycle as a row carries it [OMK:REQ-015]: `{ state, word, source, since, by, change, guarded, approvers,
 * deprecation, words, guardWords, notGuarded }`, without its history (which only a move review reads). `recorded` marks
 * one read from the import record because its marketplace could not be read [OMK:REQ-011].
 */
export function lifecycleSummary(lifecycle, { recorded = false } = {}) {
  if (!lifecycle) return null;
  const { history: _history, ...shown } = lifecycle;
  return { ...shown, notGuarded: unguardedApproval(lifecycle), ...(recorded ? { recorded: true, words: `${lifecycle.words} (as recorded when it was imported)` } : {}) };
}
