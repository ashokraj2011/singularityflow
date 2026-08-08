#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { evaluateLatency, summarizeSamples } from '../src/dx-performance.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureManifest = JSON.parse(await readFile(path.join(projectRoot, 'benchmarks/dx/reference-fixture.json'), 'utf8'));
const baselinePath = path.join(projectRoot, 'benchmarks/dx/accepted-baseline.json');
const acceptedBaseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const option = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const samples = Number(option('samples') ?? fixtureManifest.protocol.samples);
const enforce = process.argv.includes('--enforce');
const json = process.argv.includes('--json');
const writeBaseline = process.argv.includes('--write-baseline');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-dx-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'DX Benchmark']);
  git(root, ['config', 'user.email', 'dx@example.invalid']);
  await mkdir(path.join(root, 'singularity/work-items/DX-001/artifacts/intake'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 2\n', 'utf8');
  const workflow = {
    schemaVersion: 3,
    workItem: { id: 'DX-001', title: 'Reference Story', branch: 'DX-001', workType: 'chore' },
    status: 'active', currentPhase: 'intake', phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', status: 'in_progress', generation: 0, defaultAgent: 'developer', artifacts: [], approvals: [], generationPolicy: { requirement: 'required' } } },
    resolution: { worldModelGrounding: 'off', collaboration: { assignmentMode: 'off' } }, history: []
  };
  await writeFile(path.join(root, 'singularity/work-items/DX-001/workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  for (let index = 0; index < fixtureManifest.topology.trackedFiles - 2; index += 1) {
    const directory = path.join(root, 'src', String(Math.floor(index / 100)));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `file-${index}.txt`), `fixture ${index}\n`, 'utf8');
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'Reference fixture']);
  git(root, ['branch', 'DX-001']);
  for (let index = 1; index < fixtureManifest.topology.localBranches - 1; index += 1) git(root, ['branch', `fixture-${index}`]);
  git(root, ['switch', '-q', 'DX-001']);
  for (let index = 0; index < fixtureManifest.topology.untrackedFiles; index += 1) await writeFile(path.join(root, `untracked-${index}.txt`), 'untracked\n', 'utf8');
  return root;
}

function verifyTopology(root) {
  const actual = {
    trackedFiles: Number(git(root, ['ls-files']).split('\n').filter(Boolean).length),
    untrackedFiles: Number(git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).length),
    localBranches: Number(git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads']).split('\n').filter(Boolean).length)
  };
  for (const [key, value] of Object.entries(actual)) {
    if (value !== fixtureManifest.topology[key]) throw new Error(`Reference fixture ${key} is ${value}; expected ${fixtureManifest.topology[key]}.`);
  }
  return actual;
}

function invoke(root, args) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [path.join(projectRoot, 'bin/singularity-flow.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1', SINGULARITY_FLOW_NO_NETWORK: '1', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return durationMs;
}

const commands = {
  about: ['about'],
  status: ['status', 'DX-001', '--json'],
  nextsteps: ['nextsteps', 'DX-001', '--json'],
  snapshot: ['snapshot', '--include', 'repository']
};

const fixture = await createFixture();
try {
  const topology = verifyTopology(fixture);
  const commandResults = {};
  const failures = [];
  const comparableBaseline = acceptedBaseline.status === 'accepted'
    && acceptedBaseline.runtime.nodeMajor === Number(process.versions.node.split('.')[0])
    && acceptedBaseline.runtime.platform === process.platform
    && acceptedBaseline.runtime.architecture === process.arch;
  for (const [name, args] of Object.entries(commands)) {
    invoke(fixture, args); // discarded warm-up
    const values = Array.from({ length: samples }, () => invoke(fixture, args));
    commandResults[name] = summarizeSamples(values);
    failures.push(...evaluateLatency(name, commandResults[name], fixtureManifest.budgets[name], comparableBaseline ? acceptedBaseline.commands[name] : null));
  }
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    runtime: { node: process.version, nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, architecture: process.arch },
    protocol: { ...fixtureManifest.protocol, samples }, topology,
    commands: commandResults,
    baselineComparison: comparableBaseline ? 'applied' : 'not-comparable',
    failures,
    passed: failures.length === 0
  };
  if (writeBaseline) await writeFile(baselinePath, `${JSON.stringify({ schemaVersion: 1, status: 'accepted', runtime: { ...fixtureManifest.runtime }, commands: commandResults }, null, 2)}\n`, 'utf8');
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Singularity Flow DX benchmark · ${samples} measured run(s) after one discarded warm-up`);
    for (const [name, result] of Object.entries(commandResults)) console.log(`${name.padEnd(10)} p50 ${result.p50Ms.toFixed(1)}ms · p95 ${result.p95Ms.toFixed(1)}ms · min ${result.minMs.toFixed(1)}ms · max ${result.maxMs.toFixed(1)}ms · CV ${result.coefficientOfVariation.toFixed(3)}`);
    if (failures.length) console.error(`\n${failures.join('\n')}`);
    if (!comparableBaseline) console.warn('\nWarning: no accepted baseline matches this Node/platform/architecture; absolute budgets were still evaluated.');
  }
  if (enforce && failures.length) process.exitCode = 1;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
