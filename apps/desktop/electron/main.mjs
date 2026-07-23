import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { invokeCliProcess, REPOSITORY_SNAPSHOT_TIMEOUT_MS, validateRepositoryDirectory } from './cli-runner.mjs';
import { forgetRecentRepository, readRecentRepositories, rememberRecentRepository } from './recent-repositories.mjs';
import { CopilotPlanningBridge, copilotPlanningPreflight } from './copilot-acp.mjs';
import { JiraCredentialStore } from './jira-credentials.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, 'preload.cjs');
let activeRepository = null;
let mainWindow = null;
const planningPacks = new Map();
const planningBridges = new Map();
const jiraCache = new Map();

function recentRepositoriesPath() { return path.join(app.getPath('userData'), 'recent-repositories.json'); }
function jiraCredentialsPath() { return path.join(app.getPath('userData'), 'jira-credentials.json'); }
function jiraCredentialStore() { return new JiraCredentialStore(jiraCredentialsPath(), safeStorage); }

function cliResourcePath(...segments) {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'cli') : path.resolve(here, '../../..');
  return path.join(root, ...segments);
}

async function importCliModule(name) {
  return import(pathToFileURL(cliResourcePath('src', name)).href);
}

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted desktop request.');
  const senderUrl = event.sender.getURL();
  if (app.isPackaged ? !senderUrl.startsWith('file:') : !/^http:\/\/(127\.0\.0\.1|localhost):5173/.test(senderUrl)) {
    throw new Error('Untrusted desktop origin.');
  }
}

async function jiraPolicy(repository) {
  const root = assertRepository(repository);
  const { loadPortfolio } = await importCliModule('initiative-config.mjs');
  const portfolio = await loadPortfolio(root);
  if (!portfolio.jira?.enabled) throw new Error('Jira is disabled in singularity/portfolio.yml.');
  return { root, portfolio, policy: portfolio.jira };
}

function assertJiraConnectionPolicy(connection, policy) {
  const hostname = new URL(connection.baseUrl).hostname.toLowerCase();
  if (policy.allowedHosts?.length && !policy.allowedHosts.includes(hostname)) throw new Error(`Jira host ${hostname} is outside the repository allowlist.`);
  if (connection.deployment !== policy.deployment) throw new Error(`Repository policy requires Jira ${policy.deployment}.`);
  if (!policy.authentication?.permitted?.includes(connection.auth.mode)) throw new Error(`Authentication mode ${connection.auth.mode} is not permitted by repository policy.`);
}

function jiraCacheRead(key, minutes) {
  const entry = jiraCache.get(key);
  return entry && Date.now() - entry.at < Math.max(0, minutes) * 60_000 ? entry.value : null;
}

function jiraCacheWrite(key, value) {
  jiraCache.set(key, { at: Date.now(), value });
  return value;
}

async function recentRepositories() {
  return (await readRecentRepositories(recentRepositoriesPath())).map((entry) => ({ ...entry, available: existsSync(entry.path) }));
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
  const resolved = path.resolve(repository || '');
  if (!activeRepository || resolved !== activeRepository) throw new Error('Repository is not open in Singularity Flow.');
  return resolved;
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
  return result;
}

async function openRepository(repository) {
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
  const result = await snapshot(root);
  if (migration) result.repository.migration = migration;
  await rememberRecentRepository(recentRepositoriesPath(), {
    path: result.repository.root,
    name: path.basename(result.repository.root),
    branch: result.repository.branch
  });
  return result;
}

function registerHandlers() {
  ipcMain.handle('repository:choose', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open a Singularity Flow repository' });
    if (result.canceled || !result.filePaths[0]) return null;
    return openRepository(result.filePaths[0]);
  });
  ipcMain.handle('repository:recent', () => recentRepositories());
  ipcMain.handle('repository:open', (_event, { repository }) => openRepository(repository));
  ipcMain.handle('repository:forget', async (_event, { repository }) => {
    await forgetRecentRepository(recentRepositoriesPath(), repository);
    return recentRepositories();
  });
  ipcMain.handle('repository:snapshot', (_event, { repository, workId, initiativeId }) => snapshot(path.resolve(repository), workId, initiativeId));
  ipcMain.handle('inbox:refresh', async (_event, { repository }) => {
    const root = assertRepository(repository);
    const approvalInbox = await invokeCli(root, ['inbox', '--json'], { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
    return { ...await snapshot(root), approvalInbox };
  });
  ipcMain.handle('inbox:attach', async (_event, { repository, workId }) => {
    const root = assertRepository(repository);
    await invokeCli(root, ['session', 'attach', workId, '--json'], { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
    return snapshot(root, workId);
  });
  ipcMain.handle('configuration:validate', (_event, { repository }) => invokeCli(assertRepository(repository), ['desktop', 'validate', '--json']));
  ipcMain.handle('configuration:save', (_event, { repository, filePath, content }) => invokeCli(assertRepository(repository), ['desktop', 'save', filePath], { input: content }));
  ipcMain.handle('configuration:delete-template', (_event, { repository, filePath }) => invokeCli(assertRepository(repository), ['desktop', 'delete-template', filePath, '--json']));
  ipcMain.handle('configuration:delete-file', (_event, { repository, filePath }) => invokeCli(assertRepository(repository), ['desktop', 'delete-file', filePath, '--json']));
  ipcMain.handle('configuration:download', async (_event, { repository, filePath }) => {
    const source = await invokeCli(assertRepository(repository), ['desktop', 'read', filePath, '--json']);
    const result = await dialog.showSaveDialog({ title: 'Download Singularity Flow file', defaultPath: source.name });
    if (result.canceled || !result.filePath) return { canceled: true };
    await writeFile(result.filePath, Buffer.from(source.contentBase64, 'base64'));
    return { path: result.filePath, bytes: source.bytes };
  });
  ipcMain.handle('configuration:import', async (_event, { repository, targetDirectory, targetPath, kind }) => {
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
  ipcMain.handle('configuration:export-bundle', async (_event, { repository }) => {
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
  ipcMain.handle('configuration:publish', (_event, { repository, message }) => invokeCli(assertRepository(repository), ['desktop', 'publish', '--message', message || 'Configure Singularity Flow workflow', '--json']));
  ipcMain.handle('session:persona', (_event, { repository, workId, persona }) => invokeCli(assertRepository(repository), ['desktop', 'session', persona, ...(workId ? ['--work-id', workId] : []), '--json']));
  ipcMain.handle('planning:preflight', (_event, { repository }) => {
    assertRepository(repository);
    return copilotPlanningPreflight();
  });
  ipcMain.handle('planning:context', async (_event, {
    repository, scope, id, phase, persona, target, objective
  }) => {
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
  ipcMain.handle('planning:start', async (event, { repository, planningSessionId, model }) => {
    const root = assertRepository(repository);
    const pack = planningPacks.get(planningSessionId);
    if (!pack || pack.repository !== root) throw new Error('Build and review a planning context before starting Copilot.');
    const existing = planningBridges.get(planningSessionId);
    if (existing) await existing.stop();
    const bridge = new CopilotPlanningBridge({
      repository: root,
      emit: (update) => {
        if (!event.sender.isDestroyed()) event.sender.send('planning:event', { planningSessionId, ...update });
      }
    });
    planningBridges.set(planningSessionId, bridge);
    try {
      const result = await bridge.start({
        model: model?.trim() || null,
        prompt: `Read and follow the complete governed planning contract at ${pack.contextPath}. Work only in native Plan mode. Before finalizing, identify assumptions that materially change scope, story boundaries, repository ownership, dependencies, acceptance criteria, or Jira hierarchy. Ask those questions through ACP form elicitation so Planning Studio can show them inline, then incorporate the answers. Produce a decision-ready proposal for the configured promotion target and do not implement or mutate repository files.`
      });
      return { ...result, planningSessionId };
    } catch (error) {
      planningBridges.delete(planningSessionId);
      await bridge.stop();
      throw error;
    }
  });
  ipcMain.handle('planning:prompt', (_event, { repository, planningSessionId, text }) => {
    assertRepository(repository);
    const bridge = planningBridges.get(planningSessionId);
    if (!bridge) throw new Error('Copilot planning session is not active.');
    void bridge.prompt(text).catch(() => {});
    return { accepted: true };
  });
  ipcMain.handle('planning:answer', (_event, {
    repository, planningSessionId, questionId, content, action
  }) => {
    assertRepository(repository);
    const bridge = planningBridges.get(planningSessionId);
    if (!bridge) throw new Error('Copilot planning session is not active.');
    return bridge.answerQuestion(questionId, { content, action });
  });
  ipcMain.handle('planning:stop', async (_event, { repository, planningSessionId }) => {
    assertRepository(repository);
    const bridge = planningBridges.get(planningSessionId);
    if (!bridge) return { stopped: false };
    planningBridges.delete(planningSessionId);
    return bridge.stop();
  });
  ipcMain.handle('planning:promote', async (_event, { repository, planningSessionId, persona, content }) => {
    const root = assertRepository(repository);
    const pack = planningPacks.get(planningSessionId);
    if (!pack || pack.repository !== root) throw new Error('Planning context is not available for promotion.');
    const result = await invokeCli(root, [
      'desktop', 'planning-promote',
      '--session', planningSessionId,
      ...(persona ? ['--persona', persona] : []),
      '--json'
    ], { input: content, timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
    const bridge = planningBridges.get(planningSessionId);
    if (bridge) {
      planningBridges.delete(planningSessionId);
      await bridge.stop();
    }
    planningPacks.delete(planningSessionId);
    return result;
  });
  ipcMain.handle('initiative:materialize-preview', (_event, { repository, initiativeId }) => invokeCli(
    assertRepository(repository),
    ['desktop', 'initiative-materialize-preview', '--initiative', initiativeId, '--json'],
    { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS }
  ));
  ipcMain.handle('initiative:materialize', (_event, { repository, initiativeId, confirmation }) => invokeCli(
    assertRepository(repository),
    ['desktop', 'initiative-materialize', '--initiative', initiativeId, '--confirm', confirmation, '--json'],
    { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS }
  ));
  ipcMain.handle('initiative:sync', (_event, { repository, initiativeId }) => invokeCli(
    assertRepository(repository),
    ['desktop', 'initiative-sync', '--initiative', initiativeId, '--json'],
    { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS }
  ));
  ipcMain.handle('jira:status', async (event, { repository }) => {
    assertTrustedSender(event);
    const { policy } = await jiraPolicy(repository);
    return { policy, credentials: await jiraCredentialStore().status() };
  });
  ipcMain.handle('jira:connect', async (event, { repository, connection: input }) => {
    assertTrustedSender(event);
    const { policy } = await jiraPolicy(repository);
    const { normalizeJiraConnection, discoverJiraConnection } = await importCliModule('jira.mjs');
    const connection = normalizeJiraConnection(input);
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
  ipcMain.handle('jira:disconnect', async (event, { repository, name }) => {
    assertTrustedSender(event);
    await jiraPolicy(repository);
    jiraCache.clear();
    return jiraCredentialStore().disconnect(name);
  });
  ipcMain.handle('jira:projects', async (event, { repository, query, refresh = false }) => {
    assertTrustedSender(event);
    const { policy } = await jiraPolicy(repository);
    const connection = await jiraCredentialStore().load(policy.connection);
    assertJiraConnectionPolicy(connection, policy);
    const key = `projects:${connection.name}:${query ?? ''}`;
    const cached = !refresh && jiraCacheRead(key, policy.read.cacheMinutes);
    if (cached) return cached;
    const { listProjects } = await importCliModule('jira.mjs');
    const projects = await listProjects({ connection, query, limit: 100 });
    const allowed = policy.allowedProjects?.length ? projects.filter((project) => policy.allowedProjects.includes(project.key)) : projects;
    return jiraCacheWrite(key, allowed);
  });
  ipcMain.handle('jira:epics', async (event, { repository, projectKey, refresh = false }) => {
    assertTrustedSender(event);
    const { policy } = await jiraPolicy(repository);
    if (!policy.read.epics) throw new Error('Jira Epic browsing is disabled by repository policy.');
    if (policy.allowedProjects?.length && !policy.allowedProjects.includes(projectKey)) throw new Error(`Project ${projectKey} is outside the repository allowlist.`);
    const connection = await jiraCredentialStore().load(policy.connection);
    const key = `epics:${connection.name}:${projectKey}`;
    const cached = !refresh && jiraCacheRead(key, policy.read.cacheMinutes);
    if (cached) return cached;
    const { listEpics } = await importCliModule('jira.mjs');
    return jiraCacheWrite(key, await listEpics(projectKey, { connection, issueType: policy.epicIssueType, limit: 100 }));
  });
  ipcMain.handle('jira:children', async (event, { repository, epicKey, refresh = false }) => {
    assertTrustedSender(event);
    const { policy } = await jiraPolicy(repository);
    if (!policy.read.stories) throw new Error('Jira story browsing is disabled by repository policy.');
    const connection = await jiraCredentialStore().load(policy.connection);
    const key = `children:${connection.name}:${epicKey}`;
    const cached = !refresh && jiraCacheRead(key, policy.read.cacheMinutes);
    if (cached) return cached;
    const { listEpicStories } = await importCliModule('jira.mjs');
    return jiraCacheWrite(key, await listEpicStories(epicKey, { connection, limit: 100 }));
  });
  ipcMain.handle('jira:adopt-preview', async (event, {
    repository, initiativeId, epicKey, repositoryMap
  }) => {
    assertTrustedSender(event);
    const { root, policy } = await jiraPolicy(repository);
    const connection = await jiraCredentialStore().load(policy.connection);
    const { previewJiraAdoption } = await importCliModule('jira-initiative.mjs');
    return previewJiraAdoption(root, initiativeId, epicKey, { repositoryMap, connection });
  });
  ipcMain.handle('jira:adopt', async (event, {
    repository, initiativeId, epicKey, repositoryMap, replace = false
  }) => {
    assertTrustedSender(event);
    const { root, policy } = await jiraPolicy(repository);
    const connection = await jiraCredentialStore().load(policy.connection);
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
  ipcMain.handle('jira:write-plan', async (event, { repository, initiativeId }) => {
    assertTrustedSender(event);
    const { root, policy } = await jiraPolicy(repository);
    const connection = await jiraCredentialStore().load(policy.connection);
    const [{ createJiraWritePlan }, { commitInitiativeChange }] = await Promise.all([
      importCliModule('jira-initiative.mjs'),
      importCliModule('initiative-state.mjs')
    ]);
    const result = await createJiraWritePlan(root, initiativeId, { connection });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:jira-plan] ${result.plan.sha256.slice(0, 12)}`);
    return { plan: result.plan, publication };
  });
  ipcMain.handle('jira:apply', async (event, {
    repository, initiativeId, planSha256, confirmation
  }) => {
    assertTrustedSender(event);
    const { root, policy } = await jiraPolicy(repository);
    const connection = await jiraCredentialStore().load(policy.connection);
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
  ipcMain.handle('jira:open', async (event, { repository, url }) => {
    assertTrustedSender(event);
    const { policy } = await jiraPolicy(repository);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Jira links must be public-form HTTPS URLs without embedded credentials.');
    if (policy.allowedHosts?.length && !policy.allowedHosts.includes(parsed.hostname.toLowerCase())) throw new Error('Jira link is outside the repository host allowlist.');
    await shell.openExternal(parsed.href);
    return { opened: parsed.href };
  });
  ipcMain.handle('documents:upload', async (_event, { repository }) => {
    const root = assertRepository(repository);
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: 'Add supporting documents' });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return invokeCli(root, ['documents', 'upload', ...result.filePaths], { json: false });
  });
  ipcMain.handle('documents:upload-directory', async (_event, { repository }) => {
    const root = assertRepository(repository);
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Add a design or evidence package' });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return invokeCli(root, ['documents', 'upload', result.filePaths[0]], { json: false, timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
  });
  ipcMain.handle('documents:add-url', (_event, { repository, url, label }) => invokeCli(assertRepository(repository), ['documents', 'upload', '--url', url, ...(label ? ['--label', label] : [])], { json: false }));
  ipcMain.handle('documents:preview', (_event, { repository, workId, reference }) => invokeCli(
    assertRepository(repository),
    ['documents', 'preview', reference, '--work-id', workId, '--json'],
    { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS }
  ));
  ipcMain.handle('documents:open', async (_event, { repository, workId, record }) => {
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
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
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
  for (const bridge of planningBridges.values()) void bridge.stop();
  planningBridges.clear();
  planningPacks.clear();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
