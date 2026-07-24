import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { invokeCliProcess, REPOSITORY_SNAPSHOT_TIMEOUT_MS, validateRepositoryDirectory } from './cli-runner.mjs';
import { forgetRecentRepository, readRecentRepositories, rememberRecentRepository } from './recent-repositories.mjs';
import { CopilotPlanningBridge, copilotPlanningPreflight } from './copilot-acp.mjs';
import { CopilotBackendController } from './copilot-service.mjs';
import { isTrustedRendererUrl, safeExternalUrl } from './desktop-security.mjs';
import {
  requireActiveRepository,
  requireActiveWorkspace,
  requireReadyLeadRepository
} from './desktop-scope.mjs';
import { JiraCredentialStore } from './jira-credentials.mjs';
import { StorageCredentialStore } from './storage-credentials.mjs';
import { authorizeSharePoint, sharePointAccessToken } from './sharepoint-oauth.mjs';
import {
  ONBOARDING_ROLES,
  prepareOnboardingProfile,
  readOnboardingProfile,
  saveOnboardingProfile,
  validateOnboardingWorkspace
} from './onboarding-profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, 'preload.cjs');
let activeRepository = null;
let activeWorkspace = null;
let mainWindow = null;
const planningPacks = new Map();
const jiraCache = new Map();
const copilotBackend = new CopilotBackendController({
  bridgeFactory: ({ repository, emit }) => new CopilotPlanningBridge({ repository, emit }),
  preflight: () => copilotPlanningPreflight(),
  emit: (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  }
});

function recentRepositoriesPath() { return path.join(app.getPath('userData'), 'recent-repositories.json'); }
function workspaceRegistryPath() { return path.join(app.getPath('userData'), 'workspaces.json'); }
function jiraCredentialsPath() { return path.join(app.getPath('userData'), 'jira-credentials.json'); }
function storageCredentialsPath() { return path.join(app.getPath('userData'), 'storage-credentials.json'); }
function onboardingProfilePath() { return path.join(app.getPath('userData'), 'onboarding.json'); }
function jiraCredentialStore() { return new JiraCredentialStore(jiraCredentialsPath(), safeStorage); }
function storageCredentialStore() { return new StorageCredentialStore(storageCredentialsPath(), safeStorage); }

function cliResourcePath(...segments) {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'cli') : path.resolve(here, '../../..');
  return path.join(root, ...segments);
}

function rendererEntryUrl() {
  return app.isPackaged
    ? pathToFileURL(path.join(here, '../dist/index.html'))
    : new URL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
}

async function importCliModule(name) {
  return import(pathToFileURL(cliResourcePath('src', name)).href);
}

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted desktop request.');
  const expected = rendererEntryUrl();
  if (!isTrustedRendererUrl(event.sender.getURL(), expected.href, { packaged: app.isPackaged })) {
    throw new Error('Untrusted desktop origin.');
  }
}

function trustedHandle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return listener(event, ...args);
  });
}

async function jiraPolicy(repository) {
  const root = assertRepository(repository);
  const { loadPortfolio } = await importCliModule('initiative-config.mjs');
  const portfolio = await loadPortfolio(root);
  if (!portfolio.jira?.enabled) throw new Error('Jira is disabled in singularity/portfolio.yml.');
  return { root, portfolio, policy: portfolio.jira };
}

async function governedPolicyConnection(policy, { projectKey = null, issueKey = null } = {}) {
  const {
    assertJiraConnectionPolicy,
    assertJiraIssuePolicy,
    assertJiraProjectPolicy
  } = await importCliModule('jira.mjs');
  const connection = assertJiraConnectionPolicy(
    await jiraCredentialStore().load(policy.connection),
    policy
  );
  if (projectKey) assertJiraProjectPolicy(projectKey, policy);
  if (issueKey) assertJiraIssuePolicy(issueKey, policy);
  return connection;
}

async function governedJiraConnection(repository, constraints = {}) {
  const scoped = await jiraPolicy(repository);
  return {
    ...scoped,
    connection: await governedPolicyConnection(scoped.policy, constraints)
  };
}

async function governedInitiativeJiraConnection(repository, initiativeId, constraints = {}) {
  const root = assertRepository(repository);
  const { loadInitiative } = await importCliModule('initiative-state.mjs');
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const policy = initiative.resolution?.jira ?? portfolio.jira;
  if (!policy?.enabled) throw new Error('Jira is disabled in the initiative configuration snapshot.');
  return {
    root,
    portfolio,
    initiative,
    policy,
    connection: await governedPolicyConnection(policy, constraints)
  };
}

function jiraCacheRead(key, minutes) {
  const entry = jiraCache.get(key);
  return entry && Date.now() - entry.at < Math.max(0, minutes) * 60_000 ? entry.value : null;
}

function jiraCacheWrite(key, value) {
  jiraCache.set(key, { at: Date.now(), value });
  return value;
}

function jiraCacheKey(connection, operation, ...parts) {
  return JSON.stringify([operation, connection.name, connection.baseUrl, ...parts]);
}

async function recentRepositories() {
  return (await readRecentRepositories(recentRepositoriesPath())).map((entry) => ({ ...entry, available: existsSync(entry.path) }));
}

async function workspaceModule() {
  return importCliModule('workspace.mjs');
}

async function recentWorkspaces() {
  const { readWorkspaceRegistry } = await workspaceModule();
  const entries = await readWorkspaceRegistry(workspaceRegistryPath());
  return Promise.all(entries.map(async (entry) => ({
    ...entry,
    available: existsSync(path.join(entry.path, 'workspace.json'))
  })));
}

function cliPath() {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'cli') : path.resolve(here, '../../..');
  return path.join(root, 'bin', 'singularity-flow.mjs');
}

function invokeCli(repository, args, { input = null, json = true, timeoutMs = undefined } = {}) {
  return invokeCliProcess({
    executable: process.execPath,
    cli: cliPath(),
    repository,
    args,
    input,
    json,
    timeoutMs,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SINGULARITY_FLOW_DESKTOP: '1' }
  });
}

function assertRepository(repository) {
  return requireActiveRepository(activeRepository, repository);
}

function assertWorkspace(workspace) {
  return requireActiveWorkspace(activeWorkspace, workspace);
}

function planningWorkspaceBoundary(root) {
  if (!activeWorkspace?.workspace?.path || path.resolve(activeWorkspace.leadRepositoryPath) !== path.resolve(root)) return '';
  const repositories = activeWorkspace.repositories
    .filter((repository) => repository.state === 'ready')
    .map((repository) => `- ${repository.id} (${repository.role}): ${repository.absolutePath}`)
    .join('\n');
  return `\n\nActive Singularity project workspace: ${activeWorkspace.workspace.anchor.key}. The following cloned repository roots are the complete allowed filesystem scope for this read-only planning session:\n${repositories}\nDo not inspect paths outside those roots. Workspace documents marked staged-not-governed are excluded until they are explicitly imported into a Git work item or registered as initiative evidence.`;
}

function safeRelativePath(value, label = 'path') {
  const normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error(`${label} must stay inside the repository.`);
  return normalized;
}

function portableName(value) {
  return String(value ?? '').toLowerCase().replace(/\.md$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imported-skill';
}

async function snapshot(repository, workId = null, initiativeId = null) {
  const result = await invokeCli(repository, [
    'desktop', 'snapshot',
    ...(workId ? [workId] : []),
    ...(initiativeId ? ['--initiative', initiativeId] : []),
    '--json'
  ], { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
  activeRepository = path.resolve(result.repository.root);
  const jira = await jiraCredentialStore().safeStatus();
  result.desktopProfile = await readOnboardingProfile(onboardingProfilePath(), { jiraConnected: jira.connected });
  result.jiraSession = jira;
  if (activeWorkspace?.workspace?.path) {
    const { workspaceStatus } = await workspaceModule();
    const status = await workspaceStatus(activeWorkspace.workspace.path);
    if (path.resolve(status.leadRepositoryPath) === activeRepository) {
      activeWorkspace = status;
      result.workspace = status;
    }
  }
  return result;
}

async function openRepository(repository, { workspace = null } = {}) {
  let root;
  let migration = null;
  try {
    root = await validateRepositoryDirectory(repository);
  } catch (error) {
    if (error?.code !== 'SINGULARITY_FLOW_LEGACY_CONTROL_ROOT') throw error;
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Keep unchanged', 'Migrate folder'],
      defaultId: 0,
      cancelId: 0,
      title: 'Move Singularity Flow files?',
      message: `This repository still uses ${error.legacyRoot}/.`,
      detail: 'Flow Studio can move it to the visible singularity/ folder and refresh pinned path hashes. This changes only the current branch working tree; it does not commit, push, merge, or rewrite Git history.'
    });
    if (confirmation.response !== 1) return null;
    const migrated = await invokeCli(error.repository, ['migrate-config'], { json: false, timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
    root = await validateRepositoryDirectory(error.repository);
    migration = { from: error.legacyRoot, to: 'singularity', output: migrated.output };
  }
  if (activeRepository && path.resolve(activeRepository) !== path.resolve(root)) {
    await copilotBackend.stop(activeRepository).catch(() => null);
    planningPacks.clear();
  }
  activeWorkspace = workspace;
  const result = await snapshot(root);
  if (workspace) result.workspace = workspace;
  if (migration) result.repository.migration = migration;
  await rememberRecentRepository(recentRepositoriesPath(), {
    path: result.repository.root,
    name: path.basename(result.repository.root),
    branch: result.repository.branch
  });
  return result;
}

function registerHandlers() {
  trustedHandle('onboarding:get', async (event) => {
    assertTrustedSender(event);
    const jira = await jiraCredentialStore().safeStatus();
    return {
      profile: await readOnboardingProfile(onboardingProfilePath(), { jiraConnected: jira.connected }),
      jira,
      roles: [...ONBOARDING_ROLES]
    };
  });
  trustedHandle('onboarding:choose-workspace', async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose your local Singularity workspace'
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  trustedHandle('onboarding:choose-repositories', async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
      title: 'Add existing Singularity repositories'
    });
    if (result.canceled || !result.filePaths.length) return [];
    const repositories = [];
    for (const repository of result.filePaths) {
      const root = await validateRepositoryDirectory(repository);
      repositories.push({ path: root, name: path.basename(root) });
    }
    return repositories;
  });
  trustedHandle('onboarding:jira-connect', async (event, { connection: input }) => {
    assertTrustedSender(event);
    const { normalizeJiraConnection, discoverJiraConnection } = await importCliModule('jira.mjs');
    const connection = normalizeJiraConnection({ ...input, name: input?.name || 'corporate-jira' });
    const discovery = await discoverJiraConnection({ connection });
    const saved = await jiraCredentialStore().save({
      ...connection,
      account: discovery.account,
      server: discovery.server
    });
    jiraCache.clear();
    return { ...saved, discovery };
  });
  trustedHandle('onboarding:save', async (event, { profile: input, complete = false }) => {
    assertTrustedSender(event);
    const jira = await jiraCredentialStore().safeStatus();
    const prepared = await prepareOnboardingProfile(structuredClone(input ?? {}), {
      complete,
      jiraConnected: jira.connected,
      validateWorkspace: validateOnboardingWorkspace,
      validateRepository: validateRepositoryDirectory
    });
    const profile = await saveOnboardingProfile(onboardingProfilePath(), prepared.profile, {
      complete,
      jiraConnected: jira.connected
    });
    for (const repository of profile.repositories) {
      await rememberRecentRepository(recentRepositoriesPath(), repository);
    }
    return { profile, jira, notices: prepared.notices };
  });
  trustedHandle('repository:choose', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open a Singularity Flow repository' });
    if (result.canceled || !result.filePaths[0]) return null;
    return openRepository(result.filePaths[0]);
  });
  trustedHandle('repository:recent', () => recentRepositories());
  trustedHandle('repository:open', (_event, { repository }) => openRepository(repository));
  trustedHandle('repository:forget', async (_event, { repository }) => {
    await forgetRecentRepository(recentRepositoriesPath(), repository);
    return recentRepositories();
  });
  trustedHandle('repository:snapshot', (_event, { repository, workId, initiativeId }) => snapshot(assertRepository(repository), workId, initiativeId));
  trustedHandle('workspace:recent', async (event) => {
    assertTrustedSender(event);
    return recentWorkspaces();
  });
  trustedHandle('workspace:choose', async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open a Singularity workspace' });
    if (result.canceled || !result.filePaths[0]) return null;
    const { readWorkspace, rememberWorkspace, workspaceStatus } = await workspaceModule();
    const workspace = await readWorkspace(result.filePaths[0]);
    const status = await workspaceStatus(workspace.path);
    await rememberWorkspace(workspaceRegistryPath(), workspace, status);
    return openRepository(requireReadyLeadRepository(status), { workspace: status });
  });
  trustedHandle('workspace:open', async (event, { workspace: workspacePath }) => {
    assertTrustedSender(event);
    const { readWorkspace, rememberWorkspace, workspaceStatus } = await workspaceModule();
    const workspace = await readWorkspace(workspacePath);
    const status = await workspaceStatus(workspace.path);
    await rememberWorkspace(workspaceRegistryPath(), workspace, status);
    return openRepository(requireReadyLeadRepository(status), { workspace: status });
  });
  trustedHandle('workspace:forget', async (event, { workspace }) => {
    assertTrustedSender(event);
    const { forgetWorkspace } = await workspaceModule();
    await forgetWorkspace(workspaceRegistryPath(), workspace);
    if (activeWorkspace?.workspace?.path === path.resolve(workspace)) activeWorkspace = null;
    return recentWorkspaces();
  });
  trustedHandle('workspace:choose-base', async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Choose a workspace storage directory' });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  trustedHandle('inbox:refresh', async (_event, { repository }) => {
    const root = assertRepository(repository);
    const approvalInbox = await invokeCli(root, ['inbox', '--json'], { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
    return { ...await snapshot(root), approvalInbox };
  });
  trustedHandle('inbox:attach', async (_event, { repository, workId }) => {
    const root = assertRepository(repository);
    await invokeCli(root, ['session', 'attach', workId, '--json'], { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
    return snapshot(root, workId);
  });
  trustedHandle('configuration:validate', (_event, { repository }) => invokeCli(assertRepository(repository), ['desktop', 'validate', '--json']));
  trustedHandle('configuration:save', (_event, { repository, filePath, content }) => invokeCli(assertRepository(repository), ['desktop', 'save', filePath], { input: content }));
  trustedHandle('configuration:delete-template', (_event, { repository, filePath }) => invokeCli(assertRepository(repository), ['desktop', 'delete-template', filePath, '--json']));
  trustedHandle('configuration:delete-file', (_event, { repository, filePath }) => invokeCli(assertRepository(repository), ['desktop', 'delete-file', filePath, '--json']));
  trustedHandle('configuration:download', async (_event, { repository, filePath }) => {
    const source = await invokeCli(assertRepository(repository), ['desktop', 'read', filePath, '--json']);
    const result = await dialog.showSaveDialog({ title: 'Download Singularity Flow file', defaultPath: source.name });
    if (result.canceled || !result.filePath) return { canceled: true };
    await writeFile(result.filePath, Buffer.from(source.contentBase64, 'base64'));
    return { path: result.filePath, bytes: source.bytes };
  });
  trustedHandle('configuration:import', async (_event, { repository, targetDirectory, targetPath, kind }) => {
    const root = assertRepository(repository);
    const result = await dialog.showOpenDialog({ properties: ['openFile'], title: 'Import YAML or Markdown', filters: [{ name: 'Singularity Flow files', extensions: ['md', 'yml', 'yaml'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const sourcePath = result.filePaths[0];
    const extension = path.extname(sourcePath).toLowerCase();
    if (!['.md', '.yml', '.yaml'].includes(extension)) throw new Error('Only Markdown and YAML files can be imported.');
    let relative;
    if (targetPath) relative = safeRelativePath(targetPath, 'Import target');
    else if (kind === 'skill') {
      const parent = path.basename(path.dirname(sourcePath));
      const id = portableName(path.basename(sourcePath).toLowerCase() === 'skill.md' ? parent : path.basename(sourcePath, extension));
      relative = `${safeRelativePath(targetDirectory, 'Import directory').replace(/\/$/, '')}/${id}/SKILL.md`;
    } else relative = `${safeRelativePath(targetDirectory, 'Import directory').replace(/\/$/, '')}/${path.basename(sourcePath)}`;
    const absolute = path.join(root, relative);
    if (existsSync(absolute)) {
      const confirmation = await dialog.showMessageBox({ type: 'warning', buttons: ['Cancel', 'Replace'], defaultId: 0, cancelId: 0, title: 'Replace existing configuration?', message: `${relative} already exists.`, detail: 'Replacing it updates the repository working tree and remains uncommitted until you publish.' });
      if (confirmation.response !== 1) return { canceled: true };
    }
    const saved = await invokeCli(root, ['desktop', 'save', relative], { input: await readFile(sourcePath, 'utf8') });
    return { ...saved, sourcePath };
  });
  trustedHandle('configuration:export-bundle', async (_event, { repository }) => {
    const root = assertRepository(repository);
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Choose where to export Singularity Flow configuration' });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const bundle = await invokeCli(root, ['desktop', 'export-bundle', '--json']);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const output = path.join(result.filePaths[0], `singularity-flow-export-${stamp}`);
    for (const file of bundle.files) {
      const relative = safeRelativePath(file.path, 'Export path');
      const destination = path.join(output, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content, 'utf8');
    }
    return { path: output, files: bundle.files.length, worldModelRepositoryOwned: true };
  });
  trustedHandle('configuration:publish', (_event, { repository, message }) => invokeCli(assertRepository(repository), ['desktop', 'publish', '--message', message || 'Configure Singularity Flow workflow', '--json']));
  trustedHandle('configuration:bootstrap-portfolio', async (event, { repository, configuration }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    await invokeCli(root, ['desktop', 'portfolio-bootstrap', '--json'], {
      input: JSON.stringify(configuration ?? {}),
      timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS
    });
    return snapshot(root);
  });
  trustedHandle('session:persona', (_event, { repository, workId, persona }) => invokeCli(assertRepository(repository), ['desktop', 'session', persona, ...(workId ? ['--work-id', workId] : []), '--json']));
  trustedHandle('planning:preflight', (event, { repository }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    return copilotPlanningPreflight();
  });
  trustedHandle('copilot-service:status', (event, { repository }) => {
    assertTrustedSender(event);
    return copilotBackend.status(assertRepository(repository));
  });
  trustedHandle('copilot-service:start', (event, { repository, model }) => {
    assertTrustedSender(event);
    return copilotBackend.start(assertRepository(repository), { model: model?.trim() || null });
  });
  trustedHandle('copilot-service:stop', (event, { repository }) => {
    assertTrustedSender(event);
    return copilotBackend.stop(assertRepository(repository));
  });
  trustedHandle('copilot-service:logs', (event, { repository }) => {
    assertTrustedSender(event);
    return copilotBackend.logs(assertRepository(repository));
  });
  trustedHandle('planning:context', async (event, {
    repository, scope, id, phase, persona, target, objective
  }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const result = await invokeCli(root, [
      'desktop', 'planning-context',
      '--scope', scope,
      '--id', id,
      '--phase', phase,
      '--persona', persona,
      '--target', target,
      ...(objective?.trim() ? ['--objective', objective.trim()] : []),
      '--json'
    ], { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
    planningPacks.set(result.sessionId, {
      repository: root,
      contextPath: result.contextPath,
      manifestPath: result.manifestPath
    });
    return result;
  });
  trustedHandle('planning:start', async (event, { repository, planningSessionId, model }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const pack = planningPacks.get(planningSessionId);
    if (!pack || pack.repository !== root) throw new Error('Build and review a planning context before starting Copilot.');
    return copilotBackend.beginPlanning(root, planningSessionId, {
      model: model?.trim() || null,
      prompt: `Read and follow the complete governed planning contract at ${pack.contextPath}. Work only in native Plan mode. Before finalizing, identify assumptions that materially change scope, story boundaries, repository ownership, dependencies, acceptance criteria, or Jira hierarchy. Ask those questions through ACP form elicitation so Planning Studio can show them inline, then incorporate the answers. Produce a decision-ready proposal for the configured promotion target and do not implement or mutate repository files.${planningWorkspaceBoundary(root)}`
    });
  });
  trustedHandle('planning:prompt', (event, { repository, planningSessionId, text }) => {
    assertTrustedSender(event);
    return copilotBackend.prompt(assertRepository(repository), planningSessionId, text);
  });
  trustedHandle('planning:answer', (event, {
    repository, planningSessionId, questionId, content, action
  }) => {
    assertTrustedSender(event);
    return copilotBackend.answer(assertRepository(repository), planningSessionId, questionId, { content, action });
  });
  trustedHandle('planning:stop', async (event, { repository, planningSessionId }) => {
    assertTrustedSender(event);
    return copilotBackend.releasePlanning(assertRepository(repository), planningSessionId);
  });
  trustedHandle('planning:promote', async (event, { repository, planningSessionId, persona, content }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const pack = planningPacks.get(planningSessionId);
    if (!pack || pack.repository !== root) throw new Error('Planning context is not available for promotion.');
    const result = await invokeCli(root, [
      'desktop', 'planning-promote',
      '--session', planningSessionId,
      ...(persona ? ['--persona', persona] : []),
      '--json'
    ], { input: content, timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
    await copilotBackend.releasePlanning(root, planningSessionId);
    planningPacks.delete(planningSessionId);
    return result;
  });
  trustedHandle('initiative:materialize-preview', (_event, { repository, initiativeId }) => invokeCli(
    assertRepository(repository),
    ['desktop', 'initiative-materialize-preview', '--initiative', initiativeId, '--json'],
    { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS }
  ));
  trustedHandle('initiative:materialize', (_event, { repository, initiativeId, confirmation }) => invokeCli(
    assertRepository(repository),
    ['desktop', 'initiative-materialize', '--initiative', initiativeId, '--confirm', confirmation, '--json'],
    { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS }
  ));
  trustedHandle('initiative:sync', (_event, { repository, initiativeId }) => invokeCli(
    assertRepository(repository),
    ['desktop', 'initiative-sync', '--initiative', initiativeId, '--json'],
    { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS }
  ));
  trustedHandle('epic:sources', async (event, { repository, initiativeId }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const { listEpicSources } = await importCliModule('epic-sources.mjs');
    const result = await listEpicSources(root, initiativeId);
    return {
      manifest: result.manifest,
      credentials: await storageCredentialStore().status()
    };
  });
  trustedHandle('epic:storage-credential', async (event, { repository, providerId, token }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    return storageCredentialStore().save(providerId, token);
  });
  trustedHandle('epic:storage-disconnect', async (event, { repository, providerId }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    return storageCredentialStore().disconnect(providerId);
  });
  trustedHandle('epic:sharepoint-connect', async (event, { repository, initiativeId, providerId }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const { loadInitiative } = await importCliModule('initiative-state.mjs');
    const { portfolio, initiative } = await loadInitiative(root, initiativeId);
    const storage = initiative.resolution.storage ?? portfolio.storage;
    const provider = storage.providers?.[providerId];
    if (provider?.type !== 'sharepoint') throw new Error(`Storage provider '${providerId ?? ''}' is not a configured SharePoint provider.`);
    const credential = await authorizeSharePoint(provider, {
      openExternal: (url) => shell.openExternal(url)
    });
    return storageCredentialStore().saveOAuth(providerId, credential);
  });
  async function epicSourceRuntime(root, initiativeId, providerId = null) {
    const { loadInitiative } = await importCliModule('initiative-state.mjs');
    const { portfolio, initiative } = await loadInitiative(root, initiativeId);
    const storage = initiative.resolution.storage ?? portfolio.storage;
    const selectedId = providerId ?? storage.defaultProvider;
    const provider = storage.providers?.[selectedId];
    if (!provider) throw new Error(`Unknown Epic source provider '${selectedId ?? ''}'.`);
    const runtime = { tokens: {} };
    const credentialErrors = {};
    for (const [id, configured] of Object.entries(storage.providers ?? {})) {
      if (!['artifactory', 'sharepoint'].includes(configured.type)) continue;
      try {
        runtime.tokens[id] = configured.type === 'sharepoint'
          ? await sharePointAccessToken(id, configured, storageCredentialStore())
          : (await storageCredentialStore().load(id)).token;
      } catch (error) {
        credentialErrors[id] = error;
      }
    }
    if (Object.values(storage.providers ?? {}).some((entry) => entry.type === 'jira-attachment')) {
      const governed = await governedInitiativeJiraConnection(root, initiativeId, { issueKey: initiativeId });
      runtime.jiraConnection = governed.connection;
    }
    if (['artifactory', 'sharepoint'].includes(provider.type) && !runtime.tokens[selectedId]) {
      throw new Error(credentialErrors[selectedId]?.message ?? `No secure credential is configured for storage provider '${selectedId}'.`);
    }
    return { selectedId, runtime };
  }
  trustedHandle('epic:sources-upload', async (event, {
    repository, initiativeId, providerId = null, mimeType = 'application/octet-stream'
  }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const selected = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: `Add governed sources to ${initiativeId}`
    });
    if (selected.canceled) return { canceled: true, records: [] };
    const [{ registerEpicSource }, { commitInitiativeChange }] = await Promise.all([
      importCliModule('epic-sources.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const runtime = await epicSourceRuntime(root, initiativeId, providerId);
    const records = [];
    for (const filePath of selected.filePaths) {
      const result = await registerEpicSource(root, {
        initiativeId,
        providerId: runtime.selectedId,
        filePath,
        mimeType,
        runtime: runtime.runtime
      });
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][epic:source] ${result.record.sourceId}`, { appendOnly: true });
      records.push({ ...result.record, publication });
    }
    return { canceled: false, records };
  });
  trustedHandle('epic:sources-add-url', async (event, {
    repository, initiativeId, providerId = null, url, label = null, mimeType = 'application/octet-stream'
  }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [{ registerEpicSource }, { commitInitiativeChange }] = await Promise.all([
      importCliModule('epic-sources.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const runtime = await epicSourceRuntime(root, initiativeId, providerId);
    const result = await registerEpicSource(root, {
      initiativeId,
      providerId: runtime.selectedId,
      url,
      label,
      mimeType,
      runtime: runtime.runtime
    });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][epic:source] ${result.record.sourceId}`, { appendOnly: true });
    return { record: result.record, publication };
  });
  trustedHandle('epic:sources-verify', async (event, {
    repository, initiativeId, providerId = null, materialize = true
  }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const { verifyEpicSources } = await importCliModule('epic-sources.mjs');
    const selected = await epicSourceRuntime(root, initiativeId, providerId);
    return verifyEpicSources(root, initiativeId, { materialize, runtime: selected.runtime });
  });
  trustedHandle('epic:review-inbox', async (event, { repository, initiativeId }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const { listEpicReviewInbox } = await importCliModule('epic-review.mjs');
    return listEpicReviewInbox(root, initiativeId);
  });
  trustedHandle('epic:review', async (event, { repository, initiativeId, storyId, packetSha256 = null }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const { epicReviewStory } = await importCliModule('epic-review.mjs');
    return epicReviewStory(root, initiativeId, storyId, { packetSha256 });
  });
  trustedHandle('epic:checks', async (event, { repository, initiativeId, storyId, packetSha256 = null }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const { epicCheckStory } = await importCliModule('epic-review.mjs');
    return epicCheckStory(root, initiativeId, storyId, { packetSha256 });
  });
  trustedHandle('epic:decision', async (event, {
    repository, initiativeId, storyId, packetSha256, decision, persona, target = null, reason = null
  }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const { epicReviewDecision } = await importCliModule('epic-review.mjs');
    return epicReviewDecision(root, initiativeId, storyId, {
      packetSha256, decision, persona, target, reason
    });
  });
  trustedHandle('epic:complete', async (event, { repository, initiativeId, confirmation }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [
      { completeEpicDelivery },
      { commitInitiativeChange, loadInitiative },
      { syncInitiativeRepositories },
      { identity }
    ] = await Promise.all([
      importCliModule('epic-completion.mjs'),
      importCliModule('initiative-state.mjs'),
      importCliModule('initiative-repositories.mjs'),
      importCliModule('git.mjs')
    ]);
    const synchronized = await syncInitiativeRepositories(root, initiativeId);
    const synced = await loadInitiative(root, initiativeId);
    const syncPublication = await commitInitiativeChange(
      root,
      synced.portfolio,
      synced.initiative,
      `[${initiativeId}][epic:sync] completion preflight`
    );
    const result = await completeEpicDelivery(root, initiativeId, {
      confirmation,
      actor: identity(root)
    });
    const publication = await commitInitiativeChange(
      root,
      result.portfolio,
      result.initiative,
      `[${initiativeId}][epic:complete] ${result.record.sha256.slice(0, 12)}`
    );
    return {
      record: result.record,
      reportPath: result.reportPath,
      synchronized,
      publications: { sync: syncPublication, completion: publication }
    };
  });
  trustedHandle('epic:jira-drift', async (event, { repository, initiativeId }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const governed = await governedInitiativeJiraConnection(root, initiativeId);
    const [{ observeJiraDrift }, { commitInitiativeChange }] = await Promise.all([
      importCliModule('jira-initiative.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const result = await observeJiraDrift(root, initiativeId, { connection: governed.connection });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][epic:jira-drift] observe`);
    return { record: result.record, publication };
  });
  trustedHandle('jira:status', async (event, { repository }) => {
    assertTrustedSender(event);
    const { policy } = await jiraPolicy(repository);
    const credentials = await jiraCredentialStore().safeStatus(policy.connection);
    if (!credentials.connected) return { policy, credentials };
    try {
      await governedPolicyConnection(policy);
      return { policy, credentials };
    } catch (error) {
      return { policy, credentials: { ...credentials, connected: false, policyError: error.message }, error: error.message };
    }
  });
  trustedHandle('jira:connect', async (event, { repository, connection: input }) => {
    assertTrustedSender(event);
    const { policy } = await jiraPolicy(repository);
    const {
      assertJiraConnectionPolicy,
      normalizeJiraConnection,
      discoverJiraConnection
    } = await importCliModule('jira.mjs');
    if (input?.name && input.name !== policy.connection) {
      throw new Error(`Repository policy requires Jira connection name '${policy.connection}'.`);
    }
    const connection = normalizeJiraConnection({ ...input, name: policy.connection });
    assertJiraConnectionPolicy(connection, policy);
    const discovery = await discoverJiraConnection({ connection });
    const saved = await jiraCredentialStore().save({
      ...connection,
      account: discovery.account,
      server: discovery.server
    });
    jiraCache.clear();
    return { ...saved, discovery };
  });
  trustedHandle('jira:disconnect', async (event, { repository }) => {
    assertTrustedSender(event);
    const { policy } = await jiraPolicy(repository);
    jiraCache.clear();
    return jiraCredentialStore().disconnect(policy.connection);
  });
  trustedHandle('jira:reset-credentials', async (event, { repository = null } = {}) => {
    assertTrustedSender(event);
    if (repository) await jiraPolicy(repository);
    jiraCache.clear();
    return jiraCredentialStore().reset();
  });
  trustedHandle('jira:projects', async (event, { repository, query, refresh = false }) => {
    assertTrustedSender(event);
    const { policy, connection } = await governedJiraConnection(repository);
    const key = jiraCacheKey(connection, 'projects', query ?? '');
    const cached = !refresh && jiraCacheRead(key, policy.read.cacheMinutes);
    if (cached) return cached;
    const { listProjects } = await importCliModule('jira.mjs');
    const projects = await listProjects({ connection, query, limit: 100 });
    const allowed = policy.allowedProjects?.length ? projects.filter((project) => policy.allowedProjects.includes(project.key)) : projects;
    return jiraCacheWrite(key, allowed);
  });
  trustedHandle('jira:epics', async (event, { repository, projectKey, refresh = false }) => {
    assertTrustedSender(event);
    const { policy, connection } = await governedJiraConnection(repository, { projectKey });
    if (!policy.read.epics) throw new Error('Jira Epic browsing is disabled by repository policy.');
    const key = jiraCacheKey(connection, 'epics', projectKey);
    const cached = !refresh && jiraCacheRead(key, policy.read.cacheMinutes);
    if (cached) return cached;
    const { listEpics } = await importCliModule('jira.mjs');
    return jiraCacheWrite(key, await listEpics(projectKey, { connection, issueType: policy.epicIssueType, limit: 100 }));
  });
  trustedHandle('jira:workspace-anchors', async (event, { repository, projectKey, refresh = false }) => {
    assertTrustedSender(event);
    const { policy, connection } = await governedJiraConnection(repository, { projectKey });
    const key = jiraCacheKey(connection, 'workspace-anchors', projectKey);
    const cached = !refresh && jiraCacheRead(key, policy.read.cacheMinutes);
    if (cached) return cached;
    const { listWorkspaceAnchors } = await importCliModule('jira.mjs');
    return jiraCacheWrite(key, await listWorkspaceAnchors(projectKey, { connection, limit: 100 }));
  });
  trustedHandle('jira:hierarchy', async (event, { repository, anchorKey, refresh = false }) => {
    assertTrustedSender(event);
    const { policy, connection } = await governedJiraConnection(repository, { issueKey: anchorKey });
    const key = jiraCacheKey(connection, 'hierarchy', anchorKey);
    const cached = !refresh && jiraCacheRead(key, policy.read.cacheMinutes);
    if (cached) return cached;
    const { getIssueHierarchy } = await importCliModule('jira.mjs');
    return jiraCacheWrite(key, await getIssueHierarchy(anchorKey, { connection }));
  });
  trustedHandle('workspace:preview', async (event, {
    repository, baseDirectory, anchorKey, leadRepository, repositoryIds
  }) => {
    assertTrustedSender(event);
    const { root, portfolio, connection } = await governedJiraConnection(repository, { issueKey: anchorKey });
    const [{ getIssueHierarchy }, { previewWorkspace }, { run }] = await Promise.all([
      importCliModule('jira.mjs'),
      workspaceModule(),
      importCliModule('util.mjs')
    ]);
    const hierarchy = await getIssueHierarchy(anchorKey, { connection });
    const configured = structuredClone(portfolio.repositories ?? {});
    const origin = run('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFailure: true }).stdout.trim();
    const matching = Object.entries(configured).find(([, value]) => value.url === origin)?.[0] ?? null;
    const effectiveLead = leadRepository || matching || 'lead';
    if (!configured[effectiveLead]) {
      if (!origin) throw new Error('The open lead repository has no origin remote. Configure it in singularity/portfolio.yml before creating a workspace.');
      configured[effectiveLead] = { url: origin, defaultBranch: portfolio.repositories?.[effectiveLead]?.defaultBranch ?? 'main', required: true };
    }
    const selected = new Set(repositoryIds?.length ? repositoryIds : Object.keys(configured));
    selected.add(effectiveLead);
    const repositories = Object.fromEntries(Object.entries(configured)
      .filter(([id]) => selected.has(id))
      .map(([id, value]) => [id, { ...value, path: `repos/${id}` }]));
    return previewWorkspace({
      baseDirectory,
      anchor: {
        provider: 'jira',
        baseUrl: connection.baseUrl,
        key: hierarchy.anchor.key,
        issueId: hierarchy.anchor.id,
        issueTypeId: hierarchy.anchor.issueTypeId,
        issueTypeName: hierarchy.anchor.issueType,
        hierarchyLevel: hierarchy.anchor.hierarchyLevel,
        title: hierarchy.anchor.title,
        url: hierarchy.anchor.url,
        fetchedAt: hierarchy.fetchedAt
      },
      leadRepository: effectiveLead,
      repositories,
      hierarchySnapshot: hierarchy
    });
  });
  trustedHandle('workspace:create', async (event, {
    repository, baseDirectory, anchorKey, leadRepository, repositoryIds, confirmation
  }) => {
    assertTrustedSender(event);
    const { root, portfolio, connection } = await governedJiraConnection(repository, { issueKey: anchorKey });
    const [{ getIssueHierarchy }, workspaceApi, { run }] = await Promise.all([
      importCliModule('jira.mjs'),
      workspaceModule(),
      importCliModule('util.mjs')
    ]);
    const hierarchy = await getIssueHierarchy(anchorKey, { connection });
    const configured = structuredClone(portfolio.repositories ?? {});
    const origin = run('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFailure: true }).stdout.trim();
    const matching = Object.entries(configured).find(([, value]) => value.url === origin)?.[0] ?? null;
    const effectiveLead = leadRepository || matching || 'lead';
    if (!configured[effectiveLead]) {
      if (!origin) throw new Error('The open lead repository has no origin remote.');
      configured[effectiveLead] = { url: origin, defaultBranch: 'main', required: true };
    }
    const selected = new Set(repositoryIds?.length ? repositoryIds : Object.keys(configured));
    selected.add(effectiveLead);
    const repositories = Object.fromEntries(Object.entries(configured)
      .filter(([id]) => selected.has(id))
      .map(([id, value]) => [id, { ...value, path: `repos/${id}` }]));
    const input = {
      baseDirectory,
      anchor: {
        provider: 'jira',
        baseUrl: connection.baseUrl,
        key: hierarchy.anchor.key,
        issueId: hierarchy.anchor.id,
        issueTypeId: hierarchy.anchor.issueTypeId,
        issueTypeName: hierarchy.anchor.issueType,
        hierarchyLevel: hierarchy.anchor.hierarchyLevel,
        title: hierarchy.anchor.title,
        url: hierarchy.anchor.url,
        fetchedAt: hierarchy.fetchedAt
      },
      leadRepository: effectiveLead,
      repositories,
      hierarchySnapshot: hierarchy
    };
    const created = await workspaceApi.createWorkspace(input, { confirmation });
    await workspaceApi.rememberWorkspace(workspaceRegistryPath(), created.workspace, created.status);
    return openRepository(requireReadyLeadRepository(created.status), { workspace: created.status });
  });
  trustedHandle('workspace:status', async (event, { workspace }) => {
    assertTrustedSender(event);
    const { workspaceStatus } = await workspaceModule();
    return workspaceStatus(assertWorkspace(workspace));
  });
  trustedHandle('workspace:sync', async (event, { workspace }) => {
    assertTrustedSender(event);
    const { fetchWorkspace } = await workspaceModule();
    return fetchWorkspace(assertWorkspace(workspace));
  });
  trustedHandle('workspace:repair', async (event, { workspace }) => {
    assertTrustedSender(event);
    const { repairWorkspace } = await workspaceModule();
    return repairWorkspace(assertWorkspace(workspace));
  });
  trustedHandle('workspace:documents-stage', async (event, { workspace }) => {
    assertTrustedSender(event);
    const workspaceRoot = assertWorkspace(workspace);
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: 'Stage workspace documents (not governed)' });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const { stageWorkspaceDocuments } = await workspaceModule();
    return stageWorkspaceDocuments(workspaceRoot, result.filePaths);
  });
  trustedHandle('workspace:documents-promote', async (event, {
    repository, workspace, documentPath, workId
  }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const workspaceRoot = assertWorkspace(workspace);
    const [{ resolveWorkspaceDocument }, { branch }] = await Promise.all([
      workspaceModule(),
      importCliModule('git.mjs')
    ]);
    if (!workId || branch(root) !== workId) {
      throw new Error(`Check out or resume work item ${workId || '(none)'} before importing a staged document.`);
    }
    const document = await resolveWorkspaceDocument(workspaceRoot, documentPath);
    const publication = await invokeCli(root, ['documents', 'upload', document.absolutePath], {
      json: false,
      timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS
    });
    return { publication, document, snapshot: await snapshot(root, workId) };
  });
  trustedHandle('jira:children', async (event, { repository, epicKey, refresh = false }) => {
    assertTrustedSender(event);
    const { policy, connection } = await governedJiraConnection(repository, { issueKey: epicKey });
    if (!policy.read.stories) throw new Error('Jira story browsing is disabled by repository policy.');
    const key = jiraCacheKey(connection, 'children', epicKey);
    const cached = !refresh && jiraCacheRead(key, policy.read.cacheMinutes);
    if (cached) return cached;
    const { listEpicStories } = await importCliModule('jira.mjs');
    return jiraCacheWrite(key, await listEpicStories(epicKey, { connection, limit: 100 }));
  });
  trustedHandle('epic:start', async (event, {
    repository, epicKey, profile = 'epic-planning', persona
  }) => {
    assertTrustedSender(event);
    const { root, connection } = await governedJiraConnection(repository, { issueKey: epicKey });
    const [
      { getIssue },
      { loadDefinition },
      { loadPortfolio },
      {
        assertClean, checkout, identity
      },
      {
        commitInitiativeChange, createInitiative, loadInitiative
      },
      { registerInitiativeEvidence },
      { setPersonaSession }
    ] = await Promise.all([
      importCliModule('jira.mjs'),
      importCliModule('config.mjs'),
      importCliModule('initiative-config.mjs'),
      importCliModule('git.mjs'),
      importCliModule('initiative-state.mjs'),
      importCliModule('initiative-evidence.mjs'),
      importCliModule('session.mjs')
    ]);
    const [definition, portfolio, source] = await Promise.all([
      loadDefinition(root),
      loadPortfolio(root),
      getIssue(epicKey, { connection })
    ]);
    if (!portfolio.initiativeProfiles?.[profile]) throw new Error(`Unknown initiative profile '${profile}'.`);
    if (!definition.personas?.[persona]) throw new Error(`Unknown persona '${persona ?? ''}'.`);
    assertClean(root);
    checkout(root, epicKey, { base: definition.defaultBaseBranch, fetch: true });
    const actor = identity(root);
    await setPersonaSession(root, definition, actor, persona, epicKey);
    const created = await createInitiative(root, {
      id: epicKey,
      title: source.title ?? epicKey,
      profile,
      source,
      persona
    });
    if (profile === 'epic-planning') {
      await registerInitiativeEvidence(root, {
        initiativeId: epicKey,
        phaseId: 'epic-intake',
        checkId: 'epic-identity-verified',
        assurance: 'system-verified',
        verificationMethod: 'jira-issue-read',
        source: {
          externalId: source.id ?? source.key ?? epicKey,
          version: source.updatedAt ?? null,
          observedState: `${source.key ?? epicKey}: ${source.title ?? epicKey}`
        },
        persona
      });
    }
    const started = await loadInitiative(root, epicKey, created.portfolio);
    const publication = await commitInitiativeChange(
      root,
      started.portfolio,
      started.initiative,
      `[${epicKey}][epic:init] start ${profile}`
    );
    return { initiativeId: epicKey, source, publication };
  });
  trustedHandle('jira:adopt-preview', async (event, {
    repository, initiativeId, epicKey, repositoryMap
  }) => {
    assertTrustedSender(event);
    const { root, connection } = await governedInitiativeJiraConnection(repository, initiativeId, { issueKey: epicKey });
    const { previewJiraAdoption } = await importCliModule('jira-initiative.mjs');
    return previewJiraAdoption(root, initiativeId, epicKey, { repositoryMap, connection });
  });
  trustedHandle('jira:adopt', async (event, {
    repository, initiativeId, epicKey, repositoryMap, replace = false
  }) => {
    assertTrustedSender(event);
    const { root, connection } = await governedInitiativeJiraConnection(repository, initiativeId, { issueKey: epicKey });
    const [{ adoptJiraEpic }, { commitInitiativeChange }, { identity }] = await Promise.all([
      importCliModule('jira-initiative.mjs'),
      importCliModule('initiative-state.mjs'),
      importCliModule('git.mjs')
    ]);
    const actor = identity(root).email?.toLowerCase() ?? identity(root).name;
    const result = await adoptJiraEpic(root, initiativeId, epicKey, { repositoryMap, replace, connection, actor });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:jira-adopt] ${epicKey}`);
    return { sourceSha256: result.sourceSha256, unresolved: result.unresolved, breakdown: result.breakdown, publication };
  });
  trustedHandle('jira:write-plan', async (event, { repository, initiativeId, artifacts = [] }) => {
    assertTrustedSender(event);
    const { root, connection } = await governedInitiativeJiraConnection(repository, initiativeId);
    const [{ createJiraWritePlan }, { commitInitiativeChange }] = await Promise.all([
      importCliModule('jira-initiative.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const result = await createJiraWritePlan(root, initiativeId, { connection, artifactSelections: artifacts });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:jira-plan] ${result.plan.sha256.slice(0, 12)}`);
    return { plan: result.plan, publication };
  });
  trustedHandle('jira:apply', async (event, {
    repository, initiativeId, planSha256, confirmation
  }) => {
    assertTrustedSender(event);
    const { root, connection } = await governedInitiativeJiraConnection(repository, initiativeId);
    const [{ applyJiraWritePlan }, { commitInitiativeChange }, { identity }] = await Promise.all([
      importCliModule('jira-initiative.mjs'),
      importCliModule('initiative-state.mjs'),
      importCliModule('git.mjs')
    ]);
    const actor = identity(root).email?.toLowerCase() ?? identity(root).name;
    const result = await applyJiraWritePlan(root, initiativeId, { planSha256, confirmation, connection, actor });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:jira-apply] ${planSha256.slice(0, 12)}`);
    jiraCache.clear();
    return { plan: result.plan, results: result.results, publication };
  });
  trustedHandle('jira:open', async (event, { repository, url }) => {
    assertTrustedSender(event);
    const { policy } = await jiraPolicy(repository);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Jira links must be public-form HTTPS URLs without embedded credentials.');
    if (policy.allowedHosts?.length && !policy.allowedHosts.includes(parsed.hostname.toLowerCase())) throw new Error('Jira link is outside the repository host allowlist.');
    await shell.openExternal(parsed.href);
    return { opened: parsed.href };
  });
  trustedHandle('documents:upload', async (_event, { repository }) => {
    const root = assertRepository(repository);
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: 'Add supporting documents' });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return invokeCli(root, ['documents', 'upload', ...result.filePaths], { json: false });
  });
  trustedHandle('documents:upload-directory', async (_event, { repository }) => {
    const root = assertRepository(repository);
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Add a design or evidence package' });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return invokeCli(root, ['documents', 'upload', result.filePaths[0]], { json: false, timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
  });
  trustedHandle('documents:add-url', (_event, { repository, url, label }) => invokeCli(assertRepository(repository), ['documents', 'upload', '--url', url, ...(label ? ['--label', label] : [])], { json: false }));
  trustedHandle('documents:preview', (_event, { repository, workId, reference }) => invokeCli(
    assertRepository(repository),
    ['documents', 'preview', reference, '--work-id', workId, '--json'],
    { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS }
  ));
  trustedHandle('documents:open', async (_event, { repository, workId, record }) => {
    const root = assertRepository(repository);
    const resolved = await invokeCli(root, ['documents', 'view', record.id, '--work-id', workId, '--json']);
    if (resolved.record.url) {
      const parsed = new URL(resolved.record.url);
      if (parsed.protocol !== 'https:') throw new Error('Only HTTPS document links can be opened.');
      if (parsed.username || parsed.password) throw new Error('Document links cannot contain embedded credentials.');
      await shell.openExternal(parsed.href);
      return { opened: parsed.href };
    }
    const absolute = resolved.absolutePath;
    if (!absolute) throw new Error('Document has no governed local path.');
    const error = await shell.openPath(absolute);
    if (error) throw new Error(error);
    return { opened: absolute };
  });
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0b0d10',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow = window;
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  if (!app.isPackaged) await window.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
  else await window.loadFile(path.join(here, '../dist/index.html'));
}

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => {
  void copilotBackend.stopAll();
  planningPacks.clear();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
