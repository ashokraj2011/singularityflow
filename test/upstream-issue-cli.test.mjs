import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Issue Tester', SINGULARITY_FLOW_NO_MODEL: '1' };

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: ENV });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** A classic-delivery Story with an approved intake plan and implementation drafted. */
async function drafted(t, W) {
  const AC = `${W}:AC-001`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-upstream-issue-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Issue Tester'], root);
  run('git', ['config', 'user.email', 'issue@example.test'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value, 1));", ''].join('\n'));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.workTypes['classic-delivery'].spec = { ...(config.workTypes['classic-delivery'].spec ?? {}), mode: 'enforce', coverage: 'enforce' };
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the upstream issue fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.');
  const item = path.join(root, 'singularity/work-items', W);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '', 'Return the approved value 2 to every caller.', '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${AC}\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value, 2));", ''].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value.'));
  const state = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  return { root, cli, attempt, state, AC };
}

const PROBLEM = 'The intake never says whether callers may cache the value.';

test('an issue raised mid-step is returned to its owners without the step being submitted, and the draft survives', async (t) => {
  const { root, cli, attempt, state } = await drafted(t, 'ISSUE-1');
  const raised = JSON.parse(cli('upstream-issue', 'raise', '--phase', 'intake', '--about', 'Scope and constraints',
    '--problem', PROBLEM, '--assumption', 'Callers do not cache.', '--json').stdout);
  assert.equal(raised.data.issues[0].id, 'UPI-001');
  assert.equal((await state()).phases.implementation.status, 'in_progress', 'raising never stops the current step');
  const later = attempt('upstream-issue', 'raise', '--phase', 'implementation', '--about', 'x', '--problem', PROBLEM);
  assert.notEqual(later.status, 0);
  assert.match(later.stdout + later.stderr, /earlier step/u);
  assert.match(cli('status').stdout, /Open upstream issues: UPI-001 \(intake\)/u);
  assert.deepEqual(JSON.parse(cli('upstream-issue', 'list', '--open', '--json').stdout).data.issues.map((issue) => issue.status), ['open']);

  const returned = attempt('upstream-issue', 'decide', 'UPI-001', '--outcome', 'return', '--reason', 'Intake must state the caching rule first.');
  assert.equal(returned.status, 0, returned.stdout + returned.stderr);
  const after = await state();
  assert.equal(after.currentPhase, 'intake');
  assert.equal(after.phases.intake.status, 'in_progress');
  assert.equal(after.phases.implementation.status, 'not_started');
  const request = after.changeRequests.at(-1);
  assert.equal(request.upstreamIssue, 'UPI-001');
  assert.equal(request.targetPhase, 'intake');
  assert.deepEqual(after.upstreamIssueDecisions.map((entry) => [entry.issue, entry.outcome, entry.link]), [['UPI-001', 'return', request.id]]);
  assert.equal(run('git', ['status', '--porcelain', '--', 'src/value.mjs'], root).stdout.trim(), 'M src/value.mjs', 'the draft code is kept');
  assert.deepEqual(JSON.parse(cli('upstream-issue', 'list', '--open', '--json').stdout).data.issues, []);
});

test('an issue raised while a step is in review leaves its approval valid', async (t) => {
  const { cli, attempt, state } = await drafted(t, 'ISSUE-2');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  // The raise is one appended decision commit between the submission and the approval.
  cli('upstream-issue', 'raise', '--phase', 'intake', '--about', 'Scope and constraints', '--problem', PROBLEM);
  const approved = attempt('approve', 'implementation', '--yes');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  const after = await state();
  assert.equal(after.phases.implementation.status, 'approved');
  assert.deepEqual(after.upstreamIssues.map((issue) => [issue.id, issue.raisedIn.status]), [['UPI-001', 'awaiting_approval']]);
});

test('a Story completes only once its open upstream issue is decided', async (t) => {
  const W = 'ISSUE-3';
  const AC = `${W}:AC-001`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-upstream-complete-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true }), rm(`${root}-story.yml`, { force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  const source = (greeting, tagged) => `${tagged ? `// @clause:${AC} returns the greeting\n` : ''}export const greeting = ${JSON.stringify(greeting)};\n`;
  const check = (expected, tagged) => ["import assert from 'node:assert/strict';", "import test from 'node:test';",
    "import { greeting } from '../greeting.mjs';", ...(tagged ? [`/** @ac:${AC} */`] : []),
    `test('greeting', () => assert.equal(greeting, ${JSON.stringify(expected)}));`, ''].join('\n');
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Issue Tester'], root);
  run('git', ['config', 'user.email', 'issue@example.test'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('greeting.mjs', source('Hello, world.', false));
  await write('tests/greeting.test.mjs', check('Hello, world.', false));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the completion fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  await writeFile(`${root}-story.yml`, YAML.stringify({ title: 'Correct the greeting', description: 'Name the product in the greeting.',
    desiredOutcome: 'The greeting names the product.', acceptanceCriteria: ['The greeting says Hello, Singularity Flow!'],
    risk: 'low', repositoryCount: 1 }));
  cli('start', W, '--from-branch', 'main', '--story-file', `${root}-story.yml`, '--work-type', 'quick-fix', '--agent', 'developer');
  cli('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items', W, 'artifacts/intake/intake.md'), [
    `# ${W} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The greeting says Hello, world. and should name the product.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | The greeting says Hello, Singularity Flow! |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${AC}\` | \`greeting.mjs\` | \`tests/greeting.test.mjs\` |`, '',
    '## Out of scope', '', 'Nothing but the greeting and its test changes.', ''].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  cli('prepare', 'implement');
  await write('greeting.mjs', source('Hello, Singularity Flow!', true));
  await write('tests/greeting.test.mjs', check('Hello, Singularity Flow!', true));
  cli('phase', 'publish', 'implement', '--authored', 'deterministic');
  cli('submit', 'implement');
  cli('upstream-issue', 'raise', '--phase', 'intake', '--about', 'Out of scope', '--problem', 'The intake does not say whether other locales change too.');
  cli('prepare', 'verify');
  cli('phase', 'publish', 'verify', '--authored', 'deterministic');
  const refused = attempt('submit', 'verify');
  assert.notEqual(refused.status, 0, 'the policy-approved ending waits for the open issue');
  assert.match(refused.stdout + refused.stderr, /UPI-001 about intake \(Out of scope\) is not decided/u);
  assert.match(refused.stdout + refused.stderr, /upstream-issue decide UPI-001 --work-id ISSUE-3/u);
  const state = async () => JSON.parse(await readFile(path.join(root, 'singularity/work-items', W, 'workflow.json'), 'utf8'));
  assert.equal((await state()).status, 'in_progress', 'nothing was recorded');
  const dismissal = attempt('upstream-issue', 'decide', 'UPI-001', '--outcome', 'dismiss', '--reason', 'Only the default locale ships in this release.');
  assert.equal(dismissal.status, 0, dismissal.stdout + dismissal.stderr);
  const finished = attempt('submit', 'verify');
  assert.equal(finished.status, 0, finished.stdout + finished.stderr);
  const done = await state();
  assert.equal(done.status, 'closed');
  assert.deepEqual(done.history.filter((entry) => entry.event.startsWith('upstream_issue_')).map((entry) => entry.event),
    ['upstream_issue_raised', 'upstream_issue_decided']);
});
