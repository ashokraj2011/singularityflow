import path from 'node:path';
import YAML from 'yaml';
import { canonicalJson, publishToStateBranch, sha256 } from './ledger.mjs';
import { loadInitiativeAggregate } from './state-stores.mjs';
import {
  initiativeMergeState, loadInitiativeBreakdown, initiativeRepositoryClonePath
} from './initiative-repositories.mjs';
import { readStorySeed } from './pull-request.mjs';
import { SingularityFlowError, run } from './util.mjs';

export const STORY_STACK_SCHEMA_VERSION = 1;

function safeId(value, label) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text)) throw new SingularityFlowError(`${label} must be a safe identifier.`);
  return text;
}

export function storyStackPath(initiativeId) {
  return path.posix.join('orchestration', 'stacks', `${safeId(initiativeId, 'Epic ID')}.json`);
}

export function buildStoryStack(mergeState, breakdown) {
  const sourceById = new Map(breakdown.stories.map((story) => [story.id, story]));
  const workIdById = new Map(mergeState.stories.map((story) => [story.id, story.workId]));
  const stories = mergeState.stories.map((story, index, ordered) => {
    const source = sourceById.get(story.id);
    const predecessors = ordered.slice(0, index)
      .filter((candidate) => candidate.blocking && candidate.status !== 'merged')
      .map((candidate) => candidate.workId);
    const blockedBy = story.blockedBy.map((storyId) => workIdById.get(storyId) ?? storyId);
    const mergeBlockedBy = [...new Set([...blockedBy, ...predecessors])].sort();
    return {
      ...story,
      blockedBy,
      parentBranch: source?.parentBranch ?? mergeState.epicBranch,
      dependsOn: (source?.dependsOn ?? []).map((dependency) => dependency.story),
      mergeBlockedBy,
      mergeEligible: story.status === 'ready' && mergeBlockedBy.length === 0
    };
  });
  const document = {
    schemaVersion: STORY_STACK_SCHEMA_VERSION,
    initiativeId: mergeState.initiativeId,
    epicBranch: mergeState.epicBranch,
    stories,
    nextToMerge: stories.find((story) => story.mergeEligible)?.workId ?? null,
    epicReady: mergeState.epicReady,
    outstanding: mergeState.outstanding,
    unreachable: mergeState.unreachable
  };
  return { ...document, sha256: sha256(canonicalJson(document)) };
}

function repositoryLedgerConfig(clone, stories) {
  for (const story of stories) {
    const workId = story.workId ?? story.id;
    const result = run('git', ['show', `origin/${workId}:singularity/workflow.yml`], { cwd: clone, allowFailure: true });
    if (result.status !== 0 || !result.stdout.trim()) continue;
    try {
      const parsed = YAML.parse(result.stdout);
      if (parsed?.ledger && typeof parsed.ledger === 'object') return { ...parsed.ledger, enabled: true, remote: 'origin' };
    } catch { /* fall through to the standard state branch */ }
  }
  return {
    enabled: true,
    branch: 'state',
    remote: 'origin',
    pinTransport: 'refs'
  };
}

/** Replicate the same deterministic merge stack onto every participating repo's orphan state branch. */
export async function syncStoryStack(root, initiativeId) {
  const mergeState = await initiativeMergeState(root, initiativeId);
  const { portfolio, initiative } = await loadInitiativeAggregate(root, initiativeId);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const stack = buildStoryStack(mergeState, breakdown);
  const contents = canonicalJson(stack);
  const repositoryIds = [...new Set(breakdown.stories.map((story) => story.repository))].sort();
  if (!repositoryIds.length) throw new SingularityFlowError(`${initiativeId} has no Story repositories to receive a merge stack.`);

  const publications = [];
  for (const repositoryId of repositoryIds) {
    const repository = initiative.resolution.repositories?.[repositoryId] ?? portfolio.repositories?.[repositoryId];
    if (!repository) throw new SingularityFlowError(`Merge stack references unknown repository '${repositoryId}'.`);
    const clone = await initiativeRepositoryClonePath(root, initiativeId, repositoryId);
    const repositoryStories = breakdown.stories.filter((story) => story.repository === repositoryId);
    const publication = await publishToStateBranch(
      clone,
      repositoryLedgerConfig(clone, repositoryStories),
      { [storyStackPath(initiativeId)]: contents },
      `[${initiativeId}][stack] synchronize Story merge sequence`
    );
    publications.push({ repository: repositoryId, clone, ...publication });
  }
  return { stack, publications };
}

function readAtRef(root, ref, file) {
  const result = run('git', ['show', `${ref}:${file}`], { cwd: root, allowFailure: true });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try { return JSON.parse(result.stdout); }
  catch { throw new SingularityFlowError(`Published Story stack at ${ref}:${file} is not valid JSON.`); }
}

export async function publishedStackForStory(root, config, workflow) {
  const seed = await readStorySeed(root, workflow);
  const initiativeId = seed?.initiative?.id;
  if (!initiativeId) return null;
  const file = storyStackPath(initiativeId);
  const remote = config.ledger?.remote ?? config.git?.remote ?? 'origin';
  const stateBranch = config.ledger?.branch ?? 'state';
  run('git', ['fetch', '--no-tags', remote, `+refs/heads/${stateBranch}:refs/remotes/${remote}/${stateBranch}`], { cwd: root, allowFailure: true });
  const stack = readAtRef(root, `${remote}/${stateBranch}`, file) ?? readAtRef(root, stateBranch, file);
  if (!stack) {
    throw new SingularityFlowError(`No synchronized merge stack exists for ${initiativeId}. Run 'singularity-flow stack sync --epic ${initiativeId}' from the lead repository before opening Story pull requests.`);
  }
  if (stack.schemaVersion !== STORY_STACK_SCHEMA_VERSION || stack.initiativeId !== initiativeId || !Array.isArray(stack.stories)) {
    throw new SingularityFlowError(`Published Story stack for ${initiativeId} has an unsupported shape.`);
  }
  const entry = stack.stories.find((story) => story.workId === workflow.workItem.id || story.id === workflow.workItem.id);
  if (!entry) throw new SingularityFlowError(`${workflow.workItem.id} is not present in the published merge stack for ${initiativeId}. Synchronize the stack from the lead repository.`);
  return stack;
}
