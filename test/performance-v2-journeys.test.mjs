import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { performanceFixture, authoredFixtureIntake } from './helpers/performance-v2-fixture.mjs';
import { summarizeSamples } from '../src/dx-performance.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const samples = Number(process.env.SINGULARITY_FLOW_JOURNEY_BENCHMARK ?? 0);

test('phase entry and publication keep exact effects in a paired disposable journey', { timeout: 3_600_000,
  skip: !Number.isSafeInteger(samples) || samples < 1 || samples > 100 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-perf-journey-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = await performanceFixture(path.join(base, 'seed'), cli);
  await authoredFixtureIntake(fixture);
  const baselineCli = process.env.SINGULARITY_FLOW_BENCHMARK_BASE_CLI ?? cli;
  const remoteHead = fixture.must('git', ['--git-dir', path.join(fixture.base, 'remote.git'),
    'rev-parse', `refs/heads/${fixture.workId}`]).stdout.trim();
  const observations = { baseline: [], candidate: [] };
  // Each publication consumes its own independently copied unpublished repository and local remote.
  // No mutation is retried as a latency sample and the seed itself remains unpublished.
  for (let index = 0; index < samples + 5; index++) {
    for (const mode of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const copy = path.join(base, `${index}-${mode}`);
      await cp(fixture.base, copy, { recursive: true });
      const root = path.join(copy, 'repo');
      // Restore only the throwaway bare fixture ref, outside the timed segment. Each copied
      // checkout then sees the same remote predecessor, rather than another sample's publication.
      fixture.must('git', ['--git-dir', path.join(fixture.base, 'remote.git'), 'update-ref',
        `refs/heads/${fixture.workId}`, remoteHead]);
      const command = mode === 'baseline' ? baselineCli : cli;
      const entry = fixture.must(process.execPath, [command, 'phase', 'enter', '--for-agent', '--json', '--timings'], root);
      const packet = JSON.parse(entry.stdout);
      assert.equal(packet.workId, fixture.workId);
      assert.equal(packet.effects.testsRun, false);
      assert.equal(packet.effects.committed, false);
      const published = fixture.must(process.execPath, [command, 'phase', 'publish', 'intake', '--authored', 'human',
        '--channel', 'manual-in-place', '--json', '--timings'], root);
      const state = JSON.parse(fixture.must(process.execPath, [command, 'status', '--json'], root).stdout);
      assert.equal(state.phases.intake.generation, 1);
      assert.equal(state.phases.intake.status, 'in_progress');
      if (index >= 5) observations[mode].push({ phaseEntryMs: entry.elapsedMs, publicationMs: published.elapsedMs,
        entryBytes: Buffer.byteLength(entry.stdout), entryTimings: entry.stderr, publicationTimings: published.stderr });
      await rm(copy, { recursive: true, force: true });
    }
  }
  const report = { schemaVersion: 1, resultType: 'sflow-performance-v2-journeys', platform: process.platform,
    node: process.version, samples, warmups: 5, referenceCommit: process.env.SINGULARITY_FLOW_BENCHMARK_BASE_COMMIT ?? null,
    fixture: 'quick-fix-authored-intake', mode: 'source', modelsInvoked: 0,
    limitations: ['Total publication includes local-remote push and commit; not orchestration-only or network qualification.',
      'This is a deterministic fixture, not a native Copilot Story or human approval.'],
    summaries: Object.fromEntries(Object.entries(observations).map(([mode, rows]) => [mode, {
      phaseEntry: summarizeSamples(rows.map(row => row.phaseEntryMs)), publication: summarizeSamples(rows.map(row => row.publicationMs))
    }])), observations };
  if (process.env.SINGULARITY_FLOW_JOURNEY_REPORT) await writeFile(process.env.SINGULARITY_FLOW_JOURNEY_REPORT,
    `${JSON.stringify(report, null, 2)}\n`);
  t.diagnostic(JSON.stringify(report));
});
