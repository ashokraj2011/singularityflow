/** `story approvers refresh`: the approved configuration's added members carried into a running Story. */
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { loadStoryConfigurationSnapshot, resolveNewStoryConfigurationAuthority } from '../configuration-branch.mjs';
import { repoRoot } from '../git.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const fail = (message, code) => { throw new SingularityFlowError(message, { code }); };
const allowedOptions = new Set(['work-id', 'reason', 'confirm', 'json']);
const runtime = {
  loadAcceptedStoryExecution, resolveNewStoryConfigurationAuthority, loadStoryConfigurationSnapshot,
  async preview(...args) { return (await import('../story-approver-refresh.mjs')).previewStoryApproverRefresh(...args); },
  async apply(...args) { return (await import('../story-approver-refresh.mjs')).applyStoryApproverRefresh(...args); }
};

/** The override seam is test-only; no dependency or reviewer can be supplied through CLI input. */
export async function refreshStoryApprovers({ root, positionals = [], options = {} }, overrides = {}) {
  const dependencies = { ...runtime, ...overrides };
  if (Object.keys(options).some((key) => !allowedOptions.has(key))) {
    fail('Unsupported approvers refresh option. Use --reason, --work-id, --confirm or --json.', 'APR_ARGUMENT_INVALID');
  }
  if (positionals.length > 1) fail('Supply at most one Story ID.', 'APR_ARGUMENT_INVALID');
  const positional = positionals[0] ?? null;
  const optionId = optionString(options, 'work-id');
  if (positional && optionId && positional !== optionId) fail('The positional Story ID and --work-id disagree.', 'APR_ARGUMENT_INVALID');
  const confirm = optionString(options, 'confirm');
  if (confirm && !/^sha256:[a-f0-9]{64}$/u.test(confirm)) fail('--confirm takes the exact plan digest the preview printed.', 'APR_CONFIRMATION_REQUIRED');
  const loaded = await dependencies.loadAcceptedStoryExecution(root, optionId ?? positional);
  const config = loaded.config ?? loaded.definition;
  const workflow = loaded.workflow;
  const pinnedRemote = workflow.resolution?.configurationSource?.repository;
  if (!pinnedRemote) fail('This Story has no retained configuration authority to take approvers from.', 'APR_AUTHORITY_REQUIRED');
  const authority = await dependencies.resolveNewStoryConfigurationAuthority(root, { pinnedRemote });
  if (!authority) fail('The Story\'s configuration authority could not be resolved. Inspect Git access and retry the preview.', 'APR_AUTHORITY_REQUIRED');
  const approvedConfigurationSnapshot = await dependencies.loadStoryConfigurationSnapshot(authority);
  return dependencies[confirm ? 'apply' : 'preview'](root, config, workflow, {
    approvedConfigurationSnapshot, reason: optionString(options, 'reason'), ...(confirm ? { confirm } : {})
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
