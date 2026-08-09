/**
 * A readable account of what happened to a Story, rendered from normalized beats.
 *
 * Determinism is the whole contract here. A recap that reads differently on two machines from the
 * same history is not evidence, it is decoration — so every input that could vary is pinned:
 * timezone and locale are parameters rather than ambient, ordering has a total tie-break, user text
 * is normalized and bounded, and beat selection is a fixed rule.
 *
 * `selectBriefBeats` lives here, in the directory the narration-purity test scans, on purpose. Its
 * name says "selection" rather than "summarize" so nobody reaches for a model, and its location
 * means that if someone does, the test that forbids narration from computing truth sees it.
 */
import { narrationBeats } from './beats.mjs';

export const RECAP_LENGTHS = Object.freeze(['brief', 'standard', 'full']);

/**
 * Beats that carry the shape of the story, in the order they must be kept.
 *
 * Deliberately a ranking, not a judgement. Given the same beats this returns the same selection on
 * every machine, forever — which a model cannot promise and a governance narrative cannot do
 * without.
 */
const BRIEF_PRIORITY = Object.freeze([
  'story.started', 'story.completed', 'story.cancelled', 'story.reopened',
  'phase.rejected', 'phase.approved', 'phase.submitted', 'generation.published'
]);

export function selectBriefBeats(beats, { limit = 6 } = {}) {
  const ranked = [...beats].sort((a, b) => {
    const left = BRIEF_PRIORITY.indexOf(a.kind);
    const right = BRIEF_PRIORITY.indexOf(b.kind);
    return (left < 0 ? BRIEF_PRIORITY.length : left) - (right < 0 ? BRIEF_PRIORITY.length : right)
      || a.at.localeCompare(b.at)
      || a.id.localeCompare(b.id);
  }).slice(0, limit);
  // Chronological once chosen: the ranking decides what is worth saying, never the order it is said.
  return ranked.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

const MAXIMUM_QUOTED = 160;

/**
 * User-authored text, made safe to place in a governed narrative.
 *
 * Rejection reasons and change-request comments are free text that ends up in review packets and
 * pull-request bodies. Unnormalized, they can carry newlines that forge structure, control
 * characters, confusable Unicode, or enough length to bury everything around them.
 */
export function quoted(value, { maximum = MAXIMUM_QUOTED } = {}) {
  if (value === undefined || value === null) return null;
  const normalized = String(value)
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

/** An explicit, pinned timestamp. Never the machine's idea of local time. */
function when(at, { timeZone, locale }) {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return at;
  return new Intl.DateTimeFormat(locale, {
    timeZone, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(parsed);
}

function actorName(actor) {
  if (!actor) return 'someone';
  return quoted(actor.name ?? actor.login ?? actor.email) ?? 'someone';
}

const LINES = Object.freeze({
  'story.started': (b) => `started${b.phase ? ` at ${b.phase}` : ''}`,
  // Only the lifecycle stream records which generation it was. When a beat came from the operational
  // log alone the number is genuinely unknown, and printing "generation ?" states a gap as if it
  // were a fact.
  'generation.published': (b) => (b.generation
    ? `published generation ${b.generation} of ${b.phase ?? 'a phase'}`
    : `published a generation of ${b.phase ?? 'a phase'}`),
  'phase.submitted': (b) => `submitted ${b.phase ?? 'a phase'} for approval`,
  'phase.approved': (b) => `approved ${b.phase ?? 'a phase'}${b.authority ? ` through ${b.authority}` : ''}`,
  'phase.rejected': (b) => `returned ${b.phase ?? 'a phase'} for changes`,
  'story.reopened': (b) => `reopened completed work at ${b.phase ?? 'an earlier phase'}`,
  'story.cancelled': () => 'cancelled the work',
  'story.completed': () => 'completed the work',
  'branch.attached': (b) => `attached a child branch${b.detail ? ` (${quoted(b.detail)})` : ''}`,
  'documents.added': () => 'added supporting documents',
  'evidence.recorded': () => 'recorded evidence',
  'checks.recorded': () => 'recorded check results',
  'sequence.overridden': (b) => `confirmed a soft sequence override${b.phase ? ` on ${b.phase}` : ''}`,
  'interval.started': (b) => `opened a work interval on ${b.phase ?? 'a phase'}`,
  'interval.reconciled': (b) => `reconciled the work interval on ${b.phase ?? 'a phase'}`,
  'interval.closed': (b) => `closed the work interval on ${b.phase ?? 'a phase'}`,
  'design.promoted': () => 'promoted a reviewed design source',
  'impact.invalidated': () => 'invalidated the impact receipt',
  'configuration.changed': () => 'changed the governed configuration'
});

function line(beat, options) {
  const render = LINES[beat.kind];
  const body = render ? render(beat) : beat.kind;
  const provenance = beat.source.commit ? `  ↳ ${beat.source.stream}:${beat.source.commit.slice(0, 8)}` : '';
  return `${when(beat.at, options)}  ${actorName(beat.actor)} ${body}${provenance}`;
}

/**
 * Render a Story's account.
 *
 * `locale` and `timeZone` are required inputs rather than defaults read from the environment,
 * because the same history rendered in two places must produce identical bytes.
 */
export function recap(workflowOrBeats, { locale = 'en-GB', timeZone = 'UTC', length = 'standard' } = {}) {
  if (!RECAP_LENGTHS.includes(length)) {
    throw new TypeError(`recap length must be one of ${RECAP_LENGTHS.join(', ')}`);
  }
  const beats = Array.isArray(workflowOrBeats) ? workflowOrBeats : narrationBeats(workflowOrBeats);
  const selected = length === 'brief' ? selectBriefBeats(beats) : beats;
  const options = { locale, timeZone };
  return selected.map((beat) => line(beat, options)).join('\n');
}
