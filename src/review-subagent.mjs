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
 * opens the step's next generation through the reviewed rollover; a ready review is submitted in the same turn). A host with
 * no sub-agent tool runs the review in a new chat, as before. Nothing here decides for a person.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { actionCommandLine } from './action-command-map.mjs';

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

// ------------------------------------------------------------------------------------ the qualified delegation adapter

/**
 * SPEC-OSA v1.1 §9, Stage 4 [OSA:REQ-052, AC-018]: an independent review is started only through a qualified delegation.
 * Each Copilot dispatch mode SFlow knows, with what makes it independent and the evidence it was qualified on. Any other
 * sub-agent tool is not a qualified reviewer start (the guard refuses it), and no other harness is ever a fallback.
 */
export const REVIEW_DISPATCH_MODES = Object.freeze({
  'copilot-cli-task': Object.freeze({ tools: Object.freeze(['task']), context: 'a sub-agent session of its own, given only the review prompt',
    attribution: 'the host names the reviewer agent on each of its calls; agent-start records its read-only-review turn',
    evidence: 'Copilot CLI 1.0.109, live probe 2026-11-12' }),
  'vscode-run-subagent': Object.freeze({ tools: Object.freeze(['runsubagent', 'run_subagent']), context: 'a sub-agent given only the review prompt, under the author\'s session',
    attribution: 'the launch is noted beside the author\'s turn and the review prompt opens the reviewer\'s own turn',
    evidence: 'VS Code 1.145, live 2026-11-11; same-chat review (owner, 2026-11-11)' })
});
/** The capability a host needs for the work command to start the review itself; without it the review waits for it. */
export const REVIEW_DELEGATION_CAPABILITY = 'independent-review-delegation';
export const REVIEW_DELEGATION_SCHEMA = 'sflow-review-delegation/v1';

/** The dispatch mode a sub-agent tool call is, or null when the tool is not a qualified reviewer start. */
export function reviewDispatchMode(toolName) {
  const name = String(toolName ?? '').toLowerCase().split(/[.:]|__/u).at(-1);
  return Object.entries(REVIEW_DISPATCH_MODES).find(([, mode]) => mode.tools.includes(name))?.[0] ?? null;
}

const digestOf = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/**
 * The delegation the work command starts the review through [§9]: the exact version and packet the reviewer reviews, a
 * fresh reviewer context (the review prompt alone, never the author's reasoning), its own read-only role and issued
 * staging only, and the identity its retained report must carry. The author keeps the author's role: starting a reviewer
 * grants it no reviewer, approver or person's authority. `fallback` is the supported route when no sub-agent tool is
 * there; `pending` is what holds when no qualified mode is available at all.
 */
export function reviewDelegation({ workId, phase, generation, reviewerAgent, reviewerSha256 = null }) {
  if (!workId || !phase || !NAME.test(String(reviewerAgent ?? '')) || !Number.isSafeInteger(Number(generation)) || Number(generation) < 1) return null;
  const version = Number(generation);
  // The review's packet and retention, as the action-to-command map names them [OSA:REQ-021].
  const review = (form) => actionCommandLine('start-review', form, { step: phase, workId });
  const binding = { workId, phase, version, role: 'reviewer', reviewer: { agent: reviewerAgent, sha256: reviewerSha256 ?? null },
    packet: { command: review('context'), version,
      rule: 'the report copies this packet\'s binding; a report for another version or another packet is refused at retention' },
    context: 'fresh: the review prompt alone, never the author\'s conversation', staging: 'the review packet\'s issued staging path only',
    report: { version, reviewer: reviewerAgent, retainedBy: review('retain') } };
  return { schema: REVIEW_DELEGATION_SCHEMA, status: 'delegate', binding, digest: digestOf(binding),
    modes: Object.keys(REVIEW_DISPATCH_MODES), parent: { role: 'author', gains: [] },
    fallback: { status: 'fresh-conversation', copilotCommand: `/sf-review-source ${phase}`, prerequisite: 'independent-context',
      words: `Run this in a new chat: /sf-review-source ${phase}. A new chat keeps the review independent of the conversation that wrote it.` },
    pending: { status: 'review-pending', capability: REVIEW_DELEGATION_CAPABILITY,
      words: `${phase} version ${version} waits for its independent review: this host has no qualified way to start it, so nothing was reviewed. It is reviewed in a new chat with /sf-review-source ${phase}, or on a host that has ${REVIEW_DELEGATION_CAPABILITY}.` } };
}

/**
 * Why a retained review does not answer the delegation `binding`, as `{ code, words }`, or null when it does: a report for
 * another version than the one delegated, or by another reviewer, is never this version's review [§9, AC-018].
 */
export function delegatedReportProblem(binding, retained) {
  if (!binding || !retained) return { code: 'REVIEW_DELEGATION_REPORT_MISSING', words: 'No review was retained for this delegation.' };
  if (Number(retained.generation) !== Number(binding.version)) return { code: 'REVIEW_DELEGATION_VERSION_MISMATCH',
    words: `The retained review is of version ${retained.generation}, not version ${binding.version} that was delegated; it does not count for it.` };
  const reviewer = retained.provenance?.reviewerAgentId ?? retained.reviewer ?? null;
  if (reviewer !== binding.reviewer.agent) return { code: 'REVIEW_DELEGATION_REVIEWER_MISMATCH',
    words: `The retained review is by ${reviewer ?? 'no named reviewer'}, not the pinned reviewer ${binding.reviewer.agent}.` };
  if (retained.provenance?.readOnly !== true) return { code: 'REVIEW_DELEGATION_NOT_READ_ONLY', words: 'The retained review was not made read-only.' };
  return null;
}

/** How a reviewer launch ended, from the host's after-tool result: completed, failed or cancelled; null when unknown. */
export function reviewDelegationOutcome(result) {
  const type = String(result?.resultType ?? result?.result_type ?? result?.status ?? '').toLowerCase();
  if (['success', 'completed', 'ok'].includes(type)) return 'completed';
  if (['rejected', 'denied', 'cancelled', 'canceled', 'aborted', 'interrupted', 'skipped'].includes(type)) return 'cancelled';
  if (['failure', 'failed', 'error'].includes(type)) return 'failed';
  return null;
}

/**
 * After-tool: the author's launch of its reviewer failed or was cancelled. The review stays pending, nothing was reviewed,
 * and the author is told the supported way on: the review in a new chat, never its own review [§9, OSA:REQ-052].
 * `failure`: the host's tool-failure event. Null for anything else.
 */
export function reviewDelegationAfter(payload, { failure = false } = {}) {
  const call = launcherCall(payload);
  if (!call || hasAgent(payload)) return null;
  const agent = ownAgentName([call.args.agentName, call.args.agent_type, call.args.agentType, call.args.agent_name]
    .find((entry) => typeof entry === 'string' && entry.trim()));
  const step = String(call.args.prompt ?? '').match(/^\s*\/sf(?:low)?-review-source(?:\s+([^\s]+))?/u);
  if (!step && !/reviewer/iu.test(String(agent ?? ''))) return null;
  const outcome = failure ? 'failed' : reviewDelegationOutcome(payload.toolResult ?? payload.tool_result ?? payload.tool_response);
  if (outcome !== 'failed' && outcome !== 'cancelled') return null;
  const phase = step?.[1] ?? '<step>';
  return { outcome, additionalContext: `SFlow: the reviewer of ${phase} did not run (${outcome}). Its review stays pending and nothing was reviewed. `
    + `Never review, stage or retain it yourself. Run this in a new chat: /sf-review-source ${phase} (a new chat keeps the review independent).` };
}

/**
 * What a publication that owes its review hands the author's turn: start the pinned reviewer as a sub-agent in
 * this chat, then read the retained review's status once and follow its route here. Without a sub-agent tool, the
 * review runs in a new chat. `delegation` is the qualified delegation it is started through (reviewDelegation).
 */
export function reviewSubagentHandoff({ workId, phase, generation, reviewerAgent, reviewerSha256 = null }) {
  if (!workId || !phase || !NAME.test(String(reviewerAgent ?? ''))) return null;
  const next = generation + 1;
  const prompt = `/sf-review-source ${phase}`;
  const status = actionCommandLine('start-review', 'status', { step: phase, workId });
  const delegation = reviewDelegation({ workId, phase, generation, reviewerAgent, reviewerSha256 });
  return {
    agent: reviewerAgent, phase, generation, prompt, reviewStatus: status, ...(delegation ? { delegation } : {}),
    instruction: `Start the independent reviewer of ${phase} generation ${generation} now, in this chat: run agent '${reviewerAgent}' as a sub-agent `
      + `with the task tool: agent_type '${reviewerAgent}', prompt '${prompt}' (VS Code's Copilot agent and the Copilot CLI alike). `
      // Started with mode 'background', the host said "tell the user you're waiting and end your response", and the
      // author ended its turn on /sf-review-source while the reviewer ran (Story anu-bin, 2026-11-11).
      + `Run it in the foreground and wait for its result (mode 'sync' where the tool has one, never 'background'). `
      // "wait for its completion notice" named no way to wait, beside a host that said to end the response (agent-text audit, 2026-11-11).
      + `If a host starts it in the background anyway: read or wait for that agent's result with the host's own tool when it has one; if ending your response is the only way to wait, end it saying only that the review is running and continues here when it returns, with no route or skill. `
      + `Its review is this turn's work: never offer ${prompt} while it runs, and never end the turn before it returns but as just said. It reviews read-only and retains its report; do not review, edit or retain it yourself. When it returns, run ${status} once and follow its route here: `
      // The author ended its turn on "/sf-phase" after a correction, leaving the person to start it again (Story anu-bin, 2026-11-11).
      // The person's yes starts the next version; asked in these words, a confirmed rollover is held to it (copilot-answer-binding.mjs).
      // Asked before its preview, the question came again after it, in the code step's own turn (Story new-ash-graph): one question, after the preview.
      // Only the reviewer has seen this version: its route (--review-findings) starts the next one itself, with an undo (owner, 2026-11-19).
      + `a correction: run the route's command first. With --review-findings (only the reviewer has seen this version) it starts version ${next} itself: say its one line and fix the findings in this same turn, asking nothing. `
      + `Otherwise it is a rollover preview: show the person its findings and ask once with ask_user the preview's question, "Start version ${next} to fix the review's findings?" (Yes, No); on yes, run the confirmation it returns and correct the draft in this same turn, then prepublish; never end the turn on that route. `
      // A ready review was handed to a /sf-submit turn of its own, one more turn per step that protected nothing (owner, 2026-11-19).
      + 'A ready review: run its do.shell (the submission) once, here in this turn, never a separate submit turn; then end with the next step it returns. '
      + `No sub-agent tool: end with "Run this in a new chat:" and ${prompt}.`
  };
}

/**
 * What SFlow tells a reviewer it started as the author's sub-agent, so its ending is SFlow's data, not the model's guess:
 * a review the person typed ends on the next step, and one the author's turn started returns its findings to that turn,
 * which asks the person there. A person's /sf-review-source dropped its next step as if it were a sub-agent (owner, 2026-11-16).
 */
export const REVIEWER_SUBAGENT_NOTE = 'SFlow: reviewDispatch: author-turn. The author\'s turn started this review as its sub-agent: end with the retained status and findings only; that turn shows the person the next step.';

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
    + 'and follow its reviewGuide: write the report at its stagingPath, check it, retain it. Never edit code, artifacts or tests, submit or approve.',
  REVIEWER_SUBAGENT_NOTE, turn?.additionalContext].filter(Boolean).join(' ') };
}
