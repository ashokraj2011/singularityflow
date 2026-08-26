/** `sflow goal` — personal outcomes over, never instead of, governed work. */
import path from 'node:path';

import { head, localBranches, remoteBranches, repoRoot } from '../git.mjs';
import {
  RepositorySubjectIndex, buildRepositorySubjectIndex, buildRepositorySubjectIndexFromRefs, resolveContext
} from '../repository-subject-index.mjs';
import { loadConfig } from '../state-stores.mjs';
import {
  abandonGoal, activeGoalWorkspace, completeGoal, createGoal, findGoal, goalWorkspaceSummary,
  linkGoal, listGoals, readGoalState, selectGoal, unlinkGoal
} from '../goals.mjs';
import {
  GOVERNED_GOAL_AUTHORITY, GOVERNED_GOAL_ID,
  abandonGovernedGoal, approveGovernedGoalPlan, compileGovernedGoalPlan,
  createGovernedGoal, governedGoalImpact, governedGoalTrace, listGovernedGoals,
  loadGovernedGoal, pauseGovernedGoal, proposalForGoal, resumeGovernedGoal,
  runGovernedGoalNext, syncGovernedGoal, verifyGovernedGoal
} from '../governed-goals.mjs';
import {
  action, because, commandResult, effects, noEffects, noop, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  SingularityFlowError, optionBoolean, optionString, optionStrings
} from '../util.mjs';
import { recordSha256 } from '../records.mjs';
import { workspaceRepositoryPath } from '../workspace.mjs';

function terminalStatus(state) {
  return ['complete', 'completed', 'cancelled', 'archived'].includes(String(state ?? '').toLowerCase());
}

function repositoryFor(context, repositoryId) {
  const id = String(repositoryId ?? context.selected.repositoryId).trim();
  const configured = context.workspace.repositories[id];
  if (!configured) {
    throw new SingularityFlowError(`Repository '${id}' is not part of workspace '${context.workspace.name}'.`, {
      code: 'GOAL_REPOSITORY_REQUIRED', details: { repositoryId: id }
    });
  }
  const root = repoRoot(workspaceRepositoryPath(context.workspace, configured));
  return { id, root };
}

function combinedIndex(working, references) {
  const index = new RepositorySubjectIndex();
  for (const source of [working, references]) {
    for (const subject of source.list()) {
      for (const location of subject.locations ?? [subject.location]) {
        index.add({
          ...subject,
          state: location?.state ?? subject.state,
          location: location ?? subject.location
        });
      }
    }
    index.unreadable.push(...source.unreadable);
    index.conflicts.push(...(source.conflicts ?? []));
  }
  return index;
}

async function subjectIndex(root) {
  const config = await loadConfig(root).catch(() => null);
  const remote = config?.git?.remote ?? 'origin';
  const refs = [
    ...remoteBranches(root, remote).map((branch) => ({ branch, ref: `${remote}/${branch}` })),
    ...localBranches(root).map((branch) => ({ branch, ref: branch }))
  ];
  return combinedIndex(
    await buildRepositorySubjectIndex(root),
    await buildRepositorySubjectIndexFromRefs(root, { refs })
  );
}

export async function resolveGovernedWork(context, {
  reference, kind = 'story', repositoryId = null, required = true, indexCache = null
} = {}) {
  if (!['story', 'initiative'].includes(kind)) {
    throw new SingularityFlowError("Linked work kind must be 'story' or 'initiative'.", {
      code: 'GOAL_SUBJECT_KIND_INVALID'
    });
  }
  const repository = repositoryFor(context, repositoryId);
  let indexed = indexCache?.get(repository.root);
  if (!indexed) {
    indexed = subjectIndex(repository.root);
    indexCache?.set(repository.root, indexed);
  }
  const index = await indexed;
  const matches = index.matches(reference, { kind });
  if (!matches.length) {
    const diagnostics = [...index.unreadable, ...(index.conflicts ?? [])]
      .filter((entry) => entry.claimedId === String(reference)
        || (!entry.path && entry.code !== 'REF_TREE_REF_MISSING'));
    if (diagnostics.length) {
      const unavailable = {
        kind, id: String(reference), repositoryId: repository.id, availability: 'unavailable',
        status: 'unknown', terminal: false, branch: null, title: String(reference), commit: null,
        diagnostics
      };
      if (!required) return unavailable;
      throw new SingularityFlowError(
        `Governed ${kind} '${reference}' may exist, but its state authority is unreadable or conflicting.`,
        { code: 'GOAL_SUBJECT_STATE_UNAVAILABLE', details: unavailable }
      );
    }
    if (!required) return {
      kind, id: String(reference), repositoryId: repository.id, availability: 'missing', status: 'unknown',
      terminal: false, branch: null, title: String(reference), commit: null
    };
    const unreadable = index.unreadable.length
      ? ` ${index.unreadable.length} state file(s) could not be read; run singularity-flow doctor.` : '';
    throw new SingularityFlowError(
      `No governed ${kind} matches '${reference}' in repository '${repository.id}'.${unreadable}`,
      { code: 'GOAL_SUBJECT_NOT_FOUND', details: { kind, reference, repositoryId: repository.id } }
    );
  }
  const ids = [...new Set(matches.map((item) => item.id))];
  if (ids.length > 1) {
    throw new SingularityFlowError(`Governed work reference '${reference}' is ambiguous: ${ids.join(', ')}.`, {
      code: 'GOAL_SUBJECT_AMBIGUOUS', details: { kind, reference, candidates: ids }
    });
  }
  const selected = resolveContext(index, { reference, kind });
  const diagnostics = [...index.unreadable, ...(index.conflicts ?? [])]
    .filter((entry) => entry.claimedId === selected.id
      || (entry.path && entry.path === selected.location?.path)
      || (!entry.path && entry.ref === selected.location?.ref));
  if (diagnostics.length) {
    const unavailable = {
      kind, id: selected.id, repositoryId: repository.id, availability: 'unavailable',
      status: 'unknown', terminal: false, branch: selected.canonicalBranch,
      title: selected.id, phase: null, commit: selected.location?.commit ?? null,
      diagnostics
    };
    if (!required) return unavailable;
    throw new SingularityFlowError(
      `Governed ${kind} '${selected.id}' has conflicting or unreadable state and cannot satisfy a Goal oracle.`,
      { code: 'GOAL_SUBJECT_STATE_UNAVAILABLE', details: unavailable }
    );
  }
  const state = selected.state;
  const status = state?.status ?? 'unknown';
  const work = kind === 'story' ? state?.workItem : state?.initiative;
  return {
    kind,
    id: selected.id,
    repositoryId: repository.id,
    availability: 'available',
    status,
    terminal: terminalStatus(status),
    branch: selected.canonicalBranch,
    title: work?.title ?? selected.id,
    phase: state?.currentPhase ?? null,
    commit: selected.location?.commit ?? (selected.location?.source === 'working-tree' ? head(repository.root) : null),
    observation: {
      ref: selected.location?.ref ?? null,
      commit: selected.location?.commit ?? (selected.location?.source === 'working-tree' ? head(repository.root) : null),
      path: selected.location?.path ?? null,
      stateSha256: `sha256:${recordSha256(state)}`,
      schemaVersion: state?.schemaVersion ?? null
    }
  };
}

async function resolveLinks(context, goal) {
  // A Goal may link several subjects in one monorepo. Index that repository once, not once per
  // link: a read-only Goal card must not multiply Git work by its number of rows.
  const indexCache = new Map();
  return Promise.all(goal.links.map((link) => resolveGovernedWork(context, {
    reference: link.id, kind: link.kind, repositoryId: link.repositoryId, required: false, indexCache
  }).catch(() => ({
    ...link, availability: 'missing', status: 'unknown', terminal: false, phase: null, commit: null
  }))));
}

async function resolveGovernedLinks(context, contract) {
  const indexCache = new Map();
  return Promise.all(contract.linkedWork.map((link) => resolveGovernedWork(context, {
    reference: link.id, kind: link.kind, repositoryId: link.repositoryId, required: false, indexCache
  }).catch(() => ({
    ...link, availability: 'missing', status: 'unknown', terminal: false, phase: null, commit: null
  }))));
}

function provenance(context) {
  return [because('goal.from-workspace-state', 'evidence', {
    ref: context.workspace.id,
    slots: { workspace: context.workspace.name },
    topic: 'goals-and-outcomes'
  })];
}

function nextActionFor(context, goal, links) {
  const active = links.find((link) => link.availability === 'available' && !link.terminal);
  if (active?.kind === 'story') {
    const alreadySelected = context.selected.repositoryId === active.repositoryId
      && context.selected.storyId === active.id;
    return {
      action: action({
        id: alreadySelected ? 'inspect-linked-story-next' : 'attach-linked-story',
        label: alreadySelected
          ? `See the next governed action for ${active.id}`
          : `Attach ${active.id} in repository ${active.repositoryId}`,
        command: alreadySelected
          ? `singularity-flow nextsteps ${active.id}`
          : `singularity-flow session workspace ${context.workspace.id} --repository ${active.repositoryId} --story ${active.id}`,
        rank: 'NOW', kind: 'workflow'
      }),
      skill: alreadySelected ? '/sf-nextsteps' : '/sf-session',
      linkedWork: active
    };
  }
  if (active?.kind === 'initiative') {
    return {
      action: action({
        id: 'inspect-linked-initiative-next',
        label: `See the next governed action for ${active.id}`,
        command: `singularity-flow initiative next ${active.id}`,
        rank: 'NOW', kind: 'workflow'
      }),
      skill: '/sf-initiative-next',
      linkedWork: active
    };
  }
  if (!goal.links.length) {
    return {
      action: action({
        id: 'link-governed-work',
        label: 'Link an existing Story or Initiative to this Goal',
        command: `singularity-flow goal link ${goal.id} <WORK-ID> --kind story`,
        rank: 'NOW', kind: 'workflow'
      }),
      skill: '/sf-goal',
      linkedWork: null
    };
  }
  if (links.some((link) => link.availability !== 'available')) {
    return {
      action: action({
        id: 'repair-goal-links',
        label: 'Review unavailable governed-work links',
        command: `singularity-flow goal show ${goal.id}`,
        rank: 'NOW', kind: 'remediation'
      }),
      skill: '/sf-goal',
      linkedWork: null
    };
  }
  return {
    action: action({
      id: 'complete-goal',
      label: 'Acknowledge that the Goal outcome was achieved',
      command: `singularity-flow goal complete ${goal.id} --confirm ${goal.id}`,
      rank: 'NOW', kind: 'workflow'
    }),
    skill: '/sf-goal',
    linkedWork: null
  };
}

function result(operation, context, {
  goal = null, outcome, changed = false, data = {}, next = [], restState = null
}) {
  return commandResult({
    operation: { id: operation.id, classification: operation.classification },
    subject: goal ? { kind: 'goal', id: goal.id } : { kind: 'workspace', id: context.workspace.id },
    outcome,
    effects: changed
      ? effects({ stateChanged: true, filesChanged: true })
      : noEffects(),
    why: provenance(context),
    next,
    restState,
    data: {
      workspace: goalWorkspaceSummary(context),
      authority: 'personal-advisory',
      activeGoalId: data.state
        ? data.state.activeGoalId ?? null
        : goal?.status === 'active' ? goal.id : null,
      ...data
    }
  });
}

function governedView(loaded) {
  return {
    id: loaded.contract.id,
    statement: loaded.contract.outcome.statement,
    status: loaded.state.status,
    authority: GOVERNED_GOAL_AUTHORITY,
    successCriteria: loaded.contract.criteria.map((criterion) => criterion.statement),
    criteria: loaded.contract.criteria,
    links: loaded.contract.linkedWork,
    assurance: loaded.state.assurance,
    planGeneration: loaded.state.planGeneration,
    planApproved: Boolean(loaded.state.approvedPlan)
  };
}

function governedResult(operation, context, loaded, {
  outcome, changed = false, declaredEffects = null, data = {}, next = [], restState = null
}) {
  return commandResult({
    operation: { id: operation.id, classification: operation.classification },
    subject: { kind: 'goal', id: loaded.contract.id },
    outcome,
    effects: declaredEffects ?? (changed
      ? effects({ stateChanged: true, filesChanged: true, publicationCreated: true }) : noEffects()),
    why: [because('goal.from-governed-repository', 'evidence', {
      ref: loaded.revision?.commit ?? loaded.publication?.commit ?? loaded.contract.contractSha256,
      slots: { goalId: loaded.contract.id }, topic: 'goals-and-outcomes'
    })],
    next,
    restState,
    data: {
      workspace: goalWorkspaceSummary(context),
      authority: GOVERNED_GOAL_AUTHORITY,
      goal: governedView(loaded),
      contract: loaded.contract,
      state: loaded.state,
      plan: loaded.plan ?? null,
      publication: loaded.publication ?? null,
      ...data
    }
  });
}

function governedReference(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return GOVERNED_GOAL_ID.test(normalized) ? normalized : null;
}

function governedRecommendation(loaded, links) {
  const id = loaded.contract.id;
  if (loaded.state.status === 'abandoned' || loaded.state.status === 'achieved') return null;
  if (loaded.state.paused) return action({
    id: 'resume-governed-goal', label: `Resume ${id}`,
    command: `singularity-flow goal resume ${id}`, rank: 'NOW', kind: 'workflow'
  });
  if (!loaded.plan) return action({
    id: 'compile-governed-goal-plan', label: 'Compile the deterministic Goal plan',
    command: `singularity-flow goal plan ${id}`, rank: 'NOW', kind: 'workflow'
  });
  if (!loaded.state.approvedPlan) return action({
    id: 'approve-governed-goal-plan', label: `Review and approve plan generation ${loaded.plan.generation}`,
    command: `singularity-flow goal plan approve ${id} --generation ${loaded.plan.generation} --confirm ${loaded.plan.planSha256}`,
    rank: 'NOW', kind: 'review'
  });
  if (loaded.state.status === 'verifying' || links.every((link) => link.terminal)) return action({
    id: 'verify-governed-goal', label: 'Evaluate the Goal success oracles',
    command: `singularity-flow goal verify ${id}`, rank: 'NOW', kind: 'workflow'
  });
  return action({
    id: 'run-governed-goal-next', label: 'Navigate one approved Goal step',
    command: `singularity-flow goal run-next ${id}`, rank: 'NOW', kind: 'workflow'
  });
}

function delegatedAction(step, live) {
  if (step.subject.kind === 'story') return action({
    id: `continue-${step.subject.id}`,
    label: `Continue ${step.subject.id}; its Story gates remain authoritative`,
    command: `singularity-flow session workspace --repository ${step.subject.repositoryId} --story ${step.subject.id}`,
    rank: 'NOW', kind: 'workflow'
  });
  return action({
    id: `inspect-${step.subject.id}`,
    label: `Continue Initiative ${step.subject.id}`,
    command: `singularity-flow initiative next ${live?.id ?? step.subject.id}`,
    rank: 'NOW', kind: 'workflow'
  });
}

function goalReference(positionals, index = 2) {
  return positionals[index] ?? null;
}

function linkArguments(positionals) {
  const args = positionals.slice(2);
  if (!args.length) throw new SingularityFlowError('Enter the governed Work ID to link.');
  if (args.length > 2) {
    throw new SingularityFlowError('Goal link and unlink accept at most a Goal ID and one governed Work ID.', {
      code: 'GOAL_ARGUMENTS_INVALID'
    });
  }
  return args.length === 1
    ? { goalId: null, workId: args[0] }
    : { goalId: args[0], workId: args[1] };
}

export async function run(_argv, { positionals, options, operation }) {
  const context = await activeGoalWorkspace();
  const subcommand = positionals[1] ?? 'list';
  const json = optionBoolean(options, 'json');

  if (subcommand === 'propose') {
    const statement = positionals.slice(2).join(' ');
    const workId = optionString(options, 'work-id');
    const links = workId ? [await resolveGovernedWork(context, {
      reference: workId,
      kind: optionString(options, 'kind', 'story'),
      repositoryId: optionString(options, 'repository')
    })] : [];
    const proposal = proposalForGoal(context, {
      statement, successCriteria: optionStrings(options, 'success'), links
    });
    const shell = `singularity-flow goal create ${JSON.stringify(proposal.outcome)}`
      + proposal.successCriteria.map((criterion) => ` --success ${JSON.stringify(criterion)}`).join('');
    return emitCommandResult(commandResult({
      operation: { id: operation.id, classification: operation.classification },
      subject: { kind: 'workspace', id: context.workspace.id },
      outcome: succeeded('goal.proposed', { workspace: context.workspace.name }),
      effects: noEffects(), why: provenance(context),
      next: [action({ id: 'create-personal-goal', label: 'Create the personal Goal before promotion', command: shell, rank: 'NOW', kind: 'workflow' })],
      data: { proposal, authority: GOVERNED_GOAL_AUTHORITY, workspace: goalWorkspaceSummary(context) }
    }), { json });
  }

  if (subcommand === 'govern') {
    const loadedPersonal = await readGoalState(context);
    const personal = findGoal(loadedPersonal.state, goalReference(positionals), { activeOnly: true });
    const config = await loadConfig(context.leadRepositoryPath);
    const created = await createGovernedGoal(context, personal, {
      id: optionString(options, 'id'), config
    });
    const loaded = { ...created, revision: { commit: created.publication.commit } };
    return emitCommandResult(governedResult(operation, context, loaded, {
      outcome: succeeded('goal.governed', { goalId: created.contract.id, personalGoalId: personal.id }),
      changed: true,
      next: [action({
        id: 'compile-governed-goal-plan', label: 'Compile the deterministic Goal plan',
        command: `singularity-flow goal plan ${created.contract.id}`, rank: 'NOW', kind: 'workflow'
      })]
    }), { json });
  }

  if (subcommand === 'list' && optionString(options, 'mode') === 'governed') {
    const config = await loadConfig(context.leadRepositoryPath);
    const listed = listGovernedGoals(context, { config });
    return emitCommandResult(commandResult({
      operation: { id: operation.id, classification: operation.classification },
      subject: { kind: 'workspace', id: context.workspace.id },
      outcome: succeeded('goal.governed-listed', { count: listed.goals.length, workspace: context.workspace.name }),
      effects: noEffects(), why: provenance(context), next: [],
      data: { ...listed, authority: GOVERNED_GOAL_AUTHORITY, workspace: goalWorkspaceSummary(context) }
    }), { json });
  }

  const nestedApproval = subcommand === 'plan' && positionals[2] === 'approve';
  const governedId = governedReference(nestedApproval ? positionals[3] : positionals[2]);
  if (governedId) {
    const config = await loadConfig(context.leadRepositoryPath);
    if (['inspect', 'show', 'status', 'next', 'impact', 'change', 'trace'].includes(subcommand)) {
      const loaded = loadGovernedGoal(context, governedId, { config });
      const links = await resolveGovernedLinks(context, loaded.contract);
      if (subcommand === 'impact' || subcommand === 'change') {
        const impact = governedGoalImpact(loaded, links);
        return emitCommandResult(governedResult(operation, context, loaded, {
          outcome: succeeded(subcommand === 'change' ? 'goal.change-proposed' : 'goal.impact-reported', { goalId: governedId }),
          data: { links, impact, readOnlyProposal: subcommand === 'change' },
          next: subcommand === 'change' ? [action({
            id: 'review-goal-contract', label: 'Review the current contract before creating a new plan generation',
            command: `singularity-flow goal inspect ${governedId}`, rank: 'NOW', kind: 'informational'
          })] : []
        }), { json });
      }
      if (subcommand === 'trace') {
        return emitCommandResult(governedResult(operation, context, loaded, {
          outcome: succeeded('goal.trace-reported', { goalId: governedId }),
          data: { trace: governedGoalTrace(loaded, { criterionId: optionString(options, 'criterion') }), links }
        }), { json });
      }
      const recommendation = governedRecommendation(loaded, links);
      return emitCommandResult(governedResult(operation, context, loaded, {
        outcome: succeeded(subcommand === 'next' ? 'goal.next' : 'goal.shown', {
          goalId: governedId, status: loaded.state.status, action: recommendation?.label ?? 'No further action'
        }),
        data: { links, recommendation }, next: recommendation ? [recommendation] : [],
        restState: loaded.state.status === 'achieved' ? 'complete' : loaded.state.status === 'abandoned' ? 'cancelled' : null
      }), { json });
    }

    if (subcommand === 'plan') {
      if (!nestedApproval) {
        const current = loadGovernedGoal(context, governedId, { config });
        const resolved = await resolveGovernedLinks(context, current.contract);
        const missing = resolved.filter((item) => item.availability !== 'available');
        if (missing.length) {
          throw new SingularityFlowError(
            `Governed Goal '${governedId}' cannot become ready because ${missing.map((item) => `${item.repositoryId}:${item.id}`).join(', ')} could not be resolved.`,
            { code: 'GOVERNED_GOAL_SUBJECT_UNRESOLVED', details: { missing } }
          );
        }
      }
      const changed = nestedApproval
        ? await approveGovernedGoalPlan(context, governedId, {
            config, generation: optionString(options, 'generation'), confirmation: optionString(options, 'confirm')
          })
        : await compileGovernedGoalPlan(context, governedId, { config, assisted: optionBoolean(options, 'assisted') });
      const loaded = { ...changed, revision: { commit: changed.publication.commit } };
      return emitCommandResult(governedResult(operation, context, loaded, {
        outcome: succeeded(nestedApproval ? 'goal.plan-approved' : 'goal.plan-compiled', {
          goalId: governedId, generation: changed.plan.generation, planSha256: changed.plan.planSha256
        }),
        changed: true,
        next: nestedApproval ? [action({
          id: 'run-governed-goal-next', label: 'Navigate one approved Goal step',
          command: `singularity-flow goal run-next ${governedId}`, rank: 'NOW', kind: 'workflow'
        })] : [action({
          id: 'approve-governed-goal-plan', label: 'Approve the exact plan hash',
          command: `singularity-flow goal plan approve ${governedId} --generation ${changed.plan.generation} --confirm ${changed.plan.planSha256}`,
          rank: 'NOW', kind: 'review'
        })]
      }), { json });
    }

    if (subcommand === 'run-next') {
      const current = loadGovernedGoal(context, governedId, { config });
      const links = await resolveGovernedLinks(context, current.contract);
      const changed = await runGovernedGoalNext(context, governedId, links, { config });
      const loaded = { ...changed, revision: { commit: changed.publication.commit } };
      const step = changed.value?.step;
      const next = step && !changed.value?.alreadyDelegated ? [delegatedAction(step, changed.value.live)]
        : changed.state.status === 'verifying' ? [action({
            id: 'verify-governed-goal', label: 'Evaluate the Goal success oracles',
            command: `singularity-flow goal verify ${governedId}`, rank: 'NOW', kind: 'workflow'
          })] : [];
      return emitCommandResult(governedResult(operation, context, loaded, {
        outcome: succeeded('goal.step-evaluated', { goalId: governedId, stepId: step?.id ?? 'complete' }),
        changed: true, data: { links, execution: changed.value }, next
      }), { json });
    }

    if (subcommand === 'run-until-blocked') {
      throw new SingularityFlowError(
        'Bounded governed Goal execution is intentionally unavailable. Use run-next; it stops at every underlying Story or Initiative boundary.',
        { code: 'GOVERNED_GOAL_BOUNDED_EXECUTION_UNAVAILABLE' }
      );
    }

    if (subcommand === 'sync') {
      const publication = await syncGovernedGoal(context, governedId, { config });
      const current = loadGovernedGoal(context, governedId, { config });
      const loaded = { ...current, publication };
      return emitCommandResult(governedResult(operation, context, loaded, {
        outcome: publication.changed
          ? succeeded('goal.synced', { goalId: governedId, commit: publication.commit })
          : noop('goal.already-synced', { goalId: governedId }),
        changed: publication.changed,
        declaredEffects: publication.changed ? effects({ publicationCreated: true }) : noEffects(),
        next: [action({ id: 'inspect-governed-goal', label: 'Inspect the published Goal', command: `singularity-flow goal inspect ${governedId}`, rank: 'NOW', kind: 'informational' })]
      }), { json });
    }

    if (subcommand === 'verify') {
      const current = loadGovernedGoal(context, governedId, { config });
      const links = await resolveGovernedLinks(context, current.contract);
      const changed = await verifyGovernedGoal(context, governedId, links, {
        config, criterionId: optionString(options, 'criterion')
      });
      const loaded = { ...changed, revision: { commit: changed.publication.commit } };
      return emitCommandResult(governedResult(operation, context, loaded, {
        outcome: succeeded('goal.verified', { goalId: governedId, assurance: changed.state.assurance }),
        changed: true, data: { links, verification: changed.value },
        restState: changed.state.status === 'achieved' ? 'complete' : null
      }), { json });
    }

    if (subcommand === 'pause') {
      const changed = await pauseGovernedGoal(context, governedId, { config, reason: optionString(options, 'reason') });
      const loaded = { ...changed, revision: { commit: changed.publication.commit } };
      return emitCommandResult(governedResult(operation, context, loaded, {
        outcome: succeeded('goal.paused', { goalId: governedId }), changed: true,
        next: [action({ id: 'resume-governed-goal', label: 'Resume when ready', command: `singularity-flow goal resume ${governedId}`, rank: 'LATER', kind: 'workflow' })]
      }), { json });
    }

    if (subcommand === 'resume') {
      const changed = await resumeGovernedGoal(context, governedId, { config });
      const loaded = { ...changed, revision: { commit: changed.publication.commit } };
      return emitCommandResult(governedResult(operation, context, loaded, {
        outcome: succeeded('goal.resumed', { goalId: governedId }), changed: true,
        next: [action({ id: 'inspect-governed-goal', label: 'Review the resumed Goal', command: `singularity-flow goal inspect ${governedId}`, rank: 'NOW', kind: 'informational' })]
      }), { json });
    }

    if (subcommand === 'abandon') {
      const changed = await abandonGovernedGoal(context, governedId, {
        config, confirmation: optionString(options, 'confirm'), reason: optionString(options, 'reason')
      });
      const loaded = { ...changed, revision: { commit: changed.publication.commit } };
      return emitCommandResult(governedResult(operation, context, loaded, {
        outcome: succeeded('goal.abandoned', { goalId: governedId }), changed: true, restState: 'cancelled'
      }), { json });
    }
  }

  if (subcommand === 'create') {
    const statement = positionals.slice(2).join(' ');
    const workId = optionString(options, 'work-id');
    const initialLink = workId ? await resolveGovernedWork(context, {
      reference: workId,
      kind: optionString(options, 'kind', 'story'),
      repositoryId: optionString(options, 'repository')
    }) : null;
    const created = await createGoal(context, {
      statement,
      successCriteria: optionStrings(options, 'success'),
      initialLink: initialLink ? {
        kind: initialLink.kind, id: initialLink.id, repositoryId: initialLink.repositoryId,
        branch: initialLink.branch, title: initialLink.title, linkedAt: new Date().toISOString()
      } : null
    });
    const links = initialLink ? [initialLink] : [];
    const recommendation = nextActionFor(context, created.goal, links);
    return emitCommandResult(result(operation, context, {
      goal: created.goal,
      outcome: succeeded('goal.created', { goalId: created.goal.id, statement: created.goal.statement }),
      changed: true,
      data: { goal: created.goal, state: created.state, links, recommendation },
      next: [recommendation.action]
    }), { json });
  }

  const loaded = await readGoalState(context);
  if (subcommand === 'list') {
    const goals = listGoals(loaded.state, optionString(options, 'status', optionBoolean(options, 'all') ? 'all' : 'active'));
    const next = loaded.state.activeGoalId
      ? [action({
          id: 'show-active-goal', label: 'Open the active Goal',
          command: `singularity-flow goal show ${loaded.state.activeGoalId}`, rank: 'NOW', kind: 'informational'
        })]
      : [action({
          id: 'create-goal', label: 'Create a Goal with observable success criteria',
          command: 'singularity-flow goal create "<OUTCOME>" --success "<OBSERVABLE SUCCESS>"',
          rank: 'NOW', kind: 'workflow'
        })];
    return emitCommandResult(result(operation, context, {
      outcome: succeeded('goal.listed', { count: goals.length, workspace: context.workspace.name }),
      data: { goals, state: loaded.state }, next
    }), { json });
  }

  if (['show', 'status'].includes(subcommand)) {
    const goal = findGoal(loaded.state, goalReference(positionals));
    const links = await resolveLinks(context, goal);
    const recommendation = goal.status === 'active' ? nextActionFor(context, goal, links) : null;
    return emitCommandResult(result(operation, context, {
      goal,
      outcome: succeeded('goal.shown', { goalId: goal.id, status: goal.status }),
      data: { goal, links, state: loaded.state, recommendation },
      next: recommendation ? [recommendation.action] : [],
      restState: recommendation ? null : goal.status === 'achieved' ? 'complete' : 'cancelled'
    }), { json });
  }

  if (subcommand === 'next') {
    const goal = findGoal(loaded.state, goalReference(positionals), { activeOnly: true });
    const links = await resolveLinks(context, goal);
    const recommendation = nextActionFor(context, goal, links);
    return emitCommandResult(result(operation, context, {
      goal,
      outcome: succeeded('goal.next', { goalId: goal.id, action: recommendation.action.label }),
      data: { goal, links, state: loaded.state, recommendation },
      next: [recommendation.action]
    }), { json });
  }

  if (subcommand === 'use') {
    const selected = await selectGoal(context, goalReference(positionals));
    const links = await resolveLinks(context, selected.goal);
    const recommendation = nextActionFor(context, selected.goal, links);
    return emitCommandResult(result(operation, context, {
      goal: selected.goal,
      outcome: selected.changed
        ? succeeded('goal.selected', { goalId: selected.goal.id })
        : noop('goal.already-selected', { goalId: selected.goal.id }),
      changed: selected.changed,
      data: { goal: selected.goal, links, state: selected.state, recommendation },
      next: [recommendation.action]
    }), { json });
  }

  if (subcommand === 'link') {
    const { goalId, workId } = linkArguments(positionals);
    const governed = await resolveGovernedWork(context, {
      reference: workId,
      kind: optionString(options, 'kind', 'story'),
      repositoryId: optionString(options, 'repository')
    });
    const linked = await linkGoal(context, goalId, {
      kind: governed.kind, id: governed.id, repositoryId: governed.repositoryId,
      branch: governed.branch, title: governed.title, linkedAt: new Date().toISOString()
    });
    const links = await resolveLinks(context, linked.goal);
    const recommendation = nextActionFor(context, linked.goal, links);
    return emitCommandResult(result(operation, context, {
      goal: linked.goal,
      outcome: linked.changed
        ? succeeded('goal.linked', { goalId: linked.goal.id, workId: governed.id })
        : noop('goal.already-linked', { goalId: linked.goal.id, workId: governed.id }),
      changed: linked.changed,
      data: { goal: linked.goal, links, state: linked.state, recommendation },
      next: [recommendation.action]
    }), { json });
  }

  if (subcommand === 'unlink') {
    const { goalId, workId } = linkArguments(positionals);
    const kind = optionString(options, 'kind', 'story');
    const unlinked = await unlinkGoal(context, goalId, {
      kind, id: workId, repositoryId: optionString(options, 'repository')
    });
    return emitCommandResult(result(operation, context, {
      goal: unlinked.goal,
      outcome: succeeded('goal.unlinked', { goalId: unlinked.goal.id, workId: unlinked.link.id }),
      changed: true,
      data: { goal: unlinked.goal, state: unlinked.state },
      next: [action({
        id: 'show-goal', label: 'Review the updated Goal',
        command: `singularity-flow goal show ${unlinked.goal.id}`, rank: 'NOW', kind: 'informational'
      })]
    }), { json });
  }

  if (subcommand === 'complete') {
    const goal = findGoal(loaded.state, goalReference(positionals), { activeOnly: true });
    const links = await resolveLinks(context, goal);
    const completed = await completeGoal(context, goal.id, {
      confirmation: optionString(options, 'confirm'),
      completionNote: optionString(options, 'note'),
      linkStates: links
    });
    return emitCommandResult(result(operation, context, {
      goal: completed.goal,
      outcome: succeeded('goal.completed', { goalId: completed.goal.id }),
      changed: true,
      data: { goal: completed.goal, links, state: completed.state },
      next: completed.state.activeGoalId ? [action({
        id: 'show-next-active-goal', label: 'Open the next active Goal',
        command: `singularity-flow goal show ${completed.state.activeGoalId}`, rank: 'NOW', kind: 'informational'
      })] : [],
      restState: completed.state.activeGoalId ? null : 'complete'
    }), { json });
  }

  if (subcommand === 'abandon') {
    const abandoned = await abandonGoal(context, goalReference(positionals), {
      confirmation: optionString(options, 'confirm'), reason: optionString(options, 'reason')
    });
    return emitCommandResult(result(operation, context, {
      goal: abandoned.goal,
      outcome: succeeded('goal.abandoned', { goalId: abandoned.goal.id }),
      changed: true,
      data: { goal: abandoned.goal, state: abandoned.state },
      next: abandoned.state.activeGoalId ? [action({
        id: 'show-next-active-goal', label: 'Open the next active Goal',
        command: `singularity-flow goal show ${abandoned.state.activeGoalId}`, rank: 'NOW', kind: 'informational'
      })] : [],
      restState: abandoned.state.activeGoalId ? null : 'cancelled'
    }), { json });
  }

  throw new SingularityFlowError(
    `Unknown goal subcommand '${subcommand}'. Available: create, list, show, status, next, use, link, unlink, complete, abandon, propose, govern, inspect, impact, plan, run-next, run-until-blocked, verify, change, pause, resume, sync, trace.`,
    { code: 'UNKNOWN_SUBCOMMAND' }
  );
}
