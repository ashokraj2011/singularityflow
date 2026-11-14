/**
 * The agents-home migration [SPEC-AGH section 5.5]: which files in `.github/agents` are SFlow's and
 * move to `singularity/agents`, and which stay as the team's own.
 *
 * It is planned from the configuration as found, file by file, so a half-moved configuration is
 * completed and never doubled [AGH:REQ-018]. The package refresh carries the plan in its one
 * candidate [AGH:REQ-012]; nothing here decides whether that candidate is published or reviewed.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { AGENTS_HOME, LEGACY_AGENTS_ROOT, agentsRootOf, agentsTransportRootOf } from './configuration-assets.mjs';
import { parseAgentDependencies, withoutSfGuardStampBlock } from './agent-document-parser.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { isKnownPackagedAssetHash } from './packaged-asset-history.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isAgentFileName = (name) => /\.md$/iu.test(name);

/** Why a file stays, as a person reads it in the preview [AGH:REQ-014]. */
export const AGENTS_HOME_STAY_REASONS = Object.freeze({
  own: 'your own agent',
  apm: 'deployed by APM',
  shadow: 'your own agent; SFlow\'s packaged agent of the same name is installed in singularity/agents'
});

async function directoryFiles(directory) {
  return (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && isAgentFileName(entry.name))
    .map((entry) => entry.name).sort();
}

async function packagedAgents() {
  const names = new Set(); const identities = new Set();
  for (const directory of [path.join(PACKAGE_ROOT, 'templates/agents'), path.join(PACKAGE_ROOT, 'plugin/agents')]) {
    for (const name of await directoryFiles(directory)) {
      const text = await readFile(path.join(directory, name), 'utf8');
      if (directory.endsWith('templates/agents')) names.add(name.toLowerCase());
      identities.add(`${name.toLowerCase()}\0${sha256(withoutSfGuardStampBlock(text))}`);
    }
  }
  return { names, identities };
}

/** A front-matter `metadata` key starting with `sflow-` [AGH:REQ-013 rule 1], read without the full parser. */
function hasSflowMarker(text) {
  const front = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  return Boolean(front && /^\s+sflow-[a-z0-9-]+\s*:/mu.test(front[1]));
}

function agentIdOf(name, text) {
  try { return parseAgentDependencies(text, { source: `${LEGACY_AGENTS_ROOT}/${name}` }).id; }
  catch { return name.replace(/(?:\.agent)?\.md$/iu, '').toLowerCase(); }
}

/** Every agent ID the configuration names [AGH:REQ-013 rule 3]: mappings, `agents:` lists, skill attachments. */
async function referencedAgentIds(root, workflow) {
  const ids = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'agents' && Array.isArray(child)) child.filter((id) => typeof id === 'string').forEach((id) => ids.add(id));
      else if (key !== 'apm') walk(child);
    }
  };
  walk(workflow);
  const yaml = async (relative) => {
    try { return YAML.parse(await readFile(path.join(root, relative), 'utf8')) ?? {}; } catch { return {}; }
  };
  for (const id of Object.values((await yaml('singularity/agent-mappings.yml')).mappings ?? {})) if (typeof id === 'string') ids.add(id);
  for (const entry of (await yaml('singularity/skill-library/attachments.yml')).attachments ?? []) {
    if (typeof entry?.agent === 'string') ids.add(entry.agent);
  }
  return ids;
}

async function apmDeployed(root) {
  let lock;
  try { lock = YAML.parse(await readFile(path.join(root, 'apm.lock.yaml'), 'utf8')); }
  catch { return new Set(); }
  const { apmDeployedIndex } = await import('./apm-lock.mjs');
  return new Set([...(apmDeployedIndex(lock)?.keys() ?? [])]);
}

/**
 * The migration for the configuration at `root` whose parsed workflow.yml is `workflow`, or null when
 * it already records the agents home [AGH:REQ-017]. Reads only; `applyAgentsHomeMigration` writes.
 *
 * `status` is `proposed`, or `held` when a source and an existing destination differ: then nothing
 * moves and the layout stays, and `conflicts` names both files [AGH:REQ-018].
 */
export async function planAgentsHomeMigration(root, workflow) {
  if (agentsRootOf(workflow) === AGENTS_HOME) return null;
  // The key already names a transport root of the repository's own; recording the agents home would
  // drop it, so the move waits for a person to choose [AGH:REQ-018].
  const transportRoot = agentsTransportRootOf(workflow);
  if (transportRoot) {
    return { status: 'held', from: LEGACY_AGENTS_ROOT, to: AGENTS_HOME, transportRoot, moves: [], completed: [], stays: [], conflicts: [], shadowed: [] };
  }
  const [packaged, referenced, deployed] = await Promise.all([packagedAgents(), referencedAgentIds(root, workflow), apmDeployed(root)]);
  const moves = []; const completed = []; const stays = []; const conflicts = []; const shadowed = [];
  for (const name of await directoryFiles(path.join(root, LEGACY_AGENTS_ROOT))) {
    const from = `${LEGACY_AGENTS_ROOT}/${name}`;
    const to = `${AGENTS_HOME}/${name}`;
    if (deployed.has(from)) { stays.push({ path: from, reason: 'apm' }); continue; }
    const bytes = await readFile(path.join(root, from));
    const text = bytes.toString('utf8');
    const digest = sha256(bytes);
    const identity = packaged.identities.has(`${name.toLowerCase()}\0${sha256(withoutSfGuardStampBlock(text))}`)
      || isKnownPackagedAssetHash(from, digest);
    const marked = hasSflowMarker(text);
    let rule = marked ? 'marker' : identity ? 'packaged' : null;
    if (!rule && packaged.names.has(name.toLowerCase())) {
      // The broken case of SPEC-AGH section 2: the team's own file took a packaged agent's name.
      stays.push({ path: from, reason: 'shadow' });
      shadowed.push(to);
      continue;
    }
    if (!rule && referenced.has(agentIdOf(name, text))) rule = 'referenced';
    if (!rule) { stays.push({ path: from, reason: 'own' }); continue; }
    const existing = await readFile(path.join(root, to)).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
    if (existing == null) moves.push({ from, to, rule, sha256: digest });
    else if (existing.equals(bytes)) completed.push({ from, to, rule, sha256: digest });
    else conflicts.push({ from, to, rule });
  }
  return {
    status: conflicts.length ? 'held' : 'proposed',
    from: LEGACY_AGENTS_ROOT, to: AGENTS_HOME,
    moves, completed, stays, conflicts, shadowed
  };
}

/** Moves each file of a proposed plan, byte for byte, so Git follows it as a rename. */
export async function applyAgentsHomeMigration(root, plan) {
  if (plan?.status !== 'proposed') return;
  for (const move of plan.moves) {
    await mkdir(path.join(root, AGENTS_HOME), { recursive: true });
    await rename(path.join(root, move.from), path.join(root, move.to));
  }
  for (const done of plan.completed) await rm(path.join(root, done.from), { force: true });
}

/** A package baseline receipt with its `.github/agents` entries at their agents-home paths [AGH:REQ-012]. */
export function baselineAtAgentsHome(baseline) {
  if (!baseline) return baseline;
  const moved = (map) => (map && typeof map === 'object' ? Object.fromEntries(Object.entries(map).map(([relative, value]) => [
    relative.startsWith(`${LEGACY_AGENTS_ROOT}/`) ? `${AGENTS_HOME}/${relative.slice(LEGACY_AGENTS_ROOT.length + 1)}` : relative, value])) : map);
  return {
    ...baseline,
    assets: moved(baseline.assets),
    ...(baseline.ownership ? { ownership: { ...baseline.ownership, assets: moved(baseline.ownership.assets) } } : {})
  };
}

/** Why a move is held for a repository whose workflow.yml names its own agentPromptsRoot. */
export function transportRootHold({ transportRoot, from, to }) {
  return `held: workflow.yml agentPromptsRoot names ${transportRoot}, which is carried as configuration. SFlow's agents stay in ${from}. To move them to ${to}, remove that key in sflow/config (${transportRoot} is then no longer carried), then preview again.`;
}

/** The preview's lines for one repository's migration [SPEC-AGH section 6]; none when there is none. */
export function agentsHomeLines(agentsHome, indent = '    ') {
  if (!agentsHome) return [];
  const lines = [`${indent}Agents move to ${agentsHome.to}: ${agentsHome.status === 'held' ? 'held' : `${agentsHome.moves.length + agentsHome.completed.length} file(s)`}`];
  for (const move of [...agentsHome.moves, ...agentsHome.completed]) lines.push(`${indent}  moves: ${move.from} → ${move.to}`);
  for (const stay of agentsHome.stays) lines.push(`${indent}  stays: ${stay.path} (${AGENTS_HOME_STAY_REASONS[stay.reason] ?? stay.reason})`);
  for (const installed of agentsHome.shadowed) lines.push(`${indent}  installs: ${installed} (SFlow's packaged agent)`);
  for (const conflict of agentsHome.conflicts) {
    lines.push(`${indent}  held: ${conflict.from} and ${conflict.to} differ. Keep one of them in sflow/config, then preview again.`);
  }
  if (agentsHome.transportRoot) lines.push(`${indent}  ${transportRootHold(agentsHome)}`);
  if (agentsHome.status === 'proposed') lines.push(`${indent}  Stories already running keep their own agents; new Stories use ${agentsHome.to}.`);
  return lines;
}
