#!/usr/bin/env node
/** Matched installed workspace creation: fresh targets for BOTH cold and prewarmed requests. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCliBundle } from './build-cli-bundle.mjs';
import { createWarmReadFixture } from './warm-read-fixture.mjs';
import { buildCreationBenchmarkControl } from './creation-benchmark-control.mjs';
import { seedBenchmarkRepository } from './benchmark-git-seed.mjs';

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const samples = Number(option('samples', '3')), files = Number(option('files', '1000'));
const controlRef = option('control-ref', null), output = option('out', null);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10 || !Number.isSafeInteger(files)
    || files < 0 || files > 20000 || (controlRef && !/^[a-f0-9]{40}$/u.test(controlRef))) throw new Error('Invalid benchmark bounds.');
const f = await createWarmReadFixture({ files });
try {
  const built = await buildCliBundle({ root: f.engine });
  const variants = { candidate: { root: f.engine, outdir: built.outdir } };
  if (controlRef) variants.control = await buildCreationBenchmarkControl(f, fileURLToPath(new URL('..', import.meta.url)), controlRef);
  const app = path.join(f.directory, 'application'), remote = path.join(f.directory, 'application.git');
  await mkdir(app);
  await cp(path.join(f.repository, 'src'), path.join(app, 'src'), { recursive: true });
  const git = (args, options = {}) => f.git(args, { ...options, cwd: app });
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Workspace Fixture']);
  git(['config', 'user.email', 'workspace@example.invalid']);
  const initialized = spawnSync(process.execPath, [f.cli, 'init'], { cwd: app, env: f.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  await seedBenchmarkRepository(app, git, 'application fixture');
  git(['init', '--bare', '-b', 'main', remote]); git(['push', remote, 'main']);
  const expected = git(['rev-parse', 'HEAD']), rows = [];
  for (let index = 0; index < samples; index++) {
    for (const [variant, installation] of index % 2 ? Object.entries(variants).reverse() : Object.entries(variants)) {
      for (const mode of ['cold', 'prewarmed']) {
        const id = `perf-${variant}-${mode}-${index}`;
        // Every sample gets an identical remote without a state branch; otherwise the first cold
        // sample would pay state initialization while the later variants silently reused it.
        const sampleRemote = path.join(f.directory, `${id}.git`);
        f.git(['clone', '--bare', '--no-hardlinks', remote, sampleRemote], { cwd: f.directory });
        const cache = path.join(f.directory, 'cache', id), countsFile = path.join(f.directory, `${id}.jsonl`);
        const env = { ...f.env, NODE_COMPILE_CACHE: cache, SINGULARITY_FLOW_BUNDLE: 'on',
          SINGULARITY_FLOW_BUNDLE_DIR: installation.outdir, SINGULARITY_FLOW_PROGRESS: 'stderr-v1' };
        delete env.NODE_DISABLE_COMPILE_CACHE;
        const invoke = (args, measured = false) => {
          const started = performance.now();
          const result = spawnSync(process.execPath, ['--import', new URL('./benchmark-git-probe.mjs', import.meta.url).href,
            path.join(installation.root, 'bin', 'singularity-flow.mjs'), ...args], {
            cwd: f.directory, env: { ...env, ...(measured ? { SFLOW_BENCHMARK_GIT_COUNTS: countsFile } : {}) },
            encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024
          });
          assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
          return { ms: Math.round(performance.now() - started), packet: JSON.parse(result.stdout), stderr: result.stderr };
        };
        const preparation = mode === 'prewarmed' ? invoke(['--warm-runtime']) : null;
        const result = invoke(['workspace', 'create', '--local', '--id', id, '--name', id,
          '--repository', `app=${sampleRemote}`, '--lead', 'app', '--base', path.join(f.directory, 'workspaces'),
          '--clone', '--confirm', id, '--json', '--timings'], true);
        assert.equal(result.packet.created, true);
        assert.equal(result.packet.status.healthy, true);
        const checkout = path.join(result.packet.workspace.path, 'repos', 'app');
        assert.equal(result.packet.state?.error ?? null, null, 'state initialization must succeed, not benchmark a caught failure');
        assert.equal(f.git(['rev-parse', 'main'], { cwd: checkout }), expected, 'application branch is preserved');
        rows.push({ variant, mode, sample: index, wallMs: result.ms, preparationMs: preparation?.ms ?? 0,
          totalWithPreparationMs: result.ms + (preparation?.ms ?? 0),
          nodeLaunchedGit: JSON.parse((await readFile(countsFile, 'utf8')).trim()),
          timings: result.stderr.split('\n').find(line => line.startsWith('[sflow timing] ')),
          exactCloneTip: true, backgroundIndex: result.packet.codeIndex });
      }
    }
  }
  const report = { platform: process.platform, node: process.version, files, samples, controlRef, rows,
    protocol: { cold: 'fresh Node process, empty private compile cache, newly created workspace',
      prewarmed: 'same fresh-target creation after explicit runtime prewarm; preparation charged separately',
      gitCounts: 'Node-launched Git calls in the request, including direct legacy spawns; excludes detached worker and Git internal children',
      remote: 'disposable local bare repository', osCache: 'not flushed', modelCalls: 0 } };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(path.resolve(output), text);
  process.stdout.write(text);
} finally { await f.cleanup(); }
