/**
 * The approver's own decisions, recorded in the approval commit [SPEC-OAP M4, decision 2].
 *
 * An approver answers what the decision list asks of them on the step they approve (a test-run
 * risk, a reused run, a screen size that does not apply, a conformance gap or an upstream issue) in
 * the approval itself: `approve <PHASE> --choose d1=OPTION ... --decisions sha256:<LIST DIGEST>`, or
 * in place in an interactive terminal and the VS Code approval form. Each answer is checked exactly
 * as `decisions record` checks it (the list's digest, the option, the person's approval group) and
 * written through the same function its own command uses, but inside the approval's transaction and
 * before the approval is evaluated: one commit and one push, and the decisions never count as commits
 * after the submission. A return or a Story test command is not an approval, so neither is recorded
 * here. Nothing is written when any answer is refused.
 */
import { SingularityFlowError, nowIso, optionString, optionStrings } from './util.mjs';

/** What an approval can write: records that only add to the Story, never a return or a test command. */
const IN_APPROVAL = Object.freeze(['upstream-issue', 'upstream-issue-decision', 'evidence-reuse', 'visual-profile', 'test-run-risk']);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function refused(message, code, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

/** Whether an option's records can go in an approval. */
export function recordableInApproval(option) {
  return option.recordable !== false && option.effects.every((effect) => IN_APPROVAL.includes(effect.kind)
    && !(effect.kind === 'upstream-issue-decision' && effect.outcome === 'return'));
}

/**
 * The list items this person can answer in the approval: ones that hold it, that they may decide,
 * with only the options an approval can record. Null when there are none.
 */
export function approvalDecisionItems(packet) {
  const items = packet.items.filter((item) => item.kind !== 'approval' && item.holdsApproval && item.decidedBy?.allowed)
    .map((item) => ({ ...item, options: item.options.filter(recordableInApproval) }))
    .filter((item) => item.options.length);
  return items.length ? items : null;
}

const listCommand = (packet) => `singularity-flow decisions ${packet.workId} --phase ${packet.phase}`;

async function readPacket(root, config, workflow, phase, at) {
  return (await import('./decision-list-reads.mjs')).readPendingList(root, config, workflow, { phaseId: phase.id, at });
}

/** The recorder part for one effect, built against `workflow` (a scratch copy when items depend on each other). */
async function partFor(root, config, workflow, effect, step, produced, who) {
  if (effect.kind === 'upstream-issue') {
    return (await import('./commands/upstream-issue.mjs')).upstreamIssuePart(workflow, { phase: effect.phase, about: effect.about,
      problem: effect.problem, assumption: null, impact: null, proposed: 'unknown', source: null, supersedes: null }, who);
  }
  if (effect.kind === 'evidence-reuse') {
    return (await import('./commands/decision-evidence-reuse.mjs')).evidenceReuseDecisionPart(root, config, workflow,
      { phaseId: effect.phase, attemptId: effect.attemptId, reason: step.values.reason }, who);
  }
  if (effect.kind === 'visual-profile') {
    return (await import('./commands/decision-visual-profile.mjs')).visualProfileDecisionPart(root, config, workflow,
      { phaseId: effect.phase, profileId: effect.profileId, reason: step.values.reason }, who);
  }
  if (effect.kind === 'test-run-risk') {
    return (await import('./commands/decision-test-risk.mjs')).testRunRiskDecisionPart(root, config, workflow,
      { phaseId: effect.phase, commandId: effect.commandId, argvSha256: effect.argvSha256 ?? null, cause: step.values.cause,
        reason: step.values.reason, expires: step.values.expires }, who);
  }
  return (await import('./commands/upstream-issue.mjs')).upstreamIssueDecisionPart(root, config, workflow, effect.issue ?? produced.issue,
    { outcome: effect.outcome, reason: step.values.reason, expires: effect.outcome === 'accept-risk' ? step.values.expires : null }, who);
}

/**
 * Check the answers against the list as it stands and build what the approval writes. `answers` come
 * from the flags (`--choose`, `--reason`, `--expires`, `--cause`) with the list digest the person saw
 * (`--decisions`), or from the interactive prompt with the list it showed. Null when nothing is chosen.
 */
export async function prepareApprovalDecisions(root, config, workflow, phase, { answers, digest, packet = null }, who) {
  if (!answers?.choose.size) return null;
  const at = nowIso();
  const list = packet ?? await readPacket(root, config, workflow, phase, at);
  const route = { command: listCommand(list), skill: '/sf-decide', label: `Review what ${phase.label ?? phase.id}'s approval holds.` };
  if (!digest) {
    refused(`Recording decisions with the approval needs the digest of the list they were chosen from: add --decisions ${list.packetSha256}, after reviewing it with ${route.command}.`,
      'APPROVAL_DECISIONS_CONFIRMATION_REQUIRED', { packetSha256: list.packetSha256, nextAction: route });
  }
  if (!DIGEST.test(digest)) refused('--decisions takes the list\'s digest: sha256:<64 hexadecimal characters>.', 'APPROVAL_DECISIONS_OPTIONS_INVALID');
  if (digest !== list.packetSha256) {
    refused(`The decision list changed since it was reviewed (it was ${digest.slice(0, 19)}…, it is ${list.packetSha256.slice(0, 19)}…). Nothing was recorded. Review it again: ${route.command}`,
      'DECISIONS_PACKET_CHANGED', { packetSha256: list.packetSha256, nextAction: route });
  }
  const { decisionRecordPlan, effectWords } = await import('./decision-list.mjs');
  const plan = decisionRecordPlan(list, answers, { at });
  if (plan.refused.length) {
    refused(`Nothing was recorded: you may not decide ${plan.refused.map((entry) => `${entry.item} (${entry.title}): ${entry.words} Share this with them: ${entry.share}`).join(' ')}`,
      'DECISIONS_NOT_YOURS', { refused: plan.refused });
  }
  for (const step of plan.steps) {
    const item = list.items.find((entry) => entry.id === step.item);
    const option = item.options.find((entry) => entry.id === step.option);
    if (!recordableInApproval(option)) {
      refused(`${step.item}=${step.option} (${step.label}) is not recorded with an approval: it ${option.effects.some((effect) => effect.kind === 'test-command') ? 'changes what the submitted review ran' : 'returns the work instead of approving it'}. `
        + `Record it from the decision list: ${route.command}`, 'APPROVAL_DECISION_NOT_IN_APPROVAL', { item: step.item, option: step.option, nextAction: route });
    }
  }
  // Built in order on a scratch copy, so an issue raised for a gap is there when the same item decides it.
  const scratch = structuredClone(workflow);
  const parts = [];
  for (const step of plan.steps) {
    const produced = {};
    for (const effect of step.effects) {
      const part = await partFor(root, config, scratch, effect, step, produced, who);
      const written = part.write(scratch);
      if (effect.kind === 'upstream-issue') produced.issue = written.id;
      parts.push({ item: step.item, kind: effect.kind, part, words: effectWords(workflow, effect, step.values) });
    }
  }
  return {
    packetSha256: list.packetSha256, steps: plan.steps, parts,
    summary: plan.steps.map((step) => `${step.item}. ${list.items.find((item) => item.id === step.item).title}: ${step.label}. `
      + `Records: ${parts.filter((entry) => entry.item === step.item).map((entry) => entry.words).join('; then ')}.`)
  };
}

/** The answers on the command line, and the list digest they were chosen from. */
export async function approvalDecisionFlags(options) {
  const { parseDecisionAnswers } = await import('./decision-list.mjs');
  return {
    answers: parseDecisionAnswers({ choose: optionStrings(options, 'choose'), reason: optionStrings(options, 'reason'),
      expires: optionStrings(options, 'expires'), cause: optionStrings(options, 'cause') }),
    digest: optionString(options, 'decisions') ?? null
  };
}

/** Write the prepared decisions into the approval's aggregate, in order; returns what each recorded. */
export function writeApprovalDecisions(aggregate, prepared) {
  return (prepared?.parts ?? []).map(({ item, kind, part }) => ({ item, kind, record: part.record(part.write(aggregate)) }));
}
