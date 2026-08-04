import test from 'node:test';
import assert from 'node:assert/strict';
import { SecureCredentials } from '../apps/vscode/src/credentials.ts';

class MemorySecrets {
  values = new Map();
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

test('VS Code SecretStorage is the only Jira credential persistence path', async () => {
  const secrets = new MemorySecrets();
  const credentials = new SecureCredentials(secrets);
  await credentials.saveJira({
    deployment: 'cloud', baseUrl: 'https://example.atlassian.net/', username: 'person@example.com'
  }, 'secret-token');
  const env = await credentials.environment({ PATH: '/bin' });
  assert.equal(env.JIRA_BASE_URL, 'https://example.atlassian.net');
  assert.equal(env.JIRA_USERNAME, 'person@example.com');
  assert.equal(env.JIRA_PAT, 'secret-token');
  assert.equal((await credentials.jiraStatus()).connected, true);
  await credentials.resetJira();
  assert.equal((await credentials.jiraStatus()).connected, false);
  assert.equal((await credentials.environment({})).JIRA_PAT, undefined);
});

test('secure provider tokens are scoped by provider and Jira refuses plaintext transport', async () => {
  const secrets = new MemorySecrets();
  const credentials = new SecureCredentials(secrets);
  await credentials.saveProviderToken('sharepoint-main', 'provider-secret');
  await credentials.saveTeamsWebhook('https://teams.example.com/hooks/demo');
  assert.equal(await credentials.providerToken('sharepoint-main'), 'provider-secret');
  await assert.rejects(() => credentials.saveJira({
    deployment: 'cloud', baseUrl: 'http://jira.example.com', username: 'person'
  }, 'token'), /HTTPS/);
  await credentials.resetAll();
  assert.equal(await credentials.providerToken('sharepoint-main'), undefined);
  assert.equal(secrets.values.size, 0);
});
