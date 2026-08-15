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
const acceptedReportPath = option('accept-report');

function assertBaselineCandidate(report) {
  const expectedRuntime = fixtureManifest.runtime;
  const actualRuntime = report.runtime ?? {};
  for (const key of ['nodeMajor', 'platform', 'architecture']) {
    if (actualRuntime[key] !== expectedRuntime[key]) {
      throw new Error(`Baseline candidate ${key} is ${actualRuntime[key] ?? 'missing'}; expected ${expectedRuntime[key]}.`);
    }
  }
  if (report.protocol?.samples !== fixtureManifest.protocol.samples) {
    throw new Error(`Baseline candidate must contain ${fixtureManifest.protocol.samples} measured runs per command.`);
  }
  for (const key of ['network', 'modelCalls']) {
    if (report.protocol?.[key] !== fixtureManifest.protocol[key]) throw new Error(`Baseline candidate protocol.${key} does not match the reference fixture.`);
  }
  for (const [key, expected] of Object.entries(fixtureManifest.topology)) {
    if (report.topology?.[key] !== expected) throw new Error(`Baseline candidate topology.${key} does not match the reference fixture.`);
  }
  if (report.passed !== true || (report.failures?.length ?? 0) !== 0) throw new Error('A failing benchmark report cannot become the accepted baseline.');
  for (const command of Object.keys(commands)) {
    if (!report.commands?.[command] || report.commands[command].samples !== fixtureManifest.protocol.samples) {
      throw new Error(`Baseline candidate is missing the complete ${command} sample summary.`);
    }
  }
  return {
    schemaVersion: 1,
    status: 'accepted',
    acceptedAt: new Date().toISOString(),
    sourceRecordedAt: report.recordedAt,
    runtime: { ...fixtureManifest.runtime },
    commands: report.commands
  };
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-dx-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'DX Benchmark']);
  git(root, ['config', 'user.email', 'dx@example.invalid']);
  await mkdir(path.join(root, 'singularity/work-items/DX-001/artifacts/intake'), { recursive: true });
  await mkdir(path.join(root, 'singularity/templates/chore'), { recursive: true });
  await writeFile(path.join(root, 'singularity/templates/chore/intake.md'), '# Intake\n\nWhat is being asked for.\n', 'utf8');
  /**
   * The smallest definition the engine will actually load.
   *
   * This was `version: 2` and nothing else, which is enough for `snapshot --include repository` —
   * that path never parses the definition — and is rejected outright by every other command. So the
   * fixture could only ever benchmark the one shape that was already fast, and the shape the VS Code
   * extension really sends could not be measured here at all.
   *
   * Kept minimal rather than copied from `templates/workflow.yml`: a 637-line definition would make
   * the benchmark sensitive to every future edit of the shipped template.
   */
  await writeFile(path.join(root, 'singularity/workflow.yml'), [
    'version: 2',
    'defaultBaseBranch: main',
    'workItemRoot: singularity/work-items',
    'templatesRoot: singularity/templates',
    'worldModel:',
    '  views: [business, architecture, development, testing, release, operations, security]',
    '  outputDir: singularity/world-model',
    'phases:',
    '  intake:',
    '    id: intake',
    '    label: Intake',
    '    writeScope: artifact-only',
    '    defaultTemplate: chore/intake.md',
    '    artifact:',
    '      path: artifacts/intake/intake.md',
    'workTypes:',
    '  chore:',
    '    label: Chore',
    '    phases: [intake]',
    ''
  ].join('\n'), 'utf8');
  /**
   * Schema 2, which is the only schema the engine loads.
   *
   * This said `schemaVersion: 3` and had done since before schema 3 was withdrawn — undetected,
   * because the only benchmarked snapshot shape never loaded a Story. Everything `normalizeCurrentWorkflow`
   * fills in with `??=` is left out; what remains is exactly the seven keys it refuses to default.
   */
  const workflow = {
    schemaVersion: 2,
    workItem: { id: 'DX-001', title: 'Reference Story', branch: 'DX-001', workType: 'chore' },
    status: 'active', currentPhase: 'intake', phaseOrder: ['intake'],
    // `requiredArtifact` is one of the few phase fields `normalizeCurrentWorkflow` does not default,
    // and `createReviewBundle` dereferences it unguarded.
    phases: {
      intake: {
        id: 'intake', status: 'in_progress', generation: 0, defaultAgent: 'developer',
        artifacts: [], approvals: [], generationPolicy: { requirement: 'required' },
        requiredArtifact: { path: 'artifacts/intake/intake.md' }
      }
    },
    resolution: {
      worldModelGrounding: 'off',
      collaboration: { assignmentMode: 'off' },
      session: {}, contextPolicy: {}, sequenceGates: {}
    },
    lineage: { canonicalBranch: 'DX-001', childBranches: [], requiredChecks: [] },
    usage: {}, telemetry: {},
    history: []
  };
  await writeFile(path.join(root, 'singularity/work-items/DX-001/workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  // Three governed files now exist — the definition, the Story, and the one template the definition
  // references — so the filler stops three short of the declared total rather than two.
  for (let index = 0; index < fixtureManifest.topology.trackedFiles - 3; index += 1) {
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
  snapshot: ['snapshot', '--include', 'repository'],
  /**
   * What the VS Code extension actually runs, on activation and after every action.
   *
   * The sliced call above was the only snapshot shape measured, and it is the shape nothing in the
   * product asks for: `apps/vscode/src/cli/client.ts` sends `snapshot --json` with no `--include`.
   * So the budget was being met by a path the extension never took, while the path it did take was
   * unmeasured and free to regress.
   */
  snapshotFull: ['snapshot', '--json']
};

if (acceptedReportPath) {
  const candidate = JSON.parse(await readFile(path.resolve(acceptedReportPath), 'utf8'));
  const baseline = assertBaselineCandidate(candidate);
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log(`Accepted DX baseline from ${path.resolve(acceptedReportPath)}.`);
  process.exit(0);
}

if (writeBaseline) {
  const local = {
    nodeMajor: Number(process.versions.node.split('.')[0]),
    platform: process.platform,
    architecture: process.arch
  };
  for (const key of ['nodeMajor', 'platform', 'architecture']) {
    if (local[key] !== fixtureManifest.runtime[key]) {
      throw new Error(`--write-baseline is restricted to ${fixtureManifest.runtime.nodeMajor ? `Node ${fixtureManifest.runtime.nodeMajor}` : 'the pinned Node runtime'} on ${fixtureManifest.runtime.platform}/${fixtureManifest.runtime.architecture}; this host is Node ${local.nodeMajor} on ${local.platform}/${local.architecture}. Run the benchmark on the pinned runner and import its JSON with --accept-report=<path>.`);
    }
  }
}

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
  if (writeBaseline) {
    const candidate = assertBaselineCandidate(report);
    await writeFile(baselinePath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  }
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
