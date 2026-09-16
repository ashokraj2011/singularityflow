import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { commandExists, SingularityFlowError, run } from './util.mjs';
import {
  bundledDirectSkillNames, installDirectSkills, uninstallDirectSkills
} from './direct-skills.mjs';

const PLUGIN_NAME = 'singularity-flow';
const MARKETPLACE_NAME = 'singularity-flow';
const MARKETPLACE_PLUGIN = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const PLUGIN_IDENTITIES = Object.freeze([PLUGIN_NAME, MARKETPLACE_PLUGIN]);

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
  const remaining = execute('copilot', ['plugin', 'list'], { allowFailure: true, stdio: 'pipe' });
  if (remaining.status !== 0) {
    throw new SingularityFlowError(
      `Copilot plugin removal could not be verified: ${String(remaining.stderr || remaining.stdout || `exit ${remaining.status}`).trim()}`
    );
  }
  const identities = installedPluginIdentities(remaining.stdout);
  if (identities.length) {
    throw new SingularityFlowError(
      `Copilot plugin removal left installed identity or identities: ${identities.join(', ')}.`
    );
  }
}

function installedPluginIdentities(output) {
  const lines = String(output ?? '').split(/\r?\n/u).map((line) => line
    .replace(/^[\s*\-•]+/u, '').trim());
  return PLUGIN_IDENTITIES.filter((identity) => lines.some((line) => (
    line === identity || line.startsWith(`${identity} `) || line.startsWith(`${identity} (`)
  )));
}

function relevantDiscoveryErrors(errors, expectedDirectSkills, targetRoot) {
  const expected = new Set(expectedDirectSkills.map((name) => name.toLowerCase()));
  const normalizedRoot = String(targetRoot ?? '').toLowerCase().replaceAll('\\', '/');
  return errors.filter((error) => {
    const rendered = JSON.stringify(error).toLowerCase().replaceAll('\\', '/');
    return rendered.includes('singularity-flow')
      || (normalizedRoot && rendered.includes(normalizedRoot))
      || [...expected].some((name) => rendered.includes(name));
  });
}

function structuredInventory(execute, kind, scope, env) {
  const result = execute(
    'copilot', ['plugins', 'list', '--kind', kind, '--scope', scope, '--json'],
    { allowFailure: true, stdio: 'pipe', env }
  );
  if (result.status !== 0) {
    throw new SingularityFlowError(
      `Copilot ${kind} verification failed: ${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`
    );
  }
  let payload;
  try { payload = JSON.parse(result.stdout); }
  catch (error) {
    throw new SingularityFlowError(`Copilot returned invalid ${kind} inventory JSON: ${error.message}`);
  }
  if (!Array.isArray(payload?.plugins) || !Array.isArray(payload?.errors)) {
    throw new SingularityFlowError(`Copilot ${kind} inventory did not contain plugins and errors arrays.`);
  }
  return payload;
}

function skillInventoryFailures(payload, expectedNames, scope) {
  const missing = [];
  const disabled = [];
  const duplicated = [];
  for (const name of expectedNames) {
    const entries = payload.plugins.filter((entry) => entry?.kind === 'skill'
      && entry?.scope === scope && entry?.name === name);
    if (!entries.length) missing.push(name);
    else if (entries.length !== 1) duplicated.push(name);
    else if (entries[0].enabled !== true) disabled.push(name);
  }
  return { missing, disabled, duplicated };
}

/**
 * Prove that Copilot sees one SFlow plugin and every installer-managed direct skill as enabled.
 *
 * `copilot plugin list` alone is not sufficient: Copilot can accept the plugin while refusing an
 * individual skill because its frontmatter is invalid. Keep every inventory explicitly scoped to
 * `user` or `plugin`; the unscoped JSON can exceed Copilot's 64 KiB output limit on a normally
 * configured developer machine and arrive truncated.
 */
export function verifyPluginInstallation({
  execute = run,
  exists = commandExists,
  expectedDirectSkills = bundledDirectSkillNames(),
  targetRoot = null,
  env = process.env
} = {}) {
  requireCopilot(exists);
  const pluginList = execute('copilot', ['plugin', 'list'], {
    allowFailure: true, stdio: 'pipe', env
  });
  if (pluginList.status !== 0) {
    throw new SingularityFlowError(
      `Copilot plugin verification failed: ${String(pluginList.stderr || pluginList.stdout || `exit ${pluginList.status}`).trim()}`
    );
  }
  const identities = installedPluginIdentities(pluginList.stdout);
  if (identities.length !== 1) {
    throw new SingularityFlowError(
      `Copilot plugin verification expected exactly one Singularity Flow identity; found ${identities.length}: `
      + `${identities.join(', ') || '(none)'}.`
    );
  }

  const pluginInventory = structuredInventory(execute, 'plugin', 'user', env);
  const pluginEntries = pluginInventory.plugins.filter((entry) => entry?.kind === 'plugin'
    && entry?.scope === 'user' && entry?.name === PLUGIN_NAME);
  const pluginErrors = relevantDiscoveryErrors(pluginInventory.errors, expectedDirectSkills, targetRoot);
  if (pluginEntries.length !== 1 || pluginEntries[0]?.enabled !== true || pluginErrors.length) {
    throw new SingularityFlowError(
      `Copilot structured plugin verification failed (entries: ${pluginEntries.length}; `
      + `enabled: ${pluginEntries[0]?.enabled === true}; errors: ${pluginErrors.length}).`
    );
  }

  const directInventory = structuredInventory(execute, 'skill', 'user', env);
  const relevantDirectErrors = relevantDiscoveryErrors(
    directInventory.errors, expectedDirectSkills, targetRoot
  );
  const directFailures = skillInventoryFailures(directInventory, expectedDirectSkills, 'user');
  const expectedPluginSkills = expectedDirectSkills.map((name) => `sflow-${name.slice('sf-'.length)}`);
  const pluginSkillInventory = structuredInventory(execute, 'skill', 'plugin', env);
  const relevantPluginSkillErrors = relevantDiscoveryErrors(
    pluginSkillInventory.errors, expectedPluginSkills, targetRoot
  );
  const pluginSkillFailures = skillInventoryFailures(
    pluginSkillInventory, expectedPluginSkills, 'plugin'
  );
  if (relevantDirectErrors.length || relevantPluginSkillErrors.length
      || directFailures.missing.length || directFailures.disabled.length || directFailures.duplicated.length
      || pluginSkillFailures.missing.length || pluginSkillFailures.disabled.length
      || pluginSkillFailures.duplicated.length) {
    const details = [
      ...(directFailures.missing.length ? [`missing direct skills: ${directFailures.missing.join(', ')}`] : []),
      ...(directFailures.disabled.length ? [`disabled direct skills: ${directFailures.disabled.join(', ')}`] : []),
      ...(directFailures.duplicated.length ? [`duplicated direct skills: ${directFailures.duplicated.join(', ')}`] : []),
      ...(pluginSkillFailures.missing.length ? [`missing plugin skills: ${pluginSkillFailures.missing.join(', ')}`] : []),
      ...(pluginSkillFailures.disabled.length ? [`disabled plugin skills: ${pluginSkillFailures.disabled.join(', ')}`] : []),
      ...(pluginSkillFailures.duplicated.length ? [`duplicated plugin skills: ${pluginSkillFailures.duplicated.join(', ')}`] : []),
      ...(relevantDirectErrors.length ? [`direct-skill discovery errors: ${relevantDirectErrors.map((error) => JSON.stringify(error)).join('; ')}`] : []),
      ...(relevantPluginSkillErrors.length ? [`plugin-skill discovery errors: ${relevantPluginSkillErrors.map((error) => JSON.stringify(error)).join('; ')}`] : [])
    ];
    throw new SingularityFlowError(`Copilot skill verification failed (${details.join(' | ')}).`);
  }
  return {
    pluginIdentity: identities[0],
    pluginVersion: pluginEntries[0].version ?? null,
    expectedDirectSkills: [...expectedDirectSkills],
    enabledDirectSkills: expectedDirectSkills.length,
    enabledPluginSkills: expectedPluginSkills.length,
    unrelatedDiscoveryErrors: pluginInventory.errors.length + directInventory.errors.length
      + pluginSkillInventory.errors.length - pluginErrors.length - relevantDirectErrors.length
      - relevantPluginSkillErrors.length
  };
}

export function installPlugin({
  execute = run,
  exists = commandExists,
  developmentSource = process.env.SINGULARITY_FLOW_PLUGIN_SOURCE,
  marketplaceSource = process.env.SINGULARITY_FLOW_MARKETPLACE_SOURCE,
  installAliases = installDirectSkills,
  verify = verifyPluginInstallation,
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
  const verification = verify({
    execute, exists, expectedDirectSkills: aliases.installed, targetRoot: aliases.targetRoot
  });
  log(`Verified plugin ${verification.pluginIdentity}, ${verification.enabledPluginSkills} enabled packaged skills, and ${verification.enabledDirectSkills} enabled direct skills.`);
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
