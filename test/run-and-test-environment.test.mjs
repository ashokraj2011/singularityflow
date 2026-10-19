import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bindEnvironment, materializeEnvironmentBinding } from '../src/environment-bindings.mjs';
import { createStreamRedactor, redactText, redactionEntries } from '../src/output-redaction.mjs';
import { runQualityCommand } from '../src/quality-command-runner.mjs';
import {
  environmentCountsForStep, environmentDoesNotCountWords, localIntegrationPolicyRefusal, selectRunEnvironment
} from '../src/run-environment.mjs';

const SECRET = 'very-private-token-3141';
const declaration = { environments: { dev: {}, qa: {}, uat: {} } };

test('a run uses a listed environment, else the checks-linked one, and refuses any other by name', () => {
  assert.equal(selectRunEnvironment({ listed: ['dev', 'qa'], declaration, subject: 'Test command' }), 'dev');
  assert.equal(selectRunEnvironment({ listed: ['dev', 'qa'], requested: 'qa', declaration, subject: 'Test command' }), 'qa');
  assert.equal(selectRunEnvironment({ linked: 'qa', declaration, subject: 'Test command' }), 'qa');
  assert.equal(selectRunEnvironment({ declaration, subject: 'Test command' }), null);
  assert.throws(() => selectRunEnvironment({ listed: ['dev', 'qa'], requested: 'uat', declaration, subject: 'Test command' }),
    (error) => error.code === 'RUN_ENVIRONMENT_NOT_ALLOWED' && /only in 'dev', 'qa', not 'uat'/u.test(error.message)
      && error.details.allowed.join() === 'dev,qa');
  assert.throws(() => selectRunEnvironment({ linked: 'qa', requested: 'dev', declaration, subject: 'Test command' }),
    (error) => error.code === 'RUN_ENVIRONMENT_NOT_ALLOWED');
  assert.throws(() => selectRunEnvironment({ requested: 'dev', declaration, subject: 'Test command' }),
    (error) => error.code === 'RUN_ENVIRONMENT_NOT_ALLOWED' && /declares no environment/u.test(error.message));
  assert.throws(() => selectRunEnvironment({ listed: ['staging'], declaration, subject: 'Test command' }),
    (error) => error.code === 'RUN_ENVIRONMENT_UNKNOWN' && /staging/u.test(error.message));
  const refusal = localIntegrationPolicyRefusal({ capabilityId: 'web', environment: 'qa', subject: 'Start entry' });
  assert.equal(refusal.code, 'LOCAL_INTEGRATION_POLICY_OFF');
  assert.equal(refusal.details.changedBy, 'capability proposal');
});

test('only a run in the checks-linked environment counts; without a link any declared one counts', () => {
  assert.equal(environmentCountsForStep({ environment: 'qa', linked: 'qa' }), true);
  assert.equal(environmentCountsForStep({ environment: 'dev', listed: ['dev', 'qa'], linked: 'qa' }), false);
  assert.equal(environmentCountsForStep({ environment: 'dev', listed: ['dev', 'qa'] }), true);
  assert.equal(environmentCountsForStep({ environment: 'uat', listed: ['dev', 'qa'] }), false);
  assert.equal(environmentDoesNotCountWords('qa'), 'does not count for this step: it requires `qa`');
});

test('stream redaction replaces every secret of four or more characters, even split across chunks', () => {
  const entries = redactionEntries([
    { name: 'API_TOKEN', value: SECRET }, { name: 'PIN', value: 'abc' }, { name: 'PREFIX', value: 'very-private' }
  ]);
  assert.deepEqual(entries.map((entry) => entry.name), ['API_TOKEN', 'PREFIX']);
  assert.equal(redactText(`a ${SECRET} b very-private c abc`, entries), 'a [redacted:API_TOKEN] b [redacted:PREFIX] c abc');
  const redactor = createStreamRedactor(entries);
  const pieces = [`line one\nvalue=${SECRET.slice(0, 5)}`, SECRET.slice(5, 11), `${SECRET.slice(11)} done\n`, 'plain tail'];
  const emitted = [];
  for (const piece of pieces) emitted.push(redactor.write(Buffer.from(piece)));
  emitted.push(redactor.end());
  assert.equal(emitted.join(''), 'line one\nvalue=[redacted:API_TOKEN] done\nplain tail');
  // Text that cannot become a secret is emitted at once, not held for the next chunk.
  assert.equal(emitted[0], 'line one\nvalue=');
  assert.equal(emitted.at(-2), 'plain tail');
});

async function boundRepository() {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-run-env-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'environments.yml'), `schemaVersion: 1
environments:
  qa:
    requires:
      - { name: API_TOKEN, kind: secret }
      - { name: API_BASE_URL, kind: endpoint, value: "https://qa.example.test" }
      - { name: SHORT_SECRET, kind: secret }
`);
  return root;
}

test('materialization gives values to a child environment only and never serializes them', async () => {
  const root = await boundRepository();
  const unbound = await materializeEnvironmentBinding(root, 'qa');
  assert.equal(unbound.status, 'unbound');
  assert.equal(typeof unbound.childEnvironment, 'undefined');
  await bindEnvironment(root, 'qa', { bindings: { API_TOKEN: { source: 'local', value: SECRET }, SHORT_SECRET: { source: 'local', value: 'xyz' } } });
  const bound = await materializeEnvironmentBinding(root, 'qa');
  assert.equal(bound.status, 'bound');
  const serialized = JSON.stringify(bound) + JSON.stringify({ ...bound }) + JSON.stringify(structuredClone({ ...bound }));
  assert.doesNotMatch(serialized, new RegExp(SECRET, 'u'));
  assert.deepEqual(Object.keys(bound), ['status', 'environment', 'missing']);
  const env = bound.childEnvironment({ PATH: process.env.PATH, api_token: 'shadow' });
  assert.equal(env.API_TOKEN, SECRET);
  assert.equal(env.API_BASE_URL, 'https://qa.example.test');
  assert.equal(env.api_token, undefined);
  assert.equal(bound.redact(`x ${SECRET} y xyz`), 'x [redacted:API_TOKEN] y xyz');
});

test('a quality command given private values has its output and captured report redacted', async () => {
  const root = await boundRepository();
  await bindEnvironment(root, 'qa', { bindings: { API_TOKEN: { source: 'local', value: SECRET }, SHORT_SECRET: { source: 'local', value: 'xyz' } } });
  const bound = await materializeEnvironmentBinding(root, 'qa');
  const stdoutFile = path.join(root, 'report.tap');
  const script = 'process.stdout.write("out " + process.env.API_TOKEN.slice(0, 7)); setTimeout(() => { process.stdout.write(process.env.API_TOKEN.slice(7) + "\\n"); console.error("err " + process.env.API_TOKEN); }, 20);';
  const result = await runQualityCommand(process.execPath, ['-e', script], {
    cwd: root, env: bound.childEnvironment(process.env), timeoutMs: 10_000, stdoutFile, redactor: bound.streamRedactor
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'out [redacted:API_TOKEN]\n');
  assert.equal(result.stderr, 'err [redacted:API_TOKEN]\n');
  assert.equal(await readFile(stdoutFile, 'utf8'), 'out [redacted:API_TOKEN]\n');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET, 'u'));
});
