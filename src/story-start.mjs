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
import { setPersonaSession } from './session.mjs';
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
 * The UI supplies explicit workflow/working-lens choices, so this function never
 * prompts and never invents defaults. It persists exactly the same workflow,
 * source, document, commit, and publication records as the CLI start command.
 */
export async function startStory(root, {
  id,
  source,
  workType,
  persona,
  files = [],
  urls = []
} = {}) {
  const definition = await loadDefinition(root);
  validateId(definition, id);
  if (!definition.workTypes?.[workType]) throw new SingularityFlowError(`Unknown work type '${workType ?? ''}'.`);
  if (!definition.personas?.[persona]) throw new SingularityFlowError(`Unknown working lens '${persona ?? ''}'.`);
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
    await setPersonaSession(root, definition, actor, persona, id);
    return {
      workId: id,
      resumed: true,
      checkoutMode,
      branch: id,
      workflow
    };
  }

  await setPersonaSession(root, definition, actor, persona, id);
  const workflow = await createWorkflow(root, definition, {
    id,
    title: normalizedSource.title,
    source: normalizedSource,
    baseBranch: definition.defaultBaseBranch,
    workType,
    persona,
    resolved: resolveWorkType(definition, workType)
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
