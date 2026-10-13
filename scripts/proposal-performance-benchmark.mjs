#!/usr/bin/env node
/** Disposable local-remote measurements: no application workspace or model is used. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = path.resolve(option('source') ?? fileURLToPath(new URL('..', import.meta.url)));
const samples = Number(option('samples') ?? 3), files = Number(option('files') ?? 1000);
if (!Number.isInteger(samples) || samples < 1 || samples > 30 || !Number.isInteger(files) || files < 0 || files > 10000) {
  throw new Error('Use --samples=1..30 and --files=0..10000.');
}
if (JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).name !== 'singularity-flow') {
  throw new Error('The benchmark source must be a Singularity Flow checkout.');
}
const bin = path.join(source, 'bin/singularity-flow.mjs');
const results = [];
for (let sample = 0; sample < samples; sample++) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-proposal-benchmark-'));
  const root = path.join(base, 'checkout'), remote = path.join(base, 'remote.git');
  // Never let ambient Git selectors redirect fixture writes into a real checkout. Global
  // hook/fsmonitor settings are also excluded; only local fixture Git is involved here.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_OPTIONS'));
  const env = { ...inherited, NODE_ENV: 'test', NO_COLOR: '1', SINGULARITY_FLOW_NO_MODEL: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'empty.gitconfig'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(base, 'no-hooks'),
    GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Proposal Benchmark',
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
    SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: path.join(base, 'cache'),
    SINGULARITY_FLOW_AST_PREFERENCE_FILE: path.join(base, 'ast.json'),
    SINGULARITY_FLOW_PRESENTATION_PROFILE_FILE: path.join(base, 'profile.json') };
  function exec(command, args, cwd = root) {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8',
      timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    if (result.error) throw result.error;
    return result;
  }
  function check(result) {
    if (result.status !== 0) throw new Error(result.stderr + result.stdout);
    return result;
  }
  const git = (...args) => check(exec('git', args));
  const measurements = [];
  function flow(action, args, refusal = null) {
    const start = performance.now();
    const result = exec(process.execPath, [bin, ...args, '--json', '--timings']);
    const wallMs = Math.round(performance.now() - start);
    if (!refusal) check(result);
    const packet = JSON.parse(result.stdout);
    if (refusal && (result.status === 0 || packet.error?.code !== refusal)) throw new Error('Unexpected benchmark refusal.');
    const timing = result.stderr.split('\n').find(line => line.startsWith('[sflow timing] ')) ?? '';
    const value = key => Number(new RegExp(`(?:^|\\s)${key.replaceAll('.', '\\.')}=([0-9.]+)`).exec(timing)?.[1] ?? 0);
    if (!value('git.spawns')) throw new Error('The benchmark requires real command timing counters.');
    measurements.push({ action, wallMs, gitSpawns: value('git.spawns'),
      remoteOperations: value('git.remote.total'), clones: value('git.remote.command.clone'),
      sealReuse: value('configuration.seal-reuse'), inventoryReuse: value('configuration.inventory-reuse') });
    return packet;
  }
  try {
    await mkdir(root);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Proposal Benchmark');
    git('config', 'user.email', 'proposal@example.invalid');
    check(exec(process.execPath, [bin, 'init']));
    await mkdir(path.join(root, 'src'));
    for (let offset = 0; offset < files; offset += 100) await Promise.all(
      Array.from({ length: Math.min(100, files - offset) }, (_, item) =>
        writeFile(path.join(root, 'src', `fixture-${offset + item}.txt`), 'Disposable benchmark source\n')));
    git('add', '.'); git('commit', '-qm', 'Disposable proposal fixture');
    check(exec('git', ['init', '-q', '--bare', '--initial-branch=main', remote], base));
    git('remote', 'add', 'origin', remote);
    git('push', '-q', '-u', 'origin', 'main');
    git('push', '-q', 'origin', 'HEAD:refs/heads/sflow/config');
    const proposal = flow('create', ['workflow', 'create', 'benchmark-workflow', '--label', 'Benchmark workflow',
      '--phases', 'requirements,implementation', '--governs', 'story', '--planned-claims', 'required',
      '--clause-phases', 'requirements', '--claim-owners', 'implementation=requirements', '--propose']);
    flow('list-cold', ['workflow', 'proposals']);
    flow('list-warm', ['workflow', 'proposals']);
    flow('review', ['workflow', 'proposal', proposal.branch]);
    flow('unacknowledged-cli', ['workflow', 'activate', proposal.branch, '--confirm', proposal.commit],
      'WORKFLOW_CONFIGURATION_UNPROTECTED');
    const activated = flow('activate', ['workflow', 'activate', proposal.branch, '--confirm', proposal.commit,
      '--acknowledge-unprotected']);
    if (!activated.activated) throw new Error('The disposable proposal did not activate.');
    results.push(measurements);
  } finally { await rm(base, { recursive: true, force: true }); }
}
const actions = results[0].map(({ action }) => action);
const summarize = values => ({ minimum: Math.min(...values),
  median: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)], maximum: Math.max(...values) });
process.stdout.write(JSON.stringify({ schemaVersion: 1, runtime: { platform: process.platform, node: process.version },
  protocol: { samples, trackedSourceFiles: files, remote: 'local-bare-only', model: 'disabled',
    authority: 'fresh-exact-commit', applicationWorkspacesTouched: false },
  actions: Object.fromEntries(actions.map(action => [action, Object.fromEntries(
    ['wallMs', 'gitSpawns', 'remoteOperations', 'clones'].map(metric => [metric,
      summarize(results.map(rows => rows.find(row => row.action === action)[metric]))]))])),
  samples: results
}, null, 2) + '\n');
