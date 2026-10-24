/**
 * The closed XPL2 statement template catalog [XPL2-LAW-001, XPL2-LAW-003].
 *
 * Every computed factual sentence in an XPL2 view is produced here from typed arguments. A model
 * may later select and order statement IDs, but no caller can pass prose through this boundary:
 * arguments are typed, bounded and display-sanitized, and an unknown template or argument is a
 * programming error rather than a new kind of fact. Wording deliberately says what was recorded,
 * by whom and at what scope — never that behavior is correct.
 */
import { xpl2ReasonText } from './reasons.mjs';

export const XPL2_TEMPLATE_CATALOG_VERSION = 'xpl2-templates@1';

const MAXIMUM_TEXT = 300;
const MAXIMUM_QUOTE = 600;
const OPERATIONS = new Set(['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed', 'mode-changed', 'changed']);

/** Strip controls, bidirectional overrides and separators for display; retained identities are not altered. */
export function displayText(value, maximum = MAXIMUM_TEXT) {
  const text = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function lines(start, count) {
  if (!count) return 'none';
  return count === 1 ? String(start) : `${start}–${start + count - 1}`;
}

const TRUTH_LABELS = Object.freeze({
  'working-tree-observation': 'working-tree observation',
  'repository-tree-comparison': 'repository-tree comparison'
});

const FEATURE_LABELS = Object.freeze({
  wel: 'Witness insights (WEL)',
  pe: 'Prompt and tool-trace capture (PE)',
  structure: 'Cached structural navigation',
  impact: 'Repository impact',
  provenance: 'Change provenance',
  admission: 'Admission evaluation',
  cause: 'Exact cause links'
});

const STATE_LABELS = Object.freeze({
  observe: "observe",
  off: "off",
  "not-evaluated": "not evaluated",
  "not-read": "not read by this release",
  unavailable: "unavailable",
  "navigation-only": "available as navigation hints only"
});

// Git records these file types; the diff text of a link or gitlink is its target, not file content.
const FILE_TYPE_LABELS = Object.freeze({
  'regular-file': 'a regular file',
  symlink: 'a symbolic link',
  gitlink: 'a submodule pointer (gitlink)',
  missing: 'absent'
});

const FILE_TYPE_MEANING = Object.freeze({
  symlink: 'its diff text is the recorded link target, not file content.',
  gitlink: "its diff text is the recorded commit pointer, not the submodule's files."
});

// Where a tag sits relative to this capture's change units.
const TAG_PLACEMENT_LABELS = Object.freeze({
  added: 'added by this change',
  unchanged: 'on a line this change did not touch',
  unknown: 'line-level change detail is not available'
});

// Verification-owner vocabularies, in plain words [E2G-017]. Unknown values are refused, not guessed.
const ASSURANCE_LABELS = Object.freeze({
  none: 'no assurance',
  declared: 'a declaration by tag only',
  'source-bound': 'one exact declaration',
  'module-observed': 'a pass observed through its module command',
  'exact-local-observed': 'its own occurrence observed in a local run',
  'exact-authenticated': 'its own occurrence observed in an authenticated run'
});

const IDENTITY_LABELS = Object.freeze({
  declared: 'declared by a tag',
  'source-bound': 'bound to one exact test declaration'
});

const WITNESS_OUTCOMES = Object.freeze({
  passed: 'passed', failed: 'failed', flaky: 'was flaky', 'not-run': 'has no recorded run',
  missing: 'was not found in the run', inconclusive: 'was inconclusive', 'passed-with-skips': 'passed with skipped tests',
  unavailable: 'has no usable result', 'unverified-skipped': 'was skipped', ambiguous: 'matched more than one occurrence'
});

// The evidence-reuse owner's states (src/evidence-reuse.mjs), plus unknown for a record it cannot judge.
const REUSE_STATES = Object.freeze({
  active: 'applies now, because the source and test inputs are unchanged since that run',
  revoked: 'was revoked',
  expired: 'has expired',
  superseded: 'no longer applies: the step that ran it was reopened',
  unobserved: 'is not confirmed: the current source was not compared',
  'source-changed': 'no longer applies: the source or its test inputs changed after that run',
  'attempt-changed': 'no longer applies: the attempt record changed',
  unknown: 'cannot be judged: the record lacks what its rule binds'
});

const INVOCATION_STATUS = Object.freeze({
  completed: 'completed',
  failed: 'failed',
  started: 'started and has no recorded outcome'
});

const PROMPT_SOURCES = Object.freeze({
  'wm-compose': 'composed and prepared; whether it was sent was not observed',
  'vscode-governed-handoff': 'handed to the Copilot host; the host\'s own invocation was not observed',
  'model-invocation': 'sent through the model runner',
  other: 'kept by another writer'
});

const CAPTURE_LABELS = Object.freeze({
  'prompt-log': 'The prompt log',
  invocations: 'The model invocation record',
  attempts: 'The test attempt record'
});

const CAPTURE_STATES = Object.freeze({
  on: 'is readable', off: 'is off', unreadable: 'could not be read'
});

function fileTypeSentence(a) {
  const meaning = FILE_TYPE_MEANING[a.after === 'missing' ? a.before : a.after];
  if (a.before === a.after) return `${a.path} is ${FILE_TYPE_LABELS[a.after]} on both sides${meaning ? `; ${meaning}` : '.'}`;
  if (a.before === 'missing') return `${a.path} is added as ${FILE_TYPE_LABELS[a.after]}${meaning ? `; ${meaning}` : '.'}`;
  if (a.after === 'missing') return `${a.path} was ${FILE_TYPE_LABELS[a.before]} and is removed${meaning ? `; ${meaning}` : '.'}`;
  return `${a.path} changed from ${FILE_TYPE_LABELS[a.before]} to ${FILE_TYPE_LABELS[a.after]}.`;
}

const sideLabel = (side) => side === 'before' ? 'Before' : 'After';

// Where an after-side line sits when commit history is asked about it.
const LINE_PLACEMENTS = Object.freeze({
  baseline: (a) => '',
  context: (a) => ` is unchanged context inside a change unit (baseline line ${a.baselineLine}), and`,
  outside: (a) => ` is baseline line ${a.baselineLine}, outside the changed units, and`
});

const TEMPLATES = [
  {
    id: 'xpl2.change-inventory@1',
    arguments: { truth: 'truth', files: 'count', hunks: 'count', opaque: 'count', units: 'count', complete: 'boolean' },
    render: (a) => `This ${TRUTH_LABELS[a.truth]} records ${a.complete ? '' : 'at least '}${plural(a.files, 'changed file')}: `
      + `${plural(a.hunks, 'text hunk')} and ${plural(a.opaque, 'opaque unit')}, ${plural(a.units, 'change unit')} in total.`
  },
  {
    id: 'xpl2.singularity-files-hidden@1',
    arguments: { entries: 'count', groups: 'text' },
    render: (a) => `${plural(a.entries, 'Singularity Flow file change')} (${a.groups}) `
      + `${a.entries === 1 ? 'is' : 'are'} not code and ${a.entries === 1 ? 'is' : 'are'} not shown.`
  },
  {
    id: 'xpl2.hunk@1',
    arguments: {
      unitId: 'identifier', path: 'text', operation: 'operation',
      beforeStart: 'count', beforeLines: 'count', afterStart: 'count', afterLines: 'count'
    },
    render: (a) => `${a.unitId} is a text hunk in ${a.path} (${a.operation}): before lines ${lines(a.beforeStart, a.beforeLines)}, `
      + `after lines ${lines(a.afterStart, a.afterLines)}.`
  },
  {
    id: 'xpl2.opaque-unit@1',
    arguments: { unitId: 'identifier', path: 'text', unitKind: 'identifier', reason: 'reason' },
    render: (a) => `${a.unitId} is an opaque change to ${a.path}. ${xpl2ReasonText(a.reason)}`
  },
  {
    id: 'xpl2.file-type@1',
    arguments: { path: 'text', before: 'file-type', after: 'file-type' },
    render: fileTypeSentence
  },
  {
    id: 'xpl2.mode-change@1',
    arguments: { path: 'text', before: 'mode', after: 'mode' },
    render: (a) => `${a.path} changed file mode from ${a.before} to ${a.after}.`
  },
  {
    id: 'xpl2.declaration-overlap@1',
    arguments: { unitId: 'identifier', symbol: 'text', declarationKind: 'identifier', line: 'count', assurance: 'identifier' },
    render: (a) => `${a.symbol} (${a.declarationKind}, ${a.assurance} cache) is declared on line ${a.line} inside ${a.unitId}; `
      + 'this is a navigation hint, not ownership or coverage.'
  },
  {
    id: 'xpl2.region-association@1',
    arguments: { clauseId: 'identifier', causeKind: 'identifier', path: 'text' },
    render: (a) => `${a.clauseId} is recorded as a region-level ${a.causeKind} association with ${a.path}; `
      + 'its hunks are not individually linked.'
  },
  {
    id: 'xpl2.cause-not-recorded@1',
    arguments: { unitId: 'identifier' },
    render: (a) => `No exact cause link was returned for ${a.unitId} in this captured cause set.`
  },
  {
    id: 'xpl2.clause-declared@1',
    arguments: { clauseId: 'identifier', sourcePath: 'text', line: 'count', text: 'quote' },
    render: (a) => `${a.clauseId} is declared at ${a.sourcePath}:${a.line}: “${a.text}”`
  },
  {
    id: 'xpl2.clause-cites@1',
    arguments: { clauseId: 'identifier', cited: 'identifier', sourcePath: 'text', line: 'count' },
    render: (a) => `${a.clauseId} names ${a.cited} in its specification text (${a.sourcePath}:${a.line}); `
      + 'a citation links the two clauses, it does not show that either is met.'
  },
  {
    id: 'xpl2.clause-tag@1',
    arguments: { clauseId: 'identifier', path: 'text', line: 'count', placement: 'tag-placement', note: 'quote' },
    render: (a) => `${a.path}:${a.line} tags ${a.clauseId} (${TAG_PLACEMENT_LABELS[a.placement]})`
      + `${a.note ? ` with the author's note “${a.note}”` : ' with no note on how the code meets it'}; `
      + 'a tag declares intent, it does not show that the code meets the clause.'
  },
  {
    id: 'xpl2.acceptance-tag@1',
    arguments: { clauseId: 'identifier', path: 'text', line: 'count', placement: 'tag-placement' },
    render: (a) => `${a.path}:${a.line} tags acceptance criterion ${a.clauseId} (${TAG_PLACEMENT_LABELS[a.placement]}); `
      + 'a tag is a mapping declaration, not coverage or a result.'
  },
  {
    id: 'xpl2.clause-required@1',
    arguments: { clauseId: 'identifier', phase: 'identifier' },
    render: (a) => `The ${a.phase} delivery record lists ${a.clauseId} as a required clause.`
  },
  {
    id: 'xpl2.clause-untagged@1',
    arguments: { clauseId: 'identifier', phase: 'identifier' },
    render: (a) => `The ${a.phase} delivery record reports no changed test tagged for ${a.clauseId}.`
  },
  {
    id: 'xpl2.test-tag@1',
    arguments: { clauseId: 'identifier', testSource: 'text', bindingAssurance: 'identifier' },
    render: (a) => `${a.testSource} declares a test tag for ${a.clauseId} (${a.bindingAssurance}); `
      + 'a tag is a mapping declaration, not coverage or a result.'
  },
  {
    id: 'xpl2.test-result@1',
    arguments: { commandId: 'text', status: 'identifier', phase: 'identifier', generation: 'text' },
    render: (a) => `The local ${a.phase} delivery record (generation ${a.generation}) lists test command ${a.commandId} `
      + `as ${a.status}; authenticated Candidate execution is unavailable.`
  },
  {
    id: 'xpl2.admission-unavailable@1',
    arguments: { truth: 'truth' },
    render: (a) => `Admission is not evaluated for this ${TRUTH_LABELS[a.truth]}; no evaluation owner result was read.`
  },
  {
    id: 'xpl2.feature-state@1',
    arguments: { feature: 'feature', state: 'state', reason: 'reason' },
    render: (a) => `${FEATURE_LABELS[a.feature]}: ${STATE_LABELS[a.state]}. ${xpl2ReasonText(a.reason)}`
  },
  {
    id: 'xpl2.gap-observed@1',
    arguments: { code: 'identifier', subject: 'text' },
    render: (a) => `The shadow proof observation lists gap ${a.code} for ${a.subject}; it is observe-only and not an admission verdict.`
  },
  {
    id: 'xpl2.no-complete-evaluation@1',
    arguments: {},
    render: () => 'No complete evaluation was read, so this view cannot report that no blockers exist.'
  },
  {
    id: 'xpl2.line-in-unit@1',
    arguments: { side: 'side', path: 'text', line: 'count', unitId: 'identifier' },
    render: (a) => `${a.side === 'before' ? 'Before' : 'After'}-side line ${a.line} of ${a.path} is inside ${a.unitId}.`
  },
  {
    id: 'xpl2.line-outside@1',
    arguments: { side: 'side', path: 'text', line: 'count' },
    render: (a) => `${a.side === 'before' ? 'Before' : 'After'}-side line ${a.line} of ${a.path} is not inside any change unit of this captured interval.`
  },
  {
    id: 'xpl2.line-opaque@1',
    arguments: { side: 'side', path: 'text', line: 'count', unitId: 'identifier' },
    render: (a) => `${a.path} is part of opaque change ${a.unitId}; ${a.side}-side line ${a.line} has no line-level detail here.`
  },
  {
    id: 'xpl2.generation-recorded@1',
    arguments: { phase: 'identifier', generation: 'text', events: 'count', status: 'identifier' },
    render: (a) => `Phase ${a.phase} generation ${a.generation} has ${plural(a.events, 'normalized history event')}; `
      + `recorded phase status: ${a.status}.`
  },
  {
    id: 'xpl2.provenance-unavailable@1',
    arguments: { subject: 'text', reason: 'reason' },
    render: (a) => `Change provenance for ${a.subject} is unavailable. ${xpl2ReasonText(a.reason)}`
  },
  {
    id: 'xpl2.witness-result@1',
    arguments: {
      label: 'text', clauseId: 'identifier', outcome: 'witness-outcome', identity: 'identity-assurance',
      assurance: 'assurance', requiredAssurance: 'assurance', attempt: 'text', commandId: 'text', shortfall: 'boolean'
    },
    render: (a) => `${a.label} is the recorded witness for ${a.clauseId}: it ${WITNESS_OUTCOMES[a.outcome]}`
      + `${a.attempt === 'none' ? '' : ` in attempt ${a.attempt} of ${a.commandId}`}. It is ${IDENTITY_LABELS[a.identity]} and reached `
      + `${ASSURANCE_LABELS[a.assurance]}${a.shortfall ? `, below the ${ASSURANCE_LABELS[a.requiredAssurance]} its runner can reach` : ''}. `
      + 'This is a local recorded run, not authenticated Candidate execution.'
  },
  {
    id: 'xpl2.test-attempt@1',
    arguments: {
      attemptId: 'identifier', commandId: 'text', purpose: 'identifier', status: 'identifier', completedAt: 'text',
      countsKnown: 'boolean', passed: 'count', failed: 'count', skipped: 'count', previous: 'text'
    },
    render: (a) => `Attempt ${a.attemptId} (${a.purpose}) of ${a.commandId} `
      + `${a.completedAt === 'not recorded' ? 'has no recorded completion time' : `completed at ${a.completedAt}`}: ${a.status}`
      + `${a.countsKnown ? `, ${a.passed} passed, ${a.failed} failed, ${a.skipped} skipped` : ', with no test counts in its report'}; `
      + `${a.previous === 'none' ? 'no earlier attempt of this command is recorded' : `it follows attempt ${a.previous}`}.`
  },
  {
    id: 'xpl2.evidence-reuse@1',
    arguments: { reuseId: 'identifier', phase: 'identifier', attemptId: 'text', sourcePhase: 'text', commit: 'text', state: 'reuse-state', actor: 'text' },
    render: (a) => `${a.reuseId}: ${a.actor} recorded that attempt ${a.attemptId}, run by ${a.sourcePhase} at ${a.commit}, stands for ${a.phase}. `
      + `Its owner reports that this decision ${REUSE_STATES[a.state]}. A reused run is not a new run on this change.`
  },
  {
    id: 'xpl2.line-commit@1',
    arguments: {
      side: 'side', path: 'text', line: 'count', placement: 'line-placement', baselineLine: 'count', commit: 'identifier',
      summary: 'quote', author: 'quote', authorTime: 'text'
    },
    render: (a) => `${sideLabel(a.side)}-side line ${a.line} of ${a.path}${LINE_PLACEMENTS[a.placement](a)} was last changed in commit `
      + `${a.commit.slice(0, 12)} (“${a.summary || 'no summary'}”, recorded author ${a.author || 'not recorded'}, ${a.authorTime}). `
      + 'The author field is what the commit records; it does not show how the line was produced.'
  },
  {
    id: 'xpl2.line-uncommitted@1',
    arguments: { path: 'text', line: 'count', unitId: 'identifier' },
    render: (a) => `After-side line ${a.line} of ${a.path} was added or changed in ${a.unitId} of this captured change; no commit records it yet.`
  },
  {
    id: 'xpl2.line-commit-unavailable@1',
    arguments: { side: 'side', path: 'text', line: 'count', reason: 'reason' },
    render: (a) => `Commit attribution for ${a.side}-side line ${a.line} of ${a.path} is unavailable. ${xpl2ReasonText(a.reason)}`
  },
  {
    id: 'xpl2.generation-invocation@1',
    arguments: {
      invocationId: 'text', status: 'invocation-status', requestedModel: 'text', reportedModel: 'text', startedAt: 'text',
      completedAt: 'text', toolsObserved: 'boolean', toolCalls: 'count', integrity: 'identifier'
    },
    render: (a) => `Model invocation ${a.invocationId} ${INVOCATION_STATUS[a.status]}: requested model ${a.requestedModel}; `
      + `${a.reportedModel === 'unreported' ? 'the provider did not report which model served it' : `the provider reported ${a.reportedModel}`}; `
      + `started ${a.startedAt}, ${a.completedAt === 'not recorded' ? 'with no recorded end' : `ended ${a.completedAt}`}; `
      + `${a.toolsObserved ? `${plural(a.toolCalls, 'tool call')} observed, in their recorded order` : 'no tool observation was recorded'}. `
      + `It is this machine's record (${a.integrity}); it does not say which files or lines it wrote.`
  },
  {
    id: 'xpl2.invocation-overlap@1',
    arguments: { first: 'text', second: 'text' },
    render: (a) => `Model invocations ${a.first} and ${a.second} overlap in time; the records establish no order between them.`
  },
  {
    id: 'xpl2.generation-prompt@1',
    arguments: { recordId: 'text', source: 'prompt-source', recordedAt: 'text', redactions: 'count', invocation: 'text' },
    render: (a) => `Prompt-log entry ${a.recordId}, recorded at ${a.recordedAt}, was ${PROMPT_SOURCES[a.source]}`
      + `${a.redactions ? `; ${plural(a.redactions, 'secret-shaped value')} ${a.redactions === 1 ? 'was' : 'were'} redacted before it was kept` : ''}`
      + `${a.invocation === 'none' ? '' : `; it names invocation ${a.invocation}`}.`
  },
  {
    id: 'xpl2.capture-state@1',
    arguments: { capture: 'capture', state: 'capture-state', records: 'count', retentionDays: 'count', reason: 'reason' },
    render: (a) => `${CAPTURE_LABELS[a.capture]} on this machine ${CAPTURE_STATES[a.state]}${a.retentionDays ? ` (it keeps ${a.retentionDays} days)` : ''}: `
      + `${plural(a.records, 'record')} for this generation. ${xpl2ReasonText(a.reason)}`
  },
  {
    id: 'xpl2.source-state@1',
    arguments: { source: 'text', reason: 'reason' },
    render: (a) => `${a.source}: ${xpl2ReasonText(a.reason)}`
  }
];

function validArgument(kind, value) {
  switch (kind) {
    case 'count': return Number.isSafeInteger(value) && value >= 0;
    case 'boolean': return typeof value === 'boolean';
    case 'identifier': return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._@/+-]{0,199}$/u.test(value);
    case 'text': return typeof value === 'string' && value.length > 0 && value.length <= 4096;
    case 'quote': return typeof value === 'string' && value.length <= 16384;
    case 'truth': return Object.hasOwn(TRUTH_LABELS, value);
    case 'feature': return Object.hasOwn(FEATURE_LABELS, value);
    case 'state': return Object.hasOwn(STATE_LABELS, value);
    case 'side': return value === 'before' || value === 'after';
    case 'file-type': return Object.hasOwn(FILE_TYPE_LABELS, value);
    case 'mode': return typeof value === 'string' && /^[0-7]{6}$/u.test(value);
    case 'operation': return OPERATIONS.has(value);
    case 'tag-placement': return Object.hasOwn(TAG_PLACEMENT_LABELS, value);
    case 'assurance': return Object.hasOwn(ASSURANCE_LABELS, value);
    case 'identity-assurance': return Object.hasOwn(IDENTITY_LABELS, value);
    case 'witness-outcome': return Object.hasOwn(WITNESS_OUTCOMES, value);
    case 'reuse-state': return Object.hasOwn(REUSE_STATES, value);
    case 'invocation-status': return Object.hasOwn(INVOCATION_STATUS, value);
    case 'prompt-source': return Object.hasOwn(PROMPT_SOURCES, value);
    case 'capture': return Object.hasOwn(CAPTURE_LABELS, value);
    case 'capture-state': return Object.hasOwn(CAPTURE_STATES, value);
    case 'line-placement': return Object.hasOwn(LINE_PLACEMENTS, value);
    case 'reason':
      try { xpl2ReasonText(value); return true; } catch { return false; }
    default: return false;
  }
}

function sanitizeArgument(kind, value) {
  if (kind === 'text') return displayText(value);
  if (kind === 'quote') return displayText(value, MAXIMUM_QUOTE);
  return value;
}

const CATALOG = new Map(TEMPLATES.map((template) => [template.id, Object.freeze(template)]));

export const XPL2_TEMPLATE_IDS = Object.freeze([...CATALOG.keys()]);

/** Statement kind is the template's stable name without its version. */
export function templateKind(templateId) {
  return String(templateId).replace(/^xpl2\./u, '').replace(/@\d+$/u, '');
}

/**
 * Validate one template invocation and return its sanitized arguments plus rendered text.
 * Throws on any unknown template, missing/extra argument or mistyped value.
 */
export function renderTemplate(templateId, rawArguments = {}) {
  const template = CATALOG.get(templateId);
  if (!template) throw new TypeError(`Unregistered XPL2 template '${String(templateId)}'.`);
  const names = Object.keys(template.arguments);
  const supplied = Object.keys(rawArguments ?? {});
  const unexpected = supplied.filter((name) => !names.includes(name));
  if (unexpected.length) throw new TypeError(`${templateId} does not accept ${unexpected.join(', ')}.`);
  const argumentsOut = {};
  for (const name of names) {
    const value = rawArguments[name];
    if (!validArgument(template.arguments[name], value)) {
      throw new TypeError(`${templateId} argument '${name}' is not a valid ${template.arguments[name]}.`);
    }
    argumentsOut[name] = sanitizeArgument(template.arguments[name], value);
  }
  return Object.freeze({ arguments: Object.freeze(argumentsOut), text: template.render(argumentsOut) });
}
