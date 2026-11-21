/**
 * `choices begin approve <WORK-ID> [--fetch] --json --review-packet`: everything `/sf-approve`
 * shows before the person's review, in one command.
 *
 * The skill ran submission readiness, then `choices begin approve`, then `phase show` for the
 * phase awaiting approval: three Copilot round trips with no decision between them. This runs the
 * same three. The output is the selection receipt unchanged plus `approvalPacket` (the readiness
 * result and the `phase show --for-agent` review). Nothing is answered or approved here: the
 * person's review, their Yes to "Approve <Step> v<N>?", `choices answer` and `approve` stay separate.
 * Terminal obligations stop before a receipt exists, as the skill did.
 */
import { step, stop } from '../cli-steps.mjs';
import { SingularityFlowError } from '../util.mjs';
import { approvalHoldContinuation } from '../copilot-guidance.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';
import { blockingHolds, sheetForAgent, sheetRoute } from '../step-sheet-route.mjs';

export async function run({ positionals, options }) {
  if (options.json !== true) {
    throw new SingularityFlowError('--review-packet requires --json.', { code: 'APPROVAL_PACKET_OPTIONS' });
  }
  console.log(JSON.stringify(await loadApprovalPacket({ workId: positionals[3], cwd: process.cwd(), fetch: options.fetch === true }), null, 2));
}

/** Stop at known holds before creating consent receipts or loading complete review documents. */
export async function loadApprovalPacket({ workId, cwd, fetch = false }, { runStep = step, stopStep = stop } = {}) {
  const checked = await runStep(['status', workId, '--submission-readiness', '--json'], cwd);
  if (!checked.ok) stopStep(checked, 'status --submission-readiness');
  // The sheet stops the approval, in the agent's short form; the readiness keeps the rest of what it said.
  const { sheet = null, ...read } = checked.value ?? {};
  const readiness = sheet ? read : checked.value;
  // Decisions approval would refuse for open the decision list first; no receipt is begun.
  if (['terminal-obligations-required', 'decisions-required'].includes(readiness?.classification)) {
    return { resultType: 'sflow-approval-packet', begun: false,
      reason: readiness.classification, approvalPacket: { readiness, review: null } };
  }
  if (sheet && blockingHolds(sheet).length) {
    const { approvalCheck: _sheetSaysThis, ...rest } = readiness;
    return { resultType: 'sflow-approval-packet', begun: false, reason: 'approval-holds', nextAction: sheetRoute(sheet),
      approvalPacket: { sheet: sheetForAgent(sheet), readiness: rest, review: null } };
  }
  // SF Guard takes this signature in the person's own terminal, so no chat can record it: it says so
  // here, with their exact command, not after the review they would read again there.
  const ownTerminal = (readiness?.approvalCheck?.holds ?? []).find((hold) => hold.owner === 'you-decide' && hold.clearedBy?.kind === 'viewer-terminal');
  if (ownTerminal && readiness.approvalCheck.ready !== false && ownTerminal.action?.command) {
    return { resultType: 'sflow-approval-packet', begun: false, reason: 'approval-holds',
      nextAction: { command: ownTerminal.action.command, label: ownTerminal.action.label, reason: ownTerminal.summary, skill: null, copilotCommand: null },
      approvalPacket: { readiness, review: null } };
  }
  if (readiness?.approvalCheck?.ready === false && readiness.approvalCheck.holds?.length) {
    return { resultType: 'sflow-approval-packet', begun: false, reason: 'approval-holds',
      nextAction: readiness.approvalContinuation ?? approvalHoldContinuation(workId, readiness.approvalCheck),
      approvalPacket: { readiness, review: null } };
  }
  if ((readiness.phaseStatus && readiness.phaseStatus !== 'awaiting_approval')
      || (!readiness.phaseStatus && readiness.classification !== 'already-submitted')) {
    const command = readiness.nextCommand ?? readiness.command ?? 'singularity-flow nextsteps --json';
    const nextAction = readiness.authoringProgress?.next ?? safeCommandGuidance({
      command,
      skill: readiness.nextSkill ?? undefined
    }) ?? safeCommandGuidance(command) ?? safeCommandGuidance('singularity-flow nextsteps --json');
    return { resultType: 'sflow-approval-packet', begun: false,
      reason: readiness.classification, preserveDraft: true, turnBoundary: 'end', nextAction,
      approvalPacket: { readiness, review: null } };
  }
  const begun = await runStep(['choices', 'begin', 'approve', workId, ...(fetch ? ['--fetch'] : []), '--json'], cwd);
  if (!begun.ok) stopStep(begun, 'choices begin approve');
  const phase = begun.value?.approvalContext?.phase;
  if (typeof phase !== 'string') {
    throw new SingularityFlowError(`The approval selection for ${workId} names no phase awaiting approval.`, { code: 'APPROVAL_PACKET_PHASE_MISSING' });
  }
  const shown = await runStep(['phase', 'show', phase, '--for-agent', '--json'], cwd);
  if (!shown.ok) stopStep(shown, 'phase show');
  // On the person's Yes, the filled command that records it on this receipt; its result names the approval, filled.
  const filled = (await import('../choices.mjs')).approvalReceiptCommands(begun.value);
  // This turn is that approval: what the readiness and the review say comes next is this same approval, never a route.
  const own = { workId, phase };
  // A code step's ready ways to try it, and the second pass's advice: shown, optional, never a hold (step intents §12.4, §12.5).
  const tryIt = await approvalTryIt(cwd, workId, phase);
  // The person's Yes is recorded in this same approve turn: onYes has no skill or chat route of its own (choices maps to /sf-start).
  return { ...begun.value, ...(tryIt ? { tryIt } : {}),
    ...(filled ? { onYes: { ...safeCommandGuidance({ argv: filled.answer }), skill: null, copilotCommand: null, modelFreeCommand: null } } : {}),
    approvalPacket: { readiness: withoutOwnApproval(readiness, own), review: withoutOwnApproval(shown.value, own) } };
}

/**
 * What the person may try before approving a code step's version, from its runtime check, and the reviewer's improvements
 * (advice that holds nothing); null for any other step or when nothing was kept. A read; never a reason to stop.
 */
async function approvalTryIt(cwd, workId, phaseId) {
  try {
    const [{ repoRoot }, { loadAcceptedStoryExecution }, { phaseRequiresCodeDelivery }] = await Promise.all([
      import('../git.mjs'), import('../accepted-story-execution.mjs'), import('../code-delivery-policy.mjs')]);
    const root = repoRoot(cwd);
    const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
    if (!phaseRequiresCodeDelivery(workflow.phases?.[phaseId])) return null;
    const view = await (await import('../runtime-check.mjs')).runtimeTryItView(root, workflow, phaseId);
    const review = await (await import('../source-review-lifecycle.mjs')).readSourceReviewStatus(root, config, workflow, phaseId).catch(() => null);
    const advice = review?.useAdvice ?? [];
    return view || advice.length ? { ...(view ?? { optional: true, recordsAcceptance: false }), ...(advice.length ? { advice } : {}) } : null;
  } catch { return null; }
}

// The fields of one action that name its route: its Shell, Copilot and VS Code forms and its skill.
const ROUTE_FIELDS = ['command', 'nextCommand', 'copilotCommand', 'modelFreeCommand', 'skill', 'nextSkill'];
// What a route object may carry beside its routes and still be one action: its argv and per-platform forms.
const ACTION_PARTS = new Set(['argv', 'platformCommands', 'commandGuidance']);

/**
 * Whether a route approves this step of this Story: Copilot's /sf-approve (naming this step or none), the terminal's
 * `approve <step>` and VS Code's `@sflow /approve <step>`. A route to another step's approval, or another Story's, is not.
 */
export function approvesOwnStep(value, { workId, phase }) {
  const words = String(value ?? '').trim().split(/\s+/u);
  const at = /^\/(?:sf|sflow)-approve$/u.test(words[0]) ? 1
    : /^(?:singularity-flow|sflow)$/u.test(words[0]) && words[1] === 'approve' ? 2
      : words[0] === '@sflow' && words[1] === '/approve' ? 2 : -1;
  if (at < 0) return false;
  const rest = words.slice(at);
  const story = rest.indexOf('--work-id');
  if (story >= 0 && rest[story + 1] !== workId) return false;
  const step = rest.find((word, index) => !word.startsWith('--') && rest[index - 1] !== '--work-id');
  return step === undefined || step === phase;
}

/**
 * A readiness or review result an approve turn reads, without the approval of the step being approved as a route
 * (owner, 2026-11-21: /sf-approve ended "approve or decline in the approval page" with /sf-approve, `approve --fetch`
 * and @sflow /approve, the same step's approval, which the person read as a loop). An action whose route approves this
 * step goes (the decision list's next, the review's continuation); a result keeps everything but those route fields.
 * The decision list's own route goes too when nothing but this approval is left on it. Other items and other steps stay.
 */
export function withoutOwnApproval(value, own, depth = 0) {
  if (Array.isArray(value)) return value.map((entry) => withoutOwnApproval(entry, own, depth + 1)).filter((entry) => entry !== undefined);
  if (!value || typeof value !== 'object') return value;
  const approving = ROUTE_FIELDS.filter((field) => typeof value[field] === 'string' && approvesOwnStep(value[field], own));
  const action = !Object.entries(value).some(([field, child]) => child && typeof child === 'object' && !ACTION_PARTS.has(field));
  if (depth > 0 && approving.length && action) return undefined;
  const kept = Object.fromEntries(Object.entries(value).filter(([field]) => !approving.includes(field))
    .map(([field, child]) => [field, withoutOwnApproval(child, own, depth + 1)]).filter(([, child]) => child !== undefined));
  // The decision list's summary (submission-readiness.mjs pendingSummary) with only this approval on it: its /sf-decide
  // opens this same approval again.
  if (Array.isArray(kept.items) && kept.items.length && kept.items.every((item) => item?.kind === 'approval') && Object.hasOwn(kept, 'open')) {
    delete kept.command;
    delete kept.copilotCommand;
  }
  return kept;
}
