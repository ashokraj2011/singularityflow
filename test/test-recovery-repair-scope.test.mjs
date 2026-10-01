import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { assertTrpRepairCohortRetained, inspectTrpRepairScope } from '../src/test-recovery-repair-scope.mjs';
import { trpDigest } from '../src/test-recovery-policy.mjs';

const BASE = 'a'.repeat(40), REPAIR = 'b'.repeat(40);
const entry = (name, status = 'modified', extra = {}) => ({ status,
  oldPath: status === 'added' ? null : name, newPath: status === 'deleted' ? null : name,
  oldMode: status === 'added' ? '000000' : '100644', newMode: status === 'deleted' ? '000000' : '100644',
  oldObject: status === 'added' ? null : 'c'.repeat(40), newObject: status === 'deleted' ? null : 'd'.repeat(40), ...extra });
function inspect(entries, options = {}) {
  return inspectTrpRepairScope('/repository', { workRoot: '/repository/singularity/work-items/story-1', workflow: {},
    baseCommit: BASE, repairCommit: REPAIR, changeSet: { entries, digest: trpDigest(entries) }, ...options });
}

test('bounded repair allows docs/new tests but rejects product changes, test weakening, removal and rename', () => {
  const allowed = inspect([entry('README.md'), entry('test/new.test.mjs', 'added'), entry('singularity/work-items/story-1/workflow.json')]);
  assert.equal(allowed.blockers.length, 0);
  assert.equal(allowed.testSourceRetention, 'existing-sources-byte-identical');
  for (const changed of [entry('src/product.mjs'), entry('test/existing.test.mjs'), entry('test/existing.test.mjs', 'deleted'),
    entry('test/existing.test.mjs', 'renamed', { newPath: 'test/new.test.mjs' }),
    entry('tests/fixture.json'), entry('jest.config.js'), entry('src/new.test.mjs', 'added', { newMode: '120000' })]) {
    assert.equal(inspect([changed]).status, 'scope-review-required', JSON.stringify(changed));
  }
});

test('package repair cannot remove dependencies, change scripts, lower assertions/configuration or add manifests', () => {
  const old = { scripts: { test: 'node --test' }, dependencies: { useful: '1' }, jest: { testMatch: ['**/*.test.js'] } };
  const check = (next, changed = entry('package.json')) => inspect([changed], {
    readFileAt: (_root, commit) => Buffer.from(JSON.stringify(commit === BASE ? old : next))
  });
  assert.equal(check({ ...old, dependencies: { useful: '2', added: '1' } }).blockers.length, 0);
  assert.equal(check({ ...old, dependencies: {} }).blockers.length, 1);
  assert.equal(check({ ...old, scripts: { test: 'echo pass' } }).blockers.length, 1);
  assert.equal(check({ ...old, jest: { testMatch: ['**/only-one.test.js'] } }).blockers.length, 1);
  assert.equal(check(old, entry('package.json', 'added')).blockers.length, 1);
  assert.equal(check(old, entry('package-lock.json')).blockers.length, 0);
  assert.equal(check(old, entry('package-lock.json', 'deleted')).blockers.length, 1);
});

test('only exact pinned configuration materialization is exempt from repair scope', () => {
  const changed = entry('.sflow/config.json');
  const workflow = { resolution: { configurationSource: { assets: {
    '.sflow/config.json': { mode: changed.newMode, object: changed.newObject }
  } } } };
  assert.equal(inspect([changed], { workflow }).entries[0].disposition, 'approved-configuration-input');
  assert.equal(inspect([{ ...changed, newObject: 'e'.repeat(40) }], { workflow }).blockers.length, 1);
});

function baseline() {
  return { testTools: [{ id: 'unit', argvSha256: trpDigest(['node', '--test']), adapter: 'node-tap' }],
    testObservations: [{ commandId: 'unit', status: 'available', testIdentitiesComplete: true,
      testCasesTruncated: false, testCases: [{ id: trpDigest('a'), outcome: 'failed' }, { id: trpDigest('b'), outcome: 'passed' }] }] };
}
function repaired(original) {
  return { structuredTestContract: { commands: original.testTools }, testObservations: original.testObservations.map(row =>
    ({ ...row, testCases: row.testCases.map(testcase => ({ ...testcase, outcome: 'passed' })) })) };
}

test('cohort retention compares complete identities and execution contract, never matching totals', () => {
  const original = baseline();
  assert.equal(assertTrpRepairCohortRetained(original, repaired(original)).status, 'original-cohort-retained');
  assert.equal(assertTrpRepairCohortRetained(original, repaired(original), { preview: true }).testIds.length, 2);
  for (const mutate of [
    value => { value.testObservations[0].testCases[0].id = trpDigest('different-case'); },
    value => { value.testObservations[0].testCases[0].outcome = 'skipped'; },
    value => { value.testObservations[0].testCases.push({ ...value.testObservations[0].testCases[0] }); },
    value => { value.testObservations[0].testIdentitiesComplete = false; },
    value => { value.structuredTestContract.commands = []; }
  ]) {
    const current = repaired(original); mutate(current);
    assert.throws(() => assertTrpRepairCohortRetained(original, current), { code: 'TRP_REPAIR_COHORT_UNAVAILABLE' });
  }
  original.testObservations[0].testCasesTruncated = true;
  assert.throws(() => assertTrpRepairCohortRetained(original, repaired(original), { preview: true }), { code: 'TRP_REPAIR_COHORT_UNAVAILABLE' });
});

test('an unknown original cohort is reported unknown rather than asserted as observed', () => {
  assert.deepEqual(assertTrpRepairCohortRetained(null, {}), {
    status: 'original-cohort-unknown', basis: 'unchanged-source-and-command-scope'
  });
});

test('immutable Git scope preserves both portable rename endpoints and never stages or edits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trp-repair-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid'
  } }).trim();
  git(['init', '-q']);
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'test', 'space ü.test.js'), 'unchanged test content\n');
  git(['add', '--', 'test/space ü.test.js']); git(['commit', '-qm', 'base']);
  const baseCommit = git(['rev-parse', 'HEAD']);
  git(['mv', '--', 'test/space ü.test.js', 'test/new ü.test.js']); git(['commit', '-qm', 'rename']);
  const repairCommit = git(['rev-parse', 'HEAD']);
  const result = inspectTrpRepairScope(root, { workRoot: path.join(root, 'singularity/work-items/story-1'),
    workflow: {}, baseCommit, repairCommit });
  assert.equal(result.blockers[0].oldPath, 'test/space ü.test.js');
  assert.equal(result.blockers[0].newPath, 'test/new ü.test.js');
  assert.equal(result.blockers[0].status, 'renamed');
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(git(['rev-parse', 'HEAD']), repairCommit);
});
