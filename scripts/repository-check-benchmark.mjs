/** Disposable local qualification. No real repository/Story, providers, tests or approval. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWarmReadFixture } from './warm-read-fixture.mjs';
import { completeAgentResult } from '../src/agent-output.mjs';

export async function repositoryCheckFixture({ files = 1000, historyCommits = 30, artifacts = 8 } = {}) {
  const f = await createWarmReadFixture({ storyMode: 'pinned', files, historyCommits, artifacts });
  try {
    const primary = f.repository;
    await writeFile(path.join(primary, 'singularity/work-items', f.workId, 'source.json'), JSON.stringify({
      type: 'manual', key: f.workId, title: 'Routine-check qualification',
      description: 'Measure entry verification with disposable local inputs.'
    }));
    f.git(['add', '.'], { cwd: primary });
    f.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic source'], { cwd: primary });
    f.git(['switch', '-q', 'main'], { cwd: primary });
    const repository = path.join(f.directory, 'story-worktrees', 'qualification');
    f.git(['worktree', 'add', '--quiet', repository, f.workId], { cwd: primary });
    const env = { ...f.env, SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES: path.join(f.directory, 'preferences.json') };
    const invoke = (args, extra = {}) => {
      const started = performance.now();
      const result = spawnSync(process.execPath, [f.cli, ...args], {
        cwd: repository, env: { ...env, ...extra }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90000
      });
      return { ...result, ms: performance.now() - started,
        packet: result.status === 0 ? completeAgentResult(result.stdout) : null };
    };
    const opened = invoke(['session', 'open', f.workId, '--for-agent', '--json']);
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);
    assert.equal(opened.packet.ready, true);
    return { ...f, repository, env, invoke };
  } catch (error) { await f.cleanup(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const f = await repositoryCheckFixture();
  try {
    const rows = [];
    for (const mode of ['always', 'cached']) for (const [command, args] of [
      ['nextsteps', ['nextsteps']], ['phase-enter-compose', ['phase', 'enter', '--compose']],
      ['session-open', ['session', 'open', f.workId]]
    ]) for (let sample = 0; sample < 4; sample++) {
      const result = f.invoke([...args, '--for-agent', '--json', '--timings'], { SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: mode });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.packet.ready, true, result.stdout);
      const checks = result.packet.repositoryChecks;
      const count = name => Number(result.stderr.match(new RegExp(`${name.replaceAll('.', '\\.')}=(\\d+)`))?.[1] ?? 0);
      rows.push({ command, mode, sample, ms: Math.round(result.ms), source: checks?.source,
        parentGitSpawns: count('git.spawns'), snapshotVerifications: count('story.snapshot-verifications'),
        cacheHits: count('repository-checks.hits') });
    }
    console.log(JSON.stringify({ platform: process.platform, node: process.version,
      scope: 'Fresh Node processes, local disposable pinned Story; 1000 files, 30 history commits, 8 artifacts. No model, tests or network. V8/OS caches are not flushed.', rows }, null, 2));
  } finally { await f.cleanup(); }
}
