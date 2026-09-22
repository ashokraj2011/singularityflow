import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveOperation } from '../src/command-registry.mjs';
import { skillForCommandLine } from '../src/command-skills.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function runCli(cwd, args, envOverrides = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...envOverrides }
  });
}

function parsedFailure(result) {
  const text = result.stdout.trim() || result.stderr.trim();
  assert.ok(text, 'CLI refusal emits a bounded diagnostic');
  try { return JSON.parse(text); } catch { return { text }; }
}

test('revision-check operation admission is closed and preserves read-versus-mutation boundaries', () => {
  for (const action of ['capabilities', 'plan', 'status', 'result']) {
    const operation = resolveOperation({
      requestedCommand: 'revision', positionals: ['revision', 'checks', action], options: {}
    });
    assert.equal(operation.id, `revision.checks.${action}`);
    assert.equal(operation.classification, 'read');
    assert.equal(operation.modelPolicy, 'never');
  }
  const run = resolveOperation({
    requestedCommand: 'revision', positionals: ['revision', 'checks', 'run'], options: {}
  });
  assert.equal(run.id, 'revision.checks.run');
  assert.equal(run.classification, 'mutation');
  assert.equal(run.modelPolicy, 'never');
  for (const action of ['cancel', 'retry', 'recover']) {
    assert.throws(() => resolveOperation({
      requestedCommand: 'revision', positionals: ['revision', 'checks', action], options: {}
    }), (error) => error?.code === 'UNKNOWN_SUBCOMMAND', action);
  }
});

test('revision-check commands route to the dedicated zero-model Copilot skill', async () => {
  for (const action of ['capabilities', 'plan', 'status', 'result', 'run']) {
    assert.equal(
      skillForCommandLine(`singularity-flow revision checks ${action} trailing`),
      'sf-revision-checks', action
    );
  }
  const skill = await readFile(
    path.join(packageRoot, 'plugin', 'skills', 'sflow-revision-checks', 'SKILL.md'), 'utf8'
  );
  assert.match(skill, /^name: sflow-revision-checks$/m);
  assert.match(skill, /disable-model-invocation:\s*true/);
  assert.match(skill, /revision checks capabilities --json/);
  assert.match(skill, /revision checks plan --json/);
  assert.match(skill, /revision checks status \[RUN-ID\] --json/);
  assert.match(skill, /revision checks result <RUN-ID> --json/);
  assert.match(skill, /--plan sha256:<PLAN> --confirm sha256:<PLAN>/);
  assert.match(skill, /Do not execute `singularity-flow revision checks run`/i);
  assert.match(skill, /Cancel, retry, and recovery are not public/i);
  assert.match(skill, /establishes neither a passing repository test nor Testing\/Verification/i);
});

test('the revision-check participant uses its dedicated local argument-aware renderer', async () => {
  const manifest = JSON.parse(await readFile(
    path.join(packageRoot, 'apps', 'vscode', 'src', 'participant-commands.json'), 'utf8'
  ));
  const declared = manifest.find((entry) => entry.id === 'revision-checks');
  assert.deepEqual({
    transport: declared?.transport,
    runtime: declared?.runtime,
    acceptsArguments: declared?.acceptsArguments,
    confirmation: declared?.confirmation,
    skill: declared?.skill
  }, {
    transport: 'local', runtime: null, acceptsArguments: true,
    confirmation: 'separate-guarded-flow', skill: '/sf-revision-checks'
  });
  assert.equal(declared?.requiresRepository, false,
    'installation-level capability discovery must work before repository selection');
  assert.ok(declared.keywords.includes('revision checks'));
  assert.ok(declared.keywords.includes('browser revision checks'));
});

test('capabilities is a machine-local read that separates foundations from unavailable authority', async (t) => {
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'sflow-brl-capabilities-home-'));
  t.after(() => rm(isolatedHome, { recursive: true, force: true }));
  const result = runCli(os.tmpdir(), ['revision', 'checks', 'capabilities', '--json'], {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
    APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(isolatedHome, 'missing-active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(isolatedHome, 'missing-workspaces.json')
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.operation.id, 'revision.checks.capabilities');
  assert.equal(output.operation.classification, 'read');
  assert.deepEqual(output.effects, {
    stateChanged: false, filesChanged: false,
    publicationCreated: false, externalSystemsChanged: false
  });
  assert.equal(output.data.foundations.closedCheckContract, 'available');
  assert.equal(output.data.foundations.immutableReceiptStore, 'available-local-private');
  assert.equal(output.data.foundations.assertionProjection, 'available-observation-only');
  assert.equal(output.data.foundations.deterministicVisualComparison, 'unavailable');
  assert.equal(output.data.foundations.approvedRunnerProviderContract,
    'available-fail-closed');
  assert.equal(output.data.foundations.authenticatedRunnerReceiptStore,
    'available-requires-sgos-cab-trust');
  assert.deepEqual(output.data.approvedRunnerBoundary, {
    providerId: 'sflow-isolated-runner',
    providerProtocol: 'revision-isolated-runner-v1',
    apiVersion: 1,
    authoritySource: 'sgos-cab-approved-configuration',
    activationStatus: 'disabled-pending-authority-revalidation-and-adapter-wiring',
    executionEnabled: false,
    testingVerificationEstablished: false,
    publicationEligibilityEstablished: false
  });
  assert.equal(output.data.unavailable.visualComparator, 'BRL_VISUAL_COMPARATOR_UNAVAILABLE');
  assert.equal(output.data.unavailable.executor, 'REV_CODE_CHECK_EXECUTOR_UNAVAILABLE');
  assert.equal(output.data.unavailable.approvedRunnerProvider,
    'REV_RUNNER_PROVIDER_UNAVAILABLE');
  assert.equal(output.data.unavailable.approvedRunnerTrust,
    'REV_RUNNER_AUTHORITY_UNAVAILABLE');
  assert.equal(
    output.data.unavailable.candidateUnderTestProvenance,
    'BRL_CANDIDATE_UNDER_TEST_UNAVAILABLE'
  );
  assert.equal(output.data.unavailable.publication, 'BRL_PUBLICATION_AUTHORITY_UNAVAILABLE');
  assert.equal(output.data.actions.run, 'unavailable-no-approved-runner');
  assert.equal(output.data.publicationEligibilityEstablished, false);
});

test('public CLI refuses caller-selected checks and cannot run without exact confirmation', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-brl-public-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-q', '-b', 'main'], {
    cwd: repository, encoding: 'utf8'
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const selected = runCli(repository, [
    'revision', 'checks', 'plan', '--candidate', 'CANDIDATE-1', '--json'
  ]);
  assert.notEqual(selected.status, 0);
  const selectionFailure = parsedFailure(selected);
  assert.match(JSON.stringify(selectionFailure), /REV_BROWSER_CHECK_OPTION_INVALID/);
  assert.match(JSON.stringify(selectionFailure), /does not accept --candidate/);

  const unconfirmed = runCli(repository, ['revision', 'checks', 'run', '--json']);
  assert.notEqual(unconfirmed.status, 0);
  const confirmationFailure = parsedFailure(unconfirmed);
  assert.match(JSON.stringify(confirmationFailure), /REV_BROWSER_CONFIRMATION_REQUIRED/);
  assert.match(JSON.stringify(confirmationFailure), /same full SHA-256 digest/);

  for (const action of ['cancel', 'retry', 'recover']) {
    const refused = runCli(repository, ['revision', 'checks', action, '--json']);
    assert.notEqual(refused.status, 0, action);
    assert.match(JSON.stringify(parsedFailure(refused)), /UNKNOWN_SUBCOMMAND/, action);
  }
});
