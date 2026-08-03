import type * as vscode from 'vscode';

const JIRA_CONFIG = 'singularityFlow.jira.config';
const JIRA_TOKEN = 'singularityFlow.jira.token';
const STORAGE_PREFIX = 'singularityFlow.storage.';

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
    return env;
  }

  async saveProviderToken(providerId: string, token: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) throw new Error('Storage provider ID is invalid.');
    if (!token.trim()) throw new Error('Provider token is required.');
    await this.secrets.store(`${STORAGE_PREFIX}${providerId}`, token);
  }

  async providerToken(providerId: string): Promise<string | undefined> {
    return this.secrets.get(`${STORAGE_PREFIX}${providerId}`);
  }
}
