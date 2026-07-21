import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { commandExists, SingularityFlowError, run } from './util.mjs';

const PLUGIN_NAME = 'singularity-flow';
const MARKETPLACE_NAME = 'singularity-flow';
const MARKETPLACE_SOURCE = 'ashokraj2011/singularityflow';

export function pluginPath() {
  return path.resolve(fileURLToPath(new URL('../plugin/', import.meta.url)));
}

function requireCopilot() {
  if (!commandExists('copilot')) {
    throw new SingularityFlowError(`GitHub Copilot CLI was not found on PATH. After installing it, run:\n  copilot plugin marketplace add ${MARKETPLACE_SOURCE}\n  copilot plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  }
}

export function installPlugin({ force = false } = {}) {
  requireCopilot();
  if (force) run('copilot', ['plugin', 'uninstall', PLUGIN_NAME], { allowFailure: true, stdio: 'inherit' });
  const developmentSource = process.env.SINGULARITY_FLOW_PLUGIN_SOURCE;
  if (developmentSource) return run('copilot', ['plugin', 'install', developmentSource], { stdio: 'inherit' });
  const added = run('copilot', ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE], { allowFailure: true, stdio: 'inherit' });
  if (added.status !== 0) run('copilot', ['plugin', 'marketplace', 'update', MARKETPLACE_NAME], { stdio: 'inherit' });
  return run('copilot', ['plugin', 'install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], { stdio: 'inherit' });
}

export function uninstallPlugin() {
  requireCopilot();
  run('copilot', ['plugin', 'uninstall', PLUGIN_NAME], { stdio: 'inherit' });
}

export function listPlugins() {
  requireCopilot();
  run('copilot', ['plugin', 'list'], { stdio: 'inherit' });
}
