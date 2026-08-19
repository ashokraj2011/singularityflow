/** Model-free, read-only governed Goal projections for gateway and MCP hosts. */
import { governedGoalImpact, governedGoalTrace, loadGovernedGoal } from '../../governed-goals.mjs';
import { loadConfig } from '../../state-stores.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, sflowResult } from '../result.mjs';

function repositoryRoot(root, operation) {
  if (!root) throw new SingularityFlowError(`${operation} requires the lead repository root.`, {
    code: 'GOVERNED_GOAL_GATEWAY_NO_ROOT'
  });
  return root;
}

async function loaded(root, args, operation) {
  const repository = repositoryRoot(root, operation);
  const config = await loadConfig(repository);
  return loadGovernedGoal({ leadRepositoryPath: repository }, args.goalId, { config });
}

function result(operation, current, data, recommendation = null) {
  return sflowResult({
    kind: 'read',
    operation: { id: operation, classification: 'read' },
    subject: { kind: 'goal', id: current.contract.id },
    outcome: {
      status: 'succeeded', messageId: 'gateway.read',
      slots: { goal: current.contract.id, status: current.state.status }
    },
    effects: noEffects(),
    why: [{
      code: 'goal.durable-execution', source: 'evidence',
      slots: { goal: current.contract.id, revision: current.revision.commit.slice(0, 12) }
    }],
    restState: 'informational',
    data: {
      authority: 'governed-execution',
      contract: current.contract,
      state: current.state,
      plan: current.plan,
      revision: current.revision.commit,
      ...(recommendation ? { recommendation } : {}),
      ...data
    }
  });
}

export async function governedGoalInspectPlanner({ root = null, arguments: args = {} } = {}) {
  const current = await loaded(root, args, 'goal.inspect');
  return result('goal.inspect', current, {});
}

export async function governedGoalImpactPlanner({ root = null, arguments: args = {} } = {}) {
  const current = await loaded(root, args, 'goal.impact');
  return result('goal.impact', current, { impact: governedGoalImpact(current, []) });
}

export async function governedGoalTracePlanner({ root = null, arguments: args = {} } = {}) {
  const current = await loaded(root, args, 'goal.trace');
  return result('goal.trace', current, {
    trace: governedGoalTrace(current, { criterionId: args.criterionId ?? null })
  });
}

export async function governedGoalNextPlanner({ root = null, arguments: args = {} } = {}) {
  const current = await loaded(root, args, 'goal.next');
  let recommendation;
  if (current.state.paused) recommendation = { action: 'resume', confirmation: 'explicit-only' };
  else if (!current.plan) recommendation = { action: 'plan', confirmation: 'explicit-only' };
  else if (!current.state.approvedPlan) recommendation = {
    action: 'approve-plan', confirmation: 'exact-confirm',
    generation: current.plan.generation, planSha256: current.plan.planSha256
  };
  else if (current.state.status === 'verifying') recommendation = { action: 'verify', confirmation: 'explicit-only' };
  else recommendation = { action: 'run-next', confirmation: 'explicit-only' };
  return result('goal.next', current, {}, recommendation);
}
