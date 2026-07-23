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
  SingularityFlowError, exists, nowIso, posix, readJson, run, snapshot, writeJson, writeText
} from './util.mjs';

function actorKey(actor) { return actor.email?.toLowerCase() ?? actor.name; }

export function validateInitiativeId(id) {
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new SingularityFlowError('Initiative ID must be one safe identifier without slashes.');
  return id;
}

export function initiativeDir(root, portfolio, id) {
  return path.join(root, portfolio.initiativeRoot ?? '.singularity/initiatives', validateInitiativeId(id));
}

export function initiativeRelative(portfolio, id) {
  return posix(path.join(portfolio.initiativeRoot ?? '.singularity/initiatives', validateInitiativeId(id)));
}

export function initiativeStatePath(root, portfolio, id) {
  return path.join(initiativeDir(root, portfolio, id), 'state.json');
}

export function initiativePendingPublicationPath(root, portfolio, id) {
  return path.join(initiativeDir(root, portfolio, id), 'publication-pending.json');
}

function outputKey(phaseId, outputId) { return `${phaseId}/${outputId}`; }

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
  if (missing.length) throw new SingularityFlowError(`Initiative approval authorities require at least one local Git identity before start: ${missing.join(', ')}. Configure approvalAuthorities in .singularity/portfolio.yml.`);
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
  const directory = initiativeDir(root, portfolio, initiative.initiative.id);
  await writeJson(path.join(directory, 'state.json'), initiative);
  await writeText(path.join(directory, 'STATUS.md'), statusMarkdown(initiative));
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
  const stateFile = initiativeStatePath(root, portfolio, id);
  if (await exists(stateFile)) throw new SingularityFlowError(`${id} already exists. Use singularity-flow initiative resume ${id}.`);
  const resolved = resolveInitiativeProfile(portfolio, profile);
  assertAuthorityMembership(resolved);
  const resolution = await snapshotInitiativeResolution(root, portfolio, resolved);
  resolution.worldModelGrounding = groundingMode(definition);
  resolution.worldModelOutputDir = definition.worldModel?.outputDir ?? '.singularity/world-model';
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
  const directory = initiativeDir(root, portfolio, id);
  await mkdir(directory, { recursive: true });
  await writeText(path.join(directory, 'definition.yml'), YAML.stringify({
    version: 1,
    initiative: initiative.initiative,
    resolution: {
      profile: resolution.profile,
      portfolioSha256: resolution.portfolioSha256,
      resolutionSha256: resolution.resolutionSha256
    }
  }));
  await writeText(path.join(directory, 'breakdown.yml'), YAML.stringify({ version: 1, initiativeId: id, epics: [] }));
  await writeText(path.join(directory, 'repositories.lock.yml'), YAML.stringify({
    version: 1,
    initiativeId: id,
    repositories: Object.fromEntries(Object.entries(resolution.repositories).map(([repositoryId, repository]) => [repositoryId, {
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      required: repository.required,
      observedHead: null,
      observedAt: null
    }]))
  }));
  await writeText(path.join(directory, 'README.md'), `# ${id} — ${initiative.initiative.title}\n\nDurable initiative orchestration state for branch \`${id}\`.\n\n- [state.json](./state.json) — immutable profile resolution and lifecycle state\n- [STATUS.md](./STATUS.md) — human-readable progress\n- [breakdown.yml](./breakdown.yml) — Epic and repository-story plan\n- [repositories.lock.yml](./repositories.lock.yml) — observed repository heads\n- [artifacts/](./artifacts/) — governed phase outputs\n- [evidence/records/](./evidence/records/) — append-only evidence\n- [approvals/records/](./approvals/records/) — append-only decisions\n- [invalidations/records/](./invalidations/records/) — dependency-cone invalidations\n- [contracts/](./contracts/) — versioned cross-repository contracts\n`);
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative };
}

export async function loadInitiative(root, id = branch(root), portfolio = null) {
  const definition = portfolio ?? await loadPortfolio(root);
  const file = initiativeStatePath(root, definition, id);
  if (!(await exists(file))) throw new SingularityFlowError(`No initiative found for ${id}. Expected ${posix(path.relative(root, file))}.`);
  const initiative = await readJson(file);
  if (initiative.schemaVersion !== 1 || initiative.initiative?.id !== id) throw new SingularityFlowError(`Invalid initiative state for ${id}.`);
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
      const absolute = path.join(initiativeDir(root, portfolio, initiative.initiative.id), producerOutput.path);
      const current = await snapshot(absolute);
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
    const target = path.join(initiativeDir(root, portfolio, id), output.path);
    if (!(await exists(target))) {
      const templateRecord = initiative.resolution.templates[outputKey(phaseId, output.id)];
      let text = await readFile(path.join(root, templateRecord.path), 'utf8');
      const replacements = {
        '{{initiative.id}}': initiative.initiative.id,
        '{{initiative.title}}': initiative.initiative.title,
        '{{phase.id}}': phase.id,
        '{{phase.label}}': phase.label,
        '{{output.id}}': output.id,
        '{{output.label}}': output.label,
        '{{inputs}}': inputSummary(initiative, phaseDefinition, definition),
        '{{metadata}}': metadata(initiative, phase, output, definition)
      };
      for (const [token, value] of Object.entries(replacements)) text = text.replaceAll(token, value ?? '');
      await writeText(target, text);
    }
    const current = await snapshot(target);
    Object.assign(output, {
      status: 'draft',
      generation: phase.generation + 1,
      sha256: current.sha256,
      bytes: current.size,
      generatedBy: actor,
      generatedPersona: persona
    });
    prepared.push({ id: output.id, path: posix(path.relative(root, target)), sha256: current.sha256, bytes: current.size });
  }
  initiative.history.push({ at: nowIso(), actor: actorKey(actor), persona, event: 'initiative_phase_prepared', phase: phase.id, detail: `${prepared.length} outputs` });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, phase, outputs: prepared };
}

export async function listInitiatives(root, portfolio = null) {
  const definition = portfolio ?? await loadPortfolio(root, { required: false });
  if (!definition) return [];
  const base = path.join(root, definition.initiativeRoot);
  if (!(await exists(base))) return [];
  const results = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const state = await readJson(path.join(base, entry.name, 'state.json'));
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
  const pending = initiativePendingPublicationPath(root, portfolio, initiative.initiative.id);
  if (await exists(pending)) throw new SingularityFlowError('Initiative publication is pending. Run singularity-flow initiative sync before another mutation.');
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
    await writeJson(pending, {
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
  const pending = initiativePendingPublicationPath(root, portfolio, initiative.initiative.id);
  if (!(await exists(pending))) return { pending: false, pushed: null };
  const record = await readJson(pending);
  const result = pushBranch(root, record.remote, record.branch);
  if (result.status !== 0) throw new SingularityFlowError(`Initiative push still fails: ${(result.stderr || result.stdout).trim()}`);
  await unlink(pending);
  return { pending: false, pushed: head(root), remote: record.remote, branch: record.branch };
}
