#!/usr/bin/env node
/** VS Code-equivalent selected-base preview -> single-use receipt -> isolated Story start. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWarmReadFixture } from './warm-read-fixture.mjs';
import { createStoryReadinessFixture } from './story-readiness-benchmark.mjs';
import { buildCliBundle } from './build-cli-bundle.mjs';
import { buildCreationBenchmarkControl } from './creation-benchmark-control.mjs';

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const files = Number(option('files', '1000')), samples = Number(option('samples', '2'));
const controlRef = option('control-ref', null), output = option('out', null);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10 || !Number.isSafeInteger(files)
    || files < 0 || files > 20000 || (controlRef && !/^[a-f0-9]{40}$/u.test(controlRef))) throw new Error('Invalid benchmark bounds.');
const installation = await createWarmReadFixture({ files: 0 });
try {
  const built = await buildCliBundle({ root: installation.engine });
  const variants = { candidate: { root: installation.engine, outdir: built.outdir } };
  if (controlRef) variants.control = await buildCreationBenchmarkControl(installation, fileURLToPath(new URL('..', import.meta.url)), controlRef);
  const rows = [];
  for (let sample = 0; sample < samples; sample++) {
    for (const [variant, engine] of sample % 2 ? Object.entries(variants).reverse() : Object.entries(variants)) {
      for (const mode of ['cold', 'prewarmed']) {
        const f = await createStoryReadinessFixture({ cliRoot: engine.root, files });
        try {
          const gitConfig = path.join(f.directory, 'fixture.gitconfig');
          await writeFile(gitConfig, '[user]\n name = Fixture\n email = readiness@example.invalid\n');
          const env = { ...f.env, ...installation.env,
            SINGULARITY_FLOW_ACTIVE_WORKSPACE: f.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE,
            SINGULARITY_FLOW_WORKSPACE_REGISTRY: f.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY,
            SINGULARITY_FLOW_LEAD_REGISTRY: f.env.SINGULARITY_FLOW_LEAD_REGISTRY,
            SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES: f.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES,
            SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: path.join(f.directory, 'configuration-objects'),
            SINGULARITY_FLOW_TEST_IDENTITY: 'Fixture',
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig,
            NODE_COMPILE_CACHE: path.join(f.directory, 'compile-cache'), SINGULARITY_FLOW_BUNDLE: 'on',
            SINGULARITY_FLOW_BUNDLE_DIR: engine.outdir, SINGULARITY_FLOW_PROGRESS: 'stderr-v1',
            SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' };
          delete env.NODE_DISABLE_COMPILE_CACHE;
          const invoke = async (stage, args, cwd) => {
            const countsFile = path.join(f.directory, `${stage}.jsonl`), started = performance.now();
            const result = spawnSync(process.execPath, ['--import', new URL('./benchmark-git-probe.mjs', import.meta.url).href,
              path.join(engine.root, 'bin', 'singularity-flow.mjs'), ...args], {
              cwd, env: { ...env, SFLOW_BENCHMARK_GIT_COUNTS: countsFile }, encoding: 'utf8',
              timeout: 300_000, maxBuffer: 32 * 1024 * 1024
            });
            assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
            const wallMs = Math.round(performance.now() - started);
            return { wallMs, packet: JSON.parse(result.stdout),
              nodeLaunchedGit: JSON.parse((await readFile(countsFile, 'utf8')).trim()),
              timings: result.stderr.split('\n').find(line => line.startsWith('[sflow timing] ')) };
          };
          const preparation = mode === 'prewarmed' ? await invoke('prepare', ['--warm-runtime'], f.original) : null;
          const preview = await invoke('preview', ['workspace', 'branches', '--intake', '--preflight-story', 'PERF-READY',
            '--from-branch', 'main', '--work-type', 'feature', '--selected-base-only', '--isolated-worktree',
            '--mint-intake-receipt', '--json', '--timings'], f.original);
          assert.equal(preview.packet.preflight?.passed, true);
          const receipt = preview.packet.preflight.intakeReceipt;
          assert.equal(receipt?.issued, true, 'measure a real issued handoff, never silent full-validation fallback');
          const selected = preview.packet.repositoryPath;
          const start = await invoke('start', ['start', 'PERF-READY', '--from-branch', 'main', '--work-type', 'feature',
            '--title', 'Intake creation qualification', '--isolated-worktree', '--intake-receipt', receipt.id,
            '--json', '--timings'], selected);
          const remoteTip = f.git(selected, 'ls-remote', '--heads', 'origin', 'refs/heads/PERF-READY').split(/\s/u)[0];
          assert.match(remoteTip, /^[a-f0-9]{40}$/u);
          assert.equal(f.git(selected, 'rev-parse', 'refs/heads/PERF-READY'), remoteTip);
          rows.push({ variant, mode, sample, preparationMs: preparation?.wallMs ?? 0,
            preview: { wallMs: preview.wallMs, nodeLaunchedGit: preview.nodeLaunchedGit, timings: preview.timings },
            start: { wallMs: start.wallMs, nodeLaunchedGit: start.nodeLaunchedGit, timings: start.timings },
            totalMs: preview.wallMs + start.wallMs,
            totalWithPreparationMs: (preparation?.wallMs ?? 0) + preview.wallMs + start.wallMs, exactRemoteTip: true });
        } finally { await f.cleanup(); }
      }
    }
  }
  const report = { platform: process.platform, node: process.version, files, samples, controlRef, rows,
    protocol: 'Fresh workspace fixture per sample; selected-base branch checkout and genuine receipt handoff; empty private cache or charged prewarm; local bare remotes; OS caches not flushed; no model calls.' };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(path.resolve(output), text);
  process.stdout.write(text);
} finally { await installation.cleanup(); }
