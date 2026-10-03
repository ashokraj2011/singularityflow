import type * as vscode from 'vscode';

const JIRA_CONFIG = 'singularityFlow.jira.config';
const JIRA_TOKEN = 'singularityFlow.jira.token';
const STORAGE_PREFIX = 'singularityFlow.storage.';
const STORAGE_INDEX = 'singularityFlow.storage.index';
const TEAMS_WEBHOOK = 'singularityFlow.teams.webhook';
const INTEGRATION_PREFIX = 'singularityFlow.integration.';
const INTEGRATION_INDEX = 'singularityFlow.integration.index';
/** An environment secret an integration target names, such as SFLOW_SECRET_EVENTS_KEY (the engine's rule). */
export const INTEGRATION_SECRET_NAME = /^SFLOW_SECRET_[A-Z0-9_]{1,51}$/;

/** Where an integration secret comes from on this machine, if anywhere. */
export type IntegrationSecretSource = 'stored' | 'environment' | 'missing';

/** The environment variable the engine reads a storage provider's token from. */
export function storageTokenVariable(providerId: string): string {
  return `SINGULARITY_FLOW_STORAGE_TOKEN_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export interface JiraSecretConfig {
  deployment: 'cloud' | 'data-center';
  baseUrl: string;
  username?: string;
  connectionName?: string;
}

/** The extension keychain is the only credential store used by the visual surface. */
export class SecureCredentials {
  private readonly secrets: vscode.SecretStorage;
  constructor(secrets: vscode.SecretStorage) { this.secrets = secrets; }

  async jiraStatus(): Promise<{ connected: boolean; config: JiraSecretConfig | null }> {
    const raw = await this.secrets.get(JIRA_CONFIG);
    const token = await this.secrets.get(JIRA_TOKEN);
    if (!raw || !token) return { connected: false, config: null };
    try { return { connected: true, config: JSON.parse(raw) as JiraSecretConfig }; }
    catch { return { connected: false, config: null }; }
  }

  async saveJira(config: JiraSecretConfig, token: string): Promise<void> {
    const baseUrl = new URL(config.baseUrl);
    if (baseUrl.protocol !== 'https:') throw new Error('Jira must use HTTPS.');
    if (!token.trim()) throw new Error('Jira API token or PAT is required.');
    await this.secrets.store(JIRA_CONFIG, JSON.stringify({ ...config, baseUrl: baseUrl.toString().replace(/\/$/, '') }));
    await this.secrets.store(JIRA_TOKEN, token);
  }

  async resetJira(): Promise<void> {
    await Promise.all([this.secrets.delete(JIRA_CONFIG), this.secrets.delete(JIRA_TOKEN)]);
  }

  async environment(base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
    const env = { ...base };
    const status = await this.jiraStatus();
    const token = await this.secrets.get(JIRA_TOKEN);
    if (status.connected && status.config && token) {
      env.JIRA_BASE_URL = status.config.baseUrl;
      env.JIRA_DEPLOYMENT = status.config.deployment;
      env.JIRA_CONNECTION_NAME = status.config.connectionName ?? 'vscode';
      env.JIRA_PAT = token;
      if (status.config.username) env.JIRA_USERNAME = status.config.username;
    }
    const teamsWebhook = await this.secrets.get(TEAMS_WEBHOOK);
    if (teamsWebhook) env.SINGULARITY_FLOW_TEAMS_WEBHOOK_URL = teamsWebhook;
    // Storage provider tokens reach the engine under the variable it reads; they were saved but never passed.
    for (const providerId of await this.index(STORAGE_INDEX)) {
      const token = await this.secrets.get(`${STORAGE_PREFIX}${providerId}`);
      if (token) env[storageTokenVariable(providerId)] = token;
    }
    // Integration secrets: what after-step actions sign and authenticate with. A stored value wins
    // over one inherited from the shell, because someone chose it here.
    for (const name of await this.index(INTEGRATION_INDEX)) {
      const value = await this.secrets.get(`${INTEGRATION_PREFIX}${name}`);
      if (value) env[name] = value;
    }
    return env;
  }

  private async index(key: string): Promise<string[]> {
    try {
      const parsed = JSON.parse(await this.secrets.get(key) ?? '[]') as unknown;
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch { return []; }
  }

  /** Store an integration secret by the name a target uses; the value never leaves the keychain except into the CLI. */
  async saveIntegrationSecret(name: string, value: string): Promise<void> {
    if (!INTEGRATION_SECRET_NAME.test(name)) throw new Error('Integration secret names start with SFLOW_SECRET_, such as SFLOW_SECRET_EVENTS_KEY.');
    if (!value.trim()) throw new Error('The secret value is empty.');
    await this.secrets.store(`${INTEGRATION_PREFIX}${name}`, value.trim());
    const names = [...new Set([...(await this.index(INTEGRATION_INDEX)), name])].sort();
    await this.secrets.store(INTEGRATION_INDEX, JSON.stringify(names));
  }

  async resetIntegrationSecret(name: string): Promise<void> {
    if (!INTEGRATION_SECRET_NAME.test(name)) return;
    await this.secrets.delete(`${INTEGRATION_PREFIX}${name}`);
    const names = (await this.index(INTEGRATION_INDEX)).filter((entry) => entry !== name);
    await this.secrets.store(INTEGRATION_INDEX, JSON.stringify(names));
  }

  /** Whether each named secret is stored here, inherited from the environment, or missing. Never the values. */
  async integrationSecretStatus(names: readonly string[], base: NodeJS.ProcessEnv = process.env): Promise<Record<string, IntegrationSecretSource>> {
    const status: Record<string, IntegrationSecretSource> = {};
    for (const name of names) {
      if (!INTEGRATION_SECRET_NAME.test(name)) continue;
      if (await this.secrets.get(`${INTEGRATION_PREFIX}${name}`)) status[name] = 'stored';
      else status[name] = String(base[name] ?? '').trim() ? 'environment' : 'missing';
    }
    return status;
  }

  async saveTeamsWebhook(value: string): Promise<void> {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Teams webhook must use HTTPS without embedded credentials.');
    }
    await this.secrets.store(TEAMS_WEBHOOK, url.toString());
  }

  async resetTeamsWebhook(): Promise<void> { await this.secrets.delete(TEAMS_WEBHOOK); }

  async saveProviderToken(providerId: string, token: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) throw new Error('Storage provider ID is invalid.');
    if (!token.trim()) throw new Error('Provider token is required.');
    await this.secrets.store(`${STORAGE_PREFIX}${providerId}`, token);
    let current: string[] = [];
    try { current = JSON.parse(await this.secrets.get(STORAGE_INDEX) ?? '[]') as string[]; } catch { /* reset below */ }
    const next = [...new Set([...current, providerId])].sort();
    await this.secrets.store(STORAGE_INDEX, JSON.stringify(next));
  }

  async providerToken(providerId: string): Promise<string | undefined> {
    return this.secrets.get(`${STORAGE_PREFIX}${providerId}`);
  }

  async resetAll(): Promise<void> {
    let providerIds: string[] = [];
    try { providerIds = JSON.parse(await this.secrets.get(STORAGE_INDEX) ?? '[]') as string[]; } catch { /* ignore corrupt index */ }
    const integrationNames = await this.index(INTEGRATION_INDEX);
    await Promise.all([
      this.resetJira(),
      this.resetTeamsWebhook(),
      ...integrationNames.map((name) => this.secrets.delete(`${INTEGRATION_PREFIX}${name}`)),
      this.secrets.delete(INTEGRATION_INDEX),
      ...providerIds.filter((id) => typeof id === 'string').map((id) => this.secrets.delete(`${STORAGE_PREFIX}${id}`)),
      this.secrets.delete(STORAGE_INDEX)
    ]);
  }
}
