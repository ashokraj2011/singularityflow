/**
 * `decision test-narrowing`: a person in the group that approves a step accepts that one of its test
 * commands ran narrowed, or revokes such a decision. See src/test-narrowing.mjs [TCE:REQ-023].
 *
 *   singularity-flow decision test-narrowing [WORK-ID] --phase PHASE [--command ID] --reason TEXT [--expires YYYY-MM-DD]
 *   singularity-flow decision test-narrowing [WORK-ID] --revoke TNR-001 --reason TEXT
 *
 * It accepts the narrowing of the latest recorded run of the command in this checkout: a run that
 * passed and was narrowed (filters, focused tests, skipped tests or fewer tests than its baseline).
 * The decision is bound to the command's pin and that narrowing, and covers later runs whose
 * narrowing is the same or smaller. The Copilot guard refuses this command, like approve: an agent
 * may name the route, never decide it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';

import { repoRoot } from '../git.mjs';

import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';

import { loadConfig } from '../state-stores.mjs';
import { narrowingWords } from '../test-narrowing.mjs';

import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

import { actionActor } from './kernel.mjs';
import {recordTestNarrowingDecision} from '../engine-compatibility/native-test-narrowing-decisions.mjs';
export {recordTestNarrowingDecision};

const fail = (message, code = 'TEST_NARROWING_INVALID') => { throw new SingularityFlowError(message, { code }); };

export async function decisionTestNarrowingCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') fail(`Story ${id} is ${workflow.status}; narrowed runs are decided while it is in progress.`, 'TEST_NARROWING_CLOSED');
  const revoke = optionString(options, 'revoke') ?? null;
  const requestedPhase = optionString(options, 'phase') ?? null;
  if (!revoke === !requestedPhase) fail('Name the step with --phase PHASE, or a decision to revoke with --revoke TNR-...');
  const target = revoke ? (workflow.testNarrowings ?? []).find((entry) => !entry.revokes && entry.id === revoke) ?? null : null;
  if (revoke && !target) fail(`This Story has no test-narrowing decision ${revoke}.`, 'TEST_NARROWING_UNKNOWN');
  const phaseId = revoke ? target.phase : requestedPhase;
  if (!workflow.phases?.[phaseId]) fail(`Story ${id} has no step ${phaseId}.`);
  const actor = actionActor(root);
  const session = await loadSession(root, { required: false });
  const agent = session?.workId === id ? session.agent ?? null : null;
  const { record, publication } = await recordTestNarrowingDecision(root, config, workflow, {
    phaseId, revoke, commandId: optionString(options, 'command') ?? null, reason: optionString(options, 'reason') ?? '',
    expires: optionString(options, 'expires') ?? null
  }, { actor, agent });
  if (!optionBoolean(options, 'json')) {
    console.log(record.revokes ? `Revoked ${record.revokes} on ${record.phase} ${record.commandId}.`
      : `Recorded ${record.id}: ${record.phase} test command ${record.commandId} may pass narrowed (${narrowingWords(record.narrowing)})`
        + `${record.expiresAt ? ` until ${record.expiresAt.slice(0, 10)}` : ' until the Story ends'}, accepted through ${record.authorityGroup}. `
        + 'A run narrowed further, or under a changed pin, is refused again.');
    console.log(publication.pushed ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.test-narrowing', classification: 'mutation' },
    subject: { kind: 'story', id },
    // The risk decision's words fit: the narrowed run stays visible, and the decision counts until it expires or is revoked.
    outcome: succeeded('decision.risk.succeeded', { record: record.revokes ? `the revocation of ${record.revokes}` : record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
