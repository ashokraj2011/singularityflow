import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
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
