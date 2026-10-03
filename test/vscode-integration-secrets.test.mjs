/**
 * Integration secrets in VS Code: stored in the keychain, passed to the CLI under their own names,
 * shown to the Studio page only as stored, from the environment, or missing.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SecureCredentials, storageTokenVariable } from '../apps/vscode/src/credentials.ts';
import { SingularityFlowClient, commandClass } from '../apps/vscode/src/cli/client.ts';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class MemorySecrets {
  values = new Map();
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

test('integration secrets reach the CLI under their own names, and a status never carries a value', async () => {
  const secrets = new MemorySecrets();
  const credentials = new SecureCredentials(secrets);
  await credentials.saveIntegrationSecret('SFLOW_SECRET_EVENTS_KEY', ' signing-key ');
  await credentials.saveProviderToken('sharepoint-main', 'provider-secret');
  const env = await credentials.environment({ PATH: '/bin', SFLOW_SECRET_EVENTS_KEY: 'from-the-shell' });
  assert.equal(env.SFLOW_SECRET_EVENTS_KEY, 'signing-key', 'a value someone stored here wins over the shell');
  assert.equal(env.PATH, '/bin');
  // Storage provider tokens were saved but never passed; the engine reads them by this name.
  assert.equal(storageTokenVariable('sharepoint-main'), 'SINGULARITY_FLOW_STORAGE_TOKEN_SHAREPOINT_MAIN');
  assert.equal(env.SINGULARITY_FLOW_STORAGE_TOKEN_SHAREPOINT_MAIN, 'provider-secret');

  const status = await credentials.integrationSecretStatus(
    ['SFLOW_SECRET_EVENTS_KEY', 'SFLOW_SECRET_TEAMS_URL', 'SFLOW_SECRET_NOT_SET', 'JIRA_PAT'], { SFLOW_SECRET_TEAMS_URL: 'https://example.webhook.office.com/x' });
  assert.deepEqual(status, { SFLOW_SECRET_EVENTS_KEY: 'stored', SFLOW_SECRET_TEAMS_URL: 'environment', SFLOW_SECRET_NOT_SET: 'missing' },
    'another tool\'s credential is not even reported');
  assert.equal(JSON.stringify(status).includes('signing-key'), false);

  // The Studio can never write over another tool's credential or the CLI's own environment.
  for (const name of ['JIRA_PAT', 'GITHUB_TOKEN', 'PATH', 'NODE_OPTIONS', 'SINGULARITY_FLOW_NO_MODEL', 'SFLOW_SECRET_']) {
    await assert.rejects(() => credentials.saveIntegrationSecret(name, 'value'), /SFLOW_SECRET_/, name);
  }
  await assert.rejects(() => credentials.saveIntegrationSecret('SFLOW_SECRET_BLANK', '   '), /empty/);

  await credentials.resetIntegrationSecret('SFLOW_SECRET_EVENTS_KEY');
  assert.equal((await credentials.environment({})).SFLOW_SECRET_EVENTS_KEY, undefined);
  await credentials.saveIntegrationSecret('SFLOW_SECRET_HOOK_KEY', 'value');
  await credentials.resetAll();
  assert.equal(secrets.values.size, 0, 'a fresh reset leaves no integration secret or index behind');
});

test('the client reads its environment at every spawn, so a secret stored now reaches the next command', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-integration-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = path.join(directory, 'fixture.mjs');
  const log = path.join(directory, 'spawns.log');
  await writeFile(log, '');
  await writeFile(cli, `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
    process.stdout.write(JSON.stringify({ data: { secret: process.env.SFLOW_SECRET_PROBE ?? null } }));
  `);
  let environment = { ...process.env, SFLOW_SECRET_PROBE: undefined };
  delete environment.SFLOW_SECRET_PROBE;
  const client = new SingularityFlowClient({ location: { executable: process.execPath, cli, source: 'setting' }, repository: directory, environment: () => environment });
  assert.equal((await client.run(['integrations', 'status', '--json', '--case', 'before'])).data.secret, null);
  environment = { ...environment, SFLOW_SECRET_PROBE: 'stored-now' };
  assert.equal((await client.run(['integrations', 'status', '--json', '--case', 'after'])).data.secret, 'stored-now');

  // A test delivery reaches another system each time it is asked for; it is never answered from the read cache.
  const sendTest = ['integrations', 'test', 'team-events', '--trigger', 'approved', '--send', 'event', '--send-test', '--json'];
  await client.run(sendTest);
  await client.run(sendTest);
  const spawns = (await readFile(log, 'utf8')).trim().split('\n').filter((line) => line.includes('--send-test'));
  assert.equal(spawns.length, 2);
});

test('integrations reads are reads; retrying a delivery is not', () => {
  assert.equal(commandClass(['integrations']), 'read');
  assert.equal(commandClass(['integrations', 'list', '--json']), 'read');
  assert.equal(commandClass(['integrations', 'status', '--work-id', 'STORY-1', '--json']), 'read');
  assert.equal(commandClass(['integrations', 'test', 'team-events', '--send-test', '--json']), 'read', 'the engine changes no repository state for a test');
  assert.equal(commandClass(['integrations', 'retry', 'sad_0123', '--json']), 'mutation');
  assert.equal(commandClass(['integrations', 'future-action']), 'mutation');
});

test('the Studio host never shows a secret to the page and asks before it stores, removes or sends', async () => {
  const host = await readFile(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio.ts'), 'utf8');
  // The value is typed into VS Code's own password box and goes straight to the keychain.
  assert.match(host, /showInputBox\(\{[\s\S]{0,200}password: true,[\s\S]{0,300}\}\);[\s\S]{0,80}if \(!value\) return;[\s\S]{0,40}await store\.store\(name, value\);/);
  assert.match(host, /this\.post\(\{ type: 'studio\.secretStored', name \}\)/);
  assert.doesNotMatch(host, /type: 'studio\.secret[A-Za-z]*', [^}]*value/, 'no message to the page carries a value');
  assert.match(host, /Remove \$\{name\} from this machine's keychain\?[\s\S]{0,200}'Remove'\);[\s\S]{0,40}if \(confirmed !== 'Remove'\) return;/);
  // A test delivery is sent only after the person confirms, through the engine.
  assert.match(host, /if \(sendTest && !readOnly\) \{[\s\S]{0,400}'Send test'\);[\s\S]{0,40}if \(confirmed !== 'Send test'\)/);
  // Only a Jira check skips that consent, and the host decides it from the model it read, not from the page.
  assert.match(host, /const readOnly = targets\.find\(\(entry\) => entry\.id === target\)\?\.kind === 'jira';/);
  assert.match(host, /const targets = \(\(this\.model as/);
  assert.match(host, /this\.client\.run<\{ data\?: Record<string, unknown> \}>\(\[\s*'integrations', 'test', target, '--trigger', trigger, '--send', send, \.\.\.\(sendTest \? \['--send-test'\] : \[\]\), '--json'\s*\]\)/);
  // Names are checked against the engine's rule before anything is asked of the keychain.
  assert.match(host, /INTEGRATION_SECRET_NAME\.test\(name\)/);
  const extension = await readFile(path.join(packageRoot, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /integrationSecrets: \{[\s\S]{0,200}saveIntegrationSecret\(name, value\); cliEnvironment = await resolvedCliEnvironment\(\);/);
  assert.match(extension, /client = new SingularityFlowClient\(\{[\s\S]{0,300}environment: \(\) => cliEnvironment,/, 'the window\'s client reads the environment at each spawn');
});
