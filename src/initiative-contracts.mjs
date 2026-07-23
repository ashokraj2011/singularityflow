import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  initiativeDir, loadInitiative, saveInitiative
} from './initiative-state.mjs';
import {
  initiativeNode, invalidateInitiativeCone
} from './initiative-graph.mjs';
import { loadInitiativeBreakdown } from './initiative-repositories.mjs';
import {
  SingularityFlowError, exists, nowIso, posix, repoRelative, snapshot, writeJson, writeText
} from './util.mjs';

const CONTRACT_FORMATS = new Set(['markdown', 'openapi', 'asyncapi', 'json-schema', 'protobuf']);

function safeContractId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new SingularityFlowError(`${label} must be a safe identifier.`);
  return value;
}

function contractKey(id, version) { return `${id}@${version}`; }

export async function registerInterfaceContract(root, {
  initiativeId,
  contractId,
  version,
  format,
  sourcePath,
  producers = [],
  consumers = [],
  compatibilityPolicy = 'explicit-review',
  persona = null
} = {}) {
  safeContractId(contractId, 'Contract ID');
  safeContractId(String(version), 'Contract version');
  if (!CONTRACT_FORMATS.has(format)) throw new SingularityFlowError(`Contract format must be one of: ${[...CONTRACT_FORMATS].join(', ')}.`);
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const sourceRelative = repoRelative(root, sourcePath);
  const sourceAbsolute = path.join(root, sourceRelative);
  const sourceSnapshot = await snapshot(sourceAbsolute);
  if (!sourceSnapshot.exists || !sourceSnapshot.sha256) throw new SingularityFlowError(`Contract source is not a file: ${sourceRelative}`);
  const key = contractKey(contractId, String(version));
  const existing = initiative.contracts[key];
  if (existing && existing.sha256 !== sourceSnapshot.sha256) throw new SingularityFlowError(`Contract ${key} already exists with different content. Create a new version instead of rewriting it.`);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const plannedStories = new Set([
    ...breakdown.stories.map((story) => story.id),
    ...Object.keys(initiative.childStories ?? {})
  ]);
  const unknownStories = [...new Set([...producers, ...consumers])].filter((storyId) => !plannedStories.has(storyId));
  if (unknownStories.length) throw new SingularityFlowError(`Contract ${key} references unknown stories: ${unknownStories.join(', ')}.`);
  const directory = path.join(initiativeDir(root, portfolio, initiativeId), 'contracts', contractId, String(version));
  const destination = path.join(directory, path.basename(sourceRelative));
  if (!(await exists(destination))) await writeText(destination, await readFile(sourceAbsolute, 'utf8'));
  const record = {
    schemaVersion: 1,
    id: contractId,
    version: String(version),
    format,
    path: posix(path.relative(root, destination)),
    sha256: sourceSnapshot.sha256,
    bytes: sourceSnapshot.size,
    producers: [...new Set(producers)].sort(),
    consumers: [...new Set(consumers)].sort(),
    compatibilityPolicy,
    status: 'active',
    registeredAt: nowIso(),
    persona
  };
  await writeJson(path.join(directory, 'manifest.json'), record);
  const previous = Object.values(initiative.contracts).filter((contract) => contract.id === contractId && contract.version !== String(version) && contract.status === 'active');
  initiative.contracts[key] = record;
  initiative.history.push({
    at: record.registeredAt,
    actor: initiative.initiative.createdBy.email?.toLowerCase() ?? initiative.initiative.createdBy.name,
    persona,
    event: 'initiative_contract_registered',
    phase: initiative.currentPhase,
    detail: `${key} ${record.sha256.slice(0, 12)}`
  });
  await saveInitiative(root, portfolio, initiative);
  const invalidations = [];
  for (const prior of previous) {
    invalidations.push(await invalidateInitiativeCone(root, {
      initiativeId,
      starts: [initiativeNode('contract', prior.id, prior.version)],
      reason: `Contract ${contractId} advanced from version ${prior.version} to ${version}.`,
      cause: 'contract-version-changed',
      persona
    }));
  }
  return { contract: record, invalidations };
}

export async function interfaceContractStatus(root, initiativeId) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const contracts = [];
  for (const [key, contract] of Object.entries(initiative.contracts ?? {})) {
    const current = await snapshot(path.join(root, contract.path));
    const consumers = (contract.consumers ?? []).map((storyId) => ({
      storyId,
      repository: initiative.childStories?.[storyId]?.repository ?? null,
      stale: initiative.childStories?.[storyId]?.stale ?? false,
      observedContractSha256: initiative.childStories?.[storyId]?.contractSnapshots?.[contract.id]?.sha256 ?? null
    }));
    contracts.push({
      key,
      ...contract,
      integrity: current.exists && current.sha256 === contract.sha256 ? 'verified' : 'stale',
      consumers
    });
  }
  return contracts.sort((left, right) => left.key.localeCompare(right.key));
}
