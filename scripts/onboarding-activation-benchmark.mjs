#!/usr/bin/env node
/** Matched installed-build onboarding activation qualification. All mutations use disposable local remotes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/onboarding-activation-benchmark.mjs --output <JSON> [--control <CHECKOUT>] [--samples=3] [--files=1000]');
  process.exit(0);
}
const option = (name, fallback) => {
  const equal = args.find(value => value.startsWith(`--${name}=`));
  if (equal) return equal.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const output = option('output', null);
const samples = Number(option('samples', '3')), files = Number(option('files', '1000'));
if (!output || !Number.isSafeInteger(samples) || samples < 1 || samples > 10
  || !Number.isSafeInteger(files) || files < 0 || files > 100_000) throw new Error('Provide --output, samples 1..10 and files 0..100000.');
const roots = { ...(option('control', null) ? { control: path.resolve(option('control', null)) } : {}), candidate: root };
const report = {
  schemaVersion: 1, platform: process.platform, arch: process.arch, node: process.version,
  cpu: os.cpus()[0]?.model ?? null, logicalCpus: os.cpus().length, osRelease: os.release(),
  protocol: { samples, files, remote: 'disposable local bare repositories', modelsInvoked: 0,
    cold: 'fresh process and empty private V8 cache; operating-system caches are not flushed',
    prewarmed: '--warm-runtime first, with preparation cost separate from request latency',
    gitFactStore: 'disabled identically in both variants',
    scope: 'CLI proposal review, first activation and organisation refresh; excludes native UI and provider WAN latency' },
  sources: {}, rows: []
};
const fixtures = new Map();
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const save = async () => { await mkdir(path.dirname(path.resolve(output)), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`); };

try {
  for (const [variant, source] of Object.entries(roots)) {
    const { createWarmReadFixture } = await import(pathToFileURL(path.join(source, 'scripts/warm-read-fixture.mjs')));
    const { buildCliBundle } = await import(pathToFileURL(path.join(source, 'scripts/build-cli-bundle.mjs')));
    const f = await createWarmReadFixture();
    fixtures.set(variant, f);
    const built = await buildCliBundle({ root: f.engine });
    const application = path.join(f.directory, 'application');
    await mkdir(path.join(application, 'src'), { recursive: true });
    await writeFile(path.join(application, 'README.md'), '# Disposable onboarding qualification\n');
    for (let index = 0; index < files; index++) await writeFile(path.join(application, 'src', `file-${index}.txt`), `file ${index}\n`);
    const git = argv => f.git(argv, { cwd: application });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Activation qualification']); git(['config', 'user.email', 'activation@example.invalid']);
    git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Disposable application baseline']);
    const main = git(['rev-parse', 'main']);
    const env = { ...f.env, SINGULARITY_FLOW_BUNDLE: 'on', SINGULARITY_FLOW_BUNDLE_DIR: built.outdir,
      SINGULARITY_FLOW_SUBPROCESS_PROBE: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(f.directory, 'empty.gitconfig'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(f.directory, 'leads.json'),
      SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(f.directory, 'organisation-cache'),
      SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(f.directory, 'bootstrap'),
      SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(f.directory, 'outbox'),
      SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Activation qualification',
      GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'activation@example.invalid' };
    delete env.NODE_DISABLE_COMPILE_CACHE;
    report.sources[variant] = {
      commit: f.git(['rev-parse', 'HEAD'], { cwd: source }),
      trackedChanges: f.git(['status', '--porcelain', '--untracked-files=no'], { cwd: source }),
      bundleManifestSha256: digest(JSON.stringify(built.manifest)), git: git(['--version'])
    };
    function call(argv, cache) {
      const started = performance.now();
      const warm = argv[0] === '--warm-runtime';
      const result = spawnSync(process.execPath, [f.cli, ...argv, ...(warm ? [] : ['--json', '--timings'])], {
        cwd: application, env: { ...env, NODE_COMPILE_CACHE: cache }, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024
      });
      if (result.status !== 0 || result.error || result.signal) throw new Error(
        `${variant} ${argv.slice(0, 2).join(' ')} failed:\n${result.stderr}\n${result.stdout}`, { cause: result.error });
      const packet = JSON.parse(result.stdout);
      const timingLine = result.stderr.split('\n').findLast(line => line.startsWith('[sflow timing] '));
      const metrics = Object.fromEntries([...(timingLine ?? '').matchAll(/([a-z][a-z0-9.-]*)=([0-9]+(?:\.[0-9]+)?)(ms)?/g)]
        .map(match => [match[1], Number(match[2])]));
      const spans = Object.fromEntries([...(timingLine?.split('spans:')[1] ?? '').matchAll(/([a-z][a-z0-9.-]*)=([0-9]+(?:\.[0-9]+)?)ms/g)]
        .map(match => [match[1], Number(match[2])]));
      return { packet, wallMs: Math.round(performance.now() - started), metrics, spans, timingLine,
        subprocessSummary: result.stderr.split('\n').filter(line => /^subprocesses:|^\s+\d+x /.test(line)) };
    }
    Object.assign(f, { application, main, call });
  }
  for (let sample = 0; sample < samples; sample++) {
    const variants = [...fixtures.keys()];
    if (sample % 2) variants.reverse();
    for (const prewarmed of sample % 2 ? [true, false] : [false, true]) for (const variant of variants) {
      const f = fixtures.get(variant);
      const lead = path.join(f.directory, `lead-${sample}-${prewarmed}.git`);
      const delivery = path.join(f.directory, `delivery-${sample}-${prewarmed}.git`);
      f.git(['clone', '-q', '--bare', f.application, lead]); f.git(['clone', '-q', '--bare', f.application, delivery]);
      const baseCache = path.join(f.directory, 'cache', `${sample}-${prewarmed}`);
      const mapped = f.call(['capability', 'map', `demo-activation-${sample}-${prewarmed ? 'warm' : 'cold'}`,
        '--lead', lead, '--name', 'Activation qualification', '--kind', 'delivery', '--repository', delivery], path.join(baseCache, 'setup')).packet;
      assert.ok(mapped.branch && mapped.commit);
      for (const [action, argv] of [
        ['review', ['capability', 'proposal', mapped.branch, '--lead', lead]],
        ['activate', ['capability', 'activate', mapped.branch, '--lead', lead, '--confirm', mapped.commit, '--acknowledge-unprotected']],
        ['refresh-catalog', ['capability', 'organisation', '--lead', lead]]
      ]) {
        const cache = path.join(baseCache, action);
        let preparation = null;
        if (prewarmed) {
          const warm = f.call(['--warm-runtime'], cache);
          assert.equal(warm.packet.prepared, true);
          assert.equal(warm.packet.modelsInvoked, 0);
          assert.equal(warm.packet.commandsExecuted, 0);
          preparation = { wallMs: warm.wallMs, preparedFiles: warm.packet.files };
        }
        const loadBefore = os.loadavg(), observed = f.call(argv, cache), packet = observed.packet;
        const { packet: ignored, ...measurements } = observed;
        const row = { variant, sample, prewarmed, action, loadBefore, preparation, ...measurements };
        if (action === 'review') assert.equal(packet.valid, true);
        if (action === 'activate') {
          assert.equal(packet.status, 'activated'); assert.equal(packet.activated, true);
          assert.equal(packet.proposalCommit, mapped.commit); assert.equal(packet.audit.recorded, true);
          assert.equal(packet.projection.published, true); assert.equal(packet.portability.portable, true);
          assert.equal(f.git(['rev-parse', 'sflow/config'], { cwd: lead }), packet.targetCommit);
          assert.equal(f.git(['rev-parse', 'state'], { cwd: lead }), packet.projection.commit);
          for (const repository of [lead, delivery]) assert.equal(f.git(['rev-parse', 'main'], { cwd: repository }), f.main);
          Object.assign(row, { activated: true, auditRecorded: true, projectionPublished: true,
            portable: true, applicationMainUnchanged: true });
        }
        report.rows.push(row); await save();
        console.log(JSON.stringify({ variant, sample, prewarmed, action, wallMs: row.wallMs,
          git: row.metrics['git.spawns'], remote: row.metrics['git.remote.total'] }));
      }
    }
  }
} catch (error) {
  report.failure = error.message; await save(); throw error;
} finally {
  for (const fixture of fixtures.values()) await fixture.cleanup();
}
console.log(`Complete: ${report.rows.length} qualified requests; all disposable fixtures removed.`);
