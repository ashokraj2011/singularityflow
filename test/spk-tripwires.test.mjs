/**
 * Tripwires. `[SPK:AC-007]`
 *
 * Every other suite in this pack proves a feature works. These prove that eight specific ways of
 * getting around the features *do not work* — and each one is a shortcut somebody would genuinely
 * reach for, not a hypothetical.
 *
 * A tripwire is worth more than a feature test because features are exercised constantly and their
 * breakage is loud. A bypass is exercised by nobody until the day someone is in a hurry, and its
 * breakage is silent: the gate simply stops being there.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { COMMAND_REGISTRY, resolveOperation } from '../src/command-registry.mjs';
import { FAST_PATH_VERBS } from '../src/fast-path.mjs';
import { convergenceFacts, convergenceProjection, validateAdjudication } from '../src/convergence.mjs';
import { evaluateApprovalChecklist } from '../src/specification-gate.mjs';
import { STARTER_CHECKLIST } from '../src/specification-quality.mjs';
import { policyValue, validateCitations } from '../src/constitution.mjs';

const SOURCE = new URL('../src/', import.meta.url);
import { commandFunction, commandLayerSource } from './helpers/command-source.mjs';

/**
 * Source with comments removed.
 *
 * Several tripwires below ask "does this module *do* X". Prose is not doing: a comment explaining
 * why something is forbidden would otherwise trip the very guard that forbids it, and the fix a
 * reader reaches for is deleting the explanation.
 */
function withoutComments(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function sourceFiles() {
  const names = (await readdir(SOURCE, { recursive: true })).filter((name) => name.endsWith('.mjs'));
  return Promise.all(names.map(async (name) => [name, await readFile(new URL(name, SOURCE), 'utf8')]));
}

test('an alias cannot reach an operation the long form could not', async () => {
  /**
   * The five verbs are the friendly surface, and the obvious shortcut is for one to do the work
   * itself rather than route to the registered operation — at which point the gates attached to
   * that operation are simply not there. `[SPK:CON-002]` forbids a second lifecycle engine wearing
   * a friendly name; this checks the verbs never grew one.
   */
  const dispatcher = withoutComments(await readFile(new URL('commands/fast-path.mjs', SOURCE), 'utf8'));
  const planner = withoutComments(await readFile(new URL('fast-path.mjs', SOURCE), 'utf8'));
  for (const forbidden of ['publishGeneration', 'submitPhase', 'approvePhase', 'rejectPhase', 'commitAndPublish', 'saveWorkflow']) {
    assert.doesNotMatch(dispatcher, new RegExp(`\\b${forbidden}\\s*\\(`), `the verb dispatcher calls ${forbidden} directly instead of routing`);
    assert.doesNotMatch(planner, new RegExp(`\\b${forbidden}\\s*\\(`), `the verb planner calls ${forbidden} directly instead of routing`);
  }

  // And every verb is a registered command in its own right, so the registry, tripwires and help
  // treat it exactly like the long form.
  for (const verb of FAST_PATH_VERBS) {
    const entry = COMMAND_REGISTRY.find((command) => command.name === verb);
    assert.ok(entry, `${verb} is not a registered command`);
    assert.equal(entry.classification, 'read', `${verb} claims to mutate; a router must not`);
  }
});

test('the advisory task map cannot gate anything', async () => {
  // `[SPK:CON-046]`. A fully ticked `tasks.md` is a note to yourself. The moment a gate reads it,
  // completion becomes something you can type.
  const [advisory, ...rest] = [
    await readFile(new URL('advisory-tasks.mjs', SOURCE), 'utf8'),
    await readFile(new URL('state.mjs', SOURCE), 'utf8'),
    await readFile(new URL('specification-gate.mjs', SOURCE), 'utf8'),
    await readFile(new URL('convergence.mjs', SOURCE), 'utf8')
  ];
  assert.match(advisory, /not evidence/, 'the task map does not say it is advisory');
  /**
   * Comments stripped first. The property is about what the code *does*, and `state.mjs` legitimately
   * discusses `tasks.md` in a comment about bundle integrity — scanning raw text would have made
   * this tripwire fire on an explanation of why the file is *not* trusted, which is the opposite of
   * what it guards.
   */
  for (const consumer of rest.map(withoutComments)) {
    assert.doesNotMatch(consumer, /tasks\.md/, 'a gate reads tasks.md');
    assert.doesNotMatch(consumer, /\[\s*x\s*\]/i, 'a gate reads task completion markers');
    assert.doesNotMatch(consumer, /ADVISORY_TASK_MEMBER|deriveAdvisoryTasks/, 'a gate consumes the advisory task map');
  }

  // The shipped set declares it advisory, and an advisory member can never be required into
  // becoming evidence.
  const workflow = await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8');
  assert.match(workflow, /path: tasks\.md, role: advisory-task-map, required: false, authority: advisory/);
});

test('a model cannot confirm a checklist article', () => {
  // `[SPK:CON-030]`. A model may summarize the evidence; the confirmation attributed to a human has
  // to come from that human. The bypass is a default — anything that turns an absent article into a
  // `satisfied` one without a person.
  const policy = { mode: 'enforce', checklist: STARTER_CHECKLIST.id };
  assert.equal(evaluateApprovalChecklist({ policy, decisions: [] }).errors.length, STARTER_CHECKLIST.articles.length,
    'an approval with no decisions was accepted');

  // Partial decisions do not become whole ones.
  const five = STARTER_CHECKLIST.articles.slice(0, 5).map((article) => ({ article: article.id, decision: 'satisfied' }));
  assert.equal(evaluateApprovalChecklist({ policy, decisions: five }).errors.length, 1);

  // And there is no flag that answers them all at once.
  assert.doesNotMatch(
    JSON.stringify(Object.keys(evaluateApprovalChecklist({ policy, decisions: five }))),
    /allSatisfied|acceptAll|autoConfirm/i
  );
});

test('a checklist shortcut flag does not exist anywhere in the CLI', async () => {
  const cli = withoutComments(await commandLayerSource());
  for (const flag of ['all-satisfied', 'accept-all', 'auto-confirm', 'skip-checklist']) {
    assert.doesNotMatch(cli, new RegExp(`'${flag}'`), `the CLI accepts --${flag}, which is a rubber stamp with a human's name on it`);
  }
});

test('an assisted candidate cannot mutate a deterministic fact', async () => {
  // `[SPK:CON-034]` and `[SPK:CON-029]`. The structural guarantee is that neither assisted record
  // contains a copy of the deterministic findings — so there is nothing there to have been changed.
  const quality = withoutComments(await readFile(new URL('assisted-quality.mjs', SOURCE), 'utf8'));
  const converge = withoutComments(await readFile(new URL('assisted-convergence.mjs', SOURCE), 'utf8'));
  assert.doesNotMatch(quality, /findings:\s*report\.findings/, 'the assisted record copies the deterministic findings');
  assert.doesNotMatch(converge, /facts:\s*facts\b/, 'the assisted convergence record copies the deterministic facts');
  assert.match(quality, /findingCount: report\.findings\.length/, 'the assisted record must reference findings by count, not carry them');
  assert.match(converge, /factIds: facts\.map/, 'the assisted convergence record must reference facts by ID, not carry them');

  // A candidate is never a governed finding until a human disposes of it `[SPK:CON-035]`.
  const facts = convergenceFacts({ reconciliation: { reconciliationSha256: 'a'.repeat(64), findings: [] } });
  const candidates = [{ id: 'CC-abc123abc123', classification: 'missing', clauseIds: ['D:REQ-001'], text: 'x' }];
  const projection = convergenceProjection({
    workId: 'D-1',
    bindings: { iteration: 1, reconciliation: { sha256: 'a'.repeat(64) } },
    facts, candidates, adjudications: []
  });
  assert.deepEqual(projection.findings, [], 'an unadjudicated candidate became a governed finding');
  assert.ok(projection.allowedNext.includes('adjudicate'));
  assert.ok(!projection.allowedNext.includes('advance-to-verification'), 'an undisposed candidate allowed advancement');
});

test('convergence cannot re-derive what reconciliation already decided', async () => {
  /**
   * `[SPK:CON-031]` `[SPK:CON-032]`. Reconciliation is the path-altitude authority. A convergence
   * engine that enumerated paths itself would be a second answer to a question that already has
   * one, and the two would eventually disagree — at which point neither can be trusted.
   */
  const source = withoutComments(await readFile(new URL('convergence.mjs', SOURCE), 'utf8'));
  for (const forbidden of ['changedRepositoryPaths', 'pathsSince', 'changedFiles', 'git.mjs', "spawn", 'execFile']) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace('.', '\\.')), `convergence reaches for ${forbidden} instead of consuming reconciliation`);
  }
  assert.match(source, /reconciliation\.findings/, 'convergence does not consume the reconciliation findings');

  // No reconciliation record, no convergence. It cannot substitute its own view of the tree.
  assert.throws(() => convergenceFacts({}), /requires the reconciliation record/);
});

test('the agent running convergence cannot create rework or advance', async () => {
  /**
   * `[SPK:CON-036]`. Rework is a governed change request through the existing approval-authority
   * path `[SPK:REQ-182]`, and advancement is an explicit human action `[SPK:REQ-183]`. The bypass
   * is `converge` doing either itself, at which point a model has moved the Story.
   */
  const cli = withoutComments(await commandLayerSource());
  const converge = await commandFunction('storyConvergeCommand');
  for (const forbidden of ['rejectPhase', 'approvePhase', 'submitPhase', 'publishGeneration']) {
    assert.doesNotMatch(converge, new RegExp(`\\b${forbidden}\\s*\\(`), `story converge calls ${forbidden} itself`);
  }

  // Advancement refuses without the exact digest of the fully verified convergence snapshot. A
  // boolean `--confirm` would merely prove that somebody supplied a flag; it would not prove what
  // they reviewed, and could survive source/evidence drift between preview and submission.
  const advance = await commandFunction('storyAdvanceCommand');
  assert.match(advance, /advancementBlocked\(/, 'advancement does not check for unresolved blockers');
  assert.match(advance,
    /const reviewed = await assertConvergencePublicationReady\(root, config, workflow, subject\.phase\)/,
    'advancement does not compute the exact publishable convergence snapshot');
  assert.match(advance, /const confirmation = optionString\(options, 'confirm'\)/,
    'advancement does not require a digest-valued confirmation');
  assert.match(advance, /if \(confirmation !== reviewed\.snapshotSha256\)/,
    'advancement does not reject a stale or unrelated confirmation digest');
  assert.match(advance, /--confirm \$\{reviewed\.snapshotSha256\}/,
    'the no-confirm preview does not return the exact digest a human must review');
  assert.match(advance, /submitConfirmedConvergenceCommand\([\s\S]*reviewed\.snapshotSha256/,
    'the reviewed digest is not carried into the private confirmed-submission boundary');
  assert.doesNotMatch(advance, /optionBoolean\(options, 'confirm'\)|options\.confirm\s*===\s*true/,
    'advancement still accepts a content-free boolean confirmation');

  // Every disposition except direct deterministic rework needs a human-authored reason.
  const facts = [{ id: 'CF-aaaaaaaaaaaa', kind: 'absent-observed-claim', clauseIds: [] }];
  assert.throws(() => validateAdjudication({ itemId: 'CF-aaaaaaaaaaaa', disposition: 'dismissed' }, { facts }), /needs a human-authored reason/);
  assert.doesNotThrow(() => validateAdjudication({ itemId: 'CF-aaaaaaaaaaaa', disposition: 'rework' }, { facts }));
  assert.throws(
    () => validateAdjudication({ itemId: 'CC-bbbbbbbbbbbb', disposition: 'rework' }, { facts, candidates: [{ id: 'CC-bbbbbbbbbbbb' }] }),
    /needs a human-authored reason/,
    'rework on an assisted candidate went unexplained'
  );
});

test('constitution text cannot override policy', async () => {
  /**
   * `[SPK:CON-041]`. The bypass is editing the enforced article to say what you wish the policy
   * said. It fails validation — but the deeper guarantee is that nothing anywhere *reads* the
   * article prose as a policy value: the value comes from the resolved configuration, always.
   */
  const constitution = withoutComments(await readFile(new URL('constitution.mjs', SOURCE), 'utf8'));
  assert.match(constitution, /export function policyValue\(resolution, policyPath\)/);
  // The renderer is a one-way function from policy to prose. Nothing parses prose back into a value.
  assert.doesNotMatch(constitution, /parsePolicyFromProse|proseToPolicy|applyArticle/);
  assert.equal(policyValue({ phases: [{ id: 'a', approval: { minimum: 1 } }] }, 'phases.a.approval.minimum'), 1);

  // No gate anywhere consults an article to decide an approval minimum or a mode.
  for (const [name, text] of await sourceFiles()) {
    if (['constitution.mjs', 'review.mjs'].includes(path.basename(name))) continue;
    assert.doesNotMatch(withoutComments(text), /article\.(?:prose|body)\s*(?:===|\.includes|\.match)/, `${name} reads constitution prose to make a decision`);
  }
});

test('an old Story cannot adopt moving configuration', async () => {
  /**
   * `[SPK:CON-039]`. A Story is held to the rules that were in force when it started. The bypass is
   * subtle and was real: resolve a policy correctly, then fail to carry it into the Story's own
   * snapshot, so every later read falls back to whatever the configuration branch says *today*.
   */
  const config = await readFile(new URL('config.mjs', SOURCE), 'utf8');
  const snapshot = config.slice(config.indexOf('export async function snapshotResolution'));
  for (const pinned of ['constitution', 'artifactSets', 'analysisLimits', 'spec', 'sequenceGates', 'approvalAuthorities']) {
    assert.match(snapshot, new RegExp(`${pinned}:`), `the Story snapshot drops '${pinned}', so it reads live configuration instead`);
  }

  // Citations are validated against the pin, so an article added after the Story started is not one
  // the author can be held to — they never read it.
  const pin = { path: 'c.md', fileSha256: 'a'.repeat(64), indexSha256: 'b'.repeat(64), articles: [{ id: 'ART-001', type: 'judged', status: 'active' }] };
  assert.deepEqual(validateCitations(pin, ['ART-001']).errors, []);
  assert.equal(validateCitations(pin, ['ART-002']).errors.length, 1, 'an article the Story never pinned was accepted');
});

test('no command runs a shell fragment supplied by an artifact, checklist, constitution or model', async () => {
  /**
   * `[SPK:CON-049]`. Every one of those is attacker-influenced or model-generated text, and the
   * distance between "the document says what to run" and "the document runs it" is one convenience.
   */
  const modules = [
    'specification-quality.mjs', 'clarification-markers.mjs', 'specification-gate.mjs',
    'convergence.mjs', 'assisted-quality.mjs', 'assisted-convergence.mjs', 'constitution.mjs',
    'artifact-sets.mjs', 'advisory-tasks.mjs', 'analysis-limits.mjs'
  ];
  for (const name of modules) {
    const text = withoutComments(await readFile(new URL(name, SOURCE), 'utf8'));
    for (const forbidden of ['child_process', 'execSync', 'execFile', 'spawnSync', 'eval(', 'new Function']) {
      assert.ok(!text.includes(forbidden), `${name} can execute a command; none of these modules may`);
    }
  }
});

test('the deterministic paths never invoke a model', async () => {
  /**
   * `[SPK:CON-050]`. `spec analyze` and `story converge` default to `never`, and `never` is enforced
   * by the operation context — which is exactly what made `--assisted` unreachable until it was
   * classified separately. That accident is the proof the classification is load-bearing.
   */
  const cases = [
    [{ requestedCommand: 'spec', positionals: ['spec', 'analyze'], options: {} }, 'never'],
    [{ requestedCommand: 'spec', positionals: ['spec', 'analyze'], options: { assisted: true } }, 'optional'],
    [{ requestedCommand: 'story', positionals: ['story', 'converge'], options: {} }, 'never'],
    [{ requestedCommand: 'story', positionals: ['story', 'converge'], options: { assisted: true } }, 'optional'],
    [{ requestedCommand: 'review', positionals: ['review'], options: {} }, 'never'],
    [{ requestedCommand: 'status', positionals: ['status'], options: {} }, 'never'],
    [{ requestedCommand: 'constitution', positionals: ['constitution', 'check'], options: {} }, 'never']
  ];
  for (const [request, expected] of cases) {
    assert.equal(resolveOperation(request).modelPolicy, expected,
      `${request.positionals.join(' ')}${request.options.assisted ? ' --assisted' : ''} has the wrong model policy`);
  }

  // And the deterministic modules import no provider.
  for (const name of ['specification-quality.mjs', 'convergence.mjs', 'specification-gate.mjs', 'constitution.mjs']) {
    const text = withoutComments(await readFile(new URL(name, SOURCE), 'utf8'));
    assert.ok(!text.includes('model-runner'), `${name} imports the model runner`);
    assert.ok(!text.includes('invokeModel'), `${name} can invoke a model`);
  }
});

test('an assisted pass receives a bounded envelope, not the repository', async () => {
  // `[SPK:REQ-131]`. Enforced on what is *sent*, because once a model has the content no policy
  // downstream can un-send it.
  const cli = withoutComments(await commandLayerSource());
  for (const marker of ['runAssistedAnalysis', 'runAssistedConvergence']) {
    const body = cli.slice(cli.indexOf(`async function ${marker}`), cli.indexOf(`async function ${marker}`) + 2200);
    assert.match(body, /tools: \{ mode: 'none' \}/, `${marker} grants the model tools`);
    assert.match(body, /limits: \{ timeoutMs/, `${marker} sends an unbounded request`);
  }
});
