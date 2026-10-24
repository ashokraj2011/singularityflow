/**
 * XPL2 retained snapshots and `explain --subject change --compare` through the real CLI.
 *
 * Every view the comprehension slice builds is retained under its explanation-set digest; the CLI
 * compares the current view with one of them using the Change Explorer's own unit-by-unit
 * comparison. The store is bounded, expiring and discardable, and never changes a view.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { compareXpl2Views } from '../src/comprehension/xpl2/compare.mjs';
import {
  listXpl2Snapshots, resolveXpl2Snapshot, retainXpl2Snapshot, xpl2SnapshotDirectory, XPL2_SNAPSHOT_LIMITS
} from '../src/comprehension/xpl2/snapshots.mjs';
import { compareXpl2Views as explorerComparison } from '../apps/vscode/src/views/change-explorer.ts';
import { git } from './helpers/xpl2-fixture.mjs';

const bin = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'singularity-flow.mjs');

async function repository(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-snap-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-snap-home-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'config', 'user.name', 'XPL2 Snapshots');
  git(directory, 'config', 'user.email', 'xpl2-snapshots@example.test');
  await writeFile(path.join(directory, 'app.js'), `${Array.from({ length: 40 }, (_, index) => `const v${index + 1} = ${index + 1};`).join('\n')}\n`);
  await writeFile(path.join(directory, 'util.js'), 'export const a = 1;\n');
  git(directory, 'add', '.');
  git(directory, 'commit', '-qm', 'baseline');
  return { directory, home };
}

function cli({ directory, home }, ...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: directory, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1', SINGULARITY_FLOW_NO_MODEL: '1', GIT_TERMINAL_PROMPT: '0' }
  });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function refusal(result, code) {
  assert.notEqual(result.status, 0);
  const body = JSON.parse(result.stdout || result.stderr);
  assert.equal(body.error.code, code, result.stdout);
  return body.error;
}

async function edit(directory, file, from, to) {
  const target = path.join(directory, file);
  await writeFile(target, (await readFile(target, 'utf8')).replace(from, to));
}

test('XPL2 M3 every change view is retained under its set digest and compared unit by unit from the CLI', async (t) => {
  const fixture = await repository(t);
  await edit(fixture.directory, 'app.js', 'const v5 = 5;', 'const v5 = 500;');
  const first = json(cli(fixture, 'explain', '--subject', 'change', '--json')).data;
  assert.deepEqual(first.snapshot, { id: first.explanation.explanationSetSha256, retained: true, reason: null });
  // Nothing earlier: `previous` says so beside the view, and the view is the same.
  const alone = json(cli(fixture, 'explain', '--subject', 'change', '--compare', 'previous', '--json')).data;
  assert.equal(alone.comparison.status, 'unavailable');
  assert.equal(alone.comparison.reason, 'source-not-recorded');
  assert.equal(alone.explanation.explanationSetSha256, first.explanation.explanationSetSha256);

  await edit(fixture.directory, 'app.js', 'const v30 = 30;', 'const v30 = 3000;');
  await edit(fixture.directory, 'util.js', 'a = 1', 'a = 2');
  const second = json(cli(fixture, 'explain', '--subject', 'change', '--compare', 'previous', '--json')).data;
  assert.equal(second.comparison.status, 'available');
  assert.equal(second.comparison.older.id, first.explanation.explanationSetSha256);
  assert.equal(second.comparison.newer.id, second.explanation.explanationSetSha256);
  // The CLI's comparison is exactly the Change Explorer's over the two whole views.
  assert.deepEqual(second.comparison.result, explorerComparison(first.explanation, second.explanation));
  assert.deepEqual(second.comparison.result, compareXpl2Views(first.explanation, second.explanation));
  assert.equal(second.comparison.result.units.kept, 1);
  assert.equal(second.comparison.result.units.addedCount, 2);
  assert.deepEqual(second.comparison.result.units.added.map((unit) => unit.path).sort(), ['app.js', 'util.js']);

  // Undoing one edit: compare with the second view by an exact digest prefix.
  await edit(fixture.directory, 'util.js', 'a = 2', 'a = 1');
  const prefix = second.explanation.explanationSetSha256.slice('sha256:'.length, 'sha256:'.length + 12);
  const third = json(cli(fixture, 'explain', '--subject', 'change', '--compare', prefix, '--json')).data;
  assert.equal(third.comparison.older.id, second.explanation.explanationSetSha256);
  assert.equal(third.comparison.result.units.removedCount, 1);
  assert.deepEqual(third.comparison.result.units.removed.map((unit) => unit.path), ['util.js']);
  const text = cli(fixture, 'explain', '--subject', 'change', '--compare', prefix);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Compared with retained snapshot [a-f0-9]{12}\n/u);
  assert.match(text.stdout, /Since that snapshot: 0 change units new, 1 gone, 2 unchanged; .*\n  Changes gone from util\.js\./u);
  assert.match(text.stdout, /retained on this machine for --compare/u);
  // Comparing changes nothing in the repository, and the store holds only the projections.
  assert.equal(git(fixture.directory, 'status', '--porcelain'), 'M app.js');
  const directory = xpl2SnapshotDirectory(path.join(fixture.directory, '.git'));
  for (const name of await readdir(directory)) {
    const stored = await readFile(path.join(directory, name), 'utf8');
    assert.doesNotMatch(stored, /const v5|500|statements"\s*:\s*\[/u, 'no source or statement text is retained');
  }
});

test('XPL2 M3 --compare is refused with its next action for an unknown snapshot, another subject or a malformed digest', async (t) => {
  const fixture = await repository(t);
  await edit(fixture.directory, 'app.js', 'const v5 = 5;', 'const v5 = 6;');
  const unknown = refusal(cli(fixture, 'explain', '--subject', 'change', '--compare', 'abcdefabcdef12', '--json'), 'XPL2_SNAPSHOT_NOT_FOUND');
  assert.equal(unknown.details.nextAction, 'singularity-flow explain --subject change --compare previous --json');
  const subject = refusal(cli(fixture, 'explain', '--subject', 'line', '--path', 'app.js', '--line', '5', '--compare', 'previous', '--json'),
    'XPL2_COMPARE_SUBJECT_INVALID');
  assert.ok(subject.details.nextAction);
  assert.ok(refusal(cli(fixture, 'explain', '--subject', 'change', '--compare', 'HEAD~1', '--json'), 'XPL2_SNAPSHOT_ID_INVALID').details.nextAction);
  const snapshot = refusal(cli(fixture, 'explain', '--subject', 'change', '--snapshot', 'abc', '--json'), 'XPL2_SNAPSHOT_UNAVAILABLE');
  assert.match(snapshot.message, /keeps only what a comparison needs/u);
  assert.ok(snapshot.details.nextAction);
});

test('XPL2 M3 the snapshot store is bounded, expiring, content-addressed and ignores a tampered entry', async (t) => {
  const gitDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-snapstore-'));
  t.after(() => rm(gitDirectory, { recursive: true, force: true }));
  const view = (index, workId = 'ORD-1') => ({
    kind: 'xpl2-explanation', explanationSetSha256: `sha256:${index.toString(16).padStart(64, '0')}`,
    snapshot: { workId, phase: 'implementation', truth: 'working-tree-observation', baseline: { revision: 'HEAD' }, compatibilityCandidateSha256: null },
    inventory: { units: [{ unitId: 'H-001', path: `f${index}.js`, explanationUnitSha256: 'sha256:u', unitContentSha256: `sha256:c${index}` }] },
    sources: [], observations: [], statements: [{ id: 'S-001', text: 'never retained' }]
  });
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  for (let index = 1; index <= XPL2_SNAPSHOT_LIMITS.count + 6; index += 1) {
    assert.equal((await retainXpl2Snapshot(gitDirectory, view(index), { now: start + index * 1000 })).retained, true);
  }
  const listed = await listXpl2Snapshots(gitDirectory, { now: start + 100_000 });
  assert.equal(listed.length, XPL2_SNAPSHOT_LIMITS.count, 'the oldest past the count bound are gone');
  assert.equal(listed[0].id, view(XPL2_SNAPSHOT_LIMITS.count + 6).explanationSetSha256, 'newest first');
  // Retaining the same universe again keeps one entry and only marks it seen.
  await retainXpl2Snapshot(gitDirectory, view(10), { now: start + 200_000 });
  assert.equal((await listXpl2Snapshots(gitDirectory, { now: start + 200_000 }))[0].id, view(10).explanationSetSha256);
  // `previous` is the most recently seen other snapshot of the same Story.
  const previous = await resolveXpl2Snapshot(gitDirectory, 'previous', { current: view(10).explanationSetSha256, workId: 'ORD-1', now: start + 200_000 });
  assert.equal(previous.snapshot.id, view(XPL2_SNAPSHOT_LIMITS.count + 6).explanationSetSha256);
  assert.equal((await resolveXpl2Snapshot(gitDirectory, 'previous', { workId: 'OTHER-2', now: start + 200_000 })).status, 'not-found');
  // An entry whose content no longer matches its name contributes nothing.
  const file = path.join(xpl2SnapshotDirectory(gitDirectory), `${view(10).explanationSetSha256.slice(7)}.json`);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...stored, projection: { ...stored.projection, explanationSetSha256: view(11).explanationSetSha256 } }));
  await utimes(file, new Date(start + 300_000), new Date(start + 300_000));
  assert.equal((await resolveXpl2Snapshot(gitDirectory, view(10).explanationSetSha256, { now: start + 300_000 })).status, 'not-found');
  // Past the retention window nothing is listed or compared.
  const expired = start + (XPL2_SNAPSHOT_LIMITS.retentionDays + 1) * 24 * 60 * 60 * 1000;
  assert.deepEqual(await listXpl2Snapshots(gitDirectory, { now: expired }), []);
  assert.equal((await resolveXpl2Snapshot(gitDirectory, 'previous', { workId: 'ORD-1', now: expired })).status, 'not-found');
});
