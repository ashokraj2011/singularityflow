/** Reviewed adoption of an approved test command with fresh epoch validation; never a test bypass. */
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { loadStoryConfigurationSnapshot, resolveNewStoryConfigurationAuthority } from '../configuration-branch.mjs';
import { repoRoot } from '../git.mjs';
import { redactDiagnosticText } from '../git-remote-diagnostics.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { trpSelectionPublicPreview } from '../trp-delivery-selection.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const fail = (message, code) => { throw new SingularityFlowError(message, { code }); };
const allowedOptions = new Set(['work-id', 'phase', 'reason', 'apply', 'confirm', 'json']);
const runtime = {
  loadAcceptedStoryExecution, resolveNewStoryConfigurationAuthority, loadStoryConfigurationSnapshot,
  async preview(...args) {
    const { previewStoryTestCommandAmendment } = await import('../story-test-command-amendment.mjs');
    return previewStoryTestCommandAmendment(...args);
  },
  async apply(...args) {
    const { applyStoryTestCommandAmendment } = await import('../story-test-command-amendment.mjs');
    return applyStoryTestCommandAmendment(...args);
  }
};

/** Redact presentation only. The runtime binds the exact, unredacted candidate. */
export function publicTestAmendment(value, depth = 0) {
  if (depth > 32) return '[bounded]';
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.slice(0, 2048).map(item => publicTestAmendment(item, depth + 1));
  if (value && typeof value === 'object') {
    // A secret may be the next argv element, or an opaque value under any env key.
    // Scrubbing isolated strings cannot preserve this context, so use the command projector.
    const projected = Array.isArray(value.argv) || value.env
      ? trpSelectionPublicPreview({ commands: [value] }).commands[0] : value;
    return Object.fromEntries(Object.entries(projected).slice(0, 2048)
      .map(([key, item]) => [key, /^(?:password|token|secret|authorizationToken)$/iu.test(key)
        ? '[REDACTED]' : publicTestAmendment(item, depth + 1)]));
  }
  return value;
}

/** The override seam is test-only; no dependency or reviewer can be supplied through CLI input. */
export async function amendStoryTestCommand({ root, positionals = [], options = {} }, overrides = {}) {
  const dependencies = { ...runtime, ...overrides };
  if (Object.keys(options).some(key => !allowedOptions.has(key))) {
    fail('Unsupported test-policy amend option. Use --reason, --work-id, --phase, --apply, --confirm or --json.', 'TCA_ARGUMENT_INVALID');
  }
  if (positionals.length > 1) fail('Supply at most one Story ID.', 'TCA_ARGUMENT_INVALID');
  const positional = positionals[0] ?? null;
  const optionId = optionString(options, 'work-id');
  if (positional && optionId && positional !== optionId) fail('The positional Story ID and --work-id disagree.', 'TCA_ARGUMENT_INVALID');
  const apply = optionBoolean(options, 'apply');
  const confirm = optionString(options, 'confirm');
  if (confirm && !apply) fail('--confirm only selects a review card when used with --apply; it is not approval.', 'TCA_ARGUMENT_INVALID');
  if (apply && !/^sha256:[a-f0-9]{64}$/u.test(confirm ?? '')) {
    fail('Preview first, then use --apply --confirm with the exact plan digest in a live terminal.', 'TCA_CONFIRMATION_REQUIRED');
  }
  const reason = optionString(options, 'reason')?.trim();
  if (!reason || reason.length < 15 || reason.length > 2000 || /[\x00-\x1f\x7f]/u.test(reason)) {
    fail('Give a substantive --reason of 15–2000 ordinary characters for this test-command repair.', 'TCA_REASON_REQUIRED');
  }
  const loaded = await dependencies.loadAcceptedStoryExecution(root, optionId ?? positional);
  const config = loaded.config ?? loaded.definition;
  const workflow = loaded.workflow;
  const phaseId = optionString(options, 'phase');
  if (phaseId && phaseId !== workflow.currentPhase) fail('Only the current Story phase can adopt a test-command repair.', 'TCA_PHASE_INVALID');
  const pinnedRemote = workflow.resolution?.configurationSource?.repository;
  if (!pinnedRemote) fail('This Story has no retained configuration authority. Do not substitute the active workspace authority.', 'TCA_AUTHORITY_REQUIRED');
  const authority = await dependencies.resolveNewStoryConfigurationAuthority(root, { pinnedRemote });
  if (!authority) fail('The original configuration authority could not be resolved. Inspect Git access and retry the preview.', 'TCA_AUTHORITY_REQUIRED');
  const approvedConfigurationSnapshot = await dependencies.loadStoryConfigurationSnapshot(authority);
  return dependencies[apply ? 'apply' : 'preview'](root, config, workflow, {
    approvedConfigurationSnapshot, reason, ...(apply ? { confirm } : {})
  });
}

export async function run(positionals, { options = {}, root = repoRoot() } = {}) {
  const data = publicTestAmendment(await amendStoryTestCommand({ root, positionals, options }));
  const apply = optionBoolean(options, 'apply');
  const changed = data.stateChanged === true;
  return emitCommandResult(commandResult({
    operation: { id: `story.test-policy.amend${apply ? '' : '.preview'}`, classification: apply ? 'mutation' : 'read' },
    outcome: succeeded(!apply ? 'story.test-policy.amendment-planned'
      : changed ? 'story.test-policy.amendment-recorded' : 'story.test-policy.amendment-unchanged', { status: data.status }),
    effects: changed ? effects({ stateChanged: true, filesChanged: true, publicationCreated: true,
      externalSystemsChanged: Boolean(data.publication?.pushed) }) : noEffects(),
    restState: 'informational', data
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}
