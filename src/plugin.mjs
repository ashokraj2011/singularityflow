import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { commandExists, SingularityFlowError, run } from './util.mjs';

const PLUGIN_NAME = 'singularity-flow';
const MARKETPLACE_NAME = 'singularity-flow';
const MARKETPLACE_SOURCE = 'ashokraj2011/singularityflow';
const MARKETPLACE_PLUGIN = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

export function pluginPath() {
  return path.resolve(fileURLToPath(new URL('../plugin/', import.meta.url)));
}

function requireCopilot(exists = commandExists) {
  if (!exists('copilot')) {
    throw new SingularityFlowError(`GitHub Copilot CLI was not found on PATH. After installing it, run:\n  copilot plugin marketplace add ${MARKETPLACE_SOURCE}\n  copilot plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  }
}

function removeInstalledCopies(execute) {
  // Copilot stores direct and marketplace installs under different identities.
  // Remove both so upgrades never leave duplicate skills mounted.
  execute('copilot', ['plugin', 'uninstall', PLUGIN_NAME], { allowFailure: true, stdio: 'pipe' });
  execute('copilot', ['plugin', 'uninstall', MARKETPLACE_PLUGIN], { allowFailure: true, stdio: 'pipe' });
}

export function installPlugin({
  execute = run,
  exists = commandExists,
  developmentSource = process.env.SINGULARITY_FLOW_PLUGIN_SOURCE
} = {}) {
  requireCopilot(exists);
  removeInstalledCopies(execute);
  if (developmentSource) return execute('copilot', ['plugin', 'install', developmentSource], { stdio: 'inherit' });
  const added = execute('copilot', ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE], { allowFailure: true, stdio: 'pipe' });
  if (added.status !== 0) execute('copilot', ['plugin', 'marketplace', 'update', MARKETPLACE_NAME], { stdio: 'inherit' });
  return execute('copilot', ['plugin', 'install', MARKETPLACE_PLUGIN], { stdio: 'inherit' });
}

export function uninstallPlugin({ execute = run, exists = commandExists } = {}) {
  requireCopilot(exists);
  removeInstalledCopies(execute);
}

export function listPlugins() {
  requireCopilot();
  run('copilot', ['plugin', 'list'], { stdio: 'inherit' });
}
