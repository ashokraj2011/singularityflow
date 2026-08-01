/**
 * The capability map: what this organisation builds, as a tree.
 *
 * A workspace is a set of repositories, which says how the code is stored. The capability map says
 * what the code is *for*, and those are not the same shape: one business capability is often several
 * repositories, and one repository sometimes serves several. The map nests to any depth, like a
 * directory, because that is how businesses actually describe themselves — Payments contains
 * Checkout contains the one-tap flow — and flattening it to a list throws away the only structure a
 * reader can navigate.
 *
 * It lives in the lead repository, which is where governed state lives, and is versioned with it.
 * There is exactly one map per workspace: two would immediately disagree.
 *
 * Two kinds, and the distinction is load-bearing rather than decorative:
 *
 *   business   a grouping. Has children, ships nothing, owns no repository.
 *   delivery   a leaf that ships. Names exactly one repository and has no children.
 *
 * That is what lets a question like "which repositories does Payments touch" be answered by walking
 * the tree, and "who owns this repository" by walking back up it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { secureRepositoryPath, SingularityFlowError, writeText } from './util.mjs';

export const CAPABILITY_MAP_PATH = 'singularity/capability-map.yml';
export const CAPABILITY_KINDS = new Set(['business', 'delivery']);

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new SingularityFlowError(`${label} must be a safe identifier containing letters, numbers, dots, underscores, or hyphens.`);
  }
  return value;
}

/**
 * Validate and normalize a map.
 *
 * @param portfolio when given, every delivery capability's repository must be one the portfolio
 *   declares. A capability pointing at a repository nobody has configured is the failure this
 *   catches — it looks fine until something tries to clone it.
 */
export function validateCapabilityMap(value, portfolio = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('Capability map must be an object.');
  }
  if (value.version !== 1) throw new SingularityFlowError('Capability map version must be 1.');
  if (!Array.isArray(value.capabilities)) throw new SingularityFlowError('Capability map capabilities must be an array.');

  const seen = new Set();
  const repositories = new Set();

  const normalizeNode = (raw, trail) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SingularityFlowError(`Capability at ${trail.join(' / ') || 'the root'} must be an object.`);
    }
    const id = safeId(raw.id, `Capability ID at ${trail.join(' / ') || 'the root'}`);
    // Unique across the whole tree, not per level: an identifier that means two things cannot be
    // cited, and citing them is the point of having them.
    if (seen.has(id)) throw new SingularityFlowError(`Capability '${id}' is declared more than once.`);
    seen.add(id);

    const kind = raw.kind ?? (raw.repository ? 'delivery' : 'business');
    if (!CAPABILITY_KINDS.has(kind)) {
      throw new SingularityFlowError(`Capability '${id}' kind must be business or delivery.`);
    }
    const here = [...trail, id];

    if (kind === 'delivery') {
      if (!raw.repository) throw new SingularityFlowError(`Delivery capability '${id}' must name a repository.`);
      safeId(raw.repository, `Delivery capability '${id}' repository`);
      if (portfolio && !portfolio.repositories?.[raw.repository]) {
        throw new SingularityFlowError(`Delivery capability '${id}' names repository '${raw.repository}', which the portfolio does not declare.`);
      }
      if (raw.children?.length) {
        throw new SingularityFlowError(`Delivery capability '${id}' ships from a repository and cannot contain other capabilities.`);
      }
      repositories.add(raw.repository);
    } else if (raw.repository) {
      throw new SingularityFlowError(`Business capability '${id}' groups other capabilities and cannot name a repository of its own.`);
    }

    const children = (raw.children ?? []).map((child) => normalizeNode(child, here));
    return {
      id,
      name: raw.name ?? id,
      kind,
      description: raw.description ?? '',
      ...(kind === 'delivery' ? { repository: raw.repository } : {}),
      owner: raw.owner ?? null,
      children
    };
  };

  const capabilities = value.capabilities.map((node) => normalizeNode(node, []));
  return { version: 1, capabilities, repositories: [...repositories].sort() };
}

/** Every capability, depth first, each with the path of ancestors that reaches it. */
export function flattenCapabilities(map) {
  const rows = [];
  const walk = (nodes, ancestors) => {
    for (const node of nodes) {
      rows.push({ ...node, depth: ancestors.length, ancestors });
      walk(node.children ?? [], [...ancestors, node.id]);
    }
  };
  walk(map.capabilities ?? [], []);
  return rows;
}

/** The delivery capabilities beneath a capability, which is what "what does this ship" means. */
export function deliveriesUnder(map, capabilityId) {
  const rows = flattenCapabilities(map);
  const root = rows.find((row) => row.id === capabilityId);
  if (!root) throw new SingularityFlowError(`Unknown capability '${capabilityId}'.`);
  return rows
    .filter((row) => row.kind === 'delivery'
      && (row.id === capabilityId || row.ancestors.includes(capabilityId)))
    .map((row) => ({ id: row.id, name: row.name, repository: row.repository }));
}

/** Which capability a repository belongs to, and the business chain above it. */
export function capabilityForRepository(map, repositoryId) {
  const row = flattenCapabilities(map).find((entry) => entry.repository === repositoryId);
  if (!row) return null;
  return { id: row.id, name: row.name, ancestors: row.ancestors };
}

export async function loadCapabilityMap(root, portfolio = null, { required = false } = {}) {
  const target = await secureRepositoryPath(root, CAPABILITY_MAP_PATH, {
    label: 'Capability map',
    type: 'file'
  });
  if (!target.exists) {
    if (required) throw new SingularityFlowError(`No capability map exists. Create ${CAPABILITY_MAP_PATH} in the lead repository.`);
    // An absent map is a repository that has not described itself yet, not a broken one.
    return null;
  }
  let parsed;
  try { parsed = YAML.parse(await readFile(target.absolute, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`Unable to parse the capability map: ${error.message}`); }
  return validateCapabilityMap(parsed, portfolio);
}

/** Written back in the declared shape, so the file stays the readable thing a person edits. */
export async function saveCapabilityMap(root, map, portfolio = null) {
  const normalized = validateCapabilityMap(map, portfolio);
  const target = await secureRepositoryPath(root, CAPABILITY_MAP_PATH, { label: 'Capability map' });
  const document = {
    version: 1,
    capabilities: normalized.capabilities.map(function strip(node) {
      return {
        id: node.id,
        name: node.name,
        kind: node.kind,
        ...(node.description ? { description: node.description } : {}),
        ...(node.owner ? { owner: node.owner } : {}),
        ...(node.repository ? { repository: node.repository } : {}),
        ...(node.children.length ? { children: node.children.map(strip) } : {})
      };
    })
  };
  await writeText(target.absolute, YAML.stringify(document));
  return { path: target.relative, map: normalized };
}
