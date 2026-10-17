import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { readStoryState } from '../src/story-state-read.mjs';
import { readProgress } from '../src/commands/progress.mjs';
import { readReport } from '../src/commands/report.mjs';
import { readReportPreferences } from '../src/report-preferences.mjs';
import { progressSnapshot } from '../src/progress.mjs';
import { deriveReport } from '../src/report.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { withCommandReadScope, withFreshReadScope } from '../src/read-scope.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';
import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { configurationReadAuthority } from '../src/configuration-read-scope.mjs';
import { validateSkillRequest, validateSkillMasterRequest } from '../src/commands/skill-request.mjs';
import { validateInstructionRequest } from '../src/commands/instruction-request.mjs';

const timer = counters => ({ increment(key, amount = 1) { counters[key] = (counters[key] ?? 0) + amount; }, async measure(_key, fn) { return fn(); } });
const stableReport = report => { const copy = structuredClone(report); delete copy.generatedAt; return copy; };

for (const storyMode of ['legacy', 'pinned']) test(`${storyMode} informational reads match canonical state without admitting execution`, async t => {
  const f = await createWarmReadFixture({ storyMode }); t.after(f.cleanup);
  const accepted = await loadAcceptedStoryExecution(f.repository, 'PERF-001');
  if (storyMode === 'pinned') assert.equal(accepted.executionCatalog.mode, 'workflow-snapshot');
  const counters = {};
  await withCommandTiming(timer(counters), () => withCommandReadScope(async () => {
    assert.deepEqual(await readProgress(f.repository, 'PERF-001'), progressSnapshot(accepted.workflow));
    assert.deepEqual(stableReport(await readReport(f.repository, 'PERF-001')),
      stableReport(deriveReport(accepted.workflow, { pricing: accepted.config.tokens?.pricing ?? null,
        premiumMultipliers: accepted.config.tokens?.premiumMultipliers ?? null })));
  }));
  assert.equal(counters['story.record-projections'], 1);
  assert.equal(counters['story.context-load'] ?? 0, 0);
  assert.equal(counters['configuration.definition-load'] ?? 0, 0);
  assert.equal(counters['configuration.template-checks'] ?? 0, 0);
  if (storyMode === 'legacy') {
    await rm(path.join(f.repository, 'singularity/templates/chore/intake.md'));
    assert.equal((await readProgress(f.repository, 'PERF-001')).currentPhase, 'intake');
    await assert.rejects(loadAcceptedStoryExecution(f.repository, 'PERF-001'), /Template missing/);
  } else {
    f.state.workflowSnapshot.snapshotHash = `sha256:${'0'.repeat(64)}`;
    await writeFile(f.statePath, JSON.stringify(f.state));
    assert.equal((await readProgress(f.repository, 'PERF-001')).currentPhase, 'intake', 'recorded progress is not a closure verification claim');
    await assert.rejects(loadAcceptedStoryExecution(f.repository, 'PERF-001'), /snapshot|hash|blob|bytes/i);
  }
});

test('state projection clones and refreshes; report preferences retain the strict pricing contract', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  await withCommandReadScope(async () => {
    const first = await readStoryState(f.repository, 'PERF-001'); first.workItem.title = 'not durable';
    assert.equal((await readStoryState(f.repository, 'PERF-001')).workItem.title, 'Read fixture');
    f.state.workItem.title = 'External edit'; await writeFile(f.statePath, JSON.stringify(f.state));
    assert.equal((await withFreshReadScope(() => readStoryState(f.repository, 'PERF-001'))).workItem.title, 'External edit');
  });
  const file = path.join(f.repository, 'singularity/workflow.yml'), original = await readFile(file, 'utf8');
  await writeFile(file, original + '\ntokens:\n  pricing:\n    sample:\n      input: 2\n  premiumMultipliers:\n    sample: 1\n');
  assert.deepEqual(await readReportPreferences(f.repository), { pricing: { sample: { input: 2 } }, premiumMultipliers: { sample: 1 } });
  await writeFile(file, original + '\ntokens:\n  premiumMultipliers:\n    sample: -1\n');
  await assert.rejects(readReport(f.repository, 'PERF-001'), /non-negative/);
  await assert.rejects(readProgress(f.repository, 'NO-SUCH-STORY'), /not found|No .*found|No .*matches/i);
});

test('pure validators preserve request refusals and have no command-service dependencies', async () => {
  assert.equal(await validateSkillRequest({ positionals: ['skill', 'list'], options: { json: true } }), 'list');
  assert.equal(validateSkillMasterRequest({ positionals: ['skill', 'show', 'x'], options: {} }), 'show');
  await assert.rejects(validateSkillRequest({ positionals: ['skill', 'list', 'extra'], options: {} }), /takes no skill ID/);
  assert.throws(() => validateInstructionRequest({ positionals: ['instruction', 'list'], options: { from: 'x' } }), /unsupported option/);
  for (const name of ['skill-request', 'instruction-request']) {
    const source = await readFile(new URL(`../src/commands/${name}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /import\(['"]|from ['"]\.\/(?:skill-master|instruction|skill)\.mjs/);
  }
});

test('approved authority reads batch frozen metadata and ignore irrelevant lower-priority policy', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  f.git(['branch', 'sflow/config']);
  const commit = f.git(['rev-parse', 'sflow/config']);
  // Lower-priority state points at an ordinary application commit, not a valid mirror.
  f.git(['branch', 'state']);
  const counters = {};
  const authority = await withCommandTiming(timer(counters), () => withApprovedConfigurationRead(f.repository,
    async value => {
      assert.equal(configurationReadAuthority(f.repository).commit, commit);
      return value;
    }, { preferAuthority: true, refreshAuthority: false }));
  assert.equal(authority.commit, commit);
  assert.equal(authority.kind, 'approved-configuration-ref');
  assert.ok((counters['git.spawns'] ?? 0) <= 7, JSON.stringify(counters));
});

test('worker preparation loads only definitions and the next read uses current state', { timeout: 60_000 }, async t => {
  const f = await createWarmReadFixture();
  const worker = await import(pathToFileURL(path.join(f.engine, 'src/read-worker-client.mjs')));
  t.after(async () => { worker.disposeReadWorkers(); await f.cleanup(); });
  const original = await readFile(f.statePath, 'utf8'); await writeFile(f.statePath, 'invalid JSON');
  const options = { executable: process.execPath, cli: f.cli, repository: f.repository, env: f.env };
  assert.deepEqual(await worker.prewarmReadWorker(options), { status: 'prepared' });
  await writeFile(f.statePath, original);
  const result = await worker.readWithWorker({ ...options, args: ['progress', 'PERF-001', '--json'] });
  assert.equal(result.transport, 'warm-worker'); assert.equal(result.value.workId, 'PERF-001');
  const report = await worker.readWithWorker({ ...options, args: ['report', 'PERF-001', '--format', 'json', '--json'] });
  assert.deepEqual(stableReport(report.value), stableReport(f.cold(['report', 'PERF-001', '--format', 'json', '--json'])));
  const stopped = new AbortController(); stopped.abort();
  assert.equal((await worker.prewarmReadWorker({ ...options, signal: stopped.signal })).status, 'cancelled');
});
