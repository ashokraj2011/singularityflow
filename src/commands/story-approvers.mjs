/** `story approvers refresh`: the approved configuration's added members carried into a running Story. */
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { loadStoryConfigurationSnapshot, resolveNewStoryConfigurationAuthority } from '../configuration-branch.mjs';
import { repoRoot } from '../git.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const fail = (message, code) => { throw new SingularityFlowError(message, { code }); };
const allowedOptions = new Set(['work-id', 'reason', 'confirm', 'adopt-without-ancestry', 'json']);
const runtime = {
  loadAcceptedStoryExecution, resolveNewStoryConfigurationAuthority, loadStoryConfigurationSnapshot,
  async preview(...args) { return (await import('../story-approver-refresh.mjs')).previewStoryApproverRefresh(...args); },
  async apply(...args) { return (await import('../story-approver-refresh.mjs')).applyStoryApproverRefresh(...args); }
};

/** The override seam is test-only; no dependency or reviewer can be supplied through CLI input. */
export async function refreshStoryApprovers({ root, positionals = [], options = {} }, overrides = {}) {
  const dependencies = { ...runtime, ...overrides };
  if (Object.keys(options).some((key) => !allowedOptions.has(key))) {
    fail('Unsupported approvers refresh option. Use --reason, --work-id, --confirm, --adopt-without-ancestry or --json.', 'APR_ARGUMENT_INVALID');
  }
  if (positionals.length > 1) fail('Supply at most one Story ID.', 'APR_ARGUMENT_INVALID');
  const positional = positionals[0] ?? null;
  const optionId = optionString(options, 'work-id');
  if (positional && optionId && positional !== optionId) fail('The positional Story ID and --work-id disagree.', 'APR_ARGUMENT_INVALID');
  const confirm = optionString(options, 'confirm');
  if (confirm && !/^sha256:[a-f0-9]{64}$/u.test(confirm)) {
    // The preview prints the whole confirming command; the person never copies a digest by hand.
    const reason = optionString(options, 'reason');
    const preview = `singularity-flow story approvers refresh${/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(optionId ?? positional ?? '') ? ` ${optionId ?? positional}` : ''}`
      + ` --reason "${reason && !/["\\$`\x00-\x1f]/u.test(reason) ? reason : '<REASON>'}"`;
    throw new SingularityFlowError('That is not a confirmation the refresh preview gave. Preview it again: it prints the whole command to confirm.',
      { code: 'APR_CONFIRMATION_REQUIRED', details: { nextAction: { command: preview, label: 'Preview the refresh again' } } });
  }
  const loaded = await dependencies.loadAcceptedStoryExecution(root, optionId ?? positional);
  const config = loaded.config ?? loaded.definition;
  const workflow = loaded.workflow;
  const pinnedRemote = workflow.resolution?.configurationSource?.repository;
  if (!pinnedRemote) fail('This Story has no retained configuration authority to take approvers from.', 'APR_AUTHORITY_REQUIRED');
  const authority = await dependencies.resolveNewStoryConfigurationAuthority(root, { pinnedRemote });
  if (!authority) fail('The Story\'s configuration authority could not be resolved. Inspect Git access and retry the preview.', 'APR_AUTHORITY_REQUIRED');
  const approvedConfigurationSnapshot = await dependencies.loadStoryConfigurationSnapshot(authority);
  // --adopt-without-ancestry: sflow/config was rewritten outside SFlow, and the approver adopts it for this
  // Story's approvers in the same step, recorded as adopted without ancestry (SPEC-SCF D9).
  const adoptWithoutAncestry = optionBoolean(options, 'adopt-without-ancestry');
  return dependencies[confirm ? 'apply' : 'preview'](root, config, workflow, {
    approvedConfigurationSnapshot, reason: optionString(options, 'reason'), ...(confirm ? { confirm } : {}),
    ...(adoptWithoutAncestry ? { adoptWithoutAncestry: true } : {})
  });
}

export async function run(positionals, { options = {}, root = repoRoot() } = {}) {
  const data = await refreshStoryApprovers({ root, positionals, options });
  const confirmed = Boolean(optionString(options, 'confirm'));
  const changed = data.stateChanged === true;
  return emitCommandResult(commandResult({
    operation: { id: `story.approvers.refresh${confirmed ? '' : '.preview'}`, classification: confirmed ? 'mutation' : 'read' },
    outcome: succeeded(!confirmed ? 'story.approvers.refresh-planned'
      : changed ? 'story.approvers.refresh-recorded' : 'story.approvers.refresh-unchanged', { status: data.status }),
    effects: changed ? effects({ stateChanged: true, filesChanged: true, publicationCreated: true,
      externalSystemsChanged: Boolean(data.publication?.pushed) }) : noEffects(),
    restState: 'informational', data
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}
