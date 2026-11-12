/**
 * `story test-policy scope`: which tests a Story's gates run, changed at any point while it is open
 * [TCE:REQ-090].
 *
 *   singularity-flow story test-policy scope [WORK-ID] [--json]
 *   singularity-flow story test-policy scope [WORK-ID] --to all-configured|changed-and-affected|new-and-changed [--reason TEXT] [--json]
 *
 * Owner, 2026-11-06: anyone working on the Story may change it, an agent included, and a move to
 * fewer tests is recorded with its reason and shown to the step's reviewer. A filter or `.only` added
 * to the tests themselves is still refused (CODE_TEST_NARROWED): this setting is the open way to run fewer.
 *
 * Nothing already recorded changes. The sealed test policy stays as intake wrote it, and every
 * recorded run stays what it was. The change decides what the next gate runs, and a run on the same
 * code that already covers it stands [TCE:REQ-080], so a wider scope runs only what has not run.
 */
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { storyTestScope, TEST_SCOPES } from '../code-delivery-policy.mjs';
import { repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory } from '../state-stores.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { actionActor } from './kernel.mjs';

const ALLOWED = new Set(['work-id', 'to', 'reason', 'fetch', 'json']);
export const TEST_SCOPE_LABELS = Object.freeze({
  'all-configured': 'All configured tests',
  'changed-and-affected': 'Changed and affected tests',
  'new-and-changed': 'Only new and changed tests'
});
const MEANING = Object.freeze({
  'all-configured': "Each code step runs the repository's own suite as well as the tests of every module it touches.",
  'changed-and-affected': 'Each code step runs every test of the modules it touches.',
  'new-and-changed': "Each code step runs only the test files the Story added, changed or planned. Its other tests never run, and each step's review says so."
});
const fail = (message, code, details) => { throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) }); };
const width = (scope) => TEST_SCOPES.length - TEST_SCOPES.indexOf(scope);

/** The scope a Story runs under, what it means, how it got there, and the record of each change. */
export function testScopeView(workflow) {
  const scope = storyTestScope(workflow);
  const changes = workflow.testScopeChanges ?? [];
  const pilot = Boolean(workflow.testRecovery || workflow.resolution?.testRecovery?.enabled === true);
  return { workId: workflow.workItem.id, scope, label: TEST_SCOPE_LABELS[scope], meaning: MEANING[scope], changes,
    existingTestsRun: scope !== 'new-and-changed',
    changeable: workflow.status === 'in_progress' && !pilot,
    ...(pilot ? { sealedBy: 'test-recovery-pilot' } : {}),
    scopes: TEST_SCOPES.map((id) => ({ id, label: TEST_SCOPE_LABELS[id], meaning: MEANING[id], current: id === scope })) };
}

/** Change the scope of an open Story and commit the record. The refusals name what to do instead. */
export async function recordTestScopeChange(root, config, workflow, { scope, reason = '' }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') fail(`Story ${id} is ${workflow.status}; its test scope changes only while it is open.`, 'TEST_SCOPE_STORY_CLOSED');
  if (workflow.testRecovery || workflow.resolution?.testRecovery?.enabled === true) {
    fail(`Story ${id} is on the test-recovery pilot, whose agreement seals which tests run. Review it with singularity-flow story test-policy show ${id}.`, 'TEST_SCOPE_SEALED_BY_PILOT');
  }
  const current = storyTestScope(workflow);
  if (!TEST_SCOPES.includes(scope)) fail(`Test scope must be one of ${TEST_SCOPES.join(', ')}.`, 'TEST_SCOPE_INVALID');
  const text = String(reason ?? '').trim();
  const narrowing = width(scope) < width(current);
  if (narrowing && (text.length < 10 || text.length > 500)) {
    fail(`Moving ${id} to fewer tests needs a reason of 10 to 500 characters with --reason: the step's reviewer reads it.`, 'TEST_SCOPE_REASON_REQUIRED');
  }
  const { value: record, publication } = await transactStory(root, config, workflow,
    { type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase, generation: null, actor, agent, payload: { decision: 'test-scope' } },
    `[${id}][test-scope] ${current} to ${scope}`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'change the test scope');
      aggregate.testScopeChanges ??= [];
      const recorded = { id: `TSC-${String(aggregate.testScopeChanges.length + 1).padStart(3, '0')}`, from: current, to: scope, narrowing,
        phase: aggregate.currentPhase, reason: text, actor: actorKey(actor), at: nowIso() };
      aggregate.testScopeChanges.push(recorded);
      aggregate.history.push({ at: recorded.at, actor: recorded.actor, agent, event: 'test_scope_changed', phase: recorded.phase,
        detail: `${recorded.id} ${TEST_SCOPE_LABELS[current]} to ${TEST_SCOPE_LABELS[scope]}${text ? `. ${text}` : ''}` });
      return recorded;
    },
    { eventFromResult: (recorded) => ({ actor, agent, payload: { decision: 'test-scope', record: recorded.id, reviewPacketSha256: null } }) });
  return { record, publication };
}

export async function run(positionals, { options = {}, root = repoRoot() } = {}) {
  if (Object.keys(options).some((key) => !ALLOWED.has(key)) || positionals.length > 1) {
    fail('Use story test-policy scope [WORK-ID] [--to SCOPE] [--reason TEXT] [--json].', 'TEST_SCOPE_INVALID');
  }
  const requested = positionals[0] ?? optionString(options, 'work-id') ?? null;
  if (requested) await checkoutStoryBranch(root, await loadConfig(root), requested, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requested ?? undefined);
  const workflow = accepted.workflow;
  const json = optionBoolean(options, 'json');
  const scope = optionString(options, 'to') ?? null;
  const emit = (result) => emitCommandResult(commandResult(result), { json, ...(result.postState ? { postState: result.postState } : { restStateWhenIdle: null }) });
  if (!scope || scope === storyTestScope(workflow)) {
    const view = testScopeView(workflow);
    if (scope && !view.changeable) fail(`Story ${view.workId} cannot change its test scope${view.sealedBy ? ': the test-recovery pilot seals it' : ': it is not open'}.`, view.sealedBy ? 'TEST_SCOPE_SEALED_BY_PILOT' : 'TEST_SCOPE_STORY_CLOSED');
    if (!json) printView(view);
    return emit({ operation: { id: 'story.test-policy.scope.preview', classification: 'read' },
      outcome: succeeded('story.test-policy.scope-inspected', { status: view.label }), effects: noEffects(), restState: 'informational', data: view });
  }
  const loadedSession = await loadSession(root, { required: false });
  const { record, publication } = await recordTestScopeChange(root, accepted.definition, workflow,
    { scope, reason: optionString(options, 'reason') ?? '' },
    { actor: actionActor(root), agent: loadedSession?.workId === workflow.workItem.id ? loadedSession.agent ?? null : null });
  const view = testScopeView(workflow);
  if (!json) {
    console.log(`Test scope of ${view.workId} is now ${TEST_SCOPE_LABELS[record.to]} (was ${TEST_SCOPE_LABELS[record.from]}), recorded as ${record.id}.`);
    console.log(MEANING[record.to]);
    console.log('Runs already recorded stay as they are; a run on the same code that covers what is now asked is not repeated.');
    console.log(publication.pushed ? `Committed and pushed.` : `Committed locally; push is disabled by git.publish: off.`);
  }
  return emit({ operation: { id: 'story.test-policy.scope', classification: 'mutation' }, subject: { kind: 'story', id: view.workId },
    outcome: succeeded('story.test-policy.scope-changed', { status: TEST_SCOPE_LABELS[record.to] }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { ...view, record, commit: publication.sha, pushed: publication.pushed }, postState: workflow });
}

function printView(view) {
  console.log(`Test scope of ${view.workId}: ${view.label}. ${view.meaning}`);
  for (const change of view.changes) {
    console.log(`  ${change.id}: ${TEST_SCOPE_LABELS[change.from]} to ${TEST_SCOPE_LABELS[change.to]}, by ${change.actor} at ${change.at}${change.reason ? `: ${change.reason}` : ''}`);
  }
  if (view.sealedBy) console.log('The test-recovery pilot seals this Story\'s scope.');
  else if (view.changeable) console.log(`Change it: singularity-flow story test-policy scope ${view.workId} --to ${TEST_SCOPES.join('|')} [--reason TEXT]`);
}
