/** GDP-M8 exact Outcome-to-Workflow handoff plans. */
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { validateOutcomeSelectionBundle } from './delivery-kernel.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PROFILES = new Set(['feature', 'bugfix']);

function fail(message, code = 'GDM_PROMOTION_PLAN_INVALID') {
  const error = new TypeError(`GDP promotion: ${message}`); error.code = code; throw error;
}
function digest(value) { return `sha256:${recordSha256(value)}`; }
function exact(value, label, nullable = false) {
  if (nullable && value == null) return null;
  if (!DIGEST.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value);
}
function text(value, label, maximum = 320) {
  const result = String(value ?? '');
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) fail(`${label} is invalid.`);
  return result;
}
function seal(fields) {
  const core = {
    schemaVersion: currentSchemaVersion('delivery-mode-transition'),
    kind: 'delivery-mode-transition', ...fields
  };
  return Object.freeze({ ...core, transitionSha256: digest(core) });
}

export function buildPromotionPlan({
  session, targetWorkId, targetWorkflowProfile, expectedHead, changeSetSha256 = null
} = {}) {
  if (!session?.gdp) fail('Outcome session has no GDP delivery selection.');
  validateOutcomeSelectionBundle(session.gdp);
  if (session.gdp.selection.deliveryMode !== 'outcome') fail('Only Outcome mode can be promoted.');
  if (!PROFILES.has(targetWorkflowProfile)) fail(`workflow '${targetWorkflowProfile}' is not mapped.`);
  const workId = text(targetWorkId, 'targetWorkId', 160);
  const sessionId = text(session.sessionId, 'sessionId', 96);
  return seal({
    transitionId: `GDT-${recordSha256({ sessionId, workId, targetWorkflowProfile }).slice(0, 24).toUpperCase()}`,
    workId, sessionId, fromMode: 'outcome', targetMode: 'workflow', targetWorkflowProfile,
    preservedBranch: text(session.branch, 'preservedBranch'),
    expectedHead: text(expectedHead, 'expectedHead', 64),
    baselineSha256: exact(session.baseline?.baselineSha256, 'baselineSha256'),
    changeSetSha256: exact(changeSetSha256, 'changeSetSha256', true),
    selectionSha256: session.gdp.selection.selectionSha256,
    completionContractSha256: session.gdp.completionContract.contractSha256,
    sourceTransitionSha256: null, status: 'planned',
    targetArgv: [
      'singularity-flow', 'start', workId, '--workflow', targetWorkflowProfile,
      '--from-branch', session.branch, '--allow-dirty'
    ]
  });
}

export function applyPromotionPlan({ plan, session, expectedHead, changeSetSha256 = null } = {}) {
  const verified = validateDeliveryModeTransition(plan);
  if (verified.status !== 'planned' || verified.sourceTransitionSha256 !== null) {
    fail('Only a reviewed planned transition can be applied.');
  }
  const current = buildPromotionPlan({
    session, targetWorkId: verified.workId,
    targetWorkflowProfile: verified.targetWorkflowProfile,
    expectedHead, changeSetSha256
  });
  if (current.transitionSha256 !== verified.transitionSha256) {
    fail('Outcome session, branch, HEAD, or effect identity changed after preview.', 'GDM_PROMOTION_PLAN_STALE');
  }
  const core = structuredClone(verified);
  delete core.schemaVersion; delete core.kind; delete core.transitionSha256;
  core.sourceTransitionSha256 = verified.transitionSha256;
  core.status = 'handoff-ready';
  return seal(core);
}

export function validateDeliveryModeTransition(value) {
  const expected = [
    'schemaVersion', 'kind', 'transitionId', 'workId', 'sessionId', 'fromMode',
    'targetMode', 'targetWorkflowProfile', 'preservedBranch', 'expectedHead',
    'baselineSha256', 'changeSetSha256', 'selectionSha256', 'completionContractSha256',
    'sourceTransitionSha256', 'status', 'targetArgv', 'transitionSha256'
  ].sort();
  if (canonicalJson(Object.keys(value ?? {}).sort()) !== canonicalJson(expected)) {
    fail('transition has an invalid field set.');
  }
  const readable = readRecord('delivery-mode-transition', value);
  if (readable.migratedThrough.length || value.kind !== 'delivery-mode-transition') fail('transition is not current.');
  const core = structuredClone(value); delete core.transitionSha256;
  if (value.transitionSha256 !== digest(core)) fail('transition self hash is invalid.');
  if (!['planned', 'handoff-ready'].includes(value.status)
      || value.fromMode !== 'outcome' || value.targetMode !== 'workflow'
      || !PROFILES.has(value.targetWorkflowProfile)) fail('transition vocabulary is invalid.');
  if (!Array.isArray(value.targetArgv) || value.targetArgv.length !== 8
      || value.targetArgv.some((entry) => typeof entry !== 'string' || !entry)) {
    fail('targetArgv is invalid.');
  }
  return Object.freeze(structuredClone(value));
}
