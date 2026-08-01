import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { commandExists, SingularityFlowError, run } from './util.mjs';
import { installDirectSkills, uninstallDirectSkills } from './direct-skills.mjs';

const PLUGIN_NAME = 'singularity-flow';
const MARKETPLACE_NAME = 'singularity-flow';
const MARKETPLACE_PLUGIN = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

export function pluginPath() {
  return path.resolve(fileURLToPath(new URL('../plugin/', import.meta.url)));
}

function requireCopilot(exists = commandExists) {
  if (!exists('copilot')) {
    throw new SingularityFlowError(`GitHub Copilot CLI was not found on PATH. After installing it, run:\n  singularity-flow plugin install`);
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
  developmentSource = process.env.SINGULARITY_FLOW_PLUGIN_SOURCE,
  marketplaceSource = process.env.SINGULARITY_FLOW_MARKETPLACE_SOURCE,
  installAliases = installDirectSkills,
  log = console.log
} = {}) {
  requireCopilot(exists);
  removeInstalledCopies(execute);
  let result;
  if (developmentSource) {
    result = execute('copilot', ['plugin', 'install', developmentSource], { stdio: 'inherit' });
  } else {
    const configuredMarketplaceSource = String(marketplaceSource ?? '').trim();
    if (!configuredMarketplaceSource) {
      result = execute('copilot', ['plugin', 'install', pluginPath()], { stdio: 'inherit' });
    } else {
      const added = execute('copilot', ['plugin', 'marketplace', 'add', configuredMarketplaceSource], { allowFailure: true, stdio: 'pipe' });
      if (added.status !== 0) execute('copilot', ['plugin', 'marketplace', 'update', MARKETPLACE_NAME], { stdio: 'inherit' });
      result = execute('copilot', ['plugin', 'install', MARKETPLACE_PLUGIN], { stdio: 'inherit' });
    }
  }
  const aliases = installAliases();
  log(`Installed ${aliases.installed.length} direct Copilot skills under ${aliases.targetRoot}. Use /sf-<action>, for example /sf-submit.`);
  return result;
}

export function uninstallPlugin({
  execute = run,
  exists = commandExists,
  uninstallAliases = uninstallDirectSkills,
  log = console.log
} = {}) {
  requireCopilot(exists);
  removeInstalledCopies(execute);
  const aliases = uninstallAliases();
  log(`Removed ${aliases.removed.length} managed direct Copilot skill aliases from ${aliases.targetRoot}.`);
}

export function listPlugins() {
  requireCopilot();
  run('copilot', ['plugin', 'list'], { stdio: 'inherit' });
}
