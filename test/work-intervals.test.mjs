import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import {
  closeWorkInterval,
  createLocalCheckpoint,
  ensureWorkIntervalBaseline,
  escalationPlan,
  reconcileWorkInterval,
  recordFinalReconciliation,
  verifyWorkIntervalBaseline
} from '../src/work-intervals.mjs';
import { run } from '../src/util.mjs';

function git(root, args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function fixture({ protectedPaths = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-work-interval-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Interval Tester']);
  git(root, ['config', 'user.email', 'interval@example.com']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/app.js'), 'export const value = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  git(root, ['switch', '-c', 'WORK-1']);
  const itemRelative = 'singularity/work-items/WORK-1';
  const itemDirectory = path.join(root, itemRelative);
  await mkdir(itemDirectory, { recursive: true });
  const workflow = {
    workItem: { id: 'WORK-1', workType: 'quick-fix', branch: 'WORK-1' },
    currentPhase: 'implement',
    phases: {
      implement: {
        id: 'implement', generation: 0, status: 'in_progress', writeScope: 'source-and-artifact',
        approvalPolicy: { maximumChangedPaths: 5 }
      }
    },
    resolution: {
      configSha256: 'c'.repeat(64), sourceSha256: 's'.repeat(64), templates: {},
      capability: { policy: { protectedPaths } }
    },
    lineage: { canonicalBranch: 'WORK-1', requiredChecks: [] },
    history: []
  };
  const config = { governance: {}, workTypes: { 'quick-fix': {}, feature: {} } };
  return { root, config, workflow, itemDirectory, itemRelative };
}

test('a work interval keeps checkpoints local and records a final governed reconciliation', async () => {
  const context = await fixture();
  const startHead = git(context.root, ['rev-parse', 'HEAD']);
  const baseline = await ensureWorkIntervalBaseline(context.root, context.config, context.workflow, context);
  assert.match(baseline.baselineSha256, /^[0-9a-f]{64}$/);
  assert.match(baseline.intervalId, /^INT-implement-G1-001$/);
  assert.equal(JSON.parse(await readFile(path.join(context.root, baseline.path), 'utf8')).sourceBaseCommit, startHead);

  await writeFile(path.join(context.root, 'src/app.js'), 'export const value = 2;\n');
  const checkpoint = await createLocalCheckpoint(context.root, context.workflow, { name: 'safe point' });
  assert.equal(git(context.root, ['rev-parse', 'HEAD']), startHead, 'checkpoint must not commit source');
  assert.match(checkpoint.path, new RegExp(`${path.sep}\.git${path.sep}singularity-flow${path.sep}checkpoints${path.sep}`));
  assert.equal(checkpoint.files[0].path, 'src/app.js');
  assert.equal(checkpoint.durability, 'local');
  assert.equal(checkpoint.hasUncommittedBytes, true);
  assert.match(checkpoint.durabilityNotice, /not remotely durable/);

  const preview = await reconcileWorkInterval(context.root, context.config, context.workflow, context);
  assert.equal(preview.baseline.verified, true);
  assert.equal(preview.baseline.sha256, baseline.baselineSha256);
  assert.equal(preview.summary.changedPaths, 1);
  assert.equal(preview.decision.status, 'review');
  assert.equal(preview.decision.summaryStatus, 'attention');
  assert.equal(preview.decision.eligibleForSubmission, true);
  git(context.root, ['add', 'src/app.js']);
  git(context.root, ['commit', '-m', 'implement change']);
  const clean = await reconcileWorkInterval(context.root, context.config, context.workflow, {
    ...context,
    requireCleanTarget: true
  });
  assert.equal(clean.target.cleanApplicationTree, true);
  const final = await recordFinalReconciliation(context.root, context.workflow, clean, context);
  assert.equal(context.workflow.workIntervals.current.status, 'reconciled');
  closeWorkInterval(context.workflow, { phaseId: 'implement', at: '2026-08-08T00:00:00.000Z' });
  assert.equal(context.workflow.workIntervals.current.status, 'closed');
  assert.equal(context.workflow.workIntervals.current.closedAt, '2026-08-08T00:00:00.000Z');
  assert.equal(JSON.parse(await readFile(path.join(context.root, final.path), 'utf8')).final, true);
});

test('reconciliation refuses deleted or tampered governed baselines', async () => {
  const deleted = await fixture();
  const first = await ensureWorkIntervalBaseline(deleted.root, deleted.config, deleted.workflow, deleted);
  await import('node:fs/promises').then(({ rm }) => rm(path.join(deleted.root, first.path)));
  await assert.rejects(
    reconcileWorkInterval(deleted.root, deleted.config, deleted.workflow, deleted),
    /baseline does not exist/
  );

  const modified = await fixture();
  const second = await ensureWorkIntervalBaseline(modified.root, modified.config, modified.workflow, modified);
  const record = JSON.parse(await readFile(path.join(modified.root, second.path), 'utf8'));
  record.workId = 'OTHER';
  await writeFile(path.join(modified.root, second.path), `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(
    verifyWorkIntervalBaseline(modified.root, modified.config, modified.workflow, modified),
    /work ID changed|content hash/
  );
});

test('reconciliation refuses baseline path escapes and policy drift', async () => {
  const escaped = await fixture();
  await ensureWorkIntervalBaseline(escaped.root, escaped.config, escaped.workflow, escaped);
  escaped.workflow.workIntervals.current.path = 'README.md';
  await assert.rejects(
    reconcileWorkInterval(escaped.root, escaped.config, escaped.workflow, escaped),
    /inside the Story directory/
  );

  const drifted = await fixture();
  await ensureWorkIntervalBaseline(drifted.root, drifted.config, drifted.workflow, drifted);
  drifted.workflow.phases.implement.approvalPolicy.maximumChangedPaths = 2;
  await assert.rejects(
    reconcileWorkInterval(drifted.root, drifted.config, drifted.workflow, drifted),
    /work-interval policy changed/
  );
});

test('final reconciliation refuses an uncommitted application target', async () => {
  const context = await fixture();
  await ensureWorkIntervalBaseline(context.root, context.config, context.workflow, context);
  await writeFile(path.join(context.root, 'src/app.js'), 'export const value = 4;\n');
  const report = await reconcileWorkInterval(context.root, context.config, context.workflow, {
    ...context,
    requireCleanTarget: true
  });
  assert.equal(report.target.cleanApplicationTree, false);
  assert.equal(report.decision.status, 'blocked');
  assert.equal(report.decision.eligibleForSubmission, false);
  assert.match(report.decision.reasons.join('\n'), /uncommitted application paths remain/);
});

test('quick fixes touching protected paths require a non-destructive workflow escalation', async () => {
  const context = await fixture({ protectedPaths: ['src'] });
  await ensureWorkIntervalBaseline(context.root, context.config, context.workflow, context);
  await writeFile(path.join(context.root, 'src/app.js'), 'export const value = 3;\n');
  const preview = await reconcileWorkInterval(context.root, context.config, context.workflow, context);
  assert.equal(preview.decision.status, 'escalation-required');
  assert.equal(preview.decision.eligibleForSubmission, false);
  assert.deepEqual(preview.findings.filter((entry) => entry.protected).map((entry) => entry.path), ['src/app.js']);

  const plan = escalationPlan(context.config, context.workflow, { target: 'feature' });
  assert.equal(plan.fromWorkType, 'quick-fix');
  assert.equal(plan.toWorkType, 'feature');
  assert.match(plan.action, /not rewritten/);
  assert.equal(git(context.root, ['branch', '--show-current']), 'WORK-1');
});
