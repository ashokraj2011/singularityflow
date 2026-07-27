import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell } from 'electron';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { invokeCliProcess, REPOSITORY_SNAPSHOT_TIMEOUT_MS, validateRepositoryDirectory } from './cli-runner.mjs';
import { forgetRecentRepository, readRecentRepositories, rememberRecentRepository } from './recent-repositories.mjs';
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
import {
  inspectWorkspaceSelection
} from './workspace-selection.mjs';
import {
  assertWorkspaceEpicIssue,
  assertWorkspaceEpicKey,
  assertWorkspaceStoryIssue,
  assertWorkspaceStoryKey,
  jiraIssueKeyFromReference,
  summarizeWorkspaceEpicProjects,
  workspaceJiraRouting,
  workspacePortfolioConfiguration
} from './workspace-epic.mjs';
import { installElectronNetworkFetch } from './network-fetch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, 'preload.cjs');
let activeRepository = null;
let activeWorkspace = null;
let mainWindow = null;
let eventHorizonModulePromise = null;
let workspaceRegistryImportPromise = null;
const jiraCache = new Map();

function recentRepositoriesPath() { return path.join(app.getPath('userData'), 'recent-repositories.json'); }
// Desktop, CLI, Copilot skills and Event Horizon must see one workspace
// registry. Keeping a second copy under Electron userData made a workspace
// appear saved in the app while `sflow-workspace current` reported none.
function workspaceStateDirectory() {
  return path.dirname(process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY
    || path.join(app.getPath('home'), '.singularity-flow', 'workspaces.json'));
}
function workspaceRegistryPath() {
  return path.resolve(process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY
    || path.join(workspaceStateDirectory(), 'workspaces.json'));
}
function legacyWorkspaceRegistryPath() { return path.join(app.getPath('userData'), 'workspaces.json'); }
function activeWorkspaceSelectionPath() {
  return path.resolve(process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE
    || path.join(workspaceStateDirectory(), 'active-workspace.json'));
}
function jiraCredentialsPath() { return path.join(app.getPath('userData'), 'jira-credentials.json'); }
function storageCredentialsPath() { return path.join(app.getPath('userData'), 'storage-credentials.json'); }
function onboardingProfilePath() { return path.join(app.getPath('userData'), 'onboarding.json'); }
function jiraCredentialStore() { return new JiraCredentialStore(jiraCredentialsPath(), safeStorage); }
function storageCredentialStore() { return new StorageCredentialStore(storageCredentialsPath(), safeStorage); }

function eventHorizonEntryPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'event-horizon', 'out', 'main', 'index.js')
    : path.resolve(here, '../../event-horizon/out/main/index.js');
}

async function eventHorizonModule() {
  if (!eventHorizonModulePromise) {
    const entry = eventHorizonEntryPath();
    if (!existsSync(entry)) {
      throw new Error('The Agent workbench bundle is missing. Run npm run event-horizon:build and rebuild the desktop app.');
    }
    process.env.SINGULARITY_FLOW_EMBED_EVENT_HORIZON = '1';
    eventHorizonModulePromise = import(pathToFileURL(entry).href).then((loaded) => {
      const module = loaded.default && typeof loaded.default === 'object'
        ? { ...loaded.default, ...loaded }
        : loaded;
      if (typeof module.openEventHorizonWindow !== 'function' || typeof module.eventHorizonStatus !== 'function') {
        throw new Error('The bundled Agent workbench does not expose its embedded desktop interface.');
      }
      return module;
    }).catch((error) => {
      eventHorizonModulePromise = null;
      throw error;
    });
  }
  return eventHorizonModulePromise;
}

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

// Every IPC handler runs in the main process, so a failure here never touched the CLI's command
// logging and left no trace anywhere — a click that "does nothing" was genuinely unobservable.
// Wrapping the dispatcher records the outcome of each channel against the repository being acted on.
function trustedHandle(channel, listener) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    const repository = args.find((value) => value && typeof value === 'object' && typeof value.repository === 'string')?.repository ?? null;
    const started = Date.now();
    try {
      const result = await listener(event, ...args);
      void ipcLogger(repository).then((log) => log?.debug(`ipc.${channel}.ok`, null, { durationMs: Date.now() - started })).catch(() => {});
      return result;
    } catch (error) {
      // Logged before rethrowing so the renderer still receives the rejection it expects.
      void ipcLogger(repository).then((log) => log?.error(`ipc.${channel}.failed`, error?.message, {
        durationMs: Date.now() - started, error
      })).catch(() => {});
      throw error;
    }
  });
}

// One logger per repository, reused across channels.
const ipcLoggers = new Map();
function ipcLogger(repository) {
  if (!repository) return Promise.resolve(null);
  if (!ipcLoggers.has(repository)) {
    ipcLoggers.set(repository, (async () => {
      try {
        const [{ repositoryLogger }, { loadDefinition }] = await Promise.all([
          importCliModule('logging.mjs'),
          importCliModule('config.mjs')
        ]);
        const definition = await loadDefinition(repository).catch(() => null);
        return repositoryLogger(repository, definition, { context: { surface: 'desktop', pid: process.pid } });
      } catch {
        return null;
      }
    })());
  }
  return ipcLoggers.get(repository);
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

async function openExistingWorkspace(workspacePath) {
  const { readWorkspace, rememberWorkspace, workspaceStatus } = await workspaceModule();
  const workspace = await readWorkspace(workspacePath);
  const status = await workspaceStatus(workspace.path);
  await rememberWorkspace(workspaceRegistryPath(), workspace, status);
  await activateDesktopWorkspace(workspace.id);
  return openWorkspaceStatus(status);
}

async function activateDesktopWorkspace(reference) {
  const { activateWorkspaceContext } = await importCliModule('workspace-context.mjs');
  await mkdir(path.dirname(activeWorkspaceSelectionPath()), { recursive: true });
  return activateWorkspaceContext(workspaceRegistryPath(), activeWorkspaceSelectionPath(), reference);
}

async function clearDesktopWorkspaceSelection(workspacePath) {
  const { readActiveWorkspaceContext } = await importCliModule('workspace-context.mjs');
  const selected = await readActiveWorkspaceContext(
    activeWorkspaceSelectionPath(),
    workspaceRegistryPath(),
    { refresh: false }
  ).catch(() => null);
  if (selected?.workspacePath === path.resolve(workspacePath)) {
    await unlink(activeWorkspaceSelectionPath()).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

async function openWorkspaceStatus(status, { message = null } = {}) {
  let repository;
  try {
    repository = requireReadyLeadRepository(status);
  } catch (error) {
    return {
      repository: null,
      workspace: status,
      workspaceSetup: {
        baseDirectory: path.dirname(status.workspace.path),
        mode: 'saved-needs-repair',
        message: message
          ?? `Workspace '${status.workspace.name}' is saved, but its lead repository is not ready. ${error.message}`
      }
    };
  }
  try {
    const result = await openRepository(repository, { workspace: status });
    if (message) {
      result.workspaceSetup = {
        mode: status.healthy ? 'saved' : 'saved-needs-repair',
        message
      };
    }
    return result;
  } catch (error) {
    return {
      repository: null,
      workspace: status,
      workspaceSetup: {
        baseDirectory: path.dirname(status.workspace.path),
        mode: 'saved-needs-repository',
        message: message
          ? `${message} The lead clone is not initialized for Singularity Flow: ${error.message}`
          : `Workspace '${status.workspace.name}' is saved, but its lead clone is not initialized for Singularity Flow: ${error.message}`
      }
    };
  }
}

async function openWorkspaceSetup(baseDirectory) {
  return {
    repository: null,
    workspace: null,
    workspaceSetup: {
      baseDirectory,
      mode: 'create',
      message: 'No existing workspace was found. Add the lead Git repository and participating repositories, then save the new workspace here.'
    }
  };
}

async function recentWorkspaces() {
  await importLegacyWorkspaceRegistry();
  const { readWorkspaceRegistry } = await workspaceModule();
  const entries = await readWorkspaceRegistry(workspaceRegistryPath());
  return Promise.all(entries.map(async (entry) => ({
    ...entry,
    available: existsSync(path.join(entry.path, 'workspace.json'))
  })));
}

async function importLegacyWorkspaceRegistry() {
  if (workspaceRegistryImportPromise) return workspaceRegistryImportPromise;
  workspaceRegistryImportPromise = (async () => {
    const legacy = legacyWorkspaceRegistryPath();
    const shared = workspaceRegistryPath();
    if (legacy === shared || !existsSync(legacy)) return;
    const workspaceApi = await workspaceModule();
    const entries = await workspaceApi.readWorkspaceRegistry(legacy);
    for (const entry of entries) {
      if (entry.archivedAt || !existsSync(path.join(entry.path, 'workspace.json'))) continue;
      try {
        const workspace = await workspaceApi.readWorkspace(entry.path);
        const status = await workspaceApi.workspaceStatus(workspace.path);
        await workspaceApi.rememberWorkspace(shared, workspace, status);
      } catch {
        // A missing or invalid legacy entry stays in the untouched legacy file
        // for manual recovery; it must not prevent the desktop from starting.
      }
    }
  })().catch((error) => {
    workspaceRegistryImportPromise = null;
    throw error;
  });
  return workspaceRegistryImportPromise;
}

function cliPath() {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'cli') : path.resolve(here, '../../..');
  return path.join(root, 'bin', 'singularity-flow.mjs');
}

function invokeCli(repository, args, { input = null, json = true, timeoutMs = undefined, onOutput = null } = {}) {
  return invokeCliProcess({
    executable: process.execPath,
    cli: cliPath(),
    repository,
    args,
    input,
    json,
    timeoutMs,
    onOutput,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SINGULARITY_FLOW_DESKTOP: '1' }
  });
}

function assertRepository(repository) {
  return requireActiveRepository(activeRepository, repository);
}

function assertWorkspace(workspace) {
  return requireActiveWorkspace(activeWorkspace, workspace);
}

async function workspaceRepositoryDefaults(repository) {
  const requested = path.resolve(repository);
  const root = await realpath(requested).catch(() => null);
  const rootInfo = root ? await lstat(root).catch(() => null) : null;
  if (!rootInfo?.isDirectory()) throw new Error(`Repository folder is not available: ${requested}`);
  const gitMetadata = await lstat(path.join(root, '.git')).catch(() => null);
  if (!gitMetadata || gitMetadata.isSymbolicLink() || (!gitMetadata.isDirectory() && !gitMetadata.isFile())) {
    throw new Error(`The selected folder is not a safe Git repository: ${root}`);
  }
  const { run } = await importCliModule('util.mjs');
  const topLevel = run('git', ['rev-parse', '--show-toplevel'], { cwd: root, allowFailure: true });
  const canonicalTopLevel = topLevel.status === 0 ? await realpath(topLevel.stdout.trim()).catch(() => null) : null;
  if (!canonicalTopLevel || canonicalTopLevel !== root) throw new Error(`Select the Git repository root instead of a nested folder: ${root}`);
  const origin = run('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFailure: true }).stdout.trim();
  if (!origin) throw new Error(`Repository '${root}' has no origin remote and cannot be cloned into a workspace.`);
  const remoteHead = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: root,
    allowFailure: true
  }).stdout.trim();
  const branch = remoteHead.replace(/^origin\//, '') || 'main';
  const id = path.basename(root)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'repository';
  return {
    id,
    localPath: root,
    url: origin,
    defaultBranch: branch,
    required: true,
    jira: { board: '' },
    metadata: { name: path.basename(root), appId: '' }
  };
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
    const belongsToWorkspace = status.repositories.some((entry) =>
      entry.absolutePath && path.resolve(entry.absolutePath) === activeRepository);
    if (belongsToWorkspace) {
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
  trustedHandle('agent-workbench:status', async (_event, { repository }) => {
    const root = assertRepository(repository);
    const module = await eventHorizonModule();
    const status = await module.eventHorizonStatus();
    return {
      ...status,
      repository: root,
      bundled: true,
      product: 'Event Horizon',
      description: 'A permission-gated ACP workbench for Copilot and other compatible coding agents.'
    };
  });
  trustedHandle('agent-workbench:open', async (_event, { repository, agentId = 'copilot', flowContext = null }) => {
    const root = assertRepository(repository);
    const module = await eventHorizonModule();
    const status = await module.eventHorizonStatus();
    const selected = status.agents.find((agent) => agent.id === agentId);
    if (!selected) throw new Error(`ACP agent '${agentId}' is not available on this computer.`);
    if (selected.available === false) {
      throw new Error(`${selected.name} was not found on this computer. Install its ACP command and reopen the Agent workbench.`);
    }
    module.openEventHorizonWindow({ cwd: root, agentId, flowContext });
    return { opened: true, repository: root, agent: selected };
  });
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
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open or create a Singularity project workspace',
      message: 'Choose an existing workspace, or choose the local folder where a new Jira-anchored workspace should be created.'
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selection = await inspectWorkspaceSelection(result.filePaths[0]);
    if (selection.mode === 'open') return openExistingWorkspace(selection.workspaces[0]);
    if (selection.mode === 'choose-specific') {
      throw new Error(
        `${selection.directory} contains ${selection.workspaces.length} managed project workspaces. `
        + `Choose the specific workspace folder: ${selection.workspaces.map((item) => path.basename(item)).join(', ')}.`
      );
    }
    return openWorkspaceSetup(selection.directory);
  });
  trustedHandle('workspace:open', async (event, { workspace: workspacePath }) => {
    assertTrustedSender(event);
    return openExistingWorkspace(workspacePath);
  });
  trustedHandle('workspace:forget', async (event, { workspace }) => {
    assertTrustedSender(event);
    const { forgetWorkspace } = await workspaceModule();
    await clearDesktopWorkspaceSelection(workspace);
    await forgetWorkspace(workspaceRegistryPath(), workspace);
    if (activeWorkspace?.workspace?.path === path.resolve(workspace)) activeWorkspace = null;
    return recentWorkspaces();
  });
  trustedHandle('workspace:archive', async (event, { workspace, confirmation }) => {
    assertTrustedSender(event);
    const { archiveWorkspace } = await workspaceModule();
    await archiveWorkspace(workspaceRegistryPath(), assertWorkspace(workspace), { confirmation });
    await clearDesktopWorkspaceSelection(workspace);
    if (activeWorkspace?.workspace?.path === path.resolve(workspace)) activeWorkspace = null;
    return recentWorkspaces();
  });
  trustedHandle('workspace:restore', async (event, { workspace }) => {
    assertTrustedSender(event);
    const { restoreWorkspace } = await workspaceModule();
    await restoreWorkspace(workspaceRegistryPath(), workspace);
    return recentWorkspaces();
  });
  trustedHandle('workspace:choose-base', async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Choose a workspace storage directory' });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  trustedHandle('workspace:repository-defaults', async (event, { repository }) => {
    assertTrustedSender(event);
    return workspaceRepositoryDefaults(assertRepository(repository));
  });
  trustedHandle('workspace:repository-choose', async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
      title: 'Add repositories to this workspace'
    });
    if (result.canceled || !result.filePaths.length) return [];
    return Promise.all(result.filePaths.map((repository) => workspaceRepositoryDefaults(repository)));
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
  trustedHandle('configuration:template-url-preview', async (_event, { repository, url }) => {
    assertRepository(repository);
    const { fetchRemoteMarkdown } = await importCliModule('agents.mjs');
    return fetchRemoteMarkdown(url, { maxBytes: 1024 * 1024, timeoutMs: 15000 });
  });
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
  trustedHandle('configuration:bootstrap-workspace-portfolio', async (event, { repository, workspace }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const workspaceRoot = assertWorkspace(workspace);
    const { readWorkspace } = await workspaceModule();
    const manifest = await readWorkspace(workspaceRoot);
    const credentials = await jiraCredentialStore().safeStatus();
    await invokeCli(root, ['desktop', 'portfolio-bootstrap', '--json'], {
      input: JSON.stringify(workspacePortfolioConfiguration(manifest, credentials)),
      timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS
    });
    return snapshot(root);
  });
  trustedHandle('worldmodel:generate', async (event, { repository, local = true, views = null, initiativeId = null }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const send = (payload) => {
      try { event.sender.send('worldmodel:progress', { repository: root, ...payload }); } catch { /* The renderer may close while Copilot is still running. */ }
    };
    send({ type: 'phase', phase: 'starting', message: 'Preparing the governed world-model prompt and repository snapshot.' });
    try {
      // Generation runs the world-model builder (Copilot) in an isolated worktree; allow up to 15
      // minutes. --local commits into the working tree without pushing to the remote default branch.
      send({ type: 'phase', phase: 'copilot', message: 'Copilot is inspecting the repository and generating Markdown views.' });
      // `wm build` has always accepted --views; the desktop passed only --local, so a rebuild from
      // the app could only ever produce whatever `views: auto` routed to — core plus development —
      // no matter which views the phases actually need.
      const requested = Array.isArray(views) ? views.filter((view) => /^[a-z][a-z0-9-]*$/.test(view)) : [];
      await invokeCli(root, [
        'wm', 'build',
        ...(requested.length ? ['--views', requested.join(',')] : []),
        ...(local ? ['--local'] : [])
      ], {
        json: false,
        timeoutMs: 15 * 60 * 1000,
        onOutput: (text, stream) => {
          const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          for (const line of lines.slice(-20)) send({ type: 'output', stream, message: line.slice(0, 1000) });
        }
      });
      send({ type: 'phase', phase: 'finalizing', message: local ? 'Validating and committing the local world model.' : 'Validating, committing, and pushing the world model with the Story branch.' });
      const result = await snapshot(root);
      const response = { ...result };
      send({ type: 'complete', phase: 'complete', message: 'Story world model generated and committed.', result: response });
      return response;
    } catch (error) {
      send({ type: 'error', phase: 'error', message: error?.message || String(error) });
      throw error;
    }
  });
  trustedHandle('session:persona', (_event, { repository, workId, persona }) => invokeCli(assertRepository(repository), ['desktop', 'session', persona, ...(workId ? ['--work-id', workId] : []), '--json']));
  trustedHandle('initiative:restart', async (event, { repository, initiativeId, confirmation, reason = null }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    // The typed confirmation is checked here rather than in the renderer: the engine's own guard is
    // a CLI prompt, and an IPC caller must clear the same bar before anything is discarded.
    if (String(confirmation ?? '').trim() !== initiativeId) throw new Error(`Type ${initiativeId} exactly to restart it.`);
    const { restartInitiative, loadInitiative, commitInitiativeChange } = await importCliModule('initiative-state.mjs');
    await restartInitiative(root, initiativeId, { reason });
    const state = await loadInitiative(root, initiativeId);
    await commitInitiativeChange(root, state.portfolio, state.initiative, `[${initiativeId}][initiative:restart] back to ${state.initiative.currentPhase}`);
    return snapshot(root, null, initiativeId);
  });
  trustedHandle('initiative:outputs-select', async (event, { repository, initiativeId, phaseId, outputIds, reason = null }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [{ selectInitiativePhaseOutputs }, { commitInitiativeChange }, { loadInitiative }] = await Promise.all([
      importCliModule('initiative-state.mjs'),
      importCliModule('initiative-state.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const selection = await selectInitiativePhaseOutputs(root, initiativeId, phaseId, outputIds ?? [], { reason });
    const state = await loadInitiative(root, initiativeId);
    await commitInitiativeChange(root, state.portfolio, state.initiative, `[${initiativeId}][initiative:${phaseId}][outputs] select`);
    return snapshot(root, null, initiativeId);
  });
  trustedHandle('initiative:evidence-record', async (event, { repository, initiativeId, phaseId, checkId, reason, observedState }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    // Mirrors `initiative evidence add` exactly: register, reload, then commit append-only. The
    // engine owns authorization — it refuses an actor outside the check's approval authority — so
    // this handler must not pre-judge who may attest.
    const [
      { registerInitiativeEvidence },
      { commitInitiativeChange, loadInitiative },
      { loadSession }
    ] = await Promise.all([
      importCliModule('initiative-evidence.mjs'),
      importCliModule('initiative-state.mjs'),
      importCliModule('session.mjs')
    ]);
    const session = await loadSession(root, { required: false });
    const appended = await registerInitiativeEvidence(root, {
      initiativeId,
      phaseId,
      checkId,
      assurance: 'human-approved',
      verificationMethod: 'human-review',
      source: { observedState: observedState?.trim() || null },
      persona: session?.persona ?? null,
      reason: reason?.trim() || null
    });
    const fresh = await loadInitiative(root, initiativeId);
    const publication = await commitInitiativeChange(
      root, fresh.portfolio, fresh.initiative,
      `[${initiativeId}][initiative:${phaseId}][evidence] ${checkId}`,
      { appendOnly: true }
    );
    return { checkId, sha256: appended.sha256, commit: publication.sha, pushed: publication.pushed };
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
  trustedHandle('initiative:open', async (event, { repository, initiativeId }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [{ loadDefinition }, {
      assertClean,
      branch,
      changes,
      checkout,
      fetchRemote,
      hasRemote
    }] = await Promise.all([
      importCliModule('config.mjs'),
      importCliModule('git.mjs')
    ]);
    const definition = await loadDefinition(root);
    const currentBranch = branch(root);
    const pendingChanges = changes(root).trim().split('\n').filter(Boolean);
    // Opening the Epic already checked out is a read operation. Refusing it hid the dashboard and
    // authored documents precisely when a contributor most needed to inspect pending work. Fetch
    // remote refs, but never pull, switch, stash, or rewrite over a dirty working tree.
    if (currentBranch === initiativeId && pendingChanges.length) {
      const remote = definition.git?.remote ?? 'origin';
      if (hasRemote(root, remote)) fetchRemote(root, remote);
      const result = await snapshot(root, null, initiativeId);
      result.repository.openMode = 'local-edits';
      result.repository.openMessage = `Viewing ${initiativeId} with ${pendingChanges.length} uncommitted change${pendingChanges.length === 1 ? '' : 's'}. Remote references were fetched, but the branch was not pulled; your local edits were preserved.`;
      return result;
    }
    // A branch switch can overwrite or strand unrelated edits, so it keeps the hard clean-tree
    // boundary used by the CLI resume path.
    if (currentBranch !== initiativeId) assertClean(root);
    checkout(root, initiativeId, {
      base: definition.defaultBaseBranch,
      fetch: true,
      existingOnly: true
    });
    return snapshot(root, null, initiativeId);
  });
  trustedHandle('initiative:refresh', async (event, { repository }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [{ loadDefinition }, { fetchRemote, hasRemote }] = await Promise.all([
      importCliModule('config.mjs'),
      importCliModule('git.mjs')
    ]);
    const definition = await loadDefinition(root);
    const remote = definition.git?.remote ?? 'origin';
    if (hasRemote(root, remote)) fetchRemote(root, remote);
    return { remote, fetched: hasRemote(root, remote) };
  });
  trustedHandle('initiative:phase-publish', async (event, {
    repository, initiativeId, phaseId, persona = null
  }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [
      { publishInitiativePhase },
      { commitInitiativeChange }
    ] = await Promise.all([
      importCliModule('initiative-evidence.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const result = await publishInitiativePhase(root, initiativeId, phaseId, { persona });
    const publication = await commitInitiativeChange(
      root,
      result.portfolio,
      result.initiative,
      `[${initiativeId}][initiative:${phaseId}][publish] generation ${result.phase.generation}`
    );
    return { ...result, publication };
  });
  trustedHandle('initiative:phase-approve', async (event, {
    repository, initiativeId, subject = 'phase', confirmation, persona = null,
    selfApprovalAcknowledged = false
  }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [
      { approveInitiative, initiativeBundle },
      { commitInitiativeChange, loadInitiative },
      { identity }
    ] = await Promise.all([
      importCliModule('initiative-evidence.mjs'),
      importCliModule('initiative-state.mjs'),
      importCliModule('git.mjs')
    ]);
    const loaded = await loadInitiative(root, initiativeId);
    const phaseId = loaded.initiative.currentPhase;
    if (!phaseId) throw new Error(`Epic ${initiativeId} is already complete.`);
    const expected = `${phaseId}:${subject}`;
    if (confirmation !== expected) throw new Error(`Approval requires exact confirmation '${expected}'.`);
    const actor = identity(root);
    const actorEmail = actor.email?.toLowerCase();
    const phase = loaded.initiative.phases[phaseId];
    const potentialSelfApproval = Object.values(phase.outputs).some(
      (output) => output.generatedBy?.email?.toLowerCase() === actorEmail
    );
    if (potentialSelfApproval && !selfApprovalAcknowledged) {
      throw new Error('This is a self-approval and is not independent review. Acknowledge the warning before continuing.');
    }
    const before = await initiativeBundle(root, loaded.portfolio, loaded.initiative, phaseId);
    const result = await approveInitiative(root, {
      initiativeId,
      phaseId,
      subject,
      persona,
      channel: 'desktop'
    });
    const publication = await commitInitiativeChange(
      root,
      result.portfolio,
      result.initiative,
      `[${initiativeId}][initiative:${phaseId}][approve] ${subject}`
    );
    return { ...result, bundleSha256: before.sha256, publication };
  });
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
  // Copilot receives a filesystem path and reads it as UTF-8, so a pinned PDF/DOCX/XLSX arrived as
// mojibake. A text rendition is derived once, at pin time, and written beside the cached bytes; the
// engine notices it and points Copilot there instead. Failure is never fatal — a source with no
// rendition is declared unreadable in the contract rather than silently handed over.
async function writeSourceRenditions(root, initiativeId, records) {
  const { verifyEpicSources } = await importCliModule('epic-sources.mjs');
  const { TEXT_RENDITION_SUFFIX } = await importCliModule('initiative-context.mjs');
  const verification = await verifyEpicSources(root, initiativeId, { materialize: true }).catch(() => null);
  if (!verification) return;
  for (const record of records) {
    const result = verification.results?.find((item) => item.sourceId === record.sourceId);
    if (!result?.cachePath) continue;
    if (isTextualSource(record.mimeType, record.name)) continue;
    try {
      const absolute = path.join(root, result.cachePath);
      const rendition = extractSourceText(await readFile(absolute), record.mimeType);
      if (rendition.status !== 'extracted') continue;
      await writeFile(`${absolute}${TEXT_RENDITION_SUFFIX}`, [
        `# Text extracted from ${record.name}`,
        '',
        `- Source: \`${record.sourceId}\``,
        `- SHA-256 of the original: \`${record.sha256}\``,
        '',
        rendition.text,
        ''
      ].join('\n'), 'utf8');
    } catch { /* A rendition is an optimisation; the pinned bytes remain the evidence. */ }
  }
}

function isTextualSource(mimeType, name = '') {
  const mime = String(mimeType ?? '');
  if (mime.startsWith('text/')) return true;
  if (['application/json', 'application/yaml', 'application/xml'].includes(mime)) return true;
  return ['.md', '.markdown', '.txt', '.csv', '.json', '.yml', '.yaml', '.xml'].includes(path.extname(String(name)).toLowerCase());
}

const SOURCE_MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

// Recording everything as application/octet-stream defeats the storage MIME policy and leaves any
// consumer unable to tell a specification from a screenshot.
function mimeTypeForFile(filePath, fallback = 'application/octet-stream') {
  return SOURCE_MIME_TYPES[path.extname(String(filePath)).toLowerCase()] ?? fallback;
}

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
    repository, initiativeId, providerId = null, mimeType = 'application/octet-stream', filePaths = null }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    // Dropped files arrive with their paths already known, so the picker is only opened when the
    // user asked for it.
    const selected = Array.isArray(filePaths) && filePaths.length
      ? { canceled: false, filePaths: filePaths.filter((item) => typeof item === 'string' && item.trim()) }
      : await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        title: `Add governed sources to ${initiativeId}`
      });
    if (selected.canceled || !selected.filePaths.length) return { canceled: true, records: [] };
    const [{ registerEpicSource }, { commitInitiativeChange }] = await Promise.all([
      importCliModule('epic-sources.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const runtime = await epicSourceRuntime(root, initiativeId, providerId);
    // One commit for the whole selection. Committing per file produced a commit and a push each,
    // and every commit moves HEAD — which invalidates any planning context already built, so
    // attaching five files could invalidate the same conversation five times over.
    const records = [];
    let last = null;
    for (const filePath of selected.filePaths) {
      const result = await registerEpicSource(root, {
        initiativeId,
        providerId: runtime.selectedId,
        filePath,
        mimeType: mimeTypeForFile(filePath, mimeType),
        runtime: runtime.runtime
      });
      records.push(result.record);
      last = result;
    }
    if (!last) return { canceled: false, records: [] };
    const ids = records.map((record) => record.sourceId).join(' ');
    const publication = await commitInitiativeChange(
      root, last.portfolio, last.initiative,
      `[${initiativeId}][epic:source] ${ids}`,
      { appendOnly: true }
    );
    // After the commit: the rendition lives in .git alongside the cache and is never committed.
    await writeSourceRenditions(root, initiativeId, records);
    return { canceled: false, records: records.map((record) => ({ ...record, publication })) };
  });
  // A pinned source was a name, a size and a hash: nothing could open it, so a user could never see
  // what they had attached. verifyEpicSources already materialises the bytes into a cache under
  // .git; this reads that cache rather than re-implementing every storage adapter.
  // The sources pane listed the Epic's Jira attachments and told the user to "pin one above" — but
  // the only control above was a disk file picker, so the instruction had no action behind it.
  trustedHandle('epic:sources-pin-jira', async (event, { repository, initiativeId, providerId = null }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [{ pinJiraEpicAttachments }, { loadInitiative, commitInitiativeChange }] = await Promise.all([
      importCliModule('epic-sources.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const loaded = await loadInitiative(root, initiativeId);
    const source = loaded.initiative.initiative.source;
    if (source?.type !== 'jira') throw new Error(`${initiativeId} was not imported from Jira, so it has no attachments to pin.`);
    const attachments = source.attachments ?? [];
    if (!attachments.length) throw new Error(`${initiativeId} has no Jira attachments.`);

    const runtime = await epicSourceRuntime(root, initiativeId, providerId);
    const result = await pinJiraEpicAttachments(root, initiativeId, {
      attachments, providerId: runtime.selectedId, runtime: runtime.runtime
    });
    if (!result.pinned.length) return { pinned: [], skipped: result.skipped };
    const fresh = await loadInitiative(root, initiativeId);
    const publication = await commitInitiativeChange(
      root, fresh.portfolio, fresh.initiative,
      `[${initiativeId}][epic:source] ${result.pinned.map((item) => item.sourceId).join(' ')}`,
      { appendOnly: true }
    );
    return { pinned: result.pinned, skipped: result.skipped, publication };
  });
  trustedHandle('epic:sources-preview', async (event, { repository, initiativeId, sourceId, maxBytes = 25 * 1024 * 1024 }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const { listEpicSources, verifyEpicSources } = await importCliModule('epic-sources.mjs');
    const listed = await listEpicSources(root, initiativeId);
    const entry = listed.manifest.sources.find((item) => item.sourceId === sourceId);
    if (!entry) throw new Error(`Unknown pinned source '${sourceId}'.`);

    const runtime = await epicSourceRuntime(root, initiativeId, entry.provider).catch(() => ({ runtime: {} }));
    const verification = await verifyEpicSources(root, initiativeId, { materialize: true, runtime: runtime.runtime });
    const result = verification.results?.find((item) => item.sourceId === sourceId);
    if (!result?.cachePath) throw new Error(`Source '${sourceId}' could not be materialised: ${result?.error ?? result?.status ?? 'unavailable'}.`);

    // Containment on the real path, as the ACP reader does: the cache lives inside the repository
    // and a record must never be able to name something outside it.
    const cacheRoot = await realpath(path.join(root, '.git', 'singularity-flow', 'epic-sources'));
    const absolute = await realpath(path.resolve(root, result.cachePath));
    const relative = path.relative(cacheRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to read a source outside the governed cache.');

    const info = await lstat(absolute);
    if (!info.isFile()) throw new Error(`Source '${sourceId}' is not a readable file.`);
    if (info.size > maxBytes) {
      return { sourceId, name: entry.name, mimeType: entry.mimeType, bytes: info.size, tooLarge: true, sha256: entry.sha256 };
    }
    const raw = await readFile(absolute);
    return {
      sourceId,
      name: entry.name,
      mimeType: entry.mimeType ?? 'application/octet-stream',
      bytes: info.size,
      sha256: entry.sha256,
      verified: result.status === 'verified',
      // Text is returned as text so it can be rendered; anything else as a data URL the existing
      // media viewer already knows how to display.
      text: isTextualSource(entry.mimeType, entry.name) ? raw.toString('utf8') : null,
      dataUrl: isTextualSource(entry.mimeType, entry.name) ? null : `data:${entry.mimeType ?? 'application/octet-stream'};base64,${raw.toString('base64')}`
    };
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
  trustedHandle('epic:sources-add-text', async (event, {
    repository, initiativeId, text, label = null, kind = 'note'
  }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [{ registerEpicTextSource }, { commitInitiativeChange }] = await Promise.all([
      importCliModule('epic-sources.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const result = await registerEpicTextSource(root, { initiativeId, text, label, kind });
    const publication = await commitInitiativeChange(
      root,
      result.portfolio,
      result.initiative,
      `[${initiativeId}][epic:source] ${result.record.sourceId}`,
      { appendOnly: true }
    );
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
  trustedHandle('epic:story-update', async (event, { repository, initiativeId, planId, changes }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [{ updateEpicStory }, { commitInitiativeChange }] = await Promise.all([
      importCliModule('epic-lifecycle.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const updated = await updateEpicStory(root, initiativeId, planId, changes);
    const publication = await commitInitiativeChange(
      root,
      updated.portfolio,
      updated.initiative,
      `[${initiativeId}][epic:story] update ${planId}`
    );
    return { story: updated.story, publication };
  });
  trustedHandle('epic:story-split', async (event, { repository, initiativeId, planId, changes }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [{ splitEpicStory }, { commitInitiativeChange }] = await Promise.all([
      importCliModule('epic-lifecycle.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const split = await splitEpicStory(root, initiativeId, planId, changes);
    const publication = await commitInitiativeChange(
      root,
      split.portfolio,
      split.initiative,
      `[${initiativeId}][epic:story] split ${planId} as ${split.story.planId}`
    );
    return { story: split.story, publication };
  });
  trustedHandle('epic:story-adopt', async (event, { repository, initiativeId, jiraKey, changes }) => {
    assertTrustedSender(event);
    const { root, connection } = await governedInitiativeJiraConnection(repository, initiativeId, { issueKey: jiraKey });
    const [{ adoptEpicStory }, { commitInitiativeChange }, { getIssue }] = await Promise.all([
      importCliModule('epic-lifecycle.mjs'),
      importCliModule('initiative-state.mjs'),
      importCliModule('jira.mjs')
    ]);
    const issue = await getIssue(jiraKey, { connection });
    if (String(issue.issueType ?? '').toLowerCase() === 'epic') {
      throw new Error(`Jira ${issue.key} is an Epic. Choose a Story, task, or other delivery issue.`);
    }
    const adopted = await adoptEpicStory(root, initiativeId, issue, changes);
    const publication = await commitInitiativeChange(
      root,
      adopted.portfolio,
      adopted.initiative,
      `[${initiativeId}][epic:story] adopt ${issue.key} as ${adopted.story.planId}`
    );
    return { story: adopted.story, publication };
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
  trustedHandle('jira:epic', async (event, { repository, epicKey }) => {
    assertTrustedSender(event);
    const { connection } = await governedJiraConnection(repository, { issueKey: epicKey });
    const { getIssue } = await importCliModule('jira.mjs');
    const issue = await getIssue(epicKey, { connection });
    if (String(issue.issueType ?? '').toLowerCase() !== 'epic' && Number(issue.hierarchyLevel) !== 1) {
      throw new Error(`Jira ${issue.key} is a ${issue.issueType ?? 'work item'}, not an Epic.`);
    }
    return issue;
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
    await activateDesktopWorkspace(created.workspace.id);
    return openRepository(requireReadyLeadRepository(created.status), { workspace: created.status });
  });
  trustedHandle('workspace:configuration-preview', async (event, {
    baseDirectory, id, name, repositories, leadRepository
  }) => {
    assertTrustedSender(event);
    const { previewWorkspaceConfiguration } = await workspaceModule();
    return previewWorkspaceConfiguration({ baseDirectory, id, name, repositories, leadRepository });
  });
  trustedHandle('workspace:configuration-create', async (event, {
    baseDirectory, id, name, repositories, leadRepository, confirmation
  }) => {
    assertTrustedSender(event);
    const workspaceApi = await workspaceModule();
    const created = await workspaceApi.saveWorkspaceConfiguration({
      baseDirectory, id, name, repositories, leadRepository
    }, { confirmation });
    await workspaceApi.rememberWorkspace(workspaceRegistryPath(), created.workspace, created.status);
    await activateDesktopWorkspace(created.workspace.id);
    const message = created.materializationError
      ? `Workspace configuration saved. Some repositories could not be cloned: ${created.materializationError}`
      : `Workspace ${created.workspace.name} saved and all repositories are ready.`;
    return openWorkspaceStatus(created.status, { message });
  });
  trustedHandle('workspace:configuration-update-preview', async (event, {
    workspace, name, repositories, leadRepository
  }) => {
    assertTrustedSender(event);
    const { previewWorkspaceUpdate } = await workspaceModule();
    return previewWorkspaceUpdate(assertWorkspace(workspace), { name, repositories, leadRepository });
  });
  trustedHandle('workspace:configuration-update', async (event, {
    workspace, name, repositories, leadRepository, confirmation
  }) => {
    assertTrustedSender(event);
    const workspaceApi = await workspaceModule();
    const updated = await workspaceApi.updateWorkspaceConfiguration(assertWorkspace(workspace), {
      name, repositories, leadRepository
    }, { confirmation });
    await workspaceApi.rememberWorkspace(workspaceRegistryPath(), updated.workspace, updated.status);
    await activateDesktopWorkspace(updated.workspace.id);
    const message = updated.materializationError
      ? `Workspace changes saved. Some new repositories could not be cloned: ${updated.materializationError}`
      : `Workspace ${updated.workspace.name} updated and all repositories are ready.`;
    return openWorkspaceStatus(updated.status, { message });
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
    const workspaceApi = await workspaceModule();
    const repaired = await workspaceApi.repairWorkspace(assertWorkspace(workspace));
    await workspaceApi.rememberWorkspace(workspaceRegistryPath(), repaired.status.workspace, repaired.status);
    await activateDesktopWorkspace(repaired.status.workspace.id);
    return {
      ...repaired,
      snapshot: repaired.status.healthy
        ? await openWorkspaceStatus(repaired.status, { message: 'Workspace repositories repaired and ready.' })
        : null
    };
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
  trustedHandle('workspace:jira-context', async (event, { repository, workspace }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    const workspaceRoot = assertWorkspace(workspace);
    const { readWorkspace } = await workspaceModule();
    const manifest = await readWorkspace(workspaceRoot);
    const credentials = await jiraCredentialStore().safeStatus();
    return { routing: workspaceJiraRouting(manifest, credentials), credentials };
  });
  trustedHandle('workspace:jira-connect', async (event, { repository, workspace, connection: input }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    const workspaceRoot = assertWorkspace(workspace);
    const [{ readWorkspace }, { normalizeJiraConnection, discoverJiraConnection }] = await Promise.all([
      workspaceModule(),
      importCliModule('jira.mjs')
    ]);
    const manifest = await readWorkspace(workspaceRoot);
    const routing = workspaceJiraRouting(manifest);
    if (!routing.configured) throw new Error('Add a Jira project key to at least one workspace repository before connecting Jira.');
    const connection = normalizeJiraConnection({ ...input, name: input?.name || 'corporate-jira' });
    const discovery = await discoverJiraConnection({ connection });
    const visibleProjects = new Set((discovery.projects ?? []).map((project) => project.key));
    const unverifiedProjects = routing.projectKeys.filter((project) => !visibleProjects.has(project));
    const saved = await jiraCredentialStore().save({
      ...connection,
      account: discovery.account,
      server: discovery.server
    });
    jiraCache.clear();
    return { ...saved, discovery, routing: workspaceJiraRouting(manifest, saved), unverifiedProjects };
  });
  trustedHandle('workspace:jira-disconnect', async (event, { repository, workspace }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    assertWorkspace(workspace);
    const credentials = await jiraCredentialStore().safeStatus();
    jiraCache.clear();
    return credentials.selected
      ? jiraCredentialStore().disconnect(credentials.selected)
      : credentials;
  });
  trustedHandle('workspace:jira-epics', async (event, { repository, workspace, refresh = false }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    const workspaceRoot = assertWorkspace(workspace);
    const [{ readWorkspace }, { listWorkspaceAnchors }] = await Promise.all([
      workspaceModule(),
      importCliModule('jira.mjs')
    ]);
    const manifest = await readWorkspace(workspaceRoot);
    const credentials = await jiraCredentialStore().safeStatus();
    const routing = workspaceJiraRouting(manifest, credentials);
    if (!routing.connected) throw new Error('Connect Jira for this operating-system account before listing Epics.');
    const connection = await jiraCredentialStore().load(credentials.selected);
    const projectResults = await Promise.all(routing.projectKeys.map(async (projectKey) => {
      const repositoryIds = Object.entries(manifest.repositories)
        .filter(([, value]) => String(value?.jira?.board ?? '').trim().toUpperCase() === projectKey)
        .map(([repositoryId]) => repositoryId);
      try {
        const key = jiraCacheKey(connection, 'workspace-epics', projectKey);
        const cached = !refresh && jiraCacheRead(key, 5);
        if (cached) return { projectKey, repositoryIds, epics: cached };
        const anchors = await listWorkspaceAnchors(projectKey, { connection, limit: 500 });
        const epics = anchors.filter((issue) => Number(issue.hierarchyLevel) === 1);
        jiraCacheWrite(key, epics);
        return { projectKey, repositoryIds, epics };
      } catch (error) {
        return { projectKey, repositoryIds, error };
      }
    }));
    return summarizeWorkspaceEpicProjects(projectResults);
  });
  trustedHandle('workspace:jira-stories', async (event, { repository, workspace, refresh = false }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    const workspaceRoot = assertWorkspace(workspace);
    const [{ readWorkspace }, { listMyIssues }] = await Promise.all([
      workspaceModule(),
      importCliModule('jira.mjs')
    ]);
    const manifest = await readWorkspace(workspaceRoot);
    const credentials = await jiraCredentialStore().safeStatus();
    const routing = workspaceJiraRouting(manifest, credentials);
    if (!routing.connected) throw new Error('Connect Jira for this operating-system account before listing Stories.');
    const connection = await jiraCredentialStore().load(credentials.selected);
    const results = await Promise.all(routing.projectKeys.map(async (projectKey) => {
      const repositoryIds = Object.entries(manifest.repositories)
        .filter(([, value]) => String(value?.jira?.board ?? '').trim().toUpperCase() === projectKey)
        .map(([repositoryId]) => repositoryId);
      try {
        const key = jiraCacheKey(connection, 'workspace-stories', projectKey);
        const cached = !refresh && jiraCacheRead(key, 5);
        const response = cached ?? await listMyIssues({
          project: projectKey,
          issueType: 'Story',
          limit: 100,
          connection
        });
        if (!cached) jiraCacheWrite(key, response);
        return { projectKey, repositoryIds, issues: response.issues ?? [] };
      } catch (error) {
        return { projectKey, repositoryIds, error };
      }
    }));
    const stories = new Map();
    const warnings = [];
    for (const result of results) {
      if (result.error) {
        warnings.push({
          projectKey: result.projectKey,
          repositoryIds: result.repositoryIds,
          message: result.error.message
        });
        continue;
      }
      for (const issue of result.issues) {
        if (!stories.has(issue.key)) stories.set(issue.key, { ...issue, repositoryIds: result.repositoryIds });
      }
    }
    return {
      stories: [...stories.values()].sort((left, right) =>
        String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
        || String(left.key).localeCompare(String(right.key))),
      warnings
    };
  });
  trustedHandle('workspace:jira-route-correct', async (event, {
    repository, workspace, currentProjectKey, epicReference
  }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    const workspaceRoot = assertWorkspace(workspace);
    const workspaceApi = await workspaceModule();
    const { getIssue } = await importCliModule('jira.mjs');
    const manifest = await workspaceApi.readWorkspace(workspaceRoot);
    const credentials = await jiraCredentialStore().safeStatus();
    const routing = workspaceJiraRouting(manifest, credentials);
    if (!routing.connected) throw new Error('Connect Jira for this operating-system account before correcting Jira routing.');
    const existingProject = String(currentProjectKey ?? '').trim().toUpperCase();
    if (!routing.projectKeys.includes(existingProject)) {
      throw new Error(`Workspace Jira project '${existingProject}' is no longer configured. Refresh before trying again.`);
    }
    const issueKey = jiraIssueKeyFromReference(epicReference);
    if (!issueKey.includes('-')) throw new Error('Use an Epic key or Jira browse URL so the replacement project can be identified.');
    const replacementProject = issueKey.slice(0, issueKey.lastIndexOf('-'));
    if (replacementProject === existingProject) throw new Error(`Workspace already routes this repository to ${replacementProject}.`);
    const affectedRepositories = Object.entries(manifest.repositories)
      .filter(([, value]) => String(value?.jira?.board ?? '').trim().toUpperCase() === existingProject)
      .map(([repositoryId]) => repositoryId);
    if (!affectedRepositories.length) throw new Error(`No workspace repository is routed to ${existingProject}.`);
    const connection = await jiraCredentialStore().load(credentials.selected);
    const issue = await getIssue(issueKey, { connection });
    if (String(issue.issueType ?? '').toLowerCase() !== 'epic' && Number(issue.hierarchyLevel) !== 1) {
      throw new Error(`Jira ${issue.key} is a ${issue.issueType ?? 'work item'}, not an Epic.`);
    }
    const repositories = Object.fromEntries(Object.entries(manifest.repositories).map(([repositoryId, value]) => [
      repositoryId,
      affectedRepositories.includes(repositoryId)
        ? { ...value, jira: { ...value.jira, board: replacementProject } }
        : value
    ]));
    const updated = await workspaceApi.updateWorkspaceConfiguration(workspaceRoot, {
      name: manifest.name,
      repositories,
      leadRepository: manifest.leadRepository
    }, { confirmation: manifest.anchor.key });
    await workspaceApi.rememberWorkspace(workspaceRegistryPath(), updated.workspace, updated.status);
    await activateDesktopWorkspace(updated.workspace.id);
    jiraCache.clear();
    return openWorkspaceStatus(updated.status, {
      message: `Jira routing updated from ${existingProject} to ${replacementProject} for ${affectedRepositories.join(', ')}.`
    });
  });
  trustedHandle('workspace:jira-epic', async (event, { repository, workspace, epicKey }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    const workspaceRoot = assertWorkspace(workspace);
    const [{ readWorkspace }, { getIssue }] = await Promise.all([
      workspaceModule(),
      importCliModule('jira.mjs')
    ]);
    const manifest = await readWorkspace(workspaceRoot);
    const credentials = await jiraCredentialStore().safeStatus();
    const routing = workspaceJiraRouting(manifest, credentials);
    if (!routing.connected) throw new Error('Connect Jira for this operating-system account before fetching an Epic.');
    const key = assertWorkspaceEpicKey(routing, epicKey);
    const connection = await jiraCredentialStore().load(credentials.selected);
    const issue = assertWorkspaceEpicIssue(routing, await getIssue(key, { connection }));
    if (String(issue.issueType ?? '').toLowerCase() !== 'epic' && Number(issue.hierarchyLevel) !== 1) {
      throw new Error(`Jira ${key} is a ${issue.issueType ?? 'work item'}, not an Epic.`);
    }
    return issue;
  });
  trustedHandle('workspace:jira-story', async (event, { repository, workspace, storyKey }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    const workspaceRoot = assertWorkspace(workspace);
    const [{ readWorkspace }, { getIssue }] = await Promise.all([
      workspaceModule(),
      importCliModule('jira.mjs')
    ]);
    const manifest = await readWorkspace(workspaceRoot);
    const credentials = await jiraCredentialStore().safeStatus();
    const routing = workspaceJiraRouting(manifest, credentials);
    if (!routing.connected) throw new Error('Connect Jira for this operating-system account before fetching a Story.');
    const key = assertWorkspaceStoryKey(routing, storyKey);
    const connection = await jiraCredentialStore().load(credentials.selected);
    return assertWorkspaceStoryIssue(routing, await getIssue(key, { connection }));
  });
  trustedHandle('story:start', async (event, {
    repository, workspace, repositoryId, storyKey, workType, persona
  }) => {
    assertTrustedSender(event);
    assertRepository(repository);
    const workspaceRoot = assertWorkspace(workspace);
    const workspaceApi = await workspaceModule();
    const [manifest, workspaceHealth] = await Promise.all([
      workspaceApi.readWorkspace(workspaceRoot),
      workspaceApi.workspaceStatus(workspaceRoot)
    ]);
    const delivery = workspaceHealth.repositories.find((entry) => entry.id === repositoryId);
    if (!delivery) throw new Error(`Repository '${repositoryId}' is not part of this workspace.`);
    if (delivery.state !== 'ready' || !delivery.absolutePath) {
      throw new Error(`Repository '${repositoryId}' is not ready. Repair the workspace before starting this Story.`);
    }
    const root = await validateRepositoryDirectory(delivery.absolutePath);
    const credentials = await jiraCredentialStore().safeStatus();
    const routing = workspaceJiraRouting(manifest, credentials);
    if (!routing.connected) throw new Error('Connect Jira for this operating-system account before starting a Story.');
    const key = assertWorkspaceStoryKey(routing, storyKey);
    const configuredProject = String(manifest.repositories?.[repositoryId]?.jira?.board ?? '').trim().toUpperCase();
    const storyProject = key.includes('-') ? key.slice(0, key.lastIndexOf('-')) : null;
    if (storyProject && configuredProject !== storyProject) {
      throw new Error(`Jira ${key} is routed to project ${storyProject}, but repository '${repositoryId}' is configured for ${configuredProject || 'no Jira project'}.`);
    }
    const connection = await jiraCredentialStore().load(credentials.selected);
    const [
      { getIssue },
      { resolveWorkType },
      { assertClean, checkout, identity },
      { commitAndPublish, createWorkflow, loadConfig, loadWorkflow, validateId, workflowPath },
      { setPersonaSession }
    ] = await Promise.all([
      importCliModule('jira.mjs'),
      importCliModule('config.mjs'),
      importCliModule('git.mjs'),
      importCliModule('state.mjs'),
      importCliModule('session.mjs')
    ]);
    const [config, fetched] = await Promise.all([
      loadConfig(root),
      getIssue(key, { connection })
    ]);
    const source = assertWorkspaceStoryIssue(routing, fetched);
    const sourceProject = String(source.project?.key ?? source.key.slice(0, source.key.lastIndexOf('-'))).toUpperCase();
    if (configuredProject !== sourceProject) {
      throw new Error(`Jira ${source.key} belongs to project ${sourceProject}, but repository '${repositoryId}' is configured for ${configuredProject || 'no Jira project'}.`);
    }
    validateId(config, source.key);
    if (!config.workTypes?.[workType]) throw new Error(`Unknown Story workflow '${workType ?? ''}'.`);
    if (!config.personas?.[persona]) throw new Error(`Unknown persona '${persona ?? ''}'.`);
    const baseBranch = manifest.repositories?.[repositoryId]?.defaultBranch || config.defaultBaseBranch;
    assertClean(root);
    checkout(root, source.key, { base: baseBranch, fetch: true });
    const actor = identity(root);
    await setPersonaSession(root, config, actor, persona, source.key);
    let workflow;
    let publication = null;
    let resumed = false;
    if (existsSync(workflowPath(root, config, source.key))) {
      workflow = await loadWorkflow(root, config, source.key);
      resumed = true;
    } else {
      workflow = await createWorkflow(root, config, {
        id: source.key,
        title: source.title ?? source.key,
        source: {
          ...source,
          type: 'jira',
          epicId: source.parent?.key ?? null
        },
        baseBranch,
        workType,
        persona,
        resolved: resolveWorkType(config, workType)
      });
      publication = await commitAndPublish(
        root,
        config,
        workflow,
        `[${source.key}][init] start ${workType} workflow`
      );
    }
    const opened = await openRepository(root, { workspace: workspaceHealth });
    return {
      ...opened,
      storyIntake: {
        source,
        repositoryId,
        resumed,
        publication,
        currentPhase: workflow.currentPhase,
        command: `/sflow-phase ${source.key}`
      }
    };
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
    const checkoutMode = checkout(root, epicKey, { base: definition.defaultBaseBranch, fetch: true });
    const actor = identity(root);
    await setPersonaSession(root, definition, actor, persona, epicKey);
    if (!checkoutMode.startsWith('created-from-')) {
      try {
        const existing = await loadInitiative(root, epicKey, portfolio);
        return {
          initiativeId: epicKey,
          source,
          resumed: true,
          publication: null,
          intakePublication: null,
          currentPhase: existing.initiative.currentPhase,
          worldModel: { required: false, timing: 'story-intake' },
          attachments: null
        };
      } catch (error) {
        if (!String(error?.message ?? '').includes('No initiative found')) throw error;
        throw new Error(
          `Git branch ${epicKey} already exists but does not contain a governed initiative. `
          + 'Choose a different Epic ID or resolve the branch before starting.'
        );
      }
    }
    const created = await createInitiative(root, {
      id: epicKey,
      title: source.title ?? epicKey,
      profile,
      source,
      persona,
      idAuthority: 'jira'
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
    // Pin the Epic's own attachments as governed sources. A listed attachment is not evidence
    // until it has been fetched and hash-pinned, and doing that by hand is the most common reason
    // intake stalls. Never fails the start: a pin that does not work is reported so the user can
    // do it manually, which is far better than losing the Epic they just created.
    let attachments = null;
    if (portfolio.jira?.pinAttachments !== false && (source.attachments ?? []).length) {
      const { pinJiraEpicAttachments } = await importCliModule('epic-sources.mjs');
      attachments = await pinJiraEpicAttachments(root, epicKey, {
        attachments: source.attachments,
        runtime: { jiraConnection: connection }
      });
    }
    const started = await loadInitiative(root, epicKey, created.portfolio);
    const publication = await commitInitiativeChange(
      root,
      started.portfolio,
      started.initiative,
      `[${epicKey}][epic:init] start ${profile}`
    );
    let current = started;
    let intakePublication = null;
    if (profile === 'epic-planning') {
      const { completeEpicIntake } = await importCliModule('epic-lifecycle.mjs');
      const completed = await completeEpicIntake(root, epicKey, { persona });
      if (completed.advanced) {
        intakePublication = await commitInitiativeChange(
          root,
          completed.portfolio,
          completed.initiative,
          `[${epicKey}][epic:intake] sources accepted`
        );
        current = await loadInitiative(root, epicKey);
      }
    }
    return {
      initiativeId: epicKey,
      source,
      publication,
      intakePublication,
      currentPhase: current.initiative.currentPhase,
      worldModel: { required: false, timing: 'story-intake' },
      attachments
    };
  });
  trustedHandle('epic:local-id-preview', async (event, { repository }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    const [{ loadPortfolio }, { nextLocalEpicId }] = await Promise.all([
      importCliModule('initiative-config.mjs'),
      importCliModule('local-identity.mjs')
    ]);
    const portfolio = await loadPortfolio(root);
    return nextLocalEpicId(root, portfolio, { fetch: true });
  });
  trustedHandle('epic:start-local', async (event, {
    repository, title, description = '', goal = '', profile = 'epic-planning', persona
  }) => {
    assertTrustedSender(event);
    const root = assertRepository(repository);
    if (!String(title ?? '').trim()) throw new Error('Describe the Epic with a title before starting.');
    const [
      { loadDefinition },
      { loadPortfolio },
      { assertClean, identity },
      { reserveLocalEpicBranch },
      { commitInitiativeChange, createInitiative, loadInitiative },
      { registerInitiativeEvidence },
      { setPersonaSession }
    ] = await Promise.all([
      importCliModule('config.mjs'),
      importCliModule('initiative-config.mjs'),
      importCliModule('git.mjs'),
      importCliModule('local-identity.mjs'),
      importCliModule('initiative-state.mjs'),
      importCliModule('initiative-evidence.mjs'),
      importCliModule('session.mjs')
    ]);
    const [definition, portfolio] = await Promise.all([loadDefinition(root), loadPortfolio(root)]);
    if (!portfolio.initiativeProfiles?.[profile]) throw new Error(`Unknown initiative profile '${profile}'.`);
    if (!definition.personas?.[persona]) throw new Error(`Unknown persona '${persona ?? ''}'.`);
    assertClean(root);
    const actor = identity(root);
    const reservation = await reserveLocalEpicBranch(root, portfolio, {
      base: definition.defaultBaseBranch,
      actor
    });
    const source = {
      type: 'manual',
      id: reservation.id,
      title: String(title).trim(),
      description: String(description ?? '').trim(),
      goal: String(goal ?? '').trim()
    };
    await setPersonaSession(root, definition, actor, persona, reservation.id);
    const created = await createInitiative(root, {
      id: reservation.id,
      title: source.title,
      profile,
      source,
      persona,
      idAuthority: 'local'
    });
    if (profile === 'epic-planning') {
      await registerInitiativeEvidence(root, {
        initiativeId: reservation.id,
        phaseId: 'epic-intake',
        checkId: 'epic-identity-verified',
        assurance: 'machine-verified',
        verificationMethod: 'git-atomic-branch-reservation',
        source: {
          externalId: reservation.id,
          version: reservation.reservationCommit,
          observedState: `Local Epic ID ${reservation.id} reserved on its canonical Git branch`
        },
        persona
      });
    }
    const started = await loadInitiative(root, reservation.id, created.portfolio);
    const publication = await commitInitiativeChange(
      root,
      started.portfolio,
      started.initiative,
      `[${reservation.id}][epic:init] start ${profile}`
    );
    let current = started;
    let intakePublication = null;
    if (profile === 'epic-planning') {
      const { completeEpicIntake } = await importCliModule('epic-lifecycle.mjs');
      const completed = await completeEpicIntake(root, reservation.id, { persona });
      if (completed.advanced) {
        intakePublication = await commitInitiativeChange(
          root,
          completed.portfolio,
          completed.initiative,
          `[${reservation.id}][epic:intake] sources accepted`
        );
        current = await loadInitiative(root, reservation.id);
      }
    }
    return {
      initiativeId: reservation.id,
      source,
      reservation,
      publication,
      intakePublication,
      currentPhase: current.initiative.currentPhase,
      worldModel: { required: false, timing: 'story-intake' }
    };
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
    const [{ applyJiraWritePlan }, { commitInitiativeChange, loadInitiative }, { registerInitiativeEvidence }, { identity }] = await Promise.all([
      importCliModule('jira-initiative.mjs'),
      importCliModule('initiative-state.mjs'),
      importCliModule('initiative-evidence.mjs'),
      importCliModule('git.mjs')
    ]);
    const actor = identity(root).email?.toLowerCase() ?? identity(root).name;
    const result = await applyJiraWritePlan(root, initiativeId, { planSha256, confirmation, connection, actor });
    await registerInitiativeEvidence(root, {
      initiativeId,
      phaseId: 'epic-publish',
      checkId: 'jira-permission-verified',
      assurance: 'system-verified',
      verificationMethod: 'jira-permission-preflight-and-apply',
      source: {
        externalId: planSha256,
        version: result.application.appliedAt,
        observedState: `${result.results.length} reviewed Jira operations applied by an account with required permissions`
      }
    });
    const fresh = await loadInitiative(root, initiativeId);
    const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, `[${initiativeId}][initiative:jira-apply] ${planSha256.slice(0, 12)}`);
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
  // Per-work-item document providers (OneDrive/SharePoint) live in workflow.yml, not portfolio.yml.
  // These call the CLI modules in-process (like Epic sources) so the refreshing OAuth token can be
  // passed as runtime — the spawned `documents upload` path above cannot carry a token object.
  async function workItemStorageRuntime(config, providerId = null) {
    const storage = config.storage;
    const selectedId = providerId ?? storage?.defaultProvider ?? null;
    const provider = storage?.providers?.[selectedId];
    if (!provider) throw new Error(`Unknown or unconfigured storage provider '${selectedId ?? ''}'. Declare it under storage.providers in singularity/workflow.yml.`);
    const runtime = {};
    if (provider.type === 'sharepoint') runtime.token = await sharePointAccessToken(selectedId, provider, storageCredentialStore());
    else if (provider.type === 'artifactory') runtime.token = (await storageCredentialStore().load(selectedId)).token;
    return { selectedId, provider, runtime };
  }
  trustedHandle('documents:sharepoint-connect', async (_event, { repository, providerId = null }) => {
    const root = assertRepository(repository);
    const { loadConfig } = await importCliModule('state.mjs');
    const config = await loadConfig(root);
    const storage = config.storage;
    const selectedId = providerId ?? storage?.defaultProvider ?? null;
    const provider = storage?.providers?.[selectedId];
    if (provider?.type !== 'sharepoint') throw new Error(`Storage provider '${selectedId ?? ''}' is not a configured SharePoint provider in singularity/workflow.yml.`);
    const credential = await authorizeSharePoint(provider, { openExternal: (url) => shell.openExternal(url) });
    return storageCredentialStore().saveOAuth(selectedId, credential);
  });
  trustedHandle('documents:sharepoint-list', async (_event, { repository, providerId = null, path: subPath = '' }) => {
    const root = assertRepository(repository);
    const [{ loadConfig }, { listRemoteDocuments }] = await Promise.all([
      importCliModule('state.mjs'), importCliModule('documents.mjs')
    ]);
    const config = await loadConfig(root);
    const { selectedId, runtime } = await workItemStorageRuntime(config, providerId);
    return listRemoteDocuments(config, { providerId: selectedId, path: subPath, runtime });
  });
  trustedHandle('documents:sharepoint-fetch', async (_event, { repository, providerId = null, remoteRef, name = null, label = null }) => {
    const root = assertRepository(repository);
    const [{ loadConfig, loadWorkflow, commitAndPublish }, { fetchRemoteDocument }] = await Promise.all([
      importCliModule('state.mjs'), importCliModule('documents.mjs')
    ]);
    const config = await loadConfig(root);
    const workflow = await loadWorkflow(root, config);
    const { selectedId, runtime } = await workItemStorageRuntime(config, providerId);
    const records = await fetchRemoteDocument(root, config, workflow, { providerId: selectedId, remoteRef, name, label, runtime });
    const publication = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][documents][fetch] ${records.map((record) => record.id).join(',')}`);
    return { records, publication };
  });
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
  // Node's fetch does not consistently follow the operating system trust store and
  // managed proxy settings. Every dynamically imported Jira/storage client resolves
  // globalThis.fetch at call time, so install Chromium's network stack before IPC can
  // invoke any of them.
  installElectronNetworkFetch(net);
  registerHandlers();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
