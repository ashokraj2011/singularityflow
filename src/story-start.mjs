import { loadDefinition, resolveWorkType } from './config.mjs';
import { addDocuments } from './documents.mjs';
import {
  assertClean,
  checkout,
  fastForwardTo,
  fetchRemote,
  identity,
  preflightPushBranch,
  refExists,
  refHead
} from './git.mjs';
import {
  preflightStoryRepositories, prepareCapabilityRepositories, storyBaseForRepository
} from './capability-start.mjs';
import { setAgentSession } from './session.mjs';
import {
  commitAndPublish,
  createWorkflow,
  loadWorkflow,
  validateId
} from './state-stores.mjs';
import { SingularityFlowError } from './util.mjs';

function lines(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export function manualStorySource(id, input = {}) {
  const title = String(input.title ?? '').trim();
  if (!title) throw new SingularityFlowError('Enter a Story title before starting.');
  return {
    type: 'manual',
    id,
    key: null,
    url: null,
    title,
    user: String(input.user ?? input.audience ?? '').trim(),
    description: String(input.description ?? input.problem ?? '').trim(),
    desiredOutcome: String(input.desiredOutcome ?? input.outcome ?? '').trim(),
    scope: {
      in: lines(input.inScope),
      out: lines(input.outOfScope)
    },
    stakeholders: lines(input.stakeholders),
    urgency: String(input.urgency ?? '').trim(),
    constraints: lines(input.constraints),
    dependencies: lines(input.dependencies),
    acceptanceCriteria: lines(input.acceptanceCriteria),
    risks: lines(input.risks),
    notes: String(input.notes ?? '').trim(),
    epicId: String(input.parentEpicId ?? '').trim() || null
  };
}

function validateStorySource(source, id) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new SingularityFlowError('Story intake requires a source object.');
  }
  if (!String(source.title ?? '').trim()) {
    throw new SingularityFlowError('Story intake requires a title.');
  }
  return {
    ...structuredClone(source),
    type: source.type ?? 'manual',
    id: source.id ?? id,
    title: String(source.title).trim()
  };
}

/**
 * Desktop-safe Story start path.
 *
 * The UI supplies an explicit workflow choice. Its first phase selects the governed
 * agent deterministically, so this function never prompts or treats a role as user identity.
 * It persists exactly the same workflow,
 * source, document, commit, and publication records as the CLI start command.
 */
export async function startStory(root, {
  id,
  source,
  workType,
  agent,
  baseBranch = null,
  capabilityId = null,
  files = [],
  urls = []
} = {}) {
  const initialDefinition = await loadDefinition(root);
  validateId(initialDefinition, id);
  const normalizedSource = validateStorySource(source, id);
  const actor = identity(root);
  const remote = initialDefinition.git?.remote ?? 'origin';

  assertClean(root);
  const localExisted = refExists(root, `refs/heads/${id}`);
  if (!localExisted) fetchRemote(root, remote);
  const remoteExisted = refExists(root, `refs/remotes/${remote}/${id}`);
  const existed = localExisted || remoteExisted;
  let storyBase = null;
  let baseCommit = null;
  let capabilityRepositoriesPrepared = null;
  let checkoutMode;
  if (existed) {
    checkoutMode = checkout(root, id, {
      base: initialDefinition.defaultBaseBranch,
      fetch: remoteExisted,
      existingOnly: true,
      remote
    });
  } else {
    storyBase = await storyBaseForRepository(root, {
      values: baseBranch ? [baseBranch] : [],
      interactive: false,
      remote,
      defaultBranch: initialDefinition.defaultBaseBranch,
      capabilityId
    });
    const publishRequired = (initialDefinition.git?.publish ?? 'required') !== 'off';
    const capabilityPreflight = storyBase.scope === 'capability'
      ? preflightStoryRepositories(storyBase.workspaceRoot, storyBase.plan, id, {
          remote, publishRequired
        })
      : null;
    fetchRemote(root, remote);
    const remoteBaseRef = `refs/remotes/${remote}/${storyBase.localBase}`;
    if (!refExists(root, remoteBaseRef)) {
      throw new SingularityFlowError(
        `Selected base branch '${storyBase.localBase}' is no longer published by remote '${remote}'. Nothing was changed.`,
        { code: 'STORY_BASE_INVALID' }
      );
    }
    baseCommit = refHead(root, remoteBaseRef);
    if (publishRequired && !capabilityPreflight) {
      const dryRun = preflightPushBranch(root, remote, remoteBaseRef, id);
      if (dryRun.status !== 0) {
        throw new SingularityFlowError(
          `Cannot publish the new Story branch '${id}' to '${remote}'. `
          + `Git reported: ${(dryRun.stderr || dryRun.stdout || 'remote rejected the dry-run push').trim()} Nothing was changed.`,
          { code: 'STORY_PUBLICATION_PREFLIGHT_FAILED' }
        );
      }
    }
    checkoutMode = checkout(root, id, {
      base: storyBase.localBase,
      remote,
      preferRemoteBase: true
    });
    if (storyBase.scope === 'capability') {
      capabilityRepositoriesPrepared = prepareCapabilityRepositories(
        storyBase.workspaceRoot, storyBase.plan, id, { remote }
      );
    }
  }

  // The branch we just materialized is authoritative for new lifecycle configuration. Keeping the
  // definition loaded from the old checkout meant the files came from fresh remote main while the
  // pinned phase graph, agents, templates, and world-model policy came from stale local main.
  const definition = await loadDefinition(root);
  validateId(definition, id);
  if (!definition.workTypes?.[workType]) throw new SingularityFlowError(`Unknown work type '${workType ?? ''}'.`);
  const resolved = resolveWorkType(definition, workType);
  const selectedAgent = agent ?? resolved.phases[0]?.defaultAgent;
  if (!definition.agents?.[selectedAgent]) throw new SingularityFlowError(`Work type '${workType}' has no default governed agent for its first phase.`);

  if (existed) {
    // fetchRemote updated the remote-tracking ref; now advance an existing
    // local branch without merge commits before reading its durable state.
    if (refExists(root, `refs/remotes/${remote}/${id}`)) {
      fastForwardTo(root, `${remote}/${id}`);
    }
    let workflow;
    try {
      workflow = await loadWorkflow(root, definition, id);
    } catch (error) {
      throw new SingularityFlowError(
        `Branch '${id}' already exists but is not a Singularity Story work item. Choose another Work ID or attach the branch explicitly. ${error.message}`
      );
    }
    const resumedAgent = agent || workflow.phases?.[workflow.currentPhase]?.defaultAgent;
    if (!definition.agents?.[resumedAgent]) {
      throw new SingularityFlowError(`Story phase '${workflow.currentPhase}' has no valid governed agent.`);
    }
    await setAgentSession(root, definition, actor, resumedAgent, id, {
      phaseId: workflow.currentPhase,
      source: agent ? 'explicit-override' : 'phase-default'
    });
    return {
      workId: id,
      resumed: true,
      checkoutMode,
      branch: id,
      workflow
    };
  }

  await setAgentSession(root, definition, actor, selectedAgent, id, { phaseId: resolved.phases[0]?.id, source: agent ? 'explicit-override' : 'phase-default' });
  const workflow = await createWorkflow(root, definition, {
    id,
    title: normalizedSource.title,
    source: normalizedSource,
    baseBranch: storyBase.localBase,
    baseCommit,
    baseRemote: remote,
    workType,
    agent: selectedAgent,
    resolved,
    capabilityId
  });
  const publication = await commitAndPublish(
    root,
    definition,
    workflow,
    { type: 'binding' },
    `[${id}][init] start ${workType} workflow`
  );
  const documents = [];
  if (files.length) {
    const added = await addDocuments(root, definition, workflow, { files });
    documents.push(...added);
    await commitAndPublish(
      root,
      definition,
      workflow,
      { type: 'evidence-recorded', payload: { documents: added.map((item) => item.id) } },
      `[${id}][documents][upload] ${added.map((item) => item.id).join(',')}`
    );
  }
  for (const url of urls) {
    const added = await addDocuments(root, definition, workflow, { url });
    documents.push(...added);
    await commitAndPublish(
      root,
      definition,
      workflow,
      { type: 'evidence-recorded', payload: { documents: added.map((item) => item.id) } },
      `[${id}][documents][upload] ${added.map((item) => item.id).join(',')}`
    );
  }
  return {
    workId: id,
    resumed: false,
    checkoutMode,
    branch: id,
    workflow,
    base: {
      branch: storyBase.localBase,
      commit: baseCommit,
      remote
    },
    publication: {
      ...publication,
      remote,
      branch: id,
      ref: `refs/heads/${id}`,
      pushed: publication.pushed === true,
      commit: publication.sha
    },
    ...(storyBase.scope === 'capability' ? {
      capabilityBase: {
        ...storyBase.plan.record,
        prepared: capabilityRepositoriesPrepared ?? []
      }
    } : {}),
    documents
  };
}
