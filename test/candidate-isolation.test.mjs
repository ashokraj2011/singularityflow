import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { candidateIsolationNeed, importIsolatedReport, materializeCandidate } from '../src/candidate-isolation.mjs';
import { copyRepositoryDependencies } from '../src/repository-dependencies.mjs';
import { sourceTreeHash } from '../src/state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const W = 'ISO-1';

test('text and MDX alone require isolation even though the candidate tree hash excludes them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-text-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Isolation Tester'); git('config', 'user.email', 'iso@example.test');
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
  for (const name of ['data.txt', 'view.mdx']) await writeFile(path.join(root, name), 'committed');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  const workflow = { workItem: { id: W }, phaseOrder: ['implementation'],
    phases: { implementation: { id: 'implementation', generationPolicy: { task: 'code' } } },
    resolution: { plannedClaims: { mode: 'required' } } };
  const before = await sourceTreeHash(root, {}, workflow);
  for (const name of ['data.txt', 'view.mdx']) await writeFile(path.join(root, name), 'dirty');
  assert.equal(await sourceTreeHash(root, {}, workflow), before);
  assert.deepEqual((await candidateIsolationNeed(root, {}, workflow)).excluded, ['data.txt', 'view.mdx']);
});

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Isolation Tester', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('a candidate worktree holds HEAD and the planned changes, copies dependency folders, and reproduces the bound tree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Isolation Tester'); git('config', 'user.email', 'iso@example.test');
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
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
  assert.equal((await lstat(path.join(candidate.root, 'node_modules'))).isSymbolicLink(), false, 'dependencies do not link back into the dirty checkout');
  assert.equal(await readFile(path.join(root, 'src/config.mjs'), 'utf8'), 'export const factor = 10;\n', 'and it stays in the worktree');

  // A report written in the candidate comes back to where the parser reads it.
  await mkdir(path.join(candidate.root, 'reports'), { recursive: true });
  await writeFile(path.join(candidate.root, 'reports/result.json'), '{"ok":true}\n');
  await importIsolatedReport(candidate.root, root, 'reports/result.json');
  assert.equal(await readFile(path.join(root, 'reports/result.json'), 'utf8'), '{"ok":true}\n');
  await symlink(path.join(root, 'reports'), path.join(candidate.root, 'linked-reports'), 'junction');
  await assert.rejects(importIsolatedReport(candidate.root, root, 'linked-reports/result.json'), error => error.code === 'REPOSITORY_PATH_UNSAFE');
  assert.equal(await readFile(path.join(root, 'reports/result.json'), 'utf8'), '{"ok":true}\n');

  await candidate.dispose();
  assert.equal(run('git', ['worktree', 'list', '--porcelain'], root).stdout.split('\n').filter((line) => line.startsWith('worktree ')).length, 1, 'the candidate worktree is removed');

  // A candidate that cannot reproduce the bound tree is unavailable, and leaves nothing behind.
  const mismatch = await materializeCandidate(root, { included: ['src/value.mjs'], treeHash: async (directory) => directory });
  assert.equal(mismatch.available, false);
  assert.match(mismatch.reason, /does not reproduce/);
  assert.equal(run('git', ['worktree', 'list', '--porcelain'], root).stdout.split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
});

test('workspace dependencies resolve to candidate source, not excluded working-tree edits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Isolation Tester'); git('config', 'user.email', 'iso@example.test');
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
  await mkdir(path.join(root, 'packages/lib'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(root, 'packages/lib/index.js'), 'module.exports = "committed";\n');
  await writeFile(path.join(root, 'probe.cjs'), 'console.log(require("local-lib"));\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  await symlink(path.join(root, 'packages/lib'), path.join(root, 'node_modules/local-lib'), 'junction');
  await writeFile(path.join(root, 'packages/lib/index.js'), 'module.exports = "excluded";\n');
  const candidate = await materializeCandidate(root, { included: [], treeHash: async () => 'bound' });
  assert.equal(candidate.available, true, candidate.reason);
  t.after(() => candidate.dispose());
  assert.equal((await lstat(path.join(candidate.root, 'node_modules/local-lib'))).isSymbolicLink(), true,
    'a Windows junction must be rebound, never copied as a directory of excluded working bytes');
  assert.equal(await realpath(path.join(candidate.root, 'node_modules/local-lib')),
    await realpath(path.join(candidate.root, 'packages/lib')));
  assert.equal(run(process.execPath, ['probe.cjs'], candidate.root).stdout.trim(), 'committed');
  assert.equal(run(process.execPath, ['probe.cjs'], root).stdout.trim(), 'excluded');
  await writeFile(path.join(candidate.root, 'node_modules/local-lib/index.js'), 'module.exports = "candidate";\n');
  assert.match(await readFile(path.join(root, 'packages/lib/index.js'), 'utf8'), /excluded/);
});

// A repository and a linked worktree of it, side by side so nothing resolves from one into the other.
async function dependencyCheckouts(t, ignore = 'node_modules\n.venv\n') {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-deps-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'main');
  const target = path.join(directory, 'checkouts/flight');
  await mkdir(path.join(root, 'packages/lib'), { recursive: true });
  const git = (...args) => run('git', args, root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Isolation Tester'); git('config', 'user.email', 'iso@example.test');
  await writeFile(path.join(root, '.gitignore'), ignore);
  await writeFile(path.join(root, 'packages/lib/index.js'), 'module.exports = "base";\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  await mkdir(path.dirname(target));
  git('worktree', 'add', '-q', '--detach', target, 'HEAD');
  const write = async (relative, contents = 'x\n') => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  return { directory, root, target, write };
}

test('a checkout gets the installed dependencies whole, and nothing that cannot be shared [TCE:REQ-085]', async (t) => {
  const { directory, root, target, write } = await dependencyCheckouts(t);
  await write('node_modules/dep/index.js');
  await write('.venv/pyvenv.cfg');
  await write('services/app/node_modules/nested/index.js');
  const first = await copyRepositoryDependencies(root, target);
  assert.deepEqual(first.copied.sort(), ['node_modules', 'services/app/node_modules']);
  assert.deepEqual(first.refused.map(({ path: folder }) => folder), ['.venv']);
  assert.match(first.refused[0].reason, /Python virtual environments/);
  assert.equal(await readFile(path.join(target, 'node_modules/dep/index.js'), 'utf8'), 'x\n');
  assert.equal(await lstat(path.join(target, '.venv')).catch((error) => error.code), 'ENOENT');
  assert.equal(run('git', ['status', '--porcelain'], target).stdout, '', 'Git sees none of it');
  assert.deepEqual(await readdir(path.join(directory, 'checkouts')), ['flight'], 'nothing is left beside the checkout');
  // One already there stays as it is, so a later step costs only the look.
  await writeFile(path.join(target, 'node_modules/dep/index.js'), 'kept\n');
  assert.deepEqual((await copyRepositoryDependencies(root, target)).copied, []);
  assert.equal(await readFile(path.join(target, 'node_modules/dep/index.js'), 'utf8'), 'kept\n');
});

test('a dependency link outside the repository leaves its whole folder out, and the other folders in [TCE:REQ-085]', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation requires privileges on Windows');
  const { directory, root, target, write } = await dependencyCheckouts(t);
  await write('node_modules/ours/index.js');
  await write('apps/web/node_modules/theirs/index.js');
  await mkdir(path.join(directory, 'elsewhere'));
  await symlink(path.join(directory, 'elsewhere'), path.join(root, 'node_modules/linked'));
  const { copied, refused } = await copyRepositoryDependencies(root, target);
  assert.deepEqual(copied, ['apps/web/node_modules']);
  assert.deepEqual(refused.map(({ path: folder }) => folder), ['node_modules']);
  assert.match(refused[0].reason, /resolves outside the repository/);
  assert.equal(await lstat(path.join(target, 'node_modules')).catch((error) => error.code), 'ENOENT', 'never half copied');
});

test('links bind to the checkout, across folders in any order, and one with nothing behind it is dropped [TCE:REQ-085]', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation requires privileges on Windows');
  const { root, target, write } = await dependencyCheckouts(t);
  // pnpm's shape: a package folder that sorts first links into the root folder's store.
  await write('node_modules/.pnpm/dep@1/node_modules/dep/index.js', 'module.exports = "stored";\n');
  await mkdir(path.join(root, 'apps/web/node_modules'), { recursive: true });
  await symlink('../../../node_modules/.pnpm/dep@1/node_modules/dep', path.join(root, 'apps/web/node_modules/dep'));
  await symlink('../packages/lib', path.join(root, 'node_modules/lib'));
  // Installed from another branch: this checkout's tree has no such package.
  await write('packages/only-on-a-branch/index.js');
  await symlink('../packages/only-on-a-branch', path.join(root, 'node_modules/only-on-a-branch'));
  await symlink('../gone', path.join(root, 'node_modules/dangling'));
  const { copied, refused } = await copyRepositoryDependencies(root, target);
  assert.deepEqual(refused, []);
  assert.deepEqual(copied.sort(), ['apps/web/node_modules', 'node_modules']);
  assert.equal(await realpath(path.join(target, 'apps/web/node_modules/dep')), path.join(target, 'node_modules/.pnpm/dep@1/node_modules/dep'));
  assert.equal(await realpath(path.join(target, 'node_modules/lib')), path.join(target, 'packages/lib'));
  for (const gone of ['only-on-a-branch', 'dangling']) {
    assert.equal(await lstat(path.join(target, 'node_modules', gone)).catch((error) => error.code), 'ENOENT');
  }
});

test('a folder this checkout would commit stays out, and another repository gets nothing [TCE:REQ-085]', async (t) => {
  const { directory, root, target, write } = await dependencyCheckouts(t);
  await write('node_modules/dep/index.js');
  // The Story's tree stopped ignoring it, though the checkout it started from still does.
  await writeFile(path.join(target, '.gitignore'), '');
  const { copied, refused } = await copyRepositoryDependencies(root, target);
  assert.deepEqual(copied, []);
  assert.match(refused[0].reason, /would be committed/);
  assert.equal(await lstat(path.join(target, 'node_modules')).catch((error) => error.code), 'ENOENT');

  const other = path.join(directory, 'other');
  await mkdir(other);
  run('git', ['init', '-q', '-b', 'main'], other);
  await writeFile(path.join(other, '.gitignore'), 'node_modules\n');
  assert.deepEqual(await copyRepositoryDependencies(root, other), { copied: [], refused: [] });
  assert.equal(await lstat(path.join(other, 'node_modules')).catch((error) => error.code), 'ENOENT');
});

test('local verification isolates unrelated edits; publication requires explicit accounting or private preservation [D9]', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-isolation-'));
  const remote = `${root}.git`;
  // Git's detached maintenance can still be writing .git/objects as the test ends (ENOTEMPTY).
  const removed = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
  t.after(() => Promise.all([rm(root, removed), rm(remote, removed)]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Isolation Tester'], root);
  run('git', ['config', 'user.email', 'iso@example.test'], root);
  // Keep exact managed artifact bytes stable in this isolation/approval fixture; the separate
  // publication regression deliberately retains Windows CRLF checkout conversion.
  await write('.gitattributes', '* text=auto eol=lf\n');
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/config.mjs', 'export const factor = 1;\n');
  await write('data.txt', 'committed text');
  await write('component.mdx', 'committed MDX');
  const oldReport = '<testsuite tests="1" failures="0" errors="0"><testcase classname="old" name="old pass"/></testsuite>\n';
  await write('.sflow/results/unit.xml', oldReport);
  const runner = "const {spawnSync}=require('node:child_process'); const r=spawnSync(process.execPath,['--test','--test-reporter=junit','test/value.test.mjs'],{encoding:'utf8'}); process.stdout.write(r.stdout); process.exit(r.status ?? 1);\n";
  await write('test/runner.cjs', runner);
  await write('src/value.mjs', "import { factor } from './config.mjs';\nexport const value = 1 * factor;\n");
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", "test('value', () => assert.equal(value, 1));", ''].join('\n'));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implementation.qualityCommands = [{
    id: 'isolated-tests', kind: 'test', argv: [process.execPath, 'test/runner.cjs', '--test-reporter=junit'],
    workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'junit-xml', path: '.sflow/results/unit.xml', minimumDiscovered: 1 }
  }];
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // The review clone attaches through the state ledger, never a branch scan (5be0d63e).
  config.ledger = { ...(config.ledger ?? {}), enabled: true };
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
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { value } from '../src/value.mjs';", `// @ac:${W}:AC-001`, "test('value', () => assert.equal(value, 2));",
    "test('text input', () => assert.equal(readFileSync('data.txt', 'utf8'), 'committed text'));",
    "test('MDX input', () => assert.equal(readFileSync('component.mdx', 'utf8'), 'committed MDX'));", ''].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module doubles the configured factor.'));
  // Unrelated local work no plan names: run in place, the edited factor would make the test fail.
  const unrelated = 'export const factor = 10; // trying something unrelated\n';
  await write('src/config.mjs', unrelated);
  await write('src/scratch.mjs', "throw new Error('never part of this Story');\n");
  await write('data.txt', 'excluded text');
  await write('component.mdx', 'excluded MDX');

  // A committed passing report in the candidate must not turn a no-op into fresh evidence.
  await write('test/runner.cjs', '// intentionally emit no report\n');
  const stale = run(process.execPath, [CLI, '--no-model', 'tests', 'run', '--work-id', W, '--phase', 'implementation', '--json'], root, { allowFailure: true });
  assert.ok(stale.status !== 0 || JSON.parse(stale.stdout).commands.some(command => command.status !== 'passed'), 'old committed JUnit is not evidence of this no-op');
  assert.equal(await readFile(path.join(root, '.sflow/results/unit.xml'), 'utf8'), oldReport, 'the original report is restored');
  await write('test/runner.cjs', runner);
  const local = JSON.parse(cli('tests', 'run', '--work-id', W, '--phase', 'implementation', '--json').stdout);
  assert.ok(local.commands.every(command => command.status === 'passed'), JSON.stringify(local));
  assert.equal(await readFile(path.join(root, 'src/config.mjs'), 'utf8'), unrelated);
  const refused = run(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place'], root, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /These changed files would be excluded from implementation/);
  const recovery = JSON.parse(cli('recover', W, '--json').stdout);
  const aside = recovery.actions.find(action => action.id === 'set-aside-worktree');
  assert.deepEqual(aside.paths, ['component.mdx', 'data.txt', 'src/config.mjs', 'src/scratch.mjs']);
  const preserved = JSON.parse(cli(...aside.commandGuidance.argv).stdout);
  const checkpoint = JSON.parse(cli('appeal', 'checkpoint-show', preserved.setAside.checkpoint, '--work-id', W, '--phase', 'implementation', '--json').stdout);
  for (const file of aside.paths) assert.ok(JSON.stringify(checkpoint).includes(file), file);
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  // The diagnostic runner edit was restored before publication; it needs no human re-pin.
  const pins = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).testCommandPins;
  assert.deepEqual(pins.map(pin => pin.commandId), ['isolated-tests']);
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.implementation.status, 'approved');
  const receipt = JSON.parse(await readFile(path.join(root, workflow.phases.implementation.deliveryEvidence.receiptPath), 'utf8'));
  assert.deepEqual(receipt.excludedChanges ?? [], []);
  // Only the explicit, hash-confirmed action moved the unrelated edits to their recovery copy.
  assert.equal(await readFile(path.join(root, 'src/config.mjs'), 'utf8'), 'export const factor = 1;\n');
  assert.equal(await readFile(path.join(root, 'data.txt'), 'utf8'), 'committed text');
  assert.equal(await readFile(path.join(root, 'component.mdx'), 'utf8'), 'committed MDX');
  assert.equal(run('git', ['show', 'HEAD:src/config.mjs'], root).stdout, 'export const factor = 1;\n');
  assert.equal(run('git', ['ls-files', '--', 'src/scratch.mjs'], root).stdout.trim(), '');
  assert.equal(run('git', ['worktree', 'list', '--porcelain'], root).stdout.split('\n').filter((line) => line.startsWith('worktree ')).length, 1,
    'every candidate worktree was removed');
});
