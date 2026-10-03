import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { accountedAmendmentPaths, planAmendmentRecord, recordPlanAmendment } from '../src/plan-amendments.mjs';
import { evaluateSpecCoverage, normalizeSpecPolicy } from '../src/specifications.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const W = 'AMEND-1';

const plan = {
  [`${W}:AC-001`]: { expectedPaths: ['src/value.mjs'], tests: ['test/value.test.mjs'], fulfillment: 'modified' },
  [`${W}:AC-002`]: { expectedPaths: [], tests: ['test/regression.test.mjs'], fulfillment: 'test-only' }
};
const story = () => ({ workItem: { id: W }, phaseOrder: ['intake', 'implementation'], resolution: { plannedClaims: { owners: { implementation: 'intake' } } }, phases: { intake: { generation: 1 } } });
const amend = (workflow, changes, overrides = {}) => recordPlanAmendment(workflow, {
  changes, reason: 'The helper was needed to keep the value module small.', actor: 'lead@example.test', authorityGroup: 'engineering-reviewers', at: '2026-10-03T00:00:00.000Z', plan, ...overrides
});

test('a plan amendment adds a location to an existing row or a supporting change of the right class', () => {
  const workflow = story();
  assert.throws(() => amend(workflow, [{ kind: 'add-location', clauseId: `${W}:AC-009`, path: 'src/helper.mjs' }]), /has no row/);
  assert.throws(() => amend(workflow, [{ kind: 'add-location', clauseId: `${W}:AC-002`, path: 'src/helper.mjs' }]), /test-only/);
  assert.throws(() => amend(workflow, [{ kind: 'add-location', clauseId: `${W}:AC-001`, path: 'src/*.mjs' }]), /one exact repository-relative file path/);
  assert.throws(() => amend(workflow, [{ kind: 'add-supporting', path: 'src/helper.mjs', class: 'build-configuration', reason: 'Splits the module.' }]),
    (error) => error.code === 'PLAN_AMENDMENT_SUPPORTING_REFUSED', 'application source can never be a supporting change');
  assert.throws(() => amend(workflow, [{ kind: 'add-supporting', path: 'package.json', class: 'documentation', reason: 'Adds a dependency.' }]),
    /is build-configuration/);
  assert.throws(() => amend(workflow, [{ kind: 'add-location', clauseId: `${W}:AC-001`, path: 'src/helper.mjs' }], { reason: 'short' }),
    (error) => error.code === 'PLAN_AMENDMENT_REASON_REQUIRED');
  assert.equal(workflow.planAmendments, undefined, 'a refused amendment records nothing');

  const first = amend(workflow, [{ kind: 'add-location', clauseId: `${W}:AC-001`, path: 'src/helper.mjs' },
    { kind: 'add-supporting', path: 'package.json', class: 'build-configuration', reason: 'Adds the helper to the package exports.' }]);
  assert.equal(first.id, 'PAM-001');
  const record = planAmendmentRecord(workflow);
  assert.deepEqual(record.accountedPaths[`${W}:AC-001`], ['src/helper.mjs']);
  assert.deepEqual(record.claims, {}, 'an amendment claims nothing new, so no row is judged differently');
  assert.deepEqual(record.supportingFiles, ['package.json']);
  assert.equal(record.amendment, true);
  assert.deepEqual(accountedAmendmentPaths([record]), ['src/helper.mjs']);

  // Coverage counts the amended location as accounted for, and the supporting change as supporting.
  const coverage = evaluateSpecCoverage({
    indexes: [{ clauses: [{ id: `${W}:AC-001`, type: 'AC' }] }],
    planned: [{ phase: 'intake', generation: 1, claims: { [`${W}:AC-001`]: plan[`${W}:AC-001`] } }, record],
    observed: [{ phase: 'implementation', generation: 1, claims: { [`${W}:AC-001`]: { observedPaths: ['src/value.mjs'], testResults: ['test/value.test.mjs'], commits: [], verdict: 'matched' } } }]
  }, ['package.json', 'src/helper.mjs', 'src/value.mjs'], { mode: 'enforce', coverage: 'enforce' });
  assert.deepEqual(coverage.unclaimedChangedPaths, []);
  assert.deepEqual(coverage.supportingChangedPaths, ['package.json']);
});

test('a repository-wide coverage exclusion is refused, so no path escapes accounting', () => {
  assert.throws(() => normalizeSpecPolicy({ excludes: ['vendor'] }), (error) => error.code === 'SPEC_EXCLUDES_RETIRED' && /decision plan/.test(error.message));
  assert.deepEqual(normalizeSpecPolicy({ excludes: [] }).excludes, ['singularity', '.github/agents', '.git', 'node_modules']);
});

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Amendment Tester', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('unplanned code is refused before it is committed, accounted for by a plan amendment, and unrelated prose is kept out', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-plan-amendment-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Amendment Tester'], root);
  run('git', ['config', 'user.email', 'amend@example.test'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', [`// @ac:${W}:AC-001`, "import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", "test('value', () => assert.equal(value, 1));", ''].join('\n'));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Classic delivery with final coverage enforced, so an unplanned path blocks the code approval.
  config.workTypes['classic-delivery'].spec = { ...(config.workTypes['classic-delivery'].spec ?? {}), mode: 'enforce', coverage: 'enforce' };
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
  await write('src/value.mjs', `// @clause:${W}:AC-001 returns the approved value from the helper\nimport { approved } from './helper.mjs';\nexport const value = approved;\n`);
  // A helper the plan did not name.
  await write('src/helper.mjs', 'export const approved = 2;\n');
  await write('test/value.test.mjs', [`// @ac:${W}:AC-001`, "import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", "test('value', () => assert.equal(value, 2));", ''].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module reads the approved value from a small helper.'));
  // A scratch note is prose the plan does not name: left out and kept, never committed [E2G-027].
  await write('NOTES.md', 'Remember to tell the team about the helper.\n');
  // The helper is code the plan does not name, and the tests would run with it: refused before
  // anything is committed, with the governed route to account for it.
  const refused = run(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place'], root, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /GENERATION_EXCLUSIONS_UNSAFE|changed files its plan does not name/);
  assert.match(refused.stdout + refused.stderr, /src\/helper\.mjs/);
  assert.doesNotMatch(refused.stdout + refused.stderr, /: NOTES\.md/, 'prose is not unsafe');

  cli('decision', 'plan', '--add-location', `${W}:AC-001=src/helper.mjs`, '--reason', 'The helper holds the approved value the module returns.');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');
  const generation = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).phases.implementation;
  const receipt = JSON.parse(await readFile(path.join(root, generation.deliveryEvidence.receiptPath), 'utf8'));
  assert.deepEqual(receipt.excludedChanges, ['NOTES.md']);
  assert.equal(run('git', ['ls-files', '--', 'NOTES.md'], root).stdout.trim(), '', 'the note was never committed');
  assert.equal(await readFile(path.join(root, 'NOTES.md'), 'utf8'), 'Remember to tell the team about the helper.\n', 'and it is still in the worktree');
  const workflowState = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflowState.phases.implementation.status, 'approved');
  assert.deepEqual(workflowState.planAmendments.map((entry) => [entry.id, entry.changes]),
    [['PAM-001', [{ kind: 'add-location', clauseId: `${W}:AC-001`, path: 'src/helper.mjs' }]]]);
  assert.equal(workflowState.history.find((entry) => entry.event === 'plan_amended').detail.startsWith('PAM-001: src/helper.mjs added to AMEND-1:AC-001'), true);
});
