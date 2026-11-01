/**
 * The six XPL2 subjects over one change universe [XPL2-AC-017].
 *
 * `change` returns the whole universe. `clause`, `test` and `line` select exact members of it and
 * may add query-derived statements; `gap` reads the existing shadow-proof owner's register when a
 * caller supplies it; `generation` reads the Story's recorded phase generation and normalized
 * history. Every lookup is exact: a missing subject is `subject-not-found` inside the stated scope
 * and an ambiguous one lists its exact choices. Nothing falls back to fuzzy search, documentation,
 * chat history or the live working tree.
 */
import { SingularityFlowError } from '../../util.mjs';
import { buildChangeExplanationUniverse } from './change-subject.mjs';
import { XPL2_AUDIENCES, XPL2_SUBJECTS } from './model.mjs';

const MAXIMUM_SELECTOR_BYTES = 512;

function refuse(message, code = 'XPL2_SUBJECT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function boundedSelector(value, label) {
  if (value == null) return null;
  const text = String(value);
  if (!text || text.includes('\0') || Buffer.byteLength(text, 'utf8') > MAXIMUM_SELECTOR_BYTES) {
    refuse(`XPL2 ${label} must be a non-empty value of at most ${MAXIMUM_SELECTOR_BYTES} bytes.`);
  }
  return text;
}

/**
 * Validate the subject query before any repository read [XPL2-AC-017, XPL2-AC-018].
 * Paths and lines are separate fields; there is no `path:line` parser to misread a drive letter,
 * a colon in a legal path, a URI scheme or a deletion-side coordinate.
 */
export function normalizeXpl2Query(query = {}) {
  const subject = String(query.subject ?? '');
  if (!XPL2_SUBJECTS.includes(subject)) {
    refuse(`Unknown explanation subject '${subject}'. Use one of: ${XPL2_SUBJECTS.join(', ')}.`, 'XPL2_SUBJECT_UNKNOWN');
  }
  const audience = query.audience ?? 'reviewer';
  if (!XPL2_AUDIENCES.includes(audience)) {
    refuse(`Unknown audience '${audience}'. Use one of: ${XPL2_AUDIENCES.join(', ')}.`);
  }
  const normalized = { subject, audience, id: null, path: null, line: null, side: null, phase: null, generation: null };
  if (subject === 'clause' || subject === 'test') {
    normalized.id = boundedSelector(query.id, '--id');
    if (!normalized.id) refuse(`--subject ${subject} requires --id with an exact identifier.`);
  }
  if (subject === 'line') {
    normalized.path = boundedSelector(query.path, '--path');
    if (!normalized.path) refuse('--subject line requires --path with a repository-relative path.');
    if (/^[/\\]|^[A-Za-z]:[\\/]|(^|[\\/])\.\.([\\/]|$)/u.test(normalized.path)) {
      refuse('--path must be repository-relative and must not leave the repository.');
    }
    const line = Number(query.line);
    if (!Number.isSafeInteger(line) || line < 1) refuse('--subject line requires --line with a positive line number.');
    normalized.line = line;
    normalized.side = query.side ?? 'after';
    if (!['before', 'after'].includes(normalized.side)) refuse('--side must be before or after.');
  }
  if (subject === 'generation') {
    normalized.phase = boundedSelector(query.phase, '--phase');
    if (!normalized.phase) refuse('--subject generation requires --phase.');
    const generation = Number(query.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) refuse('--subject generation requires --gen with a positive generation number.');
    normalized.generation = generation;
  }
  for (const [field, allowed] of [
    ['id', ['clause', 'test']], ['path', ['line']], ['phase', ['generation']]
  ]) {
    if (query[field] != null && !allowed.includes(subject)) {
      refuse(`--${field} is not a selector for --subject ${subject}.`);
    }
  }
  return normalized;
}

function neighbourhood(model, seedNodes) {
  const nodes = new Set(seedNodes);
  const relationships = [];
  for (const edge of model.builderRelationships) {
    if (nodes.has(edge.from) || nodes.has(edge.to)) relationships.push(edge.id);
  }
  for (const edge of model.builderRelationships) {
    if (relationships.includes(edge.id)) { nodes.add(edge.from); nodes.add(edge.to); }
  }
  return { nodes, relationships };
}

/**
 * The deterministic "Read this change" tour [XPL2 13.1]: purpose, changed units, links, recorded
 * checks, attention and unknowns, recorded history, then one safe inspection action. Each step shows
 * at most TOUR_STEP_LIMIT statements and counts the rest, which stay in the view. No model is used.
 */
export const TOUR_STEP_LIMIT = 12;
const TOUR_STEPS = Object.freeze([
  ['purpose', ['clause-declared', 'clause-cites', 'clause-required']],
  ['changes', ['change-inventory', 'singularity-files-hidden', 'file-type', 'mode-change', 'hunk', 'opaque-unit',
    'declaration-overlap', 'line-file-gone', 'line-in-unit', 'line-outside', 'line-opaque', 'line-commit', 'line-changed',
    'line-commit-unavailable']],
  ['links', ['exact-cause', 'binding-not-joined', 'line-binding', 'clause-tag', 'region-association', 'acceptance-tag', 'test-tag']],
  ['checks', ['witness-result', 'test-result', 'test-attempt', 'evidence-reuse', 'binding-decision', 'clause-untagged', 'gap-observed']],
  ['attention', ['no-complete-evaluation', 'admission-unavailable', 'feature-state', 'source-state', 'provenance-unavailable',
    'cause-not-recorded', 'capture-state', 'records-unreadable', 'line-writer-unestablished']],
  ['history', ['line-writer', 'generation-recorded', 'generation-invocation', 'generation-prompt', 'generation-attempt', 'invocation-overlap',
    'generation-write', 'prompt-entries-removed', 'prompt-log-cleared']]
]);

function readingTour(statements, attentionStatements, next) {
  const present = new Set(statements.map((entry) => entry.id));
  // Attention items are always shown, whatever their kind, and never limited.
  const mandatory = [...new Set(attentionStatements)].filter((id) => present.has(id));
  const accounted = new Set(mandatory);
  const steps = TOUR_STEPS.map(([step, kinds]) => {
    // Within a step, statements follow the step's kind order (the inventory before its units).
    const candidates = statements.filter((entry) => kinds.includes(entry.kind) && !accounted.has(entry.id))
      .sort((left, right) => kinds.indexOf(left.kind) - kinds.indexOf(right.kind)).map((entry) => entry.id);
    // Shown or counted, never both and never neither: past the limit a statement is counted here.
    for (const id of candidates) accounted.add(id);
    const shown = candidates.slice(0, TOUR_STEP_LIMIT);
    return {
      step, statements: step === 'attention' ? [...mandatory, ...shown] : shown,
      omitted: candidates.length - shown.length
    };
  });
  const unlisted = statements.filter((entry) => !accounted.has(entry.id)).length;
  return [...steps, { step: 'next', statements: [], omitted: 0, unlisted, action: next[0] ?? null }];
}

function presentationFor(model, selection, next = []) {
  const statements = model.statements.filter((entry) => selection.statements.includes(entry.id));
  const byKind = (kinds) => statements.filter((entry) => kinds.includes(entry.kind)).map((entry) => entry.id);
  const attentionStatements = model.attention.map((entry) => entry.statement)
    .filter((id) => selection.statements.includes(id));
  // Natural unit order: the inventory summary first, then units in their H-/O- enumeration order.
  const unitOrder = new Map((model.inventory?.units ?? []).map((unit, index) => [unit.nodeId, index]));
  const units = [
    ...byKind(['change-inventory']),
    ...byKind(['file-type', 'mode-change']),
    ...statements.filter((entry) => ['hunk', 'opaque-unit', 'declaration-overlap'].includes(entry.kind))
      .sort((left, right) => (unitOrder.get(left.about) ?? 0) - (unitOrder.get(right.about) ?? 0))
      .map((entry) => entry.id)
  ];
  const intent = byKind(['clause-declared', 'clause-cites', 'clause-required', 'clause-untagged', 'clause-tag', 'region-association',
    'exact-cause', 'binding-not-joined']);
  const checks = byKind(['test-tag', 'acceptance-tag', 'test-result', 'witness-result', 'test-attempt', 'evidence-reuse',
    'binding-decision', 'gap-observed', 'no-complete-evaluation']);
  const limits = byKind(['admission-unavailable', 'feature-state', 'source-state', 'cause-not-recorded', 'provenance-unavailable']);
  const history = byKind(['generation-recorded']);
  const unique = (ids) => [...new Set(ids)];
  const everything = statements.map((entry) => entry.id);
  const complete = (ordered) => unique([...ordered, ...everything]);
  return {
    // Order and folding only; every audience receives the same statement set [XPL2-LAW-005].
    audiences: {
      reviewer: { order: complete([...units, ...intent, ...checks, ...limits, ...attentionStatements]), folded: history },
      auditor: { order: complete([...limits, ...intent, ...checks, ...units, ...attentionStatements]), folded: [] },
      developer: { order: complete([...units, ...intent, ...checks, ...attentionStatements, ...limits]), folded: unique([...limits, ...history]) }
    },
    // The deterministic "Read this change" tour [XPL2 13.1]: purpose, changed units, links,
    // recorded checks, then blockers and unknowns. No model is involved.
    walkthrough: unique([
      ...byKind(['clause-declared', 'clause-cites']),
      ...byKind(['change-inventory']),
      ...byKind(['hunk', 'opaque-unit']).slice(0, 12),
      ...byKind(['file-type', 'mode-change']),
      ...byKind(['clause-tag', 'region-association', 'acceptance-tag', 'test-tag']),
      ...byKind(['test-result']),
      ...attentionStatements
    ]),
    // The structured tour also walks the query's derived statements (a line, a gap register, a
    // generation), which belong to this subject's selection.
    tour: readingTour([...statements, ...(model.derived ?? [])], attentionStatements, next)
  };
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** The kind of one after-side line inside a hunk of the bounded patch: added, or the baseline line it was. */
function afterLineInHunk(diff, unit, line) {
  if (diff?.status !== 'available' || typeof diff.patch !== 'string' || !unit.hunk) return null;
  const file = (diff.files ?? []).find((entry) => entry.pathBefore === (unit.location?.pathBefore ?? null)
    && entry.pathAfter === (unit.location?.pathAfter ?? null));
  if (!file) return null;
  const rows = diff.patch.slice(file.patchStart, file.patchEnd).split('\n');
  const header = rows.findIndex((row) => row.replace(/\r$/u, '') === String(unit.hunk.header ?? '').replace(/\r$/u, ''));
  if (header < 0) return null;
  let before = unit.hunk.before.start;
  let after = unit.hunk.after.start;
  for (const row of rows.slice(header + 1)) {
    if (row.startsWith('@@ ') || row.startsWith('diff --git ')) break;
    if (row.startsWith('-')) before += 1;
    else if (row.startsWith('+')) { if (after === line) return { kind: 'added' }; after += 1; }
    else if (row.startsWith(' ')) { if (after === line) return { kind: 'context', baselineLine: before }; before += 1; after += 1; }
  }
  return null;
}

/**
 * What ordinary commit history can say about one line [XPL2 12]: the exact baseline commit and
 * baseline line to ask `git blame` about, the change unit that added the line (no commit records
 * it yet), or why neither is possible. Pure; the command performs the one bounded Git read.
 */
export function xpl2LineHistoryRequest({ codeExplanation, diff = null, context = {} } = {}, rawQuery = {}) {
  const query = normalizeXpl2Query(rawQuery);
  if (query.subject !== 'line') return null;
  const revision = String(context?.base ?? '');
  const all = codeExplanation?.whyEachChange ?? [];
  const units = all.filter((unit) =>
    (query.side === 'before' ? unit.location?.pathBefore : unit.location?.pathAfter) === query.path);
  // On the after side, a path that only exists before the change was deleted or renamed away: it
  // has no after-side line to ask history about.
  const gone = query.side === 'after' && !units.length ? all.find((unit) => unit.location?.pathBefore === query.path) : null;
  if (gone) {
    const newPath = gone.location?.pathAfter ?? null;
    return { kind: 'file-gone', change: newPath ? 'renamed' : 'deleted', path: query.path, newPath };
  }
  if (units.some((unit) => unit.unitKind === 'untracked-region-opaque') && query.side === 'after') {
    return { kind: 'captured-change', unitId: units[0].unitId };
  }
  if (units.length && units.every((unit) => !unit.hunk)) {
    return { kind: 'unavailable', reason: units.some((unit) => unit.opacity?.reason === 'tracked-file-has-no-text-hunks') ? 'opaque-content' : 'text-projection-unavailable' };
  }
  if (!COMMIT.test(revision)) return { kind: 'unavailable', reason: 'source-not-recorded' };
  if (query.side === 'before') return { kind: 'baseline', revision, path: query.path, line: query.line, side: 'before', placement: 'baseline' };
  const covering = units.find((unit) => unit.hunk && unit.hunk.after.lines > 0 && query.line >= unit.hunk.after.start
    && query.line <= unit.hunk.after.start + unit.hunk.after.lines - 1);
  const basePath = units.find((unit) => unit.location?.pathBefore)?.location.pathBefore ?? (units.length ? null : query.path);
  if (covering) {
    const kind = afterLineInHunk(diff, covering, query.line);
    if (!kind) return { kind: 'unavailable', reason: 'text-projection-unavailable' };
    if (kind.kind === 'added' || !basePath) return { kind: 'captured-change', unitId: covering.unitId };
    return { kind: 'baseline', revision, path: basePath, line: kind.baselineLine, side: 'after', placement: 'context' };
  }
  if (!basePath) return { kind: 'captured-change', unitId: units[0]?.unitId ?? 'unit' };
  // Outside every unit the line is unchanged: shift it by the size change of each hunk above it.
  let offset = 0;
  for (const unit of units.filter((entry) => entry.hunk)) {
    const { before, after } = unit.hunk;
    const above = after.lines > 0 ? after.start + after.lines - 1 < query.line : after.start < query.line;
    if (above) offset += before.lines - after.lines;
  }
  return { kind: 'baseline', revision, path: basePath, line: query.line + offset, side: 'after', placement: 'outside' };
}

/** Admit what the line history read returned: a commit, the change unit, or the reason there is none. */
function lineHistoryStatements(b, derived, query, history) {
  const request = history?.request ?? null;
  // A deleted or renamed-away file is stated by the line locator itself.
  if (!request || request.kind === 'file-gone') return;
  if (request.kind === 'captured-change') {
    derived.push(b.derivedStatement({
      about: 'line', template: 'xpl2.line-changed@1', cites: ['SRC-MANIFEST'],
      arguments: { path: query.path, line: query.line, unitId: request.unitId }
    }));
    return;
  }
  const result = history.result;
  if (request.kind === 'baseline' && result && COMMIT.test(String(result.commit ?? ''))) {
    b.source({
      id: 'SRC-LINE-HISTORY', label: 'Commit history of the baseline', owner: 'git.commit-history', family: 'git-blame-line',
      recordId: result.commit, integrity: 'verified', origin: 'recorded-local', applicability: 'current', availability: 'present',
      coverage: { scope: `line ${request.line} of ${request.path} at the baseline commit`, complete: true }, subject: true
    });
    derived.push(b.derivedStatement({
      about: 'line', template: 'xpl2.line-commit@1', cites: ['SRC-LINE-HISTORY'],
      arguments: {
        side: query.side, path: query.path, line: query.line, placement: request.placement ?? 'baseline', baselineLine: request.line, commit: result.commit,
        summary: String(result.summary ?? ''), author: String(result.author ?? ''), authorTime: String(result.authorTime ?? 'an unrecorded time')
      },
      limitations: ['origin-unestablished']
    }));
    return;
  }
  const reason = request.kind === 'unavailable' ? request.reason : 'source-inaccessible';
  b.observation({
    id: 'OBS-LINE-HISTORY', adapter: 'git.commit-history', scope: 'commit history of the baseline for this line',
    completeness: 'unavailable', reason, subject: true
  });
  derived.push(b.derivedStatement({
    about: 'line', template: 'xpl2.line-commit-unavailable@1', cites: ['OBS-LINE-HISTORY'],
    arguments: { side: query.side, path: query.path, line: query.line, reason }
  }));
}

/** A recorded writer in plain words: which explicit turn of which Copilot session, or which invocation. */
function writerText(writer) {
  if (writer?.kind === 'copilot-turn') {
    const skill = /^(?:sf|sflow)-[a-z0-9-]+$/u.test(String(writer.skill ?? '')) ? `/${String(writer.skill).replace(/^sflow-/u, 'sf-')}` : 'an explicit SFlow';
    return `the ${skill} turn ${recordIdentifier(writer.turn, 'unrecorded').slice(0, 8)} of Copilot session ${recordIdentifier(writer.session, 'unrecorded')}`
      + `${writer.agent ? ` (agent ${recordText(writer.agent, 'unnamed')})` : ''}`;
  }
  if (writer?.kind === 'copilot-session') {
    const skill = writer.skill ? ` using skill ${recordText(writer.skill, 'unnamed')}` : '';
    return `a Copilot prompt ${recordIdentifier(writer.turn, 'unrecorded').slice(0, 8)} of session ${recordIdentifier(writer.session, 'unrecorded')}`
      + `${writer.agent ? ` (agent ${recordText(writer.agent, 'unnamed')})` : ''}${skill}`;
  }
  if (writer?.kind === 'model-invocation') return `model invocation ${recordText(writer.invocation, 'unrecorded')}`;
  return 'an unrecognized writer';
}

function writeSubjectText(subject) {
  if (!subject?.workId) return ', with no Story bound';
  return `, for Story ${recordText(subject.workId, 'unknown')}, step ${recordText(subject.phase, 'unknown')}`
    + (Number.isSafeInteger(Number(subject.generation)) && subject.generation != null ? `, generation ${Number(subject.generation)}` : ', with no generation open');
}

/**
 * Admit what this machine's observed writes say about one line [XPL2 M3]: the writer whose recorded
 * write changed it last, only when the writes explain the file's bytes exactly; otherwise the
 * general provenance statement and the precise reason observed writes do not establish one.
 */
function lineWriterStatements(b, derived, query, lineWriter) {
  const subject = `${query.path}:${query.line} (${query.side})`;
  const store = lineWriter?.store ?? null;
  const partial = Boolean(store?.dropped || store?.unreadable || store?.omitted);
  let cites = [];
  if (store?.status === 'available') {
    b.source({
      id: 'SRC-WRITES', label: 'Observed writes on this machine', owner: 'xpl2.observed-writes', family: 'observed-write-record',
      integrity: 'unverified', origin: 'observed-local', applicability: 'current', availability: 'present',
      coverage: { scope: 'this machine', complete: !partial, records: store.records.length, retentionDays: store.retentionDays ?? 0 }, subject: true
    });
    cites = ['SRC-WRITES'];
  } else if (lineWriter) {
    const unreadable = store?.status === 'inaccessible';
    b.observation({
      id: 'OBS-WRITES', adapter: 'xpl2.observed-writes', scope: 'observed writes of this file on this machine',
      completeness: unreadable ? 'unavailable' : 'complete-for-scope', reason: unreadable ? 'source-inaccessible' : 'source-not-recorded', subject: true
    });
    cites = ['OBS-WRITES'];
  }
  if (lineWriter?.status === 'attributed') {
    derived.push(b.derivedStatement({
      about: 'line', template: 'xpl2.line-writer@1', cites: [...cites, lineWriter.span === 'commit' ? 'SRC-LINE-HISTORY' : 'SRC-MANIFEST'],
      arguments: {
        side: query.side, path: query.path, line: query.line,
        writes: lineWriter.writes.slice(0, 3).map((write) => recordIdentifier(write.id, 'OW-unrecorded')).join(', ')
          + (lineWriter.writes.length > 3 ? ` and ${lineWriter.writes.length - 3} more` : ''),
        tools: [...new Set(lineWriter.writes.map((write) => recordText(write.tool, 'unrecorded tool')))].join(', '),
        writer: writerText(lineWriter.writer), subject: writeSubjectText(lineWriter.subject),
        span: lineWriter.span === 'commit' ? 'commit' : 'captured', commit: lineWriter.commit ?? 'none'
      },
      limitations: ['machine-local-only', ...(partial ? ['partial-inventory'] : [])]
    }));
    return;
  }
  // Ordinary commit history is not provenance, and no share of the content is estimated
  // [XPL2-AC-011, AC-041]; observed writes say precisely why they do not establish one either.
  derived.push(b.derivedStatement({
    about: 'line', template: 'xpl2.provenance-unavailable@1', cites: ['OBS-PROVENANCE'],
    arguments: { subject, reason: 'origin-unestablished' }
  }));
  if (lineWriter) {
    derived.push(b.derivedStatement({
      about: 'line', template: 'xpl2.line-writer-unestablished@1', cites,
      arguments: {
        subject, basis: lineWriter.basis, writes: Number.isSafeInteger(lineWriter.writes) ? lineWriter.writes : 0,
        span: lineWriter.span === 'commit' ? 'commit' : 'captured', commit: lineWriter.commit ?? 'none'
      },
      limitations: partial ? ['partial-inventory'] : []
    }));
  }
}

const INVOCATION_STATES = new Set(['completed', 'failed', 'started']);
const PROMPT_SOURCE_KINDS = new Set(['wm-compose', 'vscode-governed-handoff', 'model-invocation']);
const MAXIMUM_OVERLAPS = 20;

function instant(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : null;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._@/+-]{0,199}$/u;

/** A record string as template text: trimmed, bounded and never empty. */
function recordText(value, fallback) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return text ? text.slice(0, 300) : fallback;
}

/** A record value as a template identifier, or the fallback when it is not one. */
function recordIdentifier(value, fallback) {
  const text = recordText(value, '');
  return IDENTIFIER.test(text) ? text : fallback;
}

/**
 * Admit one generation's machine-local records [XPL2 12.1]: invocations in their own recorded
 * order with overlaps named rather than ordered, prompt-log entries by what they say they were,
 * and the phase's test attempts of that generation. Missing outcomes, tool observations, disabled
 * capture and unreadable stores stay visible as such; none is read as zero. A record without the
 * identity its statement needs is counted as unreadable and contributes nothing.
 */
function generationStatements(b, derived, query, sources) {
  const unreadable = (capture, records) => {
    if (records) {
      derived.push(b.derivedStatement({
        about: 'generation', template: 'xpl2.records-unreadable@1', cites: [CAPTURE_SOURCES[capture]],
        arguments: { capture, records }
      }));
    }
  };
  const inaccessible = (capture, id, adapter, scope, status) => {
    const reason = status === 'unsupported' ? 'unsupported-source-version' : 'source-inaccessible';
    b.observation({ id, adapter, scope, completeness: 'unavailable', reason, subject: true });
    derived.push(b.derivedStatement({
      about: 'generation', template: 'xpl2.capture-state@1', cites: [id],
      arguments: { capture, state: 'unreadable', records: 0, retentionDays: 0, reason }
    }));
  };
  const invocations = sources?.invocations ?? null;
  if (invocations?.status === 'available') {
    const records = [...invocations.records].sort((left, right) => String(left?.startedAt ?? '').localeCompare(String(right?.startedAt ?? ''))
      || String(left?.id).localeCompare(String(right?.id)));
    b.source({
      id: 'SRC-INVOCATIONS', label: 'Model invocation records on this machine', owner: 'model-runner.invocation-audit',
      family: 'model-invocation-audit',
      integrity: records.length && records.every((record) => record?.observationIntegrity === 'machine-local-mac') ? 'self-hashed' : 'unverified',
      origin: 'observed-local', applicability: 'current', availability: 'present',
      coverage: { scope: 'this machine', complete: !invocations.omitted, records: records.length }, subject: true
    });
    derived.push(b.derivedStatement({
      about: 'generation', template: 'xpl2.capture-state@1', cites: ['SRC-INVOCATIONS'],
      arguments: { capture: 'invocations', state: 'on', records: records.length, retentionDays: 0, reason: 'machine-local-only' },
      limitations: invocations.omitted ? ['partial-inventory'] : []
    }));
    const readable = [];
    let malformed = 0;
    for (const record of records) {
      const invocationId = recordText(record?.id, '');
      if (!invocationId) { malformed += 1; continue; }
      const status = INVOCATION_STATES.has(record.status) ? record.status : 'started';
      const calls = Array.isArray(record.toolObservation?.calls) ? record.toolObservation.calls : null;
      try {
        derived.push(b.derivedStatement({
          about: 'generation', template: 'xpl2.generation-invocation@1', cites: ['SRC-INVOCATIONS'],
          arguments: {
            invocationId, status,
            requestedModel: recordText(record.requestedModel, 'not recorded'),
            reportedModel: recordText(record.modelSelection?.providerSelectedModel, 'unreported'),
            startedAt: recordText(record.startedAt, 'not recorded'),
            completedAt: status === 'started' ? 'not recorded' : recordText(record.completedAt, 'not recorded'),
            toolsObserved: Boolean(calls), toolCalls: calls?.length ?? 0,
            integrity: record.observationIntegrity === 'machine-local-mac' ? 'machine-local-mac' : 'unverified-local'
          },
          limitations: [...(status === 'started' ? ['outcome-unobserved'] : []), 'origin-unestablished']
        }));
        readable.push({ ...record, id: invocationId });
      } catch { malformed += 1; }
    }
    unreadable('invocations', malformed);
    // Concurrent invocations keep their own IDs; arrival order is not a causal order [XPL2-AC-042].
    let overlaps = 0;
    for (let left = 0; left < readable.length && overlaps < MAXIMUM_OVERLAPS; left += 1) {
      for (let right = left + 1; right < readable.length && overlaps < MAXIMUM_OVERLAPS; right += 1) {
        const [a, c] = [readable[left], readable[right]];
        const aStart = instant(a.startedAt); const cStart = instant(c.startedAt);
        if (aStart == null || cStart == null) continue;
        const aEnd = instant(a.completedAt) ?? Infinity; const cEnd = instant(c.completedAt) ?? Infinity;
        if (aStart < cEnd && cStart < aEnd) {
          overlaps += 1;
          derived.push(b.derivedStatement({
            about: 'generation', template: 'xpl2.invocation-overlap@1', cites: ['SRC-INVOCATIONS'],
            arguments: { first: a.id, second: c.id }
          }));
        }
      }
    }
  } else if (invocations) {
    inaccessible('invocations', 'OBS-INVOCATIONS', 'model-runner.invocation-audit', 'model invocation records on this machine', invocations.status);
  }
  const prompts = sources?.prompts ?? null;
  if (prompts?.status === 'available') {
    // The prompt log is listed newest first up to its own bound before the generation is chosen.
    const partial = Boolean(prompts.omitted || prompts.truncated);
    b.source({
      id: 'SRC-PROMPTS', label: 'Prompt log on this machine', owner: 'prompt-audit', family: 'prompt-audit-record',
      integrity: prompts.integrity === 'verified' ? 'verified' : 'unverified', origin: 'recorded-local', applicability: 'current',
      availability: prompts.enabled ? 'present' : 'disabled',
      coverage: { scope: 'this machine', complete: !partial, records: prompts.records.length, retentionDays: prompts.retentionDays }, subject: true
    });
    derived.push(b.derivedStatement({
      about: 'generation', template: 'xpl2.capture-state@1', cites: ['SRC-PROMPTS'],
      arguments: {
        capture: 'prompt-log', state: prompts.enabled ? 'on' : 'off', records: prompts.records.length,
        retentionDays: prompts.enabled && Number.isSafeInteger(prompts.retentionDays) ? prompts.retentionDays : 0,
        reason: prompts.enabled ? 'machine-local-only' : 'recording-disabled'
      },
      limitations: partial ? ['partial-inventory'] : []
    }));
    let malformed = 0;
    for (const record of prompts.records) {
      const recordId = recordText(record?.id, '');
      if (!recordId) { malformed += 1; continue; }
      try {
        derived.push(b.derivedStatement({
          about: 'generation', template: 'xpl2.generation-prompt@1', cites: ['SRC-PROMPTS'],
          arguments: {
            recordId, source: PROMPT_SOURCE_KINDS.has(record.source) ? record.source : 'other',
            recordedAt: recordText(record.recordedAt, 'an unrecorded time'),
            redactions: Number.isSafeInteger(record.redactions) && record.redactions >= 0 ? record.redactions : 0,
            invocation: recordText(record.invocationId, 'none')
          }
        }));
      } catch { malformed += 1; }
    }
    unreadable('prompt-log', malformed);
    // Entries retention removed are named from the log's own removal notes [XPL2-AC-043]; an entry
    // removed before notes were kept, or past their bound, still cannot be told from one never kept.
    const removed = prompts.removed?.status === 'available' ? prompts.removed : null;
    for (const reason of ['expired', 'size']) {
      const group = (removed?.entries ?? []).filter((entry) => entry.reason === reason);
      if (!group.length) continue;
      const times = group.map((entry) => recordText(entry.recordedAt, '')).filter(Boolean).sort();
      derived.push(b.derivedStatement({
        about: 'generation', template: 'xpl2.prompt-entries-removed@1', cites: ['SRC-PROMPTS'],
        arguments: { records: group.length, reason, earliest: times[0] ?? 'an unrecorded time', latest: times.at(-1) ?? 'an unrecorded time' },
        limitations: ['source-expired', ...(removed.complete ? [] : ['partial-inventory'])]
      }));
    }
    for (const clear of (removed?.cleared ?? []).slice(-3)) {
      derived.push(b.derivedStatement({
        about: 'generation', template: 'xpl2.prompt-log-cleared@1', cites: ['SRC-PROMPTS'],
        arguments: { clearedAt: recordText(clear.removedAt, 'an unrecorded time'), records: Number.isSafeInteger(clear.records) && clear.records >= 0 ? clear.records : 0 }
      }));
    }
  } else if (prompts) {
    inaccessible('prompt-log', 'OBS-PROMPTS', 'prompt-audit', 'prompt log on this machine', prompts.status);
  }
  const writes = sources?.writes ?? null;
  if (writes?.status === 'available') {
    const partial = Boolean(writes.omitted || writes.dropped || writes.unreadable);
    b.source({
      id: 'SRC-WRITES', label: 'Observed writes on this machine', owner: 'xpl2.observed-writes', family: 'observed-write-record',
      integrity: 'unverified', origin: 'observed-local', applicability: 'current', availability: 'present',
      coverage: { scope: 'this machine', complete: !partial, records: writes.records.length, retentionDays: writes.retentionDays ?? 0 }, subject: true
    });
    derived.push(b.derivedStatement({
      about: 'generation', template: 'xpl2.capture-state@1', cites: ['SRC-WRITES'],
      arguments: {
        capture: 'writes', state: 'on', records: writes.records.length, retentionDays: Number.isSafeInteger(writes.retentionDays) ? writes.retentionDays : 0,
        reason: writes.records.length ? 'machine-local-only' : 'source-not-recorded'
      },
      limitations: partial ? ['partial-inventory'] : []
    }));
    let malformed = 0;
    for (const record of writes.records) {
      const files = Array.isArray(record?.files) ? record.files.filter((file) => typeof file?.path === 'string') : [];
      const writeId = recordIdentifier(record?.id, '');
      if (!writeId || !files.length) { malformed += 1; continue; }
      try {
        derived.push(b.derivedStatement({
          about: 'generation', template: 'xpl2.generation-write@1', cites: ['SRC-WRITES'],
          arguments: {
            writeId, tools: recordText(record.tool, 'an unrecorded tool'), writer: writerText(record.writer),
            recordedAt: recordText(record.recordedAt, 'an unrecorded time'), files: files.length,
            verified: files.filter((file) => file.verified === true).length,
            paths: files.slice(0, 5).map((file) => file.path).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '')
          }
        }));
      } catch { malformed += 1; }
    }
    unreadable('writes', malformed);
  } else if (writes) {
    inaccessible('writes', 'OBS-WRITES', 'xpl2.observed-writes', 'observed writes of this generation on this machine', writes.status);
  }
  const attempts = sources?.attempts ?? null;
  if (attempts?.status === 'available') {
    b.source({
      id: 'SRC-GENERATION-ATTEMPTS', label: 'Test attempts of this generation', owner: 'verification.test-attempts', family: 'test-execution',
      integrity: 'unverified', origin: 'recorded-local', applicability: 'current', availability: 'present',
      coverage: { scope: 'admitted and kept attempts on this machine', complete: !attempts.omitted, records: attempts.records.length }, subject: true
    });
    derived.push(b.derivedStatement({
      about: 'generation', template: 'xpl2.capture-state@1', cites: ['SRC-GENERATION-ATTEMPTS'],
      arguments: {
        capture: 'attempts', state: 'on', records: attempts.records.length, retentionDays: 0,
        reason: attempts.records.length ? 'machine-local-only' : 'source-not-recorded'
      },
      limitations: attempts.omitted ? ['partial-inventory'] : []
    }));
    let malformed = 0;
    for (const record of attempts.records) {
      const attemptId = recordIdentifier(record?.attemptId, '');
      if (!attemptId) { malformed += 1; continue; }
      const tests = record.tests && typeof record.tests === 'object' ? record.tests : null;
      const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
      try {
        derived.push(b.derivedStatement({
          about: 'generation', template: 'xpl2.test-attempt@1', cites: ['SRC-GENERATION-ATTEMPTS'],
          arguments: {
            attemptId, commandId: recordText(record.commandId, 'an unrecorded command'),
            purpose: recordIdentifier(record.purpose, 'unknown'), status: recordIdentifier(record.status, 'unavailable'),
            completedAt: recordText(record.process?.completedAt, 'not recorded'),
            countsKnown: Boolean(tests), passed: count(tests?.passed), failed: count(tests?.failed), skipped: count(tests?.skipped),
            previous: recordText(record.parentAttemptId, 'none')
          }
        }));
      } catch { malformed += 1; }
    }
    unreadable('attempts', malformed);
  } else if (attempts) {
    inaccessible('attempts', 'OBS-GENERATION-ATTEMPTS', 'verification.test-attempts', 'test attempts of this generation on this machine', attempts.status);
  }
}

const CAPTURE_SOURCES = Object.freeze({ writes: 'SRC-WRITES', invocations: 'SRC-INVOCATIONS', 'prompt-log': 'SRC-PROMPTS', attempts: 'SRC-GENERATION-ATTEMPTS' });

function nextActions(model) {
  const first = model.attention[0] ?? null;
  return first ? [{
    id: 'xpl2.inspect-attention', kind: 'inspect', about: first.about,
    label: 'Inspect the first attention item; inspection changes nothing.'
  }] : [];
}

/**
 * Build one subject view. `input` is the slice-derived universe input; `proof` optionally carries
 * a shadow-proof gap register already read through its owner for the `gap` subject.
 */
export function explainXpl2Subject(input, rawQuery = {}, {
  proof = null, maximumUnits = null, lineHistory = null, lineWriter = null, generationSources = null
} = {}) {
  const query = normalizeXpl2Query(rawQuery);
  const universe = buildChangeExplanationUniverse({
    ...input, includeAllDeclaredClauses: query.subject === 'clause'
  });
  const b = universe.builder;
  const derived = [];
  let status = 'available';
  let reason = null;
  let choices = [];
  let seeds = null;

  if (query.subject === 'gap') {
    if (proof?.gaps) {
      b.source({
        id: 'SRC-PROOF', label: 'Shadow proof observation', owner: 'gdp.shadow-proof', family: 'gdp-proof-gaps-view',
        recordId: proof.proofSubjectSha256 ?? null, digest: proof.proofSummarySha256 ?? null,
        integrity: proof.proofSummarySha256 ? 'self-hashed' : 'unverified', origin: 'recorded-local',
        applicability: 'unknown', availability: 'present',
        coverage: { scope: 'selected Story, observe mode', complete: false, gaps: proof.gaps.length }, subject: true
      });
      for (const gap of proof.gaps.slice(0, 200)) {
        const code = String(gap?.code ?? gap?.gapCode ?? gap?.id ?? 'GAP').replace(/[^A-Za-z0-9:._@/+-]/gu, '_').slice(0, 120) || 'GAP';
        const subjectLabel = String(gap?.subject ?? gap?.clauseId ?? gap?.predicate ?? input.context?.workId ?? 'this Story');
        derived.push(b.derivedStatement({
          about: 'gap', template: 'xpl2.gap-observed@1', cites: ['SRC-PROOF'],
          arguments: { code, subject: subjectLabel }, limitations: ['evaluation-unavailable']
        }));
      }
    } else {
      b.observation({
        id: 'OBS-PROOF', adapter: 'gdp.shadow-proof', scope: 'shadow proof gap register for the selected Story',
        completeness: 'unavailable', reason: input.context?.workId ? 'evaluation-unavailable' : 'no-active-story', subject: true
      });
    }
    derived.push(b.derivedStatement({
      about: 'gap', template: 'xpl2.no-complete-evaluation@1', cites: ['OBS-ADMISSION'], arguments: {}
    }));
  }

  if (query.subject === 'line') {
    const matches = universe.inventory.units.filter((unit) => {
      const path = query.side === 'before' ? unit.pathBefore : unit.pathAfter;
      if (path !== query.path) return false;
      if (!unit.hunk) return true;
      const range = unit.hunk[query.side];
      return range.lines > 0 && query.line >= range.start && query.line <= range.start + range.lines - 1;
    });
    const textual = matches.filter((unit) => unit.hunk);
    const opaque = matches.filter((unit) => !unit.hunk);
    const gone = query.side === 'after' && !universe.inventory.units.some((unit) => unit.pathAfter === query.path)
      ? universe.inventory.units.filter((unit) => unit.pathBefore === query.path) : [];
    const citeLine = universe.availability.diff === 'available' ? ['SRC-DIFF', 'SRC-MANIFEST'] : ['SRC-MANIFEST'];
    if (textual.length) {
      seeds = textual.map((unit) => unit.nodeId);
      for (const unit of textual) {
        derived.push(b.derivedStatement({
          about: unit.nodeId, template: 'xpl2.line-in-unit@1', cites: citeLine,
          arguments: { side: query.side, path: query.path, line: query.line, unitId: unit.unitId }
        }));
        // An exactly bound changed line names the binding, never an author [XPL2 M4].
        const covering = (universe.anchors.bindingIntervals.get(unit.nodeId) ?? []).filter((interval) => {
          const [start, lines] = query.side === 'before' ? [interval.beforeStart, interval.beforeLines] : [interval.afterStart, interval.afterLines];
          return Number(lines) > 0 && query.line >= start && query.line <= start + lines - 1;
        });
        for (const phase of [...new Set(covering.map((interval) => `${interval.phase}\u0000${interval.generation}`))]) {
          const [phaseId, generation] = phase.split('\u0000');
          const clauses = [...new Set(covering.filter((interval) => interval.phase === phaseId && interval.generation === generation)
            .map((interval) => interval.clauseId))].sort();
          derived.push(b.derivedStatement({
            about: unit.nodeId, template: 'xpl2.line-binding@1',
            cites: [...b.sourceIds().filter((id) => id.startsWith('SRC-BINDINGS-')), ...citeLine],
            arguments: { side: query.side, path: query.path, line: query.line, unitId: unit.unitId, clauses: clauses.join(', '), phase: phaseId, generation }
          }));
        }
      }
    } else if (opaque.length) {
      seeds = opaque.map((unit) => unit.nodeId);
      derived.push(b.derivedStatement({
        about: opaque[0].nodeId, template: 'xpl2.line-opaque@1', cites: ['SRC-MANIFEST'],
        arguments: { side: query.side, path: query.path, line: query.line, unitId: opaque[0].unitId }
      }));
    } else if (gone.length) {
      // The path exists only before the change: it was deleted or renamed away, and has no after side.
      seeds = gone.map((unit) => unit.nodeId);
      status = 'unavailable';
      reason = 'not-applicable';
      derived.push(b.derivedStatement({
        about: gone[0].nodeId, template: 'xpl2.line-file-gone@1', cites: ['SRC-MANIFEST'],
        arguments: { path: query.path, line: query.line, change: gone[0].pathAfter ? 'renamed' : 'deleted', newPath: gone[0].pathAfter ?? 'none' }
      }));
    } else {
      b.observation({
        id: 'OBS-LINE', adapter: 'xpl2.line-locator', scope: 'change units of this captured interval',
        completeness: 'complete-for-scope', reason: 'outside-change-set', subject: true
      });
      seeds = [];
      status = 'unavailable';
      reason = 'outside-change-set';
      derived.push(b.derivedStatement({
        about: 'line', template: 'xpl2.line-outside@1', cites: ['OBS-LINE', 'SRC-MANIFEST'],
        arguments: { side: query.side, path: query.path, line: query.line }
      }));
    }
    lineHistoryStatements(b, derived, query, lineHistory);
    lineWriterStatements(b, derived, query, lineWriter);
  }

  if (query.subject === 'generation') {
    const workflow = input.workflow;
    const phase = workflow?.phases?.[query.phase] ?? null;
    if (!workflow) {
      status = 'unavailable';
      reason = 'no-active-story';
    } else if (!phase || !Number.isSafeInteger(phase.generation) || query.generation > phase.generation) {
      status = 'unavailable';
      reason = 'subject-not-found';
    } else {
      const events = (input.replay?.events ?? []).filter((event) => event.phase === query.phase
        && Number(event.generation) === query.generation);
      if (input.replay) {
        derived.push(b.derivedStatement({
          about: 'generation', template: 'xpl2.generation-recorded@1', cites: ['SRC-REPLAY', 'SRC-STORY'],
          arguments: {
            phase: query.phase, generation: String(query.generation), events: events.length,
            status: String(phase.status ?? 'unknown').replace(/[^A-Za-z0-9:._@/+-]/gu, '_') || 'unknown'
          },
          limitations: input.replay.truncated ? ['partial-inventory'] : []
        }));
      }
      generationStatements(b, derived, query, generationSources);
      // Records of invocations and prompts are not observed writes: no record says which lines any
      // of them produced, so the generation's authorship stays unestablished [XPL2-AC-011].
      derived.push(b.derivedStatement({
        about: 'generation', template: 'xpl2.provenance-unavailable@1', cites: ['OBS-PROVENANCE', 'OBS-PE'],
        arguments: { subject: `${query.phase} generation ${query.generation}`, reason: generationSources ? 'origin-unestablished' : 'adapter-unavailable' }
      }));
    }
    seeds = [];
  }

  // Build once to resolve node/relationship lists, then compute the exact subject selection.
  const draft = b.build({
    subject: { kind: query.subject }, snapshot: universe.snapshot, inventory: universe.inventory,
    availability: universe.availability
  });
  const lookup = { ...draft, builderRelationships: draft.relationships };
  if (query.subject === 'clause') {
    const matches = draft.nodes.filter((node) => node.kind === 'clause' && node.label === query.id);
    if (matches.length === 1) seeds = [matches[0].id];
    else { status = 'unavailable'; reason = 'subject-not-found'; seeds = []; }
  }
  if (query.subject === 'test') {
    const matches = draft.nodes.filter((node) => ['test', 'run'].includes(node.kind) && node.label === query.id);
    if (matches.length === 1) seeds = [matches[0].id];
    else if (matches.length > 1) {
      status = 'ambiguous'; reason = 'subject-ambiguous'; seeds = [];
      choices = matches.map((node) => ({ kind: node.kind, label: node.label, nodeId: node.id }));
    } else { status = 'unavailable'; reason = 'subject-not-found'; seeds = []; }
  }
  if (query.subject === 'change' && !universe.inventory.units.length) {
    status = 'not-applicable';
    reason = 'complete-empty';
  }

  let selection;
  if (query.subject === 'change') {
    selection = null;
  } else if (query.subject === 'gap') {
    const ids = draft.attention.map((entry) => entry.statement);
    selection = { statements: [...new Set(ids)], nodes: [...new Set(draft.attention.map((entry) => entry.about).filter((id) => draft.nodes.some((node) => node.id === id)))], relationships: [] };
  } else {
    const { nodes, relationships } = neighbourhood(lookup, seeds ?? []);
    const statements = draft.statements.filter((entry) => nodes.has(entry.about)).map((entry) => entry.id);
    selection = { statements, nodes: [...nodes], relationships };
  }
  let effectiveSelection = selection ?? {
    statements: draft.statements.map((entry) => entry.id),
    nodes: draft.nodes.map((node) => node.id),
    relationships: draft.relationships.map((edge) => edge.id)
  };
  // Bounded delivery omits whole units (and only units) past the limit; counts stay complete and
  // the omission is explicit [XPL2-REQ-035].
  let delivery = { complete: true, reason: null };
  const selectedUnits = universe.inventory.units.filter((unit) => effectiveSelection.nodes.includes(unit.nodeId));
  if (Number.isSafeInteger(maximumUnits) && maximumUnits >= 1 && selectedUnits.length > maximumUnits) {
    const omitted = new Set(selectedUnits.slice(maximumUnits).map((unit) => unit.nodeId));
    effectiveSelection = {
      statements: effectiveSelection.statements.filter((id) => !omitted.has(draft.statements.find((entry) => entry.id === id)?.about)),
      nodes: effectiveSelection.nodes.filter((id) => !omitted.has(id)),
      relationships: effectiveSelection.relationships.filter((id) => {
        const edge = draft.relationships.find((entry) => entry.id === id);
        return edge && !omitted.has(edge.from) && !omitted.has(edge.to);
      })
    };
    delivery = {
      complete: false, reason: 'bounded-delivery',
      returnedUnits: maximumUnits, totalUnits: selectedUnits.length, omittedUnits: selectedUnits.length - maximumUnits
    };
  }
  const subject = {
    kind: query.subject,
    selector: {
      id: query.id, path: query.path, line: query.line, side: query.side,
      phase: query.phase, generation: query.generation
    },
    status, reason, choices
  };
  const next = nextActions(draft);
  const presentation = presentationFor(draft, effectiveSelection, next);
  return b.build({
    subject,
    snapshot: universe.snapshot,
    inventory: universe.inventory,
    availability: universe.availability,
    next,
    presentation: { audience: query.audience, ...presentation },
    selection: effectiveSelection,
    delivery
  });
}
