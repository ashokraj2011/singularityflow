import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { gitDir, head, identity } from './git.mjs';
import { findOrCreateIssue } from './jira.mjs';
import {
  initiativeDir, loadInitiative, saveInitiative
} from './initiative-state.mjs';
import {
  initiativeNode, invalidateInitiativeCone
} from './initiative-graph.mjs';
import {
  SingularityFlowError, ensureDir, exists, nowIso, posix, run, writeJson, writeText
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
  if (value.version !== 1) throw new SingularityFlowError('Initiative breakdown version must be 1.');
  if (!Array.isArray(value.epics)) throw new SingularityFlowError('Initiative breakdown epics must be an array.');
  const epics = [];
  const stories = [];
  for (const [epicIndex, rawEpic] of value.epics.entries()) {
    if (!rawEpic || typeof rawEpic !== 'object') throw new SingularityFlowError(`Epic ${epicIndex + 1} must be an object.`);
    const epicId = safeId(rawEpic.id, `Epic ${epicIndex + 1} ID`);
    if (!Array.isArray(rawEpic.stories)) throw new SingularityFlowError(`Epic '${epicId}' stories must be an array.`);
    if (rawEpic.description != null && typeof rawEpic.description !== 'string') throw new SingularityFlowError(`Epic '${epicId}' description must be text.`);
    const epic = {
      id: epicId,
      title: rawEpic.title ?? epicId,
      description: rawEpic.description ?? '',
      acceptanceCriteria: textList(rawEpic.acceptanceCriteria, `Epic '${epicId}' acceptanceCriteria`),
      jiraKey: rawEpic.jiraKey ?? null,
      stories: []
    };
    for (const [storyIndex, rawStory] of rawEpic.stories.entries()) {
      if (!rawStory || typeof rawStory !== 'object') throw new SingularityFlowError(`Epic '${epicId}' story ${storyIndex + 1} must be an object.`);
      const id = safeId(rawStory.id, `Epic '${epicId}' story ID`);
      const repository = safeId(rawStory.repository, `Story '${id}' repository`);
      if (rawStory.description != null && typeof rawStory.description !== 'string') throw new SingularityFlowError(`Story '${id}' description must be text.`);
      if (!portfolio.repositories[repository]) throw new SingularityFlowError(`Story '${id}' references unknown repository '${repository}'.`);
      const story = {
        id,
        title: rawStory.title ?? id,
        description: rawStory.description ?? '',
        acceptanceCriteria: textList(rawStory.acceptanceCriteria, `Story '${id}' acceptanceCriteria`),
        epicId,
        repository,
        blocking: rawStory.blocking !== false,
        suggestedWorkType: rawStory.suggestedWorkType ?? 'feature',
        dependsOn: (rawStory.dependsOn ?? []).map((dependency) => normalizeDependency(dependency, id)),
        consumesContracts: (rawStory.consumesContracts ?? []).map((contract) => normalizeContract(contract, id)),
        jiraKey: rawStory.jiraKey ?? null,
        estimate: rawStory.estimate ?? null
      };
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
  return { version: 1, initiativeId: value.initiativeId ?? null, epics, stories };
}

export function initiativeBreakdownDocument(breakdown) {
  return {
    version: 1,
    initiativeId: breakdown.initiativeId,
    epics: breakdown.epics.map((epic) => ({
      id: epic.id,
      title: epic.title,
      ...(epic.description ? { description: epic.description } : {}),
      ...(epic.acceptanceCriteria.length ? { acceptanceCriteria: epic.acceptanceCriteria } : {}),
      ...(epic.jiraKey ? { jiraKey: epic.jiraKey } : {}),
      stories: epic.stories.map((story) => ({
        id: story.id,
        title: story.title,
        ...(story.description ? { description: story.description } : {}),
        ...(story.acceptanceCriteria.length ? { acceptanceCriteria: story.acceptanceCriteria } : {}),
        repository: story.repository,
        blocking: story.blocking,
        suggestedWorkType: story.suggestedWorkType,
        ...(story.jiraKey ? { jiraKey: story.jiraKey } : {}),
        ...(story.estimate != null ? { estimate: story.estimate } : {}),
        ...(story.dependsOn.length ? { dependsOn: story.dependsOn } : {}),
        ...(story.consumesContracts.length ? { consumesContracts: story.consumesContracts } : {})
      }))
    }))
  };
}

export async function loadInitiativeBreakdown(root, portfolio, initiativeId) {
  const file = path.join(initiativeDir(root, portfolio, initiativeId), 'breakdown.yml');
  let parsed;
  try { parsed = YAML.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`Unable to parse initiative breakdown: ${error.message}`); }
  const breakdown = validateInitiativeBreakdown(parsed, portfolio);
  if (breakdown.initiativeId && breakdown.initiativeId !== initiativeId) throw new SingularityFlowError(`Breakdown initiativeId '${breakdown.initiativeId}' does not match '${initiativeId}'.`);
  breakdown.initiativeId = initiativeId;
  return breakdown;
}

function materializationPhase(initiative) {
  return initiative.phaseOrder.includes('elaboration') ? 'elaboration' : initiative.phaseOrder.includes('plan') ? 'plan' : null;
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
      id: story.id,
      workId: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
      epicId: story.epicId,
      epicJiraKey: story.epicJiraKey ?? null,
      jiraKey: story.jiraKey ?? null,
      repository: story.repository,
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
  const target = path.join(cacheRoot(root, initiative.initiative.id), story.repository);
  await ensureDir(path.dirname(target));
  if (!(await exists(path.join(target, '.git')))) {
    const cloned = run('git', ['clone', repository.url, target], { cwd: root, allowFailure: true });
    if (cloned.status !== 0) throw new SingularityFlowError(`Unable to clone ${story.repository}: ${(cloned.stderr || cloned.stdout).trim()}`);
  }
  if (run('git', ['status', '--porcelain'], { cwd: target }).stdout.trim()) throw new SingularityFlowError(`Managed clone for '${story.repository}' is not clean.`);
  configureCloneIdentity(target, actor);
  run('git', ['fetch', '--prune', 'origin'], { cwd: target });
  const remoteHead = remoteBranchHead(repository.url, story.id, target);
  if (remoteHead) {
    const switched = run('git', ['switch', '-C', story.id, `origin/${story.id}`], { cwd: target, allowFailure: true });
    if (switched.status !== 0) throw new SingularityFlowError(`Unable to attach branch ${story.id}: ${(switched.stderr || switched.stdout).trim()}`);
  } else {
    const base = `origin/${repository.defaultBranch}`;
    if (run('git', ['rev-parse', '--verify', base], { cwd: target, allowFailure: true }).status !== 0) throw new SingularityFlowError(`Repository '${story.repository}' has no default branch '${repository.defaultBranch}'.`);
    run('git', ['switch', '-C', story.id, base], { cwd: target });
  }
  if (run('git', ['status', '--porcelain'], { cwd: target }).stdout.trim()) throw new SingularityFlowError(`Managed clone for '${story.repository}' is not clean.`);
  const relativeSeed = posix(path.join('singularity', 'seeds', `${story.id}.yml`));
  const seedPath = path.join(target, relativeSeed);
  const seed = storySeed(root, initiative, story);
  if (await exists(seedPath)) {
    const current = YAML.parse(await readFile(seedPath, 'utf8'));
    if (current?.initiative?.id !== initiative.initiative.id || current?.story?.id !== story.id) throw new SingularityFlowError(`Existing branch '${story.id}' contains an unrelated Singularity Flow seed.`);
    const refreshed = {
      ...current,
      version: 1,
      initiative: seed.initiative,
      story: { ...(current.story ?? {}), ...seed.story },
      approvedArtifacts: seed.approvedArtifacts,
      contracts: seed.contracts
    };
    if (YAML.stringify(current) !== YAML.stringify(refreshed)) {
      await writeText(seedPath, YAML.stringify(refreshed));
      run('git', ['add', '--', relativeSeed], { cwd: target });
      run('git', ['commit', '-m', `[${initiative.initiative.id}][story:${story.id}][seed] Refresh initiative linkage`], { cwd: target });
      const pushed = run('git', ['push', 'origin', `HEAD:${story.id}`], { cwd: target, allowFailure: true });
      if (pushed.status !== 0) throw new SingularityFlowError(`Story '${story.id}' refreshed seed commit was retained locally but push failed: ${(pushed.stderr || pushed.stdout).trim()}`);
      return { status: 'updated', branch: story.id, commit: run('git', ['rev-parse', 'HEAD'], { cwd: target }).stdout.trim(), seed: relativeSeed };
    }
    return { status: 'attached', branch: story.id, commit: remoteHead, seed: relativeSeed };
  }
  await writeText(seedPath, YAML.stringify(seed));
  run('git', ['add', '--', relativeSeed], { cwd: target });
  run('git', ['commit', '-m', `[${initiative.initiative.id}][story:${story.id}][seed] Link initiative`], { cwd: target });
  const pushed = run('git', ['push', '-u', 'origin', `HEAD:${story.id}`], { cwd: target, allowFailure: true });
  if (pushed.status !== 0) throw new SingularityFlowError(`Story '${story.id}' seed commit was retained locally but push failed: ${(pushed.stderr || pushed.stdout).trim()}`);
  return { status: 'created', branch: story.id, commit: run('git', ['rev-parse', 'HEAD'], { cwd: target }).stdout.trim(), seed: relativeSeed };
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
    for (const story of epic.stories) {
      story.jiraKey = jira.stories[story.id]?.key ?? story.jiraKey;
      story.epicJiraKey = epic.jiraKey ?? null;
    }
  }
  breakdown.stories = breakdown.epics.flatMap((epic) => epic.stories);
  await writeText(
    path.join(initiativeDir(root, portfolio, initiativeId), 'breakdown.yml'),
    YAML.stringify(initiativeBreakdownDocument(breakdown))
  );
  const attempt = { at: nowIso(), actor, status: 'in_progress', jira, stories: [] };
  initiative.materialization.attempts.push(attempt);
  const journalPath = path.join(initiativeDir(root, portfolio, initiativeId), 'context', 'materialization-journal.json');
  for (const story of breakdown.stories) {
    let receipt;
    try {
      receipt = await materializeStory(root, portfolio, initiative, story, actor);
      initiative.childStories[story.id] = {
        ...story,
        workId: story.id,
        branch: story.id,
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
      receipt = { status: 'failed', branch: story.id, error: error.message };
    }
    attempt.stories.push({ storyId: story.id, repository: story.repository, ...receipt });
    await writeJson(journalPath, { schemaVersion: 1, initiativeId, attempts: initiative.materialization.attempts });
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
  await writeJson(journalPath, { schemaVersion: 1, initiativeId, attempts: initiative.materialization.attempts });
  await saveInitiative(root, portfolio, initiative);
  return { dryRun: false, review, attempt, failures };
}

function milestoneReached(workflow, phaseId) {
  if (!workflow) return false;
  const phase = workflow.phases?.[phaseId];
  return phase?.status === 'approved';
}

export async function syncInitiativeRepositories(root, initiativeId) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const lockPath = path.join(initiativeDir(root, portfolio, initiativeId), 'repositories.lock.yml');
  const lock = YAML.parse(await readFile(lockPath, 'utf8'));
  const regressions = [];
  const results = [];
  for (const story of breakdown.stories) {
    const repository = portfolio.repositories[story.repository];
    const cache = path.join(cacheRoot(root, initiativeId), story.repository);
    await ensureDir(path.dirname(cache));
    if (!(await exists(path.join(cache, '.git')))) {
      const cloned = run('git', ['clone', repository.url, cache], { cwd: root, allowFailure: true });
      if (cloned.status !== 0) {
        results.push({ storyId: story.id, repository: story.repository, status: 'unreachable', error: (cloned.stderr || cloned.stdout).trim() });
        continue;
      }
    }
    const fetched = run('git', ['fetch', '--prune', 'origin'], { cwd: cache, allowFailure: true });
    if (fetched.status !== 0) {
      results.push({ storyId: story.id, repository: story.repository, status: 'unreachable', error: (fetched.stderr || fetched.stdout).trim() });
      continue;
    }
    const commit = run('git', ['rev-parse', `origin/${story.id}`], { cwd: cache, allowFailure: true }).stdout.trim();
    if (!commit) {
      results.push({ storyId: story.id, repository: story.repository, status: 'missing-branch' });
      continue;
    }
    const workflowText = run('git', ['show', `origin/${story.id}:singularity/work-items/${story.id}/workflow.json`], { cwd: cache, allowFailure: true });
    const workflow = workflowText.status === 0 ? JSON.parse(workflowText.stdout) : null;
    const previous = initiative.childStories[story.id] ?? {};
    const phaseOrder = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
    const approvedPhases = phaseOrder.filter((phaseId) => workflow?.phases?.[phaseId]?.status === 'approved');
    const completedPhases = approvedPhases.length;
    const current = {
      ...previous,
      ...story,
      branch: story.id,
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
      milestones: {
        implementationSpec: milestoneReached(workflow, 'implementation-spec') || milestoneReached(workflow, 'fix-spec'),
        verification: milestoneReached(workflow, 'verification'),
        conformance: milestoneReached(workflow, 'conformance')
      },
      telemetry: workflow ? {
        totalTokens: workflow.usage?.totalTokens ?? null,
        models: [...new Set(Object.values(workflow.phases ?? {}).flatMap((phase) => (phase.usage ?? []).map((usage) => usage.model).filter(Boolean)))],
        providerCost: (() => {
          const values = Object.values(workflow.phases ?? {}).flatMap((phase) => (phase.usage ?? []).map((usage) => usage.providerCost).filter(Number.isFinite));
          return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
        })()
      } : previous.telemetry ?? null
    };
    if (previous.milestones) {
      for (const [milestone, wasReached] of Object.entries(previous.milestones)) {
        if (wasReached && !current.milestones[milestone]) regressions.push({ storyId: story.id, milestone });
      }
    }
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
    current.blocked = story.dependsOn.some((dependency) => {
      const dependencyState = initiative.childStories[dependency.story];
      if (dependency.requiredPhase === 'complete') return dependencyState?.status !== 'complete';
      const camelMilestone = dependency.requiredPhase.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      return !dependencyState?.approvedPhases?.includes(dependency.requiredPhase)
        && !dependencyState?.milestones?.[camelMilestone];
    });
  }
  await writeText(lockPath, YAML.stringify(lock));
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

export function initiativeMilestoneReadiness(initiative, phaseId, stories = Object.values(initiative.childStories ?? {})) {
  const blocking = stories.filter((story) => story.blocking);
  const required = phaseId === 'delivery' ? 'conformance' : phaseId === 'construction' ? 'verification' : null;
  const incomplete = required ? blocking.filter((story) => !story.milestones?.[required] || story.stale) : [];
  return {
    phase: phaseId,
    policy: 'allBlocking',
    requiredMilestone: required,
    blockingStories: blocking.length,
    readyStories: blocking.length - incomplete.length,
    ready: incomplete.length === 0,
    incomplete: incomplete.map((story) => ({ id: story.id, repository: story.repository, status: story.status, currentPhase: story.currentPhase, stale: story.stale }))
  };
}
