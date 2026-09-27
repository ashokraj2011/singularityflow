import { SingularityFlowError } from './util.mjs';

const PHASE_STATUSES = Object.freeze([
  'not_started', 'in_progress', 'awaiting_approval', 'approved', 'cancelled'
]);
export const STORY_ROSTER_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const text = (value) => typeof value === 'string' && value.length > 0 ? value : null;

/** Read only the phase order and states retained by this Story, never today's global profile. */
export function storyLifecycleProgress(workflow) {
  const id = text(workflow?.currentPhase);
  const phase = id && own(workflow?.phases, id) ? workflow.phases[id] : null;
  const current = Object.freeze({
    id,
    status: own(phase, 'status') && PHASE_STATUSES.includes(phase.status) ? phase.status : null,
    // Zero is the real initial generation; missing historical data must not become zero or one.
    generation: own(phase, 'generation') && Number.isSafeInteger(phase.generation) && phase.generation >= 0
      ? phase.generation : null
  });
  const unavailable = (reason) => Object.freeze({
    schemaVersion: 1, available: false, approved: null, total: null,
    statusCounts: null, current, reason
  });
  const order = workflow?.phaseOrder;
  if (!Array.isArray(order) || order.length === 0) return unavailable('phase-order-unavailable');
  if (order.some((entry) => !text(entry)) || new Set(order).size !== order.length) {
    return unavailable('phase-order-invalid');
  }
  // Newer Stories also retain the resolved configuration. A contradictory copy cannot prove a
  // denominator. Historical records without that optional snapshot keep their own phase order.
  const retained = workflow?.resolution?.phases;
  if (retained != null && (!Array.isArray(retained) || retained.length !== order.length
      || retained.some((entry, index) => entry?.id !== order[index]))) {
    return unavailable('retained-phase-order-mismatch');
  }
  if (id && !order.includes(id)) return unavailable('current-phase-not-in-order');
  const statusCounts = Object.fromEntries(PHASE_STATUSES.map((status) => [status, 0]));
  for (const phaseId of order) {
    if (!own(workflow?.phases, phaseId) || !object(workflow.phases[phaseId])) {
      return unavailable('phase-state-unavailable');
    }
    const state = workflow.phases[phaseId];
    if ((own(state, 'id') && state.id !== phaseId) || !own(state, 'status')
        || !PHASE_STATUSES.includes(state.status)) {
      return unavailable('phase-state-invalid');
    }
    statusCounts[state.status]++;
  }
  return Object.freeze({
    schemaVersion: 1, available: true, approved: statusCounts.approved, total: order.length,
    statusCounts: Object.freeze(statusCounts), current, reason: null
  });
}

function fail(message, code = 'SESSION_ROSTER_INVALID') {
  throw new SingularityFlowError(message, { code });
}

function outputBudget(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > STORY_ROSTER_MAX_OUTPUT_BYTES) {
    fail(`Story roster output must be bounded to 1–${STORY_ROSTER_MAX_OUTPUT_BYTES} bytes.`,
      'SESSION_ROSTER_OUTPUT_LIMIT');
  }
  return value;
}

/** Literal cells: repository text cannot introduce rows, links, HTML, or terminal controls. */
function cell(value, maximumBytes, fallback = 'unavailable') {
  if (!text(value)) return fallback;
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail('The complete Story roster exceeds its output bound. Use the JSON discovery result instead.',
      'SESSION_ROSTER_OUTPUT_LIMIT');
  }
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (control) => {
      if (control === '\n') return '\\n';
      if (control === '\r') return '\\r';
      if (control === '\t') return '\\t';
      const codepoint = control.codePointAt(0);
      return codepoint > 0xffff ? `\\u{${codepoint.toString(16)}}`
        : `\\u${codepoint.toString(16).padStart(4, '0')}`;
    })
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/[|`*_\[\]{}()!~]/gu, (character) => `\\${character}`);
}

function selectedItem(item, result, active) {
  if (!object(active) || !(active.ready === true || active.selectionStatus === 'ready')) return false;
  const activeId = text(active.storyId) ?? text(active.workId);
  if (!activeId || activeId !== item.id || !text(active.branch) || active.branch !== item.branch) return false;
  const sourcePath = text(item.repositoryPath) ?? text(result.repositoryPath);
  if (!sourcePath || ![active.repositoryPath, active.canonicalRepositoryPath].includes(sourcePath)) return false;
  for (const key of ['workspaceId', 'repositoryId']) {
    const expected = text(item[key]) ?? text(result[key]);
    if (expected && active[key] !== expected) return false;
  }
  return true;
}

function countsAvailable(progress) {
  // This is an ephemeral projection, not a second durable-record version reader.
  return object(progress) && progress.available === true
    && Number.isSafeInteger(progress.approved) && progress.approved >= 0
    && Number.isSafeInteger(progress.total) && progress.total > 0
    && progress.approved <= progress.total;
}

/**
 * Render the entire verified discovery result, or refuse its bound before returning any output.
 * Row numbers are display-only; callers must still attach an explicitly chosen exact Story ID.
 */
export function renderStoryRoster(result, {
  scope = null, activeSelection = null, maxOutputBytes = STORY_ROSTER_MAX_OUTPUT_BYTES
} = {}) {
  const maximumBytes = outputBudget(maxOutputBytes);
  if (!object(result) || !Array.isArray(result.items)
      || (result.unavailable != null && !Array.isArray(result.unavailable))) {
    fail('Story roster requires a complete discovery result with its items and diagnostics.');
  }
  const diagnostics = result.unavailable ?? [];
  const lines = [];
  let bytes = 0;
  const add = (line) => {
    bytes += Buffer.byteLength(line, 'utf8') + (lines.length ? 1 : 0);
    if (bytes > maximumBytes) fail(
      'The complete Story roster exceeds its output bound. Use the JSON discovery result instead; no rows were omitted.',
      'SESSION_ROSTER_OUTPUT_LIMIT'
    );
    lines.push(line);
  };
  const literal = (value, fallback) => cell(value, maximumBytes, fallback);
  const showSelection = result.items.some((item) => object(item)
    && selectedItem(item, result, activeSelection));
  add('# Governed Story roster');
  add('');
  if (text(scope?.workspaceReference)) add(`Workspace selector: ${literal(scope.workspaceReference)}`);
  if (text(scope?.repositoryId)) add(`Repository selector: ${literal(scope.repositoryId)}`);
  if (text(scope?.repositoryUrl)) add(`Repository URL selector: ${literal(scope.repositoryUrl)}`);
  add(`Discovery source: ${literal(result.source, text(scope?.repositoryUrl) ? 'remote URL metadata' : 'materialized remote refs')}`);
  add(`Scanned repository: ${literal(result.repositoryPath)}`);
  add(`Story remote: ${literal(result.remote)}`);
  add(`Verified Story rows: ${result.items.length}`);
  add('Progress is approved phases / retained configured phases, not estimated code completion.');
  if (showSelection) add('The selected marker comes from an exact supplied ready repository, Story, and branch binding; it is not a selection request.');
  if (result.count != null && result.count !== result.items.length) {
    add(`Warning: the discovery count ${literal(String(result.count))} differs from the retained rows; this roster may be incomplete.`);
  }
  add('');
  add(`| # | Story ID | Title | Status | Current phase | Phase status | Generation | Progress (approved/total) | Branch |${showSelection ? ' Selection |' : ''}`);
  add(`|---:|---|---|---|---|---|---:|---|---|${showSelection ? '---|' : ''}`);
  result.items.forEach((item, index) => {
    if (!object(item) || !text(item.id)) fail(`Story roster row ${index + 1} has no verified Story identity.`);
    const progress = item.progress;
    const available = countsAvailable(progress);
    const current = object(progress?.current) ? progress.current : null;
    const phaseId = text(item.phase);
    const samePhase = current?.id === phaseId;
    const generation = samePhase && Number.isSafeInteger(current?.generation) && current.generation >= 0
      ? String(current.generation) : 'unavailable';
    const fraction = available ? `${progress.approved}/${progress.total}` : 'unavailable';
    add(`| ${index + 1} | ${literal(item.id)} | ${literal(item.title)} | ${literal(item.status)} | ${literal(phaseId, '—')} | ${samePhase ? literal(current?.status) : 'unavailable'} | ${generation} | ${fraction} | ${literal(item.branch)} |${showSelection ? ` ${selectedItem(item, result, activeSelection) ? 'selected' : '—'} |` : ''}`);
  });
  if (!result.items.length) add('');
  if (!result.items.length) add('No verified governed Stories were found in this discovery scope.');
  const unavailableProgress = result.items.filter((item) => !countsAvailable(item.progress)).length;
  if (unavailableProgress) {
    add('');
    add(`Lifecycle counts are unavailable for ${unavailableProgress} verified Story rows; missing or contradictory phase evidence was not turned into an estimated denominator or approval count.`);
  }
  const reported = Number.isSafeInteger(result.unavailableCount) && result.unavailableCount >= 0
    ? result.unavailableCount : diagnostics.length;
  if (reported || diagnostics.length) {
    add('');
    add(`Warning: discovery is incomplete or contains conflicting/unreadable claims (${reported} reported; ${diagnostics.length} retained diagnostics). Unavailable Stories were not treated as absent or selected.`);
    if (reported !== diagnostics.length) {
      add('Warning: the diagnostic count differs from the retained detail; not every unavailable claim is described below.');
    }
    if (diagnostics.length) {
      add('');
      add('| # | Claimed Story | Branch / ref | State path | Diagnostic | Reason |');
      add('|---:|---|---|---|---|---|');
      diagnostics.forEach((entry, index) => {
        if (!object(entry)) fail(`Story roster diagnostic ${index + 1} is not a retained diagnostic record.`);
        add(`| ${index + 1} | ${literal(entry.claimedId)} | ${literal(text(entry.branch) ?? text(entry.ref))} | ${literal(entry.path)} | ${literal(entry.code)} | ${literal(entry.reason)} |`);
      });
    }
  }
  add('');
  add('Choose an exact Story ID explicitly, then use the existing safe session attach command. Listing this roster does not activate or mutate a Story.');
  add('Copilot: `/sf-session` — supply the exact chosen Story ID and preserve the scope shown above.');
  const scoped = text(scope?.workspaceReference) || text(scope?.repositoryUrl);
  const selectorPlaceholders = scoped
    ? ' --workspace <EXACT-WORKSPACE-ID-OR-PATH> --repository <EXACT-REPOSITORY-ID>' : '';
  add(`Shell: \`singularity-flow session attach <EXACT-STORY-ID>${selectorPlaceholders}\``);
  if (scoped) add('Replace the selector placeholders with the exact captured workspace and repository; do not switch to an old host checkout.');
  if (text(scope?.repositoryUrl)) add('URL-only discovery is read-only: choose a matching registered workspace/repository before attaching; session attach does not accept --repository-url.');
  return lines.join('\n');
}
