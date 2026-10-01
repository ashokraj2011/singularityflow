/** Restore local review origin after cloning, without changing any accepted Story record. */
import { captureTerminalActionAuthorization } from '../action-authorization.mjs';
import { loadDefinition } from '../config.mjs';
import { head, repoRoot } from '../git.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { resolveWorkItem, workDir } from '../state-stores.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { reattestTestCommandReviewOrigin, testCommandReviewReattestationAuthorization } from '../test-command-amendment-origin.mjs';
import { inspectWorkflowTestCommandReviews } from '../workflow-snapshots.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { publicTestAmendment } from './story-test-amendment.mjs';

const fail = (message, code = 'TCA_ATTEST_ARGUMENT_INVALID') => { throw new SingularityFlowError(message, { code }); };
const runtime = { loadDefinition, resolveWorkItem, workDir, head, withSubjectLock,
  inspectWorkflowTestCommandReviews, captureTerminalActionAuthorization,
  reattestTestCommandReviewOrigin, testCommandReviewReattestationAuthorization };
const allowed = new Set(['work-id', 'apply', 'confirm', 'json']);

export async function attestStoryTestCommand({ root, positionals = [], options = {} }, overrides = {}) {
  const dependencies = { ...runtime, ...overrides };
  if (Object.keys(options).some(key => !allowed.has(key)) || positionals.length > 1) fail('Use attest [WORK-ID] [--json], or --apply --confirm REVIEW-SHA256 in a live terminal.');
  const id = optionString(options, 'work-id') ?? positionals[0];
  if (positionals[0] && optionString(options, 'work-id') && positionals[0] !== optionString(options, 'work-id')) fail('The Story selections disagree.');
  const apply = optionBoolean(options, 'apply');
  const confirm = optionString(options, 'confirm');
  if (confirm && !apply) fail('--confirm requires --apply; a digest alone is not human authorization.');
  if (apply && !/^sha256:[a-f0-9]{64}$/u.test(confirm ?? '')) fail('Preview first, then select the exact immutable review digest.', 'TCA_ATTEST_CONFIRMATION_REQUIRED');
  // This bootstrap and subject index are used only to locate the committed record.
  // No unverified Story resolution is ever returned or used as execution policy.
  const config = await dependencies.loadDefinition(root, { storyBootstrap: true });
  const subject = await dependencies.resolveWorkItem(root, config, id);
  if (!subject?.workId || subject.readOnly) fail('Attach the exact Story branch before restoring its local review origin.', 'TCA_ATTEST_CHECKOUT_REQUIRED');
  const inspect = () => dependencies.inspectWorkflowTestCommandReviews(root, config, subject.workId);
  if (!apply) {
    const inspected = await inspect();
    return { ...inspected, status: inspected.reviews.some(row => !row.originPresent) ? 'review-required' : 'verified',
      stateChanged: false, filesChanged: false, executed: false,
      legalActions: inspected.reviews.filter(row => !row.originPresent).map(row => ({
        id: `attest-${row.review.id}`, label: 'The original reviewer must re-attest this unchanged review in a direct terminal',
        command: 'story', args: ['test-policy', 'attest', '--work-id', subject.workId, '--apply', '--confirm', row.sha256]
      })) };
  }
  return dependencies.withSubjectLock(root, { kind: 'story', id: subject.workId }, async () => {
    const initialHead = dependencies.head(root);
    const inspected = await inspect();
    const selected = inspected.reviews.find(row => row.sha256 === confirm);
    if (!selected) fail('The selected review is not in the verified accepted chain. Inspect the current Story again.', 'TCA_ATTEST_REVIEW_STALE');
    if (selected.originPresent) return { status: 'already-attested', workId: subject.workId,
      stateChanged: false, filesChanged: false, executed: false };
    const card = dependencies.testCommandReviewReattestationAuthorization(selected.review);
    const authorization = await dependencies.captureTerminalActionAuthorization(root, card.plan, card.action,
      { label: 'Restore local test-command review' });
    if (!authorization) return { status: 'cancelled', workId: subject.workId,
      stateChanged: false, filesChanged: false, executed: false };
    const fresh = await inspect();
    if (dependencies.head(root) !== initialHead || !fresh.reviews.some(row => row.sha256 === confirm)) {
      fail('The accepted Story moved during review; preview again. No Story policy was changed.', 'TCA_ATTEST_REVIEW_STALE');
    }
    await dependencies.reattestTestCommandReviewOrigin(root, dependencies.workDir(root, config, subject.workId), {
      review: selected.review, token: authorization.token
    });
    return { status: 'attested', workId: subject.workId, reviewSha256: confirm,
      stateChanged: false, filesChanged: true, executed: false,
      message: 'Only local review-origin evidence was restored. Story, policy, source and Git records are unchanged.' };
  });
}

export async function run(positionals, { options = {}, root = repoRoot() } = {}) {
  const data = publicTestAmendment(await attestStoryTestCommand({ root, positionals, options }));
  const apply = optionBoolean(options, 'apply');
  return emitCommandResult(commandResult({
    operation: { id: `story.test-policy.attest${apply ? '' : '.preview'}`, classification: apply ? 'mutation' : 'read' },
    outcome: succeeded(data.filesChanged ? 'story.test-policy.origin-restored' : 'story.test-policy.origin-inspected', { status: data.status }),
    effects: data.filesChanged ? effects({ filesChanged: true }) : noEffects(),
    restState: 'informational', data
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}
