/**
 * The walk on every change (step intents Stage 6, src/workflow-walk/quick.mjs): every path a Story takes and each step's
 * routes on Copilot CLI and VS Code, in this process, with no Story. Fast lane:
 *
 *   - every shipped workflow walks with no stop, in well under its time;
 *   - each class of stop fires on a workflow made to have it, with a plain explanation and a filled fix: a decision that
 *     goes back on values its round never records again (loop), rounds that run out to a group nobody is in (limit), a
 *     skill or page tool a host lacks (host-route), a value SFlow knows left in a route for the agent (copy-value);
 *   - it is bounded: out of time is a note, never a stop;
 *   - `workflow walk --quick` prints it, and refuses what only a Story walk takes;
 *   - on change: `workflow check` reports each stop as a problem with its fix, and the one check every way of making a
 *     workflow runs (create, edit, a configuration save, a Studio change set, an import) refuses a change that adds one.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { QUICK_WALK_CODES, quickWalkLines, quickWalkResolved, quickWalkShippedOr, valuesToCopy, walkHosts } from '../src/workflow-walk/quick.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const BASE = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));

/** The shipped configuration with one work type `walked`, the classic delivery's steps, and `edit` applied. */
function configuration(edit) {
  const value = structuredClone(BASE);
  value.workTypes.walked = { ...structuredClone(value.workTypes['classic-delivery']), label: 'Walked' };
  edit?.(value, value.workTypes.walked);
  return value;
}

const resolvedOf = (value, id = 'walked') => {
  const definition = validateDefinition(structuredClone(value));
  return { definition, resolved: resolveWorkType(definition, id) };
};
const groupsOf = (value) => new Map(Object.entries(value.approvalAuthorities).map(([id, group]) => [id, { id, label: group.label ?? id,
  status: (group.members ?? []).length ? 'people' : group.allowAnyGitIdentity ? 'anyone' : value.approvalSecurity?.autoEnrollNewIdentities === false ? 'blocked' : 'auto' }]));
const walked = (value, options = {}) => {
  const { definition, resolved } = resolvedOf(value);
  return quickWalkResolved(resolved, { approvalAuthorities: definition.approvalAuthorities, groups: groupsOf(value), ...options });
};

/** A decision after intake that records the channel, and one after testing that goes back to Code on it. */
const reusedChannel = (value, type) => {
  type.decisions = [
    { id: 'pick-channel', after: 'intake', kind: 'branch', label: 'Pick the channel', inputs: [{ name: 'channel', values: ['web', 'mobile'] }],
      routes: [{ id: 'web', label: 'Web', when: { channel: 'web' }, to: 'next' }, { id: 'other', label: 'Other', to: 'next' }] },
    { id: 'retest', after: 'testing', kind: 'branch', label: 'Test again on the web', inputs: [{ name: 'channel', from: 'pick-channel' }],
      routes: [{ id: 'again', label: 'Back to Code', when: { channel: 'web' }, to: 'implementation' }, { id: 'done', label: 'Done', to: 'next' }], maxRounds: 2, by: ['engineering-reviewers'] }
  ];
  // A rule goes back only after a step a person signs off.
  type.phaseOverrides.testing.approval = { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['intake', 'implementation', 'testing'] };
};

// ------------------------------------------------------------------------------------------- shipped

test('every shipped workflow walks with no stop on both hosts, in well under its time, with no model and no Story', async () => {
  const started = Date.now();
  const result = await quickWalkShippedOr(ROOT, { shipped: true });
  assert.equal(result.mode, 'quick');
  assert.equal(result.modelUsed, false);
  assert.equal(result.source.kind, 'shipped');
  assert.deepEqual(result.hosts, ['Copilot CLI', "VS Code's chat"]);
  assert.deepEqual(result.workflows.flatMap((workflow) => workflow.stops.map((stop) => `${workflow.id}: ${stop.title}`)), []);
  assert.equal(result.ok, true);
  assert.ok(result.workflows.length >= 15, `${result.workflows.length} workflows`);
  assert.ok(result.workflows.every((workflow) => workflow.outcome === 'completed' && workflow.paths >= 1 && workflow.routes >= 3), JSON.stringify(result.workflows.map(({ id, outcome, paths, routes }) => ({ id, outcome, paths, routes }))));
  assert.ok(Date.now() - started < 20_000, `the quick walk of every shipped workflow took ${Date.now() - started} ms`);
  assert.match(quickWalkLines(result).join('\n'), /No stop: no loop, no limit without a way on, every route exists on both hosts/u);
});

test("the hosts are read from SFlow's own files: the plugin's skills on both, VS Code's page tools and palette where its manifest is", () => {
  const hosts = walkHosts();
  for (const skill of ['/sf-code', '/sf-phase', '/sf-approve', '/sf-decide', '/sf-submit', '/sf-review-source']) {
    assert.ok(hosts['copilot-cli'].skills.has(skill), skill);
    assert.ok(hosts.vscode.skills.has(skill), skill);
  }
  assert.ok(hosts.vscode.tools?.has('#sflowDecide'), 'this checkout carries the VS Code manifest');
  assert.ok(hosts.vscode.palette?.has('Command Palette: Singularity Flow: Stories'));
});

// ------------------------------------------------------------------------------------------- each class

test('loop: a decision that goes back on a value only an earlier decision recorded takes the same route every round, and says how to fix it', () => {
  const result = walked(configuration(reusedChannel));
  const [stop] = result.stops;
  assert.deepEqual(result.stops.map((entry) => [entry.class, entry.code, entry.decision]), [['loop', QUICK_WALK_CODES.sameRoute, 'retest']]);
  assert.equal(result.outcome, 'stopped');
  assert.equal(stop.title, '"Test again on the web" goes back to Code on values that never change');
  assert.match(stop.detail, /It chooses its route from channel, which Pick the channel recorded before Code\. Going back to Code records nothing new for it, so once it takes "Back to Code" it takes it again every round, with nothing changed, until its 2 rounds run out\./u);
  assert.match(stop.fix.text, /give "Test again on the web" \(after: testing\) an input of its own, \{ name: channel, values: \[web, mobile\] \}, in place of the one reused from Pick the channel; or make it a decision a person makes \(kind: ask, with by\)\./u);
  // The fix it names: the testing step records the channel itself each round, and nothing comes round unchanged.
  const fixed = walked(configuration((value, type) => {
    reusedChannel(value, type);
    type.decisions[1].inputs = [{ name: 'channel', values: ['web', 'mobile'] }];
  }));
  assert.deepEqual(fixed.stops, []);
  // A value reused from a decision inside the loop is recorded again each round: no stop.
  const inside = walked(configuration((value, type) => {
    reusedChannel(value, type);
    type.decisions[0].after = 'implementation';
  }));
  assert.deepEqual(inside.stops, []);
});

test('limit: rounds that run out to a group nobody is in leave only the same decision, with the group to fill named', () => {
  const value = configuration((configured, type) => {
    configured.approvalSecurity = { ...configured.approvalSecurity, autoEnrollNewIdentities: false };
    configured.approvalAuthorities['rework-deciders'] = { label: 'Rework deciders', allowAnyGitIdentity: false, members: [] };
    for (const id of ['engineering-reviewers', 'quality-reviewers', 'product-approvers']) configured.approvalAuthorities[id].members = [{ name: 'A person', email: 'person@example.invalid' }];
    type.decisions = [{ id: 'retest', after: 'testing', kind: 'loop', label: 'Retest until green', inputs: [{ name: 'result', values: ['pass', 'fail'] }],
      goal: { result: 'pass' }, back: 'implementation', maxRounds: 2, by: ['rework-deciders'] }];
    type.phaseOverrides.testing.approval = { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['intake', 'implementation', 'testing'] };
  });
  const result = walked(value);
  assert.deepEqual(result.stops.map((entry) => [entry.class, entry.code, entry.decision]), [['limit', QUICK_WALK_CODES.noExit, 'retest']]);
  const [stop] = result.stops;
  assert.equal(stop.title, 'When "Retest until green" runs out of rounds, nobody can say how to go on');
  assert.match(stop.detail, /After 2 rounds back, the Story waits for Rework deciders to decide, but nobody is in it and new people are not added to it automatically\. The only route left is the same decision, which nobody can answer\./u);
  assert.equal(stop.fix.text, 'Add people to Rework deciders in Workflow Studio\'s People, or name a group with people in "Retest until green"\'s by.');
  value.approvalAuthorities['rework-deciders'].members = [{ name: 'A decider', email: 'decider@example.invalid' }];
  assert.deepEqual(walked(value).stops, [], 'with someone in the group, its rounds have a way on');
});

test('host-route: a skill or page tool a host does not have stops there, on that host, with the fix', () => {
  const hosts = walkHosts();
  const without = (skill) => new Set([...hosts['copilot-cli'].skills].filter((entry) => entry !== skill));
  const noApprove = walked(configuration(), { hosts: { 'copilot-cli': { skills: without('/sf-approve') }, vscode: { ...hosts.vscode, skills: without('/sf-approve') } } });
  assert.deepEqual([...new Set(noApprove.stops.map((entry) => `${entry.class} ${entry.code} ${entry.step} ${entry.stage} ${entry.host}`))].sort(), [
    'host-route WALK_ROUTE_NOT_ON_HOST implementation approval copilot-cli', 'host-route WALK_ROUTE_NOT_ON_HOST implementation approval vscode',
    'host-route WALK_ROUTE_NOT_ON_HOST intake approval copilot-cli', 'host-route WALK_ROUTE_NOT_ON_HOST intake approval vscode']);
  assert.match(noApprove.stops[0].detail, /SFlow hands \/sf-approve .* there, but (?:Copilot CLI|VS Code's chat) has no \/sf-approve, so a Story on/u);
  assert.match(noApprove.stops[0].fix.text, /singularity-flow update\.$/u);
  // VS Code's chat takes an approval by the extension's page tool: without it, only VS Code stops.
  const noTool = walked(configuration(), { hosts: { ...hosts, vscode: { ...hosts.vscode, tools: new Set() } } });
  assert.ok(noTool.stops.length >= 1);
  assert.ok(noTool.stops.every((entry) => entry.host === 'vscode' && entry.stage === 'approval'), JSON.stringify(noTool.stops));
  assert.match(noTool.stops[0].detail, /\/sf-approve runs on VS Code's page tool #sflowDecide, which this VS Code extension does not contribute/u);
});

test("copy-value: a route that leaves a value SFlow knows is one to copy; a step's own decision values and the person's words are not", () => {
  assert.deepEqual(valuesToCopy({ command: 'singularity-flow approve <step> --work-id <W> --fetch' }), ['<step>', '<W>']);
  assert.deepEqual(valuesToCopy({ command: 'singularity-flow reject intake --work-id W-1 --to intake --reason <reason>' }), []);
  assert.deepEqual(valuesToCopy({ command: 'singularity-flow phase rollover intake --reason "<what to change>" --json' }), []);
  // A step that feeds a rule decision records its values at submission: the author gives them, so no stop.
  const value = configuration((configured, type) => {
    type.decisions = [{ id: 'size', after: 'implementation', kind: 'branch', label: 'Size of the change', inputs: [{ name: 'size', values: ['small', 'large'] }],
      routes: [{ id: 'small', label: 'Small', when: { size: 'small' }, to: 'next' }, { id: 'large', label: 'Large', to: 'next' }] }];
  });
  const result = walked(value);
  assert.deepEqual(result.stops, []);
  assert.ok(result.routes > 0);
});

test('a route that repeats without a limit is a loop the walk names, and workflow check shows it once', () => {
  const result = walked(configuration(reusedChannel), { simulation: { scenarios: [{ id: 'retest:again', kind: 'repair', outcome: 'unbounded', path: [], choices: [{ decision: 'retest', route: 'again' }] }], findings: [] } });
  const repeats = result.stops.find((entry) => entry.code === QUICK_WALK_CODES.repeats);
  assert.equal(repeats.class, 'loop');
  assert.equal(repeats.alsoChecked, 'WORKFLOW_ROUTE_UNBOUNDED');
  assert.match(repeats.fix.text, /Give "Test again on the web" a limit: maxRounds \(1 to 20\) and by/u);
});

test('bounded: a walk out of time adds a note, never a stop', () => {
  const result = walked(configuration(reusedChannel), { deadline: Date.now() - 1 });
  assert.equal(result.outcome, 'stopped', 'what it checks without walking paths still counts');
  const late = walked(configuration(), { deadline: Date.now() - 1 });
  assert.equal(late.outcome, 'not-judged');
  assert.deepEqual(late.stops, []);
  assert.match(late.notes[0], /^The quick walk stopped at its time limit/u);
});

// ------------------------------------------------------------------------------------------- the command and on change

function run(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd, encoding: 'utf8', timeout: childTimeout(240_000), maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A repository initialized from the shipped templates, committed. */
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-quick-walk-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Walk Tester'], ['config', 'user.email', 'walk-tester@example.invalid']]) spawnSync('git', args, { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Quick walk\n');
  assert.equal(run(['init'], root).status, 0);
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('workflow walk --quick prints the walk, exits 0 with no stop, and refuses what only a Story walk takes', async (t) => {
  const root = await repository(t);
  const ran = run(['workflow', 'walk', 'quick-fix', '--quick', '--json'], root);
  assert.equal(ran.status, 0, ran.stderr);
  const value = JSON.parse(ran.stdout);
  assert.equal(value.resultType, 'workflow-walk');
  assert.equal(value.mode, 'quick');
  assert.deepEqual(value.workflows.map((workflow) => [workflow.id, workflow.outcome]), [['quick-fix', 'completed']]);
  const text = run(['workflow', 'walk', '--quick'], root);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /^Quick walk: \d+ workflow\(s\), \d+ path\(s\) and \d+ route\(s\) on Copilot CLI and VS Code, with no model and no Story\./u);
  const keep = run(['workflow', 'walk', '--quick', '--keep', '--json'], root);
  assert.notEqual(keep.status, 0);
  assert.match(keep.stdout + keep.stderr, /WORKFLOW_WALK_USAGE/u);
});

test('on change: workflow check shows each stop as a problem with its fix, and a configuration save that adds one is refused', async (t) => {
  const root = await repository(t);
  const file = path.join(root, 'singularity/workflow.yml');
  const before = await readFile(file, 'utf8');
  const value = YAML.parse(before);
  value.workTypes.walked = { ...structuredClone(value.workTypes['classic-delivery']), label: 'Walked' };
  reusedChannel(value, value.workTypes.walked);
  const { checkedConfigurationSave } = await import('../src/workflow-autofix.mjs');
  await assert.rejects(checkedConfigurationSave(root, 'singularity/workflow.yml', YAML.stringify(value), () => writeFile(file, YAML.stringify(value))), (error) => {
    assert.equal(error.code, 'CONFIGURATION_SAVE_WORKFLOW_PROBLEMS');
    assert.match(error.message, /- walked: "Test again on the web" goes back to Code on values that never change\n {2}Fix: Have Testing record the value each round/u);
    assert.equal(error.details.problems[0].code, QUICK_WALK_CODES.sameRoute);
    return true;
  });
  assert.equal(await readFile(file, 'utf8'), before, 'nothing was saved');
  // Written by hand anyway, workflow check reports it, located, with its fix, and says the walk ran.
  await writeFile(file, YAML.stringify(value));
  const checked = run(['workflow', 'check', 'walked', '--json'], root);
  const report = JSON.parse(checked.stdout);
  const [workflow] = report.workflows;
  const found = workflow.findings.find((entry) => entry.code === QUICK_WALK_CODES.sameRoute);
  assert.equal(found.severity, 'problem');
  assert.equal(found.subject.walk, 'loop');
  assert.equal(found.subject.decision, 'retest');
  assert.match(found.fix.text, /an input of its own, \{ name: channel, values: \[web, mobile\] \}/u);
  assert.ok(found.location?.line > 0, 'located at the decision');
  assert.equal(workflow.walk.mode, 'quick');
  assert.equal(workflow.walk.stops, 1);
  assert.deepEqual(workflow.walk.hosts, ['Copilot CLI', "VS Code's chat"]);
});

test('on change: workflow edit that adds a stop is refused with it, and one that adds none goes through', async (t) => {
  const root = await repository(t);
  const file = path.join(root, 'singularity/workflow.yml');
  const value = YAML.parse(await readFile(file, 'utf8'));
  value.workTypes.walked = { ...structuredClone(value.workTypes['classic-delivery']), label: 'Walked' };
  await writeFile(file, YAML.stringify(value));
  const { editedWithoutNewProblems } = await import('../src/workflow-validation.mjs');
  const edit = (change) => async () => {
    const next = YAML.parse(await readFile(file, 'utf8'));
    change(next, next.workTypes.walked);
    await writeFile(file, YAML.stringify(next));
    return { governs: 'story' };
  };
  await assert.rejects(editedWithoutNewProblems(root, 'walked', edit(reusedChannel), {}), (error) => {
    assert.equal(error.code, 'WORKFLOW_EDIT_PROBLEMS');
    assert.match(error.message, /"Test again on the web" goes back to Code on values that never change\n {2}Fix: Have Testing record the value each round/u);
    return true;
  });
  assert.equal(YAML.parse(await readFile(file, 'utf8')).workTypes.walked.decisions, undefined, 'the edit was put back');
  const done = await editedWithoutNewProblems(root, 'walked', edit((next, type) => {
    reusedChannel(next, type);
    type.decisions[1].inputs = [{ name: 'channel', values: ['web', 'mobile'] }];
  }), {});
  assert.equal(done.governs, 'story');
});

test('on change: an import of a workflow that would loop is blocked with the stop and its fix, before anyone confirms it', async (t) => {
  const source = await repository(t);
  const file = path.join(source, 'singularity/workflow.yml');
  const value = YAML.parse(await readFile(file, 'utf8'));
  value.workTypes.walked = { ...structuredClone(value.workTypes['classic-delivery']), label: 'Walked' };
  reusedChannel(value, value.workTypes.walked);
  await writeFile(file, YAML.stringify(value));
  spawnSync('git', ['commit', '-qam', 'a workflow that loops'], { cwd: source });
  const bundle = path.join(source, 'walked.workflow.json');
  const exported = run(['workflow', 'export', '--workflow', 'walked', '--out', bundle, '--json'], source);
  assert.equal(exported.status, 0, exported.stdout + exported.stderr);
  const target = await repository(t);
  const planned = run(['workflow', 'import', bundle, '--dry-run', '--json'], target);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.status, 'blocked', JSON.stringify(plan).slice(0, 2000));
  const problem = (plan.problems ?? []).find((entry) => entry.code === QUICK_WALK_CODES.sameRoute);
  assert.ok(problem, JSON.stringify(plan.problems));
  assert.equal(problem.title, '"Test again on the web" goes back to Code on values that never change');
  assert.match(problem.fix, /Have Testing record the value each round/u);
});

test('on change: a Workflow Studio change set that would loop shows the stop and its fix in its preview, and is refused when proposed', async (t) => {
  const root = await repository(t);
  const file = path.join(root, 'singularity/workflow.yml');
  const value = YAML.parse(await readFile(file, 'utf8'));
  value.workTypes.walked = { ...structuredClone(value.workTypes['classic-delivery']), label: 'Walked' };
  reusedChannel(value, value.workTypes.walked);
  const { decisions } = value.workTypes.walked;
  delete value.workTypes.walked.decisions;
  await writeFile(file, YAML.stringify(value));
  spawnSync('git', ['commit', '-qam', 'the walked workflow'], { cwd: root });
  // What Workflow Studio's Save and Propose run on the change set (src/workflow-studio.mjs planStudioChangeSet).
  const { planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const changeSet = { schema: 'sflow-studio-change-set@1', changes: [{ op: 'workflow.update', id: 'walked', decisions }] };
  const preview = await planStudioChangeSet(root, changeSet);
  assert.equal(preview.valid, true, JSON.stringify(preview.problems));
  const warning = preview.warnings.find((entry) => entry.code === 'STUDIO_WORKFLOW_PROBLEM' && entry.problem?.code === QUICK_WALK_CODES.sameRoute);
  assert.ok(warning, JSON.stringify(preview.warnings));
  assert.match(warning.message, /^Approval would refuse walked: "Test again on the web" goes back to Code on values that never change Fix: Have Testing record the value each round/u);
  await assert.rejects(planStudioChangeSet(root, changeSet, { write: true, proposing: true }), (error) => {
    assert.equal(error.code, 'STUDIO_WORKFLOW_PROBLEMS');
    assert.match(error.message, /- walked: "Test again on the web" goes back to Code on values that never change\n {2}Fix: /u);
    return true;
  });
  assert.equal(YAML.parse(await readFile(file, 'utf8')).workTypes.walked.decisions, undefined, 'nothing was written');
});
