/**
 * The specification acceptance the Story's ending judges, judged where the last code step can still
 * repair it [PHR:REQ-007], G6 (owner answer 7, 2026-11-10).
 *
 * The ending refused a missing, failed or stale acceptance run, or a clause with no observed test
 * result, long after the code step that delivers them was approved and its author had moved on. The
 * same evaluation the ending runs (governance.mjs specAcceptanceFindings), with the same records and
 * source tree, now refuses the last code step's submission instead, where its author runs the
 * allowlisted acceptance commands and publishes the tests. A later step that changes the source owns
 * the run it makes stale [PHR:REQ-008]. The planned-test rows are the plan's, checked at planning.
 *
 * Only for a Story that pinned the owner-step checks, under an enforced specification with acceptance
 * on: the ending refuses nothing otherwise. Loaded only at a code step's submission.
 */
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { specAcceptanceFindings } from './governance.mjs';
import { ownerStepChecks } from './phase-roles.mjs';
import { loadActiveSpecRecords } from './specifications.mjs';
import { workDir } from './story-paths.mjs';
import { SingularityFlowError } from './util.mjs';

/** The plan's own findings, met at planning's prepublish (G7); everything else is the code step's. */
const PLANS_OWN = new Set(['gate.acceptance.planned-test-missing']);

/** The last code step on the Story's route, which delivers what acceptance runs. */
function lastCodeStep(workflow) {
  return (workflow?.phaseOrder ?? []).filter((id) => phaseRequiresCodeDelivery(workflow.phases?.[id])
    && workflow.phases[id].status !== 'skipped').at(-1) ?? null;
}

/**
 * The records the ending reads, as the submission has them: the published generation's claim maps, which this
 * submission binds once it is recorded. The ending reads the same records through their bindings.
 */
async function submittedRecords(root, config, workflow) {
  return loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
}

/** The refusal for the last code step's submission, or null. `records` replaces the read, for tests. */
export async function acceptanceOwnerRefusal(root, config, workflow, phase, { records = null } = {}) {
  if (!ownerStepChecks(workflow) || lastCodeStep(workflow) !== phase?.id) return null;
  const specPolicy = workflow.resolution?.spec ?? config.spec ?? { mode: 'off', coverage: 'off' };
  if (specPolicy.mode !== 'enforce' || (specPolicy.acceptance ?? 'off') === 'off') return null;
  const read = records ?? await submittedRecords(root, config, workflow);
  const findings = (await specAcceptanceFindings(root, config, workflow, specPolicy, read)).entries.filter((entry) => !PLANS_OWN.has(entry.code));
  if (!findings.length) return null;
  const workId = workflow.workItem.id;
  const run = { command: `singularity-flow spec acceptance --phase ${phase.id}`,
    label: 'Run the allowlisted acceptance commands on the code as it is now; fix what fails, then run them again.' };
  const publish = { command: `singularity-flow phase prepublish ${phase.id} --for-agent --json --publish-if-ready`,
    label: 'Publish the tests each clause names, so each has an observed result, then submit again.' };
  const observedOnly = findings.every((entry) => entry.code === 'gate.acceptance.observed-test-missing');
  return new SingularityFlowError(
    `Phase '${phase.id}' cannot be submitted while the specification acceptance the Story's ending judges is incomplete:\n- `
    + findings.map((entry) => entry.message).join('\n- ')
    + `\nIt is the last code step, so this is where acceptance is run and its tests observed; the ending refuses the same.`,
    { code: 'SPEC_ACCEPTANCE_INCOMPLETE', details: { workId, phase: phase.id, ownerPhase: phase.id, repairScope: 'current-draft',
      findings: findings.slice(0, 20), nextAction: observedOnly ? publish : run, recoveryCommands: observedOnly ? [run] : [publish] } }
  );
}
