/**
 * Story-only test commands: a step approver's decision that one exact command tests a step of this
 * Story.
 *
 * When Singularity Flow infers no runner for a step's changed code and the repository configures
 * none, publication refuses (CODE_DELIVERY_TEST_COMMAND_REQUIRED). The developer, or their agent,
 * requests the exact command that runs those tests, and a person in the group that approves the step
 * accepts it. An accepted command runs at every publication and submission of that step like a
 * configured one, covers its affected roots, and its tests must pass; nothing is waived. The
 * repository configuration is unchanged: `capability test-setup` proposes the command for later
 * Stories. Requests, acceptances and revocations are append-only (`testCommandDecisions`), and each
 * step carries its accepted commands as `storyTestCommands`, which the gates check against them.
 * A `repin` request adds no command: it admits a pinned command's changed form (test-command-pins.mjs). Pure.
 */
import {NODE_TEXT_DIGESTS} from './records.mjs';
import {countedRecords} from './presence/counted.mjs';
import {SingularityFlowError} from './foundation/failures.mjs';
import {storyTestCommandPolicies} from './kernel/test-recovery.mjs';
const rules=storyTestCommandPolicies(NODE_TEXT_DIGESTS);
const observed=workflow=>countedRecords(workflow,workflow?.testCommandDecisions,entry=>Boolean(entry?.accepts||entry?.revokes));
export const pinDiffWords=rules.pinDiffWords;
export const storyTestCommandState=(workflow,id)=>rules.storyTestCommandState(workflow,id,observed(workflow));
export const pendingStoryTestCommands=(workflow,phaseId)=>rules.pendingStoryTestCommands(workflow,phaseId,observed(workflow));
export const matchingPendingTestCommand=(workflow,input)=>rules.matchingPendingTestCommand(workflow,input,observed(workflow));
export const activeStoryTestCommands=(workflow,phaseId)=>rules.activeStoryTestCommands(workflow,phaseId,observed(workflow));
export const assertStoryTestCommands=workflow=>rules.assertStoryTestCommands(workflow,observed(workflow));
const fail=(message,code='TEST_COMMAND_DECISION_INVALID',details=undefined)=>{throw new SingularityFlowError(message,{code,...(details?{details}:{})});};
/** A step awaiting approval keeps the tests its review ran: a decision now would make that review stale. */
export function testCommandReviewHold(workflow, phaseId) {
  const phase = workflow?.phases?.[phaseId];
  if (phase?.status !== 'awaiting_approval') return null;
  const name = phase.label ?? phaseId;
  return {
    words: `${name} is awaiting approval, and a test command decided now would change what its submitted review ran, so its approval would need a fresh submission. `
      + `An approver returns ${name} for changes first (/sf-reject); the command is then decided before it is submitted again. For later Stories, propose it with /sf-test-setup.`,
    command: `singularity-flow reject ${phaseId} --work-id ${workflow.workItem?.id ?? '<WORK-ID>'} --fetch --reason <REASON>`
  };
}

const OPEN_STEP=new Set(['not_started','in_progress','awaiting_approval']);
function openStep(workflow, phaseId) {
  const phase = workflow?.phases?.[phaseId];
  if (!phase) fail(`This Story has no step ${phaseId}.`);
  if (!OPEN_STEP.has(phase.status)) fail(`Step ${phaseId} is ${phase.status}; a Story-only test command is decided before the step is approved.`, 'TEST_COMMAND_DECISION_CLOSED');
  const hold = testCommandReviewHold(workflow, phaseId);
  if (hold) fail(hold.words, 'TEST_COMMAND_DECISION_DURING_REVIEW', { workId: workflow.workItem?.id ?? null, phase: phaseId,
    nextAction: { command: hold.command, label: `Return ${phase.label ?? phaseId} for changes first.` } });
  return phase;
}

export function recordStoryTestCommandRequest(workflow,input){
  openStep(workflow,input.phaseId);return rules.recordStoryTestCommandRequest(workflow,input,observed(workflow));
}
export function recordStoryTestCommandDecision(workflow,input){
  if(!/^TCD-[0-9]{3,}$/u.test(String(input.id??'')))return rules.recordStoryTestCommandDecision(workflow,input,observed(workflow));
  const found=storyTestCommandState(workflow,input.id);
  if(found)openStep(workflow,found.request.phase);
  return rules.recordStoryTestCommandDecision(workflow,input,observed(workflow));
}
