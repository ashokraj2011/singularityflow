/**
 * Git consumes these values as filesystem paths, not as Node streams. Git for Windows can
 * reject both Node's `\\\\.\\nul` and the DOS `NUL` device when they are used as config
 * filenames. Use real, empty files/directories for Git on Windows while retaining the
 * ordinary null device on POSIX.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, rmdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let windowsPaths = null;

function windowsGitIsolationPaths() {
  if (windowsPaths) return windowsPaths;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sflow-git-isolation-'));
  const config = path.join(directory, 'empty.gitconfig');
  const hooks = path.join(directory, 'hooks');
  try {
    closeSync(openSync(config, 'wx', 0o600));
    mkdirSync(hooks, { mode: 0o700 });
  } catch (error) {
    try { unlinkSync(config); } catch { /* The file may not exist yet. */ }
    try { rmdirSync(hooks); } catch { /* The directory may not exist yet. */ }
    try { rmdirSync(directory); } catch { /* Preserve the original creation error. */ }
    throw error;
  }
  windowsPaths = { directory, config, hooks };
  process.once('exit', () => {
    try { unlinkSync(config); } catch { /* A stopped process may have lost its temp file. */ }
    try { rmdirSync(hooks); } catch { /* Never remove unexpected hook content. */ }
    try { rmdirSync(directory); } catch { /* An occupied temp directory is left intact. */ }
  });
  return windowsPaths;
}

export function gitEmptyConfigPath(platform = process.platform) {
  return platform === 'win32' ? windowsGitIsolationPaths().config : os.devNull;
}

export function gitDisabledHooksPath(platform = process.platform) {
  return platform === 'win32' ? windowsGitIsolationPaths().hooks : os.devNull;
}
