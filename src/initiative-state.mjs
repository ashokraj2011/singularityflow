import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import YAML from 'yaml';
import {
  add, branch, fileAtRef, head, identity, localBranches, pushBranch, pushCommitToBranch, remoteBranches
} from './git.mjs';
import {
  loadPortfolio, resolveInitiativeProfile, snapshotInitiativeResolution,
  validatePortfolioWorldModelViews
} from './initiative-config.mjs';
import { ensureRepositoryTemplates, loadDefinition } from './config.mjs';
import { renderInitiativeGenerator } from './initiative-generators.mjs';
import { initiativeOutputRequired } from './initiative-policy.mjs';
import { groundingMode } from './grounding.mjs';
import { normalizeContextPolicy } from './context-policy.mjs';
import {
  secureRepositoryPath, SingularityFlowError, nowIso, posix, readJson, run, snapshot, stateFingerprint, writeJson, writeText
} from './util.mjs';
import { runRemoteGit } from './git-execution.mjs';
import { createLedgerIntent, reconcileLedger } from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import {
  applyCapabilityPolicyToInitiativeResolution,
  assertCapabilitySource,
  capabilityWorldModelGrounding,
  materializeCapabilityWorldModelPack,
  resolveLifecycleCapability
} from './capability-context.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import {
  clearPendingPublication,
  livePreparedPublicationOwner,
  localPendingPublicationPath,
  readPendingPublication,
  recoverPreparedPublication,
} from './publication-pending.mjs';
import { restorePublicationPreimage } from './publication-recovery.mjs';
import { lifecycleEvent, recordPublicationProjection } from './lifecycle-event.mjs';
import { publishLifecycleChange } from './publication-unit-of-work.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

export const INITIATIVE_STATE_SCHEMA_VERSION = currentSchemaVersion('initiative-state');

function actorKey(actor) { return actor.email?.toLowerCase() ?? actor.name; }

export function initiativePublicationMode(portfolio, initiative) {
  const configured = portfolio.git?.publish ?? 'required';
  const capability = initiative.resolution?.capability?.policy?.gitPublication;
  if (configured === 'required' || capability === 'required') return 'required';
  if (capability === 'warn') return 'warn';
  return configured;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

function appendOnlyStateShape(value) {
  const copy = structuredClone(value);
  delete copy.history;
  delete copy.publicationProjections;
  if (copy.sources) {
    delete copy.sources.records;
    if (Object.values(copy.sources).every((entry) => entry == null)) delete copy.sources;
  }
  return copy;
}

function mergeAppendOnlyState(base, left, right) {
  const baseline = appendOnlyStateShape(base);
  if (!sameValue(appendOnlyStateShape(left), baseline) || !sameValue(appendOnlyStateShape(right), baseline)) {
    throw new SingularityFlowError(
      'Concurrent append-only retry also contains a lifecycle-state change; automatic replay was refused.'
    );
  }
  const merged = structuredClone(left);
  const events = [...(base.history ?? []), ...(left.history ?? []), ...(right.history ?? [])];
  const unique = new Map(events.map((event) => [JSON.stringify(stableJson(event)), event]));
  merged.history = [...unique.values()].sort((a, b) => {
    const byTime = String(a.at ?? '').localeCompare(String(b.at ?? ''));
    return byTime || JSON.stringify(stableJson(a)).localeCompare(JSON.stringify(stableJson(b)));
  });
  const publications = new Map();
  for (const record of [
    ...(base.publicationProjections ?? []),
    ...(left.publicationProjections ?? []),
    ...(right.publicationProjections ?? [])
  ]) {
    const eventId = record.event?.eventId;
    if (!eventId) throw new SingularityFlowError('Append-only publication projection is missing event.eventId.');
    const previous = publications.get(eventId);
    if (previous && !sameValue(previous, record)) {
      throw new SingularityFlowError(`Concurrent publication event '${eventId}' has different projection recipes.`);
    }
    publications.set(eventId, record);
  }
  merged.publicationProjections = [...publications.values()].sort((a, b) =>
    String(a.event?.createdAt ?? '').localeCompare(String(b.event?.createdAt ?? ''))
      || String(a.event?.eventId ?? '').localeCompare(String(b.event?.eventId ?? '')));
  if (left.sources || right.sources) {
    merged.sources = structuredClone(left.sources ?? right.sources);
    merged.sources.records = Math.max(
      Number(base.sources?.records ?? 0),
      Number(left.sources?.records ?? 0),
      Number(right.sources?.records ?? 0)
    );
  }
  return merged;
}

function manifestWithoutSources(value) {
  const copy = structuredClone(value);
  delete copy.sources;
  return copy;
}

function mergeAppendOnlySourceManifest(base, left, right) {
  const baseline = manifestWithoutSources(base);
  if (!sameValue(manifestWithoutSources(left), baseline) || !sameValue(manifestWithoutSources(right), baseline)) {
    throw new SingularityFlowError(
      'Concurrent source retry changed non-source manifest fields; automatic replay was refused.'
    );
  }
  const sources = new Map();
  for (const source of [...(base.sources ?? []), ...(left.sources ?? []), ...(right.sources ?? [])]) {
    const previous = sources.get(source.sourceId);
    if (previous && !sameValue(previous, source)) {
      throw new SingularityFlowError(
        `Concurrent source '${source.sourceId}' has different immutable records; automatic replay was refused.`
      );
    }
    sources.set(source.sourceId, source);
  }
  return {
    ...structuredClone(left),
    sources: [...sources.values()].sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)))
  };
}

function rebaseStage(root, stage, relative, parser, fallback = undefined) {
  const result = run('git', ['show', `:${stage}:${relative}`], { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    if (fallback !== undefined) return structuredClone(fallback);
    throw new SingularityFlowError(`Unable to read concurrent Git stage ${stage} for ${relative}.`);
  }
  try {
    return parser(result.stdout);
  } catch (error) {
    throw new SingularityFlowError(`Concurrent ${relative} is invalid: ${error.message}`);
  }
}

async function replayAppendOnlyCommit(root, portfolio, initiative, remote, sha) {
  const remoteRef = `refs/remotes/${remote}/${initiative.initiative.branch}`;
  const fetched = runRemoteGit([
    'fetch', remote,
    `+refs/heads/${initiative.initiative.branch}:${remoteRef}`
  ], { cwd: root, operation: 'remote-configuration' });
  if (fetched.status !== 0) return { status: fetched.status, stdout: fetched.stdout, stderr: fetched.stderr };

  const unpublished = run('git', ['rev-list', '--count', `${remoteRef}..HEAD`], {
    cwd: root,
    allowFailure: true
  });
  if (unpublished.status !== 0 || Number(unpublished.stdout.trim()) !== 1 || head(root) !== sha) {
    return {
      status: 1,
      stdout: '',
      stderr: 'Automatic append-only replay requires exactly one unpublished local commit.'
    };
  }

  const rebased = run('git', ['rebase', remoteRef], { cwd: root, allowFailure: true });
  if (rebased.status === 0) return { status: 0, stdout: rebased.stdout, stderr: rebased.stderr };

  const conflicted = run('git', ['diff', '--name-only', '--diff-filter=U', '-z'], {
    cwd: root,
    allowFailure: true
  }).stdout.split('\0').filter(Boolean).map(posix);
  const prefix = `${posix(initiativeRelative(portfolio, initiative.initiative.id))}/`;
  const statePath = `${prefix}state.json`;
  const statusPath = `${prefix}STATUS.md`;
  const sourceManifestPath = `${prefix}sources/manifest.yml`;
  const supported = new Set([statePath, statusPath, sourceManifestPath]);
  const abort = (error) => {
    const aborted = run('git', ['rebase', '--abort'], { cwd: root, allowFailure: true });
    const detail = error?.message ?? String(error);
    return {
      status: 1,
      stdout: '',
      stderr: `${detail}${aborted.status === 0 ? '' : `; rebase abort failed: ${(aborted.stderr || aborted.stdout).trim()}`}`
    };
  };
  if (!conflicted.length || conflicted.some((file) => !supported.has(file))) {
    return abort(new SingularityFlowError(
      `Automatic append-only replay found unsupported conflicts: ${conflicted.join(', ') || 'unknown conflict'}.`
    ));
  }

  try {
    let mergedManifest = null;
    if (conflicted.includes(sourceManifestPath)) {
      mergedManifest = mergeAppendOnlySourceManifest(
        rebaseStage(root, 1, sourceManifestPath, YAML.parse, {
          version: 1,
          initiativeId: initiative.initiative.id,
          sources: []
        }),
        rebaseStage(root, 2, sourceManifestPath, YAML.parse),
        rebaseStage(root, 3, sourceManifestPath, YAML.parse)
      );
      await writeText(path.join(root, sourceManifestPath), YAML.stringify(mergedManifest));
    }
    const mergedState = conflicted.includes(statePath)
      ? mergeAppendOnlyState(
        rebaseStage(root, 1, statePath, JSON.parse),
        rebaseStage(root, 2, statePath, JSON.parse),
        rebaseStage(root, 3, statePath, JSON.parse)
      )
      : JSON.parse(await readFile(path.join(root, statePath), 'utf8'));
    if (mergedManifest) {
      mergedState.sources ??= { records: 0, verifiedAt: null };
      mergedState.sources.records = mergedManifest.sources.length;
    }
    await saveInitiative(root, portfolio, mergedState);
    add(root, [initiativeRelative(portfolio, initiative.initiative.id)]);
    const staged = run('git', ['diff', '--cached', '--quiet'], { cwd: root, allowFailure: true }).status !== 0;
    const continued = run(
      'git',
      staged ? ['rebase', '--continue'] : ['rebase', '--skip'],
      { cwd: root, env: { ...process.env, GIT_EDITOR: 'true' }, allowFailure: true }
    );
    if (continued.status !== 0) return abort(new SingularityFlowError(
      `Automatic append-only replay could not continue: ${(continued.stderr || continued.stdout).trim()}`
    ));
    return { status: 0, stdout: continued.stdout, stderr: continued.stderr };
  } catch (error) {
    return abort(error);
  }
}

// Restore any packaged initiative template the repository is missing, into the portfolio's own
// templatesRoot — the root the resolver and the recorded snapshot paths both read, and which the
// workflow definition may configure differently. Repositories initialized before the initiatives/
// subtree shipped have none of it, so every referenced template would otherwise abort the phase.
// Installed files are claimed by commitInitiativeChange so the isolated publication index stages
// them together with the initiative. They must not be placed in the contributor's real index:
// pre-staging a governed path would make the publication boundary correctly refuse to replace it.
/*
 * What this command restored, so the governed commit can claim it.
 *
 * Healing happens deep inside the operations while the commit is taken at the top, and threading a
 * path list through every caller in cli.mjs would be a wide change for a narrow fact. One command
 * per process, so the lifetime of this set is the command; `commitInitiativeChange` drains it.
 *
 * Before commits were isolated from the contributor's index, these files rode along in the
 * index-wide commit. The path set now supplies them directly to the publication transaction.
 */
const healedTemplatePaths = new Set();

/**
 * Claim what was healed under one portfolio's templates root.
 *
 * Scoped by root and by what is actually on disk: a process handles many operations in tests, and
 * an earlier operation's root is not this commit's to claim — `git add` fails outright on a
 * pathspec that matches nothing.
 */
function claimHealedTemplatePaths(root, templatesRoot) {
  const prefix = `${posix(templatesRoot)}/`;
  const claimed = [...healedTemplatePaths]
    .filter((relative) => relative.startsWith(prefix))
    .filter((relative) => existsSync(path.join(root, relative)));
  for (const relative of claimed) healedTemplatePaths.delete(relative);
  return claimed;
}

async function healInitiativeTemplates(root, portfolio) {
  const installed = await ensureRepositoryTemplates(root, null, { templatesRoot: portfolio.templatesRoot });
  if (installed.length) {
    const paths = installed.map((relative) => posix(path.join(portfolio.templatesRoot, relative)));
    for (const relative of paths) healedTemplatePaths.add(relative);
  }
  return installed;
}

export function validateInitiativeId(id) {
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new SingularityFlowError('Initiative ID must be one safe identifier without slashes.');
  return id;
}

export function initiativeDir(root, portfolio, id) {
  return path.join(root, portfolio.initiativeRoot ?? 'singularity/initiatives', validateInitiativeId(id));
}

export function initiativeRelative(portfolio, id) {
  return posix(path.join(portfolio.initiativeRoot ?? 'singularity/initiatives', validateInitiativeId(id)));
}

export function initiativeStatePath(root, portfolio, id) {
  return path.join(initiativeDir(root, portfolio, id), 'state.json');
}

export function initiativePendingPublicationPath(root, portfolio, id) {
  return localPendingPublicationPath(root, 'initiative', id);
}

function legacyInitiativePendingPublicationPath(root, portfolio, id) {
  return path.join(initiativeDir(root, portfolio, id), 'publication-pending.json');
}

export async function secureInitiativePath(root, portfolio, id, relative = '', options = {}) {
  const initiativeId = validateInitiativeId(id);
  if (typeof relative !== 'string' || path.isAbsolute(relative)) {
    throw new SingularityFlowError(`Initiative '${initiativeId}' path must remain inside the initiative directory.`);
  }
  const base = initiativeRelative(portfolio, initiativeId);
  const candidate = path.join(base, relative);
  const within = path.relative(base, candidate);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    throw new SingularityFlowError(`Initiative '${initiativeId}' path must remain inside the initiative directory: ${relative}`);
  }
  return secureRepositoryPath(root, candidate, {
    label: options.label ?? `Initiative '${initiativeId}' path`,
    mustExist: options.mustExist ?? false,
    type: options.type ?? null
  });
}

function outputKey(phaseId, outputId) { return `${phaseId}/${outputId}`; }

function validateInitiativeRuntimeState(initiative, expectedId = initiative?.initiative?.id) {
  initiative = readRecord('initiative-state', initiative).record;
  if (initiative?.initiative?.id !== expectedId) {
    throw new SingularityFlowError(`Invalid initiative state for ${expectedId}.`);
  }
  if (!Array.isArray(initiative.resolution?.phases) || !Array.isArray(initiative.phaseOrder)) {
    throw new SingularityFlowError(`Initiative '${expectedId}' has no valid immutable phase resolution.`);
  }
  const resolvedIds = initiative.resolution.phases.map((phase) => phase.id);
  if (JSON.stringify(initiative.phaseOrder) !== JSON.stringify(resolvedIds)) {
    throw new SingularityFlowError(`Initiative '${expectedId}' phase order differs from its immutable resolution.`);
  }
  if (initiative.resolution.profile !== initiative.initiative.profile) {
    throw new SingularityFlowError(`Initiative '${expectedId}' profile differs from its immutable resolution.`);
  }
  initiative.resolution.contextPolicy = normalizeContextPolicy(initiative.resolution.contextPolicy ?? {});
  if (initiative.initiative.branch !== expectedId) {
    throw new SingularityFlowError(`Initiative '${expectedId}' branch identity is invalid.`);
  }
  initiative.lineage ??= {
    idAuthority: initiative.resolution.identity?.authority ?? (initiative.initiative.source?.type === 'jira' ? 'jira' : 'local'),
    primaryId: initiative.initiative.id,
    aliases: []
  };
  if (!['jira', 'local'].includes(initiative.lineage.idAuthority)) {
    throw new SingularityFlowError(`Initiative '${expectedId}' has unsupported identity authority '${initiative.lineage.idAuthority}'.`);
  }
  if (initiative.resolution.identity?.authority && initiative.lineage.idAuthority !== initiative.resolution.identity.authority) {
    throw new SingularityFlowError(`Initiative '${expectedId}' identity authority differs from its immutable resolution.`);
  }
  if (initiative.lineage.primaryId !== initiative.initiative.id) {
    throw new SingularityFlowError(`Initiative '${expectedId}' primary lineage ID is invalid.`);
  }
  if (initiative.currentPhase !== null && !resolvedIds.includes(initiative.currentPhase)) {
    throw new SingularityFlowError(`Initiative '${expectedId}' current phase '${initiative.currentPhase}' is not in its immutable resolution.`);
  }
  initiative.delivery ??= {
    status: initiative.resolution.profile === 'epic-planning' ? 'tracking' : 'not_applicable',
    completion: null
  };
  for (const definition of initiative.resolution.phases) {
    const phase = initiative.phases?.[definition.id];
    if (!phase || phase.id !== definition.id) {
      throw new SingularityFlowError(`Initiative '${expectedId}' phase '${definition.id}' state is missing or invalid.`);
    }
    const expectedOutputs = definition.outputs.map((output) => output.id).sort();
    const actualOutputs = Object.keys(phase.outputs ?? {}).sort();
    if (JSON.stringify(actualOutputs) !== JSON.stringify(expectedOutputs)) {
      throw new SingularityFlowError(`Initiative '${expectedId}' output state for '${definition.id}' differs from its immutable resolution.`);
    }
    for (const outputDefinition of definition.outputs) {
      const output = phase.outputs[outputDefinition.id];
      const expectedPath = posix(path.join('artifacts', definition.id, outputDefinition.path));
      if (output.path !== expectedPath || output.kind !== outputDefinition.kind || output.required !== outputDefinition.required) {
        throw new SingularityFlowError(`Initiative '${expectedId}' output '${definition.id}/${outputDefinition.id}' differs from its immutable resolution.`);
      }
    }
  }
  return initiative;
}

function referencedAuthorities(resolved) {
  const authorities = new Set();
  for (const phase of resolved.phases) {
    for (const policy of [
      phase.bundleApproval,
      ...phase.outputs.map((output) => output.approval),
      ...phase.checklist.map((check) => check.approval)
    ]) for (const authority of policy.authorities ?? []) authorities.add(authority);
  }
  return [...authorities].sort();
}

function assertAuthorityMembership(resolved) {
  const missing = referencedAuthorities(resolved).filter((id) => !(resolved.approvalAuthorities[id]?.members ?? []).length);
  if (missing.length) throw new SingularityFlowError(`Initiative approval authorities require at least one local Git identity before start: ${missing.join(', ')}. Configure approvalAuthorities in singularity/portfolio.yml.`);
}

export async function initiativeStartPreflight(root, {
  profile,
  idAuthority = null
} = {}) {
  const portfolio = await loadPortfolio(root);
  const definition = await loadDefinition(root);
  validatePortfolioWorldModelViews(portfolio, definition);
  const resolved = resolveInitiativeProfile(portfolio, profile, { idAuthority });
  assertAuthorityMembership(resolved);
  const actor = identity(root);
  if (!actor.email) {
    throw new SingularityFlowError('Initiative governance requires a local Git email. Configure user.email before starting.');
  }
  return { portfolio, definition, resolved, actor };
}

function phaseState(phase, index, createdAt) {
  return {
    id: phase.id,
    label: phase.label,
    order: index,
    status: index === 0 ? 'in_progress' : 'not_started',
    startedAt: index === 0 ? createdAt : null,
    submittedAt: null,
    approvedAt: null,
    generation: 0,
    outputs: Object.fromEntries(phase.outputs.map((output) => [output.id, {
      id: output.id,
      label: output.label,
      kind: output.kind,
      path: posix(path.join('artifacts', phase.id, output.path)),
      required: output.required,
      status: 'not_generated',
      generation: 0,
      sha256: null,
      bytes: 0,
      generatedBy: null,
      generatedAgent: null
    }])),
    checklist: Object.fromEntries(phase.checklist.map((check) => [check.id, {
      id: check.id,
      label: check.label,
      requirement: check.requirement,
      status: check.requirement === 'optional' ? 'optional' : 'missing'
    }]))
  };
}

export function initiativeStatusMarkdown(initiative) {
  const lines = [
    `# ${initiative.initiative.id} — ${initiative.initiative.title}`, '',
    `- Profile: **${initiative.initiative.profileLabel}**`,
    ...(initiative.resolution?.capability
      ? [`- Capability: **${initiative.resolution.capability.name}** (\`${initiative.resolution.capability.id}\`)`,
        `- Capability map: \`${initiative.resolution.capability.map.sha256}\``]
      : []),
    `- Branch: \`${initiative.initiative.branch}\``,
    `- Status: **${initiative.status}**`,
    `- Current phase: **${initiative.currentPhase ?? 'complete'}**`,
    ...(initiative.resolution.profile === 'epic-planning'
      ? [`- Delivery tracking: **${initiative.delivery?.status ?? 'tracking'}**`]
      : []),
    `- Identity assurance: **configured-local**`, '',
    '| # | Phase | Status | Generation | Outputs | Checklist |',
    '|---:|---|---|---:|---:|---:|'
  ];
  for (const phaseId of initiative.phaseOrder) {
    const phase = initiative.phases[phaseId];
    const outputs = Object.values(phase.outputs);
    const checks = Object.values(phase.checklist);
    lines.push(`| ${phase.order + 1} | ${phase.label} | **${phase.status}** | ${phase.generation} | ${outputs.filter((item) => item.status !== 'not_generated').length}/${outputs.length} | ${checks.filter((item) => ['satisfied', 'waived', 'not_applicable'].includes(item.status)).length}/${checks.length} |`);
  }
  lines.push('', '## Recent history', '');
  for (const event of initiative.history.slice(-20).reverse()) lines.push(`- ${event.at} — **${event.event}**${event.phase ? ` (${event.phase})` : ''} by ${event.actor ?? 'unknown'}${event.agent ? ` · governed agent ${event.agent}` : ''}${event.detail ? `: ${event.detail}` : ''}`);
  return `${lines.join('\n')}\n`;
}

export async function saveInitiative(root, portfolio, initiative) {
  validateInitiativeRuntimeState(initiative);
  const id = initiative.initiative.id;
  const directory = await secureInitiativePath(root, portfolio, id, '', {
    label: `Initiative '${id}' directory`,
    mustExist: true,
    type: 'directory'
  });
  const state = await secureInitiativePath(root, portfolio, id, 'state.json', {
    label: `Initiative '${id}' state`
  });
  const status = await secureInitiativePath(root, portfolio, id, 'STATUS.md', {
    label: `Initiative '${id}' status`
  });
  await writeJson(state.absolute, initiative);
  await writeText(status.absolute, initiativeStatusMarkdown(initiative));
  // Mirror of `saveWorkflow`: every legitimate write by this process refreshes the aggregate's idea
  // of what is on disk, so the publication check can treat a remaining mismatch as another process.
  const tracked = initiative[Symbol.for('singularity-flow.state-revision')];
  if (tracked) tracked.stateSha256 = stateFingerprint(state.absolute);
}

export async function createInitiative(root, {
  id,
  title,
  profile,
  source = { type: 'manual' },
  agent = null,
  idAuthority = null,
  startPhase = null,
  capabilityId = null
} = {}) {
  validateInitiativeId(id);
  const preflight = await initiativeStartPreflight(root, {
    profile,
    idAuthority
  });
  const { portfolio, definition, actor } = preflight;
  const capability = await resolveLifecycleCapability(root, { capabilityId });
  assertCapabilitySource(capability, source);
  const resolved = applyCapabilityPolicyToInitiativeResolution(preflight.resolved, capability);
  assertAuthorityMembership(resolved);
  if (branch(root) !== id) throw new SingularityFlowError(`Current branch ${branch(root)} must exactly match initiative ID ${id}.`);
  const stateFile = await secureInitiativePath(root, portfolio, id, 'state.json', {
    label: `Initiative '${id}' state`
  });
  if (stateFile.exists) throw new SingularityFlowError(`${id} already exists. Use singularity-flow initiative resume ${id}.`);
  const directory = await secureInitiativePath(root, portfolio, id, '', {
    label: `Initiative '${id}' directory`,
    type: 'directory'
  });
  if (directory.exists && (await readdir(directory.absolute)).length) {
    throw new SingularityFlowError(`Initiative directory ${directory.relative} already contains files but has no valid state. Inspect or recover it before starting ${id}; existing data will not be overwritten.`);
  }
  await healInitiativeTemplates(root, portfolio);
  const resolution = await snapshotInitiativeResolution(root, portfolio, resolved);
  resolution.capability = capability;
  resolution.worldModelSourceScope = structuredClone(resolved.worldModelSourceScope ?? null);
  resolution.worldModelTiming = profile === 'epic-planning' ? 'story-intake' : 'initiative';
  resolution.worldModelGrounding = capabilityWorldModelGrounding(
    resolution.worldModelTiming === 'story-intake' ? 'off' : groundingMode(definition),
    capability
  );
  resolution.worldModelOutputDir = definition.worldModel?.outputDir ?? 'singularity/world-model';
  resolution.worldModelStaleness = resolved.worldModelStaleness ?? definition.worldModel?.staleness ?? 'warn';
  resolution.ledger = normalizeLedgerConfig(definition.ledger ?? {});
  if (capability) {
    await mkdir(directory.absolute, { recursive: true });
    const context = await materializeCapabilityWorldModelPack(root, capability, {
      itemDirectory: directory.absolute,
      itemRelative: initiativeRelative(portfolio, id),
      views: [...new Set(resolved.phases.flatMap((phase) => phase.worldModelViews ?? []))]
    });
    resolution.capability = { ...capability, context };
  }
  resolution.resolutionSha256 = createHash('sha256').update(JSON.stringify({
    profileResolutionSha256: resolution.resolutionSha256,
    worldModelTiming: resolution.worldModelTiming,
    worldModelGrounding: resolution.worldModelGrounding,
    worldModelOutputDir: resolution.worldModelOutputDir,
    worldModelStaleness: resolution.worldModelStaleness,
    worldModelSourceScope: resolution.worldModelSourceScope,
    ledger: resolution.ledger,
    capability: resolution.capability
  })).digest('hex');
  const createdAt = nowIso();
  const phases = resolved.phases.map((phase, index) => phaseState(phase, index, createdAt));

  // Work does not always begin at the beginning. An Initiative whose discovery happened elsewhere —
  // in a document, in another tool, last quarter — should be able to enter at the stage it has
  // actually reached, rather than having its earlier phases faked to get past them.
  //
  // The phases before it are recorded as skipped, not approved. Nothing pretends they were done:
  // an approval that never happened must never appear to have happened, so they carry a status of
  // their own and the reason the Initiative started where it did.
  const entryIndex = startPhase == null ? 0 : phases.findIndex((phase) => phase.id === startPhase);
  if (entryIndex < 0) {
    throw new SingularityFlowError(
      `Profile '${resolved.id}' has no phase '${startPhase}'. Its phases are: ${phases.map((phase) => phase.id).join(', ')}.`);
  }
  const entryPhase = phases[entryIndex]?.id ?? null;
  const skipped = phases.slice(0, entryIndex).map((phase) => phase.id);
  for (const phase of phases.slice(0, entryIndex)) {
    phase.status = 'skipped';
    phase.skippedAt = createdAt;
    phase.skippedReason = `Initiative entered the lifecycle at ${entryPhase}.`;
  }
  const initiative = {
    schemaVersion: INITIATIVE_STATE_SCHEMA_VERSION,
    initiative: {
      id,
      title: title || id,
      profile,
      profileLabel: resolved.label,
      branch: id,
      createdAt,
      createdBy: actor,
      source: structuredClone(source)
    },
    resolution,
    lineage: {
      idAuthority: resolution.identity.authority,
      primaryId: id,
      aliases: source?.type === 'jira' && source?.key && source.key !== id
        ? [{ authority: 'jira', id: source.key, issueId: source.id ?? null, recordedAt: createdAt }]
        : []
    },
    status: 'in_progress',
    currentPhase: entryPhase,
    phaseOrder: phases.map((phase) => phase.id),
    phases: Object.fromEntries(phases.map((phase) => [phase.id, phase])),
    materialization: { status: 'not_started', attempts: [] },
    delivery: {
      status: resolved.id === 'epic-planning' ? 'tracking' : 'not_applicable',
      completion: null
    },
    childStories: {},
    contracts: {},
    telemetry: { totalTokens: 0, exactRecords: 0, unavailableRecords: 0, providerCost: null },
    history: [{
      at: createdAt,
      actor: actorKey(actor),
      agent,
      event: 'initiative_started',
      phase: entryPhase,
      detail: skipped.length
        ? `Created ${resolved.id} initiative at ${entryPhase}, skipping ${skipped.join(', ')}`
        : `Created ${resolved.id} initiative`
    }]
  };
  await mkdir(directory.absolute, { recursive: true });
  const definitionPath = await secureInitiativePath(root, portfolio, id, 'definition.yml', {
    label: `Initiative '${id}' definition`
  });
  const breakdownPath = await secureInitiativePath(root, portfolio, id, 'breakdown.yml', {
    label: `Initiative '${id}' breakdown`
  });
  const repositoriesPath = await secureInitiativePath(root, portfolio, id, 'repositories.lock.yml', {
    label: `Initiative '${id}' repository lock`
  });
  const readmePath = await secureInitiativePath(root, portfolio, id, 'README.md', {
    label: `Initiative '${id}' README`
  });
  await writeText(definitionPath.absolute, YAML.stringify({
    version: 1,
    initiative: initiative.initiative,
    resolution: {
      profile: resolution.profile,
      portfolioSha256: resolution.portfolioSha256,
      resolutionSha256: resolution.resolutionSha256,
      idAuthority: resolution.identity.authority,
      capability: resolution.capability ? {
        id: resolution.capability.id,
        path: resolution.capability.path,
        mapSha256: resolution.capability.map.sha256
      } : null
    }
  }));
  await writeText(breakdownPath.absolute, YAML.stringify({
    version: resolved.id === 'epic-planning' ? 2 : 1,
    initiativeId: id,
    epics: []
  }));
  await writeText(repositoriesPath.absolute, YAML.stringify({
    version: 1,
    initiativeId: id,
    repositories: Object.fromEntries(Object.entries(resolution.repositories).map(([repositoryId, repository]) => [repositoryId, {
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      required: repository.required,
      metadata: structuredClone(repository.metadata ?? {}),
      jira: structuredClone(repository.jira ?? {}),
      observedHead: null,
      observedAt: null
    }]))
  }));
  await writeText(readmePath.absolute, `# ${id} — ${initiative.initiative.title}\n\nDurable initiative orchestration state for branch \`${id}\`.\n\n- [state.json](./state.json) — immutable profile resolution and lifecycle state\n- [STATUS.md](./STATUS.md) — human-readable progress\n- [breakdown.yml](./breakdown.yml) — Epic and repository-story plan\n- [repositories.lock.yml](./repositories.lock.yml) — observed repository heads\n- [artifacts/](./artifacts/) — governed phase outputs\n- [evidence/records/](./evidence/records/) — append-only evidence\n- [approvals/records/](./approvals/records/) — append-only decisions\n- [invalidations/records/](./invalidations/records/) — dependency-cone invalidations\n- [contracts/](./contracts/) — versioned cross-repository contracts\n`);
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative };
}

export async function loadInitiative(root, id = undefined, portfolio = null) {
  const definition = portfolio ?? await loadPortfolio(root);
  const requested = id ?? branch(root);
  const index = await buildRepositorySubjectIndex(root, { portfolio: definition });
  const selected = resolveContext(index, { reference: requested, kind: 'initiative', required: false });
  if (!selected) {
    const expected = posix(path.relative(root, initiativeStatePath(root, definition, requested)));
    throw new SingularityFlowError(`No initiative found for ${requested}. Expected ${expected} or a registered branch alias.`);
  }
  const initiative = validateInitiativeRuntimeState(await readJson(path.join(root, selected.location.path)), selected.id);
  return { portfolio: definition, initiative };
}

function inputSummary(initiative, phaseDefinition, outputDefinition) {
  const lines = [];
  for (const reference of outputDefinition.consumes ?? []) {
    const [phaseId, outputId] = reference.split('/');
    const source = initiative.phases[phaseId]?.outputs?.[outputId];
    lines.push(`- ${reference}: ${source?.sha256 ? `${source.sha256.slice(0, 16)} (${source.status})` : 'not yet published'}`);
  }
  return lines.length ? lines.join('\n') : '- No declared initiative artifact inputs.';
}

export function initiativeArtifactMetadata(initiative, phase, output, definition) {
  return {
    schemaVersion: 1,
    initiativeId: initiative.initiative.id,
    profile: initiative.initiative.profile,
    phase: phase.id,
    output: output.id,
    kind: output.kind,
    generation: phase.generation + 1,
    status: output.status,
    configSha256: initiative.resolution.portfolioSha256,
    resolutionSha256: initiative.resolution.resolutionSha256,
    template: initiative.resolution.templates[outputKey(phase.id, output.id)] ?? null,
    consumes: definition.consumes
  };
}

export async function verifyInitiativePhaseInputs(root, portfolio, initiative, phaseId) {
  const definition = initiative.resolution.phases.find((phase) => phase.id === phaseId);
  if (!definition) throw new SingularityFlowError(`Unknown initiative phase '${phaseId}'.`);
  const verified = [];
  for (const output of definition.outputs) {
    for (const reference of output.consumes ?? []) {
      const [producerPhaseId, producerOutputId] = reference.split('/');
      const producerPhase = initiative.phases[producerPhaseId];
      const producerOutput = producerPhase?.outputs?.[producerOutputId];
      if (producerPhase?.status !== 'approved') throw new SingularityFlowError(`Initiative input '${reference}' for '${phaseId}/${output.id}' requires approved phase '${producerPhaseId}', which is ${producerPhase?.status ?? 'missing'}.`);
      // An optional producer that was never authored is not a missing input. Requiring it anyway
      // would mean an Epic with no recorded source gaps could never reach requirements — the gate
      // would be enforcing the existence of a document rather than the availability of evidence.
      if (producerOutput?.required === false && !producerOutput.sha256) continue;
      // Legacy Epic snapshots may still say required even though the current
      // Epic Intake policy is non-blocking.
      if (!initiativeOutputRequired(initiative, producerPhaseId, producerOutput) && !producerOutput.sha256) continue;
      if (!producerOutput?.sha256 || !['published', 'approved'].includes(producerOutput.status)) throw new SingularityFlowError(`Initiative input '${reference}' for '${phaseId}/${output.id}' has no approved published artifact hash.`);
      const source = await secureInitiativePath(root, portfolio, initiative.initiative.id, producerOutput.path, {
        label: `Initiative input '${reference}'`,
        mustExist: true,
        type: 'file'
      });
      const current = await snapshot(source.absolute);
      if (!current.exists || current.sha256 !== producerOutput.sha256) throw new SingularityFlowError(`Initiative input '${reference}' for '${phaseId}/${output.id}' changed after approval.`);
      verified.push({ consumer: `${phaseId}/${output.id}`, producer: reference, sha256: current.sha256, bytes: current.size });
    }
  }
  return verified;
}

/**
 * Every output this phase could produce: the ones pinned when the Epic started, plus any the
 * profile has gained since. An Epic that started before an output existed can adopt it; one that
 * started with an output keeps it on offer even if the profile has since dropped it, because work
 * already authored against it must stay describable.
 */
export function availableInitiativeOutputs(portfolio, initiative, phaseId) {
  const pinned = initiative.resolution.phases.find((item) => item.id === phaseId)?.outputs ?? [];
  const configured = resolveInitiativeProfile(portfolio, initiative.resolution.profile)
    ?.phases.find((item) => item.id === phaseId)?.outputs ?? [];
  const configuredById = new Map(configured.map((output) => [output.id, output]));
  const byId = new Map(pinned.map((output) => [output.id, {
    ...output,
    // The profile is the authority on what governance demands *now*; the pinned entry is the
    // authority on where the artifact lives and which template it was cut from. Reading required
    // from the pinned copy would mean an Epic started before an output was relaxed could never
    // relax it — the profile could be corrected and no existing Epic would ever benefit.
    required: configuredById.has(output.id) ? configuredById.get(output.id).required !== false : output.required !== false,
    pinned: true
  }]));
  for (const output of configured) if (!byId.has(output.id)) byId.set(output.id, { ...output, pinned: false });
  return [...byId.values()];
}

/**
 * Record which of a phase's outputs this Epic will produce.
 *
 * The pinned resolution is what makes an Epic reproducible, so this is the one sanctioned way to
 * move it, and it is written down: who, when, why, and the set before and after. Three things it
 * will not do — touch an approved phase, drop an output the profile requires, or drop one that
 * already has content — because each of those would make committed work unexplainable.
 *
 * Adopting an output the Epic never pinned brings its template hash with it, so the adopted output
 * is governed on exactly the same terms as one pinned at the start.
 */
export async function selectInitiativePhaseOutputs(root, id, phaseId, includedIds, { reason = null, agent = null } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, id);
  const phase = initiative.phases[phaseId];
  if (!phase) throw new SingularityFlowError(`Initiative '${id}' has no phase '${phaseId}'.`);
  if (phase.status === 'approved') throw new SingularityFlowError(`Phase '${phaseId}' is approved; its outputs can no longer be changed.`);

  const available = availableInitiativeOutputs(portfolio, initiative, phaseId);
  const availableById = new Map(available.map((output) => [output.id, output]));
  const requested = [...new Set(includedIds ?? [])];
  const unknown = requested.filter((outputId) => !availableById.has(outputId));
  if (unknown.length) throw new SingularityFlowError(`Phase '${phaseId}' has no output ${unknown.map((value) => `'${value}'`).join(', ')}. Available: ${available.map((output) => output.id).join(', ')}.`);

  const mandatory = available.filter((output) => output.required !== false).map((output) => output.id);
  const dropped = mandatory.filter((outputId) => !requested.includes(outputId));
  if (dropped.length) throw new SingularityFlowError(`${dropped.map((value) => `'${value}'`).join(', ')} ${dropped.length === 1 ? 'is' : 'are'} required by profile '${initiative.resolution.profile}' and cannot be removed from this Epic.`);

  const authored = Object.values(phase.outputs ?? {}).filter((output) => output.sha256 && !requested.includes(output.id)).map((output) => output.id);
  if (authored.length) throw new SingularityFlowError(`${authored.map((value) => `'${value}'`).join(', ')} already ${authored.length === 1 ? 'has' : 'have'} content in this Epic. Remove the file through a governed change before dropping the output.`);

  const before = Object.keys(phase.outputs ?? {}).filter((outputId) => initiativeOutputRequired(initiative, phaseId, availableById.get(outputId) ?? { id: outputId }));
  const phaseDefinition = initiative.resolution.phases.find((item) => item.id === phaseId);
  const adopted = [];
  for (const outputId of requested) {
    const definition = availableById.get(outputId);
    if (!phaseDefinition.outputs.some((output) => output.id === outputId)) {
      const { pinned, ...pinnedDefinition } = definition;
      phaseDefinition.outputs.push(pinnedDefinition);
      if (definition.template) {
        const template = await secureRepositoryPath(root, path.join(portfolio.templatesRoot, definition.template), {
          label: `Initiative template for '${phaseId}/${outputId}'`,
          mustExist: true,
          type: 'file'
        });
        initiative.resolution.templates[outputKey(phaseId, outputId)] = { path: template.relative, ...(await snapshot(template.absolute)) };
      }
      adopted.push(outputId);
    }
    phase.outputs[outputId] ??= {
      id: outputId,
      label: definition.label,
      kind: definition.kind,
      path: posix(path.join('artifacts', phaseId, definition.path)),
      required: definition.required !== false,
      status: 'not_generated',
      generation: 0,
      sha256: null,
      bytes: 0,
      generatedBy: null,
      generatedAgent: null
    };
  }

  const actor = identity(root);
  phase.outputSelection = { included: requested, updatedAt: nowIso(), actor: actorKey(actor), reason: reason ?? null };
  initiative.history.push({
    at: nowIso(),
    actor: actorKey(actor),
    agent,
    event: 'initiative_outputs_selected',
    phase: phaseId,
    detail: `${before.join(', ') || 'none'} → ${requested.join(', ') || 'none'}${adopted.length ? ` (adopted ${adopted.join(', ')})` : ''}${reason ? `: ${reason}` : ''}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, phaseId, included: requested, adopted, before };
}

/**
 * Record whether an applicability policy applies to this initiative.
 *
 * A conditional checklist item — "security review completed when required by policy" — cannot be
 * judged from the artifacts alone; somebody has to say whether the control is in scope. Recording it
 * on the initiative makes the decision explicit and auditable rather than leaving the item to be
 * hand-waived with evidence, and lets the checklist resolve itself once the answer exists.
 */
export async function setInitiativeApplicability(root, initiativeId, policyId, applicable, { reason = null, agent = null } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  // The Epic's own pinned policies, so the question being answered is the one it started under.
  // Older Epics were pinned before policies were carried into the resolution, so they fall back.
  const declaredPolicies = initiative.resolution?.applicabilityPolicies ?? portfolio.applicabilityPolicies ?? {};
  const policy = declaredPolicies[policyId];
  if (!policy) {
    const declared = Object.keys(declaredPolicies);
    throw new SingularityFlowError(`Unknown applicability policy '${policyId}'.${declared.length ? ` Declared policies: ${declared.join(', ')}.` : ''}`);
  }
  if (typeof applicable !== 'boolean') throw new SingularityFlowError(`Applicability for '${policyId}' must be answered yes or no.`);
  const actor = identity(root);
  const previous = initiative.applicability?.[policyId] ?? null;
  initiative.applicability = {
    ...(initiative.applicability ?? {}),
    [policyId]: { applicable, reason: reason ?? null, actor: actorKey(actor), at: nowIso() }
  };
  initiative.history.push({
    at: nowIso(),
    actor: actorKey(actor),
    agent,
    event: 'initiative_applicability_set',
    phase: initiative.currentPhase,
    detail: `${policyId}: ${previous ? `${previous.applicable ? 'applicable' : 'not applicable'} → ` : ''}${applicable ? 'applicable' : 'not applicable'}${reason ? `: ${reason}` : ''}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, policyId, policy, applicable, previous };
}

/** Every declared policy with its answer, so a UI or the CLI can show what is still unanswered. */
export function initiativeApplicabilityState(portfolio, initiative) {
  const declared = initiative.resolution?.applicabilityPolicies ?? portfolio.applicabilityPolicies ?? {};
  return Object.entries(declared).map(([id, policy]) => {
    const answer = initiative.applicability?.[id] ?? null;
    return {
      id,
      label: policy.label,
      question: policy.question,
      answered: Boolean(answer),
      applicable: answer?.applicable ?? null,
      reason: answer?.reason ?? null,
      actor: answer?.actor ?? null,
      at: answer?.at ?? null
    };
  });
}

/**
 * Take an Epic back to its first phase without taking anything else with it.
 *
 * Starting over used to mean deleting the branch and starting a new Epic, which is a bigger
 * hammer than the job: it threw away the Jira identity and pinned sources. None of that is what
 * "start again" means. Restarting keeps the branch it is already on, keeps the identity and pinned
 * evidence, and touches nothing outside this Epic's own directory. Story-branch world models are
 * outside the Epic restart boundary.
 *
 * Two things it deliberately does not do. It does not erase history: the record of the first
 * attempt is the reason anyone can explain the second. And it does not reuse the old resolution —
 * the profile is resolved again from current configuration, which is what makes restarting the way
 * an Epic adopts a phase shape that has changed since it began.
 */
export async function restartInitiative(root, id = branch(root), { reason = null, agent = null } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, id);
  if (branch(root) !== id) throw new SingularityFlowError(`Current branch ${branch(root)} must be ${id} to restart it. Run singularity-flow initiative resume ${id} first.`);
  const resolved = resolveInitiativeProfile(portfolio, initiative.initiative.profile);
  await healInitiativeTemplates(root, portfolio);
  const resolution = await snapshotInitiativeResolution(root, portfolio, resolved);
  const definition = await loadDefinition(root);
  resolution.worldModelTiming = initiative.initiative.profile === 'epic-planning' ? 'story-intake' : 'initiative';
  resolution.worldModelGrounding = resolution.worldModelTiming === 'story-intake'
    ? 'off'
    : groundingMode(definition);
  resolution.worldModelOutputDir = definition.worldModel?.outputDir ?? 'singularity/world-model';
  resolution.ledger = normalizeLedgerConfig(definition.ledger ?? {});
  resolution.resolutionSha256 = createHash('sha256').update(JSON.stringify({
    profileResolutionSha256: resolution.resolutionSha256,
    worldModelTiming: resolution.worldModelTiming,
    worldModelGrounding: resolution.worldModelGrounding,
    worldModelOutputDir: resolution.worldModelOutputDir,
    ledger: resolution.ledger
  })).digest('hex');

  // Artifacts belong to the attempt being abandoned. Sources do not: they are pinned evidence
  // about the world, hashed and cited, and they are as true on the second attempt as the first.
  const artifactRoot = await secureInitiativePath(root, portfolio, id, 'artifacts', {
    label: `Initiative '${id}' artifacts`,
    type: 'directory'
  });
  const removed = [];
  if (artifactRoot.exists) {
    for (const entry of await readdir(artifactRoot.absolute, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) removed.push(posix(path.relative(artifactRoot.absolute, path.join(entry.parentPath ?? entry.path, entry.name))));
    }
    await rm(artifactRoot.absolute, { recursive: true, force: true });
  }

  const restartedAt = nowIso();
  const actor = identity(root);
  const phases = resolved.phases.map((phase, index) => phaseState(phase, index, restartedAt));
  const previous = { phase: initiative.currentPhase, status: initiative.status, generation: Object.values(initiative.phases).reduce((total, phase) => total + (phase.generation ?? 0), 0) };
  Object.assign(initiative, {
    resolution,
    status: 'in_progress',
    currentPhase: phases[0]?.id ?? null,
    phaseOrder: phases.map((phase) => phase.id),
    phases: Object.fromEntries(phases.map((phase) => [phase.id, phase])),
    materialization: { status: 'not_started', attempts: [] },
    childStories: {},
    contracts: {}
  });
  initiative.history.push({
    at: restartedAt,
    actor: actorKey(actor),
    agent,
    event: 'initiative_restarted',
    phase: phases[0]?.id ?? null,
    detail: `from ${previous.phase ?? 'complete'} (${previous.status}); ${removed.length} artifact${removed.length === 1 ? '' : 's'} discarded${reason ? `: ${reason}` : ''}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, removed, previous };
}

export async function prepareInitiativePhase(root, id = branch(root), requestedPhase = null, { agent = null } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, id);
  const phaseId = requestedPhase ?? initiative.currentPhase;
  if (!phaseId || phaseId !== initiative.currentPhase) throw new SingularityFlowError(`Current initiative phase is '${initiative.currentPhase ?? 'complete'}'; cannot prepare '${phaseId ?? 'none'}'.`);
  const phase = initiative.phases[phaseId];
  if (phase.status !== 'in_progress') throw new SingularityFlowError(`Initiative phase '${phaseId}' is ${phase.status}; preparation requires in_progress.`);
  await verifyInitiativePhaseInputs(root, portfolio, initiative, phaseId);
  // A template recorded at creation can be absent now (never installed, or deleted since). Restore
  // the packaged copy; the hash check below still rejects it if it differs from what was recorded.
  await healInitiativeTemplates(root, portfolio);
  const phaseDefinition = initiative.resolution.phases.find((item) => item.id === phaseId);
  const actor = identity(root);
  const prepared = [];
  for (const definition of phaseDefinition.outputs) {
    const output = phase.outputs[definition.id];
    let target = await secureInitiativePath(root, portfolio, id, output.path, {
      label: `Initiative output '${phaseId}/${output.id}'`,
      type: 'file'
    });
    const projectionMetadata = output.projectionMetadata
      ?? initiativeArtifactMetadata(initiative, phase, output, definition);
    // A generated output is rendered from committed state on every preparation, not filled in from
    // a blank template. Regenerating rather than preserving an edit is deliberate: the artifact is
    // a projection, and a hand-edit would be a claim that quietly disagrees with the data.
    if (definition.generator) {
      const content = await renderInitiativeGenerator(definition.generator, root, { initiative, phaseId, output: definition });
      await writeText(target.absolute, content);
      const current = await snapshot(target.absolute);
      Object.assign(output, {
        status: 'draft',
        generation: phase.generation + 1,
        sha256: current.sha256,
        bytes: current.size,
        generatedBy: actor,
        generatedAgent: agent ?? null
      });
      prepared.push({ id: output.id, path: target.relative, sha256: current.sha256, bytes: current.size, generated: definition.generator });
      continue;
    }
    if (!target.exists && !definition.template) {
      await mkdir(path.dirname(target.absolute), { recursive: true });
      Object.assign(output, {
        status: 'awaiting_upload',
        generation: phase.generation + 1,
        sha256: null,
        bytes: 0,
        generatedBy: null,
        generatedAgent: null
      });
      prepared.push({
        id: output.id,
        path: target.relative,
        sha256: null,
        bytes: 0,
        awaitingUpload: true
      });
      continue;
    }
    if (!target.exists) {
      const templateRecord = initiative.resolution.templates[outputKey(phaseId, output.id)];
      if (!templateRecord) {
        throw new SingularityFlowError(`Initiative output '${phaseId}/${output.id}' has no immutable template snapshot.`);
      }
      const template = await secureRepositoryPath(root, templateRecord.path, {
        label: `Initiative template for '${phaseId}/${output.id}'`,
        mustExist: true,
        type: 'file'
      });
      const currentTemplate = await snapshot(template.absolute);
      if (currentTemplate.sha256 !== templateRecord.sha256) {
        throw new SingularityFlowError(`Initiative template for '${phaseId}/${output.id}' changed after ${initiative.initiative.id} was created. Restore ${template.relative} to ${templateRecord.sha256} or start a new initiative.`);
      }
      let text = await readFile(template.absolute, 'utf8');
      const replacements = {
        '{{initiative.id}}': initiative.initiative.id,
        '{{workId}}': initiative.initiative.id,
        '{{initiative.title}}': initiative.initiative.title,
        '{{phase.id}}': phase.id,
        '{{phase.label}}': phase.label,
        '{{output.id}}': output.id,
        '{{output.label}}': output.label,
        '{{inputs}}': inputSummary(initiative, phaseDefinition, definition),
        '{{metadata}}': JSON.stringify(projectionMetadata, null, 2)
      };
      const unsupported = [...new Set(text.match(/\{\{[^{}\r\n]+\}\}/g) ?? [])]
        .filter((token) => !Object.hasOwn(replacements, token));
      if (unsupported.length) {
        throw new SingularityFlowError(
          `Initiative template for '${phaseId}/${output.id}' contains unsupported token(s): ${unsupported.join(', ')}. `
          + `Supported tokens: ${Object.keys(replacements).join(', ')}.`
        );
      }
      for (const [token, value] of Object.entries(replacements)) text = text.replaceAll(token, value ?? '');
      await writeText(target.absolute, text);
      target = await secureInitiativePath(root, portfolio, id, output.path, {
        label: `Initiative output '${phaseId}/${output.id}'`,
        mustExist: true,
        type: 'file'
      });
    }
    const current = await snapshot(target.absolute);
    const artifactText = await readFile(target.absolute, 'utf8');
    const tracksProjectionMetadata = Boolean(output.projectionMetadata)
      || /<!-- singularity-flow:initiative-metadata\n[\s\S]*?\n-->/.test(artifactText);
    Object.assign(output, {
      status: 'draft',
      generation: phase.generation + 1,
      sha256: current.sha256,
      bytes: current.size,
      generatedBy: actor,
      generatedAgent: agent,
      ...(tracksProjectionMetadata ? { projectionMetadata: structuredClone(projectionMetadata) } : {})
    });
    prepared.push({
      id: output.id,
      path: target.relative,
      sha256: current.sha256,
      bytes: current.size,
      awaitingUpload: false
    });
  }
  initiative.history.push({ at: nowIso(), actor: actorKey(actor), agent, event: 'initiative_phase_prepared', phase: phase.id, detail: `${prepared.length} outputs` });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, phase, outputs: prepared };
}

export async function listInitiatives(root, portfolio = null) {
  const definition = portfolio ?? await loadPortfolio(root, { required: false });
  if (!definition) return [];
  const base = await secureRepositoryPath(root, definition.initiativeRoot, {
    label: 'Initiative root',
    type: 'directory'
  });
  const results = new Map();
  const summarize = (state, fallbackId, source = 'working-tree') => {
    const phases = Array.isArray(state.phaseOrder)
      ? state.phaseOrder.map((phaseId) => state.phases?.[phaseId]).filter(Boolean)
      : [];
    const approved = phases.filter((phase) => phase.status === 'approved').length;
    const currentPhase = state.phases?.[state.currentPhase] ?? null;
    const lastEvent = state.history?.at(-1) ?? null;
    const waitingSince = currentPhase?.submittedAt ?? currentPhase?.startedAt ?? lastEvent?.at ?? state.initiative?.createdAt ?? null;
    return {
      id: state.initiative?.id ?? fallbackId,
      title: state.initiative?.title ?? fallbackId,
      profile: state.initiative?.profile ?? null,
      profileLabel: state.initiative?.profileLabel ?? state.initiative?.profile ?? null,
      idAuthority: state.lineage?.idAuthority ?? state.resolution?.identity?.authority ?? 'local',
      status: state.status ?? 'unknown',
      currentPhase: state.currentPhase ?? null,
      currentPhaseLabel: currentPhase?.label ?? state.currentPhase ?? null,
      currentPhaseStatus: currentPhase?.status ?? null,
      percentage: phases.length ? Math.round((approved / phases.length) * 100) : 100,
      phasesApproved: approved,
      phasesTotal: phases.length,
      waitingSince,
      lastActor: lastEvent?.actor ?? null,
      lastEvent: lastEvent?.event ?? null,
      branch: state.initiative?.branch ?? fallbackId,
      updatedAt: lastEvent?.at ?? state.initiative?.createdAt ?? null,
      // What this Epic pinned when it started. An Epic validates against the exact bytes it was
      // resolved from, so editing one of these files does not change the Epic — it stops it, with a
      // message about a template hash. Carried here so a surface that offers such an edit can say
      // which Epics it would stop, before rather than after.
      resolutionSha256: state.resolution?.resolutionSha256 ?? null,
      portfolioSha256: state.resolution?.portfolioSha256 ?? null,
      pinnedTemplates: [...new Map(Object.values(state.resolution?.templates ?? {})
        .filter((entry) => entry?.path)
        .map((entry) => [entry.path, { path: entry.path, sha256: entry.sha256 ?? null }])).values()],
      source
    };
  };
  const localEntries = base.exists ? await readdir(base.absolute, { withFileTypes: true }) : [];
  for (const entry of localEntries) {
    if (!entry.isDirectory()) continue;
    try {
      const statePath = await secureInitiativePath(root, definition, entry.name, 'state.json', {
        label: `Initiative '${entry.name}' state`,
        mustExist: true,
        type: 'file'
      });
      const state = await readJson(statePath.absolute);
      results.set(state.initiative?.id ?? entry.name, summarize(state, entry.name));
    } catch (error) {
      results.set(entry.name, { id: entry.name, title: entry.name, status: 'invalid', error: error.message });
    }
  }
  const remote = definition.git?.remote ?? 'origin';
  // Local branches as well as remote ones. An Epic whose push failed exists on exactly one branch
  // and nowhere else, so from any other branch it vanished from this list entirely — while
  // `initiative start` still refused to create it, leaving the Epic unreachable from the app.
  // Remote first, so a branch that exists in both places is reported as the shared copy it is;
  // a local branch only wins when its state is strictly newer, or when there is no remote one.
  const branches = [
    ...remoteBranches(root, remote).map((name) => ({ name, ref: `${remote}/${name}`, source: `${remote}/${name}` })),
    ...localBranches(root).map((name) => ({ name, ref: name, source: `local/${name}` }))
  ];
  for (const { name, ref, source } of branches) {
    try { validateInitiativeId(name); } catch { continue; }
    const statePath = posix(path.join(definition.initiativeRoot, name, 'state.json'));
    const content = fileAtRef(root, ref, statePath);
    if (!content) continue;
    try {
      const state = JSON.parse(content);
      if (state.initiative?.id !== name || state.initiative?.branch !== name) continue;
      const candidate = summarize(state, name, source);
      const current = results.get(name);
      if (!current || String(candidate.updatedAt ?? '') > String(current.updatedAt ?? '')) results.set(name, candidate);
    } catch {
      // Invalid branches are surfaced only when selected; one malformed branch must not hide
      // healthy Epics from the business home.
    }
  }
  return [...results.values()].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
}

export function initiativeProgress(initiative) {
  const phases = initiative.phaseOrder.map((id) => initiative.phases[id]);
  const approved = phases.filter((phase) => phase.status === 'approved').length;
  return {
    id: initiative.initiative.id,
    title: initiative.initiative.title,
    profile: initiative.initiative.profile,
    status: initiative.status,
    currentPhase: initiative.currentPhase,
    percentage: phases.length ? Math.round((approved / phases.length) * 100) : 100,
    phases: phases.map((phase) => ({
      id: phase.id,
      label: phase.label,
      status: phase.status,
      generation: phase.generation,
      outputs: Object.values(phase.outputs).length,
      generatedOutputs: Object.values(phase.outputs).filter((output) => output.status !== 'not_generated').length,
      checklist: Object.values(phase.checklist).length
    }))
  };
}

export function initiativeDefinitionHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function commitInitiativeChange(root, portfolio, initiative, event, message, {
  extraPaths = [],
  appendOnly = false,
  beforeStateWrite = null,
  eventFromResult = null,
  transactionId = null,
  rollbackInitiative = null,
  recoveryPreimage = null
} = {}) {
  if (branch(root) !== initiative.initiative.branch) throw new SingularityFlowError(`Current branch ${branch(root)} must match initiative branch ${initiative.initiative.branch}.`);
  const pending = await readPendingPublication(root, {
    kind: 'initiative',
    id: initiative.initiative.id,
    legacyPath: legacyInitiativePendingPublicationPath(root, portfolio, initiative.initiative.id)
  });
  if (pending) throw new SingularityFlowError('Initiative publication is pending. Run singularity-flow initiative sync before another mutation.');
  const ledgerConfig = normalizeLedgerConfig(initiative.resolution?.ledger ?? {});
  const requestedPhaseId = event?.phaseId ?? initiative.currentPhase ?? null;
  const envelope = lifecycleEvent({
    ...event,
    subject: { kind: 'initiative', id: initiative.initiative.id, branch: initiative.initiative.branch },
    phaseId: requestedPhaseId,
    generation: event?.generation ?? (requestedPhaseId ? initiative.phases?.[requestedPhaseId]?.generation ?? null : null),
    actor: event?.actor ?? identity(root)
  });
  let ledgerIntent = null;
  if (ledgerConfig.enabled) {
    ledgerIntent = createLedgerIntent({
      eventId: envelope.eventId,
      eventType: envelope.type,
      capabilityId: initiative.resolution?.capability?.id ?? `initiative-${initiative.initiative.id}`,
      subject: {
        workId: initiative.initiative.id,
        profile: initiative.initiative.profile,
        phase: envelope.phaseId,
        generation: envelope.generation,
        branch: initiative.initiative.branch
      },
      actor: envelope.actor,
      agent: envelope.agent,
      authorityGroup: envelope.authorityGroup,
      payload: {
        lifecycleEventId: envelope.eventId,
        lifecyclePayload: envelope.payload,
        configPath: 'singularity/portfolio.yml',
        configSha256: initiative.resolution?.portfolioSha256 ?? null,
        resolutionSha256: initiative.resolution?.resolutionSha256 ?? null,
        capabilityMapSha256: initiative.resolution?.capability?.map?.sha256 ?? null,
        capabilityPolicy: initiative.resolution?.capability?.policy ?? null
      }
    });
  }
  const mode = initiativePublicationMode(portfolio, initiative);
  const remote = portfolio.git?.remote ?? 'origin';
  // The transition may update source manifests, prompt-composition records, detach decisions and
  // projections as well as state.json. Capture the complete governed Initiative directory so a
  // pre-commit failure cannot leave any part of an unpublished decision behind.
  void rollbackInitiative;
  const initiativeDirectory = initiativeRelative(portfolio, initiative.initiative.id);
  const result = await publishLifecycleChange(root, {
    subject: envelope.subject,
    expectedRevision: initiative[Symbol.for('singularity-flow.state-revision')] ?? null,
    allowedPaths: [initiativeDirectory, ...extraPaths, ...claimHealedTemplatePaths(root, portfolio.templatesRoot)],
    event: envelope,
    commit: { message },
    state: {
      // saveInitiative revalidates the runtime aggregate and regenerates STATUS.md,
      // so the authoritative state and its projection enter the commit together.
      write: async (publicationEvent) => {
        const transitionResult = beforeStateWrite ? await beforeStateWrite() : undefined;
        if (eventFromResult) {
          const derived = await eventFromResult(transitionResult, initiative, publicationEvent);
          if (derived) {
            const finalized = lifecycleEvent({
              ...publicationEvent,
              ...derived,
              subject: publicationEvent.subject,
              payload: { ...(publicationEvent.payload ?? {}), ...(derived.payload ?? {}) }
            });
            Object.assign(publicationEvent, finalized, {
              eventId: publicationEvent.eventId,
              createdAt: publicationEvent.createdAt
            });
            if (ledgerIntent) {
              ledgerIntent.eventType = publicationEvent.type;
              ledgerIntent.subject.phase = publicationEvent.phaseId;
              ledgerIntent.subject.generation = publicationEvent.generation;
              ledgerIntent.actor = {
                name: publicationEvent.actor?.name ?? null,
                email: publicationEvent.actor?.email ?? null,
                githubLogin: publicationEvent.actor?.login ?? publicationEvent.actor?.githubLogin ?? null,
                identityAssurance: derived.identityAssurance
                  ?? ledgerIntent.actor?.identityAssurance
                  ?? 'unavailable'
              };
              ledgerIntent.agent = publicationEvent.agent;
              ledgerIntent.authorityGroup = publicationEvent.authorityGroup;
              ledgerIntent.payload = {
                ...(ledgerIntent.payload ?? {}),
                lifecyclePayload: publicationEvent.payload,
                lifecycleEvent: publicationEvent
              };
            }
          }
        }
        recordPublicationProjection(initiative, publicationEvent, ledgerIntent);
        await saveInitiative(root, portfolio, initiative);
        return { event: publicationEvent, transitionResult };
      },
      // Restore the complete governed Initiative directory: a publication that fails after any
      // manifest, context, decision, projection, or state write must leave no unpublished change.
      rollback: (preimage, recoveryOptions = {}) => restorePublicationPreimage(root, preimage, {
        subject: envelope.subject,
        ...recoveryOptions
      })
    },
    publication: { mode, remote, branch: initiative.initiative.branch },
    pendingRecord: () => ({ initiativeId: initiative.initiative.id, appendOnly }),
    ledger: { config: ledgerConfig, intent: ledgerIntent, intentDirectory: initiativeRelative(portfolio, initiative.initiative.id) },
    conflictStrategy: appendOnly ? async ({ sourceCommit }) => {
      const rebased = await replayAppendOnlyCommit(root, portfolio, initiative, remote, sourceCommit);
      if (rebased.status !== 0) return { result: rebased, replayed: false, publishedCommit: sourceCommit };
      const pushed = pushBranch(root, remote, initiative.initiative.branch);
      return { result: pushed, replayed: pushed.status === 0, publishedCommit: head(root) };
    } : null,
    recoveryPreimage,
    transactionId
  });
  if (initiative[Symbol.for('singularity-flow.state-revision')]) {
    initiative[Symbol.for('singularity-flow.state-revision')].head = result.sha;
  }
  if (result.pushed) await clearPendingPublication(root, {
    kind: 'initiative', id: initiative.initiative.id,
    legacyPath: legacyInitiativePendingPublicationPath(root, portfolio, initiative.initiative.id)
  });
  return result;
}

export async function syncInitiativePublication(root, portfolio, initiative) {
  const pending = await readPendingPublication(root, {
    kind: 'initiative',
    id: initiative.initiative.id,
    legacyPath: legacyInitiativePendingPublicationPath(root, portfolio, initiative.initiative.id)
  });
  if (!pending) {
    return { pending: false, pushed: null, ledger: await reconcileLedger(root, initiative.resolution?.ledger ?? {}, { workId: initiative.initiative.id }) };
  }
  const record = pending.record;
  if (record.recoveryStage === 'publication-recovery-diverged') {
    throw new SingularityFlowError(
      `Initiative '${initiative.initiative.id}' recovery diverged and was stopped safely. ${record.error} `
      + 'Run singularity-flow doctor for the exact journal/branch diagnosis; no commit was pushed.',
      { code: 'PUBLICATION_RECOVERY_DIVERGED', details: record }
    );
  }
  if (record.recoveryStage === 'interrupted-before-branch-ref-advanced') {
    const liveOwner = livePreparedPublicationOwner(pending, root);
    if (liveOwner) {
      throw new SingularityFlowError(
        `Initiative '${initiative.initiative.id}' has an active governed publication command (PID ${liveOwner.pid}`
        + `${liveOwner.createdAt ? `, started ${liveOwner.createdAt}` : ''}). `
        + 'Return to that terminal and complete or interrupt the command; do not start another mutation. '
        + 'After interrupting it, run singularity-flow initiative sync again.'
      );
    }
    const recovery = await recoverPreparedPublication(root, pending);
    if (recovery) {
      return {
        pending: false,
        pushed: null,
        remote: record.remote,
        branch: record.branch,
        recoveredPrepared: true,
        restoredPrepared: recovery.restored,
        rescuePath: recovery.rescuePath,
        ledger: await reconcileLedger(root, initiative.resolution?.ledger ?? {}, { workId: initiative.initiative.id })
      };
    }
    throw new SingularityFlowError(
      `Initiative '${initiative.initiative.id}' was interrupted before its governed commit completed. `
      + 'Inspect the working tree, run singularity-flow doctor, and repair or discard the partial local state before retrying.'
    );
  }
  const result = record.commit
    ? pushCommitToBranch(root, record.remote, record.commit, record.branch)
    : pushBranch(root, record.remote, record.branch);
  if (result.status !== 0) throw new SingularityFlowError(`Initiative push still fails: ${(result.stderr || result.stdout).trim()}`);
  await clearPendingPublication(root, {
    kind: 'initiative',
    id: initiative.initiative.id,
    legacyPath: legacyInitiativePendingPublicationPath(root, portfolio, initiative.initiative.id)
  });
  return {
    pending: false,
    pushed: record.commit ?? head(root),
    remote: record.remote,
    branch: record.branch,
    ledger: await reconcileLedger(root, initiative.resolution?.ledger ?? {}, { workId: initiative.initiative.id })
  };
}
