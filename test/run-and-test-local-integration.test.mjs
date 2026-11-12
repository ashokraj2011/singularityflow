import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { normalizeExternalCommand } from '../src/external-command-policy.mjs';
import { environmentQualityCommandBlock, environmentQualityCommandGate } from '../src/state.mjs';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const SECRET = 'qa-token-not-for-git-8c41';
const identity = {
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  sourceTreeSha256: `sha256:${'a'.repeat(64)}`,
  startedAt: '2026-10-19T00:00:00.000Z'
};
const boundEnvironment = (name) => ({
  status: 'bound', missing: [],
  environment: {
    name, declarationSha256: `sha256:${'d'.repeat(64)}`, boundNames: ['API_TOKEN'], endpointsSha256: null,
    secretsPresent: ['API_TOKEN'], source: 'private-binding', bindingRevision: 'envb_00000000-0000-4000-8000-000000000001',
    fingerprintSha256: `sha256:${'f'.repeat(64)}`
  }
});

test('policy off: an environment-linked command is blocked exactly as before, and the refusal names the policy switch', async () => {
  const policy = normalizeExternalCommand({ id: 'integration-tests', kind: 'test', argv: ['npm', 'run', 'it'], modelPolicy: 'never' });
  const resolver = async (_root, environment, options) => {
    assert.equal(environment, null);
    assert.deepEqual(options, { commandId: 'integration-tests' });
    return { ...boundEnvironment('qa'), processEnvironment: { API_TOKEN: SECRET } };
  };
  const block = await environmentQualityCommandBlock('/not-used', policy, { ...identity, resolver });
  const gate = await environmentQualityCommandGate('/not-used', policy, { ...identity, resolver });
  assert.equal(gate.run, null);
  assert.deepEqual({ ...gate.block, completedAt: null }, { ...block, completedAt: null });
  assert.equal(block.status, 'blocked');
  assert.equal(block.errorCode, 'ENVIRONMENT_ISOLATED_RUNNER_REQUIRED');
  assert.match(block.stderr, /^Environment 'qa' is bound, but quality command 'integration-tests' requires an approved isolated runner\. No environment values were materialized and the command was not executed\./u);
  assert.match(block.stderr, /capability policy localIntegrationEvidence must be allowed; it changes through a capability proposal\.$/u);
  assert.equal(block.stderrBytes, Buffer.byteLength(block.stderr));
  assert.deepEqual(Object.keys(block), ['id', 'command', 'kind', 'requirement', 'externalModelPolicy', 'workingDirectory', 'timeoutMs',
    'sourceCommit', 'sourceTreeSha256', 'startedAt', 'completedAt', 'status', 'errorCode', 'exitCode', 'stdout', 'stderr',
    'stdoutBytes', 'stderrBytes', 'stdoutTruncated', 'stderrTruncated', 'environment']);
  assert.doesNotMatch(JSON.stringify(block), new RegExp(SECRET, 'u'));
  // The unavailable wording is unchanged.
  const unavailable = await environmentQualityCommandBlock('/not-used', policy, { ...identity,
    resolver: async () => ({ status: 'unbound', missing: ['API_TOKEN'], environment: { ...boundEnvironment('qa').environment, boundNames: [], secretsPresent: [] } }) });
  assert.equal(unavailable.errorCode, 'ENVIRONMENT_BINDING_UNAVAILABLE');
  assert.equal(unavailable.stderr, "Environment 'qa' is unavailable for quality command 'integration-tests'. Bind the declared environment before retrying; the command was not executed.");
});

test('policy allowed: a complete binding runs; partial bindings, shell commands and resolver failures stay blocked', async () => {
  const policy = normalizeExternalCommand({ id: 'integration-tests', kind: 'test', argv: ['npm', 'run', 'it'], modelPolicy: 'never' });
  const localIntegration = { listed: new Map(), requested: null, ranBy: 'person@example.invalid' };
  const run = await environmentQualityCommandGate('/not-used', policy, { ...identity, localIntegration, resolver: async () => boundEnvironment('qa') });
  assert.equal(run.block, null);
  assert.deepEqual({ ...run.run, environment: run.run.environment.name }, { environmentId: 'qa', environment: 'qa', linked: 'qa', listed: [], countsForStep: true });
  const partial = await environmentQualityCommandGate('/not-used', policy, { ...identity, localIntegration,
    resolver: async () => ({ ...boundEnvironment('qa'), status: 'partial', missing: ['API_TOKEN'] }) });
  assert.equal(partial.run, null);
  assert.equal(partial.block.errorCode, 'ENVIRONMENT_BINDING_UNAVAILABLE');
  const shell = normalizeExternalCommand({ id: 'integration-tests', command: 'npm run it', modelPolicy: 'never' });
  const refusedShell = await environmentQualityCommandGate('/not-used', shell, { ...identity, localIntegration, resolver: async () => boundEnvironment('qa') });
  assert.equal(refusedShell.block.errorCode, 'ENVIRONMENT_ARGV_REQUIRED');
  const failed = await environmentQualityCommandGate('/not-used', policy, { ...identity, localIntegration, resolver: async () => { throw new Error('secret=x'); } });
  assert.equal(failed.block.errorCode, 'ENVIRONMENT_BINDING_UNAVAILABLE');
  // An unlinked command with no listed environment is an ordinary command.
  assert.deepEqual(await environmentQualityCommandGate('/not-used', policy, { ...identity, localIntegration,
    resolver: async () => ({ status: 'unbound', environment: null, missing: [] }) }), { block: null, run: null });
});

test('the capability lists environments; only the checks-linked one counts for the step', async () => {
  const policy = normalizeExternalCommand({ id: 'integration-tests', kind: 'test', argv: ['npm', 'run', 'it'], modelPolicy: 'never' });
  const calls = [];
  const resolver = async (_root, environment, options) => {
    calls.push([environment, options]);
    return environment == null ? boundEnvironment('qa') : boundEnvironment(environment);
  };
  const listed = new Map([['integration-tests', ['dev', 'qa']]]);
  const gate = await environmentQualityCommandGate('/not-used', policy, { ...identity, resolver,
    localIntegration: { listed, requested: null, ranBy: null } });
  assert.equal(gate.run.environmentId, 'qa', 'a gate runs the linked environment, the one that counts');
  assert.equal(gate.run.countsForStep, true);
  const dev = await environmentQualityCommandGate('/not-used', policy, { ...identity, resolver,
    localIntegration: { listed, requested: 'dev', ranBy: null } });
  assert.equal(dev.run.environmentId, 'dev');
  assert.equal(dev.run.countsForStep, false);
  assert.deepEqual(calls.at(-1), ['dev', {}], 'another environment is resolved by itself, not through the checks mapping');
  // Without a checks link, the first listed environment runs and any listed one counts.
  const unlinked = async (_root, environment) => (environment == null ? { status: 'unbound', environment: null, missing: [] } : boundEnvironment(environment));
  const first = await environmentQualityCommandGate('/not-used', policy, { ...identity, resolver: unlinked, localIntegration: { listed, requested: null } });
  assert.deepEqual([first.run.environmentId, first.run.countsForStep, first.run.linked], ['dev', true, null]);
  const ignored = await environmentQualityCommandGate('/not-used', policy, { ...identity, resolver: unlinked, localIntegration: { listed, requested: 'uat' } });
  assert.equal(ignored.run.environmentId, 'dev', 'an environment the command may not use is never chosen');
});

const ENVIRONMENTS = `schemaVersion: 1
environments:
  qa:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://qa.example.test" }
      - { name: API_TOKEN, kind: secret }
    localFiles: [resources/qa/**]
  dev:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://dev.example.test" }
checks:
  integration-tests: { environment: qa }
`;

const INTEGRATION = `import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

test('reaches the configured endpoint', () => {
  appendFileSync(process.env.FIXTURE_FLAG, (process.env.API_BASE_URL ?? 'none') + '\\n');
  console.log('using token ' + (process.env.API_TOKEN ?? 'none') + ' against ' + process.env.API_BASE_URL);
  assert.match(process.env.API_BASE_URL, /^https:\\/\\//);
});
`;

async function integrationRepository(t, { policy }) {
  const command = { id: 'integration-tests', kind: 'test', argv: ['node', '--test', 'integration/qa.check.mjs'], workingDirectory: '.',
    affectedRoots: ['integration'], modelPolicy: 'never', result: { adapter: 'node-tap', path: '.sflow/results/integration.tap' } };
  const repo = await repository(t, { implementQualityCommands: [command], files: { 'integration/qa.check.mjs': INTEGRATION } });
  repo.env.FIXTURE_FLAG = path.join(repo.base, 'integration-ran.flag');
  await writeFile(path.join(repo.root, 'singularity/environments.yml'), ENVIRONMENTS);
  if (policy) {
    await writeFile(path.join(repo.root, 'singularity/capabilities.yml'), JSON.stringify({ version: 1, capabilities: { web: {
      kind: 'delivery', repository: 'web',
      application: { tests: [{ use: 'integration-tests', environments: ['qa', 'dev'] }] },
      policy: { localIntegrationEvidence: policy }
    } } }, null, 2));
  }
  repo.must('git', ['add', '.']);
  repo.must('git', ['commit', '-q', '-m', 'Environment declaration']);
  return { repo };
}

async function bindQa(repo) {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [path.resolve('bin/singularity-flow.mjs'), 'env', 'bind', 'qa', '--stdin'], {
    cwd: repo.root, env: repo.env, encoding: 'utf8', input: JSON.stringify({ bindings: { API_TOKEN: { source: 'local', value: SECRET } } })
  });
  assert.equal(result.status, 0, result.stderr);
}

async function readTree(directory, skip) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (skip(target)) continue;
    if (entry.isDirectory()) found.push(...await readTree(target, skip));
    else if (entry.isFile()) found.push(target);
  }
  return found;
}

async function implementStep(repo) {
  await startQuickFix(repo);
  repo.sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is two', () => assert.equal(value, 2));\n");
  repo.sflow('prepare', 'implement');
}

test('policy off at the gate: publication refuses the bound environment-linked command and names the switch; nothing ran', slowLane({ timeout: 300_000 }), async (t) => {
  const { repo } = await integrationRepository(t, { policy: null });
  await bindQa(repo);
  // A local preview does not run it either, and says which policy would allow it.
  const preview = repo.sflowJson('tests', 'run', '--command', 'integration-tests');
  assert.equal(preview.status, 1);
  assert.equal(preview.value.commands[0].status, 'blocked');
  assert.match(preview.value.commands[0].note, /localIntegrationEvidence to allowed\. It is off\. Change it through a capability proposal/u);
  await implementStep(repo);
  const refused = repo.sflowJson('phase', 'publish', 'implement');
  assert.equal(refused.status, 1);
  assert.equal(refused.value.error.code, 'CODE_TEST_FAILED');
  const text = JSON.stringify(refused.value);
  assert.match(text, /requires an approved isolated runner/u);
  assert.match(text, /localIntegrationEvidence must be allowed; it changes through a capability proposal/u);
  assert.doesNotMatch(text, new RegExp(SECRET, 'u'));
  await assert.rejects(readFile(repo.env.FIXTURE_FLAG), { code: 'ENOENT' }, 'the command was never executed');
});

test('policy allowed: runs get the values in the child only, redacted, labelled local-integration, and count only in qa', slowLane({ timeout: 300_000 }), async (t) => {
  const { repo } = await integrationRepository(t, { policy: 'allowed' });
  await bindQa(repo);
  // A capability-scope preview in qa: values in the child, never in the private run record.
  const preview = repo.sflowJson('tests', 'run', '--command', 'integration-tests');
  assert.equal(preview.status, 0, JSON.stringify(preview.value));
  assert.deepEqual([preview.value.run.evidenceClass, preview.value.run.environment, preview.value.commands[0].environment],
    ['local-preview', 'qa', 'qa']);
  const runs = path.join(repo.root, '.git', 'singularity-flow', 'test-runs', 'web');
  for (const name of await readdir(runs)) assert.equal((await readFile(path.join(runs, name), 'utf8')).includes(SECRET), false);
  await implementStep(repo);

  // A local run in dev: labelled with dev and that it does not count for this step.
  const dev = repo.sflowJson('tests', 'run', '--work-id', 'QF-1', '--command', 'integration-tests', '--environment', 'dev');
  assert.equal(dev.status, 0, JSON.stringify(dev.value));
  assert.equal(dev.value.run.evidenceClass, 'local-integration');
  assert.equal(dev.value.run.environment, 'dev');
  assert.equal(dev.value.run.countsForStep, false);
  assert.match(dev.value.run.label, /^Local integration run by [^,\s]+@[^,\s]+, environment `dev`; values never recorded; does not count for this step: it requires `qa`$/u);

  // The default local run uses the linked environment, qa, and counts.
  const qa = repo.sflowJson('tests', 'run', '--work-id', 'QF-1', '--command', 'integration-tests');
  assert.equal(qa.value.run.environment, 'qa');
  assert.equal(qa.value.run.countsForStep, true);
  assert.match(qa.value.run.label, /environment `qa`; values never recorded$/u);
  // The preview ran in qa, then the local runs in dev and qa.
  assert.deepEqual((await readFile(repo.env.FIXTURE_FLAG, 'utf8')).trim().split('\n'), ['https://qa.example.test', 'https://dev.example.test', 'https://qa.example.test']);

  // Publication runs it at the gate as local-integration in qa and admits every attempt.
  repo.sflow('phase', 'publish', 'implement');
  const attemptsDirectory = path.join(repo.root, 'singularity/work-items/QF-1/context/code-delivery/tests/attempts/implement');
  const attempts = await Promise.all((await readdir(attemptsDirectory)).map(async (name) => JSON.parse(await readFile(path.join(attemptsDirectory, name), 'utf8'))));
  const integration = attempts.filter((attempt) => attempt.commandId === 'integration-tests');
  assert.deepEqual(integration.map((attempt) => [attempt.purpose, attempt.boundEnvironment.name, attempt.countsForStep]).sort(),
    [['local', 'dev', false], ['local', 'qa', true], ['preflight', 'qa', true]]);
  const gate = integration.find((attempt) => attempt.purpose === 'preflight');
  assert.equal(gate.evidenceClass, 'local-integration');
  assert.equal(gate.status, 'passed');
  assert.ok(gate.ranBy, 'the receipt names who ran it');
  assert.deepEqual(Object.keys(gate.boundEnvironment).sort(), ['bindingRevision', 'boundNames', 'declarationSha256', 'endpointsSha256',
    'fingerprintSha256', 'name', 'secretsPresent', 'source']);
  assert.deepEqual(gate.boundEnvironment.secretsPresent, ['API_TOKEN']);
  const governed = attempts.find((attempt) => attempt.commandId !== 'integration-tests' && attempt.purpose === 'preflight');
  assert.equal(Object.hasOwn(governed, 'evidenceClass'), false, 'a command with no environment stays governed, unchanged');

  // The raw report the Story keeps shows the redaction; nothing anywhere holds the value or its digest.
  const rawDirectory = path.join(repo.root, 'singularity/work-items/QF-1/context/code-delivery/tests/raw');
  const raw = (await Promise.all(gate.rawReports.map((report) => readFile(path.join(rawDirectory, path.basename(report.path)), 'utf8')))).join('\n');
  assert.match(raw, /using token \[redacted:API_TOKEN\] against https:\/\/qa\.example\.test/u);
  const digest = createHash('sha256').update(SECRET).digest('hex');
  const bindingStore = `${path.sep}singularity-flow${path.sep}environments${path.sep}v1${path.sep}`;
  for (const file of await readTree(repo.root, (target) => target.includes(bindingStore) || target.endsWith(`${path.sep}node_modules`))) {
    const bytes = await readFile(file);
    assert.equal(bytes.includes(SECRET), false, `${file} holds the value`);
    assert.equal(bytes.includes(digest), false, `${file} holds a value digest`);
  }
  for (const ref of repo.must('git', ['for-each-ref', '--format=%(refname)']).trim().split('\n')) {
    assert.doesNotMatch(repo.run('git', ['log', '-p', '--all', ref]).stdout, new RegExp(SECRET, 'u'));
  }

  // Submission runs it again at its gate, and binds that local-integration run for the obligation.
  repo.sflow('submit', 'implement');
  const workflow = JSON.parse(await readFile(path.join(repo.root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  const submitted = workflow.phases.implement;
  const check = submitted.checks.find((entry) => entry.id === 'integration-tests');
  assert.deepEqual([check.status, check.evidenceClass, check.environment.name, check.countsForStep], ['passed', 'local-integration', 'qa', true]);
  const execution = submitted.deliveryEvidence.testExecutions.find((entry) => entry.commandId === 'integration-tests');
  const bound = JSON.parse(await readFile(path.join(repo.root, execution.receiptPath), 'utf8'));
  assert.deepEqual([bound.purpose, bound.evidenceClass, bound.status], ['submission', 'local-integration', 'passed']);
  assert.doesNotMatch(JSON.stringify(workflow), new RegExp(SECRET, 'u'));

  // Every surface shows the label: the summary, the approval page data and the evidence matrix.
  const summary = repo.sflowJson('tests', 'summary', '--work-id', 'QF-1', '--phase', 'implement').value;
  // The other command's run stood from publication, and is part of the run submission bound [TCE:REQ-080].
  assert.match(summary.run.label, /Run by publication/u);
  const command = summary.commands.find((entry) => entry.id === 'integration-tests');
  assert.equal(command.evidenceClass, 'local-integration');
  assert.equal(command.environment, 'qa');
  assert.equal(command.countsForStep, true);
  const review = repo.sflowJson('phase', 'show', 'implement').value;
  assert.deepEqual(review.testEvidence.localIntegrationRuns.map((entry) => [entry.commandId, entry.environment, entry.countsForStep]),
    [['integration-tests', 'qa', true]]);
  assert.match(review.testEvidence.localIntegrationRuns[0].label, /^Local integration run by .+, environment `qa`; values never recorded$/u);
  const matrix = repo.run(process.execPath, [path.resolve('bin/singularity-flow.mjs'), '--no-model', 'evidence', 'matrix', 'QF-1']).stdout;
  assert.match(matrix, /Local integration \(implement\): Local integration run by .+, environment `qa`/u);
  const matrixJson = repo.sflowJson('evidence', 'matrix', 'QF-1').value;
  assert.ok(JSON.stringify(matrixJson).includes('local-integration') || JSON.stringify(matrixJson).includes('Local integration run'));
  assert.doesNotMatch(JSON.stringify([summary, review, matrixJson]), new RegExp(SECRET, 'u'));
});
