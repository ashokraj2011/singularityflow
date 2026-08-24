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
  validateId,
  workDirRelative
} from './state-stores.mjs';
import { SingularityFlowError } from './util.mjs';
import { normalizeMcpTargetOrigin } from './mcp-target.mjs';
import { writeReturnLocator } from './return-locator.mjs';
import { pinAcceptedChangeFlightPlan } from './change-flight-plan.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { pinAcceptedAutoPlan } from './auto/auto-origin.mjs';
import { runDraftTransaction } from './draft-unit-of-work.mjs';

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
  targetUrl = null,
  files = [],
  urls = [],
  expectedBaseCommit = null,
  flightPlan = null,
  auto = null
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
  // Reject incomplete POC intake while the caller is still on its original branch. Validation
  // after checkout remains below because the selected remote base owns the definitive workflow.
  const preflightTargetOrigin = normalizeMcpTargetOrigin(targetUrl ?? normalizedSource.targetOrigin, {
    required: !existed && workType === 'poc-workflow',
    label: 'POC target URL'
  });
  if (preflightTargetOrigin) normalizedSource.targetOrigin = preflightTargetOrigin;
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
      ? await preflightStoryRepositories(storyBase.workspaceRoot, storyBase.plan, id, {
          remote, publishRequired, lifecycleRoot: root, capabilityId: storyBase.capability
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
    if (expectedBaseCommit && baseCommit !== expectedBaseCommit) {
      throw new SingularityFlowError(
        `Selected base '${storyBase.localBase}' moved from accepted revision ${expectedBaseCommit.slice(0, 12)} to ${baseCommit.slice(0, 12)}. Nothing was changed.`,
        {
          code: 'CFP_PLAN_STALE',
          details: { expectedBaseCommit, actualBaseCommit: baseCommit, nextAction: `Refresh Change Flight Plan ${flightPlan?.planId ?? ''}.`.trim() }
        }
      );
    }
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
  const targetOrigin = normalizeMcpTargetOrigin(targetUrl ?? normalizedSource.targetOrigin, {
    required: !existed && workType === 'poc-workflow',
    label: 'POC target URL'
  });
  if (targetOrigin) normalizedSource.targetOrigin = targetOrigin;
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
  let workflow;
  let returnLocator;
  let publication;
  await runDraftTransaction(root, {
    subject: { kind: 'story', id, branch: id },
    allowedPaths: [workDirRelative(definition, id)],
    operation: 'story-start',
    write: async (creationPreimage) => {
      workflow = await createWorkflow(root, definition, {
        id,
        title: normalizedSource.title,
        source: normalizedSource,
        baseBranch: storyBase.localBase,
        baseCommit,
        baseRemote: remote,
        workType,
        agent: selectedAgent,
        resolved,
        capabilityId,
        executionOrigin: auto?.executionOrigin ?? null
      });
      if (flightPlan) await pinAcceptedChangeFlightPlan(root, definition, workflow, flightPlan);
      if (auto) await pinAcceptedAutoPlan(root, definition, workflow, auto);
      returnLocator = await writeReturnLocator(root, definition, workflow);
      publication = await commitAndPublish(
        root,
        definition,
        workflow,
        { type: LIFECYCLE_EVENT.BINDING },
        `[${id}][init] start ${workType} workflow`,
        [returnLocator.path],
        { recoveryPreimage: creationPreimage }
      );
      return { workflow, publication };
    }
  });
  const documents = [];
  if (files.length) {
    let added = [];
    await commitAndPublish(
      root,
      definition,
      workflow,
      { type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, payload: { operation: 'document-upload' } },
      `[${id}][documents][upload] governed evidence`,
      [],
      { beforeStateWrite: async () => { added = await addDocuments(root, definition, workflow, { files }); } }
    );
    documents.push(...added);
  }
  for (const url of urls) {
    let added = [];
    await commitAndPublish(
      root,
      definition,
      workflow,
      { type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, payload: { operation: 'document-upload' } },
      `[${id}][documents][upload] governed evidence`,
      [],
      { beforeStateWrite: async () => { added = await addDocuments(root, definition, workflow, { url }); } }
    );
    documents.push(...added);
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
    measurement: workflow.measurement?.plan ? {
      status: workflow.measurement.status,
      studyId: workflow.measurement.plan.studyId,
      studyRunId: workflow.measurement.plan.studyRunId ?? null,
      cohort: workflow.measurement.plan.groupId,
      promptVariant: workflow.measurement.plan.variantId ?? null
    } : { status: workflow.measurement?.status ?? 'not-enrolled' },
    ...(storyBase.scope === 'capability' ? {
      capabilityBase: {
        ...storyBase.plan.record,
        prepared: capabilityRepositoriesPrepared ?? []
      }
    } : {}),
    documents
  };
}
