import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { add, branch, commit, fileAtRef, head, identity, localBranches, pushBranch, remoteBranches } from './git.mjs';
import {
  loadPortfolio, resolveInitiativeProfile, snapshotInitiativeResolution,
  validatePortfolioWorldModelViews
} from './initiative-config.mjs';
import { ensureRepositoryTemplates, loadDefinition } from './config.mjs';
import { renderInitiativeGenerator } from './initiative-generators.mjs';
import { initiativeOutputRequired } from './initiative-policy.mjs';
import { groundingMode } from './grounding.mjs';
import {
  secureRepositoryPath, SingularityFlowError, nowIso, posix, readJson, run, snapshot, writeJson, writeText
} from './util.mjs';

function actorKey(actor) { return actor.email?.toLowerCase() ?? actor.name; }

// Restore any packaged initiative template the repository is missing, into the portfolio's own
// templatesRoot — the root the resolver and the recorded snapshot paths both read, and which the
// workflow definition may configure differently. Repositories initialized before the initiatives/
// subtree shipped have none of it, so every referenced template would otherwise abort the phase.
// Installed files are staged because commitInitiativeChange stages only the initiative directory;
// leaving them unstaged makes the next command fail on an unclean tree.
async function healInitiativeTemplates(root, portfolio) {
  const installed = await ensureRepositoryTemplates(root, null, { templatesRoot: portfolio.templatesRoot });
  if (installed.length) {
    add(root, installed.map((relative) => posix(path.join(portfolio.templatesRoot, relative))));
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
  if (initiative?.schemaVersion !== 1 || initiative?.initiative?.id !== expectedId) {
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
      generatedPersona: null
    }])),
    checklist: Object.fromEntries(phase.checklist.map((check) => [check.id, {
      id: check.id,
      label: check.label,
      requirement: check.requirement,
      status: check.requirement === 'optional' ? 'optional' : 'missing'
    }]))
  };
}

function statusMarkdown(initiative) {
  const lines = [
    `# ${initiative.initiative.id} — ${initiative.initiative.title}`, '',
    `- Profile: **${initiative.initiative.profileLabel}**`,
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
  for (const event of initiative.history.slice(-20).reverse()) lines.push(`- ${event.at} — **${event.event}**${event.phase ? ` (${event.phase})` : ''} by ${event.actor ?? 'unknown'}${event.persona ? ` as ${event.persona}` : ''}${event.detail ? `: ${event.detail}` : ''}`);
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
  await writeText(status.absolute, statusMarkdown(initiative));
}

export async function createInitiative(root, {
  id,
  title,
  profile,
  source = { type: 'manual' },
  persona = null,
  idAuthority = null
} = {}) {
  validateInitiativeId(id);
  const portfolio = await loadPortfolio(root);
  const definition = await loadDefinition(root);
  validatePortfolioWorldModelViews(portfolio, definition);
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
  const resolved = resolveInitiativeProfile(portfolio, profile, { idAuthority });
  assertAuthorityMembership(resolved);
  await healInitiativeTemplates(root, portfolio);
  const resolution = await snapshotInitiativeResolution(root, portfolio, resolved);
  resolution.worldModelGrounding = groundingMode(definition);
  resolution.worldModelOutputDir = definition.worldModel?.outputDir ?? 'singularity/world-model';
  resolution.resolutionSha256 = createHash('sha256').update(JSON.stringify({
    profileResolutionSha256: resolution.resolutionSha256,
    worldModelGrounding: resolution.worldModelGrounding,
    worldModelOutputDir: resolution.worldModelOutputDir
  })).digest('hex');
  const actor = identity(root);
  if (!actor.email) throw new SingularityFlowError('Initiative governance requires a local Git email. Configure user.email before starting.');
  const createdAt = nowIso();
  const phases = resolved.phases.map((phase, index) => phaseState(phase, index, createdAt));
  const initiative = {
    schemaVersion: 1,
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
    currentPhase: phases[0]?.id ?? null,
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
      persona,
      event: 'initiative_started',
      phase: phases[0]?.id ?? null,
      detail: `Created ${resolved.id} initiative`
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
      idAuthority: resolution.identity.authority
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

export async function loadInitiative(root, id = branch(root), portfolio = null) {
  const definition = portfolio ?? await loadPortfolio(root);
  const file = await secureInitiativePath(root, definition, id, 'state.json', {
    label: `Initiative '${id}' state`
  });
  if (!file.exists) throw new SingularityFlowError(`No initiative found for ${id}. Expected ${file.relative}.`);
  if (!file.entry.isFile()) throw new SingularityFlowError(`Initiative '${id}' state must be a regular file: ${file.relative}`);
  const initiative = validateInitiativeRuntimeState(await readJson(file.absolute), id);
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

function metadata(initiative, phase, output, definition) {
  return JSON.stringify({
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
  }, null, 2);
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
export async function selectInitiativePhaseOutputs(root, id, phaseId, includedIds, { reason = null, persona = null } = {}) {
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
      generatedPersona: null
    };
  }

  const actor = identity(root);
  phase.outputSelection = { included: requested, updatedAt: nowIso(), actor: actorKey(actor), reason: reason ?? null };
  initiative.history.push({
    at: nowIso(),
    actor: actorKey(actor),
    persona,
    event: 'initiative_outputs_selected',
    phase: phaseId,
    detail: `${before.join(', ') || 'none'} → ${requested.join(', ') || 'none'}${adopted.length ? ` (adopted ${adopted.join(', ')})` : ''}${reason ? `: ${reason}` : ''}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, phaseId, included: requested, adopted, before };
}

export async function prepareInitiativePhase(root, id = branch(root), requestedPhase = null, { persona = null } = {}) {
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
        generatedPersona: persona ?? null
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
        generatedPersona: null
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
        '{{metadata}}': metadata(initiative, phase, output, definition)
      };
      for (const [token, value] of Object.entries(replacements)) text = text.replaceAll(token, value ?? '');
      await writeText(target.absolute, text);
      target = await secureInitiativePath(root, portfolio, id, output.path, {
        label: `Initiative output '${phaseId}/${output.id}'`,
        mustExist: true,
        type: 'file'
      });
    }
    const current = await snapshot(target.absolute);
    Object.assign(output, {
      status: 'draft',
      generation: phase.generation + 1,
      sha256: current.sha256,
      bytes: current.size,
      generatedBy: actor,
      generatedPersona: persona
    });
    prepared.push({
      id: output.id,
      path: target.relative,
      sha256: current.sha256,
      bytes: current.size,
      awaitingUpload: false
    });
  }
  initiative.history.push({ at: nowIso(), actor: actorKey(actor), persona, event: 'initiative_phase_prepared', phase: phase.id, detail: `${prepared.length} outputs` });
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

export async function commitInitiativeChange(root, portfolio, initiative, message, {
  extraPaths = [],
  appendOnly = false
} = {}) {
  if (branch(root) !== initiative.initiative.branch) throw new SingularityFlowError(`Current branch ${branch(root)} must match initiative branch ${initiative.initiative.branch}.`);
  const pending = await secureInitiativePath(root, portfolio, initiative.initiative.id, 'publication-pending.json', {
    label: `Initiative '${initiative.initiative.id}' pending publication`
  });
  if (pending.exists) throw new SingularityFlowError('Initiative publication is pending. Run singularity-flow initiative sync before another mutation.');
  add(root, [...new Set([initiativeRelative(portfolio, initiative.initiative.id), ...extraPaths])]);
  const sha = commit(root, message);
  const mode = portfolio.git?.publish ?? 'required';
  if (mode === 'off') return { sha, pushed: false, replayed: false };
  const remote = portfolio.git?.remote ?? 'origin';
  let pushed = pushBranch(root, remote, initiative.initiative.branch);
  let replayed = false;
  if (pushed.status !== 0 && appendOnly) {
    const rebased = run('git', ['pull', '--rebase', remote, initiative.initiative.branch], { cwd: root, allowFailure: true });
    if (rebased.status === 0) {
      replayed = true;
      pushed = pushBranch(root, remote, initiative.initiative.branch);
    }
  }
  if (pushed.status !== 0) {
    await writeJson(pending.absolute, {
      schemaVersion: 1,
      initiativeId: initiative.initiative.id,
      branch: initiative.initiative.branch,
      remote,
      commit: sha,
      appendOnly,
      createdAt: nowIso(),
      error: (pushed.stderr || pushed.stdout).trim()
    });
    throw new SingularityFlowError(`Initiative commit ${sha.slice(0, 8)} was retained locally but push failed. Run singularity-flow initiative sync after fixing remote access.`);
  }
  return { sha: branch(root) === initiative.initiative.branch ? head(root) : sha, pushed: true, replayed };
}

export async function syncInitiativePublication(root, portfolio, initiative) {
  const pending = await secureInitiativePath(root, portfolio, initiative.initiative.id, 'publication-pending.json', {
    label: `Initiative '${initiative.initiative.id}' pending publication`
  });
  if (!pending.exists) return { pending: false, pushed: null };
  if (!pending.entry.isFile()) throw new SingularityFlowError(`Initiative publication record must be a regular file: ${pending.relative}`);
  const record = await readJson(pending.absolute);
  const result = pushBranch(root, record.remote, record.branch);
  if (result.status !== 0) throw new SingularityFlowError(`Initiative push still fails: ${(result.stderr || result.stdout).trim()}`);
  await unlink(pending.absolute);
  return { pending: false, pushed: head(root), remote: record.remote, branch: record.branch };
}
