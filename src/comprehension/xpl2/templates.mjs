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

function fileTypeSentence(a) {
  const meaning = FILE_TYPE_MEANING[a.after === 'missing' ? a.before : a.after];
  if (a.before === a.after) return `${a.path} is ${FILE_TYPE_LABELS[a.after]} on both sides${meaning ? `; ${meaning}` : '.'}`;
  if (a.before === 'missing') return `${a.path} is added as ${FILE_TYPE_LABELS[a.after]}${meaning ? `; ${meaning}` : '.'}`;
  if (a.after === 'missing') return `${a.path} was ${FILE_TYPE_LABELS[a.before]} and is removed${meaning ? `; ${meaning}` : '.'}`;
  return `${a.path} changed from ${FILE_TYPE_LABELS[a.before]} to ${FILE_TYPE_LABELS[a.after]}.`;
}

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
