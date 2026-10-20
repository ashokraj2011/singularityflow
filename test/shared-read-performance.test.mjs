import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { scopedUtilityRead, validateUtilityEntry } from '../src/utility-entry.mjs';
import { withReadScope } from '../src/read-scope.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';
import { repoRoot } from '../src/git.mjs';
import { loadSession } from '../src/session.mjs';

test('only closed local session projections share the command read scope', () => {
  for (const form of ['current', 'status', 'context']) {
    assert.equal(scopedUtilityRead(['session', form], { json: true }), true);
    assert.equal(scopedUtilityRead(['session', form], { json: true, 'for-agent': true }), form === 'current');
    for (const option of ['refresh', 'fetch', 'out', 'observation-file', 'confirm', 'unknown']) {
      assert.equal(scopedUtilityRead(['session', form], { json: true, [option]: true }), false);
    }
    assert.equal(scopedUtilityRead(['session', form, 'extra'], { json: true }), false);
  }
  for (const form of ['attach', 'open', 'open-local', 'takeover', 'workspace', 'candidates']) {
    assert.equal(scopedUtilityRead(['session', form], { json: true }), false);
  }
  assert.throws(() => validateUtilityEntry(['session', 'current'], {
    json: true, 'for-agent': true, 'utility-entry': true
  }), { code: 'UTILITY_ENTRY_REQUEST_INVALID' });
});

test('session files reuse the proved private Git directory only inside a read scope', async t => {
  const fixture = await createWarmReadFixture();
  t.after(fixture.cleanup);
  const counters = {};
  const timer = { increment(name, amount) { counters[name] = (counters[name] ?? 0) + amount; } };
  await withCommandTiming(timer, async () => {
    const root = repoRoot(fixture.repository);
    const before = counters['git.requests'] ?? 0;
    await withReadScope(() => Promise.all([loadSession(root, { required: false }), loadSession(root, { required: false })]));
    assert.equal(counters['git.requests'] ?? 0, before, 'shared read must not rediscover Git metadata');
    await loadSession(root, { required: false });
    await loadSession(root, { required: false });
    assert.equal(counters['git.requests'], before + 2, 'writers retain their independent Git queries');
  });
});

test('session current shares configuration and Git identity without retaining mutable state across requests', async t => {
  const fixture = await createWarmReadFixture({ storyMode: 'pinned', files: 20, artifacts: 2 });
  t.after(fixture.cleanup);
  const invoke = () => spawnSync(process.execPath, [fixture.cli, 'session', 'current', '--json', '--timings'], {
    cwd: fixture.repository, env: fixture.env, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024
  });
  const head = fixture.git(['rev-parse', 'HEAD']);
  const initialState = await readFile(fixture.statePath);
  const first = invoke();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.match(first.stderr, /configuration\.definition-load=1(?:\s|$)/u,
    'accounting reads preferences, not a second fully validated definition/catalog');
  assert.match(first.stderr, /configuration\.source-read=1(?:\s|$)/u,
    'accounting and the session share exactly one secured source read');
  const spawns = Number(/(?:^|\s)git\.spawns=(\d+)/u.exec(first.stderr)?.[1]);
  assert.ok(spawns > 0 && spawns <= 20, `session identity duplicated discovery: ${first.stderr}`);
  const result = JSON.parse(first.stdout);
  assert.equal(result.head, head);
  assert.equal(result.executionContext.worktree.head, result.head);
  assert.equal(result.executionContext.worktree.branch, result.branch);
  assert.equal(result.executionContext.observation.mutationAuthority, false);
  assert.equal(fixture.git(['rev-parse', 'HEAD']), head);
  assert.deepEqual(await readFile(fixture.statePath), initialState);

  const source = path.join(fixture.repository, 'singularity/workflow.yml');
  const original = await readFile(source, 'utf8');
  await writeFile(source, original.replace('version: 2', 'version: 999'));
  const changed = invoke();
  assert.notEqual(changed.status, 0, 'a later request must validate changed configuration');
  await writeFile(source, original);
  assert.equal(invoke().status, 0, 'failed reads must not poison the next request');
});

test('session projections use accepted amended phases instead of an unrelated live agent catalog', async t => {
  const fixture = await createWarmReadFixture({ storyMode: 'amended', artifacts: 2 });
  t.after(fixture.cleanup);
  const before = fixture.git(['rev-parse', 'HEAD']);
  for (const args of [['session', 'current', '--json'],
    ['session', 'context', '--work-id', fixture.workId, '--slice', 'brief', '--json']]) {
    const result = spawnSync(process.execPath, [fixture.cli, ...args], {
      cwd: fixture.repository, env: fixture.env, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.workId ?? value.work?.id, fixture.workId);
    assert.equal(value.phase?.id ?? value.phase ?? value.work?.phase, fixture.phaseId);
  }
  assert.equal(fixture.git(['rev-parse', 'HEAD']), before, 'reading an amendment is not approval or publication');
});
