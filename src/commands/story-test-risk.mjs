/** Exact human-reviewed exception routes; no command executes a test or accepts an inferred risk. */
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { repoRoot } from '../git.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { publicTestAmendment } from './story-test-amendment.mjs';

const digest = /^sha256:[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const operations = new Set(['publish', 'submit', 'approve', 'downstream', 'replay']);
const actions = new Set(['risks', 'accept-risk', 'revoke-risk', 'attest-risk']);
const fail = (message, code = 'TRP_RISK_ARGUMENT_INVALID') => { throw new SingularityFlowError(message, { code }); };
const runtime = {
  loadAcceptedStoryExecution,
  async plan(...args) { return (await import('../story-test-risk.mjs')).planStoryTestRisk(...args); },
  async accept(...args) { return (await import('../story-test-risk.mjs')).acceptStoryTestRisk(...args); },
  async revoke(...args) { return (await import('../story-test-risk.mjs')).revokeStoryTestRisk(...args); },
  async attest(...args) { return (await import('../story-test-risk.mjs')).attestStoryTestRisk(...args); }
};
function textOption(options, key, minimum = 1, maximum = 256) {
  const value = optionString(options, key)?.trim();
  if (!value || value.length < minimum || value.length > maximum || /[\x00-\x1f\x7f]/u.test(value)) {
    fail(`Provide --${key} using ${minimum}–${maximum} ordinary characters.`);
  }
  return value;
}

/** Test-only dependency seam. Authority, actor, tokens and record JSON are not CLI inputs. */
export async function storyTestRiskCommand({ root, action = 'risks', positionals = [], options = {} }, overrides = {}) {
  if (!actions.has(action)) fail('Use risks, accept-risk, revoke-risk or attest-risk.');
  const allowed = new Set(['work-id', 'json']);
  if (action === 'risks' || action === 'accept-risk') for (const key of ['phase', 'repository', 'obligation', 'operation']) allowed.add(key);
  if (action !== 'risks') for (const key of ['apply', 'confirm']) allowed.add(key);
  if (action === 'accept-risk') for (const key of ['issue', 'reason', 'expires', 'follow-up-owner', 'remediation']) allowed.add(key);
  if (action === 'revoke-risk' || action === 'attest-risk') allowed.add('record-sha256');
  if (action === 'revoke-risk') allowed.add('reason');
  if (Object.keys(options).some(key => !allowed.has(key)) || positionals.length > 1) fail('Unsupported Story risk option or extra positional argument. See story --help.');
  const suppliedId = optionString(options, 'work-id');
  if (positionals[0] && suppliedId && positionals[0] !== suppliedId) fail('The positional Story and --work-id disagree.');
  const workId = suppliedId ?? positionals[0];
  const phaseId = optionString(options, 'phase');
  const repositoryId = optionString(options, 'repository');
  const obligationId = optionString(options, 'obligation');
  for (const [label, value] of [['Story', workId], ['phase', phaseId], ['repository', repositoryId], ['obligation', obligationId]]) {
    if (value !== undefined && value !== null && (!identifier.test(value) || value.includes('..'))) fail(`Invalid ${label} identifier.`);
  }
  const operation = optionString(options, 'operation') ?? 'publish';
  if (!operations.has(operation)) fail('Risk operation must be publish, submit, approve, downstream or replay.');
  const apply = optionBoolean(options, 'apply');
  const confirmation = optionString(options, 'confirm');
  if (confirmation && !apply) fail('--confirm selects a preview only with --apply; it is not approval.');
  if (apply && !digest.test(confirmation ?? '')) fail('Preview first; supply --apply --confirm with its exact digest in a live terminal.', 'TRP_RISK_CONFIRMATION_REQUIRED');
  const request = {};
  if (action === 'risks' || action === 'accept-risk') Object.assign(request, { phaseId, repositoryId, operation,
    ...(obligationId ? { obligationId } : {}) });
  if (action === 'accept-risk') {
    request.issueId = textOption(options, 'issue', 1, 256);
    request.reason = textOption(options, 'reason', 15, 2000);
    request.followUpOwner = textOption(options, 'follow-up-owner');
    request.remediationRef = textOption(options, 'remediation', 1, 1000);
    const expiresAt = optionString(options, 'expires');
    if (expiresAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(expiresAt)
        || !Number.isFinite(Date.parse(expiresAt)))) fail('--expires must be an exact UTC ISO timestamp.');
    if (expiresAt) request.expiresAt = expiresAt;
  }
  if (action === 'revoke-risk' || action === 'attest-risk') {
    const recordSha256 = optionString(options, 'record-sha256');
    if (recordSha256 && !digest.test(recordSha256)) fail('--record-sha256 must be an exact sealed record digest.');
    if (action === 'revoke-risk' && !recordSha256) fail('Choose the exact risk decision using --record-sha256.');
    if (recordSha256) request.recordSha256 = recordSha256;
    request.apply = apply;
  }
  if (action === 'revoke-risk') request.reason = textOption(options, 'reason', 15, 2000);
  if (apply) request.confirmation = confirmation;
  const dependencies = { ...runtime, ...overrides };
  const loaded = await dependencies.loadAcceptedStoryExecution(root, workId);
  const workflow = loaded.workflow;
  if (phaseId && phaseId !== workflow.currentPhase
      && (!['downstream', 'replay'].includes(operation) || !(workflow.phases?.[phaseId]?.generation > 0))) {
    fail('Review the current attached phase, or name a published source phase for downstream/replay review.', 'TRP_RISK_PHASE_INVALID');
  }
  const method = action === 'risks' || action === 'accept-risk' && !apply ? 'plan'
    : action === 'accept-risk' ? 'accept' : action === 'revoke-risk' ? 'revoke' : 'attest';
  return dependencies[method](root, loaded.config ?? loaded.definition, workflow, request);
}

export async function run(action, positionals, { options = {}, root = repoRoot() } = {}) {
  const data = publicTestAmendment(await storyTestRiskCommand({ root, action, positionals, options }));
  const apply = optionBoolean(options, 'apply');
  const changed = data.stateChanged === true || data.filesChanged === true;
  return emitCommandResult(commandResult({
    operation: { id: `story.test-policy.${action}${action !== 'risks' && !apply ? '.preview' : ''}`, classification: apply ? 'mutation' : 'read' },
    outcome: succeeded(changed ? 'story.test-policy.risk-recorded' : 'story.test-policy.risk-inspected', { status: data.status }),
    effects: changed ? effects({ stateChanged: data.stateChanged === true, filesChanged: true,
      publicationCreated: Boolean(data.publication?.sha), externalSystemsChanged: Boolean(data.publication?.pushed) }) : noEffects(),
    restState: 'informational', data
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}
