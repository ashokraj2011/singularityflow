/**
 * `workflow walk`: a model-free dry run drives a throwaway Story through every step of a workflow on an
 * isolated copy and reports every stop that is not a person's real decision (src/workflow-walk/).
 *
 * Fast lane: the stub author's filling, the walk's isolation, its registration, its text, and one real
 * walk that stops at Story start (an approval group nobody can approve). Slow lane: every shipped
 * workflow walks with no stop; a team's custom workflow walks clean; configurations that make a step
 * impossible stop there with their cause.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { MACHINE_STATE_LOCATIONS } from '../src/machine-state-locations.mjs';
import { clauseSection, codeChange, draftClauses, fillDocument, hasPlannedClaimsTable, plannedClaimsSection } from '../src/workflow-walk/author.mjs';
import { walkEnvironment } from '../src/workflow-walk/sandbox.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: childTimeout(1_800_000), maxBuffer: 64 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** A repository initialized from the shipped templates, with `edit` applied to its workflow.yml before the commit. */
async function repository(t, { edit = null, files = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-walk-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  run('git', ['init', '-q', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Walk Tester'], root);
  run('git', ['config', 'user.email', 'walk-tester@example.invalid'], root);
  await writeFile(path.join(root, 'README.md'), '# Walk test\n');
  run(process.execPath, [CLI, '--no-model', 'init'], root);
  for (const [relative, text] of Object.entries(files)) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  if (edit) {
    const file = path.join(root, 'singularity/workflow.yml');
    const configuration = YAML.parse(await readFile(file, 'utf8'));
    edit(configuration);
    await writeFile(file, YAML.stringify(configuration));
  }
  run('git', ['add', '-A'], root);
  run('git', ['commit', '-q', '-m', 'Initialize the walk test repository'], root);
  return root;
}

/** `workflow walk` as a person runs it: its exit and its JSON. */
function walkCli(root, args) {
  const result = run(process.execPath, [CLI, '--no-model', 'workflow', 'walk', ...args, '--json'], root, { allowFailure: true });
  let value = null;
  try { value = JSON.parse(result.stdout); } catch { /* reported below */ }
  assert.ok(value, `workflow walk printed no JSON\n${result.stdout.slice(0, 2000)}\n${result.stderr.slice(0, 2000)}`);
  return { status: result.status, value };
}

const stopsOf = (value) => value.workflows.flatMap((workflow) => workflow.stops.map((stop) => `${workflow.id}/${stop.step}: ${stop.code} ${stop.message}`));

// ------------------------------------------------------------------------------------------- fast

test('the stub author fills a template as written: TODOs, choices, table columns, placeholders; comments and code stay', () => {
  const template = [
    '<!-- singularity-flow:metadata', '{"phase":"intake"}', '-->', '', '# WALK-1 — intake', '', '## Problem', '', 'TODO: Describe the defect.', '',
    '<!-- TODO: keep this comment -->', '```', 'TODO: code stays', '```', '',
    '| Clause | Observable outcome |', '|---|---|', '| [WALK-1:AC-001] | TODO: State one outcome. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `WALK-1:AC-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative test paths | new | TODO: what a person sees |', '',
    '| Clause | Evidence | Verdict |', '|---|---|---|', '| `WALK-1:AC-001` | TODO: exact evidence | TODO: matched/partial/missing |', '',
    '### S1 — <the most important situation>', ''
  ].join('\n');
  const filled = fillDocument(template, { clauses: ['WALK-1:AC-001'] });
  assert.doesNotMatch(filled.replace(/<!--[\s\S]*?-->/gu, '').replace(/```[\s\S]*?```/gu, ''), /TODO|<the most/u);
  assert.match(filled, /<!-- TODO: keep this comment -->/u, 'a comment is not the draft');
  assert.match(filled, /```\nTODO: code stays\n```/u, 'a code block is not the draft');
  assert.match(filled, /\| `WALK-1:AC-001` \| `src\/value\.mjs` \| `test\/value\.test\.mjs` \| modified \|/u, "the stub's own plan: the change lands in the value module");
  assert.match(filled, /\| matched \|/u, 'a TODO choice takes its first option');
  assert.match(filled, /^<!-- singularity-flow:metadata\n\{"phase":"intake"\}\n-->/u, 'the metadata header is untouched');
  assert.deepEqual(draftClauses(filled, 'WALK-1'), ['WALK-1:AC-001']);
  assert.ok(hasPlannedClaimsTable(filled));
});

test('what the stub adds only where the platform needs it: anchors, a planned-claims table, tagged code and a passing test', () => {
  assert.deepEqual(draftClauses(clauseSection('WALK-1'), 'WALK-1'), ['WALK-1:REQ-001', 'WALK-1:AC-001']);
  const plan = plannedClaimsSection(['WALK-1:REQ-001']);
  assert.ok(hasPlannedClaimsTable(plan));
  assert.match(plan, /\| `WALK-1:REQ-001` \| `src\/value\.mjs` \| `test\/value\.test\.mjs` \| modified \|/u);
  const change = codeChange(['WALK-1:REQ-001', 'WALK-1:AC-001']);
  assert.match(change['src/value.mjs'], /\/\/ @clause:WALK-1:REQ-001 .*\n\/\/ @clause:WALK-1:AC-001 .*\nexport const value = 2;/u);
  assert.match(change['test/value.test.mjs'], /\/\/ @ac:WALK-1:REQ-001\n\/\/ @ac:WALK-1:AC-001\ntest\(/u);
});

test("a walk's commands run with every machine location, home, Git config and temporary folder inside its own folder", () => {
  const base = path.join(os.tmpdir(), 'sflow-workflow-walk-example');
  const env = walkEnvironment(base, { ...process.env, SINGULARITY_FLOW_ACTIVE_WORKSPACE: '/elsewhere/active.json', GIT_DIR: '/elsewhere/.git',
    SINGULARITY_FLOW_SESSION_ID: 'another', COPILOT_AGENT_SESSION: 'x', NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off',
    JIRA_API_TOKEN: 'secret', GITHUB_TOKEN: 'secret', HTTPS_PROXY: 'http://proxy.invalid' });
  const inside = (value) => typeof value === 'string' && value.startsWith(`${base}${path.sep}`);
  for (const name of Object.keys(MACHINE_STATE_LOCATIONS)) assert.ok(inside(env[name]), `${name}=${env[name]}`);
  for (const name of ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'COPILOT_HOME', 'TMPDIR']) assert.ok(inside(env[name]), `${name}=${env[name]}`);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.SINGULARITY_FLOW_NO_MODEL, '1');
  for (const name of ['GIT_DIR', 'SINGULARITY_FLOW_SESSION_ID', 'COPILOT_AGENT_SESSION', 'NODE_ENV', 'JIRA_API_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY']) {
    assert.equal(env[name], undefined, `${name} is not passed to a walk's commands`);
  }
  assert.equal(env.PATH, process.env.PATH, 'programs are found where the person finds them');
  assert.equal(env.SINGULARITY_FLOW_BUNDLE, 'off', 'the walk runs the same build');
});

test("after-step actions are taken out of the walk's own copy, and listed, so the walk sends nothing", async (t) => {
  const { mkdtemp: makeTemporary } = await import('node:fs/promises');
  const { withoutAfterStepActions } = await import('../src/workflow-walk/sandbox.mjs');
  const folder = await makeTemporary(path.join(os.tmpdir(), 'sflow-walk-actions-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'workflow.yml');
  const action = { id: 'tell-jira', target: 'jira', on: ['approved'], send: 'summary' };
  await writeFile(file, YAML.stringify({ phases: { intake: { label: 'Intake', afterStep: [action] }, verify: { label: 'Verify' } },
    workTypes: { 'quick-fix': { phases: ['intake', 'verify'], phaseOverrides: { verify: { afterStep: [action, { ...action, id: 'hook' }] } } } } }));
  assert.deepEqual(await withoutAfterStepActions(file), [{ where: 'phases.intake', actions: 1 }, { where: 'workTypes.quick-fix.phaseOverrides.verify', actions: 2 }]);
  assert.doesNotMatch(await readFile(file, 'utf8'), /afterStep/u);
  assert.deepEqual(await withoutAfterStepActions(file), [], 'nothing left to take out');
});

test('workflow walk is a read of this repository, never a model call, and is in the help', async () => {
  const { resolveOperation } = await import('../src/command-registry.mjs');
  const operation = resolveOperation({ requestedCommand: 'workflow', positionals: ['workflow', 'walk'], options: {} });
  assert.equal(operation.id, 'workflow.walk');
  assert.equal(operation.classification, 'read');
  assert.equal(operation.modelPolicy, 'never');
  assert.match(await readFile(path.join(ROOT, 'src/help-text.mjs'), 'utf8'), /singularity-flow workflow walk \[WORKFLOW\]/u);
  assert.match(await readFile(path.join(ROOT, 'docs/OPERATION-MODEL-POLICY.md'), 'utf8'), /\| workflow\.walk \| read \| never \|/u);
});

test('the walk text names each step, its person steps, and each stop with its likely cause', async () => {
  const { walkLines } = await import('../src/commands/workflow-walk.mjs');
  const lines = walkLines({ source: { kind: 'shipped' }, counts: { workflows: 1, completed: 0, stopped: 1, notJudged: 0, stops: 1, expectedPersonSteps: 1, expectedReviews: 1 },
    workflows: [{ id: 'team-flow', label: 'Team flow', outcome: 'stopped', seconds: 3, steps: [
      { id: 'fmly-requirements', label: 'Requirements', outcome: 'approved', notes: [], stops: [], notJudged: [],
        people: [{ class: 'expected-review', kind: 'review', ask: 'The reviewer reviews.', where: 'reviewer agent' },
          { class: 'expected-person-step', kind: 'approval', ask: 'Approve the step.', where: 'own terminal' }] },
      { id: 'fmly-testing', label: 'Testing', outcome: 'stopped', notes: [], people: [], notJudged: [],
        stops: [{ class: 'stop', command: 'singularity-flow submit fmly-testing', code: 'SOME_GATE', message: 'It cannot pass.', cause: 'The step asks for what nothing can give.', routes: [] }] }], stops: [] }] });
  const text = lines.join('\n');
  assert.match(text, /Team flow \(team-flow\): stopped/u);
  assert.match(text, /review: The reviewer reviews\. \[reviewer agent\]/u);
  assert.match(text, /person: Approve the step\. \[own terminal\]/u);
  assert.match(text, /STOP SOME_GATE at singularity-flow submit fmly-testing\n +It cannot pass\.\n +Likely cause: The step asks for what nothing can give\./u);
});

test('a walk refuses an unknown option and an unknown workflow, before it builds anything', async (t) => {
  const root = await repository(t);
  const option = run(process.execPath, [CLI, '--no-model', 'workflow', 'walk', '--fast', '--json'], root, { allowFailure: true });
  assert.notEqual(option.status, 0);
  assert.match(option.stdout + option.stderr, /WORKFLOW_WALK_USAGE/u);
  const source = run(process.execPath, [CLI, '--no-model', 'workflow', 'walk', '--source', 'elsewhere', '--json'], root, { allowFailure: true });
  assert.notEqual(source.status, 0);
  assert.match(source.stdout + source.stderr, /WORKFLOW_WALK_USAGE/u, 'a source is this repository or the shipped catalog');
  const unknown = walkCli(root, ['no-such-workflow']);
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.value.error?.code, 'WORKFLOW_WALK_UNKNOWN_WORKFLOW');
});

test('an approval group nobody may approve stops the walk at Story start, with its cause, and leaves the repository as it was', async (t) => {
  const root = await repository(t, { edit: (configuration) => {
    configuration.approvalSecurity = { profile: 'team', allowSelfApproval: false, autoEnrollNewIdentities: false };
  } });
  const head = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { status, value } = walkCli(root, ['quick-fix']);
  assert.equal(status, 1, 'a stop exits 1');
  assert.equal(value.resultType, 'workflow-walk');
  assert.equal(value.ok, false);
  assert.equal(value.modelUsed, false);
  assert.equal(value.source.kind, 'checkout');
  const [workflow] = value.workflows;
  assert.equal(workflow.outcome, 'stopped');
  assert.equal(workflow.stops.length, 1, JSON.stringify(workflow.stops));
  assert.equal(workflow.stops[0].step, 'start');
  assert.equal(workflow.stops[0].code, 'APPROVAL_POLICY_UNATTAINABLE');
  assert.match(workflow.stops[0].cause, /approval group/u);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head, 'the repository it ran from is unchanged');
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '', 'nothing written to the repository it ran from');
});

// ------------------------------------------------------------------------------------------- slow

/**
 * Every shipped Story workflow walks with no stop. Three need an external tool a walk does not have:
 * figma-mobile a Figma MCP design source, poc-workflow a live web application at its start,
 * spec-code-test-loop a Playwright MCP smoke in its testing step. They end not judged, never stopped.
 */
const NEEDS_EXTERNAL_TOOL = new Set(['figma-mobile', 'poc-workflow', 'spec-code-test-loop']);

test('every shipped Story workflow walks to its end with no stop', slowLane({ timeout: 3_600_000, concurrency: 3 }), async (t) => {
  const { walkWorkflows } = await import('../src/workflow-walk/walk.mjs');
  const YAML = (await import('yaml')).default;
  const shipped = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  const ids = Object.keys(shipped.workTypes);
  assert.ok(ids.length >= 18, `the shipped catalog holds ${ids.length} Story workflows`);
  await Promise.all(ids.map((id) => t.test(id, async () => {
    const result = await walkWorkflows(ROOT, { workflow: id, shipped: true, stepSeconds: 600, totalSeconds: 1800 });
    assert.equal(result.source.kind, 'shipped');
    assert.deepEqual(stopsOf(result), [], `${id} stopped`);
    const [workflow] = result.workflows;
    assert.equal(workflow.outcome, NEEDS_EXTERNAL_TOOL.has(id) ? 'not-judged' : 'completed', JSON.stringify(workflow.steps.map((step) => [step.id, step.outcome, step.notJudged])));
    if (!NEEDS_EXTERNAL_TOOL.has(id)) {
      assert.ok(workflow.steps.every((step) => ['approved', 'completed', 'skipped'].includes(step.outcome)), JSON.stringify(workflow.steps.map((step) => [step.id, step.outcome])));
      assert.ok(workflow.steps.some((step) => step.people.some((entry) => entry.kind === 'approval')), `${id} names who approves`);
    }
  })));
});

test("a team's own workflow (custom requirements, code and testing steps) walks clean, naming each step's person steps", slowLane({ timeout: 900_000 }), async (t) => {
  const { FAMILY_FILES, familyWorkflow } = await import('./helpers/family-workflow.mjs');
  const root = await repository(t, { files: FAMILY_FILES, edit: (configuration) => familyWorkflow(configuration) });
  const { status, value } = walkCli(root, ['family-delivery']);
  assert.deepEqual(stopsOf(value), []);
  assert.equal(status, 0);
  assert.equal(value.ok, true);
  const [workflow] = value.workflows;
  assert.equal(workflow.outcome, 'completed');
  assert.deepEqual(workflow.steps.map((step) => [step.id, step.outcome]), [['fmly-requirements', 'approved'], ['fmly-code', 'approved'], ['fmly-testing', 'approved']]);
  const kinds = Object.fromEntries(workflow.steps.map((step) => [step.id, step.people.map((entry) => entry.kind)]));
  assert.ok(kinds['fmly-requirements'].includes('clarification'), 'its clarification is asked of a person');
  assert.ok(kinds['fmly-requirements'].includes('decision'), "the Story's scope statement is a person's decision");
  for (const id of ['fmly-requirements', 'fmly-code', 'fmly-testing']) {
    assert.ok(kinds[id].includes('review'), `${id} is reviewed`);
    assert.ok(kinds[id].includes('approval'), `${id} is approved`);
  }
});

test('a step whose markers block while its clarification is off stops the walk there, with that cause', slowLane({ timeout: 900_000 }), async (t) => {
  const { FAMILY_FILES, familyWorkflow } = await import('./helpers/family-workflow.mjs');
  const root = await repository(t, { files: FAMILY_FILES, edit: (configuration) => familyWorkflow(configuration,
    { requirements: { clarification: { mode: 'off', markers: { mode: 'block' } } } }) });
  const { status, value } = walkCli(root, ['family-delivery']);
  assert.equal(status, 1);
  const [workflow] = value.workflows;
  assert.equal(workflow.outcome, 'stopped');
  assert.equal(workflow.stops.length, 1, JSON.stringify(workflow.stops));
  assert.equal(workflow.stops[0].step, 'fmly-requirements');
  assert.match(workflow.stops[0].message, /unresolved clarification marker/u);
  assert.match(workflow.stops[0].cause, /clarification is off/u);
  assert.deepEqual(workflow.steps.filter((step) => step.outcome === 'not-reached').map((step) => step.id), ['fmly-code', 'fmly-testing']);
});

test('a code step with no test command this machine can run stops the walk at that step, naming the command', slowLane({ timeout: 900_000 }), async (t) => {
  const { FAMILY_FILES, MISSING_TEST_COMMAND, familyWorkflow } = await import('./helpers/family-workflow.mjs');
  const root = await repository(t, { files: FAMILY_FILES, edit: (configuration) => familyWorkflow(configuration, { code: { qualityCommands: MISSING_TEST_COMMAND } }) });
  const { status, value } = walkCli(root, ['family-delivery']);
  assert.equal(status, 1);
  const [workflow] = value.workflows;
  assert.equal(workflow.outcome, 'stopped');
  assert.equal(workflow.stops[0].step, 'fmly-code', JSON.stringify(workflow.stops));
  assert.equal(workflow.stops[0].code, 'CODE_TEST_FAILED');
  assert.match(workflow.stops[0].cause, /test command 'unit' cannot start on this machine/u);
  assert.equal(workflow.steps[0].outcome, 'approved', 'the steps before it walk on');
});
