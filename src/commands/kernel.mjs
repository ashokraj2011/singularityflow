/**
 * The spine every command service shares.
 *
 * `cli.mjs` grew to 8,578 lines with 124 eager top-level imports, so running `sflow status` parsed
 * the whole product: 167 modules and 3 MB, including the Jira client, the editor snapshot layer and
 * every Initiative module, none of which `status` touches. Splitting the dispatcher into services
 * only helps if the services do not each drag the file back in behind them — so the handful of
 * helpers they genuinely share live here, in a module with almost no closure of its own.
 *
 * The bar for adding something: it is used by more than three command services, and it is small
 * enough that importing it costs nothing. Anything reached by one service belongs in that service.
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { identity } from '../git.mjs';
import { setAgentSession } from '../session.mjs';
import { currentPhase } from '../state-stores.mjs';
import { SingularityFlowError } from '../util.mjs';

/**
 * Where a Story records its parent lineage on the Jira issue.
 *
 * A property key rather than a field: fields differ per Jira project and a governed link must not
 * depend on how one team configured their board.
 */
export const STORY_LINEAGE_PROPERTY = 'com.singularity.flow.lineage';

/** The one-screen answer to "where is this work item". */
export function summary(workflow) {
  const active = currentPhase(workflow);
  console.log(`\n${workflow.workItem.id} — ${workflow.workItem.title}`);
  console.log(`Branch: ${workflow.workItem.branch}`);
  console.log(`World-model grounding: ${workflow.resolution?.worldModelGrounding ?? 'off'}`);
  console.log(`Status: ${workflow.status}`);
  console.log(`Current phase: ${active ? `${active.id} (${active.status})` : 'complete'}`);
  if (active) {
    console.log(`Governed agent: ${active.defaultAgent ?? 'unassigned'}`);
    console.log(`Required artifact: ${active.requiredArtifact?.path ?? 'none'}`);
    console.log(`Registered artifacts: ${active.artifacts.length}`);
  }
  if (workflow.sequenceOverrides?.length) console.warn(`Warning: ${workflow.sequenceOverrides.length} confirmed soft sequence override(s) are recorded for this work item.`);
}

/**
 * Who is acting.
 *
 * In Git-host automation the git identity is the runner, not a person, so an explicitly declared
 * actor wins — otherwise every governed decision made by automation would be attributed to a bot.
 */
export function actionActor(root) {
  return process.env.SINGULARITY_FLOW_GITHUB_ACTOR
    ? { name: process.env.SINGULARITY_FLOW_GITHUB_ACTOR, login: process.env.SINGULARITY_FLOW_GITHUB_ACTOR, email: null }
    : identity(root);
}

/** Typing the phase id to approve it. Deliberately not a y/n: approval should cost a moment. */
export async function confirm(phase) {
  if (!input.isTTY || !output.isTTY) throw new SingularityFlowError('Approval needs an interactive terminal or the explicit --yes flag.');
  const io = readline.createInterface({ input, output });
  try {
    const answer = await io.question(`Type ${phase.id} to approve ${phase.label}: `);
    return answer.trim() === phase.id;
  } finally {
    io.close();
  }
}

/**
 * The plan, plan hash and action a governed runner is executing under, or null when a person is
 * driving. Read from the environment because the runner sets it around the whole invocation.
 */
export function activeActionContext() {
  const planId = process.env.SINGULARITY_FLOW_ACTION_PLAN_ID;
  const planHash = process.env.SINGULARITY_FLOW_ACTION_PLAN_HASH;
  const actionId = process.env.SINGULARITY_FLOW_ACTION_ID;
  return planId && planHash && actionId ? { planId, planHash, actionId } : null;
}

/**
 * Put the phase's governed agent on the session.
 *
 * An override is allowed but never silent: the prompt is audited and the human approval authority is
 * unchanged, so the warning is the whole disclosure.
 */
export async function activatePhaseAgent(root, definition, workId, phase, requestedAgent = null) {
  const defaultAgent = phase?.defaultAgent
    ?? definition.agentCatalog?.find((agent) => agent.defaultFor.includes(phase?.id))?.id
    ?? null;
  const agent = requestedAgent ?? defaultAgent;
  if (!agent || !definition.agents?.[agent]) throw new SingularityFlowError(`Phase '${phase?.id ?? 'unknown'}' has no valid governed agent.`);
  const compatible = !phase?.id || !definition.agents[agent].phases.length || definition.agents[agent].phases.includes(phase.id);
  if (requestedAgent && !compatible) {
    console.warn(`Warning: agent '${requestedAgent}' is not declared for phase '${phase.id}'. Continuing with an audited prompt override; human approval authority is unchanged.`);
  }
  return setAgentSession(root, definition, actionActor(root), agent, workId, {
    phaseId: phase?.id ?? null,
    source: requestedAgent ? 'explicit-override' : 'phase-default'
  });
}
