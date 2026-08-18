/** `sflow goal` — personal outcomes over, never instead of, governed work. */
import path from 'node:path';

import { head, localBranches, remoteBranches, repoRoot } from '../git.mjs';
import {
  RepositorySubjectIndex, buildRepositorySubjectIndex, buildRepositorySubjectIndexFromRefs
} from '../repository-subject-index.mjs';
import { loadConfig } from '../state-stores.mjs';
import {
  abandonGoal, activeGoalWorkspace, completeGoal, createGoal, findGoal, goalWorkspaceSummary,
  linkGoal, listGoals, readGoalState, selectGoal, unlinkGoal
} from '../goals.mjs';
import {
  action, because, commandResult, effects, noEffects, noop, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  SingularityFlowError, optionBoolean, optionString, optionStrings
} from '../util.mjs';

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
  const root = repoRoot(path.join(context.workspace.path, configured.path));
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

async function resolveGovernedWork(context, {
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
  const selected = matches.find((item) => item.location?.source === 'working-tree') ?? matches[0];
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
    commit: selected.location?.commit ?? (selected.location?.source === 'working-tree' ? head(repository.root) : null)
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
    `Unknown goal subcommand '${subcommand}'. Available: create, list, show, status, next, use, link, unlink, complete, abandon.`,
    { code: 'UNKNOWN_SUBCOMMAND' }
  );
}
