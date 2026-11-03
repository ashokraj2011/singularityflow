/**
 * The decision list: everything people must decide before a step can move, in one place, in plain
 * words, as choices. [decision list, owner decision 2026-10-19]
 *
 * A release approval once needed six commands across three approval groups: raise a replacement
 * issue, reuse a recorded run, decide the replacement, dismiss the original, then approve. Each was
 * a separate record ID and flag set to type. This module turns the same records into a short list:
 * one item per underlying problem (a conformance gap and the upstream issue that names its clauses
 * are one item, not two), each with a title and a why built from recorded facts only, and options a
 * person picks. Every option names the exact records it would write (`effects`), what it still needs
 * (a date, a reason, each with an editable default) and who decides it.
 *
 * Nothing here decides or records anything, and nothing relaxes a check: each effect is written later
 * by the same function its own command uses (src/commands/decisions.mjs), under that command's
 * authority check. Accepting reused evidence never certifies a run that was not recorded: a reused
 * run stays labelled as the step that recorded it. Pure: the facts arrive from decision-list-facts.mjs.
 */
import { matchApprovalAuthority, normalizeApprovalAuthorities } from './approval-authority.mjs';
import { commandLineWithoutSkill, DECISION_LIST_CHAT_OPTIONS } from './command-skills.mjs';
import { recordSha256 } from './records.mjs';
import { testCommandReviewHold } from './story-test-commands.mjs';
import { testRunCauseWords } from './test-run-cause.mjs';
import { testRunRiskAuthorities } from './test-run-risk.mjs';
import { decisionGroups, decisionRefusalLead } from './decision-list-facts.mjs';
import { CONFORMANCE_GAP_RULE, decidableUpstreamStep, decisionHeadline, issueNamesClause, stepName, upstreamIssueOutcomes, upstreamReturnLegal } from './upstream-routes.mjs';
import { SingularityFlowError } from './util.mjs';

export { decisionGroups, decisionHeadline, decisionRefusalLead, stepName };
export const DECISION_LIST_REVISION = 'decision-list-v1';
/** Options that write only upstream-issue records (a raise needs no authority; a decision needs its step's approvers). */
export const ISSUE_ONLY_OPTIONS = Object.freeze(['accept-risk', 'dismiss', 'return']);
export const DEFAULT_RISK_DAYS = 30;
const MAX_RISK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
// The order a chosen option's records are written in: an issue exists before it is decided.
const EFFECT_ORDER = Object.freeze(['upstream-issue', 'evidence-reuse', 'test-run-risk', 'test-narrowing', 'test-command', 'visual-profile', 'upstream-issue-decision']);
const REASON = Object.freeze({ minimum: 20, maximum: 1000 });
const CAUSE = Object.freeze({ minimum: 10, maximum: 300 });

function refused(message, code, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}


/** "A", "A and B", "A, B and C". */
export function listWords(values) {
  const items = [...values];
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}


/** A clause as people say it: without its Story's own prefix. */
export function clauseName(workflow, clauseId) {
  const prefix = `${workflow?.workItem?.id ?? ''}:`;
  return String(clauseId ?? '').toUpperCase().startsWith(prefix.toUpperCase()) ? String(clauseId).slice(prefix.length) : String(clauseId);
}

const sameClause = (left, right) => String(left).toUpperCase() === String(right).toUpperCase();

/** The calendar day `days` after `at`, as YYYY-MM-DD. */
export function dayAfter(at, days) {
  return new Date(Date.parse(at) + days * DAY).toISOString().slice(0, 10);
}

function issueGroups(workflow, phaseId) {
  const policy = workflow?.phases?.[phaseId]?.approvalPolicy ?? {};
  return [...new Set([...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])])].sort();
}

/** The approval groups that must decide one effect; null when anyone may (raising an issue). */
function effectGroups(workflow, effect) {
  if (effect.kind === 'upstream-issue') return null;
  if (effect.kind === 'upstream-issue-decision') return issueGroups(workflow, effect.issuePhase);
  return testRunRiskAuthorities(workflow, effect.phase);
}

function groupLabel(registry, id) {
  return registry?.[id]?.label ?? id;
}

/**
 * Who decides an option: every group its records need, whether this identity is in each, and, when
 * it is not, who is, in plain words, with the one line to share.
 */
function decidedBy(workflow, effects, { authorities, actor }) {
  let registry = null;
  try { registry = normalizeApprovalAuthorities(authorities); } catch { registry = null; }
  const needed = effects.map((effect) => ({ effect, groups: effectGroups(workflow, effect) })).filter((entry) => entry.groups);
  const groups = [...new Set(needed.flatMap((entry) => entry.groups))].sort();
  const unavailable = needed.find((entry) => !entry.groups.length);
  // Each record needs one of its groups; the person decides the option only when they hold one for each.
  const missing = needed.filter((entry) => {
    try { return !matchApprovalAuthority(authorities, { authorities: entry.groups }, actor).authorized; } catch { return true; }
  });
  const allowed = !unavailable && !missing.length;
  const labels = groups.map((id) => groupLabel(registry, id));
  const workId = workflow?.workItem?.id ?? '<WORK-ID>';
  const who = [...new Set(missing.map((entry) => entry.groups.map((id) => groupLabel(registry, id)).join(' or ')))];
  // An issue raised against a step without approvers is never decidable there: name where it can be.
  const stuck = unavailable ? unavailable.effect.issuePhase ?? unavailable.effect.phase : null;
  const instead = stuck ? decidableUpstreamStep(workflow, stuck) : null;
  const words = unavailable
    ? `Nobody can decide this here: ${stepName(workflow, stuck)} has no approval group.${instead
      ? ` Raise the same problem against ${stepName(workflow, instead)} with --supersedes; its approvers decide it.` : ''}`
    : !labels.length ? 'Anyone working on this Story may decide this.'
      : allowed ? `You may decide this (${listWords(labels)}).`
        : `The ${listWords(who)} decide this.`;
  return { groups, labels, allowed, words, ...(allowed ? {} : { share: `/sf-decide ${workId}` }) };
}

/** Who decides an item: every option's groups; it is yours when you may decide at least one option. */
function itemDecidedBy(workflow, options) {
  const lead = options.find((entry) => entry.recommended) ?? options[0];
  const groups = [...new Set(options.flatMap((entry) => entry.decidedBy.groups))].sort();
  const labels = [...new Set(options.flatMap((entry) => entry.decidedBy.labels))];
  const mine = options.filter((entry) => entry.decidedBy.allowed);
  if (mine.length === options.length) return { ...lead.decidedBy, groups, labels };
  if (!mine.length) return { ...lead.decidedBy, groups, labels, allowed: false, share: `/sf-decide ${workflow?.workItem?.id ?? '<WORK-ID>'}` };
  const others = options.find((entry) => !entry.decidedBy.allowed);
  return { groups, labels, allowed: true, words: `You may choose ${listWords(mine.map((entry) => `"${entry.label}"`))}; ${others.decidedBy.words.replace(/^The /u, 'the ').replace(/ decide this\.$/u, ' decide the other options.')}` };
}

const textNeed = (value, limits) => ({ default: value, minimum: limits.minimum, maximum: limits.maximum });
/**
 * A date from tomorrow to `latest`, the last day its own record command accepts: an accepted upstream
 * issue risk ends at the start of its day (at most 90 days ahead), a test-run risk at the end
 * of its day, so its last day is one earlier.
 */
const expiryNeed = (at, { endOfDay = false } = {}) => ({ default: dayAfter(at, DEFAULT_RISK_DAYS),
  latest: dayAfter(at, endOfDay ? MAX_RISK_DAYS - 1 : MAX_RISK_DAYS) });

function option(workflow, context, { id, label, recommended = false, effects, needs, words }) {
  const ordered = [...effects].sort((left, right) => EFFECT_ORDER.indexOf(left.kind) - EFFECT_ORDER.indexOf(right.kind));
  if (ISSUE_ONLY_OPTIONS.includes(id) && ordered.some((effect) => !['upstream-issue', 'upstream-issue-decision'].includes(effect.kind))) {
    // The Copilot guard trusts this: an issue-only option never writes another kind of record.
    throw new SingularityFlowError(`Decision option '${id}' may write only upstream-issue records.`, { code: 'DECISION_LIST_INVALID' });
  }
  return { id, label, recommended, words, effects: ordered, needs, decidedBy: decidedBy(workflow, ordered, context) };
}

const issueDecision = (issue, outcome) => ({ kind: 'upstream-issue-decision', issue: issue?.id ?? null, issuePhase: issue?.phase ?? null, outcome });

/** What a run's counts say, plainly: "33 of 33 passed". */
function runCounts(tests) {
  if (!tests) return 'it passed';
  return `${tests.passed} of ${tests.discovered ?? tests.passed} passed`;
}

/** The reuse a recorded run offers for every clause of an item, or null. */
function coveringCandidate(candidates, clauses) {
  return (candidates ?? []).find((candidate) => clauses.every((clause) => (candidate.clauses ?? []).some((id) => sameClause(id, clause)))) ?? null;
}

const returnLegal = upstreamReturnLegal;

/** One item for a conformance gap, with the open upstream issue that names its clauses when there is one. */
function gapItem(workflow, context, group) {
  const { issue, owner, gaps } = group;
  const clauses = [...new Set(gaps.map((gap) => gap.clauseId))];
  const names = listWords(clauses.map((clause) => clauseName(workflow, clause)));
  const verdicts = [...new Set(gaps.map((gap) => gap.verdict))];
  const reports = [...new Set(gaps.map((gap) => gap.report))];
  const reportWords = listWords(reports.map((id) => `${stepName(workflow, id)} report`));
  const isAre = clauses.length === 1 ? 'is' : 'are';
  const ownerName = stepName(workflow, owner);
  const candidate = coveringCandidate(context.facts.candidates, clauses);
  const problem = context.facts.reuseProblems?.find((entry) => clauses.some((clause) => (entry.clauses ?? []).some((id) => sameClause(id, clause))))
    ?? context.facts.reuseProblems?.[0] ?? null;
  const why = [`The ${reportWords} marks ${names} ${listWords(verdicts)}; ${issue
    ? `${ownerName} owns the linked upstream problem` : `${ownerName} delivered ${clauses.length === 1 ? 'it' : 'them'}`}.`];
  if (candidate) {
    why.push(`No run by ${stepName(workflow, candidate.consumer)} is recorded, and the code has not changed since ${stepName(workflow, candidate.producer)}'s`
      + ` recorded run (${runCounts(candidate.tests)}), which covers ${clauses.length === 1 ? 'it' : 'them'}.`);
  } else if (problem) {
    why.push(problem.words);
  }
  if (issue) {
    why.push(issue.status === 'expired'
      ? `The accepted risk on the problem reported against ${ownerName} ended on ${String(issue.decision?.expiresAt ?? '').slice(0, 10)}.`
      : `A problem reported against ${ownerName} names ${clauses.length === 1 ? 'it' : 'them'} and is not decided yet.`);
  }
  why.push('The verdict stays as written; a person decides the gap.');
  const at = context.at;
  // A gap no open issue names is reported against its owning step first; that step's approvers decide it.
  const target = issue ?? { id: null, phase: owner };
  const raise = issue ? [] : [{ kind: 'upstream-issue', phase: owner, about: clauses.join(', ').slice(0, 200),
    problem: `The ${reportWords} marks ${clauses.join(', ')} ${listWords(verdicts)}, and ${ownerName}'s approvers decide the gap. Raised from the decision list.` }];
  const options = [];
  if (candidate) {
    const consumer = stepName(workflow, candidate.consumer);
    const producer = stepName(workflow, candidate.producer);
    options.push(option(workflow, context, {
      id: 'reuse', recommended: true,
      label: `Accept ${producer}'s recorded run (${runCounts(candidate.tests)}) for ${consumer}`,
      words: `${producer}'s run stays labelled as ${producer}'s; ${consumer} is never said to have run tests.${issue ? ' The reported problem is accepted as a risk until the date.' : ''}`,
      effects: [{ kind: 'evidence-reuse', phase: candidate.consumer, attemptId: candidate.attemptId, recordedBy: candidate.producer, clauses: candidate.clauses },
        ...(issue ? [issueDecision(target, 'accept-risk')] : [])],
      needs: { reason: textNeed(`${producer}'s recorded run (${runCounts(candidate.tests)}) on unchanged code stands for ${consumer}; no run by ${consumer} was recorded. The honest verdict stays.`, REASON),
        ...(issue ? { expires: expiryNeed(at) } : {}) }
    }));
  }
  options.push(option(workflow, context, {
    id: 'accept-risk', label: 'Accept the gap as a risk until a date',
    words: `The verdict stays ${listWords(verdicts)}; the gap is accepted until the date, then it needs a decision again.`,
    effects: [...raise, issueDecision(target, 'accept-risk')],
    needs: { expires: expiryNeed(at), reason: textNeed(`Accepted as a risk until the date: ${names} ${isAre} ${listWords(verdicts)} as the ${reportWords} says.`, REASON) }
  }));
  options.push(option(workflow, context, {
    id: 'dismiss', label: 'Dismiss it: the gap is not real',
    words: 'Use this only when what was delivered is complete; the verdict itself is never edited.',
    effects: [...raise, issueDecision(target, 'dismiss')],
    needs: { reason: textNeed(`Dismissed: ${names} ${isAre} delivered completely by ${ownerName}; the report's verdict stays as written.`, REASON) }
  }));
  if (returnLegal(workflow, owner)) {
    options.push(option(workflow, context, {
      id: 'return', label: `Return the work to ${ownerName}`,
      words: `${ownerName} delivers ${names} again and the steps after it run again; working files are kept.`,
      effects: [...raise, issueDecision(target, 'return')],
      needs: { reason: textNeed(`Returned to ${ownerName} so it delivers ${names}.`, REASON) }
    }));
  }
  return {
    kind: 'conformance-gap',
    title: `${names} ${isAre} ${listWords(verdicts)} in the ${reportWords}`,
    why: why.join(' '),
    options,
    details: { clauses, verdicts, owner, reports, issue: issue?.id ?? null, issueStatus: issue?.status ?? (issue ? 'open' : 'unraised'),
      supersedes: issue ? (context.facts.issues ?? []).filter((state) => state.supersededBy === issue.id).map((state) => state.issue.id) : [],
      reuse: candidate ? { attemptId: candidate.attemptId, recordedBy: candidate.producer, for: candidate.consumer, sourceCommit: candidate.sourceCommit ?? null,
        tests: candidate.tests ?? null } : null,
      rule: CONFORMANCE_GAP_RULE,
      commands: [...new Set(gaps.flatMap((gap) => gap.choices ?? []).map((choice) => choice.command).filter(Boolean))] }
  };
}

/** One item for an open upstream issue no blocking gap names. */
function issueItem(workflow, context, state) {
  const { issue } = state;
  const ownerName = stepName(workflow, issue.phase);
  const covering = (context.facts.activeReuse ?? []).filter((entry) => (entry.clauses ?? []).some((clause) => issueNamesClause(issue.about, clause)));
  const aboutName = clauseName(workflow, issue.about);
  const reporter = issue.raisedIn?.phase ? stepName(workflow, issue.raisedIn.phase) : 'A later step';
  const why = [`${reporter} reported a problem in ${ownerName}: "${String(issue.problem).replace(/\s+/gu, ' ').trim().slice(0, 400)}"`];
  if (state.status === 'expired') why.push(`Its accepted risk ended on ${String(state.decision?.expiresAt ?? '').slice(0, 10)}.`);
  if (covering.length) {
    why.push(`The recorded run accepted for ${listWords([...new Set(covering.map((entry) => stepName(workflow, entry.phase)))])} already covers it.`);
  }
  why.push(`${ownerName}'s approvers decide it; the Story cannot finish until they do.`);
  const options = [
    option(workflow, context, {
      id: 'accept-risk', recommended: covering.length > 0, label: 'Accept it as a risk until a date',
      words: 'It needs a decision again after the date.',
      effects: [issueDecision(issue, 'accept-risk')],
      needs: { expires: expiryNeed(context.at), reason: textNeed(covering.length
        ? `Covered by the recorded run already accepted for ${stepName(workflow, covering[0].phase)}; accepted until the date.`
        : `Accepted as a risk until the date: ${aboutName} in ${ownerName} as reported.`, REASON) }
    }),
    option(workflow, context, {
      id: 'dismiss', label: 'Dismiss it: it is not a real problem',
      words: 'The report stays in the history with your reason.',
      effects: [issueDecision(issue, 'dismiss')],
      needs: { reason: textNeed(`Dismissed: ${aboutName} in ${ownerName} is not a defect.`, REASON) }
    })
  ];
  if (returnLegal(workflow, issue.phase)) {
    options.push(option(workflow, context, {
      id: 'return', label: `Return the work to ${ownerName}`,
      words: `${ownerName} is corrected and the steps after it run again; working files are kept.`,
      effects: [issueDecision(issue, 'return')],
      needs: { reason: textNeed(`Returned to ${ownerName} to correct ${aboutName}.`, REASON) }
    }));
  }
  return {
    kind: 'upstream-issue',
    title: `${aboutName}: a problem reported in ${ownerName}`,
    why: why.join(' '),
    options,
    details: { issue: issue.id, phase: issue.phase, about: issue.about, status: state.status,
      supersedes: (context.facts.issues ?? []).filter((entry) => entry.supersededBy === issue.id).map((entry) => entry.issue.id),
      coveredBy: covering.map((entry) => entry.id),
      commands: [`singularity-flow upstream-issue decide ${issue.id} --work-id ${workflow.workItem.id} --outcome ${upstreamIssueOutcomes(workflow, issue.phase)} --reason "<why>"`] }
  };
}

/**
 * One item for a screen size enforced visual coverage still lacks. Capturing it is the person's
 * action (its command is shown, never recorded here); saying it does not apply to this Story is the
 * decision, available while another screen size stays required.
 */
function visualItem(workflow, context, entry) {
  const capture = entry.options.find((candidate) => candidate.id === 'capture');
  const notApplicable = entry.options.find((candidate) => candidate.id === 'not-applicable');
  const action = (source, words) => ({ id: source.id, label: source.label, recommended: false, words, effects: [], needs: {}, recordable: false,
    ...(source.command ? { action: { command: source.command, alternativeCommands: source.alternativeCommands ?? [] } } : { available: false }),
    decidedBy: { groups: [], labels: [], allowed: true, words: source.command ? 'You take the screenshot and record it; nothing is decided here.' : words } });
  const options = [
    ...(capture ? [action(capture, capture.detail)] : []),
    ...(notApplicable ? [notApplicable.available ? option(workflow, context, {
      id: 'not-applicable', label: notApplicable.label, words: notApplicable.detail,
      effects: [{ kind: 'visual-profile', phase: entry.phase, profileId: entry.profileId }],
      needs: { reason: textNeed(`${entry.label} does not apply to this Story: the change does not ship to this screen size.`, REASON) }
    }) : action(notApplicable, notApplicable.detail)] : [])
  ];
  return {
    kind: 'visual-profile', title: entry.title, why: entry.why, options,
    details: { phase: entry.phase, profileId: entry.profileId, label: entry.label,
      commands: [capture?.command, ...(capture?.alternativeCommands ?? []), notApplicable?.command].filter(Boolean) }
  };
}

/** A choice that is the person's own step: its command is theirs to run, never recorded from the list. */
function personalStep({ id, label, command, words }) {
  return { id, label, recommended: false, words, effects: [], needs: {}, recordable: false,
    action: { command, alternativeCommands: [] }, decidedBy: { groups: [], labels: [], allowed: true, words } };
}

/**
 * One item per criterion whose evidence approval waits on a person for: witness each slot after
 * looking at it, or accept the obligation as a dated risk. Both are the person's own commands.
 */
function evidenceItem(workflow, context, entry) {
  const name = clauseName(workflow, entry.criterion);
  const slots = entry.witnesses.map((witness) => witness.files.length === 1 ? witness.files[0] : `slot ${witness.slot}`);
  const options = [
    ...entry.witnesses.map((witness) => {
      const owed = (context.facts.pending?.owed ?? []).find(row => row.kind === 'witness' && row.clauseId === entry.criterion && row.slot === witness.slot);
      const step = personalStep({
      id: `witness-${witness.slot}`,
      label: witness.files.length === 1 ? `I checked ${witness.files[0]}: witness it` : `I checked the ${witness.method} evidence for slot ${witness.slot}: witness it`,
      command: witness.command,
      words: 'You look at the evidence yourself and record the witness with its three confirmations; nothing is decided here.'
      });
      return owed ? { ...step, decidedBy: stepDecidedBy(workflow, context, [...new Set(owed.owners.flatMap(id => approvers(workflow, id)))], step.words),
        action: { ...step.action, humanReview: { kind: 'witness', clauseId: owed.clauseId, clauseText: owed.clauseText, slot: owed.slot, method: owed.method,
          files: owed.files, owners: owed.owners, contextBinding: owed.contextBinding } } } : step;
    }),
    ...entry.risks.map((risk, index) => personalStep({
      id: entry.risks.length === 1 ? 'accept-obligation-risk' : `accept-obligation-risk-${index + 1}`,
      label: 'Accept it as a risk until a date',
      command: risk.command,
      words: `You record the risk with a category (${listWords(entry.categories)}), an expiry and a reason; nothing is decided here.`
    }))
  ];
  return {
    kind: 'evidence-obligation',
    title: slots.length ? `Check the evidence for ${name}` : `Decide the open evidence for ${name}`,
    why: `${name} is ${entry.result}: ${slots.length ? `approval waits for a person to witness ${listWords(slots)} for this change` : 'an obligation is still open'}. `
      + 'Witness it if it shows the outcome, or accept a dated risk; the verdict itself does not change.',
    options,
    details: { criterion: entry.criterion, result: entry.result, witnesses: entry.witnesses, risks: entry.risks, categories: entry.categories,
      commands: [...entry.witnesses.map((witness) => witness.command), ...entry.risks.map((risk) => risk.command)] }
  };
}

/** One item for a test command of a step whose latest run the environment stopped, by its classified cause. */
function testRiskItem(workflow, context, risk) {
  const name = stepName(workflow, risk.phase);
  const stopped = risk.status === 'blocked' ? 'was blocked' : 'failed';
  const exit = Number.isInteger(risk.exitCode) ? ` (exit code ${risk.exitCode})` : '';
  const because = risk.causeClass ? `: ${testRunCauseWords(risk.causeClass)} (${risk.causeClass})` : '';
  return {
    kind: 'test-run-risk',
    title: `${name}'s tests could not run here (${risk.commandId})`,
    why: `The latest run of ${risk.commandId} ${stopped}${exit} from the environment${because}, so it says nothing about the change.`
      + `${risk.lapsed ? ` An earlier acceptance ${risk.lapsed === 'expired' ? 'expired' : 'was revoked'}.` : ''}`
      + ' Fix the environment and run it again, or accept the risk until a date: the tests still run every time, and only a run with this same cause is covered.',
    options: [option(workflow, context, {
      id: 'accept-test-risk', label: 'Accept that these tests cannot run here, until a date',
      words: 'The run stays failed; it is never counted as a pass.',
      effects: [{ kind: 'test-run-risk', phase: risk.phase, commandId: risk.commandId, argvSha256: risk.argvSha256 ?? null, attemptId: risk.attemptId ?? null,
        causeClass: risk.causeClass ?? null }],
      needs: { cause: textNeed(`The environment stopped the latest run of ${risk.commandId}${exit}${because}.`, CAUSE),
        reason: textNeed(`The tests of ${risk.commandId} run again at every publication and submission; this environment cannot run them now.`, REASON),
        expires: expiryNeed(context.at, { endOfDay: true }) }
    })],
    details: { phase: risk.phase, commandId: risk.commandId, attemptId: risk.attemptId ?? null, status: risk.status, exitCode: risk.exitCode ?? null,
      causeClass: risk.causeClass ?? null,
      commands: [`singularity-flow decision test-risk ${workflow.workItem.id} --phase ${risk.phase} --command ${risk.commandId}${risk.causeClass ? ` --cause-class ${risk.causeClass}` : ''} --cause "<what stops it>" --reason "<why>" --expires <YYYY-MM-DD>`] }
  };
}

/** One item for a test command of a step whose latest run passed narrowed, with no acceptance covering it. */
function testNarrowingItem(workflow, context, entry) {
  const name = stepName(workflow, entry.phase);
  return {
    kind: 'test-narrowing',
    title: `${name}'s tests ran narrowed (${entry.commandId})`,
    why: `The latest run of ${entry.commandId} passed narrowed: ${entry.words}. A narrowed run does not prove the module, so the gate refuses it. `
      + 'Remove the narrowing and run it again, or accept it with a reason: the acceptance covers runs of the same pin narrowed the same or less.',
    options: [option(workflow, context, {
      id: 'accept-test-narrowing', label: 'Accept this narrowed run for this step',
      words: 'A run narrowed further, or under a changed pin, is refused again.',
      effects: [{ kind: 'test-narrowing', phase: entry.phase, commandId: entry.commandId, attemptId: entry.attemptId ?? null }],
      needs: { reason: textNeed(`The narrowed run of ${entry.commandId} is enough for ${name}: ${entry.words}.`.slice(0, REASON.maximum), REASON) }
    })],
    details: { phase: entry.phase, commandId: entry.commandId, attemptId: entry.attemptId ?? null, reasons: entry.reasons,
      commands: [`singularity-flow decision test-narrowing ${workflow.workItem.id} --phase ${entry.phase} --command ${entry.commandId} --reason "<why the narrowed run is enough for this step>"`] }
  };
}

/** One item for a Story-only test command someone requested for a step (`decision test-command`). */
function testCommandItem(workflow, context, request) {
  const name = stepName(workflow, request.phase);
  const { command } = request;
  const hold = testCommandReviewHold(workflow, request.phase);
  // A re-pin: the command changed since it was pinned for this Story [TCE:REQ-012].
  const changed = request.repin ? listWords(request.repin.changes ?? []) : null;
  const removed = request.repin?.removed === true;
  return {
    kind: 'test-command',
    title: removed ? `Stop running ${command.id}, a test suite removed from ${name}`
      : request.repin ? `Re-pin ${command.id}, ${name}'s changed test command` : `Run ${command.id} as ${name}'s tests for this Story`,
    why: removed
      ? `${command.id} was pinned for this Story and its module no longer declares it, so the gate refuses the removal. ${request.requestedBy} asked that it no longer run: `
        + `${request.reason} Once accepted, ${name} no longer runs it; every other test must still pass.`
      : request.repin
      ? `${command.id} changed since it was pinned for this Story (${changed}), so the gate refuses it. ${request.requestedBy} asked that it now run `
        + `${JSON.stringify(command.argv)} from ${command.workingDirectory}: ${request.reason} Once accepted, the next gate run records this as its pin; its tests must still pass.`
      : `${request.requestedBy} asked that ${name} run ${JSON.stringify(command.argv)} from ${command.workingDirectory}, reading ${command.result.adapter} ${command.result.path}, `
        + `covering ${listWords(command.affectedRoots)}: ${request.reason} Once accepted it runs at every publication and submission of ${name}, and its tests must pass.`,
    // Accepting it while the step awaits approval would make that review stale: return the step first.
    options: [hold ? personalStep({ id: 'return-step-first', label: `Return ${name} for changes first`, command: hold.command, words: hold.words })
      : option(workflow, context, {
        id: 'accept-test-command', label: removed ? 'Accept that this suite no longer runs' : request.repin ? 'Accept the changed command as its pin' : 'Accept this command for this Story',
        words: request.repin ? 'Only this Story\'s pin changes; the repository configuration is unchanged.'
          : 'The repository configuration is unchanged; propose it there with /sf-test-setup for later Stories.',
        effects: [{ kind: 'test-command', phase: request.phase, request: request.id }],
        needs: { reason: textNeed(`${command.id} runs ${name}'s tests for this Story.`, { minimum: 0, maximum: REASON.maximum }) }
      })],
    details: { phase: request.phase, request: request.id, command, commands: [`singularity-flow decision test-command ${workflow.workItem.id} --accept ${request.id}`] }
  };
}

/**
 * Who takes a person's own step: the approval groups it needs, whether this identity holds one, and,
 * when it does not, who does (their labels and up to five members) and the line to share with them.
 */
function stepDecidedBy(workflow, { authorities, actor }, groups, words) {
  if (!groups?.length) return { groups: [], labels: [], allowed: true, words };
  let registry = null;
  try { registry = normalizeApprovalAuthorities(authorities); } catch { registry = null; }
  const labels = groups.map((id) => groupLabel(registry, id));
  let allowed = false;
  try { allowed = matchApprovalAuthority(authorities, { authorities: groups }, actor).authorized; } catch { allowed = false; }
  if (allowed) return { groups, labels, allowed: true, words: `You may do this (${listWords(labels)}). ${words}` };
  const people = [...new Set(groups.flatMap((id) => (registry?.[id]?.members ?? []).map((member) => member.name ?? member.email ?? member.githubLogin)))].slice(0, 5);
  return { groups, labels, allowed: false, ...(people.length ? { people } : {}),
    words: `The ${listWords(labels)}${people.length ? ` (${listWords(people)})` : ''} decide this; ask them.`,
    share: `/sf-decide ${workflow?.workItem?.id ?? '<WORK-ID>'}` };
}

/** One item that is a person's own step, with who takes it. */
function stepItem(workflow, context, { kind, title, why, groups = [], options, details }) {
  const steps = options.map((entry) => ({ ...personalStep(entry),
    ...(entry.humanReview ? { action: { command: entry.command, humanReview: entry.humanReview } } : {}), decidedBy: stepDecidedBy(workflow, context, groups, entry.words) }));
  return { kind, title, why, options: steps, details: { ...details, commands: steps.map((entry) => entry.action.command) } };
}

const approvers = (workflow, phaseId) => issueGroups(workflow, phaseId);

/** The workflow's own routing decision waiting after a step (`decision choose`). */
function routingItem(workflow, context, pending) {
  const workId = workflow.workItem.id;
  const after = stepName(workflow, pending.after);
  return stepItem(workflow, context, {
    kind: 'routing-decision', title: `Choose where ${workId} goes after ${after}: ${pending.label ?? pending.decision}`,
    why: `${pending.reason ? `${pending.reason} ` : ''}The workflow waits for this choice before it moves on.`,
    groups: pending.by ?? [],
    options: (pending.options ?? []).map((choice) => ({ id: `choose-${choice.id}`, label: `${choice.label ?? choice.id}${choice.to ? ` (goes to ${stepName(workflow, choice.to)})` : ''}`,
      command: `singularity-flow decision choose ${workId} --fetch --option ${choice.id} --reason "<why>" --expected ${pending.key}`,
      words: 'You choose in your own terminal with a reason; nothing is chosen here.' })),
    details: { key: pending.key, decision: pending.decision, after: pending.after }
  });
}

/**
 * An intent amendment: one proposed and still undecided (the scope step's approvers decide it), or
 * one approved whose changed clauses the current step has not acknowledged yet.
 */
function intentAmendmentItem(workflow, context, amendment) {
  const workId = workflow.workItem.id;
  const clauses = listWords((amendment.changedClauses ?? []).map((clause) => clauseName(workflow, clause))) || 'the approved scope';
  const status = `singularity-flow story intent-amendment status --work-id ${workId} --json`;
  if (amendment.status === 'approved') {
    return stepItem(workflow, context, {
      kind: 'intent-amendment', title: `Acknowledge intent amendment ${amendment.id}`,
      why: `${amendment.id} was approved and changed ${clauses}. The steps it reopened revalidate after someone acknowledges it.`,
      options: [{ id: 'acknowledge', label: `I read ${amendment.id}: acknowledge it`,
        command: `singularity-flow story intent-amendment acknowledge ${amendment.id} --work-id ${workId}`,
        words: 'You acknowledge it in your own terminal after reading it; nothing is recorded here.' }],
      details: { amendment: amendment.id, status: 'approved', statusCommand: status }
    });
  }
  const scope = context.facts.scopePhase ?? null;
  const decide = (decision) => `singularity-flow story intent-amendment decide ${amendment.id} --decision ${decision} --confirm ${amendment.id} --work-id ${workId}`;
  return stepItem(workflow, context, {
    kind: 'intent-amendment', title: `Decide intent amendment ${amendment.id}`,
    why: `${amendment.id} proposes changing ${clauses}. Rejecting it keeps every submission as it is; approving it changes the approved clauses, so the steps that cite them reopen.`,
    groups: scope ? approvers(workflow, scope) : [],
    options: [
      { id: 'reject', label: `Reject ${amendment.id}`, command: decide('reject'), words: 'Decided in your own terminal; an agent cannot decide it.' },
      { id: 'approve', label: `Approve ${amendment.id}`, command: decide('approve'), words: 'Decided in your own terminal; an agent cannot decide it.' }
    ],
    details: { amendment: amendment.id, status: 'proposed', scopePhase: scope, statusCommand: status }
  });
}

/** A forward amendment or a revalidation it asked for, as the Story's ending reads them. */
function forwardAmendmentItem(workflow, context, blocker) {
  const revalidation = blocker.code === 'AMENDMENT_REVALIDATION_REQUIRED';
  return stepItem(workflow, context, {
    kind: 'forward-amendment', title: revalidation ? `Revalidate ${stepName(workflow, blocker.phase)} after ${blocker.amendment}` : `Decide forward amendment ${blocker.amendment}`,
    why: blocker.message, groups: approvers(workflow, blocker.phase),
    options: [{ id: revalidation ? 'revalidate' : 'decide', label: revalidation ? 'Revalidate it' : 'Approve or reject it',
      command: blocker.command, words: 'Decided in your own terminal by an approver of that step.' }],
    details: { code: blocker.code, amendment: blocker.amendment, phase: blocker.phase }
  });
}

/** An exact-diff appeal of the current step that waits for a person. */
function appealItem(workflow, context, appeal) {
  return stepItem(workflow, context, {
    kind: 'appeal', title: `Review appeal ${appeal.id} on ${stepName(workflow, appeal.phaseId)}`,
    why: `The appeal is ${String(appeal.status).replaceAll('-', ' ')}. An approver reviews the exact diff and accounts for the scope or requests changes; no check is waived.`,
    groups: approvers(workflow, appeal.phaseId),
    options: [{ id: 'review', label: 'Review the appeal', command: appeal.command, words: 'Reviewed in your own terminal (/sf-appeal shows it).' }],
    details: { appeal: appeal.id, phase: appeal.phaseId, status: appeal.status }
  });
}

/** A sign-off or scope disposition an approved step owes the Story's ending; it does not hold this step. */
function owedItem(workflow, context, entry) {
  const witness = entry.kind === 'witness';
  return stepItem(workflow, context, {
    kind: 'owed-decision', title: witness ? `Sign off ${clauseName(workflow, entry.clauseId)} (${entry.method})` : `Decide scope item ${entry.id}`,
    why: witness ? `An approver of ${listWords(entry.owners.map((id) => stepName(workflow, id)))} inspects ${listWords(entry.files)} and signs it off; the Story cannot end without it.`
      : `${entry.text ? `"${entry.text}" ` : ''}needs a link or a disposition from an approver of the step that defines the scope before the Story ends.`,
    groups: witness ? [...new Set(entry.owners.flatMap((id) => approvers(workflow, id)))] : [],
    options: [{ id: witness ? 'witness' : 'disposition', label: witness ? 'Sign it off after inspecting it' : 'Include it, or say it exists, naming its clauses',
      command: entry.command ?? `singularity-flow evidence matrix ${workflow.workItem.id} --json`, words: 'Only a person records it; an agent never answers it.',
      ...(witness ? { humanReview: { kind: 'witness', clauseId: entry.clauseId, clauseText: entry.clauseText, slot: entry.slot, method: entry.method,
        files: entry.files, owners: entry.owners, contextBinding: entry.contextBinding } } : {}) },
    ...(entry.otherCommand ? [{ id: 'other-disposition', label: 'Exclude, defer or set it aside, with a reason', command: entry.otherCommand,
      words: 'Only a person records it; an agent never answers it.' }] : [])],
    details: witness ? { clause: entry.clauseId, slot: entry.slot, contextBinding: entry.contextBinding } : { scopeItem: entry.id }
  });
}

/** What Singularity Flow finishes itself and could not: shown only after the automatic attempt failed. */
function machineItem(workflow, entry) {
  const sync = entry.intentId ? `singularity-flow sync ${entry.intentId}` : `singularity-flow sync ${workflow.workItem.id}`;
  return {
    kind: entry.intentId ? 'transport-intent' : 'story-publication', machine: true,
    title: entry.intentId ? `Publish the retained upload ${entry.intentId}` : `Publish ${workflow.workItem.id}'s retained commit`,
    why: `${entry.cause ?? 'The automatic publication did not land.'} Singularity Flow retries it with sync once the cause is fixed.`,
    options: [{ ...personalStep({ id: 'sync', label: 'Publish it', command: sync, words: 'sync publishes what was not published; nothing is decided here.' }) }],
    details: { ...(entry.intentId ? { intent: entry.intentId, status: entry.status } : { commit: entry.commit ?? null }), commands: [sync] }
  };
}

/** A refusal approval names that no other item carries, with the route the approval check gives it. */
function holdItem(workflow, kind, hold) {
  const command = hold.action?.command ?? `singularity-flow phase show ${workflow.currentPhase} --work-id ${workflow.workItem.id} --json`;
  return {
    kind, title: hold.summary.split(/(?<=[.!?])\s/u)[0].slice(0, 200), why: `${hold.who}: ${hold.summary}`,
    options: [{ ...personalStep({ id: 'route', label: hold.action?.label || hold.who, command, words: hold.who }) }],
    details: { code: hold.code, owner: hold.owner, commands: [command] }
  };
}

/** The step's approval itself: always the list's last item, so the first open item is what to do next. */
function approvalItem(workflow, context, phase, { heldBy, youDecide }) {
  const workId = workflow.workItem.id;
  const name = stepName(workflow, phase.id);
  const approvals = (phase.approvals ?? []).filter((entry) => !entry.invalidatedAt && entry.decision === 'approved').length;
  const minimum = phase.approvalPolicy?.minimum ?? 1;
  const waiting = heldBy.length ? `It waits for ${listWords(heldBy)} first.` : 'Nothing above holds it.';
  return {
    kind: 'approval', title: `Approve ${name}`,
    why: `${approvals} of ${minimum} approval${minimum === 1 ? '' : 's'} recorded. ${waiting}${youDecide.length ? ` You answer ${youDecide.length === 1 ? 'one question' : `${youDecide.length} questions`} in the approval itself.` : ''}`,
    options: [{ ...personalStep({ id: 'approve', label: heldBy.length ? `Approve ${name} once ${listWords(heldBy)} ${heldBy.length === 1 ? 'is' : 'are'} done` : `Review and approve ${name}`,
      command: `singularity-flow approve ${phase.id} --work-id ${workId} --fetch`, words: 'You review it and confirm once in your own terminal, in VS Code or with /sf-approve.' }),
    decidedBy: stepDecidedBy(workflow, context, approvers(workflow, phase.id), 'You review it and confirm once.') }],
    details: { phase: phase.id, generation: Number(phase.generation ?? 0), approvals, minimum, heldBy, youDecide, ready: !heldBy.length,
      commands: [`singularity-flow approve ${phase.id} --work-id ${workId} --fetch`] }
  };
}

/**
 * The item kinds approval refuses for while they are open (CONFORMANCE_BLOCKING_VERDICTS, the
 * Story's final evaluation): the ones pendingDecisionSummary counts. Screen sizes, test-run risks
 * and test-command requests are decided while a step is open, never at its approval.
 */
export const APPROVAL_HOLDING_KINDS = Object.freeze(['conformance-gap', 'upstream-issue', 'evidence-obligation']);

/**
 * Every place that once listed pending work on its own (SPEC-OAP, "What a person meets today") and
 * the item kinds that carry it on this one list [SPEC-OAP M3]. A `machine` concept is one Singularity
 * Flow finishes itself; a person sees it only when the automatic attempt failed. `codes` are the
 * approval-check holds that carry a concept with no reader of its own. Guard:
 * test/oap-m3-one-list.test.mjs.
 */
export const PENDING_CONCEPTS = Object.freeze({
  'unpushed-commits': Object.freeze({ kinds: ['story-publication'], machine: true }),
  'transport-intents': Object.freeze({ kinds: ['transport-intent'], machine: true }),
  'decision-list': Object.freeze({ kinds: ['conformance-gap', 'upstream-issue', 'visual-profile', 'test-run-risk', 'test-narrowing', 'test-command', 'evidence-obligation'] }),
  'routing-decision': Object.freeze({ kinds: ['routing-decision'] }),
  'owed-witnesses-and-scope-items': Object.freeze({ kinds: ['owed-decision', 'evidence-obligation'] }),
  'intent-amendments': Object.freeze({ kinds: ['intent-amendment'] }),
  'forward-amendments': Object.freeze({ kinds: ['forward-amendment'] }),
  appeals: Object.freeze({ kinds: ['appeal'] }),
  'repair-journal': Object.freeze({ kinds: ['approval-hold'], codes: ['PHASE_REPAIR_RECHECK_REQUIRED', 'PHASE_REPAIR_JOURNAL_INVALID'] }),
  'trp-risks': Object.freeze({ kinds: ['approval-hold'], codes: ['TRP_DOCUMENT_GATE_BLOCKED', 'TRP_PHASE_GATE_BLOCKED'] }),
  'quality-risks': Object.freeze({ kinds: ['approval-hold'], codes: ['ARTIFACT_AUTHORING_INCOMPLETE', 'PHASE_VALIDATION_FAILED'] })
});

/** Approval-check holds another item already carries: the approval names that item instead of repeating it. */
const HOLD_KINDS = Object.freeze({
  APPROVAL_INTENT_AMENDMENT_PENDING: 'intent-amendment', INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED: 'intent-amendment',
  DECISION_REQUIRED: 'routing-decision', PHASE_APPEAL_REVIEW_REQUIRED: 'appeal', PHASE_APPEAL_INTEGRITY: 'appeal',
  STORY_PUBLICATION_PENDING: 'story-publication', CONFORMANCE_BLOCKING_VERDICTS: 'conformance-gap', STORY_COMPLETION_REFUSED: 'conformance-gap'
});

/**
 * The item kind that carries one approval-check hold: its own item kind, the approval itself for an
 * answer this approver gives in the approval (`you-decide`), a test-run risk for a lapsed one, and
 * otherwise a hold item of its own.
 */
export function holdItemKind(hold) {
  if (hold.owner === 'you-decide') return 'approval';
  if (HOLD_KINDS[hold.code]) return HOLD_KINDS[hold.code];
  return /test-run risk/iu.test(hold.summary ?? '') && hold.owner === 'someone-decides' ? 'test-run-risk' : 'approval-hold';
}

// The kinds whose items are decided on this list itself; the digest binds their words and options.
const DECIDED_HERE = new Set(['conformance-gap', 'upstream-issue', 'visual-profile', 'test-run-risk', 'test-narrowing', 'test-command', 'evidence-obligation']);

/** Every item kind this list builds. */
export const PENDING_ITEM_KINDS = Object.freeze(['story-publication', 'routing-decision', 'intent-amendment', 'forward-amendment', 'appeal',
  'conformance-gap', 'upstream-issue', 'visual-profile', 'test-run-risk', 'test-narrowing', 'test-command', 'evidence-obligation', 'owed-decision',
  'approval-hold', 'transport-intent', 'approval']);

/** The commands a person or script uses to record, with the packet digest. */
export function decisionRecordCommand(workId, { phaseId = null, choices = [], digest, values = {} } = {}) {
  return ['singularity-flow decisions record', workId, ...(phaseId ? [`--phase ${phaseId}`] : []),
    ...choiceFlags(choices, values), `--confirm ${digest}`].join(' ');
}

/** The same choices recorded with the step's approval, in its one commit [SPEC-OAP M4]: the flags approve adds. */
export function decisionApprovalFlags({ choices = [], digest, values = {} } = {}) {
  return [...choiceFlags(choices, values), `--decisions ${digest}`].join(' ');
}

function choiceFlags(choices, values) {
  // POSIX single quotes, as canonicalDisplayToken in safe-command-guidance.mjs: a JSON double-quoted
  // reason would still expand `$()`, `$NAME` and backticks when the person pastes the command.
  const quote = (value) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`);
  const extra = Object.entries(values).flatMap(([flag, entries]) => Object.entries(entries ?? {})
    .map(([item, value]) => `--${flag} ${quote(`${item}=${value}`)}`));
  return [...choices.map(([item, chosen]) => `--choose ${item}=${chosen}`), ...extra];
}

/**
 * The packet: items, the digest over exactly what a person confirms (items, options, effects, the
 * defaults they would record, and the Story state they depend on), and the record commands.
 * `context`: { authorities, actor, at, requestedPhase }.
 */
export function decisionPacket(workflow, facts, { authorities, actor, at, requestedPhase = null } = {}) {
  const context = { workflow, facts, authorities, actor, at };
  const phase = workflow.phases?.[facts.phaseId] ?? null;
  const awaiting = phase?.status === 'awaiting_approval';
  const pending = facts.pending ?? {};
  const groups = decisionGroups(workflow, { gaps: facts.gaps, issues: facts.issues, includeAllIssues: facts.endsStory === true });
  const listed = [
    ...(pending.publication ? [machineItem(workflow, pending.publication)] : []),
    ...(pending.routing ? [routingItem(workflow, context, pending.routing)] : []),
    ...(pending.intentAmendments ?? []).map((amendment) => intentAmendmentItem(workflow, context, amendment)),
    ...(pending.forwardAmendments ?? []).map((blocker) => forwardAmendmentItem(workflow, context, blocker)),
    ...(pending.appeals ?? []).map((appeal) => appealItem(workflow, context, appeal)),
    ...groups.map((group) => (group.kind === 'conformance-gap' ? gapItem(workflow, context, group) : issueItem(workflow, context, group.state))),
    ...(facts.visual ?? []).map((entry) => visualItem(workflow, context, entry)),
    ...(facts.testRisks ?? []).map((risk) => testRiskItem(workflow, context, risk)),
    ...(facts.testNarrowings ?? []).map((entry) => testNarrowingItem(workflow, context, entry)),
    ...(facts.testCommands ?? []).map((request) => testCommandItem(workflow, context, request)),
    ...(facts.evidence ?? []).map((entry) => evidenceItem(workflow, context, entry)),
    ...(pending.owed ?? []).filter(entry => entry.kind !== 'witness' || !(facts.evidence ?? []).some(row =>
      row.criterion === entry.clauseId && row.witnesses.some(witness => witness.slot === entry.slot)))
      .map((entry) => owedItem(workflow, context, entry))
  ];
  // Each refusal approval names that no item carries becomes an item of its own; the approval itself
  // names the rest, so the list and the approval check never disagree [SPEC-OAP M3].
  const holds = awaiting ? (facts.approvalCheck?.holds ?? []) : [];
  const carried = new Set(listed.map((item) => item.kind));
  const extra = holds.filter((hold) => holdItemKind(hold) !== 'approval' && !carried.has(holdItemKind(hold)))
    .map((hold) => holdItem(workflow, holdItemKind(hold) === 'test-run-risk' ? 'test-run-risk' : 'approval-hold', hold));
  const heldKinds = new Set(holds.filter((hold) => hold.owner !== 'you-decide').map(holdItemKind));
  const held = (item) => APPROVAL_HOLDING_KINDS.includes(item.kind) || extra.includes(item) || (awaiting && heldKinds.has(item.kind)
    && (!item.details?.amendment || holds.some((hold) => String(hold.summary).includes(item.details.amendment))));
  const built = [...listed, ...extra, ...(pending.transport ?? []).map((entry) => machineItem(workflow, entry))];
  const items = built.map((item, index) => {
    // Recommended first, then in the order built.
    const options = [...item.options].sort((left, right) => Number(right.recommended) - Number(left.recommended));
    return { id: `d${index + 1}`, ...item, options, decidedBy: itemDecidedBy(workflow, options), holdsApproval: held(item) };
  });
  if (awaiting) {
    const approval = approvalItem(workflow, context, phase, { heldBy: items.filter((item) => item.holdsApproval).map((item) => item.id),
      youDecide: holds.filter((hold) => hold.owner === 'you-decide').map((hold) => hold.summary) });
    items.push({ id: `d${items.length + 1}`, ...approval, decidedBy: itemDecidedBy(workflow, approval.options), holdsApproval: false });
  }
  // The decisions approval refuses for: what pendingDecisionSummary counts for readiness and the
  // refusal (SPEC-OAP D5). `open` counts every item, the approval included: what every surface shows.
  const holding = items.filter((item) => APPROVAL_HOLDING_KINDS.includes(item.kind)).length;
  const workId = workflow.workItem.id;
  const phaseId = facts.phaseId;
  const bound = {
    revision: DECISION_LIST_REVISION, workId, phase: phaseId, at: String(at).slice(0, 10),
    // A person's own step and a refusal's words are not confirmed here: bound by what they are, not their prose.
    items: items.map(({ id, kind, title, why, options, details }) => (DECIDED_HERE.has(kind) && !details?.code ? { id, kind, title, why, details,
      options: options.map(({ id: optionId, label, recommended, effects, needs, decidedBy: who }) => ({ id: optionId, label, recommended, effects, needs, groups: who.groups })) }
      : { id, kind, details: Object.fromEntries(Object.entries(details ?? {}).filter(([key]) => key !== 'commands')) })),
    state: facts.state ?? null
  };
  const digest = `sha256:${recordSha256(bound)}`;
  const phaseOption = requestedPhase && requestedPhase !== workflow.currentPhase ? phaseId : null;
  const recommended = items.filter((item) => item.decidedBy.allowed).map((item) => [item.id, item.options.find((entry) => entry.recommended && entry.decidedBy.allowed)?.id])
    .filter(([, chosen]) => chosen);
  const decisions = items.filter((item) => item.kind !== 'approval' && !item.machine);
  const holdingAll = decisions.filter((item) => item.holdsApproval).length;
  const others = decisions.length - holdingAll;
  const headline = !decisions.length && awaiting ? `${stepName(workflow, phaseId)} has nothing left to decide; its approval is next.`
    : !awaiting || !others ? decisionHeadline(workflow, phaseId, decisions.length)
      : holdingAll ? `${decisionHeadline(workflow, phaseId, holdingAll)} ${others === 1 ? '1 other decision does' : `${others} other decisions do`} not hold its approval.`
        : `${stepName(workflow, phaseId)} has ${others === 1 ? '1 open decision' : `${others} open decisions`}; none holds its approval.`;
  const [first] = items;
  // When every option left is a person's own terminal step, /sf-decide would only show it again: a
  // command no skill runs (a witness, an obligation risk), or a choice recorded on this list that a
  // /sf-decide turn may not record (an accepted test command). The route is that command.
  const theirsAlone = (item) => item.options.length > 0 && item.options.every((entry) => (entry.recordable === false
    ? typeof entry.action?.command === 'string' && commandLineWithoutSkill(entry.action.command)
    : !DECISION_LIST_CHAT_OPTIONS.includes(entry.id)));
  const listRoute = decisions.length && decisions.every(theirsAlone) ? null : `/sf-decide ${workId}`;
  return {
    schemaVersion: 1, resultType: 'sflow-decisions', revision: DECISION_LIST_REVISION,
    ...(facts.repositoryPath ? { repositoryPath: facts.repositoryPath } : {}),
    recorded: (workflow.planAmendments ?? []).slice(-10).map(record => ({ id: record.id, kind: 'plan-accounting',
      at: record.at, summary: (record.changes ?? []).map(change => `${change.path} accounted for${change.clauseId ? ` under ${change.clauseId}` : ''}`).join('; ') })),
    workId, phase: phaseId, phaseLabel: stepName(workflow, phaseId), status: decisions.length ? 'decisions-needed' : 'nothing-to-decide',
    headline, rule: CONFORMANCE_GAP_RULE,
    items, holding, open: items.length,
    ...(facts.inactiveTestCommands?.length ? { inactiveTestCommands: facts.inactiveTestCommands } : {}),
    // What to do next: the first open item, with its first route.
    next: first ? { item: first.id, kind: first.kind, title: first.title, command: first.options[0]?.action?.command ?? `singularity-flow decisions ${workId}`,
      copilotCommand: first.kind === 'approval' ? `/sf-approve ${phaseId} --work-id ${workId}` : listRoute } : null,
    packetSha256: digest,
    record: {
      form: `singularity-flow decisions record ${workId}${phaseOption ? ` --phase ${phaseOption}` : ''} --choose <ITEM>=<OPTION> [--reason <ITEM>=TEXT] [--expires <ITEM>=YYYY-MM-DD] [--cause <ITEM>=TEXT] --confirm ${digest}`,
      recommended: recommended.length ? decisionRecordCommand(workId, { phaseId: phaseOption, choices: recommended, digest }) : null,
      interactive: `singularity-flow decisions record ${workId}${phaseOption ? ` --phase ${phaseOption}` : ''}`,
      // Beside the record commands: null when no choice left may be recorded in a /sf-decide turn.
      copilotCommand: listRoute,
      share: `/sf-decide ${workId}`
    },
    ...(facts.unavailable?.length ? { unavailable: facts.unavailable } : {})
  };
}

/**
 * What every surface shows of the list [SPEC-OAP M3]: how many items are open (the approval
 * included), the first one, and each item's kind, title and whether it holds the approval. The
 * inbox, Reviews, the Navigator, next steps and the journey count from this, never from a reader
 * of their own.
 */
export function pendingSummary(packet) {
  return {
    open: packet.open, headline: packet.headline, next: packet.next,
    items: packet.items.map(({ id, kind, title, holdsApproval, machine, decidedBy }) => ({ id, kind, title, holdsApproval,
      ...(machine ? { machine: true } : {}), yours: decidedBy?.allowed === true })),
    command: `singularity-flow decisions ${packet.workId}`, copilotCommand: `/sf-decide ${packet.workId}`
  };
}

/** A real YYYY-MM-DD day after today and no later than the option's own last day. */
function validDate(value, at, latest) {
  const text = String(value ?? '');
  const day = /^\d{4}-\d{2}-\d{2}$/u.test(text) ? Date.parse(`${text}T00:00:00.000Z`) : Number.NaN;
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== text) return false;
  return text > String(at).slice(0, 10) && text <= latest;
}

/**
 * The person's answers from `--choose d1=reuse` style values (repeatable) or an answers file:
 * { choose: { d1: 'reuse' }, reason: { d1: 'TEXT' }, expires: { d1: 'YYYY-MM-DD' }, cause: { ... } }.
 */
export function parseDecisionAnswers({ choose = [], reason = [], expires = [], cause = [] } = {}) {
  const read = (flag, values) => {
    const entries = Array.isArray(values) ? values.map((value) => {
      const text = String(value);
      const split = text.indexOf('=');
      if (split < 1) refused(`--${flag} takes <ITEM>=<VALUE>, such as d1=${flag === 'choose' ? 'reuse' : 'TEXT'}; got '${text}'.`, 'DECISIONS_ANSWER_INVALID');
      return [text.slice(0, split).trim(), text.slice(split + 1)];
    }) : Object.entries(values ?? {}).map(([item, value]) => [item, String(value)]);
    const map = new Map();
    for (const [item, value] of entries) {
      if (!/^d\d{1,3}$/u.test(item)) refused(`--${flag} names '${item}', which is not an item of the list (d1, d2, ...).`, 'DECISIONS_ANSWER_INVALID');
      if (map.has(item)) refused(`--${flag} names ${item} twice.`, 'DECISIONS_ANSWER_INVALID');
      map.set(item, value);
    }
    return map;
  };
  return { choose: read('choose', choose), reason: read('reason', reason), expires: read('expires', expires), cause: read('cause', cause) };
}

/**
 * What recording these answers would write, item by item, in the packet's order, with every value
 * resolved (an answer, or the default the packet showed). Items this identity may not decide are
 * returned in `refused` with who may; nothing is written for them. Pure; never writes.
 */
export function decisionRecordPlan(packet, answers, { at }) {
  const steps = [];
  const refusedItems = [];
  for (const item of packet.items) {
    const chosen = answers.choose.get(item.id);
    if (!chosen) {
      for (const flag of ['reason', 'expires', 'cause']) {
        if (answers[flag].has(item.id)) refused(`--${flag} ${item.id}=... is given, but ${item.id} is not chosen with --choose.`, 'DECISIONS_ANSWER_INVALID');
      }
      continue;
    }
    const selected = item.options.find((entry) => entry.id === chosen);
    if (!selected) {
      refused(`${item.id} has no option '${chosen}'; its options are ${item.options.map((entry) => entry.id).join(', ')}.`, 'DECISIONS_ANSWER_INVALID',
        { item: item.id, options: item.options.map((entry) => entry.id) });
    }
    for (const flag of ['reason', 'expires', 'cause']) {
      if (answers[flag].has(item.id) && !selected.needs[flag]) refused(`${item.id}=${chosen} takes no --${flag}.`, 'DECISIONS_ANSWER_INVALID');
    }
    if (selected.recordable === false) {
      refused(selected.action
        ? item.kind === 'visual-profile'
          ? `${item.id}=${chosen} is your action, not a recorded decision: take the screenshot and run ${selected.action.command}`
          : `${item.id}=${chosen} is your own step, not a recorded decision: ${selected.words} Run: ${selected.action.command}`
        : `${item.id}=${chosen} is not available: ${selected.words}`, 'DECISIONS_OPTION_NOT_RECORDABLE', { item: item.id, option: chosen, command: selected.action?.command ?? null });
    }
    if (!selected.decidedBy.allowed) {
      refusedItems.push({ item: item.id, title: item.title, option: chosen, words: selected.decidedBy.words, groups: selected.decidedBy.groups,
        share: selected.decidedBy.share ?? `/sf-decide ${packet.workId}` });
      continue;
    }
    const values = {};
    if (selected.needs.reason) {
      const reason = String(answers.reason.get(item.id) ?? selected.needs.reason.default).trim();
      if (reason.length < REASON.minimum || reason.length > REASON.maximum) {
        refused(`The reason for ${item.id} must be ${REASON.minimum} to ${REASON.maximum} characters.`, 'DECISIONS_ANSWER_INVALID', { item: item.id });
      }
      values.reason = reason;
    }
    if (selected.needs.cause) {
      const cause = String(answers.cause.get(item.id) ?? selected.needs.cause.default).trim();
      if (cause.length < CAUSE.minimum || cause.length > CAUSE.maximum) {
        refused(`The cause for ${item.id} must be ${CAUSE.minimum} to ${CAUSE.maximum} characters.`, 'DECISIONS_ANSWER_INVALID', { item: item.id });
      }
      values.cause = cause;
    }
    if (selected.needs.expires) {
      const expires = String(answers.expires.get(item.id) ?? selected.needs.expires.default).trim();
      if (!validDate(expires, at, selected.needs.expires.latest)) {
        refused(`The date for ${item.id} must be YYYY-MM-DD, after today and no later than ${selected.needs.expires.latest}.`,
          'DECISIONS_ANSWER_INVALID', { item: item.id });
      }
      values.expires = expires;
    }
    steps.push({ item: item.id, title: item.title, option: chosen, label: selected.label, values,
      effects: selected.effects.map((effect) => ({ ...effect })) });
  }
  return { steps, refused: refusedItems };
}

/** One record a plan writes, in plain words with its record kind, for summaries and reports. */
export function effectWords(workflow, effect, values = {}) {
  if (effect.kind === 'evidence-reuse') {
    return `reuse ${stepName(workflow, effect.recordedBy)}'s recorded run for ${stepName(workflow, effect.phase)} (evidence reuse ${effect.attemptId})`;
  }
  if (effect.kind === 'upstream-issue') return `report the gap against ${stepName(workflow, effect.phase)} (new upstream issue about ${effect.about})`;
  if (effect.kind === 'test-run-risk') return `accept that ${effect.commandId} cannot run here until ${values.expires} (test-run risk)`;
  if (effect.kind === 'test-narrowing') return `accept that ${effect.commandId} ran narrowed for ${stepName(workflow, effect.phase)} (test-narrowing decision)`;
  if (effect.kind === 'test-command') return `run ${effect.request}'s command as ${stepName(workflow, effect.phase)}'s tests for this Story (test-command decision)`;
  if (effect.kind === 'visual-profile') return `record that screen size ${effect.profileId} does not apply to this Story (visual-profile decision)`;
  const what = { 'accept-risk': `accept it as a risk until ${values.expires}`, dismiss: 'dismiss it', return: `return the work to ${stepName(workflow, effect.issuePhase)}` }[effect.outcome] ?? effect.outcome;
  return `${what} (decision on ${effect.issue ?? 'the new upstream issue'})`;
}

/**
 * Write a plan's effects in order through `apply(effect, step, produced)`, which records one effect
 * with its existing function and returns the record. A failure stops there: the result says exactly
 * which records were written and which remain, so nothing is guessed and a rerun lists only what
 * remains.
 */
export async function runDecisionPlan(plan, apply) {
  const recorded = [];
  for (const [stepIndex, step] of plan.steps.entries()) {
    const produced = {};
    for (const [effectIndex, effect] of step.effects.entries()) {
      try {
        const record = await apply(effect, step, produced);
        if (effect.kind === 'upstream-issue') produced.issue = record?.id ?? null;
        recorded.push({ item: step.item, kind: effect.kind, record });
      } catch (error) {
        const remaining = [
          ...step.effects.slice(effectIndex).map((entry) => ({ item: step.item, kind: entry.kind, effect: entry })),
          ...plan.steps.slice(stepIndex + 1).flatMap((later) => later.effects.map((entry) => ({ item: later.item, kind: entry.kind, effect: entry })))
        ];
        return { recorded, failed: { item: step.item, kind: effect.kind, error }, remaining };
      }
    }
  }
  return { recorded, failed: null, remaining: [] };
}
