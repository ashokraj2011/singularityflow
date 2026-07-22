import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeCliProcess, REPOSITORY_SNAPSHOT_TIMEOUT_MS, validateRepositoryDirectory } from './cli-runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, 'preload.cjs');
let activeRepository = null;

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

async function snapshot(repository, workId = null) {
  const result = await invokeCli(repository, ['desktop', 'snapshot', ...(workId ? [workId] : []), '--json'], { timeoutMs: REPOSITORY_SNAPSHOT_TIMEOUT_MS });
  activeRepository = path.resolve(result.repository.root);
  return result;
}

function registerHandlers() {
  ipcMain.handle('repository:choose', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open a Singularity Flow repository' });
    if (result.canceled || !result.filePaths[0]) return null;
    return snapshot(await validateRepositoryDirectory(result.filePaths[0]));
  });
  ipcMain.handle('repository:snapshot', (_event, { repository, workId }) => snapshot(path.resolve(repository), workId));
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
  ipcMain.handle('documents:upload', async (_event, { repository }) => {
    const root = assertRepository(repository);
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: 'Add supporting documents' });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return invokeCli(root, ['documents', 'upload', ...result.filePaths], { json: false });
  });
  ipcMain.handle('documents:add-url', (_event, { repository, url, label }) => invokeCli(assertRepository(repository), ['documents', 'upload', '--url', url, ...(label ? ['--label', label] : [])], { json: false }));
  ipcMain.handle('documents:preview', (_event, { repository, workId, reference }) => invokeCli(assertRepository(repository), ['documents', 'view', reference, '--work-id', workId, '--json']));
  ipcMain.handle('documents:open', async (_event, { repository, record }) => {
    const root = assertRepository(repository);
    if (record.url) {
      const parsed = new URL(record.url);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS document links can be opened.');
      await shell.openExternal(parsed.href);
      return { opened: parsed.href };
    }
    if (!record.path) throw new Error('Document has no local path.');
    const absolute = path.resolve(root, record.path);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Document path is outside the repository.');
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
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
