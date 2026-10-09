/** A publish capability is offered only by the exact current prepublish contract, not by UI inference. */
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { phasePrepublish } from './phase-prepublish.mjs';
import { loadSession } from './session.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { phasePublicationContract } from './manual-authorship.mjs';

export async function inspectPublicationAction(root, snapshot, { modelEnabled = false } = {}) {
  // Story nextsteps use workId; Initiative nextsteps carry an explicit subject instead.
  if (!snapshot.workId || (snapshot.subject && (snapshot.subject.kind !== 'story'
      || snapshot.subject.id !== snapshot.workId))) return { actions: [], readiness: null };
  const { config, workflow } = await loadAcceptedStoryExecution(root, snapshot.workId);
  const phase = workflow.phases[workflow.currentPhase];
  if (!phase || phase.status !== 'in_progress' || phase.id !== snapshot.currentPhase) return { actions: [], readiness: null };
  const inspected = await phasePrepublish(root, config, workflow, phase, {
    modelEnabled, session: await loadSession(root, { required: false }),
    // Publishing an already authored draft does not reclassify its author as human merely
    // because the executor disables future model calls. The normal phase policy owns provenance.
    requestedProducer: phasePublicationContract(phase).producer
  });
  // A UI projection only, not authorization. Keep test argv, prompt bodies and private context out.
  const readiness = { status: inspected.status, findings: inspected.findings,
    commands: inspected.commands };
  const guidance = safeCommandGuidance(inspected.commands?.publish);
  const actions = inspected.status === 'ready' && guidance && guidance.argv[0] === 'phase'
      && guidance.argv[1] === 'publish' && guidance.argv[2] === phase.id
    ? [{ timing: 'now', skill: guidance.skill, command: guidance.command,
      reason: `Publish the prechecked ${phase.label ?? phase.id} draft; fresh tests and all publication gates remain required.` }]
    : [];
  return { actions, readiness };
}
