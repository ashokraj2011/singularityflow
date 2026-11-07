/**
 * `decision evidence-reuse`: a person in the group that approves a step decides that a test run an
 * earlier step of the Story recorded stands for this step, or revokes such a decision. See
 * src/evidence-reuse.mjs for the source binding and how the reuse is shown.
 *
 *   singularity-flow decision evidence-reuse [WORK-ID] --phase PHASE --from-attempt TA-... --reason TEXT [--expires YYYY-MM-DD]
 *   singularity-flow decision evidence-reuse [WORK-ID] --revoke ERU-001 --reason TEXT
 *
 * Only a retained, passed, structured attempt of an earlier step can be named, and only while the
 * application source is byte-identical to the one it ran on. The reusing step is never said to
 * have run anything. The Copilot guard refuses this command, like approve: an agent may name the
 * route, never decide it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';

import { evidenceReuseDecision, evidenceReuseLabel } from '../evidence-reuse.mjs';
import { repoRoot } from '../git.mjs';

import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';
import { loadConfig } from '../state-stores.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { actionActor } from './kernel.mjs';

import {evidenceReuseDecisionPart,recordEvidenceReuseDecision,evidenceReuseAuthorities} from '../engine-compatibility/native-evidence-decisions.mjs';
export {evidenceReuseDecisionPart,recordEvidenceReuseDecision,evidenceReuseAuthorities};

export async function decisionEvidenceReuseCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  // The Story's own branch, which need not be named after its ID.
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') {
    throw new SingularityFlowError(`Story ${id} is ${workflow.status}; evidence reuse is decided while it is in progress.`, { code: 'EVIDENCE_REUSE_STORY_CLOSED' });
  }
  const revoke = optionString(options, 'revoke') ?? null;
  const requestedPhase = optionString(options, 'phase') ?? null;
  const attemptId = optionString(options, 'from-attempt') ?? null;
  if (!revoke === !requestedPhase || (revoke && (attemptId || optionString(options, 'expires')))) {
    throw new SingularityFlowError('Name the step with --phase PHASE --from-attempt TA-..., or a decision to revoke with --revoke ERU-...', { code: 'EVIDENCE_REUSE_INVALID' });
  }
  if (!revoke && !attemptId) {
    throw new SingularityFlowError('Name the recorded run to reuse with --from-attempt TA-... (an earlier step\'s retained attempt).', { code: 'EVIDENCE_REUSE_INVALID' });
  }
  const target = revoke ? evidenceReuseDecision(workflow, revoke) : null;
  if (revoke && !target) throw new SingularityFlowError(`This Story has no evidence-reuse decision ${revoke}.`, { code: 'EVIDENCE_REUSE_UNKNOWN' });
  const phaseId = revoke ? target.phase : requestedPhase;
  if (!workflow.phases?.[phaseId] || workflow.phases[phaseId].status === 'skipped') {
    throw new SingularityFlowError(`Story ${id} has no step ${phaseId} that is on its route.`, { code: 'EVIDENCE_REUSE_INVALID' });
  }
  const actor = actionActor(root);
  const loadedSession = await loadSession(root, { required: false });
  const agent = loadedSession?.workId === id ? loadedSession.agent ?? null : null;
  const { record, publication } = await recordEvidenceReuseDecision(root, config, workflow, {
    phaseId, attemptId, revoke, reason: optionString(options, 'reason') ?? '', expires: optionString(options, 'expires') ?? null
  }, { actor, agent });
  if (!optionBoolean(options, 'json')) {
    console.log(record.revokes
      ? `Revoked ${record.revokes}: ${record.attemptId} no longer stands for ${record.phase}.`
      : `Recorded ${record.id}, ${evidenceReuseLabel(record)}. Accepted through ${record.authorityGroup}${record.expiresAt ? ` until ${record.expiresAt.slice(0, 10)}` : ''}; it lapses as soon as the application source changes.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.evidence-reuse', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.evidence-reuse.succeeded', { record: record.revokes ? `the revocation of ${record.revokes}` : record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record,
      ...(record.revokes ? {} : { label: evidenceReuseLabel(record) }) }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
