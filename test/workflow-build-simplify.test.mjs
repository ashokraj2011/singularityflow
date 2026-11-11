/**
 * A simpler workflow from a team's own: `workflow build start --simplify ID` copies it
 * under a new ID, offers every simplification it can check (located, with why), a person accepts
 * each, and the build finishes only once `workflow validate` (and `workflow walk`, where present)
 * find nothing left in what it would propose, or the person accepts each remaining one by ID. The
 * original workflow is never changed. Also: template fixes are placeholders, never one Story's wording.
 * A real walk takes minutes per workflow: the fast lane gives verify a stand-in for it, and the
 * slow-lane test walks the staged simpler copy for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { repositoryOwnedWorkflows, requirementsTemplatePlansCode } from './helpers/repository-owned-workflows.mjs';
import { addFamilyWorkflow } from './helpers/custom-workflow-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

async function harness() {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-simplify-'));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Build Tester', SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(state, 'builds'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(state, 'outbox') };
  const run = (command, args, cwd, { input = '', allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
    if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const flow = (cwd, args, options) => run(process.execPath, [bin, ...args], cwd, options);
  const json = (cwd, args, options) => JSON.parse(flow(cwd, [...args, '--json'], options).stdout);
  return { state, env, run, flow, json, engineEnv: { SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: env.SINGULARITY_FLOW_WORKFLOW_BUILD_STATE } };
}

/** A repository whose team workflow `fmly` is heavy (see the fixture); with a remote and sflow/config when `remote`. */
async function familyRepository({ run, flow }, { remote = false, ...fixture } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-simplify-repo-'));
  const root = path.join(base, 'app');
  run('git', ['init', '-q', '-b', 'main', root], base);
  run('git', ['config', 'user.name', 'Build Tester'], root); run('git', ['config', 'user.email', 'build@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Family\n');
  flow(root, ['init']);
  await repositoryOwnedWorkflows(root);
  await requirementsTemplatePlansCode(root);
  await addFamilyWorkflow(root, fixture);
  run('git', ['add', '-A'], root); run('git', ['commit', '-qm', 'family workflow'], root);
  if (remote) {
    const bare = path.join(base, 'application.git');
    run('git', ['init', '-q', '--bare', '--initial-branch=main', bare], base);
    run('git', ['remote', 'add', 'origin', bare], root); run('git', ['push', '-q', '-u', 'origin', 'main'], root);
    run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], root);
    return { base, root, bare };
  }
  return { base, root };
}

const lineAt = async (root, location) => (await readFile(path.join(root, location.file), 'utf8')).split('\n')[location.line - 1];
const familyOf = (text) => {
  const parsed = YAML.parse(text);
  return { workflow: parsed.workTypes.fmly, phases: Object.fromEntries(Object.entries(parsed.phases).filter(([id]) => id.startsWith('fmly-'))) };
};

test('simplify offers each candidate it checked, located with why; finish waits until the result validates; the original never changes', async () => {
  const h = await harness();
  const { root, base } = await familyRepository(h);
  const original = await readFile(path.join(root, 'singularity/workflow.yml'));
  const started = h.json(root, ['workflow', 'build', 'start', '--simplify', 'fmly']).build;
  assert.equal(started.label, 'Family delivery (simpler)');
  assert.match(started.conversation[0].text, /^Simplifying Family delivery into a new workflow, Family delivery \(simpler\): 7 steps.*Family delivery itself is never changed, and Stories already running keep the workflow they started with\./u);
  const candidates = started.simplify.candidates;
  const byKind = (kind) => candidates.filter((entry) => entry.kind === kind);
  assert.deepEqual(candidates.map((entry) => entry.kind), ['loop-only-route', 'duplicate-step', 'unneeded-step', 'unused-asset'], JSON.stringify(candidates, null, 2));
  for (const candidate of candidates) {
    assert.match(candidate.id, /^sc-[a-f0-9]{10}$/u);
    assert.ok(candidate.why.length > 40, candidate.why);
    assert.equal(candidate.notOffered, null, `${candidate.title}: ${candidate.notOffered}`);
    const proposal = started.proposals.find((entry) => entry.id === candidate.proposal);
    assert.deepEqual([proposal.by, proposal.status, proposal.candidate, proposal.moves], ['sflow', 'pending', candidate.id, candidate.moves]);
  }
  // Located: the decision, the duplicated step and the agent file, each at its own line.
  const [loop] = byKind('loop-only-route');
  assert.equal(loop.location.file, 'singularity/workflow.yml');
  assert.match(await lineAt(root, loop.location), /fmly-test-result/u);
  assert.deepEqual(loop.moves, [{ move: 'decision.remove', after: 'fmly-testing' }]);
  assert.match(loop.why, /^"Did the tests pass\?" after Family testing only sends work back, to Family build or Family testing itself, so a run that passes never moves on: every round waits for its inputs to be recorded, and when its 2 rounds run out the Story pauses for Quality reviewers\. Rejecting Family testing already sends work back to Family build or Family testing, so a person still can\.$/u);
  const [duplicate] = byKind('duplicate-step');
  assert.deepEqual(duplicate.subject, { step: 'fmly-testing-again', keeps: 'fmly-testing' });
  assert.match(await lineAt(root, duplicate.location), /fmly-testing-again/u);
  assert.deepEqual(duplicate.moves, [{ move: 'step.remove', id: 'fmly-testing-again' },
    { move: 'step.change', id: 'fmly-release', reads: ['fmly-requirements', 'fmly-build', 'fmly-testing'] }]);
  assert.match(duplicate.why, /same agent \(Family engineer\), output \(document\) and template \(common\/verification\.md\).*one sign-off; Family release check reads Family testing instead\./u);
  const [unused] = byKind('unused-asset');
  assert.deepEqual([unused.location, unused.subject, unused.moves[0].move, unused.moves[0].item], [{ file: '.github/agents/fmly-legacy.agent.md', line: 1 }, { agent: 'fmly-legacy' }, 'item.leaveOut', 'i-unused-agent-fmly-legacy']);
  assert.ok(started.items.some((item) => item.id === 'i-unused-agent-fmly-legacy' && item.status === 'open'));
  const [unneeded] = byKind('unneeded-step');
  assert.match(await lineAt(root, unneeded.location), /fmly-notes/u);
  assert.match(h.flow(root, ['workflow', 'build', 'status', '--build', started.id]).stdout, /^Ways to make fmly simpler \(4\):$/mu);

  // Before any is accepted, the result has the original's problems: verify lists them, finish refuses.
  // A real walk takes minutes per workflow, so this test stands in for it (the slow-lane test walks for real).
  const { verifyBuild } = await import('../src/workflow-build/simplify.mjs');
  const { finishBuild } = await import('../src/workflow-build/engine.mjs');
  const env = { ...process.env, ...h.engineEnv };
  const walked = [];
  const walk = async ({ candidate, workflow }) => {
    walked.push([workflow, YAML.parse(await readFile(path.join(candidate, 'singularity/workflow.yml'), 'utf8')).workTypes[workflow]?.label]);
    return { available: true, command: `singularity-flow workflow walk ${workflow} --json`, outcome: 'completed', stops: [] };
  };
  const verification = await verifyBuild(started.id, { root, env, walk });
  assert.deepEqual(walked, [['family-delivery-simpler', 'Family delivery (simpler)']], 'the walk is given the staged copy, which has the new workflow');
  assert.deepEqual([verification.resultType, verification.ready, verification.walk.available, verification.build.from], ['workflow-build-verification', false, true, 'fmly']);
  assert.ok(verification.remaining.length >= 1 && verification.remaining.every((entry) => entry.source === 'validate' && entry.acceptable));
  assert.ok(verification.remaining.some((entry) => entry.code === 'WORKFLOW_ROUTE_NO_END'), JSON.stringify(verification.remaining));
  assert.equal(verification.validation.workflows[0].id, 'family-delivery-simpler');
  assert.equal(verification.nextAction.copilotCommand, '/sf-fix-workflow fmly');
  const refused = await finishBuild(started.id, { propose: true, root, env, walk }).then(() => null, (error) => error);
  assert.equal(refused?.code, 'WORKFLOW_BUILD_NOT_VERIFIED');
  assert.match(refused.message, /^Family delivery \(simpler\) is not finished: \d+ problems or stops remain in what it would propose \(workflow validate and workflow walk on the result\):\n {2}f-[a-f0-9]{12} {2}problem {2}/u);
  assert.match(refused.message, /Only if the person accepts one as it is, finish with --accept-problem <ID> for each\./u);
  const bogus = await finishBuild(started.id, { propose: true, root, env, walk, acceptProblems: ['f-000000000000'] }).then(() => null, (error) => error);
  assert.match(bogus.message, /'f-000000000000' is not a problem or stop the simpler workflow has that can be accepted/u);
  assert.equal(h.run('git', ['for-each-ref', 'refs/heads/sflow/config-change'], root).stdout, '', 'nothing was proposed');

  // A person accepts each; SFlow checks each again against what was accepted before it.
  for (const candidate of candidates) h.json(root, ['workflow', 'build', 'decide', '--build', started.id, '--proposal', candidate.proposal, '--accept']);
  const after = await verifyBuild(started.id, { root, env, walk });
  assert.deepEqual([after.ready, after.remaining, after.validation.valid, after.validation.workflows[0].valid], [true, [], true, true], JSON.stringify(after.remaining));
  const check = h.json(root, ['workflow', 'build', 'check', '--build', started.id]);
  assert.deepEqual(check.draft.workflow.phases, ['intake', 'fmly-requirements', 'fmly-build', 'fmly-testing', 'fmly-release']);
  assert.deepEqual(check.simplify, { from: 'fmly', verify: `singularity-flow workflow build verify --build ${started.id}` });
  assert.deepEqual(check.changes.removed.map((entry) => entry.id), ['fmly-notes', 'fmly-testing-again']);
  assert.match(h.flow(root, ['workflow', 'build', 'check', '--build', started.id]).stdout, /^No problem in the check\. Before finishing, verify it: singularity-flow workflow build verify --build wb_[a-f0-9]{16}$/mu);
  // Verified, it finishes: here as a portable bundle (one reviewed proposal: the slow-lane test below).
  const out = path.join(base, 'simpler.sflow-workflows.json');
  assert.equal((await finishBuild(started.id, { out, root, env, walk })).kind, 'bundle');
  assert.deepEqual(await readFile(path.join(root, 'singularity/workflow.yml')), original, 'workflow.yml in the checkout is byte for byte unchanged');
  assert.equal(h.run('git', ['status', '--porcelain'], root).stdout, '');
});

test('the real walk drives the staged simpler copy to its end; finishing keeps that walk and makes one reviewed proposal that leaves the original as it was', slowLane({ timeout: 1_800_000 }), async () => {
  const h = await harness();
  const { root, bare, base } = await familyRepository(h, { remote: true });
  const original = await readFile(path.join(root, 'singularity/workflow.yml'));
  const started = h.json(root, ['workflow', 'build', 'start', '--simplify', 'fmly']).build;
  for (const proposal of started.proposals) h.json(root, ['workflow', 'build', 'decide', '--build', started.id, '--proposal', proposal.id, '--accept']);
  // The walk is given the staged copy: it walks the new workflow, which the repository does not have yet.
  const verified = h.json(root, ['workflow', 'build', 'verify', '--build', started.id]);
  assert.deepEqual([verified.walk.available, verified.walk.command, verified.walk.outcome, verified.walk.reused ?? false],
    [true, 'singularity-flow workflow walk family-delivery-simpler --json', 'completed', false], JSON.stringify(verified.walk));
  assert.deepEqual([verified.ready, verified.remaining], [true, []]);
  assert.equal(h.run('git', ['--git-dir', bare, 'for-each-ref', 'refs/heads/sflow/config-change'], base).stdout, '', 'verifying proposes nothing');
  const again = h.json(root, ['workflow', 'build', 'verify', '--build', started.id]);
  assert.deepEqual([again.walk.reused, again.walk.outcome, again.ready], [true, 'completed', true], 'an unchanged build keeps its walk');
  const proposed = h.json(root, ['workflow', 'build', 'finish', '--build', started.id, '--propose']);
  assert.match(proposed.branch, /^sflow\/config-change\/workflow\/studio-/u);
  const proposedYaml = h.run('git', ['--git-dir', bare, 'show', `${proposed.branch}:singularity/workflow.yml`], base).stdout;
  const simpler = YAML.parse(proposedYaml).workTypes['family-delivery-simpler'];
  assert.deepEqual([simpler.label, simpler.decisions ?? []], ['Family delivery (simpler)', []]);
  assert.deepEqual(familyOf(proposedYaml), familyOf(original.toString('utf8')), 'the original workflow and its steps are exactly as they were');
  assert.deepEqual(await readFile(path.join(root, 'singularity/workflow.yml')), original, 'workflow.yml in the checkout is byte for byte unchanged');
  assert.equal(h.run('git', ['status', '--porcelain'], root).stdout, '');
  const finished = h.json(root, ['workflow', 'build', 'status', '--build', started.id]).build;
  assert.deepEqual(finished.conversation.slice(-2).map((turn) => [turn.by, turn.kind, turn.text.startsWith('Verified with workflow validate and workflow walk')]),
    [['sflow', 'verified', true], ['sflow', 'finished', false]]);
});

test('a walk stop holds the finish until the person accepts it by ID; no move may change the original', async () => {
  const h = await harness();
  const { root, base } = await familyRepository(h);
  const env = { ...process.env, ...h.engineEnv };
  const started = h.json(root, ['workflow', 'build', 'start', '--simplify', 'fmly', '--name', 'Family lite']).build;
  for (const proposal of started.proposals) h.json(root, ['workflow', 'build', 'decide', '--build', started.id, '--proposal', proposal.id, '--accept']);
  const { verifyBuild, walkStops, walkCandidate } = await import('../src/workflow-build/simplify.mjs');
  const { finishBuild, proposeToBuild } = await import('../src/workflow-build/engine.mjs');
  // `workflow walk --json` (where this SFlow has it): every stop that is not a person's real decision.
  const result = { workflows: [{ id: 'family-lite', stops: [
    { id: 'walk-build-check', step: 'fmly-build', title: 'Family build waits for a check result nobody records' },
    { step: 'fmly-testing', title: 'A person signs off Family testing', personDecision: true }] }] };
  const walk = async ({ workflow }) => ({ available: true, command: `singularity-flow workflow walk ${workflow} --json`, stops: walkStops(result, workflow) });
  const verified = await verifyBuild(started.id, { root, env, walk });
  assert.deepEqual([verified.ready, verified.walk.available, verified.remaining.map((entry) => [entry.id, entry.source, entry.step])], [false, true, [['walk-build-check', 'walk', 'fmly-build']]]);
  const out = path.join(base, 'family-lite.sflow-workflows.json');
  const held = await finishBuild(started.id, { out, root, env, walk }).then(() => null, (error) => error);
  assert.equal(held?.code, 'WORKFLOW_BUILD_NOT_VERIFIED');
  assert.match(held.message, /1 problem or stop remains in what it would propose \(workflow validate and workflow walk on the result\):\n {2}walk-build-check {2}stop {5}Family build waits for a check result nobody records/u);
  const bundle = await finishBuild(started.id, { out, root, env, walk, acceptProblems: ['walk-build-check'] });
  assert.equal(bundle.kind, 'bundle');
  const { readWorkflowBuild } = await import('../src/workflow-build/store.mjs');
  const turns = (await readWorkflowBuild(started.id, { env })).conversation.slice(-3).map((turn) => [turn.by, turn.kind, turn.text]);
  assert.deepEqual(turns[0], ['you', 'accepted', 'Accepted as it is: walk-build-check (Family build waits for a check result nobody records).']);
  // `workflow walk` is in the command registry, so verify walks what the build would propose (the slow-lane test runs it).
  const { operationById } = await import('../src/command-registry.mjs');
  assert.ok(operationById('workflow.walk'), 'workflow walk is feature-detected through the command registry');
  assert.equal(typeof walkCandidate, 'function');
  // Questions are this workflow's own: step.clarify on a step the original shares writes the copy's override only.
  const { checkBuild, decideInBuild } = await import('../src/workflow-build/engine.mjs');
  const clarify = { move: 'step.clarify', id: 'fmly-build', mode: 'when-needed', maxQuestions: 3, topics: ['implementation blockers'] };
  const wrong = await proposeToBuild(started.id, { title: 'Ask always', why: 'No.', moves: [{ ...clarify, mode: 'always' }] }, { root, env }).then(() => null, (error) => error);
  assert.deepEqual(wrong.details.findings.map((entry) => [entry.at, entry.code]), [['moves[0].mode', 'BUILD_MOVE_CLARIFICATION']]);
  const asked = await proposeToBuild(started.id, { title: 'Family build asks only when needed', why: 'Its inputs settle the scope.', moves: [clarify] }, { root, env });
  await decideInBuild(started.id, asked.proposal.id, { accept: true, root, env });
  const clarified = await checkBuild(started.id, { root, env });
  assert.deepEqual(clarified.changeSet.changes.filter((change) => change.clarificationPolicy),
    [{ op: 'phase.update', id: 'fmly-build', workflow: 'family-lite', clarificationPolicy: { mode: 'when-needed', maxQuestions: 3, topics: ['implementation blockers'] } }]);
  assert.ok(clarified.plan.summary.includes('Family build: questions changed for Family lite only.'), clarified.plan.summary.join('\n'));
  assert.deepEqual(clarified.changes.changed.find((entry) => entry.id === 'fmly-build')?.what, ['clarifying questions (when-needed)']);
  const { planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const studio = await planStudioChangeSet(root, { ...clarified.changeSet, changes: [...clarified.changeSet.changes.filter((change) => !change.clarificationPolicy),
    { op: 'phase.update', id: 'fmly-build', workflow: 'family-lite', clarificationPolicy: { mode: 'required', maxQuestions: 40 } }] });
  assert.deepEqual([studio.valid, studio.problems[0]?.code], [false, 'STUDIO_CLARIFICATION_INVALID'], 'Studio checks the policy as the loader does');
  assert.match(studio.problems[0].message, /^The clarifying questions of Family build: clarification\.maxQuestions must be an integer from 1 through 10\.$/u);
  const again = h.json(root, ['workflow', 'build', 'start', '--simplify', 'fmly', '--name', 'Family other']).build;
  const refused = await proposeToBuild(again.id, { title: 'Rename the build step', why: 'Shorter.', moves: [{ move: 'step.change', id: 'fmly-build', label: 'Build' }] }, { root, env })
    .then(() => null, (error) => error);
  assert.deepEqual(refused.details.findings.map((entry) => [entry.at, entry.code]), [['moves[0].id', 'BUILD_SIMPLIFY_ORIGINAL']]);
  assert.match(refused.details.findings[0].message, /^Step 'fmly-build' is in Family delivery, which a simpler copy never changes/u);
  const usage = h.flow(root, ['workflow', 'build', 'start', '--change', 'fmly', '--simplify', 'fmly'], { allowFailure: true });
  assert.match(usage.stderr + usage.stdout, /--simplify ID copies that workflow itself; leave out --from-workflow and --change\./u);
  const { startWorkflowBuild } = await import('../src/workflow-build/build.mjs');
  const inPlace = await startWorkflowBuild({ root, change: 'fmly', simplify: true }, { env }).then(() => null, (error) => error);
  assert.match(inPlace.message, /^--simplify makes a new, simpler workflow from one the repository has: singularity-flow workflow build start --simplify fmly\. It never changes a workflow in place\.$/u);
});

test('candidates are deterministic: groups with the same people, settings findings, shipped templates; a repair loop with a way on is not one', async () => {
  const { simplificationCandidates, walkStops, copyOnlyMove } = await import('../src/workflow-build/simplify.mjs');
  const step = (id, extra = {}) => ({ id, label: id, output: 'document', agent: 'writer', inputs: [], sendBackTo: [id], approval: { mode: 'required', authorities: ['leads'], minimum: 1 }, ...extra });
  const model = {
    phases: [{ id: 'requirements', label: 'Requirements', output: 'document', agent: 'product-owner' }, { id: 'team-spec', output: 'document' }],
    agents: [{ id: 'writer', label: 'Writer' }],
    groups: [{ id: 'leads', label: 'Leads', members: ['ana@example.com', 'bo@example.com'] }, { id: 'reviewers', label: 'Reviewers', members: ['bo@example.com', 'ana@example.com'] },
      { id: 'empty-a', label: 'Empty A', members: [] }, { id: 'empty-b', label: 'Empty B', members: [] }],
    workflows: []
  };
  const workflow = {
    id: 'team', label: 'Team', phases: ['team-spec', 'team-build', 'team-check', 'team-repair', 'team-retest'], plannedClaims: { clausePhases: [], owners: {} },
    steps: [step('team-spec'), step('team-build', { output: 'code', inputs: ['team-spec'], approval: { mode: 'required', authorities: ['reviewers'], minimum: 1 } }),
      step('team-check', { inputs: ['team-build'], approval: { mode: 'required', authorities: ['empty-a'], minimum: 1 } }),
      step('team-repair', { output: 'code', inputs: ['team-check'], approval: { mode: 'required', authorities: ['empty-b'], minimum: 1 } }),
      step('team-retest', { inputs: ['team-repair'] })],
    decisions: [
      { id: 'checked', after: 'team-check', kind: 'branch', label: 'Pass?', routes: [{ id: 'pass', to: 'end' }, { id: 'repair', to: 'team-repair' }] },
      { id: 'repaired', after: 'team-repair', kind: 'branch', label: 'Retest?', routes: [{ id: 'recheck', to: 'team-check' }] }
    ]
  };
  const findings = [
    { code: 'CHECK_QUESTION_PLACEMENT', area: 'clarity', severity: 'warning', title: 'Team build asks what Team spec settled', detail: 'Its questions repeat the spec.', subject: { step: 'team-build' },
      location: { file: 'singularity/workflow.yml', line: 12 }, fix: { text: 'Ask in Team spec.', move: { move: 'step.change', id: 'team-build', reads: ['team-spec'] } } },
    { code: 'CHECK_REVIEWER_UNAVAILABLE', area: 'flow', severity: 'warning', title: 'No step of this workflow is reviewed', detail: 'The reviewer is missing.', subject: {}, fix: { text: 'Add the reviewer agent.' } },
    { code: 'CHECK_TEMPLATE_CLAUSE_ANCHORS', area: 'guidance', severity: 'problem', title: 'The template of team-spec defines no requirement clauses', subject: { step: 'team-spec', template: 'team/spec.md' },
      location: { file: 'singularity/templates/team/spec.md', line: 3 } }
  ];
  const definition = { phases: { 'team-spec': { artifact: { kind: 'requirements' } }, requirements: { artifact: { kind: 'requirements' } } } };
  const candidates = simplificationCandidates({ model, workflow, findings, definition, packaged: new Set(['requirements']) });
  assert.deepEqual(candidates.map((entry) => [entry.kind, entry.notOffered ? 'not offered' : 'offered']), [
    ['mergeable-groups', 'offered'], ['contradicting-settings', 'offered'], ['contradicting-settings', 'not offered'], ['shipped-template', 'offered']]);
  const [groups, placement, reviewer, template] = candidates;
  assert.deepEqual(groups.moves, [{ move: 'step.change', id: 'team-build', signOff: { groups: ['leads'], minimum: 1 } }], 'groups with nobody in them are never merged');
  assert.match(groups.why, /^Leads and Reviewers have exactly the same 2 people, so team-build can be signed off by Leads alone in this workflow/u);
  assert.deepEqual([placement.moves, placement.location.line], [[findings[0].fix.move], 12]);
  assert.match(reviewer.notOffered, /^No build move changes this setting; add the reviewer agent\.$/u);
  assert.deepEqual(template.moves.map((move) => [move.move, move.id]), [['step.add', 'requirements'], ['step.change', 'requirements'], ['step.remove', 'team-spec'], ['step.change', 'team-build']]);
  assert.ok(template.moves.every((move) => copyOnlyMove(move, model)), 'every move changes only the copy');
  assert.equal(copyOnlyMove({ move: 'step.change', id: 'team-build', label: 'Build' }, model), false);
  // The same workflow whose planned claims name the step keeps it: no move changes planned claims.
  const planned = simplificationCandidates({ model, workflow: { ...workflow, plannedClaims: { clausePhases: ['team-spec'], owners: {} } }, findings: [findings[2]], definition, packaged: new Set(['requirements']) });
  assert.match(planned.find((entry) => entry.kind === 'shipped-template').notOffered, /^The workflow's planned claims name team-spec, and no build move changes planned claims/u);
  // `workflow check`'s clarity findings carry fix.data: the edits to a step's clarification setting.
  const { clarifyMoveOf } = await import('../src/workflow-build/simplify.mjs');
  const setting = (step) => ({ path: ['phases', step, 'clarification'], line: 7, scope: 'step', workflowPath: ['workTypes', 'team', 'phaseOverrides', step, 'clarification'] });
  const policies = { 'team-build': { mode: 'required', maxQuestions: 3, topics: ['blockers'], markers: { mode: 'off' } }, 'team-spec': { mode: 'off', maxQuestions: 5, topics: [], markers: { mode: 'block' } } };
  const clarity = [
    { code: 'CHECK_CODE_STEP_ALWAYS_ASKS', area: 'clarity', severity: 'warning', title: 'team-build stops for a person\'s answer before every change', subject: { step: 'team-build' },
      fix: { text: 'Set when-needed.', data: { step: 'team-build', setting: setting('team-build'), decidedBy: 'fixer', edits: [{ path: ['phases', 'team-build', 'clarification', 'mode'], from: 'required', to: 'when-needed' }] } } },
    { code: 'CHECK_SCOPE_NOT_CLARIFIED', area: 'clarity', severity: 'warning', title: 'Nobody is asked about the scope before team-spec defines it', subject: { step: 'team-spec' },
      fix: { text: 'Turn clarification on.', data: { step: 'team-spec', setting: setting('team-spec'), decidedBy: 'fixer',
        edits: [{ path: ['phases', 'team-spec', 'clarification', 'mode'], to: 'required' }, { path: ['phases', 'team-spec', 'clarification', 'topics'], to: ['scope', 'acceptance criteria'] }] } } },
    { code: 'CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED', area: 'clarity', severity: 'warning', title: 'team-spec drafts without always confirming its reading', subject: { step: 'team-spec' },
      fix: { text: 'If people should always confirm.', data: { step: 'team-spec', setting: setting('team-spec'), decidedBy: 'person', edits: [], question: { text: 'Should team-spec always confirm its reading?' } } } }
  ];
  const policyOf = (step) => policies[step] ?? null;
  assert.deepEqual(clarifyMoveOf(clarity[0], policyOf), { move: 'step.clarify', id: 'team-build', mode: 'when-needed', maxQuestions: 3, topics: ['blockers'] }, 'the whole policy, only the edited field changed');
  assert.deepEqual(clarifyMoveOf(clarity[1], policyOf), { move: 'step.clarify', id: 'team-spec', mode: 'required', maxQuestions: 5, topics: ['scope', 'acceptance criteria'], markers: { mode: 'block' } });
  assert.equal(clarifyMoveOf(clarity[2], policyOf), null, 'a person decides; no move is made for them');
  assert.equal(clarifyMoveOf({ fix: { data: { ...clarity[0].fix.data, edits: [{ path: ['phases', 'team-build', 'approval'], to: 'none' }] } } }, policyOf), null, 'only edits to the clarification setting');
  const offered = simplificationCandidates({ model, workflow, findings: clarity, definition, packaged: new Set() }).filter((entry) => entry.kind === 'contradicting-settings');
  assert.deepEqual(offered.map((entry) => [entry.subject.finding, entry.moves.map((move) => move.move), entry.notOffered]), [
    ['CHECK_CODE_STEP_ALWAYS_ASKS', [], 'No build move changes this setting; set when-needed.'],
    ['CHECK_SCOPE_NOT_CLARIFIED', [], 'No build move changes this setting; turn clarification on.'],
    ['CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED', [], 'A person decides: Should team-spec always confirm its reading?']], 'without the steps\' policies (no definition here) nothing is guessed');
  assert.deepEqual(walkStops({ stops: [{ at: 'team-check', message: 'Waits for inputs' }, { step: 'team-build', title: 'A person approves', personDecision: true }] }, 'team')
    .map((stop) => [stop.step, stop.title, /^walk-[a-f0-9]{10}$/u.test(stop.id)]), [['team-check', 'Waits for inputs', true]]);
  // `workflow walk`'s own result (schemaVersion 1): a workflow's stops, the steps it could not judge, a workflow it did not walk.
  const walkResult = (folder) => ({ schemaVersion: 1, resultType: 'workflow-walk', workflows: [
    { id: 'team', label: 'Team', outcome: 'stopped', steps: [
      { id: 'team-check', label: 'Team check', stops: [], notJudged: [{ class: 'not-judged', command: 'submit team-check', code: 'WORKFLOW_WALK_OUT_OF_TIME', message: 'The step ran out of its time.' }] },
      { id: 'team-build', label: 'Team build', stops: [], notJudged: [] }],
    stops: [{ step: 'team-build', class: 'stop', command: 'submit team-build --work-id WALK-1', code: 'QUALITY_COMMAND_MISSING', message: `No test command runs in ${folder}/repository.`, cause: 'The step names no test command.' }] },
    { id: 'other', label: 'Other', outcome: 'not-walked', reason: 'The walk ran out of its total time before this workflow.', steps: [], stops: [] }] });
  const first = walkStops(walkResult('/tmp/sflow-workflow-walk-a1'), 'team');
  assert.deepEqual(first.map((stop) => [stop.kind, stop.step, stop.code, stop.title, stop.detail]), [
    ['stop', 'team-build', 'QUALITY_COMMAND_MISSING', 'No test command runs in /tmp/sflow-workflow-walk-a1/repository.', 'The step names no test command.'],
    ['not-judged', 'team-check', 'WORKFLOW_WALK_OUT_OF_TIME', 'The walk could not judge Team check: The step ran out of its time.', null]]);
  assert.deepEqual(walkStops(walkResult('/tmp/sflow-workflow-walk-b2'), 'team').map((stop) => stop.id), first.map((stop) => stop.id),
    'the same stop has the same ID on the next walk, so the one verify shows is the one finish accepts');
  assert.deepEqual(walkStops(walkResult('/tmp/x'), 'other').map((stop) => [stop.kind, stop.title]),
    [['not-judged', 'The walk did not walk Other: The walk ran out of its total time before this workflow.']]);
});

test('a template fix is placeholders the step\'s author fills for each Story, and the template drafted from it validates', async () => {
  const h = await harness();
  const { root } = await familyRepository(h, { loop: false, requirementsTemplate: '# {{work.id}} — Family requirements\n\n## Requirements\n\nWhat the change must do.\n\n## Acceptance criteria\n\nHow we know it works.\n' });
  const first = h.flow(root, ['workflow', 'validate', 'fmly', '--json'], { allowFailure: true });
  assert.equal(first.status, 1);
  const report = JSON.parse(first.stdout);
  const fix = (code) => report.workflows[0].findings.find((entry) => entry.code === code)?.fix?.text ?? '';
  const anchors = fix('CHECK_TEMPLATE_CLAUSE_ANCHORS');
  const table = fix('CHECK_TEMPLATE_PLANNED_TABLE');
  for (const text of [anchors, table]) {
    assert.match(text, /These are placeholders the step's author fills for each Story; a template never holds one Story's wording, so nobody is asked for it\./u);
    assert.doesNotMatch(text, /export includes|CSV with|rows downloads/u, 'no realistic example a model could take for wording to ask for');
  }
  assert.match(anchors, /^- TODO: one observable requirement per line\. \[\{\{work\.id\}\}:REQ-001\]$/mu);
  assert.match(anchors, /^- TODO: one testable criterion per line\. \[\{\{work\.id\}\}:AC-001\]$/mu);
  assert.match(table, /^\| `\{\{work\.id\}\}:REQ-001` \| TODO: exact backticked source paths \| TODO: exact backticked test paths \| new \| TODO: what a person observes \|$/mu);
  assert.equal(report.fixDraft.fixCommand, undefined, 'without `workflow fix` in the command registry, /sf-fix-workflow drafts the fixes itself');
  // The template drafted from the fix texts alone, exactly as they read, validates.
  const lines = (text, prefix) => text.split('\n').filter((line) => line.startsWith(prefix));
  const [requirement, criterion] = lines(anchors, '- TODO');
  await writeFile(path.join(root, 'singularity/templates/fmly/requirements.md'), ['# {{work.id}} — Family requirements', '', '## Requirements', '', requirement, '',
    '## Acceptance criteria', '', criterion, '', '## Planned implementation evidence', '', ...lines(table, '|'), ''].join('\n'));
  const second = h.flow(root, ['workflow', 'validate', 'fmly', '--json'], { allowFailure: true });
  const fixed = JSON.parse(second.stdout);
  assert.deepEqual([second.status, fixed.valid, fixed.workflows[0].findings.filter((entry) => entry.severity === 'problem')], [0, true, []]);
  // Correct but heavy: validate offers the simpler copy, with its route.
  assert.deepEqual([fixed.workflows[0].simplify.nextAction.copilotCommand, fixed.workflows[0].simplify.nextAction.command],
    ['/sf-build-workflow --simplify fmly', 'singularity-flow workflow build start --simplify fmly']);
  assert.deepEqual(fixed.workflows[0].simplify.found.map((entry) => entry.kind), ['duplicate-step', 'unneeded-step']);
  // The walk reads a folder an in-process caller names (a build's staged copy) by the same policy it reads the repository with.
  const { readConfigurationFolder, readRepositoryConfiguration } = await import('../src/workflow-walk/sandbox.mjs');
  const [folder, checkout] = [await readConfigurationFolder(root), await readRepositoryConfiguration(root)];
  assert.deepEqual([folder.source, checkout.source], [{ kind: 'staged' }, { kind: 'checkout' }]);
  assert.deepEqual([...folder.files.keys()], [...checkout.files.keys()]);
  assert.ok(folder.files.has('singularity/workflow.yml') && folder.files.has('.github/agents/fmly-engineer.agent.md'));
  // An agent nothing uses is the repository's: it makes no workflow heavy.
  const seeded = JSON.parse(h.flow(root, ['workflow', 'validate', 'repo-feature', '--json']).stdout);
  assert.deepEqual([seeded.valid, seeded.workflows[0].simplify], [true, undefined]);
});

test('the skills walk the person through simplify and never ask for template wording', async () => {
  const build = await readFile(path.join(packageRoot, 'plugin/skills/sflow-build-workflow/SKILL.md'), 'utf8');
  const fix = await readFile(path.join(packageRoot, 'plugin/skills/sflow-fix-workflow/SKILL.md'), 'utf8');
  for (const pattern of [/--simplify <ID>\] \[--folder/u, /`--simplify <ID>` makes a simpler copy \(step 8\)/u, /take `candidates` one at a time/u, /ask with `ask_user`: accept, or decline with a reason; record exactly that with `build decide`/u,
    /`singularity-flow workflow build verify --build <ID> --json`/u, /offer finishing only once the person explicitly accepts each as it is, then add `--accept-problem <id>` for each/u,
    /never changing the original workflow/u, /One with a `move`: propose that move \(`--by copilot`\), asking nothing/u, /A template fix is placeholders, never wording asked of the person/u]) {
    assert.match(build, pattern);
  }
  for (const pattern of [/With `simplify` it is correct but heavy: name `simplify\.found` and offer `simplify\.nextAction`/u,
    /With `fixDraft\.fixCommand`, run it: each `change` it returns goes into the draft as given, asking nothing; ask only its `question`s, one at a time/u,
    /Never ask for template content/u, /say in one line that it adds placeholders each Story's author fills/u]) {
    assert.match(fix, pattern);
  }
  assert.doesNotMatch(fix, /wording of requirements/u, 'the person is never asked for requirement wording');
});
