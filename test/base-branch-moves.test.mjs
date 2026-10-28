/**
 * The base branch moving, and work after a Story closes (unhappy-path audit, 2026-10-28).
 *
 * Main changing SFlow's configuration and being merged into a Story branch refused the Story's end
 * as configuration drift, with routes that would undo main's own change. Commits after a Story
 * closed shipped in its pull request under the old evidence.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Base Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'chore', agent: 'developer' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: childTimeout(180_000) });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);
const git = (cwd, ...args) => execute('git', args, cwd).stdout.trim();

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-base-moves-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(`${root}.git`, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Base Tester');
  git(root, 'config', 'user.email', 'base.tester@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Ledger\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.approvalSecurity = { profile: 'poc' };
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...config.repositoryReadiness, requiredBeforeStory: false };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
  git(root, 'init', '-q', '--bare', '-b', 'main', `${root}.git`);
  git(root, 'remote', 'add', 'origin', `${root}.git`);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return root;
}

async function complete(root, workId, phaseId) {
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'workflow.json'), 'utf8'));
  const file = path.join(root, 'singularity/work-items', workId, workflow.phases[phaseId].requiredArtifact.path);
  const text = (await readFile(file, 'utf8'))
    .replace(/^\| `([^`]+:AC-\d{3})` \|.*$/gmu, '| `$1` | The ledger outcome holds | `README.md` | Checked by inspection in verification | matched | none |')
    .replace(/^TODO: Map each qualified acceptance[^\n]*$/mu, `${workId}:AC-001 holds: README.md was inspected. Not applicable: a documentation outcome carries no test tags.`)
    .replace(/TODO:[^\n]*/g, 'Checked the ledger outcome with complete operational detail and exact references.')
    .replace(/\bTODO\b/g, 'checked');
  await writeFile(file, text);
}

async function stepThrough(root, workId, phaseId) {
  if (phaseId !== 'intake') flow(root, ['prepare', phaseId]);
  await complete(root, workId, phaseId);
  flow(root, ['phase', 'publish', phaseId]);
  flow(root, ['submit']);
  return flow(root, ['approve', '--yes'], { allowFailure: true });
}

/** main changes SFlow's own configuration (in a checkout of its own), and the Story branch merges main in. */
async function mainChangesConfiguration(root, workId) {
  const other = `${root}-main`;
  git(root, 'worktree', 'add', '-q', other, 'main');
  const configPath = path.join(other, 'singularity/workflow.yml');
  await writeFile(configPath, `${await readFile(configPath, 'utf8')}# Reviewed on main after the Story started.\n`);
  git(other, 'commit', '-q', '-am', 'main changes the workflow configuration');
  git(other, 'push', '-q', 'origin', 'main');
  git(root, 'worktree', 'remove', '--force', other);
  git(root, 'fetch', '-q', 'origin');
  git(root, 'merge', '-q', '--no-edit', 'origin/main');
  git(root, 'push', '-q', 'origin', workId);
}

test('a Story that merged main, whose own configuration changed, still ends on its pinned configuration', slowLane({ timeout: 600_000 }), async (t) => {
  const root = await repository(t);
  const workId = 'BASE-1';
  flow(root, ['start', workId, '--from-branch', 'main', '--title', 'Tidy the ledger', '--description', 'Maintenance only.']);
  assert.equal((await stepThrough(root, workId, 'intake')).status, 0);
  await mainChangesConfiguration(root, workId);
  for (const phaseId of ['implementation', 'verification']) {
    const approved = await stepThrough(root, workId, phaseId);
    assert.equal(approved.status, 0, `${phaseId}\n${approved.stdout}\n${approved.stderr}`);
  }
  const last = await stepThrough(root, workId, 'conformance');
  assert.doesNotMatch(last.stdout + last.stderr, /differs from the immutable work-item configuration snapshot|protected process path changed/u);
  assert.equal(last.status, 0, `${last.stdout}\n${last.stderr}`);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'workflow.json'), 'utf8'));
  assert.equal(workflow.status, 'closed');

  // An edit of the configuration on the Story branch itself is still refused.
  const gate = flow(root, ['gate', '--json'], { allowFailure: true });
  assert.doesNotMatch(gate.stdout, /snapshot-drift/u);
  await writeFile(path.join(root, 'singularity/workflow.yml'), `${await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8')}# Edited on the Story branch.\n`);
  git(root, 'commit', '-q', '-am', 'edit the configuration on the Story branch');
  const edited = flow(root, ['gate', '--json'], { allowFailure: true });
  assert.match(edited.stdout, /snapshot-drift/u);
});

/** A classic-delivery Story whose approved intake plans src/value.mjs and its test for one criterion. */
async function classicStory(t, W, { approveIntake = true } = {}) {
  const root = await repository(t);
  const AC = `${W}:AC-001`;
  const write = async (relative, contents) => writeFile(path.join(root, relative), contents);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.workTypes['classic-delivery'].spec = { ...(config.workTypes['classic-delivery'].spec ?? {}), mode: 'enforce', coverage: 'enforce' };
  await writeFile(configPath, YAML.stringify(config));
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  execute('mkdir', ['-p', 'src', 'test'], root);
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value, 1));", ''].join('\n'));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'value module');
  git(root, 'push', '-q', 'origin', 'main');
  const readiness = JSON.parse(flow(root, ['precheck', '--run', '--scope', 'dependency-test', '--json']).stdout).data.plan;
  flow(root, ['precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json']);
  flow(root, ['start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.']);
  const item = path.join(root, 'singularity/work-items', W);
  flow(root, ['prepare', 'intake']);
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '', 'Return the approved value 2 to every caller.', '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${AC}\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n'));
  flow(root, ['wm', 'compose', '--phase', 'intake']);
  flow(root, ['clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.']);
  flow(root, ['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place']);
  if (approveIntake) {
    flow(root, ['submit', 'intake']);
    flow(root, ['approve', 'intake', '--yes']);
  }
  return { root, item, AC, write };
}

test('a code step that merged main mid-step publishes; main\'s own protected change is not the generation\'s', slowLane({ timeout: 600_000 }), async (t) => {
  const W = 'BASE-2';
  const { root, item, AC, write } = await classicStory(t, W);
  flow(root, ['prepare', 'implementation']);
  await mainChangesConfiguration(root, W);
  await write('src/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value, 2));", ''].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value.'));
  const published = flow(root, ['phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place'], { allowFailure: true });
  assert.doesNotMatch(published.stdout + published.stderr, /protected process paths/u, 'main\'s own configuration change is not this generation\'s');
});

test('a pull request carrying a commit made after the Story closed is blocked with the reopen route; a merge from main is not', slowLane({ timeout: 600_000 }), async (t) => {
  const root = await repository(t);
  const workId = 'BASE-3';
  flow(root, ['start', workId, '--from-branch', 'main', '--title', 'Tidy the ledger', '--description', 'Maintenance only.']);
  for (const phaseId of ['intake', 'implementation', 'verification', 'conformance']) {
    const approved = await stepThrough(root, workId, phaseId);
    assert.equal(approved.status, 0, `${phaseId}\n${approved.stdout}\n${approved.stderr}`);
  }
  // The preview prints its plan, then says it is a preview.
  const plan = () => { const out = flow(root, ['pr', '--json']).stdout; return JSON.parse(out.slice(0, out.lastIndexOf('}') + 1)); };
  assert.deepEqual(plan().blockedBy, [], 'a closed Story with nothing after it is ready');

  // main moves on and is merged in: the pull request adds nothing main lacks, so it stays ready.
  const other = `${root}-main`;
  git(root, 'worktree', 'add', '-q', other, 'main');
  await writeFile(path.join(other, 'NOTES.md'), 'main moved on\n');
  git(other, 'add', 'NOTES.md');
  git(other, 'commit', '-q', '-m', 'main moves on');
  git(other, 'push', '-q', 'origin', 'main');
  git(root, 'worktree', 'remove', '--force', other);
  git(root, 'fetch', '-q', 'origin');
  git(root, 'merge', '-q', '--no-edit', 'origin/main');
  assert.deepEqual(plan().blockedBy, []);

  // A hotfix on the closed Story's branch ships under evidence that never saw it.
  await writeFile(path.join(root, 'README.md'), '# Ledger\n\nA late hotfix.\n');
  git(root, 'commit', '-q', '-am', 'late hotfix');
  const blocked = plan().blockedBy;
  assert.equal(blocked.length, 1, blocked.join('\n'));
  assert.match(blocked[0], /changes README\.md after BASE-3 closed/u);
  assert.match(blocked[0], /singularity-flow reopen BASE-3 --to \S+ --reason/u);
  const create = flow(root, ['pr', '--create', '--yes'], { allowFailure: true });
  assert.notEqual(create.status, 0);
  assert.match(create.stdout + create.stderr, /cannot open a pull request yet/u);
});

test('code committed during an artifact-only step before any code step is taken out and brought back by the route named', slowLane({ timeout: 600_000 }), async (t) => {
  const W = 'BASE-4';
  const { root, write } = await classicStory(t, W, { approveIntake: false });
  await write('src/value.mjs', 'export const value = 2;\n');
  git(root, 'commit', '-q', '-am', 'an early code change');
  const refused = flow(root, ['submit', 'intake', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'PHASE_SOURCE_CHANGED_AFTER_PUBLICATION', refused.stdout);
  assert.match(error.message, /No earlier code step owns them; implementation will deliver them/u);
  const revert = error.message.match(/git revert --no-edit ([0-9a-f ]+?) now/u);
  assert.ok(revert, error.message);
  git(root, 'revert', '--no-edit', ...revert[1].trim().split(' '));
  flow(root, ['submit', 'intake']);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', W, 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.intake.status, 'awaiting_approval', 'the unchanged intake generation is submitted');
});

test('approved code evidence stale only because main was merged in names the merge as the cause', slowLane({ timeout: 600_000 }), async (t) => {
  const W = 'BASE-5';
  const { root, item, AC, write } = await classicStory(t, W);
  flow(root, ['prepare', 'implementation']);
  await write('src/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value, 2));", ''].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value.'));
  flow(root, ['phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place']);
  flow(root, ['submit', 'implementation']);
  flow(root, ['approve', 'implementation', '--yes']);

  // main changes product code, and the Story branch merges it in.
  const other = `${root}-main`;
  git(root, 'worktree', 'add', '-q', other, 'main');
  await writeFile(path.join(other, 'src/other.mjs'), 'export const other = true;\n');
  git(other, 'add', 'src/other.mjs');
  git(other, 'commit', '-q', '-m', 'main adds a module');
  git(other, 'push', '-q', 'origin', 'main');
  git(root, 'worktree', 'remove', '--force', other);
  git(root, 'fetch', '-q', 'origin');
  git(root, 'merge', '-q', '--no-edit', 'origin/main');

  flow(root, ['prepare', 'testing']);
  const testing = path.join(item, 'artifacts/testing/test-evidence.md');
  await writeFile(testing, (await readFile(testing, 'utf8')).replace(/TODO:[^\n]*/gu, 'The approved tests pass for the exported value.'));
  const steps = [];
  for (const args of [['phase', 'publish', 'testing', '--authored', 'human', '--channel', 'manual-in-place'], ['submit', 'testing'], ['approve', 'testing', '--yes']]) {
    const result = flow(root, args, { allowFailure: true });
    steps.push(result.stdout + result.stderr);
    if (result.status !== 0) break;
  }
  const text = steps.join('\n');
  assert.match(text, /src\/other\.mjs came from main through a merge after implementation was approved, not from this Story/u, text.slice(0, 3000));
  assert.match(text, /singularity-flow reject testing --to implementation --repair/u, 'the legal return is still named');
});
