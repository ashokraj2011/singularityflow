/**
 * The reviewer runs in the author's own chat, as a sub-agent [review level 2, same-chat review] (owner, 2026-11-11).
 *
 * After /sf-phase or /sf-code publishes a step that owes its review, the author's turn starts the Story's pinned
 * read-only reviewer with the host's `task` tool (`agent_type` the reviewer, `prompt` the review's task): the
 * Copilot CLI and VS Code's Copilot agent host both launch a sub-agent that way (SF Guard G0 probe, SPEC-SFG §1.1).
 * The host's subagentStart hook (agent-start) then gives that sub-agent a turn of its own, under the same
 * read-only-review contract a `/sf-review-source` chat gets, recorded beside the author's chat and named after it
 * (`reviewerSessionId`). The host names the sub-agent on each of its own calls (`agentType`, or `agent_type`) and
 * the chat that started it (`parentAgentId`, the author's session; the sub-agent's calls carry a session of their
 * own), so the guard checks the reviewer's calls under the reviewer's contract while the author's turn keeps its
 * own. A sub-agent's task text never replaces the author's turn.
 *
 * The retained review returns to the author's turn: its status names the way on in the same chat (a correction
 * opens the step's next generation through the reviewed rollover; a ready review goes to submission). A host with
 * no sub-agent tool runs the review in a new chat, as before. Nothing here decides for a person.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** The name of the agent a sub-agent payload belongs to, or null for the top-level chat. */
export function subagentName(payload = {}) {
  const value = [payload.agentType, payload.agent_type, payload.agentName, payload.agent_name]
    .find((entry) => typeof entry === 'string' && entry.trim());
  return value && NAME.test(value.trim()) ? value.trim() : null;
}

/** The session id a reviewer sub-agent's turn is recorded under: the author's chat, and the reviewer's name. */
export function reviewerSessionId(sessionId, agent) {
  return typeof sessionId === 'string' && sessionId && sessionId.length <= 200 && NAME.test(String(agent ?? ''))
    ? `${sessionId}#agent:${agent}` : null;
}

/** The author's chat a sub-agent payload belongs to: the parent session the host names, else its own session. */
export function authorSession(payload = {}) {
  const value = [payload.parentAgentId, payload.parent_agent_id, payload.sessionId, payload.session_id]
    .find((entry) => typeof entry === 'string' && entry);
  return value ?? null;
}

/**
 * A reviewer sub-agent's own call, guarded as the reviewer's turn when agent-start recorded one for it in the author's
 * chat; every other payload unchanged. `boundaries` is the directory turn records live in.
 */
export function reviewerSubagentPayload(payload, boundaries) {
  if (!payload || typeof payload !== 'object' || ![payload.agentId, payload.agent_id].some((value) => value != null && value !== '')) return payload;
  const agent = subagentName(payload);
  const id = reviewerSessionId(authorSession(payload), agent);
  if (!id || !existsSync(path.join(boundaries, `${createHash('sha256').update(id).digest('hex')}.json`))) return payload;
  const { session_id: ignored, ...rest } = payload;
  return { ...rest, sessionId: id, authorSessionId: authorSession(payload) };
}

/**
 * What a publication that owes its review hands the author's turn: start the pinned reviewer as a sub-agent in
 * this chat, then read the retained review's status once and follow its route here. Without a sub-agent tool, the
 * review runs in a new chat.
 */
export function reviewSubagentHandoff({ workId, phase, generation, reviewerAgent }) {
  if (!workId || !phase || !NAME.test(String(reviewerAgent ?? ''))) return null;
  const prompt = `/sf-review-source ${phase}`;
  const status = `singularity-flow review-source status ${phase} --work-id ${workId} --for-agent --json`;
  return {
    agent: reviewerAgent, phase, generation, prompt, reviewStatus: status,
    instruction: `Start the independent reviewer of ${phase} generation ${generation} now, in this chat: run agent '${reviewerAgent}' as a sub-agent `
      + `with the task tool: agent_type '${reviewerAgent}', prompt '${prompt}' (VS Code's Copilot agent and the Copilot CLI alike). `
      // Started with mode 'background', the host said "tell the user you're waiting and end your response", and the
      // author ended its turn on /sf-review-source while the reviewer ran (Story anu-bin, 2026-11-11).
      + `Run it in the foreground and wait for its result (mode 'sync' where the tool has one, never 'background'). `
      // "wait for its completion notice" named no way to wait, beside a host that said to end the response (agent-text audit, 2026-11-11).
      + `If a host starts it in the background anyway: read or wait for that agent's result with the host's own tool when it has one; if ending your response is the only way to wait, end it saying only that the review is running and continues here when it returns, with no route or skill. `
      + `Its review is this turn's work: never offer ${prompt} while it runs, and never end the turn before it returns but as just said. It reviews read-only and retains its report; do not review, edit or retain it yourself. When it returns, run ${status} once and follow its route here: `
      // The author ended its turn on "/sf-phase" after a correction, leaving the person to start it again (Story anu-bin, 2026-11-11).
      + `a correction: show the person its findings and ask now with ask_user whether to correct them in generation ${generation + 1}; on yes, run the route's command and correct the draft in this same turn, then prepublish; never end the turn on that route. `
      + 'A ready review goes to submission. '
      + `No sub-agent tool: end with "Run this in a new chat:" and ${prompt}.`
  };
}

/**
 * subagentStart (agent-start): the Story's pinned reviewer, started as a sub-agent while its step's published
 * generation waits for review, gets its own `/sf-review-source` turn in this chat, so its calls are checked under
 * the read-only-review contract. Null for any other agent, or when no review is waiting: the agent is then mapped
 * as before. The author's turn is left as it is.
 */
export async function reviewerSubagentStart(root, payload = {}) {
  const agent = subagentName(payload);
  const parent = authorSession(payload);
  if (!agent || typeof parent !== 'string' || !parent) return null;
  let workflow;
  try { ({ workflow } = await (await import('./accepted-story-execution.mjs')).loadAcceptedStoryExecution(root)); }
  catch { return null; }
  if (workflow?.resolution?.sourceReview?.reviewerAgent !== agent) return null;
  const phase = workflow.phases?.[workflow.currentPhase];
  const [{ sourceReviewRequired }, { phaseNeedsGeneration }] = await Promise.all([import('./source-review-policy.mjs'), import('./sequence.mjs')]);
  if (!phase || phase.status !== 'in_progress' || !(Number(phase.generation) > 0) || !sourceReviewRequired(workflow, phase.id)
      || phaseNeedsGeneration(workflow, phase)) {
    return { additionalContext: `SFlow: no published step of ${workflow.workItem.id} is waiting for its review, so this reviewer has nothing to review. Say so to the author and stop.` };
  }
  const id = reviewerSessionId(parent, agent);
  if (!id) return null;
  const { recordRepositoryBoundaryTurn } = await import('./copilot-repository-boundary.mjs');
  const turn = await recordRepositoryBoundaryTurn({ sessionId: id, cwd: root, prompt: `/sf-review-source ${phase.id}` },
    { reviewerSubagent: true }).catch(() => ({}));
  return { additionalContext: [`SFlow: you are the independent read-only reviewer of ${workflow.workItem.id} ${phase.id} generation ${phase.generation}, `
    + `in the author's chat. Your calls are checked under your own review contract, not the author's. Run singularity-flow review-source context ${phase.id} --for-agent --json `
    + 'and follow its reviewGuide: write the report at its stagingPath, check it, retain it. Never edit code, artifacts or tests, submit or approve. '
    + 'End by returning the retained status to the author.', turn?.additionalContext].filter(Boolean).join(' ') };
}
