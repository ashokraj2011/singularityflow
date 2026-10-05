import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  deriveObservedClaimMap, evaluateSpecCoverage, mergeObservedClaimRecords, normalizeClaimMap
} from '../src/specifications.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const W = 'FULFIL-1';
const ac = (number) => `${W}:AC-00${number}`;

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Fulfillment Tester', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const plan = normalizeClaimMap({ claims: {
  [ac(1)]: { expectedPaths: ['src/value.mjs'], tests: ['test/value.test.mjs'], fulfillment: 'modified' },
  [ac(2)]: { expectedPaths: ['src/guard.mjs'], tests: ['test/guard.test.mjs'], fulfillment: 'existing' },
  [ac(3)]: { expectedPaths: [], tests: ['test/regression.test.mjs'], fulfillment: 'test-only' },
  [ac(4)]: { expectedPaths: ['src/legacy.mjs'], tests: ['test/legacy.test.mjs'], fulfillment: 'removed' },
  [ac(5)]: { expectedPaths: ['docs/usage.md'], tests: ['test/usage.test.mjs'], fulfillment: 'document' }
} }, { kind: 'planned', clauseIds: [1, 2, 3, 4, 5].map(ac) });

test('each fulfillment type is observed by its own evidence, and none needs new product source', () => {
  const delivery = {
    changeSet: { sourcePaths: ['docs/usage.md', 'src/legacy.mjs', 'src/value.mjs'], deletedSourcePaths: ['src/legacy.mjs'] },
    sourcePaths: ['docs/usage.md', 'src/legacy.mjs', 'src/value.mjs'],
    testPaths: ['test/guard.test.mjs', 'test/legacy.test.mjs', 'test/regression.test.mjs', 'test/usage.test.mjs', 'test/value.test.mjs'],
    traceability: { bindings: [] },
    fulfillment: { obligations: [
      { clauseId: ac(2), fulfillment: 'existing', paths: [{ path: 'src/guard.mjs', state: 'present', sha256: 'a'.repeat(64) }] },
      { clauseId: ac(4), fulfillment: 'removed', paths: [{ path: 'src/legacy.mjs', state: 'absent' }] },
      { clauseId: ac(5), fulfillment: 'document', paths: [{ path: 'docs/usage.md', state: 'changed' }] }
    ] }
  };
  const observed = deriveObservedClaimMap(plan, delivery, { clauseIds: [1, 2, 3, 4, 5].map(ac) });
  assert.deepEqual(Object.fromEntries(Object.entries(observed.claims).map(([id, claim]) => [id, [claim.verdict, claim.observedPaths]])), {
    [ac(1)]: ['matched', ['src/value.mjs']],
    [ac(2)]: ['matched', ['src/guard.mjs']],
    [ac(3)]: ['matched', []],
    [ac(4)]: ['matched', ['src/legacy.mjs']],
    [ac(5)]: ['matched', ['docs/usage.md']]
  });
  // Merging keeps each type's own verdict: existing work is implemented without new tests.
  const merged = mergeObservedClaimRecords([{ ...observed, phase: 'implementation', generation: 1 }], plan.claims);
  assert.ok(Object.values(merged).every((claim) => claim.verdict === 'matched'));
  const coverage = evaluateSpecCoverage({
    indexes: [{ clauses: [1, 2, 3, 4, 5].map((number) => ({ id: ac(number), type: 'AC' })) }],
    planned: [{ ...plan, phase: 'intake', generation: 1 }],
    observed: [{ ...observed, phase: 'implementation', generation: 1 }]
  }, ['docs/usage.md', 'src/legacy.mjs', 'src/value.mjs'], { mode: 'enforce', coverage: 'enforce' });
  assert.deepEqual(coverage.unimplemented, []);
  assert.deepEqual(coverage.invalidEvidence ?? [], [], 'test-only and removal evidence are valid');
});

test('a real Story delivers modified, existing, test-only, removed and document work in one code step', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fulfillment-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const write = async (relative, lines) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), Array.isArray(lines) ? lines.join('\n') : lines);
  };
  // The body ends with the test declaration; its tag sits on the line directly above it.
  const testFile = (tag, body) => ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    ...body.slice(0, -1), `// @ac:${tag}`, ...body.slice(-1), ''];
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Fulfillment Tester'], root);
  run('git', ['config', 'user.email', 'fulfil@example.test'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', testFile(ac(1), ["import { value } from '../src/value.mjs';", "test('value', () => assert.equal(value, 1));"]));
  // Behaviour that already exists, with the test that already proves it.
  await write('src/guard.mjs', 'export const guard = (input) => input !== null;\n');
  await write('test/guard.test.mjs', testFile(ac(2), ["import { guard } from '../src/guard.mjs';", "test('guard refuses null', () => assert.equal(guard(null), false));"]));
  await write('src/legacy.mjs', 'export const legacy = true;\n');
  await write('docs/usage.md', '# Usage\n\nCall value().\n');
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the fulfillment fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');

  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Retire the legacy flag',
    '--description', 'Change the value, keep the guard, retire the legacy flag and document usage.');
  const item = path.join(root, 'singularity/work-items', W);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '',
    'Return the value 2, keep refusing null input, retire the legacy flag and document how to call value().', '',
    '## Scope and constraints', '', 'Change only the listed modules, their tests and the usage document.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${ac(1)}] | The exported value equals 2. |`,
    `| [${ac(2)}] | Null input is refused, as it already is. |`,
    `| [${ac(3)}] | A regression test pins the value. |`,
    `| [${ac(4)}] | The legacy flag module no longer exists. |`,
    `| [${ac(5)}] | The usage document explains value(). |`, '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${ac(1)}\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | value() returns 2. |`,
    `| \`${ac(2)}\` | \`src/guard.mjs\` | \`test/guard.test.mjs\` | existing | guard(null) is false. |`,
    `| \`${ac(3)}\` | - | \`test/regression.test.mjs\` | test-only | The regression test passes. |`,
    `| \`${ac(4)}\` | \`src/legacy.mjs\` | \`test/legacy.test.mjs\` | removed | Importing the legacy module fails. |`,
    `| \`${ac(5)}\` | \`docs/usage.md\` | \`test/usage.test.mjs\` | document | The usage page names value(). |`, '',
    '## Initial evidence', '', 'The baseline modules, tests and usage document at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is retiring the legacy flag approved?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');

  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${ac(1)} — returns the approved value 2 instead of 1\nexport const value = 2;\n\n/** The approved value. */\nexport function readValue() {\n  return value;\n}\n`);
  await write('test/value.test.mjs', testFile(ac(1), ["import { value } from '../src/value.mjs';", "test('value', () => assert.equal(value, 2));"]));
  await write('test/regression.test.mjs', testFile(ac(3), ["import { value } from '../src/value.mjs';", "test('value stays 2', () => assert.equal(value, 2));"]));
  await unlink(path.join(root, 'src/legacy.mjs'));
  await write('test/legacy.test.mjs', testFile(ac(4), ["import { existsSync } from 'node:fs';",
    "test('legacy module is gone', () => assert.equal(existsSync(new URL('../src/legacy.mjs', import.meta.url)), false));"]));
  await write('docs/usage.md', '# Usage\n\nCall value() to read the approved value.\n');
  await write('test/usage.test.mjs', testFile(ac(5), ["import { readFileSync } from 'node:fs';",
    "test('usage names value()', () => assert.match(readFileSync(new URL('../docs/usage.md', import.meta.url), 'utf8'), /value\\(\\)/));"]));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu,
    'The value module returns 2, the guard is unchanged, the legacy flag is removed and the usage page names value().'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');

  const workflowState = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(path.join(root, workflowState.phases.implementation.deliveryEvidence.receiptPath), 'utf8'));
  assert.deepEqual(receipt.fulfillment.obligations.map((entry) => [entry.clauseId, entry.fulfillment, entry.paths.map((item) => item.state)]), [
    [ac(2), 'existing', ['present']], [ac(4), 'removed', ['absent']], [ac(5), 'document', ['changed']]
  ]);
  assert.deepEqual(receipt.traceability.sourceRequired.map((entry) => entry.clauseId), [ac(1)],
    'only the modified obligation carries its clause in source');
  // The modified obligation is bound to its exact hunk, the declaration it touches and its explanation.
  const [binding] = receipt.implementationBindings.bindings;
  assert.equal(binding.clauseId, ac(1));
  assert.deepEqual(binding.explanation, { text: 'returns the approved value 2 instead of 1', path: 'src/value.mjs', line: 1 });
  assert.deepEqual(binding.regions.map((region) => [region.path, region.change, region.symbols.map((symbol) => symbol.name), region.symbolAssurance]),
    [['src/value.mjs', 'modified', ['readValue'], 'heuristic']]);
  assert.ok(binding.regions[0].hunks.length > 0, 'hunks are mandatory');
  assert.match(receipt.implementationBindings.bindingsSha256, /^sha256:[0-9a-f]{64}$/);

  const matrix = JSON.parse(cli('evidence', 'matrix', '--json').stdout).data.matrix;
  const implement = Object.fromEntries(matrix.page.rows.map((row) => [row.id,
    row.obligations.find((entry) => entry.responsibility === 'implement')]));
  for (const number of [1, 2, 3, 4, 5]) assert.equal(implement[ac(number)].status, 'met', `${ac(number)} is implemented`);
  assert.deepEqual([2, 3, 4, 5].map((number) => implement[ac(number)].fulfillment), ['existing', 'test-only', 'removed', 'document']);
  // Approving the step accepted its binding, and the matrix shows what was accepted.
  assert.deepEqual([implement[ac(1)].binding.decision, implement[ac(1)].binding.explanation.text], ['accepted', 'returns the approved value 2 instead of 1']);
  const approval = workflowState.phases.implementation.approvals.at(-1);
  assert.deepEqual(approval.implementationBindings.decisions, [{ clauseId: ac(1), decision: 'accepted' }]);
  assert.equal(approval.implementationBindings.bindingsSha256, receipt.implementationBindings.bindingsSha256);
});
