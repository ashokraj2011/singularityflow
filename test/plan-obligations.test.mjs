import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { derivePlannedClaimMap, mergePlannedClaimRecords, normalizeClaimMap } from '../src/specifications.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'singularity-flow.mjs');
const W = 'PLAN-1';
const ids = [`${W}:REQ-001`, `${W}:AC-001`, `${W}:AC-002`];

const table = (header, rows) => ['## Planned implementation evidence', '', header,
  `|${header.split('|').slice(1, -1).map(() => '---').join('|')}|`, ...rows, ''].join('\n');

test('a three-column plan keeps its original shape and meaning', () => {
  const { claimMap } = derivePlannedClaimMap(table('| Clause | Expected paths | Planned tests |', [
    `| \`${W}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`
  ]), { clauseIds: [ids[0]] });
  assert.deepEqual(Object.keys(claimMap.claims[ids[0]]).sort(), ['deviation', 'expectedPaths', 'testDisposition', 'testReason', 'tests']);
});

test('a plan states how each obligation is fulfilled, where it is delivered and what can be observed', () => {
  const { claimMap } = derivePlannedClaimMap(table('| Clause | Expected paths | Planned tests | Fulfillment | Steps | Observable result |', [
    `| \`${W}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | \`implementation\` | The value reads 2. |`,
    `| \`${W}:AC-001\` | \`src/guard.mjs\` | \`test/guard.test.mjs\` | existing | implementation | Invalid input is refused. |`,
    `| \`${W}:AC-002\` | - | \`test/regression.test.mjs\` | test-only | - | - |`
  ]), { clauseIds: ids });
  assert.deepEqual(claimMap.claims[ids[0]].fulfillment, 'modified');
  assert.deepEqual(claimMap.claims[ids[0]].steps, ['implementation']);
  assert.equal(claimMap.claims[ids[0]].observableResult, 'The value reads 2.');
  assert.equal(claimMap.claims[ids[1]].fulfillment, 'existing');
  assert.deepEqual(claimMap.claims[ids[2]], {
    expectedPaths: [], tests: ['test/regression.test.mjs'], testDisposition: 'applicable', testReason: null, deviation: null, fulfillment: 'test-only'
  });
  // A stored record is checked by the same rules as the table.
  assert.deepEqual(normalizeClaimMap(claimMap, { kind: 'planned', clauseIds: ids }).claims, claimMap.claims);

  const merged = mergePlannedClaimRecords([
    { phase: 'planning', generation: 1, claims: { [ids[0]]: { ...claimMap.claims[ids[0]], steps: ['implementation'] } } },
    { phase: 'planning', generation: 2, claims: { [ids[0]]: { expectedPaths: ['src/value.mjs'], tests: [], steps: ['hardening'], fulfillment: 'modified' } } }
  ]);
  assert.deepEqual(merged[ids[0]].steps, ['hardening', 'implementation'], 'allocations from every map are kept');
});

test('each fulfillment type is checked for what it must name', () => {
  const header = '| Clause | Expected paths | Planned tests | Fulfillment |';
  const refuse = (row, code, pattern) => assert.throws(() => derivePlannedClaimMap(table(header, [row]), { clauseIds: ids }),
    (error) => error.code === code && pattern.test(error.message));
  refuse(`| \`${W}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | rewritten |`, 'SPEC_PLANNED_FULFILLMENT_INVALID', /must be one of new, modified/);
  refuse(`| \`${W}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | test-only |`, 'SPEC_PLANNED_FULFILLMENT_INVALID', /test-only: list its planned tests and no expected product paths/);
  refuse(`| \`${W}:REQ-001\` | - | \`test/value.test.mjs\` | existing |`, 'SPEC_PLANNED_FULFILLMENT_INVALID', /where the behaviour already lives/);
  refuse(`| \`${W}:REQ-001\` | - | \`test/value.test.mjs\` | removed |`, 'SPEC_PLANNED_FULFILLMENT_INVALID', /that are removed/);
  assert.throws(() => derivePlannedClaimMap(table('| Clause | Expected paths | Planned tests | Owner |', [
    `| \`${W}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | me |`
  ]), { clauseIds: ids }), (error) => error.code === 'SPEC_PLANNED_TABLE_INVALID');
  assert.throws(() => derivePlannedClaimMap(table(header, [`| \`${W}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`]), { clauseIds: ids }),
    /must contain exactly 4 columns/);
  assert.throws(() => derivePlannedClaimMap(table('| Clause | Expected paths | Planned tests | Steps |', [
    `| \`${W}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | Implementation Step |`
  ]), { clauseIds: ids }), (error) => error.code === 'SPEC_PLANNED_ALLOCATION_INVALID');
});

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Plan Tester', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('publishing a plan refuses an obligation allocated to a step it does not plan for', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-plan-obligations-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const git = (...args) => run('git', args, root).stdout.trim();
  const sflow = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Plan Tester');
  git('config', 'user.email', 'plan@example.test');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  sflow('init');
  const file = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.worldModel.grounding = 'off';
  definition.approvalSecurity = { profile: 'poc' };
  definition.repositoryReadiness = { ...(definition.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(definition.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(file, YAML.stringify(definition));
  git('add', '.');
  git('commit', '-qm', 'Govern the fixture');
  run('git', ['init', '-q', '--bare', '-b', 'main', remote], root);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');
  sflow('start', W, '--from-branch', 'main', '--work-type', 'spec-code-test-loop', '--title', 'Validate a value',
    '--description', 'Return an approved value with browser-visible proof.');
  const specPath = path.join(root, 'singularity/work-items', W, 'artifacts/specification/spec.md');
  const spec = (steps) => [
    `# ${W} — Specification`, '', '## Agent brief', '', 'The exported value must be 2, with a matching executable test.', '',
    '## Actors', '', 'A user reads the value.', '', '## User scenarios', '', 'Given a ready application, when a user reads the value, then 2 is displayed.', '',
    '## Requirements', '', `- The application returns the value 2. [${W}:REQ-001]`, `- The user sees the value 2. [${W}:AC-001]`, '',
    '## Boundary and non-functional requirements', '', 'Do not expose private data; invalid input is rejected deterministically.', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Steps | Observable result |', '|---|---|---|---|---|---|',
    `| \`${W}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | \`${steps}\` | The value reads 2. |`,
    `| \`${W}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | \`implementation\` | The page shows 2. |`, '',
    '## Evidence and assumptions', '', 'The pinned repository is the implementation source.', '', '## Out of scope', '', 'No unrelated application changes.'
  ].join('\n');
  await writeFile(specPath, spec('hardening'));
  sflow('artifact', 'scan', '--phase', 'specification');
  const refused = run(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place'], root, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /allocates obligations to steps it does not plan for: PLAN-1:REQ-001 to hardening/);

  await writeFile(specPath, spec('implementation'));
  sflow('artifact', 'scan', '--phase', 'specification');
  sflow('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  const workflowState = JSON.parse(await readFile(path.join(root, 'singularity/work-items', W, 'workflow.json'), 'utf8'));
  const plan = JSON.parse(await readFile(path.join(root, workflowState.phases.specification.claimMaps.planned.path), 'utf8'));
  assert.deepEqual(plan.claims[`${W}:REQ-001`], {
    expectedPaths: ['src/value.mjs'], tests: ['test/value.test.mjs'], testDisposition: 'applicable', testReason: null, deviation: null,
    fulfillment: 'modified', steps: ['implementation'], observableResult: 'The value reads 2.'
  });
});
