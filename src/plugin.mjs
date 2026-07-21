import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { commandExists, SingularityFlowError, run } from './util.mjs';

export function pluginPath() {
  return path.resolve(fileURLToPath(new URL('../plugin/', import.meta.url)));
}

function requireCopilot() {
  if (!commandExists('copilot')) {
    throw new SingularityFlowError(`GitHub Copilot CLI was not found on PATH. After installing it, run:\n  copilot plugin install ${pluginPath()}`);
  }
}

export function installPlugin({ force = false } = {}) {
  requireCopilot();
  if (force) run('copilot', ['plugin', 'uninstall', 'singularity-flow'], { allowFailure: true, stdio: 'inherit' });
  run('copilot', ['plugin', 'install', pluginPath()], { stdio: 'inherit' });
}

export function uninstallPlugin() {
  requireCopilot();
  run('copilot', ['plugin', 'uninstall', 'singularity-flow'], { stdio: 'inherit' });
}

export function listPlugins() {
  requireCopilot();
  run('copilot', ['plugin', 'list'], { stdio: 'inherit' });
}
