import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { commandExists, SingularityFlowError, run } from './util.mjs';
import {
  bundledDirectSkillNames, bundledSkillDirectory, copilotSkillsDirectory, installDirectSkills,
  uninstallDirectSkills, verifyDirectSkillContents
} from './direct-skills.mjs';

const PLUGIN_NAME = 'singularity-flow';
const MARKETPLACE_NAME = 'singularity-flow';
const MARKETPLACE_PLUGIN = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const PLUGIN_IDENTITIES = Object.freeze([PLUGIN_NAME, MARKETPLACE_PLUGIN]);
const DEFAULT_PLUGIN_INVENTORY_TIMEOUT_MS = 30_000;
const MAX_PLUGIN_INVENTORY_TIMEOUT_MS = 120_000;
const RETIRED_COPY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const PLUGIN_REPLACEMENT_NOTE = 'Note: a Copilot chat turn running while this replaces the plugin can fail partway (hook errored). '
  + 'Let it finish first, or when this is done reload VS Code or restart Copilot CLI, and open a new chat.';

function pluginInventoryTimeout(env) {
  const requested = Number(env?.SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS
    ?? DEFAULT_PLUGIN_INVENTORY_TIMEOUT_MS);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_PLUGIN_INVENTORY_TIMEOUT_MS;
  return Math.min(Math.trunc(requested), MAX_PLUGIN_INVENTORY_TIMEOUT_MS);
}

export function pluginPath() {
  return path.resolve(fileURLToPath(new URL('../plugin/', import.meta.url)));
}

function requireCopilot(exists = commandExists) {
  if (!exists('copilot')) {
    throw new SingularityFlowError(`GitHub Copilot CLI was not found on PATH. After installing it, run:\n  singularity-flow plugin install`);
  }
}

function pluginInventory(execute) {
  const listed = execute('copilot', ['plugin', 'list'], { allowFailure: true, stdio: 'pipe' });
  if (listed.status !== 0) {
    throw new SingularityFlowError(
      `Copilot plugin removal could not be verified: ${String(listed.stderr || listed.stdout || `exit ${listed.status}`).trim()}`
    );
  }
  return installedPluginIdentities(listed.stdout);
}

function removeInstalledCopies(execute, identities = PLUGIN_IDENTITIES) {
  // Copilot stores direct and marketplace installs under different identities.
  // Remove both so upgrades never leave duplicate skills mounted.
  for (const identity of identities) {
    execute('copilot', ['plugin', 'uninstall', identity], { allowFailure: true, stdio: 'pipe' });
  }
  const left = pluginInventory(execute).filter((identity) => identities.includes(identity));
  if (left.length) {
    throw new SingularityFlowError(
      `Copilot plugin removal left installed identity or identities: ${left.join(', ')}.`
    );
  }
}

// A running chat spawns each hook with the plugin's folder as its working directory, so removing the
// folder fails every later hook of that chat with "spawn /bin/bash ENOENT". Installing over the top
// never takes it away: from a new source path Copilot leaves the last folder behind, and from the same
// path it swaps the folder in one step. Only a copy under the other identity has to go, or skills mount twice.
function replaceOtherIdentity(execute, target) {
  const other = pluginInventory(execute).filter((identity) => identity !== target);
  if (other.length) removeInstalledCopies(execute, other);
}

// Each install from a new path leaves the last folder behind for the chats still using it. A week on
// nothing should be, so it goes. Only a folder whose manifest names this plugin is ever ours to remove.
export function removeRetiredPluginCopies({
  env = process.env,
  homeDirectory = os.homedir(),
  minimumAgeMs = RETIRED_COPY_AGE_MS,
  now = Date.now()
} = {}) {
  const copilotHome = String(env.COPILOT_HOME ?? '').trim() || path.join(homeDirectory, '.copilot');
  const directRoot = path.join(copilotHome, 'installed-plugins', '_direct');
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(directRoot); } catch { return removed; }
  for (const name of names) {
    const folder = path.join(directRoot, name);
    try {
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || now - stat.mtimeMs < minimumAgeMs) continue;
      const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'plugin.json'), 'utf8'));
      if (manifest?.name !== PLUGIN_NAME) continue;
      fs.rmSync(folder, { recursive: true, force: true });
      removed.push(folder);
    } catch {
      // Tidying never stands in the way of an install or an uninstall.
    }
  }
  return removed;
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
  const normalizedRoot = String(targetRoot ?? '').toLowerCase().replaceAll('\\', '/').replace(/\/+$/u, '');
  const expectedPaths = normalizedRoot
    ? [...expected].map((name) => `${normalizedRoot}/${name}`)
    : [];
  return errors.filter((error) => {
    const rendered = (typeof error === 'string' ? error : JSON.stringify(error))
      .toLowerCase()
      .replaceAll('\\\\', '\\')
      .replaceAll('\\', '/');
    return rendered.includes('singularity-flow')
      || expectedPaths.some((expectedPath) => rendered.includes(expectedPath))
      || [...expected].some((name) => rendered.includes(name));
  });
}

function renderedCommandFailure(result) {
  const diagnostics = [result?.stderr, result?.stdout]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return diagnostics.join('\n') || `exit ${result?.status}`;
}

function stderrDiagnostics(result) {
  return String(result?.stderr ?? '')
    .split(/\r?\n/u)
    .map((diagnostic) => diagnostic.trim())
    .filter(Boolean);
}

function unsupportedJsonOption(result) {
  if (result?.status === 0) return false;
  const diagnostic = [result?.stderr, result?.stdout]
    .map((value) => String(value ?? ''))
    .join('\n');
  return /(?:unknown option|unexpected argument|unrecognized (?:option|argument)|unsupported (?:option|argument))\s+['"`]?--json['"`]?/iu.test(diagnostic)
    || /['"`]?--json['"`]?.{0,80}(?:is not supported|isn't supported|not recognized)/iu.test(diagnostic);
}

function parseJson(result, description) {
  try { return JSON.parse(result.stdout); }
  catch (error) {
    const diagnostic = String(result?.stderr ?? '').trim();
    throw new SingularityFlowError(
      `Copilot returned invalid ${description} JSON: ${error.message}`
      + (diagnostic ? ` Diagnostics: ${diagnostic}` : '')
    );
  }
}

function modernInventory(result, kind) {
  const payload = parseJson(result, `${kind} inventory`);
  if (!Array.isArray(payload)) {
    throw new SingularityFlowError(`Copilot ${kind} inventory was not a flat array.`);
  }
  for (const [index, entry] of payload.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SingularityFlowError(`Copilot ${kind} inventory entry ${index} was not an object.`);
    }
    const required = kind === 'plugin'
      ? [['name', 'string'], ['marketplace', 'string'], ['enabled', 'boolean']]
      : [['name', 'string'], ['source', 'string'], ['path', 'string'], ['enabled', 'boolean']];
    const invalid = required.find(([field, type]) => typeof entry[field] !== type
      || (type === 'string' && !entry[field] && field !== 'marketplace'));
    if (invalid) {
      throw new SingularityFlowError(
        `Copilot ${kind} inventory entry ${index} did not contain a valid ${invalid[0]} field.`
      );
    }
  }
  return { entries: payload, diagnostics: stderrDiagnostics(result) };
}

function legacyStructuredInventory(execute, kind, scope, env, timeoutMs) {
  const result = execute(
    'copilot', ['plugins', 'list', '--kind', kind, '--scope', scope, '--json'],
    { allowFailure: true, stdio: 'pipe', env, timeoutMs }
  );
  if (result.status !== 0) {
    throw new SingularityFlowError(
      `Copilot ${kind} verification failed: ${renderedCommandFailure(result)}`
    );
  }
  const payload = parseJson(result, `${kind} inventory`);
  if (!Array.isArray(payload?.plugins) || !Array.isArray(payload?.errors)) {
    throw new SingularityFlowError(`Copilot ${kind} inventory did not contain plugins and errors arrays.`);
  }
  return { ...payload, diagnostics: stderrDiagnostics(result) };
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

function modernPluginIdentity(entry) {
  return entry.marketplace ? `${entry.name}@${entry.marketplace}` : entry.name;
}

function normalizedInventoryPath(value) {
  const normalized = path.normalize(path.resolve(value));
  // Win32 paths are case-insensitive even though Copilot and Node can report different drive-letter
  // casing for the same directory. Preserve strict path identity without rejecting that equivalent.
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function modernSkillFailures(entries, expectedDirectSkills, expectedPluginSkills, targetRoot) {
  const direct = { missing: [], disabled: [], duplicated: [], wrongPath: [] };
  for (const name of expectedDirectSkills) {
    const named = entries.filter((entry) => entry.name === name);
    if (!named.length) direct.missing.push(name);
    else if (named.length !== 1) direct.duplicated.push(name);
    else {
      const expectedPath = normalizedInventoryPath(path.join(targetRoot, name));
      const actualPath = normalizedInventoryPath(named[0].path);
      if (actualPath !== expectedPath) direct.wrongPath.push({ name, actualPath, expectedPath });
      if (named[0].enabled !== true) direct.disabled.push(name);
    }
  }

  const plugin = { missing: [], disabled: [], duplicated: [], wrongSource: [] };
  const pluginEntries = new Map();
  for (const name of expectedPluginSkills) {
    const named = entries.filter((entry) => entry.name === name);
    if (!named.length) plugin.missing.push(name);
    else if (named.length !== 1) plugin.duplicated.push(name);
    else if (named[0].source !== 'plugin') plugin.wrongSource.push(name);
    else {
      pluginEntries.set(name, named[0]);
      if (named[0].enabled !== true) plugin.disabled.push(name);
    }
  }
  return { direct, plugin, pluginEntries };
}

function regularFileStatus(file) {
  try {
    const directory = fs.lstatSync(path.dirname(file));
    if (!directory.isDirectory() || directory.isSymbolicLink()) return 'invalid';
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? 'regular' : 'invalid';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function verifyPackagedSkillContents({ sourceRoot, pluginEntries, expectedNames }) {
  const missing = [];
  const missingSource = [];
  const stale = [];
  const invalid = [];
  const invalidSource = [];
  for (const name of expectedNames) {
    const sourceFile = path.join(sourceRoot, name, 'SKILL.md');
    const installedFile = path.join(pluginEntries.get(name).path, 'SKILL.md');
    const sourceStatus = regularFileStatus(sourceFile);
    const installedStatus = regularFileStatus(installedFile);
    if (sourceStatus === 'missing') missingSource.push(name);
    else if (sourceStatus === 'invalid') invalidSource.push(name);
    if (installedStatus === 'missing') missing.push(name);
    else if (installedStatus === 'invalid') invalid.push(name);
    if (sourceStatus !== 'regular' || installedStatus !== 'regular') continue;
    if (!fs.readFileSync(installedFile).equals(fs.readFileSync(sourceFile))) stale.push(name);
  }
  if (missing.length || missingSource.length || stale.length || invalid.length || invalidSource.length) {
    const details = [
      ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
      ...(missingSource.length ? [`missing bundled source: ${missingSource.join(', ')}`] : []),
      ...(stale.length ? [`stale: ${stale.join(', ')}`] : []),
      ...(invalid.length ? [`not regular files: ${invalid.join(', ')}`] : []),
      ...(invalidSource.length ? [`bundled sources are not regular files: ${invalidSource.join(', ')}`] : [])
    ];
    throw new SingularityFlowError(
      `Installed packaged Copilot skill content does not match this Singularity Flow build (${details.join(' | ')}). `
      + 'Run singularity-flow plugin install, then restart Copilot Chat or reload VS Code before retrying.'
    , { details: { nextAction: { executable: 'singularity-flow', argv: ['plugin', 'install'], label: 'Inspect or continue the retained operation; recheck before retrying.' } } });
  }
  return { verified: expectedNames.length };
}

function skillFailureDetails(directFailures, pluginFailures) {
  return [
    ...(directFailures.missing.length ? [`missing direct skills: ${directFailures.missing.join(', ')}`] : []),
    ...(directFailures.disabled.length ? [`disabled direct skills: ${directFailures.disabled.join(', ')}`] : []),
    ...(directFailures.duplicated.length ? [`duplicated direct skills: ${directFailures.duplicated.join(', ')}`] : []),
    ...(directFailures.wrongPath?.length ? [`wrong-path direct skills: ${directFailures.wrongPath.map((entry) => `${entry.name} (${entry.actualPath}; expected ${entry.expectedPath})`).join(', ')}`] : []),
    ...(pluginFailures.missing.length ? [`missing plugin skills: ${pluginFailures.missing.join(', ')}`] : []),
    ...(pluginFailures.disabled.length ? [`disabled plugin skills: ${pluginFailures.disabled.join(', ')}`] : []),
    ...(pluginFailures.duplicated.length ? [`duplicated plugin skills: ${pluginFailures.duplicated.join(', ')}`] : []),
    ...(pluginFailures.wrongSource?.length ? [`wrong-source plugin skills: ${pluginFailures.wrongSource.join(', ')}`] : [])
  ];
}

function verifyLegacyInventory({ execute, expectedDirectSkills, targetRoot, env, timeoutMs }) {
  const pluginList = execute('copilot', ['plugin', 'list'], {
    allowFailure: true, stdio: 'pipe', env, timeoutMs
  });
  if (pluginList.status !== 0) {
    throw new SingularityFlowError(
      `Copilot plugin verification failed: ${renderedCommandFailure(pluginList)}`
    );
  }
  const identities = installedPluginIdentities(pluginList.stdout);
  if (identities.length !== 1) {
    throw new SingularityFlowError(
      `Copilot plugin verification expected exactly one Singularity Flow identity; found ${identities.length}: `
      + `${identities.join(', ') || '(none)'}.`
    );
  }

  const pluginInventory = legacyStructuredInventory(execute, 'plugin', 'user', env, timeoutMs);
  const pluginEntries = pluginInventory.plugins.filter((entry) => entry?.kind === 'plugin'
    && entry?.scope === 'user' && entry?.name === PLUGIN_NAME);
  const pluginDiagnostics = [
    ...stderrDiagnostics(pluginList), ...pluginInventory.errors, ...pluginInventory.diagnostics
  ];
  const pluginErrors = relevantDiscoveryErrors(pluginDiagnostics, expectedDirectSkills, targetRoot);
  if (pluginEntries.length !== 1 || pluginEntries[0]?.enabled !== true || pluginErrors.length) {
    throw new SingularityFlowError(
      `Copilot structured plugin verification failed (entries: ${pluginEntries.length}; `
      + `enabled: ${pluginEntries[0]?.enabled === true}; errors: ${pluginErrors.length}).`
    );
  }

  const directInventory = legacyStructuredInventory(execute, 'skill', 'user', env, timeoutMs);
  const directDiagnostics = [...directInventory.errors, ...directInventory.diagnostics];
  const relevantDirectErrors = relevantDiscoveryErrors(
    directDiagnostics, expectedDirectSkills, targetRoot
  );
  const directFailures = skillInventoryFailures(directInventory, expectedDirectSkills, 'user');
  const expectedPluginSkills = expectedDirectSkills.map((name) => `sflow-${name.slice('sf-'.length)}`);
  const pluginSkillInventory = legacyStructuredInventory(execute, 'skill', 'plugin', env, timeoutMs);
  const pluginSkillDiagnostics = [...pluginSkillInventory.errors, ...pluginSkillInventory.diagnostics];
  const relevantPluginSkillErrors = relevantDiscoveryErrors(
    pluginSkillDiagnostics, expectedPluginSkills, targetRoot
  );
  const pluginSkillFailures = skillInventoryFailures(
    pluginSkillInventory, expectedPluginSkills, 'plugin'
  );
  if (relevantDirectErrors.length || relevantPluginSkillErrors.length
      || directFailures.missing.length || directFailures.disabled.length || directFailures.duplicated.length
      || pluginSkillFailures.missing.length || pluginSkillFailures.disabled.length
      || pluginSkillFailures.duplicated.length) {
    const details = [
      ...skillFailureDetails(directFailures, pluginSkillFailures),
      ...(relevantDirectErrors.length ? [`direct-skill discovery errors: ${relevantDirectErrors.map((error) => JSON.stringify(error)).join('; ')}`] : []),
      ...(relevantPluginSkillErrors.length ? [`plugin-skill discovery errors: ${relevantPluginSkillErrors.map((error) => JSON.stringify(error)).join('; ')}`] : [])
    ];
    throw new SingularityFlowError(
      `Copilot skill verification failed (${details.join(' | ')}). `
      + 'Run singularity-flow plugin install, then restart Copilot Chat or reload VS Code before retrying.'
    , { details: { nextAction: { executable: 'singularity-flow', argv: ['plugin', 'install'], label: 'Inspect or continue the retained operation; recheck before retrying.' } } });
  }
  const unrelatedDiagnostics = [...pluginDiagnostics, ...directDiagnostics, ...pluginSkillDiagnostics]
    .filter((diagnostic) => !relevantDiscoveryErrors(
      [diagnostic], [...expectedDirectSkills, ...expectedPluginSkills], targetRoot
    ).length);
  return {
    inventoryProtocol: 'legacy',
    pluginIdentity: identities[0],
    pluginVersion: pluginEntries[0].version ?? null,
    expectedPluginSkills,
    enabledDirectSkills: expectedDirectSkills.length,
    enabledPluginSkills: expectedPluginSkills.length,
    contentVerifiedPluginSkills: null,
    unrelatedDiscoveryErrors: unrelatedDiagnostics.length,
    unrelatedDiscoveryDiagnostics: unrelatedDiagnostics
  };
}

/**
 * Prove that Copilot sees one SFlow plugin and every installer-managed skill as enabled, then
 * prove every direct alias contains the bytes shipped by this build. Current path-bearing
 * inventories also prove the installed packaged skill bytes; legacy inventories expose no paths.
 *
 * Current Copilot exposes flat singular `plugin` and `skill` JSON inventories. Older releases
 * expose only bounded plural/scoped inventories, so compatibility is selected by a narrow feature
 * probe: only an explicit unsupported-`--json` error may enter the legacy path. A successful but
 * malformed modern response is a verification failure, never a reason to weaken the proof.
 */
export function verifyPluginInstallation({
  execute = run,
  exists = commandExists,
  expectedDirectSkills = bundledDirectSkillNames(),
  targetRoot = null,
  env = process.env,
  directSourceRoot = null,
  verifyDirectContents = verifyDirectSkillContents
} = {}) {
  requireCopilot(exists);
  const resolvedTargetRoot = normalizedInventoryPath(
    targetRoot ?? copilotSkillsDirectory({ env })
  );
  const resolvedSourceRoot = normalizedInventoryPath(
    directSourceRoot ?? bundledSkillDirectory()
  );
  const expectedPluginSkills = expectedDirectSkills
    .map((name) => `sflow-${name.slice('sf-'.length)}`);
  const timeoutMs = pluginInventoryTimeout(env);
  const modernPluginList = execute('copilot', ['plugin', 'list', '--json'], {
    allowFailure: true, stdio: 'pipe', env, timeoutMs
  });
  let inventory;
  if (modernPluginList.status !== 0) {
    if (!unsupportedJsonOption(modernPluginList)) {
      throw new SingularityFlowError(
        `Copilot plugin verification failed: ${renderedCommandFailure(modernPluginList)}`
      );
    }
    inventory = verifyLegacyInventory({
      execute, expectedDirectSkills, targetRoot: resolvedTargetRoot, env, timeoutMs
    });
  } else {
    const pluginInventory = modernInventory(modernPluginList, 'plugin');
    const pluginEntries = pluginInventory.entries.filter((entry) => entry.name === PLUGIN_NAME);
    const pluginIdentities = pluginEntries.map(modernPluginIdentity);
    const pluginErrors = relevantDiscoveryErrors(
      pluginInventory.diagnostics,
      [...expectedDirectSkills, ...expectedPluginSkills],
      resolvedTargetRoot
    );
    const exactIdentity = pluginEntries.length === 1
      && PLUGIN_IDENTITIES.includes(pluginIdentities[0]);
    if (!exactIdentity || pluginEntries[0]?.enabled !== true || pluginErrors.length) {
      throw new SingularityFlowError(
        `Copilot structured plugin verification failed (entries: ${pluginEntries.length}; `
        + `identity: ${pluginIdentities.join(', ') || '(none)'}; `
        + `enabled: ${pluginEntries[0]?.enabled === true}; errors: ${pluginErrors.length}).`
      );
    }

    const modernSkillList = execute('copilot', ['skill', 'list', '--json'], {
      allowFailure: true, stdio: 'pipe', env, timeoutMs
    });
    if (modernSkillList.status !== 0) {
      throw new SingularityFlowError(
        `Copilot skill verification failed: ${renderedCommandFailure(modernSkillList)}`
      );
    }
    const skillInventory = modernInventory(modernSkillList, 'skill');
    const skillErrors = relevantDiscoveryErrors(
      skillInventory.diagnostics,
      [...expectedDirectSkills, ...expectedPluginSkills],
      resolvedTargetRoot
    );
    const failures = modernSkillFailures(
      skillInventory.entries, expectedDirectSkills, expectedPluginSkills, resolvedTargetRoot
    );
    const details = skillFailureDetails(failures.direct, failures.plugin);
    if (skillErrors.length || details.length) {
      if (skillErrors.length) {
        details.push(`skill discovery errors: ${skillErrors.map((error) => JSON.stringify(error)).join('; ')}`);
      }
      throw new SingularityFlowError(
        `Copilot skill verification failed (${details.join(' | ')}). `
        + 'Run singularity-flow plugin install, then restart Copilot Chat or reload VS Code before retrying.'
      , { details: { nextAction: { executable: 'singularity-flow', argv: ['plugin', 'install'], label: 'Inspect or continue the retained operation; recheck before retrying.' } } });
    }
    const packagedContentVerification = verifyPackagedSkillContents({
      sourceRoot: resolvedSourceRoot,
      pluginEntries: failures.pluginEntries,
      expectedNames: expectedPluginSkills
    });
    const allDiagnostics = [...pluginInventory.diagnostics, ...skillInventory.diagnostics];
    const unrelatedDiagnostics = allDiagnostics.filter((diagnostic) => !relevantDiscoveryErrors(
      [diagnostic], [...expectedDirectSkills, ...expectedPluginSkills], resolvedTargetRoot
    ).length);
    inventory = {
      inventoryProtocol: 'modern',
      pluginIdentity: pluginIdentities[0],
      pluginVersion: pluginEntries[0].version ?? null,
      expectedPluginSkills,
      enabledDirectSkills: expectedDirectSkills.length,
      enabledPluginSkills: expectedPluginSkills.length,
      contentVerifiedPluginSkills: packagedContentVerification.verified,
      unrelatedDiscoveryErrors: unrelatedDiagnostics.length,
      unrelatedDiscoveryDiagnostics: unrelatedDiagnostics
    };
  }
  const contentVerification = verifyDirectContents({
    sourceRoot: resolvedSourceRoot,
    targetRoot: resolvedTargetRoot,
    expectedNames: expectedDirectSkills
  });
  return {
    ...inventory,
    expectedDirectSkills: [...expectedDirectSkills],
    contentVerifiedDirectSkills: contentVerification.verified
  };
}

export function installPlugin({
  execute = run,
  exists = commandExists,
  developmentSource = process.env.SINGULARITY_FLOW_PLUGIN_SOURCE,
  marketplaceSource = process.env.SINGULARITY_FLOW_MARKETPLACE_SOURCE,
  installAliases = installDirectSkills,
  verify = verifyPluginInstallation,
  removeRetired = removeRetiredPluginCopies,
  log = console.log
} = {}) {
  requireCopilot(exists);
  log(PLUGIN_REPLACEMENT_NOTE);
  const configuredMarketplace = !developmentSource && String(marketplaceSource ?? '').trim();
  replaceOtherIdentity(execute, configuredMarketplace ? MARKETPLACE_PLUGIN : PLUGIN_NAME);
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
  removeRetired();
  return result;
}

export function uninstallPlugin({
  execute = run,
  exists = commandExists,
  uninstallAliases = uninstallDirectSkills,
  removeRetired = removeRetiredPluginCopies,
  log = console.log
} = {}) {
  requireCopilot(exists);
  removeInstalledCopies(execute);
  const aliases = uninstallAliases();
  removeRetired({ minimumAgeMs: 0 });
  log(`Removed ${aliases.removed.length} managed direct Copilot skill aliases from ${aliases.targetRoot}.`);
}

export function listPlugins() {
  requireCopilot();
  run('copilot', ['plugin', 'list'], { stdio: 'inherit' });
}
