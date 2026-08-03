import { loadDefinition, resolveWorkType } from './config.mjs';
import { addDocuments } from './documents.mjs';
import {
  assertClean,
  checkout,
  fastForwardTo,
  fetchRemote,
  identity,
  refExists
} from './git.mjs';
import { setAgentSession } from './session.mjs';
import {
  commitAndPublish,
  createWorkflow,
  loadWorkflow,
  validateId
} from './state.mjs';
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
  capabilityId = null,
  files = [],
  urls = []
} = {}) {
  const definition = await loadDefinition(root);
  validateId(definition, id);
  if (!definition.workTypes?.[workType]) throw new SingularityFlowError(`Unknown work type '${workType ?? ''}'.`);
  const resolved = resolveWorkType(definition, workType);
  const selectedAgent = agent ?? resolved.phases[0]?.defaultAgent;
  if (!definition.agents?.[selectedAgent]) throw new SingularityFlowError(`Work type '${workType}' has no default governed agent for its first phase.`);
  const normalizedSource = validateStorySource(source, id);
  const actor = identity(root);
  const remote = definition.git?.remote ?? 'origin';

  assertClean(root);
  fetchRemote(root, remote);
  const existed = refExists(root, `refs/heads/${id}`)
    || refExists(root, `refs/remotes/${remote}/${id}`);
  const checkoutMode = checkout(root, id, {
    base: definition.defaultBaseBranch,
    remote
  });

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
    baseBranch: definition.defaultBaseBranch,
    workType,
    agent: selectedAgent,
    resolved,
    capabilityId
  });
  const publication = await commitAndPublish(
    root,
    definition,
    workflow,
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
      `[${id}][documents][upload] ${added.map((item) => item.id).join(',')}`
    );
  }
  return {
    workId: id,
    resumed: false,
    checkoutMode,
    branch: id,
    workflow,
    publication,
    documents
  };
}
