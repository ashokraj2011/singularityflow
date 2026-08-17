/**
 * The pack keeps to itself. `[SPK:CON-052]` `[SPK:CON-053]` `[SPK:CON-054]` `[SPK:CON-055]`
 *
 * Four clauses say the same thing from four angles: the pack applies automatically only to new
 * Stories created with `spec-driven-standard`, existing Stories keep their pinned behaviour, no
 * migration reinterprets an existing artifact as an SPK record, and a repository with the
 * specification features switched off behaves exactly as it did before.
 *
 * Nothing enforced that. Every increment was verified from the inside — a spec-driven Story doing
 * the new thing correctly — and none of it asked what the pack does to the Stories already running
 * beside it. Those are the ones that cannot be re-run if the answer is wrong.
 *
 * The mechanism that actually protects them turns out to be a single property, and it is not
 * declared anywhere: **every SPK policy is attached to a phase id that only `spec-driven-standard`
 * uses.** Artifact sets, marker enforcement and specification quality all hang off `specification`,
 * `planning` and `release`. `implementation` and `verification` are shared with `feature`, `bugfix`
 * and `chore`, and they carry none of it.
 *
 * That is a coherent design — in this product a phase id *is* the unit of policy — but it holds by
 * where three keys happen to sit, not by construction. `resolvedArtifactSet` reads
 * `definition.phases[phase.id].artifactSet` with no reference to the work type, so an artifact set
 * added to `implementation` would silently apply to three legacy work types, hash their bundles,
 * and bind their approvals to a set nobody opted into. The first test below is the missing
 * declaration; the second checks it is true of the running product and not just of the YAML.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

/** Every key that makes a phase part of the spec-driven pack. */
const SPK_PHASE_POLICY = ['artifactSet', 'specificationQuality', 'convergence', 'constitution'];

function shell(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_LOG_CONSOLE: 'error' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\nexit ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

const git = (cwd, ...args) => shell('git', args, cwd).stdout.trim();
const sflow = (cwd, args, options) => shell(process.execPath, [CLI, ...args], cwd, options);

async function write(root, relative, contents) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
}

test('no spec-driven policy hangs off a phase a legacy work type also runs', async () => {
  const definition = YAML.parse(await readFile(path.join(packageRoot, 'templates/workflow.yml'), 'utf8'));
  const specDriven = new Set(definition.workTypes['spec-driven-standard'].phases);

  const shared = new Set();
  for (const [workType, config] of Object.entries(definition.workTypes)) {
    if (workType === 'spec-driven-standard') continue;
    for (const phase of config.phases ?? []) if (specDriven.has(phase)) shared.add(phase);
  }
  // If this is ever empty the test has stopped testing anything — the work types would have to have
  // been renamed apart, and the invariant below would pass vacuously.
  assert.ok(shared.size > 0, 'no phase is shared, so this guard proves nothing');
  assert.deepEqual([...shared].sort(), ['implementation', 'verification']);

  for (const phase of shared) {
    const config = definition.phases?.[phase] ?? {};
    const attached = SPK_PHASE_POLICY.filter((key) => config[key] !== undefined);
    if (config.clarification?.markers) attached.push('clarification.markers');
    assert.deepEqual(attached, [], `phase '${phase}' carries ${attached.join(', ')}, and feature, bugfix and chore Stories run through it`);
  }

  // Stated the other way round, so that adding policy to a brand-new shared phase fails here too.
  for (const [phase, config] of Object.entries(definition.phases ?? {})) {
    if (!config || specDriven.has(phase)) continue;
    const attached = SPK_PHASE_POLICY.filter((key) => config[key] !== undefined);
    if (config.clarification?.markers) attached.push('clarification.markers');
    assert.deepEqual(attached, [], `phase '${phase}' is outside spec-driven-standard but carries ${attached.join(', ')}`);
  }

  // And the fast path stays a property of the work type that declares it.
  for (const [workType, config] of Object.entries(definition.workTypes)) {
    if (workType === 'spec-driven-standard') continue;
    assert.equal(config.fastPath, undefined, `work type '${workType}' declares a fast path`);
  }
});

test('a legacy Story runs through the shared phases untouched by the pack', async (t) => {
  t.diagnostic('CON-052/053/055 against the real binary, in a repository that has the whole pack.');

  // A remote, because a governed publication pushes: without one the transaction retains the commit
  // locally and reports a push failure, which would fail this test for a reason it is not about.
  const origin = await mkdtemp(path.join(os.tmpdir(), 'sflow-coexist-origin-'));
  shell('git', ['init', '-q', '--bare', '-b', 'main', '.'], origin);

  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-coexist-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Coexistence');
  git(root, 'config', 'user.email', 'coexist@example.invalid');
  await write(root, 'README.md', '# Legacy\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  // `init` leaves the governed definition uncommitted on a Work-ID branch so the base branch is
  // never touched by accident; seeding `main` with it is therefore a deliberate second step, and
  // `start` refuses without it.
  sflow(root, ['init', '--work-id', 'SEED', '--base', 'main']);
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'governance');
  git(root, 'checkout', '-q', 'main');
  git(root, 'checkout', '-q', 'SEED', '--', 'singularity', '.github');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'governance');
  git(root, 'push', '-q', 'origin', 'main');

  // `chore` shares `implementation` and `verification` with spec-driven-standard, so it is the work
  // type most exposed to a policy leak through a phase id.
  const WORK = 'CHORE-1';
  sflow(root, ['start', WORK, '--from-branch', 'main', '--work-type', 'chore', '--title', 'Rotate the log retention setting',
    '--description', 'Retention is 7 days and the policy says 30.']);

  const workflowOf = async () =>
    JSON.parse(await readFile(path.join(root, `singularity/work-items/${WORK}/workflow.json`), 'utf8'));

  // Pinned at Story start: a work type with no constitution configured must not acquire one.
  assert.equal((await workflowOf()).constitutionPin, undefined, 'a chore Story was pinned to a constitution');

  /**
   * An unresolved marker in a legacy artifact.
   *
   * `markers: block` is real policy in this repository — it is what stops a spec-driven publication.
   * A chore intake is not a specification, so the same sentence must pass straight through. This is
   * `[SPK:CON-054]` in its most concrete form: text that means something to the pack must not be
   * reinterpreted as an SPK record just because it appears in a repository that has the pack.
   */
  await write(root, `singularity/work-items/${WORK}/artifacts/intake/intake.md`, [
    '# Intake — Rotate the log retention setting', '',
    'Log retention is set to 7 days. The operations policy asks for 30. This is a configuration',
    'change with no code path and no user-visible behaviour.', '',
    '[NEEDS CLARIFICATION: does the audit log follow the same retention?]', ''
  ].join('\n'));

  sflow(root, ['artifact', 'scan', '--phase', 'intake']);
  const published = sflow(root, ['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place'],
    { allowFailure: true });
  assert.equal(published.status, 0, `an unresolved marker blocked a chore intake:\n${published.output}`);

  const afterIntake = (await workflowOf()).phases.intake;
  assert.equal(afterIntake.artifactSet, undefined, 'a chore intake was catalogued into an artifact set');
  assert.equal(afterIntake.specificationQuality, undefined, 'a chore intake carries a specification-quality record');
  assert.equal(afterIntake.markers, undefined, 'a chore intake recorded clarification markers');

  // The shared phase id, which is where a leak would actually land.
  sflow(root, ['submit', 'intake', '--skip-checks']);
  sflow(root, ['approve', 'intake', '--yes']);
  assert.equal((await workflowOf()).currentPhase, 'implementation');

  await write(root, `singularity/work-items/${WORK}/artifacts/implementation/implementation-summary.md`, [
    '# Implementation — Rotate the log retention setting', '',
    'Changed the retention setting from 7 to 30 days in the deployment configuration. No source',
    'files were touched and no migration is required. Verified by reading back the applied value',
    'in the staging environment.', ''
  ].join('\n'));
  sflow(root, ['artifact', 'scan', '--phase', 'implementation']);
  sflow(root, ['phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place']);

  const implementation = (await workflowOf()).phases.implementation;
  assert.equal(implementation.artifactSet, undefined,
    'the shared implementation phase catalogued an artifact set for a chore Story');
  assert.equal(implementation.convergence, undefined, 'a chore Story acquired a convergence record');

  // `[SPK:CON-009]`: the five verbs are an addition. A work type that does not declare them refuses
  // them by name and keeps every advanced command it had.
  const specify = sflow(root, ['specify'], { allowFailure: true });
  assert.notEqual(specify.status, 0, 'the fast path ran for a work type that does not declare one');
  assert.match(specify.output, /fast path/i);

  for (const command of [['status'], ['phase', 'show'], ['phase', 'show', 'intake']]) {
    const result = sflow(root, command, { allowFailure: true });
    assert.equal(result.status, 0, `'${command.join(' ')}' no longer works for a legacy Story:\n${result.output}`);
  }
});
