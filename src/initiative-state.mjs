import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { add, branch, commit, head, identity, pushBranch } from './git.mjs';
import {
  loadPortfolio, resolveInitiativeProfile, snapshotInitiativeResolution,
  validatePortfolioWorldModelViews
} from './initiative-config.mjs';
import { loadDefinition } from './config.mjs';
import { groundingMode } from './grounding.mjs';
import {
  secureRepositoryPath, SingularityFlowError, nowIso, posix, readJson, run, snapshot, writeJson, writeText
} from './util.mjs';

function actorKey(actor) { return actor.email?.toLowerCase() ?? actor.name; }

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
  persona = null
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
  const resolved = resolveInitiativeProfile(portfolio, profile);
  assertAuthorityMembership(resolved);
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
      resolutionSha256: resolution.resolutionSha256
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

export async function prepareInitiativePhase(root, id = branch(root), requestedPhase = null, { persona = null } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, id);
  const phaseId = requestedPhase ?? initiative.currentPhase;
  if (!phaseId || phaseId !== initiative.currentPhase) throw new SingularityFlowError(`Current initiative phase is '${initiative.currentPhase ?? 'complete'}'; cannot prepare '${phaseId ?? 'none'}'.`);
  const phase = initiative.phases[phaseId];
  if (phase.status !== 'in_progress') throw new SingularityFlowError(`Initiative phase '${phaseId}' is ${phase.status}; preparation requires in_progress.`);
  await verifyInitiativePhaseInputs(root, portfolio, initiative, phaseId);
  const phaseDefinition = initiative.resolution.phases.find((item) => item.id === phaseId);
  const actor = identity(root);
  const prepared = [];
  for (const definition of phaseDefinition.outputs) {
    const output = phase.outputs[definition.id];
    let target = await secureInitiativePath(root, portfolio, id, output.path, {
      label: `Initiative output '${phaseId}/${output.id}'`,
      type: 'file'
    });
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
  if (!base.exists) return [];
  const results = [];
  for (const entry of await readdir(base.absolute, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const statePath = await secureInitiativePath(root, definition, entry.name, 'state.json', {
        label: `Initiative '${entry.name}' state`,
        mustExist: true,
        type: 'file'
      });
      const state = await readJson(statePath.absolute);
      results.push({
        id: state.initiative?.id ?? entry.name,
        title: state.initiative?.title ?? entry.name,
        profile: state.initiative?.profile ?? null,
        status: state.status ?? 'unknown',
        currentPhase: state.currentPhase ?? null,
        branch: state.initiative?.branch ?? entry.name,
        updatedAt: state.history?.at(-1)?.at ?? state.initiative?.createdAt ?? null
      });
    } catch (error) {
      results.push({ id: entry.name, title: entry.name, status: 'invalid', error: error.message });
    }
  }
  return results.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
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
