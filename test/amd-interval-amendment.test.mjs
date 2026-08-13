/**
 * A specification amendment must not move the developer's baseline. `[AMD:CON-002]` `[AMD:REQ-040]`
 *
 * `ensureWorkIntervalBaseline` keys the open interval on `phaseId + generation`. That is correct for
 * a reopen: a phase rejected and restarted genuinely begins from wherever the tree is now. It is
 * wrong for an amendment, which also mints a generation — the key stops matching, a fresh interval
 * is created, and `sourceBaseCommit` jumps to current HEAD. The developer's diff-since-baseline
 * disappears at the exact moment the amendment makes them need it.
 *
 * Both halves are tested, because the fix is only correct if it changes one of them: an amendment
 * carries the interval forward, and a plain generation bump still starts a new one.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { amendWorkIntervalBaseline, ensureWorkIntervalBaseline } from '../src/work-intervals.mjs';
import { readJson, run } from '../src/util.mjs';

function git(root, args) { return run('git', args, { cwd: root }).stdout.trim(); }

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-amd-interval-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Amendment Tester']);
  git(root, ['config', 'user.email', 'amend@example.com']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/app.js'), 'export const value = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  git(root, ['switch', '-c', 'WORK-1']);
  const itemRelative = 'singularity/work-items/WORK-1';
  await mkdir(path.join(root, itemRelative), { recursive: true });
  const workflow = {
    workItem: { id: 'WORK-1', workType: 'quick-fix', branch: 'WORK-1' },
    currentPhase: 'implement',
    phases: {
      implement: {
        id: 'implement', generation: 0, status: 'in_progress', writeScope: 'source-and-artifact',
        approvalPolicy: { maximumChangedPaths: 5 }
      }
    },
    resolution: { configSha256: 'c'.repeat(64), sourceSha256: 's'.repeat(64), templates: {}, capability: { policy: { protectedPaths: [] } } },
    lineage: { canonicalBranch: 'WORK-1', requiredChecks: [] },
    history: []
  };
  return { root, config: { governance: {}, workTypes: { 'quick-fix': {} } }, workflow, itemDirectory: path.join(root, itemRelative), itemRelative };
}

/** Work happens, so the baseline commit and current HEAD are genuinely different. */
function commitWork(root, text) {
  writeFileSync(path.join(root, 'src/app.js'), text);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'work']);
  return git(root, ['rev-parse', 'HEAD']);
}
import { writeFileSync } from 'node:fs';

test('an amendment holds the baseline and records why it moved generation', async () => {
  const context = await fixture();
  const started = await ensureWorkIntervalBaseline(context.root, context.config, context.workflow, context);
  const originalBaseline = started.sourceBaseCommit;
  const originalId = started.intervalId;

  // The developer works. HEAD is now ahead of the baseline — which is the state that makes a reset
  // destructive rather than merely untidy.
  const moved = commitWork(context.root, 'export const value = 2;\n');
  assert.notEqual(moved, originalBaseline, 'the fixture never moved HEAD, so this proves nothing');

  /**
   * An interval tracks the generation being *worked*, which is `phase.generation + 1` while the
   * phase is in progress — so a phase at generation 0 holds interval generation 1, and amending it
   * moves to 2.
   */
  context.workflow.phases.implement.generation = 1;
  const amended = await amendWorkIntervalBaseline(context.root, context.workflow, {
    phaseId: 'implement', toGeneration: 2, clauses: ['S:AC-003', 'S:AC-007'],
    author: 'amender@example.com', reason: 'tightened the retry rule'
  });

  assert.equal(amended.intervalId, originalId, 'the amendment replaced the interval instead of amending it');
  assert.equal(amended.sourceBaseCommit, originalBaseline, 'the baseline moved — the developer lost their diff');
  assert.equal(amended.generation, 2);

  // The amendment joins the pinned facts on disk, not just the in-memory workflow.
  const record = await readJson(path.join(context.root, amended.path));
  assert.equal(record.sourceBaseCommit, originalBaseline);
  assert.equal(record.generation, 2);
  assert.deepEqual(record.amendments.at(-1).clauses, ['S:AC-003', 'S:AC-007']);
  assert.equal(record.amendments.at(-1).fromGeneration, 1);
  assert.equal(record.amendments.at(-1).reason, 'tightened the retry rule');
  // The pinned facts changed, so their hash must change; the commit is what had to hold.
  assert.notEqual(record.baselineSha256, started.baselineSha256, 'the baseline hash ignored the amendment');

  const event = context.workflow.history.at(-1);
  assert.equal(event.event, 'work_interval_amended');
  assert.match(event.detail, /g1 → g2/);
  assert.match(event.detail, /baseline held at/);
});

test('after an amendment the interval is reused, not restarted', async () => {
  /**
   * The property that actually matters. `ensureWorkIntervalBaseline` runs on the next command; if
   * it still sees a generation mismatch it will mint a new interval and undo the amendment.
   */
  const context = await fixture();
  const started = await ensureWorkIntervalBaseline(context.root, context.config, context.workflow, context);
  commitWork(context.root, 'export const value = 2;\n');
  context.workflow.phases.implement.generation = 1;
  await amendWorkIntervalBaseline(context.root, context.workflow, { phaseId: 'implement', toGeneration: 2 });

  const after = await ensureWorkIntervalBaseline(context.root, context.config, context.workflow, context);
  assert.equal(after.intervalId, started.intervalId, 'the next command restarted the interval anyway');
  assert.equal(after.sourceBaseCommit, started.sourceBaseCommit);
});

test('a generation bump that is not an amendment still starts a fresh interval', async () => {
  /**
   * The behaviour that must NOT change. A rejected phase restarting is a genuinely new stretch of
   * work and belongs to a new baseline; if the fix quietly made every reopen reuse the old interval
   * it would be a worse bug than the one it fixed.
   */
  const context = await fixture();
  const started = await ensureWorkIntervalBaseline(context.root, context.config, context.workflow, context);
  const moved = commitWork(context.root, 'export const value = 3;\n');

  context.workflow.phases.implement.generation = 1;
  const reopened = await ensureWorkIntervalBaseline(context.root, context.config, context.workflow, {
    ...context, sourceBaseCommit: moved
  });
  assert.notEqual(reopened.intervalId, started.intervalId, 'a reopen reused the previous interval');
  assert.equal(reopened.sourceBaseCommit, moved, 'a reopen did not rebaseline on the current tree');
});

test('an amendment refuses to run where it would mean nothing', async () => {
  const context = await fixture();
  await ensureWorkIntervalBaseline(context.root, context.config, context.workflow, context);

  await assert.rejects(() => amendWorkIntervalBaseline(context.root, context.workflow, { phaseId: 'implement', toGeneration: 1 }),
    /generation 1 is not after 1/);
  await assert.rejects(() => amendWorkIntervalBaseline(context.root, context.workflow, { phaseId: 'implement' }),
    /needs the generation it is moving to/);
  // A phase with no open interval is not an error: there is simply nothing to carry forward.
  assert.equal(await amendWorkIntervalBaseline(context.root, context.workflow, { phaseId: 'other', toGeneration: 1 }), null);
});
