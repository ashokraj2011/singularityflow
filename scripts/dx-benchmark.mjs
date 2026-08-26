#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/**
 * The reference repository, at whatever size the caller's topology declares.
 *
 * Parameterised rather than hard-wired to `fixtureManifest.topology`, because one size cannot show a
 * growth rate. A single point says a command took 102 ms; two say whether that number follows the
 * repository, and following the repository is the property this benchmark exists to defend.
 */
async function createFixture(topology = fixtureManifest.topology) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-dx-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'DX Benchmark']);
  git(root, ['config', 'user.email', 'dx@example.invalid']);
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
  const storyRecord = (id) => ({
    schemaVersion: 2,
    workItem: { id, title: 'Reference Story', branch: id, workType: 'chore' },
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
    lineage: { canonicalBranch: id, childBranches: [], requiredChecks: [] },
    usage: {}, telemetry: {},
    history: []
  });

  /**
   * `DX-001` first, because it is the Story the fixture ends up checked out on.
   *
   * The rest exist to be walked. `buildRepositorySubjectIndex` reads every `workflow.json` on every
   * ref, so the cost of a read is branches × Stories — and a fixture holding one Story measures the
   * first factor only, which is how a read path that spawns two subprocesses per pair stayed
   * invisible for as long as it has.
   */
  for (let index = 0; index < topology.stories; index += 1) {
    const id = `DX-${String(index + 1).padStart(3, '0')}`;
    await mkdir(path.join(root, `singularity/work-items/${id}/artifacts/intake`), { recursive: true });
    await writeFile(path.join(root, `singularity/work-items/${id}/workflow.json`),
      `${JSON.stringify(storyRecord(id), null, 2)}\n`, 'utf8');
  }

  // The definition, the one template it references, and one `workflow.json` per Story are governed
  // files that already count against the declared total, so the filler stops short of them.
  const governed = 2 + topology.stories;
  for (let index = 0; index < topology.trackedFiles - governed; index += 1) {
    const directory = path.join(root, 'src', String(Math.floor(index / 100)));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `file-${index}.txt`), `fixture ${index}\n`, 'utf8');
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'Reference fixture']);
  git(root, ['branch', 'DX-001']);
  for (let index = 1; index < topology.localBranches - 1; index += 1) git(root, ['branch', `fixture-${index}`]);
  git(root, ['switch', '-q', 'DX-001']);
  for (let index = 0; index < topology.untrackedFiles; index += 1) await writeFile(path.join(root, `untracked-${index}.txt`), 'untracked\n', 'utf8');
  return root;
}

/**
 * The same repository, connected to a remote and carrying a ledger. `[UXH:REQ-120]` `[DHR:REQ-093]`
 *
 * Built on top of the reference fixture rather than beside it, so the two tiers differ in exactly
 * the dimensions named in the manifest and a difference in timing is attributable to them.
 *
 * The remote is a **bare repository on disk**, reached over `file://`. That is a real remote as far
 * as Git is concerned — `hasRemote` is true, `fetch` spawns, remote-tracking refs exist and the
 * ledger's whole remote-branch walk activates — while staying deterministic and needing no network.
 * A benchmark that depended on GitHub would be measuring someone else's afternoon.
 */
async function createConnectedFixture() {
  const root = await createFixture();
  const declared = fixtureManifest.connected.topology;
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-dx-remote-'));
  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', `file://${remote}`]);

  /**
   * The ledger has to be *enabled*, not merely present.
   *
   * `normalizeLedgerConfig` defaults `enabled` to falsy and `ledgerStatus` returns on the first line
   * when it is, so a fixture that publishes intents and configures a remote still exercises none of
   * the ledger read. This tier passed its own zero-network assertion with the original defect
   * deliberately reinstated, because nothing on the path ever ran — a benchmark measuring a branch
   * it never entered, which is the failure it was written to catch happening to itself.
   */
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const withLedger = `${(await readFile(definitionPath, 'utf8')).trimEnd()}\n`
    + 'ledger:\n'
    + '  enabled: true\n'
    + '  branch: state\n'
    + '  remote: origin\n';

  /**
   * Committed on every branch the benchmark runs from, starting with the one it ends on.
   *
   * Written once while on `DX-001` and then carried into the `main` commit below, it landed on
   * `main` only — and the fixture finishes checked out on `DX-001`, which is where `snapshot --json`
   * reads its definition. The file was right in the repository and absent from the working tree the
   * measurement used.
   */
  await writeFile(definitionPath, withLedger, 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'Enable the ledger on the measured branch']);

  /**
   * Intents published on several branches, which is what makes the ledger read expensive.
   *
   * `remoteLedgerIntents` walks every remote-tracking ref and reads every intent file on it, so the
   * cost is branches × intents. One branch with one intent exercises the code and measures nothing.
   */
  const perBranch = Math.ceil(declared.ledgerIntents / declared.workBranches);
  let published = 0;
  for (let branchIndex = 0; branchIndex < declared.workBranches; branchIndex += 1) {
    const name = branchIndex === 0 ? 'main' : `DX-10${branchIndex}`;
    if (branchIndex > 0) git(root, ['switch', '-q', '-c', name]);
    else {
      git(root, ['switch', '-q', 'main']);
      // `main` predates the ledger commit made on `DX-001`; the remote branches are cut from here.
      await writeFile(definitionPath, withLedger, 'utf8');
    }
    const directory = path.join(root, `singularity/work-items/DX-001/${'context/ledger-intents'}`);
    await mkdir(directory, { recursive: true });
    for (let n = 0; n < perBranch && published < declared.ledgerIntents; n += 1, published += 1) {
      // A UUID-shaped, stable name: the benchmark must build the same fixture on every run.
      const eventId = `0000${String(published).padStart(4, '0')}-0000-4000-8000-000000000000`;
      await writeFile(path.join(directory, `${eventId}.json`),
        `${JSON.stringify({ eventId, subject: { workId: 'DX-001' }, type: 'phase_submitted' }, null, 2)}\n`, 'utf8');
    }
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', `Ledger intents on ${name}`]);
    git(root, ['push', '-q', 'origin', name]);
  }
  git(root, ['switch', '-q', 'DX-001']);
  git(root, ['fetch', '-q', 'origin']);

  /**
   * Initialise the ledger, so the branch it reads actually exists.
   *
   * Enabling it in configuration is not enough: with no `state` branch `ledgerStatus` returns at
   * `if (!ref)` and never reaches `verifyLedger` or `ledgerLog` — the two queries that read the
   * ledger tree. The tier exercised the intent scan and nothing else, and reported zero repository
   * writes for a read path that had not performed the read.
   */
  const initialised = spawnSync(process.execPath,
    [path.join(projectRoot, 'bin/singularity-flow.mjs'), 'ledger', 'init', '--json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_NO_MODEL: '1' } });
  if (initialised.status !== 0) {
    throw new Error(`Connected fixture could not initialise its ledger: ${initialised.stderr || initialised.stdout}`);
  }

  /**
   * A second capability repository, because a workspace is rarely one.
   *
   * The read model resolves every repository a workspace names, so a single-repository fixture
   * measures a fraction of what the extension does on a real workspace.
   */
  for (let index = 1; index < declared.repositories; index += 1) {
    const sibling = path.join(path.dirname(root), `${path.basename(root)}-capability-${index}`);
    git(path.dirname(root), ['clone', '-q', `file://${remote}`, sibling]);
  }
  return { root, remote };
}

/**
 * What the connected fixture actually contains, checked rather than declared.
 *
 * The first version checked remote branches and stopped — which is to say it checked the cheap half
 * and not the half the tier exists for. A fixture whose ledger is switched off looks identical from
 * out here: same branches, same intents on disk, and a read that never touches any of them. So the
 * ledger is asserted through the engine's own resolved configuration rather than by reading the YAML
 * back, because what matters is what `normalizeLedgerConfig` concluded, not what was typed.
 */
function verifyConnectedTopology(root) {
  const declared = fixtureManifest.connected.topology;
  const remoteBranches = git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])
    .split('\n').filter(Boolean).filter((ref) => !ref.endsWith('/HEAD')).length;
  if (remoteBranches !== declared.remoteBranches) {
    throw new Error(`Connected fixture has ${remoteBranches} remote branches; expected ${declared.remoteBranches}.`);
  }
  const probe = spawnSync(process.execPath, [path.join(projectRoot, 'bin/singularity-flow.mjs'), 'snapshot', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (probe.status !== 0) throw new Error(`Connected fixture snapshot failed: ${probe.stderr || probe.stdout}`);
  /**
   * Assert the outcome, not the preconditions.
   *
   * This check grew by one property each time the fixture turned out to under-build its state:
   * first remote branches, then `enabled`, then the branch the definition was committed on — and
   * every time, the property it was still missing was the one the tier existed to exercise. A
   * benchmark that verifies preconditions can only ever be as complete as the last thing that went
   * wrong.
   *
   * So the assertions below are about what the read *produced*. `verification` exists only if
   * `verifyLedger` ran, and `verifyLedger` runs only if the ledger is enabled, initialised, on the
   * measured branch, and holding a readable tree. One check, and it cannot pass on a fixture that
   * skipped the work.
   */
  const ledger = JSON.parse(probe.stdout)?.ledger;
  if (!ledger?.verification) {
    throw new Error('Connected fixture produced no ledger verification, so the read path this tier'
      + ` measures never ran (enabled: ${ledger?.enabled}, initialized: ${ledger?.initialized}).`);
  }
  const intents = Number(ledger.durableIntents ?? 0);
  if (intents < declared.ledgerIntents) {
    throw new Error(`Connected fixture resolved ${intents} durable intents; expected at least ${declared.ledgerIntents}.`);
  }
  return { remoteBranches, durableIntents: intents, ledgerEntries: ledger.verification.entries ?? 0 };
}

/**
 * Every dimension the manifest declares, counted rather than assumed.
 *
 * This returned three keys while the manifest declared eight, and `report.topology` is exactly this
 * return value — so `assertBaselineCandidate`, which loops over all eight, compared `undefined`
 * against `1` for `stories` and threw. `--write-baseline` and `--accept-report` could therefore
 * never succeed, `accepted-baseline.json` stayed `"unestablished"` for as long as it has existed,
 * and the twenty-percent comparable-baseline gate that `docs/DX-PERFORMANCE.md` documents has never
 * once run. Only absolute budgets were ever evaluated.
 *
 * The five that were missing are the ones that make a repository expensive rather than merely
 * large: Stories and Initiatives are what the subject index walks per ref, and a benchmark that
 * cannot say how many of them the fixture holds cannot claim to have measured a read path.
 */
function verifyTopology(root, declared = fixtureManifest.topology) {
  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const under = (pattern) => tracked.filter((file) => pattern.test(file)).length;
  const actual = {
    trackedFiles: tracked.length,
    untrackedFiles: Number(git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).length),
    localBranches: Number(git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads']).split('\n').filter(Boolean).length),
    // What `buildRepositorySubjectIndex` scans: one `workflow.json` per Story, one `state.json` per
    // Initiative. Counted from the index rather than the working tree, so a fixture cannot declare a
    // Story it never committed.
    stories: under(/^singularity\/work-items\/[^/]+\/workflow\.json$/),
    initiatives: under(/^singularity\/initiatives\/[^/]+\/state\.json$/),
    specifications: under(/^singularity\/work-items\/[^/]+\/context\/spec-indexes\/[^/]+\.json$/),
    knowledgeDocuments: under(/^singularity\/knowledge\/.+/),
    /**
     * Whether this repository already carries machine-local Singularity Flow state.
     *
     * `docs/DX-PERFORMANCE.md` calls the fixture's condition "no prebuilt local subject index", and
     * nothing persists that index — it is rebuilt from refs and the working tree on every read. What
     * the phrase names is the state under the Git directory that would make a first read behave like
     * a warm one. Verified before any command runs, so a benchmark cannot warm its own fixture and
     * then describe it as cold.
     */
    localSubjectIndex: existsSync(path.join(root, '.git', 'singularity-flow')) ? 'present' : 'absent'
  };
  for (const [key, expected] of Object.entries(declared)) {
    if (actual[key] === undefined) throw new Error(`Reference fixture declares ${key}, which nothing counts.`);
    if (actual[key] !== expected) throw new Error(`Reference fixture ${key} is ${actual[key]}; expected ${expected}.`);
  }
  return actual;
}

function invoke(root, args, { network = false, probe = false } = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [path.join(projectRoot, 'bin/singularity-flow.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_NO_MODEL: '1',
      /**
       * Blocking the network is right for the tier that has no remote, and wrong for the one that
       * does. `SINGULARITY_FLOW_NO_NETWORK` makes `run()` return immediately without spawning, so a
       * fetch on the read path costs nothing and passes every budget — which is part of why this
       * benchmark watched the read model fetch six times per snapshot and reported it as fast.
       */
      ...(network ? {} : { SINGULARITY_FLOW_NO_NETWORK: '1' }),
      ...(probe ? { SINGULARITY_FLOW_SUBPROCESS_PROBE: '1' } : {})
    }
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return { durationMs, stderr: result.stderr ?? '' };
}

function timed(root, args, options) {
  return invoke(root, args, options).durationMs;
}

/**
 * Network subprocesses a command actually spawned, counted from the probe report. `[UXH:REQ-120]`
 *
 * The probe prints one row per command verb. `git fetch`, `git push`, `git ls-remote` and anything
 * through `gh` are the ones that leave this machine; everything else is local object reading, which
 * a read path is entitled to do as much of as it likes.
 */
const NETWORK_VERBS = [/^git fetch\b/, /^git push\b/, /^git ls-remote\b/, /^git clone\b/, /^gh\b/];

/**
 * Commands that change the repository, which a read must not run. `[UXH:REQ-120]`
 *
 * The ledger's read queries each built a temporary worktree to read a few JSON files, so answering
 * a question wrote an entry under `.git/worktrees`, took the index lock, and created a branch that
 * was deleted on the way out. The latency was the smaller objection; an interrupted read leaving
 * debris, and two concurrent reads contending for a lock, were the larger one.
 *
 * Counted rather than timed for the same reason the network calls are: this is a statement about
 * what a read path is allowed to do, and it holds regardless of how fast the machine is.
 */
const MUTATING_VERBS = [/^git worktree\b/, /^git branch -D\b/, /^git commit\b/, /^git add\b/,
  /^git checkout\b/, /^git switch\b/, /^git update-ref\b/, /^git reset\b/];

function countProbeRows(stderr, patterns) {
  const rows = stderr.split('\n')
    .map((line) => /^\s*(\d+)x\s+[\d.]+\s*ms\s+(.*)$/.exec(line.trim()))
    .filter(Boolean);
  let calls = 0;
  const offenders = [];
  for (const [, count, verb] of rows) {
    if (!patterns.some((pattern) => pattern.test(verb))) continue;
    calls += Number(count);
    offenders.push(`${count}x ${verb}`);
  }
  return { calls, offenders };
}

const countNetworkCalls = (stderr) => countProbeRows(stderr, NETWORK_VERBS);
const countMutatingCalls = (stderr) => countProbeRows(stderr, MUTATING_VERBS);

/**
 * How many subprocesses a command ran, which is the one number that means the same on every host.
 *
 * A time budget is met by a fast machine and blown by a loaded one, so it cannot state a complexity
 * claim: "this read does not get more expensive as the repository grows" is about the count, not the
 * clock. The read path spawns two Git processes per (branch × Story) pair, and on a fixture with one
 * Story and four branches that is invisible in both the count and the time.
 */
function countSubprocesses(stderr) {
  const match = /^subprocesses:\s+(\d+)\s+calls/m.exec(stderr);
  if (!match) {
    throw new Error('The subprocess probe produced no summary, so nothing counted the spawns this'
      + ' tier exists to count. SINGULARITY_FLOW_SUBPROCESS_PROBE was set and not honoured.');
  }
  return Number(match[1]);
}

const commands = {
  about: ['about'],
  status: ['status', 'DX-001', '--json'],
  nextsteps: ['nextsteps', 'DX-001', '--json'],
  snapshot: ['snapshot', '--include', 'repository'],
  /**
   * What the VS Code extension runs on activation and after ordinary lifecycle actions. Heavy
   * configuration, integration and diagnostic slices are loaded only when their panels open.
   */
  snapshotUi: ['snapshot', '--include', 'repository', '--include', 'lifecycle', '--include', 'capabilities', '--json'],
  /** Compatibility/full-domain read, retained and measured because external consumers may use it. */
  snapshotFull: ['snapshot', '--json'],
  /**
   * Read-only commands a person waits on, none of which anything measured. `[UXH:REQ-120]`
   *
   * The four budgeted commands above are the four served by their own lazy modules. Eighty-one of
   * the ninety-eight registered commands are not: they dispatch to `commands/legacy.mjs`, which
   * fronts a 264-module static closure, and ten of those are reads. So the commands with a measured
   * budget were exactly the commands that had been made fast, and the ones carrying ~120 ms of
   * module load before doing anything were the ones nobody was allowed to notice.
   *
   * These four are the reads that run on this fixture without arguments or setup. `doctor` and
   * `validate` refuse it, `choices` needs a subcommand, and `show`/`progress`/`receipt` need a
   * handle — worth adding when the fixture can satisfy them, rather than reshaping the fixture
   * around the benchmark.
   */
  help: ['help'],
  inbox: ['inbox'],
  guide: ['guide'],
  logs: ['logs']
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
  const referenceSubprocesses = {};
  for (const [name, args] of Object.entries(commands)) {
    timed(fixture, args); // discarded warm-up
    const values = Array.from({ length: samples }, () => timed(fixture, args));
    commandResults[name] = summarizeSamples(values);
    // One probed run per command, so the scale tier below has something to compare a count against.
    referenceSubprocesses[name] = countSubprocesses(invoke(fixture, args, { probe: true }).stderr);
    failures.push(...evaluateLatency(name, commandResults[name], fixtureManifest.budgets[name], comparableBaseline ? acceptedBaseline.commands[name] : null));
  }
  /**
   * The connected tier, and the assertion a time budget cannot make. `[UXH:REQ-120]`
   *
   * `networkCalls` is the point of this tier. The read path is required to make none, and that is a
   * structural fact rather than a speed: it holds on a fast runner and a slow one, on a good network
   * and no network, which is exactly what a budget could not say. `snapshot --json` fetched six
   * times per call for as long as it did partly because nothing here was in a position to notice.
   */
  const connected = await createConnectedFixture();
  let connectedResults = null;
  try {
    const connectedTopology = verifyConnectedTopology(connected.root);
    timed(connected.root, commands.snapshotFull, { network: true }); // discarded warm-up
    const values = Array.from({ length: Math.min(samples, 5) },
      () => timed(connected.root, commands.snapshotFull, { network: true }));
    const summary = summarizeSamples(values);
    const probed = invoke(connected.root, commands.snapshotFull, { network: true, probe: true });
    const network = countNetworkCalls(probed.stderr);
    const allowed = fixtureManifest.connected.networkCalls.snapshotFull;
    if (network.calls > allowed) {
      failures.push(`connected.snapshotFull made ${network.calls} network call(s) on a read path`
        + ` (allowed ${allowed}): ${network.offenders.join(', ')}`);
    }
    const mutating = countMutatingCalls(probed.stderr);
    const allowedMutations = fixtureManifest.connected.repositoryWrites.snapshotFull;
    if (mutating.calls > allowedMutations) {
      failures.push(`connected.snapshotFull ran ${mutating.calls} repository-mutating command(s) on a`
        + ` read path (allowed ${allowedMutations}): ${mutating.offenders.join(', ')}`);
    }
    failures.push(...evaluateLatency('connected.snapshotFull', summary,
      fixtureManifest.connected.budgets.snapshotFull, null));
    connectedResults = {
      topology: connectedTopology, snapshotFull: summary,
      networkCalls: network.calls, repositoryWrites: mutating.calls
    };
  } finally {
    await rm(connected.root, { recursive: true, force: true });
    await rm(connected.remote, { recursive: true, force: true });
  }

  /**
   * The growth tier: the same commands on a repository forty times the size. `[UXH:REQ-120]`
   *
   * Every tier above measures one point. A point says `snapshot --include repository` took 102 ms;
   * it cannot say whether that is 102 ms on any repository or 102 ms on a five-hundred-file one, and
   * those are different products. The reference fixture holds one Story and four branches, so a read
   * path that costs branches × Stories reads as constant here and as minutes on a real portfolio.
   *
   * Enforced on the **subprocess count**, not the clock. A count is the same on a fast runner and a
   * loaded one, so it can carry a complexity claim that a time budget cannot: a read whose spawn
   * count follows the repository is superlinear by construction, whatever the wall clock says on the
   * day. Times are still reported, because a growth rate is worth reading even when it passes.
   */
  const scale = fixtureManifest.scale;
  let scaleResults = null;
  if (scale && !process.argv.includes('--skip-scale')) {
    const scaleRoot = await createFixture(scale.topology);
    try {
      const scaleTopology = verifyTopology(scaleRoot, scale.topology);
      const scaled = {};
      for (const name of scale.commands) {
        const args = commands[name];
        timed(scaleRoot, args); // discarded warm-up
        const values = Array.from({ length: Math.min(samples, 5) }, () => timed(scaleRoot, args));
        const subprocesses = countSubprocesses(invoke(scaleRoot, args, { probe: true }).stderr);
        const reference = referenceSubprocesses[name];
        const growth = reference ? subprocesses / reference : null;
        scaled[name] = { ...summarizeSamples(values), subprocesses, referenceSubprocesses: reference, subprocessGrowth: growth };

        const allowed = scale.subprocessGrowth?.[name];
        if (allowed !== undefined && growth !== null && growth > allowed) {
          failures.push(`scale.${name} ran ${subprocesses} subprocesses against ${reference} on the`
            + ` reference fixture (${growth.toFixed(2)}x, allowed ${allowed}x) while the repository grew`
            + ` ${(scale.topology.trackedFiles / fixtureManifest.topology.trackedFiles).toFixed(0)}x.`
            + ' A read whose subprocess count follows the repository is superlinear.');
        }
        if (scale.budgets?.[name]) {
          failures.push(...evaluateLatency(`scale.${name}`, scaled[name], scale.budgets[name], null));
        }
      }
      scaleResults = { topology: scaleTopology, commands: scaled };
    } finally {
      await rm(scaleRoot, { recursive: true, force: true });
    }
  }

  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    connected: connectedResults,
    scale: scaleResults,
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
    if (connectedResults) {
      const { snapshotFull: connectedSnapshot, networkCalls, topology: connectedTopology } = connectedResults;
      console.log(`\nconnected tier · remote + ledger · ${connectedTopology.remoteBranches} remote branches`);
      console.log(`snapshotFull p50 ${connectedSnapshot.p50Ms.toFixed(1)}ms · p95 ${connectedSnapshot.p95Ms.toFixed(1)}ms`
        + ` · network calls: ${networkCalls} · repository writes: ${connectedResults.repositoryWrites}`);
    }
    if (scaleResults) {
      const { topology: scaleTopology, commands: scaled } = scaleResults;
      const factor = (scaleTopology.trackedFiles / topology.trackedFiles).toFixed(0);
      console.log(`\nscale tier · ${scaleTopology.trackedFiles} files · ${scaleTopology.stories} Stories`
        + ` · ${scaleTopology.localBranches} branches · ${factor}x the reference repository`);
      for (const [name, result] of Object.entries(scaled)) {
        // The growth rates, not the absolutes: the question is what follows the repository.
        console.log(`${name.padEnd(12)} p50 ${result.p50Ms.toFixed(1)}ms · p95 ${result.p95Ms.toFixed(1)}ms`
          + ` · subprocesses ${result.subprocesses} vs ${result.referenceSubprocesses}`
          + ` (${result.subprocessGrowth === null ? 'n/a' : `${result.subprocessGrowth.toFixed(2)}x`})`);
      }
    }
    if (failures.length) console.error(`\n${failures.join('\n')}`);
    if (!comparableBaseline) console.warn('\nWarning: no accepted baseline matches this Node/platform/architecture; absolute budgets were still evaluated.');
  }
  if (enforce && failures.length) process.exitCode = 1;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
