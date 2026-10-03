import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { importIsolatedReport, materializeCandidate } from '../src/candidate-isolation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const W = 'ISO-1';

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Isolation Tester', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('a candidate worktree holds HEAD and the planned changes, links dependency folders, and reproduces the bound tree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Isolation Tester'); git('config', 'user.email', 'iso@example.test');
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'node_modules/dep'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'src/config.mjs'), 'export const factor = 1;\n');
  await writeFile(path.join(root, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  // A planned change, a new planned file, and an unrelated edit that stays behind.
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 2;\n');
  await writeFile(path.join(root, 'src/added.mjs'), 'export const added = true;\n');
  await writeFile(path.join(root, 'src/config.mjs'), 'export const factor = 10;\n');
  // The bound tree is everything but the unrelated edit; a stand-in hash makes that explicit.
  const treeHash = async (directory) => JSON.stringify(await Promise.all(['src/value.mjs', 'src/added.mjs'].map((file) => readFile(path.join(directory, file), 'utf8'))));
  const candidate = await materializeCandidate(root, { included: ['src/value.mjs', 'src/added.mjs'], treeHash });
  t.after(() => candidate.dispose?.());
  assert.equal(candidate.available, true, candidate.reason);
  assert.equal(await readFile(path.join(candidate.root, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n');
  assert.equal(await readFile(path.join(candidate.root, 'src/config.mjs'), 'utf8'), 'export const factor = 1;\n', 'the unrelated edit is not in the candidate');
  assert.equal((await lstat(path.join(candidate.root, 'node_modules'))).isSymbolicLink(), true, 'dependencies are linked, not copied');
  assert.equal(await readFile(path.join(root, 'src/config.mjs'), 'utf8'), 'export const factor = 10;\n', 'and it stays in the worktree');

  // A report written in the candidate comes back to where the parser reads it.
  await mkdir(path.join(candidate.root, 'reports'), { recursive: true });
  await writeFile(path.join(candidate.root, 'reports/result.json'), '{"ok":true}\n');
  await importIsolatedReport(candidate.root, root, 'reports/result.json');
  assert.equal(await readFile(path.join(root, 'reports/result.json'), 'utf8'), '{"ok":true}\n');

  await candidate.dispose();
  assert.equal(run('git', ['worktree', 'list', '--porcelain'], root).stdout.split('\n').filter((line) => line.startsWith('worktree ')).length, 1, 'the candidate worktree is removed');

  // A candidate that cannot reproduce the bound tree is unavailable, and leaves nothing behind.
  const mismatch = await materializeCandidate(root, { included: ['src/value.mjs'], treeHash: async (directory) => directory });
  assert.equal(mismatch.available, false);
  assert.match(mismatch.reason, /does not reproduce/);
  assert.equal(run('git', ['worktree', 'list', '--porcelain'], root).stdout.split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
});

test('an unrelated local edit that would break the tests stays in the worktree while the candidate is verified, published and approved [D9]', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-isolation-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Isolation Tester'], root);
  run('git', ['config', 'user.email', 'iso@example.test'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/config.mjs', 'export const factor = 1;\n');
  await write('src/value.mjs', "import { factor } from './config.mjs';\nexport const value = 1 * factor;\n");
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", "test('value', () => assert.equal(value, 1));", ''].join('\n'));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the isolation fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');

  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Double the value', '--description', 'Return 2.');
  const item = path.join(root, 'singularity/work-items', W);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '', 'Return the approved value 2 to every caller.', '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${W}:AC-001] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${W}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');

  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${W}:AC-001 doubles the configured factor\nimport { factor } from './config.mjs';\nexport const value = 2 * factor;\n`);
  await write('test/value.test.mjs', [`// @ac:${W}:AC-001`, "import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", "test('value', () => assert.equal(value, 2));", ''].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module doubles the configured factor.'));
  // Unrelated local work no plan names: run in place, the edited factor would make the test fail.
  const unrelated = 'export const factor = 10; // trying something unrelated\n';
  await write('src/config.mjs', unrelated);
  await write('src/scratch.mjs', "throw new Error('never part of this Story');\n");

  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.implementation.status, 'approved');
  const receipt = JSON.parse(await readFile(path.join(root, workflow.phases.implementation.deliveryEvidence.receiptPath), 'utf8'));
  assert.deepEqual(receipt.excludedChanges, ['src/config.mjs', 'src/scratch.mjs']);
  assert.ok(workflow.phases.implementation.checks.some((check) => check.executionIsolation === 'candidate-worktree'
    && check.excludedFromRun.includes('src/config.mjs')), 'submission ran its checks on the candidate');
  // Nothing was cleaned, stashed, reset or committed: the unrelated work is exactly as it was.
  assert.equal(await readFile(path.join(root, 'src/config.mjs'), 'utf8'), unrelated);
  assert.equal(run('git', ['show', 'HEAD:src/config.mjs'], root).stdout, 'export const factor = 1;\n');
  assert.equal(run('git', ['ls-files', '--', 'src/scratch.mjs'], root).stdout.trim(), '');
  assert.equal(run('git', ['worktree', 'list', '--porcelain'], root).stdout.split('\n').filter((line) => line.startsWith('worktree ')).length, 1,
    'every candidate worktree was removed');
});
