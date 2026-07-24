import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { gitDir, head, identity } from './git.mjs';
import { findOrCreateIssue } from './jira.mjs';
import {
  loadInitiative, saveInitiative, secureInitiativePath
} from './initiative-state.mjs';
import {
  initiativeNode, invalidateInitiativeCone
} from './initiative-graph.mjs';
export { initiativeMilestoneReadiness } from './initiative-milestones.mjs';
import {
  secureRepositoryPath, SingularityFlowError, ensureDir, exists, nowIso, posix, run, writeJson, writeText
} from './util.mjs';

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new SingularityFlowError(`${label} must be a safe identifier.`);
  return value;
}

function textList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new SingularityFlowError(`${label} must be an array of non-empty strings.`);
  return value.map((item) => item.trim());
}

function normalizeDependency(value, storyId) {
  const dependency = typeof value === 'string' ? { story: value } : structuredClone(value);
  if (!dependency || typeof dependency !== 'object') throw new SingularityFlowError(`Story '${storyId}' dependency is invalid.`);
  safeId(dependency.story, `Story '${storyId}' dependency`);
  return { story: dependency.story, requiredPhase: dependency.requiredPhase ?? 'implementation-spec' };
}

function normalizeContract(value, storyId) {
  const contract = typeof value === 'string' ? { id: value } : structuredClone(value);
  if (!contract || typeof contract !== 'object') throw new SingularityFlowError(`Story '${storyId}' contract reference is invalid.`);
  safeId(contract.id, `Story '${storyId}' contract ID`);
  return { id: contract.id, version: contract.version == null ? null : String(contract.version), sha256: contract.sha256 ?? null };
}

export function validateInitiativeBreakdown(value, portfolio) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('Initiative breakdown must be an object.');
  if (![1, 2].includes(value.version)) throw new SingularityFlowError('Initiative breakdown version must be 1 or 2.');
  if (!Array.isArray(value.epics)) throw new SingularityFlowError('Initiative breakdown epics must be an array.');
  const epics = [];
  const stories = [];
  for (const [epicIndex, rawEpic] of value.epics.entries()) {
    if (!rawEpic || typeof rawEpic !== 'object') throw new SingularityFlowError(`Epic ${epicIndex + 1} must be an object.`);
    const epicId = safeId(rawEpic.planId ?? rawEpic.id, `Epic ${epicIndex + 1} ID`);
    if (!Array.isArray(rawEpic.stories)) throw new SingularityFlowError(`Epic '${epicId}' stories must be an array.`);
    if (rawEpic.description != null && typeof rawEpic.description !== 'string') throw new SingularityFlowError(`Epic '${epicId}' description must be text.`);
    const epic = {
      id: epicId,
      planId: epicId,
      title: rawEpic.title ?? epicId,
      description: rawEpic.description ?? '',
      acceptanceCriteria: textList(rawEpic.acceptanceCriteria, `Epic '${epicId}' acceptanceCriteria`),
      jiraKey: rawEpic.jiraKey ?? null,
      jiraIssueId: rawEpic.jiraIssueId == null ? null : String(rawEpic.jiraIssueId),
      stories: []
    };
    for (const [storyIndex, rawStory] of rawEpic.stories.entries()) {
      if (!rawStory || typeof rawStory !== 'object') throw new SingularityFlowError(`Epic '${epicId}' story ${storyIndex + 1} must be an object.`);
      const id = safeId(rawStory.planId ?? rawStory.id, `Epic '${epicId}' story ID`);
      const repository = safeId(rawStory.repository, `Story '${id}' repository`);
      if (rawStory.description != null && typeof rawStory.description !== 'string') throw new SingularityFlowError(`Story '${id}' description must be text.`);
      if (!portfolio.repositories[repository]) throw new SingularityFlowError(`Story '${id}' references unknown repository '${repository}'.`);
      const story = {
        id,
        planId: id,
        workId: safeId(value.version === 2 ? (rawStory.workId ?? rawStory.jiraKey ?? id) : id, `Story '${id}' Work ID`),
        title: rawStory.title ?? id,
        description: rawStory.description ?? '',
        requirements: textList(rawStory.requirements, `Story '${id}' requirements`),
        acceptanceCriteria: textList(rawStory.acceptanceCriteria, `Story '${id}' acceptanceCriteria`),
        epicId,
        repository,
        blocking: rawStory.blocking !== false,
        suggestedWorkType: rawStory.suggestedWorkType ?? 'feature',
        dependsOn: (rawStory.dependsOn ?? []).map((dependency) => normalizeDependency(dependency, id)),
        consumesContracts: (rawStory.consumesContracts ?? []).map((contract) => normalizeContract(contract, id)),
        jiraKey: rawStory.jiraKey ?? null,
        initialJiraKey: rawStory.initialJiraKey ?? rawStory.jiraKey ?? null,
        jiraAliases: textList(rawStory.jiraAliases, `Story '${id}' jiraAliases`),
        jiraIssueId: rawStory.jiraIssueId == null ? null : String(rawStory.jiraIssueId),
        epicKey: rawStory.epicKey ?? rawEpic.jiraKey ?? null,
        estimate: rawStory.estimate ?? null
      };
      if (value.version === 2) {
        for (const requirement of story.requirements) {
          if (!/^REQ-\d{3,}$/.test(requirement)) throw new SingularityFlowError(`Story '${id}' requirement '${requirement}' must use REQ-nnn traceability.`);
        }
        for (const criterion of story.acceptanceCriteria) {
          if (!/^AC-\d{3,}$/.test(criterion)) throw new SingularityFlowError(`Story '${id}' acceptance criterion '${criterion}' must use AC-nnn traceability.`);
        }
      }
      epic.stories.push(story);
      stories.push(story);
    }
    epics.push(epic);
  }
  const storyIds = stories.map((story) => story.id);
  if (new Set(storyIds).size !== storyIds.length) throw new SingularityFlowError('Initiative breakdown story IDs must be unique across every epic.');
  const known = new Set(storyIds);
  for (const story of stories) {
    const dependencies = story.dependsOn.map((dependency) => dependency.story);
    if (new Set(dependencies).size !== dependencies.length) throw new SingularityFlowError(`Story '${story.id}' contains duplicate dependencies.`);
    if (dependencies.includes(story.id)) throw new SingularityFlowError(`Story '${story.id}' cannot depend on itself.`);
    for (const dependency of dependencies) if (!known.has(dependency)) throw new SingularityFlowError(`Story '${story.id}' depends on unknown story '${dependency}'.`);
  }
  const visiting = new Set(), visited = new Set();
  function visit(id, trail = []) {
    if (visiting.has(id)) throw new SingularityFlowError(`Initiative story dependency cycle: ${[...trail, id].join(' -> ')}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    const story = stories.find((candidate) => candidate.id === id);
    for (const dependency of story.dependsOn) visit(dependency.story, [...trail, id]);
    visiting.delete(id); visited.add(id);
  }
  storyIds.forEach((id) => visit(id));
  return { version: value.version, initiativeId: value.initiativeId ?? null, epics, stories };
}

export function initiativeBreakdownDocument(breakdown) {
  const version = breakdown.version ?? 1;
  return {
    version,
    initiativeId: breakdown.initiativeId,
    epics: breakdown.epics.map((epic) => ({
      ...(version === 2 ? { planId: epic.planId ?? epic.id } : { id: epic.id }),
      title: epic.title,
      ...(epic.description ? { description: epic.description } : {}),
      ...(epic.acceptanceCriteria.length ? { acceptanceCriteria: epic.acceptanceCriteria } : {}),
      ...(epic.jiraKey ? { jiraKey: epic.jiraKey } : {}),
      ...(epic.jiraIssueId ? { jiraIssueId: epic.jiraIssueId } : {}),
      stories: epic.stories.map((story) => ({
        ...(version === 2 ? { planId: story.planId ?? story.id, workId: story.workId } : { id: story.id }),
        title: story.title,
        ...(story.description ? { description: story.description } : {}),
        ...(story.requirements?.length ? { requirements: story.requirements } : {}),
        ...(story.acceptanceCriteria.length ? { acceptanceCriteria: story.acceptanceCriteria } : {}),
        repository: story.repository,
        blocking: story.blocking,
        suggestedWorkType: story.suggestedWorkType,
        ...(story.jiraKey ? { jiraKey: story.jiraKey } : {}),
        ...(story.initialJiraKey ? { initialJiraKey: story.initialJiraKey } : {}),
        ...(story.jiraAliases?.length ? { jiraAliases: story.jiraAliases } : {}),
        ...(story.jiraIssueId ? { jiraIssueId: story.jiraIssueId } : {}),
        ...(story.epicKey ? { epicKey: story.epicKey } : {}),
        ...(story.estimate != null ? { estimate: story.estimate } : {}),
        ...(story.dependsOn.length ? { dependsOn: story.dependsOn } : {}),
        ...(story.consumesContracts.length ? { consumesContracts: story.consumesContracts } : {})
      }))
    }))
  };
}

export async function loadInitiativeBreakdown(root, portfolio, initiativeId) {
  const file = await secureInitiativePath(root, portfolio, initiativeId, 'breakdown.yml', {
    label: `Initiative '${initiativeId}' breakdown`,
    mustExist: true,
    type: 'file'
  });
  let parsed;
  try { parsed = YAML.parse(await readFile(file.absolute, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`Unable to parse initiative breakdown: ${error.message}`); }
  const breakdown = validateInitiativeBreakdown(parsed, portfolio);
  if (breakdown.initiativeId && breakdown.initiativeId !== initiativeId) throw new SingularityFlowError(`Breakdown initiativeId '${breakdown.initiativeId}' does not match '${initiativeId}'.`);
  breakdown.initiativeId = initiativeId;
  return breakdown;
}

function materializationPhase(initiative) {
  return initiative.phaseOrder.includes('epic-plan')
    ? 'epic-plan'
    : initiative.phaseOrder.includes('elaboration')
      ? 'elaboration'
      : initiative.phaseOrder.includes('plan') ? 'plan' : null;
}

function stableLabel(initiativeId, itemId) {
  return `sflow-${createHash('sha256').update(`${initiativeId}:${itemId}`).digest('hex').slice(0, 24)}`;
}

export async function initiativeBreakdownReview(root, initiativeId, { probe = false } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const repositories = {};
  for (const story of breakdown.stories) {
    if (repositories[story.repository]) continue;
    const repository = portfolio.repositories[story.repository];
    const probeResult = probe ? run('git', ['ls-remote', '--heads', repository.url], { cwd: root, allowFailure: true }) : null;
    repositories[story.repository] = {
      ...repository,
      reachable: probe ? probeResult.status === 0 : null,
      error: probe && probeResult.status !== 0 ? (probeResult.stderr || probeResult.stdout).trim() : null
    };
  }
  return {
    initiativeId,
    phase: materializationPhase(initiative),
    phaseStatus: initiative.phases[materializationPhase(initiative)]?.status ?? null,
    epics: breakdown.epics.length,
    stories: breakdown.stories,
    repositories
  };
}

function cacheRoot(root, initiativeId) {
  return path.join(gitDir(root), 'singularity-flow', 'initiatives', initiativeId, 'repositories');
}

async function managedClonePath(root, initiativeId, repositoryId) {
  const base = cacheRoot(root, initiativeId);
  await ensureDir(base);
  const target = await secureRepositoryPath(base, repositoryId, {
    label: `Managed clone for '${repositoryId}'`,
    type: 'directory'
  });
  return target.absolute;
}

async function validateManagedClone(target, repositoryId) {
  const gitMetadata = await secureRepositoryPath(target, '.git', {
    label: `Managed clone Git metadata for '${repositoryId}'`,
    mustExist: true,
    type: 'directory'
  });
  const discovered = run('git', ['rev-parse', '--show-toplevel'], { cwd: target, allowFailure: true });
  if (discovered.status !== 0 || path.resolve(discovered.stdout.trim()) !== path.resolve(target)) {
    throw new SingularityFlowError(`Managed clone for '${repositoryId}' is not an independent Git repository.`);
  }
  return gitMetadata;
}

function configureCloneIdentity(clone, actor) {
  run('git', ['config', 'user.name', actor.name], { cwd: clone });
  run('git', ['config', 'user.email', actor.email], { cwd: clone });
}

function remoteBranchHead(repositoryUrl, branchName, cwd) {
  const result = run('git', ['ls-remote', '--heads', repositoryUrl, `refs/heads/${branchName}`], { cwd, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(`Unable to read ${repositoryUrl}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim().split(/\s+/)[0] || null;
}

function storySeed(root, initiative, story) {
  const artifacts = [];
  for (const phaseId of initiative.phaseOrder) {
    for (const output of Object.values(initiative.phases[phaseId].outputs)) {
      if (output.status === 'approved' || output.status === 'published') artifacts.push({
        phase: phaseId,
        output: output.id,
        path: output.path,
        sha256: output.sha256,
        generation: output.generation
      });
    }
  }
  const contracts = story.consumesContracts.map((reference) => {
    const candidates = Object.values(initiative.contracts ?? {}).filter((contract) => contract.id === reference.id && (!reference.version || contract.version === reference.version));
    const selected = candidates.sort((left, right) => String(right.version).localeCompare(String(left.version)))[0] ?? null;
    return selected ? { id: selected.id, version: selected.version, sha256: selected.sha256, path: selected.path } : reference;
  });
  return {
    version: 1,
    initiative: {
      id: initiative.initiative.id,
      title: initiative.initiative.title,
      branch: initiative.initiative.branch,
      leadRepositoryCommit: head(root)
    },
    story: {
      id: story.workId,
      planId: story.planId ?? story.id,
      workId: story.workId,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
      epicId: story.epicId,
      epicJiraKey: story.epicJiraKey ?? null,
      jiraKey: story.jiraKey ?? null,
      jiraIssueId: story.jiraIssueId ?? null,
      initialJiraKey: story.initialJiraKey ?? story.jiraKey ?? null,
      jiraAliases: story.jiraAliases ?? [],
      repository: story.repository,
      repositoryMetadata: structuredClone(initiative.resolution.repositories?.[story.repository]?.metadata ?? {}),
      branchCompletionPolicy: initiative.resolution.repositories?.[story.repository]?.branchCompletionPolicy ?? 'pr',
      requiredChecks: structuredClone(initiative.resolution.repositories?.[story.repository]?.requiredChecks ?? []),
      blocking: story.blocking,
      suggestedWorkType: story.suggestedWorkType,
      dependsOn: story.dependsOn
    },
    approvedArtifacts: artifacts,
    contracts
  };
}

async function materializeStory(root, portfolio, initiative, story, actor) {
  const repository = portfolio.repositories[story.repository];
  const target = await managedClonePath(root, initiative.initiative.id, story.repository);
  if (!(await exists(path.join(target, '.git')))) {
    const cloned = run('git', ['clone', repository.url, target], { cwd: root, allowFailure: true });
    if (cloned.status !== 0) throw new SingularityFlowError(`Unable to clone ${story.repository}: ${(cloned.stderr || cloned.stdout).trim()}`);
  }
  await validateManagedClone(target, story.repository);
  if (run('git', ['status', '--porcelain'], { cwd: target }).stdout.trim()) throw new SingularityFlowError(`Managed clone for '${story.repository}' is not clean.`);
  configureCloneIdentity(target, actor);
  run('git', ['fetch', '--prune', 'origin'], { cwd: target });
  const branchName = story.workId ?? story.id;
  const remoteHead = remoteBranchHead(repository.url, branchName, target);
  if (remoteHead) {
    const switched = run('git', ['switch', '-C', branchName, `origin/${branchName}`], { cwd: target, allowFailure: true });
    if (switched.status !== 0) throw new SingularityFlowError(`Unable to attach branch ${branchName}: ${(switched.stderr || switched.stdout).trim()}`);
  } else {
    const base = `origin/${repository.defaultBranch}`;
    if (run('git', ['rev-parse', '--verify', base], { cwd: target, allowFailure: true }).status !== 0) throw new SingularityFlowError(`Repository '${story.repository}' has no default branch '${repository.defaultBranch}'.`);
    run('git', ['switch', '-C', branchName, base], { cwd: target });
  }
  if (run('git', ['status', '--porcelain'], { cwd: target }).stdout.trim()) throw new SingularityFlowError(`Managed clone for '${story.repository}' is not clean.`);
  const relativeSeed = posix(path.join('singularity', 'seeds', `${branchName}.yml`));
  let seedPath = await secureRepositoryPath(target, relativeSeed, {
    label: `Story '${branchName}' seed`,
    type: 'file'
  });
  const seed = storySeed(root, initiative, story);
  if (seedPath.exists) {
    const current = YAML.parse(await readFile(seedPath.absolute, 'utf8'));
    if (current?.initiative?.id !== initiative.initiative.id || current?.story?.id !== branchName) throw new SingularityFlowError(`Existing branch '${branchName}' contains an unrelated Singularity Flow seed.`);
    const refreshed = {
      ...current,
      version: 1,
      initiative: seed.initiative,
      story: { ...(current.story ?? {}), ...seed.story },
      approvedArtifacts: seed.approvedArtifacts,
      contracts: seed.contracts
    };
    if (YAML.stringify(current) !== YAML.stringify(refreshed)) {
      await writeText(seedPath.absolute, YAML.stringify(refreshed));
      run('git', ['add', '--', relativeSeed], { cwd: target });
      run('git', ['commit', '-m', `[${initiative.initiative.id}][story:${branchName}][seed] Refresh initiative linkage`], { cwd: target });
      const pushed = run('git', ['push', 'origin', `HEAD:${branchName}`], { cwd: target, allowFailure: true });
      if (pushed.status !== 0) throw new SingularityFlowError(`Story '${branchName}' refreshed seed commit was retained locally but push failed: ${(pushed.stderr || pushed.stdout).trim()}`);
      return { status: 'updated', branch: branchName, commit: run('git', ['rev-parse', 'HEAD'], { cwd: target }).stdout.trim(), seed: relativeSeed };
    }
    return { status: 'attached', branch: branchName, commit: remoteHead, seed: relativeSeed };
  }
  await writeText(seedPath.absolute, YAML.stringify(seed));
  run('git', ['add', '--', relativeSeed], { cwd: target });
  run('git', ['commit', '-m', `[${initiative.initiative.id}][story:${branchName}][seed] Link initiative`], { cwd: target });
  const pushed = run('git', ['push', '-u', 'origin', `HEAD:${branchName}`], { cwd: target, allowFailure: true });
  if (pushed.status !== 0) throw new SingularityFlowError(`Story '${branchName}' seed commit was retained locally but push failed: ${(pushed.stderr || pushed.stdout).trim()}`);
  return { status: 'created', branch: branchName, commit: run('git', ['rev-parse', 'HEAD'], { cwd: target }).stdout.trim(), seed: relativeSeed };
}

async function materializeJira(portfolio, initiative, breakdown, { env, fetchImpl } = {}) {
  if (!portfolio.jira?.write) return { mode: 'off', epics: {}, stories: {} };
  const projectKey = portfolio.jira.projectKey;
  if (!projectKey) throw new SingularityFlowError('portfolio.jira.projectKey is required when Jira write materialization is enabled.');
  const epics = {}, stories = {};
  for (const epic of breakdown.epics) {
    const epicIssue = epic.jiraKey ? { key: epic.jiraKey, created: false } : await findOrCreateIssue({
      idempotencyLabel: stableLabel(initiative.initiative.id, epic.id),
      projectKey,
      issueType: portfolio.jira.epicIssueType ?? 'Epic',
      summary: epic.title,
      description: [
        `Singularity Flow initiative ${initiative.initiative.id}, epic ${epic.id}.`,
        epic.description,
        epic.acceptanceCriteria.length ? `Acceptance criteria:\n${epic.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}` : ''
      ].filter(Boolean).join('\n\n')
    }, { env, fetchImpl });
    epics[epic.id] = epicIssue;
    for (const story of epic.stories) {
      const issue = story.jiraKey ? { key: story.jiraKey, created: false } : await findOrCreateIssue({
        idempotencyLabel: stableLabel(initiative.initiative.id, story.id),
        projectKey,
        issueType: portfolio.jira.storyIssueType ?? 'Story',
        summary: story.title,
        description: [
          `Repository ${story.repository}; Singularity Flow Story Work ID ${story.id}.`,
          story.description,
          story.acceptanceCriteria.length ? `Acceptance criteria:\n${story.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}` : ''
        ].filter(Boolean).join('\n\n'),
        parentKey: epicIssue.key
      }, { env, fetchImpl });
      stories[story.id] = issue;
    }
  }
  return { mode: 'jira', epics, stories };
}

export async function materializeInitiative(root, initiativeId, {
  dryRun = false,
  confirmation = null,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const review = await initiativeBreakdownReview(root, initiativeId, { probe: !dryRun });
  if (dryRun) return { dryRun: true, review };
  if (confirmation !== initiativeId) throw new SingularityFlowError(`Materialization requires exact initiative confirmation '${initiativeId}'.`);
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const requiredPhase = materializationPhase(initiative);
  if (!requiredPhase || initiative.phases[requiredPhase].status !== 'approved') throw new SingularityFlowError(`Initiative materialization requires approved phase '${requiredPhase}'.`);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const actor = identity(root);
  if (!actor.email) throw new SingularityFlowError('Materialization requires a configured local Git email.');
  const jira = await materializeJira(portfolio, initiative, breakdown, { env, fetchImpl });
  for (const epic of breakdown.epics) {
    epic.jiraKey = jira.epics[epic.id]?.key ?? epic.jiraKey;
    epic.jiraIssueId = jira.epics[epic.id]?.id ?? epic.jiraIssueId;
    for (const story of epic.stories) {
      story.jiraKey = jira.stories[story.id]?.key ?? story.jiraKey;
      story.jiraIssueId = jira.stories[story.id]?.id ?? story.jiraIssueId;
      story.initialJiraKey ??= story.jiraKey ?? null;
      story.workId = breakdown.version === 2
        ? (story.workId && story.workId !== story.id ? story.workId : (story.jiraKey ?? story.workId ?? story.id))
        : story.id;
      story.epicJiraKey = epic.jiraKey ?? null;
      story.epicKey = epic.jiraKey ?? story.epicKey ?? null;
    }
  }
  breakdown.stories = breakdown.epics.flatMap((epic) => epic.stories);
  const breakdownPath = await secureInitiativePath(root, portfolio, initiativeId, 'breakdown.yml', {
    label: `Initiative '${initiativeId}' breakdown`,
    mustExist: true,
    type: 'file'
  });
  await writeText(breakdownPath.absolute, YAML.stringify(initiativeBreakdownDocument(breakdown)));
  const attempt = { at: nowIso(), actor, status: 'in_progress', jira, stories: [] };
  initiative.materialization.attempts.push(attempt);
  const journalPath = await secureInitiativePath(root, portfolio, initiativeId, path.join('context', 'materialization-journal.json'), {
    label: `Initiative '${initiativeId}' materialization journal`,
    type: 'file'
  });
  for (const story of breakdown.stories) {
    let receipt;
    try {
      receipt = await materializeStory(root, portfolio, initiative, story, actor);
      initiative.childStories[story.id] = {
        ...story,
        workId: story.workId,
        branch: story.workId,
        canonicalBranch: story.workId,
        seedCommit: receipt.commit,
        observedCommit: receipt.commit,
        status: 'seeded',
        currentPhase: null,
        stale: false,
        blocked: false,
        jira: jira.stories[story.id] ?? null,
        contractSnapshots: Object.fromEntries(story.consumesContracts.map((contract) => [contract.id, contract]))
      };
    } catch (error) {
      receipt = { status: 'failed', branch: story.workId ?? story.id, error: error.message };
    }
    attempt.stories.push({ storyId: story.id, repository: story.repository, ...receipt });
    await writeJson(journalPath.absolute, { schemaVersion: 1, initiativeId, attempts: initiative.materialization.attempts });
    await saveInitiative(root, portfolio, initiative);
  }
  const failures = attempt.stories.filter((story) => story.status === 'failed');
  attempt.status = failures.length ? 'partial' : 'complete';
  attempt.completedAt = nowIso();
  initiative.materialization.status = attempt.status;
  initiative.history.push({
    at: attempt.completedAt,
    actor: actor.email.toLowerCase(),
    event: 'initiative_materialized',
    phase: requiredPhase,
    detail: `${attempt.stories.length - failures.length}/${attempt.stories.length} story branches ready`
  });
  await writeJson(journalPath.absolute, { schemaVersion: 1, initiativeId, attempts: initiative.materialization.attempts });
  await saveInitiative(root, portfolio, initiative);
  return { dryRun: false, review, attempt, failures };
}

function milestoneReached(workflow, phaseId) {
  if (!workflow) return false;
  const phase = workflow.phases?.[phaseId];
  return phase?.status === 'approved';
}

const CHILD_WORKFLOW_STATUSES = new Set(['in_progress', 'complete']);
const CHILD_PHASE_STATUSES = new Set(['not_started', 'in_progress', 'awaiting_approval', 'approved']);

function parseChildWorkflow(text, story) {
  const workId = story.workId ?? story.id;
  let workflow;
  try {
    workflow = JSON.parse(text);
  } catch (error) {
    throw new SingularityFlowError(`Child workflow for '${story.id}' is not valid JSON: ${error.message}`);
  }
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new SingularityFlowError(`Child workflow for '${story.id}' must be a JSON object.`);
  }
  if (![1, 2].includes(workflow.schemaVersion)) {
    throw new SingularityFlowError(`Child workflow for '${story.id}' has unsupported schema version '${workflow.schemaVersion}'.`);
  }
  if (workflow.workItem?.id !== workId) {
    throw new SingularityFlowError(`Child workflow belongs to '${workflow.workItem?.id ?? 'unknown'}'; expected '${workId}'.`);
  }
  if (workflow.schemaVersion === 2 && workflow.workItem.branch == null) {
    throw new SingularityFlowError(`Child workflow '${story.id}' has no immutable branch identity.`);
  }
  const lineageBranches = [workId, ...(workflow.lineage?.childBranches ?? []).map((entry) => entry.name)];
  if (workflow.workItem.branch != null && !lineageBranches.includes(workflow.workItem.branch)) {
    throw new SingularityFlowError(`Child workflow branch is '${workflow.workItem.branch}'; expected canonical branch '${workId}' or a registered child branch.`);
  }
  if (!CHILD_WORKFLOW_STATUSES.has(workflow.status)) {
    throw new SingularityFlowError(`Child workflow '${story.id}' has invalid status '${workflow.status}'.`);
  }
  if (!workflow.phases || typeof workflow.phases !== 'object' || Array.isArray(workflow.phases)) {
    throw new SingularityFlowError(`Child workflow '${story.id}' has no valid phase state.`);
  }
  const phaseOrder = workflow.phaseOrder ?? Object.keys(workflow.phases);
  if (!Array.isArray(phaseOrder) || !phaseOrder.length || new Set(phaseOrder).size !== phaseOrder.length) {
    throw new SingularityFlowError(`Child workflow '${story.id}' has no valid unique phase order.`);
  }
  if (workflow.schemaVersion === 2) {
    const resolvedIds = workflow.resolution?.phases?.map((phase) => phase?.id);
    if (!Array.isArray(resolvedIds) || resolvedIds.some((phaseId) => typeof phaseId !== 'string')) {
      throw new SingularityFlowError(`Child workflow '${story.id}' has no immutable phase resolution.`);
    }
    if (JSON.stringify(resolvedIds) !== JSON.stringify(phaseOrder)) {
      throw new SingularityFlowError(`Child workflow '${story.id}' phase order differs from its immutable resolution.`);
    }
    if (workflow.resolution.workType !== workflow.workItem.workType) {
      throw new SingularityFlowError(`Child workflow '${story.id}' work type differs from its immutable resolution.`);
    }
  }
  for (const phaseId of phaseOrder) {
    if (typeof phaseId !== 'string' || !workflow.phases[phaseId] || !CHILD_PHASE_STATUSES.has(workflow.phases[phaseId].status)) {
      throw new SingularityFlowError(`Child workflow '${story.id}' has invalid phase '${phaseId}'.`);
    }
  }
  if (workflow.status === 'complete') {
    if (workflow.currentPhase != null || phaseOrder.some((phaseId) => workflow.phases[phaseId].status !== 'approved')) {
      throw new SingularityFlowError(`Completed child workflow '${story.id}' must have no current phase and every phase approved.`);
    }
  } else if (!phaseOrder.includes(workflow.currentPhase) || !['in_progress', 'awaiting_approval'].includes(workflow.phases[workflow.currentPhase].status)) {
    throw new SingularityFlowError(`In-progress child workflow '${story.id}' has invalid current phase '${workflow.currentPhase ?? 'none'}'.`);
  }
  return { ...workflow, phaseOrder };
}

function childTelemetry(workflow) {
  const usage = Object.values(workflow.phases ?? {}).flatMap((phase) => phase.usage ?? []);
  const costs = usage.map((record) => record.providerCost).filter(Number.isFinite);
  return {
    totalTokens: workflow.usage?.totalTokens ?? (usage.length ? usage.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0) : null),
    exactRecords: workflow.usage?.exactRecords ?? usage.filter((record) => record.status === 'exact').length,
    unavailableRecords: workflow.usage?.unavailableRecords ?? usage.filter((record) => record.status !== 'exact').length,
    models: [...new Set(usage.map((record) => record.model).filter(Boolean))],
    providerCost: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null
  };
}

function recordMilestoneRegressions(previous, current, storyId, regressions) {
  for (const [milestone, wasReached] of Object.entries(previous.milestones ?? {})) {
    if (wasReached && !current.milestones?.[milestone]) regressions.push({ storyId, milestone });
  }
}

export async function syncInitiativeRepositories(root, initiativeId) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const lockPath = await secureInitiativePath(root, portfolio, initiativeId, 'repositories.lock.yml', {
    label: `Initiative '${initiativeId}' repository lock`,
    mustExist: true,
    type: 'file'
  });
  const lock = YAML.parse(await readFile(lockPath.absolute, 'utf8'));
  const regressions = [];
  const results = [];
  for (const story of breakdown.stories) {
    const workId = story.workId ?? story.id;
    const repository = portfolio.repositories[story.repository];
    const cache = await managedClonePath(root, initiativeId, story.repository);
    if (!(await exists(path.join(cache, '.git')))) {
      const cloned = run('git', ['clone', repository.url, cache], { cwd: root, allowFailure: true });
      if (cloned.status !== 0) {
        results.push({ storyId: story.id, repository: story.repository, status: 'unreachable', error: (cloned.stderr || cloned.stdout).trim() });
        continue;
      }
    }
    try {
      await validateManagedClone(cache, story.repository);
    } catch (error) {
      results.push({ storyId: story.id, repository: story.repository, status: 'invalid-cache', error: error.message });
      continue;
    }
    const fetched = run('git', ['fetch', '--prune', 'origin'], { cwd: cache, allowFailure: true });
    if (fetched.status !== 0) {
      results.push({ storyId: story.id, repository: story.repository, status: 'unreachable', error: (fetched.stderr || fetched.stdout).trim() });
      continue;
    }
    const commit = run('git', ['rev-parse', `origin/${workId}`], { cwd: cache, allowFailure: true }).stdout.trim();
    if (!commit) {
      results.push({ storyId: story.id, repository: story.repository, status: 'missing-branch' });
      continue;
    }
    const workflowText = run('git', ['show', `${commit}:singularity/work-items/${workId}/workflow.json`], { cwd: cache, allowFailure: true });
    const previous = initiative.childStories[story.id] ?? {};
    let workflow = null;
    if (workflowText.status === 0) {
      try {
        workflow = parseChildWorkflow(workflowText.stdout, story);
      } catch (error) {
        const observedAt = nowIso();
        const current = {
          ...previous,
          ...story,
          branch: workId,
          canonicalBranch: workId,
          observedCommit: commit,
          observedAt,
          status: 'invalid',
          currentPhase: null,
          phaseOrder: [],
          approvedPhases: [],
          progress: { completed: 0, total: 0, percentage: 0 },
          blocked: true,
          stale: true,
          milestones: { implementationSpec: false, verification: false, conformance: false },
          telemetry: null,
          error: error.message
        };
        recordMilestoneRegressions(previous, current, story.id, regressions);
        initiative.childStories[story.id] = current;
        lock.repositories[story.repository] = {
          ...lock.repositories[story.repository],
          observedHead: run('git', ['rev-parse', `origin/${repository.defaultBranch}`], { cwd: cache, allowFailure: true }).stdout.trim() || null,
          observedAt
        };
        results.push({ storyId: story.id, repository: story.repository, status: 'invalid-workflow', commit, error: error.message });
        continue;
      }
    }
    const phaseOrder = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
    const approvedPhases = phaseOrder.filter((phaseId) => workflow?.phases?.[phaseId]?.status === 'approved');
    const completedPhases = approvedPhases.length;
    const current = {
      ...previous,
      ...story,
      branch: workId,
      canonicalBranch: workId,
      observedCommit: commit,
      observedAt: nowIso(),
      status: workflow?.status ?? 'seeded',
      currentPhase: workflow?.currentPhase ?? null,
      phaseOrder,
      approvedPhases,
      progress: {
        completed: completedPhases,
        total: phaseOrder.length,
        percentage: workflow?.status === 'complete'
          ? 100
          : phaseOrder.length ? Math.round((completedPhases / phaseOrder.length) * 100) : 0
      },
      blocked: false,
      stale: false,
      invalidatedBy: null,
      error: null,
      milestones: {
        implementationSpec: milestoneReached(workflow, 'implementation-spec') || milestoneReached(workflow, 'fix-spec'),
        verification: milestoneReached(workflow, 'verification'),
        conformance: milestoneReached(workflow, 'conformance')
      },
      telemetry: workflow ? childTelemetry(workflow) : previous.telemetry ?? null
    };
    if (workflow) {
      current.canonicalBranch = workflow.lineage?.canonicalBranch ?? workId;
      current.childBranches = structuredClone(workflow.lineage?.childBranches ?? []);
      current.submissions = structuredClone(workflow.lineage?.submissions ?? []);
      current.reviewEvidence = structuredClone(workflow.lineage?.reviewEvidence ?? []);
      current.branchCompletionPolicy = workflow.lineage?.branchCompletionPolicy
        ?? initiative.resolution.repositories?.[story.repository]?.branchCompletionPolicy
        ?? 'pr';
      current.requiredChecks = structuredClone(workflow.lineage?.requiredChecks ?? []);
      current.conformance = workflow.phases?.conformance ? {
        status: workflow.phases.conformance.status,
        treeSha256: workflow.phases.conformance.conformanceTree ?? null
      } : null;
    }
    recordMilestoneRegressions(previous, current, story.id, regressions);
    initiative.childStories[story.id] = current;
    lock.repositories[story.repository] = {
      ...lock.repositories[story.repository],
      observedHead: run('git', ['rev-parse', `origin/${repository.defaultBranch}`], { cwd: cache, allowFailure: true }).stdout.trim() || null,
      observedAt: current.observedAt
    };
    results.push({ storyId: story.id, repository: story.repository, status: 'synchronized', commit, workflowStatus: current.status, currentPhase: current.currentPhase });
  }
  for (const story of breakdown.stories) {
    const current = initiative.childStories[story.id];
    if (!current) continue;
    current.blocked = current.status === 'invalid' || story.dependsOn.some((dependency) => {
      const dependencyState = initiative.childStories[dependency.story];
      if (dependency.requiredPhase === 'complete') return dependencyState?.status !== 'complete';
      const camelMilestone = dependency.requiredPhase.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      return !dependencyState?.approvedPhases?.includes(dependency.requiredPhase)
        && !dependencyState?.milestones?.[camelMilestone];
    });
  }
  await writeText(lockPath.absolute, YAML.stringify(lock));
  initiative.history.push({ at: nowIso(), actor: identity(root).email?.toLowerCase() ?? identity(root).name, event: 'initiative_repositories_synchronized', phase: initiative.currentPhase, detail: `${results.filter((item) => item.status === 'synchronized').length}/${results.length} stories synchronized` });
  await saveInitiative(root, portfolio, initiative);
  const invalidations = [];
  for (const regression of regressions) invalidations.push(await invalidateInitiativeCone(root, {
    initiativeId,
    starts: [initiativeNode('story', regression.storyId)],
    reason: `Story ${regression.storyId} regressed below milestone ${regression.milestone}.`,
    cause: 'dependency-regressed'
  }));
  return { initiativeId, results, regressions, invalidations };
}
