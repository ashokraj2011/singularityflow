/**
 * A misfiled discovery packet must not destroy the build, and the build must leave a trace.
 *
 * From a real run: a discovery worker wrote `testfile.md` into the analysis worktree instead of its
 * packet. Three things followed, and each is a separate defect.
 *
 * The missing packet triggered the retry, but nothing cleaned the worktree between attempts, so the
 * retry inherited a tree that already violated the guard — the build was unwinnable from the first
 * bad write. The failure then deleted the checkpoint, which lives in the *real repository* while the
 * violation was in a *throwaway worktree*: four completed workers, six minutes, discarded for a
 * fault in a directory that was about to be removed anyway. And `worldmodel.mjs` had no logger at
 * all, so `command.start` and `command.failed` sat 361 seconds apart with nothing between them;
 * reconstructing the run meant reading file modification times.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildTracer, checkpointRetainedNote, outsideBuilderScratch, restoreAnalysisWorktree
} from '../src/worldmodel.mjs';
import { changedSnapshotPaths, repositoryContentSnapshot } from '../src/grounding.mjs';
import { REDACTED, createLogger, parseLogLines, redact } from '../src/logging.mjs';
import { ensureGrounding, isMinimalModel } from '../src/world-model-materialization.mjs';

const CONFIG = { outputDir: 'singularity/world-model' };

/** A repository with a detached analysis worktree, exactly as `wm build` creates one. */
async function repositoryWithAnalysisWorktree() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-iso-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Isolation Tester');
  git('config', 'user.email', 'isolation@example.com');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/app.js'), 'export const app = 1;\n');
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  git('add', '-A');
  git('commit', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD').stdout.trim();
  const analysisRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-iso-wt-')), 'repository');
  git('worktree', 'add', '--detach', analysisRoot, commit);
  return { root, analysisRoot, commit, git };
}

test('a stray file is detected, and the worktree goes back to its source commit', async () => {
  const { analysisRoot } = await repositoryWithAnalysisWorktree();
  const before = await repositoryContentSnapshot(analysisRoot);

  // Precisely what happened: the worker wrote this instead of its packet.
  await writeFile(path.join(analysisRoot, 'testfile.md'), 'scratch\n');
  const dirtied = outsideBuilderScratch(
    changedSnapshotPaths(before, await repositoryContentSnapshot(analysisRoot)), CONFIG
  );
  assert.deepEqual(dirtied, ['testfile.md']);

  assert.equal(restoreAnalysisWorktree(analysisRoot), true);
  assert.equal(existsSync(path.join(analysisRoot, 'testfile.md')), false);

  // The retry now runs against a tree that matches the source commit — which is the whole point.
  const after = await repositoryContentSnapshot(analysisRoot);
  assert.deepEqual(outsideBuilderScratch(changedSnapshotPaths(before, after), CONFIG), []);
});

test('restoring reverts a modified tracked file, not only untracked scratch', async () => {
  const { analysisRoot } = await repositoryWithAnalysisWorktree();
  const before = await repositoryContentSnapshot(analysisRoot);
  await writeFile(path.join(analysisRoot, 'src/app.js'), 'export const app = 999; // edited\n');

  const dirtied = outsideBuilderScratch(
    changedSnapshotPaths(before, await repositoryContentSnapshot(analysisRoot)), CONFIG
  );
  assert.deepEqual(dirtied, ['src/app.js']);
  assert.equal(restoreAnalysisWorktree(analysisRoot), true);
  assert.equal(await readFile(path.join(analysisRoot, 'src/app.js'), 'utf8'), 'export const app = 1;\n');
});

test('the checkpoint exemption matches a path segment, not any substring', () => {
  const scratch = 'singularity/world-model/.checkpoints';
  // Genuine builder scratch: exempt.
  assert.deepEqual(outsideBuilderScratch([`${scratch}/abc/packets/testing.md`], CONFIG), []);
  assert.deepEqual(outsideBuilderScratch([scratch], CONFIG), []);
  // A repository file that merely contains that text in its path is NOT builder scratch. The old
  // `includes` test exempted it, which is a strange thing for a guard to do.
  assert.deepEqual(
    outsideBuilderScratch([`docs/${scratch}-notes.md`], CONFIG),
    [`docs/${scratch}-notes.md`]
  );
  assert.deepEqual(outsideBuilderScratch(['testfile.md'], CONFIG), ['testfile.md']);
});

test('the failure message says whether finished work survived', () => {
  assert.match(checkpointRetainedNote(null), /Rerun the build/);
  assert.match(checkpointRetainedNote({ state: { views: {} } }), /resume/);

  const withWork = {
    state: {
      views: {
        development: { status: 'completed' },
        testing: { status: 'completed' },
        security: { status: 'pending' }
      }
    }
  };
  // The number is the point. "Two packets were kept" is the difference between rerunning a
  // six-minute build and resuming one.
  assert.match(checkpointRetainedNote(withWork), /2 completed view packets were kept/);
  assert.match(checkpointRetainedNote(withWork), /resume the rest/);
  assert.match(checkpointRetainedNote({ state: { views: { a: { status: 'completed' } } } }),
    /1 completed view packet was kept/);
});

test('the build writes a groupable, timestamped trace', async () => {
  const { root } = await repositoryWithAnalysisWorktree();
  const log = buildTracer(root, { definition: null }, { operation: 'wm.build' });

  // Every event from one build shares a buildId. A repository can run concurrent commands, and a
  // trace whose lines cannot be grouped back to their build is a pile of lines.
  assert.ok(log.context.buildId, 'no buildId on the tracer');
  assert.equal(log.context.command, 'wm');
  assert.equal(log.context.operation, 'wm.build');

  const lines = [];
  const captured = createLogger({
    gitDirectory: path.join(root, '.git'), level: 'trace', consoleLevel: 'off',
    context: log.context, write: (_file, text) => lines.push(text)
  });
  captured.info('worldmodel.build.start', null, { views: ['development', 'testing'], depth: 'standard' });
  captured.warn('worldmodel.discovery.isolation', null, { view: 'development', paths: ['testfile.md'], restored: true });
  captured.info('worldmodel.build.end', null, { durationMs: 361_372, checkpointRetained: true });

  const entries = parseLogLines(lines.join(''));
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.match(entry.ts, /^\d{4}-\d\d-\d\dT/, 'every event is timestamped');
    assert.equal(entry.buildId, log.context.buildId, 'events cannot be grouped by build');
    assert.match(entry.event, /^worldmodel\./);
  }

  // The one fact the investigation needed and had to recover from file mtimes: which file, and
  // whether the tree was put back.
  const isolation = entries.find((entry) => entry.event === 'worldmodel.discovery.isolation');
  assert.deepEqual(isolation.paths, ['testfile.md']);
  assert.equal(isolation.restored, true);
  assert.equal(isolation.view, 'development');
  assert.equal(isolation.level, 'warn');

  assert.equal(entries.at(-1).durationMs, 361_372);
  assert.equal(entries.at(-1).checkpointRetained, true);
});

test('a log field named path is not mistaken for a personal access token', () => {
  // `pat` was matched anywhere in a key name, so `path` and `paths` logged as `[redacted]`. Nothing
  // leaked; the cost was the opposite — the log withheld the most ordinary field there is, and the
  // isolation event above is exactly the case that needs it.
  const secrets = redact({
    pat: 'x', PAT: 'x', github_pat: 'x', githubPat: 'x', 'pat-token': 'x',
    apiKey: 'x', accessToken: 'x', password: 'x', authorization: 'x'
  });
  for (const [key, value] of Object.entries(secrets)) {
    assert.equal(value, REDACTED, `${key} must still be redacted`);
  }

  const ordinary = redact({
    path: 'src/app.js', paths: ['testfile.md'], filePath: 'a/b', pathname: '/x',
    pattern: 'glob', patch: 'diff', compatible: true
  });
  assert.equal(ordinary.path, 'src/app.js');
  assert.deepEqual(ordinary.paths, ['testfile.md']);
  assert.equal(ordinary.filePath, 'a/b');
  assert.equal(ordinary.pattern, 'glob');
  assert.equal(ordinary.patch, 'diff');
});

test('the discovery path emits an event for every action worth tracing', async () => {
  // A source-level check, because driving `runParallelDiscovery` needs a model provider. It guards
  // the property that actually failed: the build ran for six minutes and logged nothing.
  const source = await readFile(new URL('../src/worldmodel.mjs', import.meta.url), 'utf8');
  const required = [
    'worldmodel.build.start', 'worldmodel.worktree.created', 'worldmodel.discovery.planned',
    'worldmodel.discovery.attempt', 'worldmodel.discovery.attempt.done', 'worldmodel.discovery.retry',
    'worldmodel.discovery.isolation', 'worldmodel.discovery.degraded', 'worldmodel.discovery.packet',
    'worldmodel.discovery.complete', 'worldmodel.synthesis.start', 'worldmodel.synthesis.ok',
    'worldmodel.synthesis.failed', 'worldmodel.build.end'
  ];
  for (const event of required) {
    assert.ok(source.includes(`'${event}'`), `no ${event} event is emitted`);
  }
  // `build.end` sits in the `finally` so a trace closes however the build ended.
  const finallyBlock = source.slice(source.lastIndexOf('worldmodel.build.end') - 600);
  assert.ok(/finally \{/.test(finallyBlock.slice(0, 700)), 'build.end is not in the finally block');
});

test('a worker that commits is still fatal — cleaning cannot undo it', async () => {
  const { analysisRoot, commit, git } = await repositoryWithAnalysisWorktree();
  await writeFile(path.join(analysisRoot, 'sneaky.md'), 'x\n');
  spawnSync('git', ['add', '-A'], { cwd: analysisRoot });
  spawnSync('git', ['-c', 'user.email=i@e.com', '-c', 'user.name=I', 'commit', '-m', 'worker commit'],
    { cwd: analysisRoot });

  const moved = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: analysisRoot, encoding: 'utf8' }).stdout.trim();
  assert.notEqual(moved, commit, 'the fixture did not actually create a commit');

  // Restoring cleans the tree but cannot un-write the object, and HEAD still disagrees with the
  // commit the build recorded — so the world model would describe a tree it does not name.
  restoreAnalysisWorktree(analysisRoot);
  assert.notEqual(
    spawnSync('git', ['rev-parse', 'HEAD'], { cwd: analysisRoot, encoding: 'utf8' }).stdout.trim(),
    commit
  );
  git('worktree', 'remove', '--force', analysisRoot);
});

test('restoring reports failure rather than throwing, so the caller can escalate', async () => {
  // A path that is not a git worktree at all: both git calls fail, and the helper says so instead
  // of exploding inside a `finally`.
  const nowhere = await mkdtemp(path.join(os.tmpdir(), 'sflow-iso-nogit-'));
  assert.equal(restoreAnalysisWorktree(nowhere), false);
});

/**
 * A world-model build that fails must not stop the work.
 *
 * The full build is a long model-driven job with several ways to fail that say nothing about the
 * repository — a provider timeout, a worker that misfiles its packet, a synthesis that writes an
 * invalid manifest. On the run that prompted this, one stray file cost six minutes and left the
 * phase unable to compose its prompt at all.
 *
 * `wm.build` has declared `fallback: wm.light` since the operation registry was written, and nothing
 * ever ran it: the only consumer is `cli-entry.mjs`, for `--no-model`, where it prints a hint. The
 * deterministic light builder is a real, structurally complete model — it writes `views/<v>.md`,
 * briefs and a manifest — with no tokens, in about a second.
 */
const PLAN = { selections: [], phase: 'design', includeEvidence: false, taskGuide: { required: false } };

/** A bare git repository: `withSubjectLock` resolves a git dir before it takes the lock. */
async function gitRepository(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  spawnSync('git', ['init', '-b', 'main'], { cwd: root });
  return root;
}

/** Availability that is not ready until the builder has run, then is. */
function readyAfter(attempts) {
  let seen = 0;
  return async () => (++seen <= attempts
    ? { ready: false, missing: [{ id: 'views/architecture' }], sourceTreeSha256: 'abc', action: { command: 'wm ensure' } }
    : { ready: true, selected: { source: 'state-branch' } });
}

test('a failed full build falls forward to the light model instead of blocking', async () => {
  const root = await gitRepository('sflow-fwd-');
  const calls = [];
  const ensured = await ensureGrounding(root, { outputDir: 'singularity/world-model', definition: {} }, PLAN, {
    authorized: true,
    inspect: readyAfter(2),
    materialize: async () => {
      calls.push('full');
      throw new Error('discovery workers modified files outside their isolated packets: testfile.md');
    },
    materializeMinimal: async () => { calls.push('light'); }
  });

  assert.deepEqual(calls, ['full', 'light'], 'the light builder did not take over');
  assert.equal(ensured.mode, 'materialized-degraded');
  // The reason travels with the result. Never blocking is only defensible if nobody can mistake
  // this for a full model.
  assert.match(ensured.degraded.reason, /testfile\.md/);
});

test('a successful full build is never marked degraded', async () => {
  const root = await gitRepository('sflow-fwd-ok-');
  const ensured = await ensureGrounding(root, { outputDir: 'singularity/world-model', definition: {} }, PLAN, {
    authorized: true,
    inspect: readyAfter(2),
    materialize: async () => {},
    materializeMinimal: async () => { throw new Error('the light builder must not run when the full build succeeds'); }
  });
  assert.equal(ensured.mode, 'materialized');
  assert.equal(ensured.degraded, null);
});

test('with no light builder supplied the failure still surfaces, unchanged', async () => {
  // Read-only callers pass no materializer at all. They must keep getting the real error rather
  // than a quietly degraded model they never asked for.
  const root = await gitRepository('sflow-fwd-none-');
  await assert.rejects(
    () => ensureGrounding(root, { outputDir: 'singularity/world-model', definition: {} }, PLAN, {
      authorized: true,
      inspect: readyAfter(2),
      materialize: async () => { throw new Error('provider timed out'); }
    }),
    /provider timed out/
  );
});

/**
 * The fall-forward must not become a one-way door.
 *
 * Falling forward publishes a light model, and a light model satisfies the grounding plan — that is
 * why it unblocks the work. But `ready` alone then meant every later probe short-circuited to
 * `reuse` before the builder was consulted, so the full build was never attempted again. One
 * transient provider failure would have downgraded a repository permanently, while the failure
 * message promised a retry that could not happen. Found by re-reading a run I had already watched
 * and misread as an ordinary reuse.
 */
const LIGHT = { selected: { source: 'state-branch', manifest: { builder_version: '2.1-light' } }, ready: true };
const FULL = { selected: { source: 'state-branch', manifest: { builder_version: '2.0' } }, ready: true };

test('an authorized ensure retries the full build when only a light model exists', async () => {
  const root = await gitRepository('sflow-oneway-');
  const calls = [];
  const result = await ensureGrounding(root, { outputDir: 'singularity/world-model', definition: {} }, PLAN, {
    authorized: true,
    inspect: async () => LIGHT,
    materialize: async () => { calls.push('full'); },
    materializeMinimal: async () => { calls.push('light'); }
  });
  assert.deepEqual(calls, ['full'], 'the full build was skipped because a light model looked ready');
  assert.equal(result.mode, 'materialized');
});

test('a full model is reused and never rebuilt', async () => {
  const root = await gitRepository('sflow-oneway-full-');
  const calls = [];
  const result = await ensureGrounding(root, { outputDir: 'singularity/world-model', definition: {} }, PLAN, {
    authorized: true,
    inspect: async () => FULL,
    materialize: async () => { calls.push('full'); },
    materializeMinimal: async () => { calls.push('light'); }
  });
  assert.deepEqual(calls, [], 'a complete model was rebuilt for no reason');
  assert.equal(result.mode, 'reuse');
});

test('a read-only caller composes against the light model rather than blocking', async () => {
  // Composition must never block on grounding quality — that is the whole point of falling forward.
  const root = await gitRepository('sflow-oneway-read-');
  const result = await ensureGrounding(root, { outputDir: 'singularity/world-model', definition: {} }, PLAN, {
    authorized: false,
    inspect: async () => LIGHT
  });
  assert.equal(result.mode, 'reuse');
  assert.equal(result.located.manifest.builder_version, '2.1-light');
  // And it is told what it is composing against.
  assert.match(result.degraded.reason, /light fallback/);
});

test('the light builder is recognised by suffix, not by an exact version string', async () => {
  assert.equal(isMinimalModel({ builder_version: '2.1-light' }), true);
  assert.equal(isMinimalModel({ builder_version: '3.0-light' }), true, 'a later light revision must still read as light');
  assert.equal(isMinimalModel({ builder_version: '2.0' }), false);
  assert.equal(isMinimalModel({}), false);
  assert.equal(isMinimalModel(null), false);
});
