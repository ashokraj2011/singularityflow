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
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
// Copilot CLI (1.0.109) names a plugin's agents after the plugin: SFlow's reviewer arrives as
// "singularity-flow:sflow-source-reviewer" (live probe, 2026-11-12). Only SFlow's own plugin is read past its name:
// another plugin's agent of the same name is not SFlow's.
const OWN_PLUGIN = 'singularity-flow:';

/** An agent name as SFlow knows it: SFlow's own plugin agents without the host's plugin prefix; anything else as is. */
export function ownAgentName(value) {
  if (typeof value !== 'string') return value;
  const name = value.trim();
  return name.startsWith(OWN_PLUGIN) ? name.slice(OWN_PLUGIN.length) : name;
}

/** The name of the agent a sub-agent payload belongs to, or null for the top-level chat. */
export function subagentName(payload = {}) {
  const value = [payload.agentType, payload.agent_type, payload.agentName, payload.agent_name]
    .find((entry) => typeof entry === 'string' && entry.trim());
  const name = ownAgentName(value);
  return name && NAME.test(name) ? name : null;
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

/*
 * VS Code's runSubagent (1.145, live 2026-11-11) runs the reviewer under the author's own session and names no agent
 * on any of its events: no SubagentStart, its task arrives as the prompt "/sf-review-source <step> …", and its calls
 * carry the author's session alone. Recorded as a prompt of that session, the reviewer's turn replaced the author's.
 * So the author's launch is noted beside the author's turn (`<session>.subagent.json`), the review's prompt that
 * follows it is recorded under the reviewer's own key, and every event of that session goes to the reviewer's turn
 * until the author's side shows again: the launcher call's own after-tool event (or its failure), the author's stop,
 * or a prompt that is not the review's. The author's turn is never touched. Copilot CLI's task gives the sub-agent a
 * session of its own, so its events never reach this.
 */
const LAUNCHERS = new Set(['runsubagent', 'run_subagent', 'task']);
const FRAME_MAX_AGE_MS = 30 * 60 * 1000;
const REVIEW_PROMPT = /^\s*\/sf(?:low)?-review-source(?:\s|$)/u;
const hasAgent = (payload) => [payload?.agentId, payload?.agent_id].some((value) => value != null && value !== '');
const sessionOf = (payload) => [payload?.sessionId, payload?.session_id].find((value) => typeof value === 'string' && value && value.length <= 200) ?? null;
const frameFile = (boundaries, session) => path.join(boundaries, `${createHash('sha256').update(session).digest('hex')}.subagent.json`);

/** The sub-agent launcher call a payload makes, as hosts spell it (VS Code runSubagent, Copilot CLI task), or null. */
function launcherCall(payload) {
  const calls = Array.isArray(payload?.toolCalls) ? payload.toolCalls
    : [{ name: payload?.toolName ?? payload?.tool_name, args: payload?.toolArgs ?? payload?.tool_input, id: payload?.toolCallId ?? payload?.tool_use_id }];
  for (const call of calls) {
    const name = String(call?.name ?? call?.toolName ?? '').toLowerCase().split(/[.:]|__/u).at(-1);
    if (!LAUNCHERS.has(name)) continue;
    let args = call.args ?? call.arguments ?? call.input ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    return { args: args && typeof args === 'object' ? args : {}, id: typeof call.id === 'string' ? call.id : null };
  }
  return null;
}

async function readFrame(file) {
  try {
    const frame = JSON.parse(await readFile(file, 'utf8'));
    return frame?.kind === 'reviewer-subagent' ? frame : null;
  } catch { return null; }
}

/** The author's turn launched its step's reviewer with the host's sub-agent tool: noted, so the review's prompt is known. */
export async function noteReviewerLaunch(payload, boundaries, now = Date.now()) {
  const session = sessionOf(payload);
  const call = !hasAgent(payload) && session ? launcherCall(payload) : null;
  if (!call) return;
  const agent = ownAgentName([call.args.agentName, call.args.agent_type, call.args.agentType, call.args.agent_name]
    .find((entry) => typeof entry === 'string' && entry.trim()));
  if (!REVIEW_PROMPT.test(String(call.args.prompt ?? '')) && !/reviewer/iu.test(String(agent ?? ''))) return;
  // Machine-local and short-lived (gone when the review's turn ends, at most 30 minutes on): its kind names it.
  const frame = { kind: 'reviewer-subagent', sessionId: session, launch: call.id,
    reviewerSessionId: reviewerSessionId(session, NAME.test(String(agent ?? '')) ? agent : 'reviewer'), at: now, started: false };
  await mkdir(boundaries, { recursive: true, mode: 0o700 });
  const temporary = `${frameFile(boundaries, session)}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(frame)}\n`, { mode: 0o600 });
  await rename(temporary, frameFile(boundaries, session));
}

/**
 * Where a top-level event of a session with a launched reviewer belongs. `event` is 'prompt', 'tool', 'after' (an
 * after-tool event or its failure) or 'stop'. Returns the payload to judge (under the reviewer's key while the review
 * runs), `reviewer` when it is the review's own prompt, and `ended`: the reviewer's key whose turn is over, for the
 * caller to end. Payloads naming an agent, and sessions with nothing launched, come back unchanged.
 */
export async function reviewerFramePayload(payload, boundaries, event, now = Date.now()) {
  const session = sessionOf(payload);
  if (!session || hasAgent(payload)) return { payload };
  const file = frameFile(boundaries, session);
  const frame = await readFrame(file);
  if (!frame || frame.sessionId !== session) return { payload };
  const end = async () => { await rm(file, { force: true }); return { payload, ended: frame.reviewerSessionId }; };
  if (!(now - frame.at >= 0 && now - frame.at <= FRAME_MAX_AGE_MS)) return end();
  const routed = () => {
    const { session_id: ignored, ...rest } = payload;
    return { payload: { ...rest, sessionId: frame.reviewerSessionId, authorSessionId: session } };
  };
  if (event === 'prompt') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    if (!frame.started && REVIEW_PROMPT.test(prompt)) {
      await writeFile(file, `${JSON.stringify({ ...frame, started: true, at: now })}\n`, { mode: 0o600 });
      return { ...routed(), reviewer: true };
    }
    // A stop continuation of the review's own turn stays with it; any other prompt is the author's (or the person's).
    if (frame.started && prompt.startsWith('SFLOW_SOURCE_REVIEW_INCOMPLETE:')) return routed();
    return end();
  }
  const launcher = launcherCall(payload);
  const ownLaunch = launcher && (!frame.launch || !launcher.id || launcher.id === frame.launch);
  if (event === 'stop' || (event === 'after' && ownLaunch)) return end();
  return frame.started ? routed() : { payload };
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
