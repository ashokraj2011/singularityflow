import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// An approved intent amendment reset the steps after the scope but kept the decision values a step
// had recorded, so the new round was routed on the old answers (L3, 2026-10-28).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const W = 'AMEND-DECIDE-1';
const AC = `${W}:AC-001`;
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Amendment Tester', SINGULARITY_FLOW_NO_MODEL: '1' };

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: ENV });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('an approved intent amendment clears the decision values the reset step recorded', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-amend-decision-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  const state = async () => JSON.parse(await readFile(path.join(root, 'singularity/work-items', W, 'workflow.json'), 'utf8'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Amendment Tester'], root);
  run('git', ['config', 'user.email', 'amend@example.test'], root);
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
  // The code step feeds a decision: its submission records whether the work is ready.
  config.workTypes['classic-delivery'].decisions = [{
    id: 'ready-check', after: 'implementation', kind: 'branch', label: 'Is the change ready to test?',
    inputs: [{ name: 'ready', values: ['yes', 'no'] }],
    routes: [{ id: 'ready', label: 'Ready', when: { ready: ['yes'] }, to: 'next' }, { id: 'anyway', label: 'Test anyway', to: 'next' }]
  }];
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the amendment fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');

  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.');
  const item = path.join(root, 'singularity/work-items', W);
  const intake = (outcome) => [
    `# ${W} — intake`, '', '## Request and outcome', '', `${outcome}`, '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | ${outcome} |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${AC}\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n');
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), intake('The exported value equals 2.'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');

  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value, 2));", ''].join('\n'));
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value.'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation', '--decision', 'ready=yes');
  assert.deepEqual((await state()).phases.implementation.decisionInputs?.values, { ready: 'yes' });

  // The scope changes while the code step waits for approval.
  const amended = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-amend-candidate-')), 'intake.md');
  t.after(() => rm(path.dirname(amended), { recursive: true, force: true }));
  await writeFile(amended, intake('The exported value equals 2 and stays a number.'));
  cli('story', 'intent-amendment', 'propose', '--file', amended, '--reason', 'The reviewer asked that the value stay a number.', '--json');
  cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001', '--json');
  const after = await state();
  assert.equal(after.currentPhase, 'implementation');
  assert.equal(after.phases.implementation.decisionInputs?.values, undefined, 'the old answer is not carried into the new round');
  assert.equal(after.completion?.evaluatedAt ?? null, null);

  // The new round asks again instead of reusing ready=yes.
  cli('story', 'intent-amendment', 'acknowledge', 'AMD-001');
  cli('prepare', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  const unanswered = attempt('submit', 'implementation');
  assert.notEqual(unanswered.status, 0);
  assert.match(unanswered.stdout + unanswered.stderr, /--decision ready=<yes\|no>/u);
});
