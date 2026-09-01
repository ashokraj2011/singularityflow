/** AUT v2 read-first entry modes that bind existing authority without inventing it. */
import path from 'node:path';

import { adhocStatus } from '../adhoc/session.mjs';
import { branch, gitCommonDir } from '../git.mjs';
import { activeGoalWorkspace, findGoal, readGoalState } from '../goals.mjs';
import { loadGovernedGoal } from '../governed-goals.mjs';
import {
  buildRepositoryChangeSet, verifyRepositoryChangeSetIntegrity
} from '../repository-change-set.mjs';
import { recordSha256 } from '../records.mjs';
import { loadStoryAggregate } from '../state-stores.mjs';
import { SingularityFlowError } from '../util.mjs';

function digest(value) { return `sha256:${recordSha256(value)}`; }

function fail(message, code, details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

function exactProjection(value) {
  const core = {
    schemaVersion: 1, // schema-transient: deterministic read-only proposal, never persisted or authorized
    ...value
  };
  return Object.freeze({ ...core, proposalSha256: digest(core) });
}

function repositoryAuthority(root) {
  return path.resolve(gitCommonDir(root));
}

async function goalContextFor(root, options = {}) {
  const context = options.context ?? await activeGoalWorkspace({
    env: options.env ?? process.env,
    home: options.home
  });
  if (repositoryAuthority(context.repositoryPath) !== repositoryAuthority(root)) {
    fail(
      `Goal seeding is bound to selected workspace repository '${context.selected.repositoryId}', not the current repository.`,
      'AUTO_GOAL_REPOSITORY_MISMATCH',
      {
        selectedRepository: context.selected.repositoryId,
        nextAction: 'Select the intended workspace repository, then create a new Auto Plan.'
      }
    );
  }
  return context;
}

/** Resolve one personal or governed Goal into immutable Plan input. No Goal or Story is mutated. */
export async function resolveAutoGoalSeed(root, goalId, options = {}) {
  const id = String(goalId ?? '').trim().toUpperCase();
  if (!id) fail('Goal-seeded Auto planning requires --goal <GOAL-ID>.', 'AUTO_GOAL_REQUIRED');
  const context = await goalContextFor(root, options);
  if (id.startsWith('GEX-')) {
    const loaded = loadGovernedGoal(context, id, {
      config: options.definition ?? {}, refresh: options.refresh !== false
    });
    if (['achieved', 'abandoned', 'cancelled'].includes(loaded.state.status)) {
      fail(`Governed Goal '${id}' is ${loaded.state.status} and cannot seed new work.`, 'AUTO_GOAL_NOT_ACTIVE');
    }
    return Object.freeze({
      goalId: id,
      requirement: loaded.contract.outcome.statement,
      acceptanceCriteria: loaded.contract.criteria.map((criterion) => criterion.statement),
      source: Object.freeze({
        kind: 'goal', authority: loaded.contract.authority, goalId: id,
        goalSha256: digest(loaded.contract),
        contractSha256: loaded.contract.contractSha256,
        workspaceId: loaded.contract.workspace.id,
        repositoryId: context.selected.repositoryId
      })
    });
  }
  const loaded = await readGoalState(context);
  const goal = findGoal(loaded.state, id, { activeOnly: true });
  return Object.freeze({
    goalId: goal.id,
    requirement: goal.statement,
    acceptanceCriteria: [...goal.successCriteria],
    source: Object.freeze({
      kind: 'goal', authority: 'personal-advisory', goalId: goal.id,
      goalSha256: digest(goal), workspaceId: context.workspace.id,
      repositoryId: context.selected.repositoryId
    })
  });
}

/** Re-read Goal authority before ratification so a stale Goal can never authorize a flight. */
export async function assertAutoRequirementSourceCurrent(root, source, options = {}) {
  if (!source || source.kind !== 'goal') return { valid: true };
  let current;
  try {
    current = await resolveAutoGoalSeed(root, source.goalId, options);
  } catch (error) {
    throw new SingularityFlowError(
      `Auto Plan Goal source '${source.goalId}' is no longer available in its reviewed state.`,
      { code: 'AUTO_GOAL_SOURCE_STALE', details: { goalId: source.goalId }, cause: error }
    );
  }
  const changed = [
    current.source.goalSha256 !== source.goalSha256 ? 'Goal content changed' : null,
    current.source.workspaceId !== source.workspaceId ? 'Goal workspace changed' : null,
    current.source.repositoryId !== source.repositoryId ? 'selected repository changed' : null,
    current.source.authority !== source.authority ? 'Goal authority changed' : null
  ].filter(Boolean);
  if (changed.length) fail(
    `Auto Plan Goal source '${source.goalId}' is stale: ${changed.join(', ')}.`,
    'AUTO_GOAL_SOURCE_STALE',
    { goalId: source.goalId, changed, nextAction: 'Create and review a new Goal-seeded Auto Plan.' }
  );
  return { valid: true, goalSha256: source.goalSha256 };
}

function continuationAction(workflow, flight) {
  if (!flight) {
    if (workflow.executionOrigin?.mode === 'auto' && workflow.executionOrigin.flightId) {
      return {
        status: 'recovery-required',
        command: `singularity-flow auto recover ${workflow.workItem.id} --flight ${workflow.executionOrigin.flightId}`,
        reason: 'The Story declares an Auto origin, but its rebuildable operational projection is absent.'
      };
    }
    return {
      status: workflow.status === 'complete' ? 'complete' : 'new-plan-required',
      command: null,
      reason: workflow.status === 'complete'
        ? 'The Story is already complete.'
        : 'This Story has no ratified Auto origin. Attaching automation requires a new exact intake and governed origin transition.'
    };
  }
  if (flight.status === 'waiting-human') return {
    status: 'needs-human', command: `singularity-flow auto needs-you ${flight.flightId}`,
    reason: 'A typed Human Request must be answered explicitly; continue cannot answer it.'
  };
  if (flight.status === 'paused') return {
    status: 'ready-for-explicit-resume',
    command: `singularity-flow auto resume ${flight.flightId} --confirm ${flight.checkpointSha256}`,
    reason: 'The exact paused checkpoint can be reviewed and resumed explicitly.'
  };
  if (flight.status === 'recovery-required') return {
    status: 'recovery-required',
    command: `singularity-flow auto recover ${workflow.workItem.id} --flight ${flight.flightId}`,
    reason: 'Recovery must rebuild and verify the governed boundary before execution.'
  };
  return {
    status: flight.status,
    command: ['completed', 'cancelled', 'halted'].includes(flight.status)
      ? null : `singularity-flow auto status ${flight.flightId}`,
    reason: ['completed', 'cancelled', 'halted'].includes(flight.status)
      ? `The flight is ${flight.status}; a new Plan is required for additional work.`
      : 'The flight already has an exact operational owner; continue reports it without invoking execution.'
  };
}

/** Read an existing Story and return one exact next-segment proposal without continuing it. */
export async function buildAutoContinuationProposal(root, definition, workId) {
  const id = String(workId ?? '').trim();
  const workflow = await loadStoryAggregate(root, definition, id);
  // Keep Goal-source revalidation independent of the flight-store -> continuation -> Plan cycle.
  const { autoFlightProductProjection, findAutoFlightForStory } = await import('./auto-p1-control.mjs');
  let flight = null;
  try { flight = await findAutoFlightForStory(root, id); }
  catch (error) {
    if (error?.code !== 'AUTO_STORY_FLIGHT_NOT_FOUND') throw error;
  }
  if (flight && workflow.executionOrigin?.flightId
      && workflow.executionOrigin.flightId !== flight.flightId) {
    fail(`Story '${id}' and Auto flight '${flight.flightId}' have different execution origins.`,
      'AUTO_FLIGHT_BINDING_MISMATCH');
  }
  const proposal = autoContinuationProjection(workflow, flight);
  return {
    proposal,
    flight,
    projection: flight ? await autoFlightProductProjection(root, flight.flightId) : null
  };
}

/** Pure deterministic projection used by every continuation surface. */
export function autoContinuationProjection(workflow, flight = null) {
  const action = continuationAction(workflow, flight);
  return exactProjection({
    kind: 'auto-continuation-proposal', mode: 'auto', entryMode: 'existing-story',
    story: {
      workId: workflow.workItem.id, status: workflow.status,
      currentPhase: workflow.currentPhase ?? null,
      workflowSha256: digest(workflow),
      executionOrigin: workflow.executionOrigin ?? null
    },
    flight: flight ? {
      flightId: flight.flightId, status: flight.status, checkpointSha256: flight.checkpointSha256,
      planId: flight.planId, planSha256: flight.planSha256
    } : null,
    proposal: action,
    effects: { approvals: 0, resumes: 0, mutations: 0 }
  });
}

/**
 * Build a byte-exact Ad Hoc promotion handoff. The current Story profile cannot safely copy dirty
 * effects into a managed Story worktree, so this is explicitly non-startable rather than relabeling
 * those effects as model-authored Auto work.
 */
export async function buildAdhocAutoHandoff(root, sessionId) {
  const status = await adhocStatus(root, sessionId);
  const { session, baseline, changeSet, intent, disposition } = status;
  if (!changeSet || !intent) fail(
    `Ad Hoc session '${session.sessionId}' needs an observed effect set and confirmed intent before Auto promotion.`,
    'AUTO_ADHOC_CONFIRMATION_REQUIRED',
    { nextAction: `Review and confirm the intent for ${session.sessionId}, then repeat auto adopt.` }
  );
  if (intent.changeSetSha256 !== changeSet.changeSetSha256
      || intent.provenance?.kind !== 'discovered-at-landing') {
    fail(`Ad Hoc session '${session.sessionId}' has stale or unsupported intent provenance.`,
      'AUTO_ADHOC_PROVENANCE_INVALID');
  }
  const integrity = verifyRepositoryChangeSetIntegrity(changeSet.repositoryChangeSet);
  if (!integrity.valid) fail(`Ad Hoc session '${session.sessionId}' has a corrupt effect-set receipt.`,
    'AUTO_ADHOC_CHANGE_SET_INVALID', { entryFailures: integrity.entryFailures });
  const current = await buildRepositoryChangeSet(root, {
    baseCommit: baseline.revision.gitCommit,
    subject: { kind: 'adhoc', id: session.sessionId }
  });
  if (current.digest !== changeSet.repositoryChangeSet.digest) fail(
    `Ad Hoc session '${session.sessionId}' changed after intent confirmation.`,
    'AUTO_ADHOC_CHANGE_SET_STALE',
    { expected: changeSet.repositoryChangeSet.digest, actual: current.digest }
  );
  if (branch(root) !== session.branch) fail(
    `Ad Hoc session '${session.sessionId}' belongs to branch '${session.branch}', not '${branch(root)}'.`,
    'AUTO_ADHOC_CONTEXT_MISMATCH');

  const handoff = exactProjection({
    kind: 'auto-adoption-handoff', mode: 'auto', entryMode: 'adhoc-promotion',
    source: {
      sessionId: session.sessionId,
      origin: 'pre-auto-adhoc',
      intentProvenance: 'discovered-at-landing',
      sessionSha256: session.sessionSha256,
      baselineSha256: baseline.baselineSha256,
      changeSetSha256: changeSet.changeSetSha256,
      repositoryChangeSetSha256: current.digest,
      intentSha256: intent.intentSha256,
      dispositionSha256: disposition?.mapSha256 ?? null
    },
    preserved: {
      branch: session.branch,
      baselineCommit: baseline.revision.gitCommit,
      resources: changeSet.resources.map((resource) => ({
        resourceId: resource.resourceId, operation: resource.operation,
        resourceSha256: resource.resourceSha256
      }))
    },
    requirement: {
      text: intent.objective,
      acceptanceCriteria: intent.successCriteria.map((criterion) => criterion.text)
    },
    safety: {
      startable: false,
      reasons: [
        'Story-profile Auto cannot yet materialize confirmed dirty Ad Hoc effects in its managed worktree without changing their provenance.',
        'The handoff must remain pre-auto-adhoc; it cannot be relabelled as Auto-generated.'
      ]
    },
    nextAction: `singularity-flow adhoc promote ${session.sessionId}`,
    effects: { approvals: 0, stories: 0, flights: 0, repositoryWrites: 0 }
  });
  return { handoff, status };
}
