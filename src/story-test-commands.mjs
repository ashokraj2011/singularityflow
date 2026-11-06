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
import { canonicalJson, recordSha256 } from './records.mjs';
import { countedRecords } from './presence/counted.mjs';
import { SingularityFlowError } from './util.mjs';

const fail = (message, code = 'TEST_COMMAND_DECISION_INVALID', details = undefined) => {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
};
const REQUEST_ID = /^TCD-[0-9]{3,}$/u;
const OPEN_STEP = new Set(['not_started', 'in_progress', 'awaiting_approval']);

function reasonText(value, minimum, option) {
  const text = String(value ?? '').trim();
  if (text.length < minimum || text.length > 1000) fail(`Say why in ${minimum} to 1000 characters with ${option}.`);
  return text;
}

// SF Guard: a person's acceptance or revocation counts once verified; requests always count.
const personDecision = (entry) => Boolean(entry?.accepts || entry?.revokes);
const decisions = (workflow) => countedRecords(workflow, workflow?.testCommandDecisions, personDecision);

/** One change before and after in words: `package.json scripts.test: before "vitest run", after "vitest run src"`. */
export function pinDiffWords(entry) {
  const name = entry.field === 'definition' ? `${entry.path}${entry.selector ? ` ${entry.selector}` : ''}` : entry.field;
  const quoted = (value) => `"${String(value).replaceAll('\n', ' / ')}"`;
  if (entry.field === 'definition' && !entry.known) return `${name} ${entry.change}; the text it was pinned with is not in this Story's history, so compare it with the base commit`;
  if (entry.before == null && entry.after == null) return `${name} ${entry.change}`;
  if (entry.before == null) return `${name}: added ${quoted(entry.after)}`;
  if (entry.after == null) return `${name}: removed ${quoted(entry.before)}`;
  return `${name}: before ${quoted(entry.before)}, after ${quoted(entry.after)}`;
}

/** A request by its ID, and whether a person accepted or revoked it. */
export function storyTestCommandState(workflow, id) {
  const request = decisions(workflow).find((entry) => entry.id === id) ?? null;
  if (!request) return null;
  const accepted = decisions(workflow).find((entry) => entry.accepts === id) ?? null;
  const revoked = decisions(workflow).find((entry) => entry.revokes === id) ?? null;
  return { request, accepted, revoked, state: revoked ? 'revoked' : accepted ? 'accepted' : 'requested' };
}

/** Requests of a step that wait for a person who approves it. */
export function pendingStoryTestCommands(workflow, phaseId) {
  return decisions(workflow).filter((entry) => entry.id && entry.phase === phaseId
    && storyTestCommandState(workflow, entry.id).state === 'requested');
}

/** Repeating the same request is not another human decision; prose/actor/time do not change its scope. */
export function matchingPendingTestCommand(workflow, { phaseId, command, repin = null }) {
  return pendingStoryTestCommands(workflow, phaseId).find(entry => repin
    ? entry.command.id === command.id && canonicalJson(entry.repin ?? null) === canonicalJson(repin)
    : !entry.repin && canonicalJson(entry.command) === canonicalJson(command)) ?? null;
}

/**
 * The commands a step runs because a person accepted them, each bound to its request. The latest
 * acceptance of a command ID wins; a pending request never displaces an accepted command.
 */
export function activeStoryTestCommands(workflow, phaseId) {
  const latest = new Map();
  for (const entry of decisions(workflow)) {
    if (!entry.accepts || entry.phase !== phaseId) continue;
    const { request, state } = storyTestCommandState(workflow, entry.accepts);
    if (state === 'accepted' && !request.repin) latest.set(request.command.id, request);
  }
  return [...latest.values()].map((request) => ({
    ...structuredClone(request.command), storyDecision: { id: request.id, sha256: `sha256:${recordSha256(request)}` }
  }));
}

function refreshStep(workflow, phaseId) {
  const active = activeStoryTestCommands(workflow, phaseId);
  if (active.length) workflow.phases[phaseId].storyTestCommands = active;
  else delete workflow.phases[phaseId].storyTestCommands;
}

/** Every step's accepted commands are exactly its active decisions; anything else was not decided. */
export function assertStoryTestCommands(workflow) {
  for (const [phaseId, phase] of Object.entries(workflow?.phases ?? {})) {
    if (canonicalJson(phase.storyTestCommands ?? []) !== canonicalJson(activeStoryTestCommands(workflow, phaseId))) {
      fail(`Step ${phaseId}'s Story-only test commands differ from its recorded decisions.`, 'TEST_COMMAND_DECISION_STATE_INVALID', { phase: phaseId });
    }
  }
}

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

function openStep(workflow, phaseId) {
  const phase = workflow?.phases?.[phaseId];
  if (!phase) fail(`This Story has no step ${phaseId}.`);
  if (!OPEN_STEP.has(phase.status)) fail(`Step ${phaseId} is ${phase.status}; a Story-only test command is decided before the step is approved.`, 'TEST_COMMAND_DECISION_CLOSED');
  const hold = testCommandReviewHold(workflow, phaseId);
  if (hold) fail(hold.words, 'TEST_COMMAND_DECISION_DURING_REVIEW', { workId: workflow.workItem?.id ?? null, phase: phaseId,
    nextAction: { command: hold.command, label: `Return ${phase.label ?? phaseId} for changes first.` } });
  return phase;
}

/** Record a request for `command` (already normalized and checked by the caller). */
export function recordStoryTestCommandRequest(workflow, { phaseId, command, repin = null, reason, actor, at }) {
  openStep(workflow, phaseId);
  if (!command?.id || command.kind !== 'test') fail('A Story-only test command is one structured kind: test command.');
  const reasonValue = reasonText(reason, 15, '--reason');
  const existing = matchingPendingTestCommand(workflow, { phaseId, command, repin });
  if (existing) return existing;
  workflow.testCommandDecisions ??= [];
  const request = {
    id: `TCD-${String(decisions(workflow).filter((entry) => entry.id).length + 1).padStart(3, '0')}`,
    phase: phaseId, command: structuredClone(command), ...(repin ? { repin: structuredClone(repin) } : {}),
    reason: reasonValue, requestedBy: actor, at
  };
  workflow.testCommandDecisions.push(request);
  return request;
}

/**
 * Record a person's acceptance or revocation of request `id`; the caller checked that they are in
 * one of the step's approval groups. `selfApproval: false` refuses accepting one's own request.
 */
export function recordStoryTestCommandDecision(workflow, { id, outcome, reason = '', actor, authorityGroup, identityAssurance = null, at, selfApproval = true }) {
  if (!REQUEST_ID.test(String(id ?? ''))) fail('Name the request as TCD-001.');
  const found = storyTestCommandState(workflow, id);
  if (!found) fail(`This Story has no test command request ${id}.`, 'TEST_COMMAND_DECISION_UNKNOWN');
  openStep(workflow, found.request.phase);
  if (outcome === 'accept') {
    if (found.state !== 'requested') fail(`${id} is already ${found.state}.`, 'TEST_COMMAND_DECISION_CLOSED');
    if (!selfApproval && found.request.requestedBy === actor) {
      fail(`${id} was requested by ${actor}; the step's approval policy needs someone else to accept it.`, 'TEST_COMMAND_SELF_ACCEPTANCE');
    }
  } else if (outcome === 'revoke') {
    if (found.state === 'revoked') fail(`${id} is already revoked.`, 'TEST_COMMAND_DECISION_CLOSED');
  } else fail('A request is accepted or revoked.');
  const record = {
    [outcome === 'accept' ? 'accepts' : 'revokes']: id, phase: found.request.phase,
    reason: outcome === 'revoke' ? reasonText(reason, 15, '--reason') : String(reason ?? '').trim(),
    actor, authorityGroup, identityAssurance, at
  };
  workflow.testCommandDecisions.push(record);
  refreshStep(workflow, found.request.phase);
  return record;
}
