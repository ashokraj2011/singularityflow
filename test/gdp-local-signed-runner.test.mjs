import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_RUNNER_ATTESTATION_FIELDS, resolveLocalRunnerCommand,
  verifyLocalRunnerAttestationWithSigner
} from '../src/delivery-modes/local-signed-runner.mjs';
import { currentSchemaVersion, familyForStoredPath } from '../src/schema-migrations.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'bin', 'singularity-flow.mjs');
const digest = (character) => `sha256:${character.repeat(64)}`;

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_NETWORK: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'GDP Local Runner Tester'
    }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result;
}
function git(root, ...args) { return execute('git', args, root); }
function sflow(root, ...args) { return execute(process.execPath, [cli, ...args], root); }
function sflowFailure(root, ...args) {
  return execute(process.execPath, [cli, ...args], root, { allowFailure: true });
}

test('local runner accepts only one configured shell-free model-free command', () => {
  const safe = resolveLocalRunnerCommand({ phases: { implementation: { qualityCommands: [{
    id: 'tests', argv: ['npm', 'test'], modelPolicy: 'never'
  }] } } }, 'implementation', 'tests');
  assert.deepEqual(safe.argv, ['npm', 'test']);
  assert.equal(safe.workingDirectory, '.');
  assert.throws(() => resolveLocalRunnerCommand({ phases: { implementation: {
    qualityCommands: [{ id: 'tests', command: 'npm test', modelPolicy: 'never' }]
  } } }, 'implementation', 'tests'), /shell-free argv/);
  assert.throws(() => resolveLocalRunnerCommand({ phases: { implementation: {
    qualityCommands: [{ id: 'tests', argv: ['npm', 'test'], modelPolicy: 'unknown' }]
  } } }, 'implementation', 'tests'), /modelPolicy: never/);
});

test('local runner plans, executes in a child, signs, and verifies without gate authority', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-local-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'GDP Local Runner Tester');
  git(root, 'config', 'user.email', 'gdp-local-runner@example.com');
  sflow(root, 'init');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize local runner fixture');

  const created = JSON.parse(sflow(
    root, 'delivery', 'local-runner-create', '--signer', 'developer-local', '--json'
  ).stdout);
  assert.equal(created.data.gateEligible, false);
  const planned = JSON.parse(sflow(
    root, 'delivery', 'local-runner-plan', '--signer', 'developer-local',
    '--work-id', 'GDP-LOCAL', '--phase', 'poc-test-generation',
    '--command', 'git-diff-check', '--proof-subject', digest('a'),
    '--candidate', digest('b'), '--json'
  ).stdout);
  const planFile = path.join(root, 'runner-plan.json');
  assert.deepEqual(planned.data.plan.command.argv, ['git', 'diff', '--check']);
  assert.equal(planned.data.plan.command.modelPolicy, 'never');
  await writeFile(planFile, `${JSON.stringify(planned, null, 2)}\n`);
  const executed = JSON.parse(sflow(
    root, 'delivery', 'local-runner-run', '--plan', 'runner-plan.json',
    '--confirm-plan', planned.data.plan.planSha256, '--json'
  ).stdout);
  const attestation = executed.data.attestation;
  assert.equal(attestation.outcome, 'passed');
  assert.equal(attestation.assurance, 'developer-local-signed');
  assert.equal(attestation.authority, 'developer-local');
  assert.equal(attestation.gateEligible, false);
  assert.equal(attestation.consumedByLifecycle, false);
  assert.deepEqual(Object.keys(attestation).sort(), [...LOCAL_RUNNER_ATTESTATION_FIELDS].sort());
  assert.doesNotMatch(JSON.stringify(attestation), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(currentSchemaVersion('local-runner-attestation'), 1);
  assert.equal(familyForStoredPath(
    `singularity/work-items/GDP-LOCAL/gdp/evidence/local-runner-attestation/${'a'.repeat(64)}.json`
  )?.id, 'local-runner-attestation');
  assert.match(executed.data.output.path,
    /^singularity\/work-items\/GDP-LOCAL\/gdp\/evidence\/local-runner-attestation\/[a-f0-9]{64}\.json$/);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, executed.data.output.path), 'utf8')),
    attestation
  );

  const attestationFile = path.join(root, 'runner-attestation.json');
  await writeFile(attestationFile, `${JSON.stringify(executed, null, 2)}\n`);
  const verified = JSON.parse(sflow(
    root, 'delivery', 'local-runner-verify', '--attestation-file',
    'runner-attestation.json', '--signer', 'developer-local', '--json'
  ).stdout);
  assert.equal(verified.data.status, 'verified');
  assert.equal(verified.data.gateEligible, false);

  const altered = structuredClone(attestation);
  altered.outcome = 'failed';
  await assert.rejects(
    verifyLocalRunnerAttestationWithSigner(root, altered, 'developer-local'),
    /self hash|signature/
  );
  assert.equal((await readFile(planFile, 'utf8')).includes(root), false);
});

test('local runner confirmation and stale-plan checks fail before executing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-local-runner-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'GDP Local Runner Tester');
  git(root, 'config', 'user.email', 'gdp-local-runner@example.com');
  sflow(root, 'init');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'initialize');
  sflow(root, 'delivery', 'local-runner-create', '--signer', 'developer-local', '--json');
  const planned = JSON.parse(sflow(
    root, 'delivery', 'local-runner-plan', '--signer', 'developer-local',
    '--work-id', 'GDP-LOCAL', '--phase', 'poc-test-generation',
    '--command', 'git-diff-check', '--proof-subject', digest('a'),
    '--candidate', digest('b'), '--json'
  ).stdout);
  await writeFile(path.join(root, 'runner-plan.json'), `${JSON.stringify(planned, null, 2)}\n`);
  const refused = sflowFailure(root, 'delivery', 'local-runner-run', '--plan',
    'runner-plan.json', '--confirm-plan', digest('f'), '--json');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /GDP_LOCAL_RUNNER_CONFIRMATION_INVALID/);
  await writeFile(path.join(root, 'changed.txt'), 'changed\n');
  git(root, 'add', 'changed.txt'); git(root, 'commit', '-m', 'change candidate');
  const stale = sflowFailure(root, 'delivery', 'local-runner-run', '--plan',
    'runner-plan.json', '--confirm-plan', planned.data.plan.planSha256,
    '--json');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /GDP_LOCAL_RUNNER_PLAN_STALE/);
});
