import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../src/util.mjs';
import { withConfigurationReadRoot } from '../src/configuration-read-scope.mjs';
import { GOVERNANCE_ARCHIVE_PATH, GOVERNANCE_ARCHIVE_VERSION, governanceArchiveEntry } from '../src/governance-archive.mjs';
import {
  approvePhase, assertNoPendingPublication, beginPhaseGeneration, createWorkflow, preparePhase,
  preparePhaseInputs, publishGeneration, reconcilePhaseTelemetry, registerArtifact, saveWorkflow,
  submitConfirmedConvergencePhase, submitPhase, syncPublication
} from '../src/state.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cutover-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const archive = { schema: GOVERNANCE_ARCHIVE_VERSION, rebuilds: [], stories: [{
    id: 'OLD-1', createdAt: '2026-01-01', archivedBy: 'cutover-0123456789abcdef01234567',
    allIncarnations: true, archivedAt: null, statuses: ['in_progress'], locations: []
  }] };
  await mkdir(path.join(root, path.dirname(GOVERNANCE_ARCHIVE_PATH)), { recursive: true });
  await writeFile(path.join(root, GOVERNANCE_ARCHIVE_PATH), JSON.stringify(archive));
  const workflow = { workItem: { id: 'OLD-1', createdAt: '2030-01-01' }, phases: {}, currentPhase: 'custom-step' };
  return { root, workflow };
}

test('retired Stories refuse all shared write boundaries before incomplete state can trigger partial work', async t => {
  const { root, workflow } = await fixture(t);
  const before = run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root }).stdout;
  // Deliberately incomplete historical state. Retirement wins over unrelated schema, session,
  // agent, artifact or phase errors, and no routine is allowed to create a draft before refusal.
  for (const [name, operation] of [
    ['preflight', () => assertNoPendingPublication(root, {}, workflow)],
    ['prepare', () => preparePhase(root, {}, workflow)],
    ['inputs', () => preparePhaseInputs(root, {}, workflow)],
    ['begin', () => beginPhaseGeneration(root, {}, workflow)],
    ['artifact', () => registerArtifact(root, workflow, 'screenshot.png')],
    ['save', () => saveWorkflow(root, {}, workflow)],
    ['create/reuse', () => createWorkflow(root, {}, { id: 'OLD-1' })],
    ['publish', () => publishGeneration(root, {}, workflow)],
    ['submit', () => submitPhase(root, {}, workflow)],
    ['convergence', () => submitConfirmedConvergencePhase(root, {}, workflow)],
    ['approve', () => approvePhase(root, {}, workflow)],
    ['telemetry', () => reconcilePhaseTelemetry(root, {}, workflow)],
    ['sync', () => syncPublication(root, {}, workflow)]
  ]) await assert.rejects(operation, error => error.code === 'STORY_ARCHIVED_BY_REBUILD', name);
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root }).stdout, before);
  assert.equal(governanceArchiveEntry(root, workflow)?.allIncarnations, true, 'historical inspection remains available');
});

test('a pre-cutover checkout reads retirement from its approved overlay, not only its branch', async t => {
  const { root, workflow } = await fixture(t);
  const authority = await mkdtemp(path.join(os.tmpdir(), 'sflow-cutover-overlay-'));
  t.after(() => rm(authority, { recursive: true, force: true }));
  const relative = GOVERNANCE_ARCHIVE_PATH;
  await mkdir(path.join(authority, path.dirname(relative)), { recursive: true });
  await writeFile(path.join(authority, relative), await readFile(path.join(root, relative)));
  await rm(path.join(root, relative));
  assert.equal(governanceArchiveEntry(root, workflow), null);
  await withConfigurationReadRoot(root, authority, null, async () => {
    assert.equal(governanceArchiveEntry(root, workflow)?.allIncarnations, true);
    await assert.rejects(() => preparePhase(root, {}, workflow), error => error.code === 'STORY_ARCHIVED_BY_REBUILD');
  });
});
