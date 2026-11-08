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
import { NODE_PIN_CLASS } from './node-pin-names.mjs';
import { ISSUE_ONLY_OPTIONS } from './person-step-catalog.mjs';
import { MAX_PLAN_AMENDMENT_CHANGES, planAuthorities } from './plan-amendments.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { classifySupportingChange } from './supporting-changes.mjs';
import { matchApprovalAuthority, normalizeApprovalAuthorities } from './approval-authority.mjs';
import { commandLineWithoutSkill, DECISION_LIST_CHAT_OPTIONS } from './command-skills.mjs';
import { recordSha256 } from './records.mjs';
import { pinDiffWords, testCommandReviewHold } from './story-test-commands.mjs';
import { testSetupFiles } from './test-support-files.mjs';
import { testRunCauseWords } from './test-run-cause.mjs';
import { testRunRiskAuthorities } from './test-run-risk.mjs';
import { decisionGroups, decisionRefusalLead } from './decision-list-facts.mjs';
import { CONFORMANCE_GAP_RULE, decidableUpstreamStep, decisionHeadline, DIFFERENCE_VERDICTS, issueNamesClause, stepName, upstreamIssueOutcomes, upstreamReturnLegal } from './upstream-routes.mjs';
import { SingularityFlowError } from './util.mjs';

export { decisionGroups, decisionHeadline, decisionRefusalLead, stepName };
export const DECISION_LIST_REVISION = 'decision-list-v1';
export { ISSUE_ONLY_OPTIONS } from './person-step-catalog.mjs';
export const DEFAULT_RISK_DAYS = 30;
const MAX_RISK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
// The order a chosen option's records are written in: an issue exists before it is decided.
// A draft writes no record, so it goes first: a later record that fails leaves only a file a person may delete.
const EFFECT_ORDER = Object.freeze(['intent-amendment-draft', 'upstream-issue', 'evidence-reuse', 'test-run-risk', 'test-narrowing', 'test-command', 'visual-profile', 'plan-amendment', 'departure', 'node-pin', 'obligation-risk', 'scope-disposition', 'completeness-review', 'applicability', 'convergence-adjudication', 'routing', 'upstream-issue-decision']);
// Effects that carry the groups their own command checks, read where the list's facts are read.
const EFFECTS_NAMING_GROUPS = Object.freeze(['obligation-risk', 'scope-disposition', 'completeness-review', 'applicability', 'routing', 'departure']);
const REASON = Object.freeze({ minimum: 20, maximum: 1000 });
const CAUSE = Object.freeze({ minimum: 10, maximum: 300 });
// `decision plan`'s own limits: a supporting change states its reason in at most 500 characters.
const PLAN_REASON = Object.freeze({ minimum: 20, maximum: 1000 });
const SUPPORTING_REASON = Object.freeze({ minimum: 20, maximum: 500 });
// `decision choose` asks only for a reason the log can keep.
const ROUTING_REASON = Object.freeze({ minimum: 1, maximum: 1000 });
// DECIDABLE_SCOPE_DISPOSITIONS in src/scope/extract.mjs, as a person reads them; a test pins the two equal.
const SCOPE_CHOICES = Object.freeze([['included', 'Included: named clauses carry it', true], ['existing', 'It already exists: named clauses carry it', true],
  ['excluded', 'Exclude it from this Story', false], ['deferred', 'Defer it to later work', false], ['informative', 'It informs; it is not a requirement', false],
  ['duplicate', 'It duplicates another statement', false], ['superseded', 'A later statement replaces it', false]]);

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
  // Drafting an amendment decides nothing, and its own command checks no group; the scope approvers decide the amendment.
  if (effect.kind === 'upstream-issue' || effect.kind === 'intent-amendment-draft') return null;
  if (effect.kind === 'upstream-issue-decision') return issueGroups(workflow, effect.issuePhase);
  // `story adjudicate` checks the convergence step's approval authority.
  if (effect.kind === 'convergence-adjudication') return issueGroups(workflow, effect.phase);
  if (effect.kind === 'plan-amendment' || effect.kind === 'node-pin') return planAuthorities(workflow);
  if (EFFECTS_NAMING_GROUPS.includes(effect.kind)) return effect.groups ?? [];
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
  // Its author's own step is shared with nobody: /sf-decide has nothing to decide there.
  if (!mine.length) return { ...lead.decidedBy, groups, labels, allowed: false, ...(lead.decidedBy.author ? {} : { share: `/sf-decide ${workflow?.workItem?.id ?? '<WORK-ID>'}` }) };
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

/**
 * One item for deviated or unplanned rows [SCS:REQ-012]: the code differs from what the clause says, so a
 * person decides which one changes. Fix the code (return to the code step), update the spec (write the
 * owning step's document as the code does it, decided by its approvers), accept it for now until a
 * date, or dismiss a wrong row. Only existing records are written, under their own authority rules.
 */
function differenceItem(workflow, context, group) {
  const { issue, owner, gaps } = group;
  const clauses = [...new Set(gaps.map((gap) => gap.clauseId))];
  const names = listWords(clauses.map((clause) => clauseName(workflow, clause)));
  const verdicts = [...new Set(gaps.map((gap) => gap.verdict))];
  const reports = [...new Set(gaps.map((gap) => gap.report))];
  const reportWords = listWords(reports.map((id) => `${stepName(workflow, id)} report`));
  const isAre = clauses.length === 1 ? 'is' : 'are';
  const ownerName = stepName(workflow, owner);
  const said = gaps.filter((gap) => gap.difference).map((gap) => `${clauseName(workflow, gap.clauseId)}: ${String(gap.difference).slice(0, 300)}`);
  const why = [`The ${reportWords} marks ${names} ${listWords(verdicts)}: the code does not do what ${clauses.length === 1 ? 'it says' : 'they say'}.`,
    ...(said.length ? [`It says: ${said.join('; ')}.`] : []),
    ...(issue ? [`A problem reported against ${ownerName} names ${clauses.length === 1 ? 'it' : 'them'} and is not decided yet.`] : []),
    'Decide which one changes: the code or the spec. The verdict stays as written.'];
  const target = issue ?? { id: null, phase: owner };
  const raise = issue ? [] : [{ kind: 'upstream-issue', phase: owner, about: clauses.join(', ').slice(0, 200),
    problem: `The ${reportWords} marks ${clauses.join(', ')} ${listWords(verdicts)}: ${(said.join('; ') || 'the code differs from the clause').slice(0, 600)}. Raised from the decision list.` }];
  const choices = gaps.flatMap((gap) => gap.choices ?? []);
  const fix = choices.find((choice) => choice.kind === 'fix-code' && choice.command);
  const update = choices.find((choice) => choice.kind === 'update-spec' && choice.command);
  // A draft already written for these clauses, from the approved scope as it is now: writing it and proposing it is next [SCS:REQ-022].
  const draft = context.facts.intentAmendmentDraft ?? null;
  const drafted = Boolean(update && draft?.path && clauses.every((clause) => (draft.clauses ?? []).some((id) => sameClause(id, clause))));
  if (drafted) why.splice(why.length - 1, 0, `A draft of ${stepName(workflow, update.owner)}'s scope with a slot for ${clauses.length === 1 ? 'it' : 'each of them'} is at ${draft.path}: `
    + `write ${clauses.length === 1 ? 'it' : 'them'} as the code does it, then propose it.`);
  const options = [];
  if (fix) {
    options.push({ ...personalStep({ id: 'fix-code', label: `Fix the code: return to ${stepName(workflow, fix.owner)}`, command: fix.command,
      words: `The code is changed to do what ${names} ${clauses.length === 1 ? 'says' : 'say'}; the steps after it run again and the report is written again.` }),
    decidedBy: decidedBy(workflow, [{ kind: 'upstream-issue-decision', issuePhase: reports[0] }], context) });
  }
  if (update && drafted) {
    // The wording is a person's or the Story's agent's [SCS:REQ-021]: propose refuses while a slot is left.
    const scopeName = stepName(workflow, update.owner);
    const propose = `singularity-flow story intent-amendment propose --work-id ${workflow.workItem.id} --file "${draft.path}" --reason "<why the specification changes>"`;
    const words = `The draft is at ${draft.path}. Write ${clauses.length === 1 ? 'the clause' : 'each clause'} in place of its sflow-draft slot and delete the closing line, `
      + `or ask the Story's agent (/sf-reject intent-amendment propose); then propose it. ${scopeName}'s approvers decide it.`;
    const step = personalStep({ id: 'update-spec', label: 'Update the spec: write the draft and propose it', command: propose, words,
      decidedBy: anyone(`Anyone working on this Story may write and propose it; ${scopeName}'s approvers decide it.`) });
    // The file a host may open for the person: the engine's own path, never one a page sends back.
    options.push({ ...step, action: { ...step.action, file: draft.path } });
  } else if (update) {
    // One choice drafts it [SCS:REQ-020]: built from the approved bytes with a slot per clause holding its row
    // and the person's reason. It writes no record and decides nothing; the scope approvers decide the amendment.
    const scopeName = stepName(workflow, update.owner);
    const built = option(workflow, context, {
      id: 'update-spec', label: `Update the spec: draft ${scopeName}'s amendment`,
      words: `Writes a draft of ${scopeName}'s scope with a slot for ${clauses.length === 1 ? 'this clause' : 'each clause'}, holding the row and your reason; nothing is recorded or decided. `
        + `Then write ${clauses.length === 1 ? 'it' : 'them'} as the code does it and propose it; ${scopeName}'s approvers decide it, and nothing is rewound until they do.`,
      effects: [{ kind: 'intent-amendment-draft', phase: update.owner, clauses, path: draft?.path ?? null,
        rows: gaps.map((gap) => ({ clauseId: gap.clauseId, verdict: gap.verdict, difference: gap.difference ? String(gap.difference).slice(0, 400) : null,
          report: `${stepName(workflow, gap.report)} report` })) }],
      needs: { reason: textNeed('', REASON) }
    });
    options.push({ ...built, decidedBy: anyone(`Anyone working on this Story may draft it; ${scopeName}'s approvers decide the amendment.`) });
  }
  options.push(option(workflow, context, {
    id: 'accept-risk', label: 'Accept the difference for now, until a date',
    words: `The code and ${names} stay different until the date, then it needs a decision again.`,
    effects: [...raise, issueDecision(target, 'accept-risk')],
    needs: { expires: expiryNeed(context.at), reason: textNeed(`Accepted for now: ${names} ${isAre} ${listWords(verdicts)} as the ${reportWords} says.`, REASON) }
  }));
  options.push(option(workflow, context, {
    id: 'dismiss', label: 'Dismiss it: the row is wrong',
    words: 'Use this only when the code does what the clause says; the verdict itself is never edited.',
    effects: [...raise, issueDecision(target, 'dismiss')],
    needs: { reason: textNeed(`Dismissed: the code does what ${names} ${clauses.length === 1 ? 'says' : 'say'}; the report's row is wrong.`, REASON) }
  }));
  return {
    kind: 'conformance-gap',
    title: `${names} ${isAre} ${listWords(verdicts)} in the ${reportWords}`,
    why: why.join(' '),
    options,
    details: { clauses, verdicts, owner, reports, issue: issue?.id ?? null, issueStatus: issue?.status ?? (issue ? 'open' : 'unraised'),
      differences: gaps.map((gap) => ({ clause: gap.clauseId, verdict: gap.verdict, difference: gap.difference ?? null })),
      draft: drafted ? { path: draft.path, clauses: draft.clauses } : null,
      supersedes: issue ? (context.facts.issues ?? []).filter((state) => state.supersededBy === issue.id).map((state) => state.issue.id) : [],
      reuse: null, rule: CONFORMANCE_GAP_RULE, commands: [...new Set(choices.map((choice) => choice.command).filter(Boolean))] }
  };
}

/** One item for a conformance gap, with the open upstream issue that names its clauses when there is one. */
function gapItem(workflow, context, group) {
  const { issue, owner, gaps } = group;
  if (gaps.length && gaps.every((gap) => DIFFERENCE_VERDICTS.includes(gap.verdict))) return differenceItem(workflow, context, group);
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
  // Every clause here reads satisfied in the record: the report is the thing to look at again, not the step before it.
  const reportOnly = !issue && gaps.every((gap) => gap.evidenceSatisfied);
  const why = [`The ${reportWords} marks ${names} ${listWords(verdicts)}; ${issue
    ? `${ownerName} owns the linked upstream problem` : reportOnly ? `the recorded evidence reads ${clauses.length === 1 ? 'it' : 'them'} satisfied, so nothing shows ${ownerName} at fault`
      : `${ownerName} delivered ${clauses.length === 1 ? 'it' : 'them'}`}.`];
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
  const corrected = reportOnly ? gaps.flatMap((gap) => gap.choices ?? []).find((choice) => choice.kind === 'correct-report' && choice.command) : null;
  if (corrected) {
    options.push({ ...personalStep({ id: 'correct-report', label: `Return ${reports.map((id) => stepName(workflow, id)).join(' and ')} to correct the report`,
      command: corrected.command, words: 'Its author checks the verdict against the recorded evidence and publishes it again; nothing before it changes.' }),
    decidedBy: decidedBy(workflow, [{ kind: 'upstream-issue-decision', issuePhase: reports[0] }], context) });
  }
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

/** A step anyone may take: nobody's approval is involved. Said only where the step's own command checks no group. */
const anyone = (words) => ({ groups: [], labels: [], allowed: true, words });

/** Nothing names who takes this step: it is never said to be this person's, and never said to be anyone's. */
const nobodyNamed = (words) => ({ groups: [], labels: [], allowed: false, words: `Singularity Flow cannot say who decides this. ${words}`.trimEnd() });

/**
 * A choice that is the person's own step. `recordable: false` says only that `decisions record` does
 * not write it; whether a chat turn may run its command is the guard's (command-skills.mjs).
 */
function personalStep({ id, label, command, words, decidedBy = nobodyNamed(words) }) {
  return { id, label, recommended: false, words, effects: [], needs: {}, recordable: false,
    action: { command, alternativeCommands: [] }, decidedBy };
}

const RISK_CATEGORY_WORDS = Object.freeze({ 'external-dependency': 'it depends on something outside this change', 'known-failure': 'a known failure',
  'assurance-shortfall': 'less assurance than was asked for', 'deferred-verification': 'it will be verified later', 'accepted-deviation': 'an accepted deviation' });

/**
 * One item per criterion whose evidence approval waits on a person for: witness each slot after
 * looking at it, or accept the obligation as a dated risk. Both are the person's own commands.
 */
function evidenceItem(workflow, context, entry) {
  const name = clauseName(workflow, entry.criterion);
  const slots = entry.witnesses.map((witness) => witness.files.length === 1 ? witness.files[0] : `slot ${witness.slot}`);
  const owedFor = (witness) => (context.facts.pending?.owed ?? []).find(row => row.kind === 'witness' && row.clauseId === entry.criterion && row.slot === witness.slot);
  const notYet = (witness) => owedFor(witness)?.available === false;
  const options = [
    ...entry.witnesses.map((witness) => {
      const owed = owedFor(witness);
      const words = notYet(witness) ? notPublishedYet(workflow, owed) : 'You look at the evidence yourself and record the witness with its three confirmations; nothing is decided here.';
      const step = personalStep({
      id: `witness-${witness.slot}`,
      label: notYet(witness) ? `Witness ${listWords(witness.files)} once it is published` : witness.files.length === 1 ? `I checked ${witness.files[0]}: witness it` : `I checked the ${witness.method} evidence for slot ${witness.slot}: witness it`,
      command: notYet(witness) ? null : witness.command,
      words,
      decidedBy: stepDecidedBy(workflow, context, owed?.groups ?? witness.groups ?? [...new Set((owed?.owners ?? []).flatMap(id => approvers(workflow, id)))], words)
      });
      if (notYet(witness)) return { ...step, available: false };
      return owed ? { ...step,
        action: { ...step.action, humanReview: { kind: 'witness', clauseId: owed.clauseId, clauseText: owed.clauseText, slot: owed.slot, method: owed.method,
          files: owed.files, owners: owed.owners, contextBinding: owed.contextBinding } } } : step;
    }),
    ...entry.risks.flatMap((risk, index) => (risk.obligationId ? entry.categories : []).map((category) => option(workflow, context, {
      id: `accept-obligation-risk-${category}${entry.risks.length === 1 ? '' : `-${index + 1}`}`,
      label: `Accept it as a risk until a date: ${RISK_CATEGORY_WORDS[category] ?? category}`,
      words: 'The verdict does not change; the obligation reads as excepted until that date, and a changed result needs a new decision.',
      effects: [{ kind: 'obligation-risk', obligation: risk.obligationId, category, groups: risk.groups ?? [] }],
      needs: { expires: expiryNeed(context.at, { endOfDay: true }), reason: textNeed('', REASON) }
    })))
  ];
  return {
    kind: 'evidence-obligation',
    title: slots.length ? `Check the evidence for ${name}` : `Decide the open evidence for ${name}`,
    why: `${name} is ${entry.result}: ${slots.length ? `approval waits for a person to witness ${listWords(slots)} for this change` : 'an obligation is still open'}. `
      + 'Witness it if it shows the outcome, or accept a dated risk; the verdict itself does not change.',
    options,
    details: { criterion: entry.criterion, result: entry.result,
      witnesses: entry.witnesses.map((witness) => (notYet(witness) ? { ...witness, command: null } : witness)), risks: entry.risks, categories: entry.categories,
      commands: [...entry.witnesses.filter((witness) => !notYet(witness)).map((witness) => witness.command), ...entry.risks.map((risk) => risk.command)] }
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

/**
 * One choice for a Node that does not suit the tests: a person pins an installed one, and that one
 * answer creates the file and accounts for it in the plan (src/node-pin.mjs). Before any run it is listed
 * and stops nothing; after a failed run it is what the step waits on.
 */
function nodePinItem(workflow, context, pin) {
  const name = stepName(workflow, pin.phase);
  const workId = workflow.workItem.id;
  const tryIt = `singularity-flow tests node --work-id ${workId} --phase ${pin.phase} --node ${pin.version}`;
  const { replaces = null } = pin;
  return {
    kind: 'node-pin',
    title: `${name}'s tests need another Node`,
    why: `${pin.words}${pin.words.includes(`Node ${pin.node}`) ? '' : ` Node ${pin.node} is installed here.`} ${pin.tried?.words ?? `Whether the tests pass on it is not known yet: ${tryIt} finds out and records nothing as evidence.`} ${replaces ? `Changing ${pin.file} to it amends the plan, or install Node ${replaces} and there is nothing to choose` : `Pinning it creates ${pin.file} and amends the plan`}; the code and its tests stay as they are.`,
    options: [option(workflow, context, {
      id: 'pin-node', label: replaces ? `Change ${pin.file} from ${replaces} to Node ${pin.version} and amend the plan` : `Pin Node ${pin.version}: create ${pin.file} and amend the plan`,
      words: `${replaces ? `Replaces ${replaces} with ${pin.version} in ${pin.file}` : `Creates ${pin.file} holding ${pin.version}`} in this checkout and lists it in the plan as a supporting change (${NODE_PIN_CLASS}) with your reason. SFlow then runs this repository's tests on Node ${pin.node}.`,
      effects: [{ kind: 'node-pin', phase: pin.phase, file: pin.file, version: pin.version, class: NODE_PIN_CLASS, ...(replaces ? { replaces } : {}) }],
      needs: { reason: textNeed('', SUPPORTING_REASON) }
    })],
    details: { phase: pin.phase, file: pin.file, version: pin.version, node: pin.node, running: pin.running ?? null, stage: pin.stage, commandId: pin.commandId ?? null, ...(replaces ? { replaces } : {}),
      commands: [`singularity-flow decisions record ${workId}`, tryIt] }
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
  // What a person actually decides: the before and after, and whether tests were dropped.
  const beforeAfter = request.repin?.diff?.length ? ` Before and after: ${request.repin.diff.map(pinDiffWords).join('; ')}.` : '';
  const dropped = request.repin?.dropped ? ` ${request.repin.dropped}` : '';
  return {
    kind: 'test-command',
    title: removed ? `Stop running ${command.id}, a test suite removed from ${name}`
      : request.repin ? `Re-pin ${command.id}, ${name}'s changed test command` : `Run ${command.id} as ${name}'s tests for this Story`,
    why: removed
      ? `${command.id} was pinned for this Story and its module no longer declares it, so the gate refuses the removal. ${request.requestedBy} asked that it no longer run: `
        + `${request.reason} Once accepted, ${name} no longer runs it; every other test must still pass.`
      : request.repin
      ? `${command.id} changed since it was pinned for this Story (${changed}), so the gate refuses it.${beforeAfter}${dropped} ${request.requestedBy} asked that it now run `
        + `${JSON.stringify(command.argv)} from ${command.workingDirectory}: ${request.reason} Once accepted, the next gate run records this as its pin; its tests must still pass.`
      : `${request.requestedBy} asked that ${name} run ${JSON.stringify(command.argv)} from ${command.workingDirectory}, reading ${command.result.adapter} ${command.result.path}, `
        + `covering ${listWords(command.affectedRoots)}: ${request.reason} Once accepted it runs at every publication and submission of ${name}, and its tests must pass.`,
    // Accepting it while the step awaits approval would make that review stale: return the step first.
    options: [hold ? personalStep({ id: 'return-step-first', label: `Return ${name} for changes first`, command: hold.command, words: hold.words,
      decidedBy: stepDecidedBy(workflow, context, approvers(workflow, request.phase), hold.words) })
      : option(workflow, context, {
        id: 'accept-test-command', label: removed ? 'Accept that this suite no longer runs' : request.repin ? 'Accept the changed command as its pin' : 'Accept this command for this Story',
        words: request.repin ? 'Only this Story\'s pin changes; the repository configuration is unchanged.'
          : 'The repository configuration is unchanged; propose it there with /sf-test-setup for later Stories.',
        effects: [{ kind: 'test-command', phase: request.phase, request: request.id }],
        needs: { reason: textNeed(`${command.id} runs ${name}'s tests for this Story.`, { minimum: 0, maximum: REASON.maximum }) }
      })],
    details: { phase: request.phase, request: request.id, command,
      ...(request.repin?.diff ? { repin: { diff: request.repin.diff, dropped: request.repin.dropped ?? null, ...(request.repin.pathNarrowing ? { pathNarrowing: request.repin.pathNarrowing } : {}) } } : {}),
      commands: [`singularity-flow decision test-command ${workflow.workItem.id} --accept ${request.id}`] }
  };
}

/**
 * Who takes a person's own step: the approval groups it needs, whether this identity holds one, and,
 * when it does not, who does (their labels and up to five members) and the line to share with them.
 */
function stepDecidedBy(workflow, { authorities, actor }, groups, words) {
  if (!groups?.length) return nobodyNamed(words);
  let registry = null;
  try { registry = normalizeApprovalAuthorities(authorities); } catch { registry = null; }
  const labels = groups.map((id) => groupLabel(registry, id));
  let allowed = false;
  try { allowed = matchApprovalAuthority(authorities, { authorities: groups }, actor).authorized; } catch { allowed = false; }
  if (allowed) return { groups, labels, allowed: true, words: `You may do this (${listWords(labels)}). ${words}`.trimEnd() };
  const people = [...new Set(groups.flatMap((id) => (registry?.[id]?.members ?? []).map((member) => member.name ?? member.email ?? member.githubLogin)))].slice(0, 5);
  return { groups, labels, allowed: false, ...(people.length ? { people } : {}),
    words: `The ${listWords(labels)}${people.length ? ` (${listWords(people)})` : ''} decide this; ask them.`,
    share: `/sf-decide ${workflow?.workItem?.id ?? '<WORK-ID>'}` };
}

/** One item that is a person's own step, with who takes it. */
function stepItem(workflow, context, { kind, title, why, groups = [], forAnyone = false, options, details }) {
  const steps = options.map((entry) => ({ ...personalStep(entry),
    ...(entry.humanReview ? { action: { command: entry.command, humanReview: entry.humanReview } } : {}),
    ...(entry.available === false ? { available: false } : {}),
    decidedBy: forAnyone ? anyone(entry.words) : stepDecidedBy(workflow, context, groups, entry.words) }));
  return { kind, title, why, options: steps, details: { ...details, commands: steps.map((entry) => entry.action.command).filter(Boolean) } };
}

const approvers = (workflow, phaseId) => issueGroups(workflow, phaseId);

/**
 * The workflow's own routing decision waiting after a step. Each route is a choice recorded here, and
 * `chat` is the same write as a /sf-decide turn runs it with the person's own reason. With no group
 * named it stays their own step, since nothing could say who may choose.
 */
function routingItem(workflow, context, pending) {
  const workId = workflow.workItem.id;
  const after = stepName(workflow, pending.after);
  const base = { kind: 'routing-decision', title: `Choose where ${workId} goes after ${after}: ${pending.label ?? pending.decision}`,
    why: `${pending.reason === 'limit' ? `All ${pending.maxRounds} rounds are used. ` : ''}The workflow waits for this choice before it moves on.` };
  // A route's `to` may be a word, not a step.
  const routeLabel = (choice) => `${choice.label ?? choice.id}${!choice.to || choice.to === 'next' ? '' : choice.to === 'end' ? ' (finishes the Story)' : ` (goes to ${stepName(workflow, choice.to)})`}`;
  const details = { key: pending.key, decision: pending.decision, after: pending.after };
  if (!pending.by?.length) {
    return stepItem(workflow, context, { ...base, groups: [], details,
      options: (pending.options ?? []).map((choice) => ({ id: `choose-${choice.id}`, label: routeLabel(choice),
        command: `singularity-flow decision choose ${workId} --fetch --option ${choice.id} --reason "<why>" --expected ${pending.key}`,
        words: 'You choose in your own terminal with a reason; nothing is chosen here.' })) });
  }
  const route = ({ id, label, words, effect, flag }) => ({ ...option(workflow, context, { id, label, words, effects: [{ kind: 'routing', key: pending.key, groups: pending.by, ...effect }],
    needs: { reason: textNeed('', ROUTING_REASON) } }),
  decidedBy: stepDecidedBy(workflow, context, pending.by, words),
  chat: { command: `singularity-flow decision choose ${workId} --fetch ${flag} --reason "<REASON>" --expected ${pending.key}` } });
  const named = (pending.options ?? []).map((choice) => route({ id: `choose-${choice.id}`, label: routeLabel(choice),
    words: 'The Story moves on as you chose, and the log keeps your reason.', effect: { option: choice.id }, flag: `--option ${choice.id}` }));
  // A step the decision lets a person name instead of a route: every step for an any-step decision, the earlier ones it may reopen otherwise.
  const steps = pending.anyStep ? [...(workflow.phaseOrder ?? []), 'end'] : pending.reopen ?? [];
  const reached = new Set((pending.options ?? []).map((choice) => choice.to));
  const others = steps.filter((step) => !reached.has(step)).map((step) => route({ id: `to-${String(step).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`.slice(0, 64),
    label: step === 'end' ? 'Finish the Story here' : `Go to ${stepName(workflow, step)}`,
    words: 'The Story moves as you named it, and the log keeps your reason.', effect: { to: step }, flag: `--to ${step}` }));
  return { ...base, options: [...named, ...others], details };
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
      forAnyone: true,
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
    why: `The appeal is ${String(appeal.status).replaceAll('-', ' ')}. An approver of the plan reviews the exact diff and accounts for the scope or requests changes; no check is waived.`,
    groups: planAuthorities(workflow),
    options: [{ id: 'review', label: 'Review the appeal', command: appeal.command, words: 'Reviewed in your own terminal (/sf-appeal shows it).' }],
    details: { appeal: appeal.id, phase: appeal.phaseId, status: appeal.status }
  });
}

/** Why a witness of evidence no step has published cannot be recorded yet (WITNESS_EVIDENCE_UNPUBLISHED). */
function notPublishedYet(workflow, entry) {
  const owners = listWords(entry.owners.map((id) => stepName(workflow, id)));
  return `It cannot be signed off yet: nothing has published ${listWords(entry.files)} for ${clauseName(workflow, entry.clauseId)}. ${owners} publishes it with its delivery; sign it off after that.`;
}

/** What a sign-off asks, in what the plan and the deliveries say of its evidence. */
function witnessWhy(workflow, entry) {
  const who = `An approver of ${listWords(entry.owners.map((id) => stepName(workflow, id)))}`;
  if (entry.available === false) return `${who} signs it off; the Story cannot end without it. ${notPublishedYet(workflow, entry)}`;
  return entry.files.length ? `${who} inspects ${listWords(entry.files)} and signs it off; the Story cannot end without it.`
    : `${who} signs it off, naming the file they inspected: the plan names none. The Story cannot end without it.`;
}

/** A requirement statement the Story's ending needs a disposition of: each disposition a choice, the same write as `decision scope`. */
function scopeItem(workflow, context, entry) {
  const workId = workflow.workItem.id;
  return {
    kind: 'owed-decision', title: `Decide scope item ${entry.id}`,
    why: `${entry.text ? `"${entry.text}" ` : ''}needs a link or a disposition from an approver of the step that defines the scope before the Story ends.`,
    options: SCOPE_CHOICES.map(([disposition, label, linked]) => ({ ...option(workflow, context, { id: `scope-${disposition}`, label,
      words: linked ? 'The clauses you name carry this statement.' : 'The statement stays in the inventory with your reason.',
      effects: [{ kind: 'scope-disposition', item: entry.id, disposition, groups: entry.groups }],
      needs: { ...(linked ? { clause: { known: entry.clauses ?? [] } } : {}), reason: textNeed('', REASON) } }),
    chat: { command: `singularity-flow decision scope ${workId} --fetch --item ${entry.id} --as ${disposition}${linked ? ' --clause <CLAUSES>' : ''} --reason "<REASON>"` } })),
    details: { scopeItem: entry.id, ...(entry.source ? { source: entry.source } : {}) }
  };
}

/** A responsibility this Story's end leaves out: why it does not apply is a person's word before it can finish. */
function applicabilityItem(workflow, context, entry) {
  const workId = workflow.workItem.id;
  return {
    kind: 'owed-decision', title: `Say why ${entry.responsibility} does not apply`,
    why: `This Story ends without ${entry.responsibility}${entry.declaredReason ? `: ${String(entry.declaredReason).replace(/\.+$/u, '')}` : ''}. Someone who may decide it records why it does not apply to this Story before the Story can finish.`,
    options: [{ ...option(workflow, context, { id: 'does-not-apply', label: 'It does not apply to this Story',
      words: 'Recorded with your reason; the Story can then end without it.',
      effects: [{ kind: 'applicability', responsibility: entry.responsibility, groups: [entry.authority] }], needs: { reason: textNeed('', REASON) } }),
    chat: { command: `singularity-flow decision applicability ${workId} --fetch --responsibility ${entry.responsibility} --reason "<REASON>"` } }],
    details: { responsibility: entry.responsibility, authority: entry.authority }
  };
}

/**
 * Offered, not owed: nothing waits on a completeness review, so it is no open item and no count reads
 * it. It records that a person looked for what is missing, bound to the inventory's exact digest.
 */
function completenessItem(workflow, context, entry) {
  const workId = workflow.workItem.id;
  return {
    kind: 'scope-completeness', title: 'Review the scope for completeness',
    why: `All ${entry.statements} requirement statement${entry.statements === 1 ? ' has' : 's have'} a link or a disposition. Nothing waits on this review. It records that you looked for what is missing, contradictory or unmeasurable; it never says the scope is correct.`,
    options: [{ ...option(workflow, context, { id: 'reviewed', label: 'I reviewed it: record my answers',
      words: 'Your answers bind this exact inventory; a later change to it makes the review no longer current.',
      effects: [{ kind: 'completeness-review', inventorySha256: entry.inventorySha256, groups: entry.groups }],
      needs: { article: { articles: entry.articles, decisions: entry.decisions }, reason: textNeed('', REASON) } }),
    chat: { command: `singularity-flow decision completeness ${workId} --fetch --confirm ${entry.inventorySha256} --article <ID>=<DECISION> --reason "<REASON>"` } }],
    details: { inventorySha256: entry.inventorySha256, statements: entry.statements }
  };
}

/** A sign-off or scope disposition an approved step owes the Story's ending; it does not hold this step. */
function owedItem(workflow, context, entry) {
  if (entry.kind === 'scope' && entry.groups?.length) return scopeItem(workflow, context, entry);
  const witness = entry.kind === 'witness';
  const notYet = witness && entry.available === false;
  return stepItem(workflow, context, {
    kind: 'owed-decision', title: witness ? `Sign off ${clauseName(workflow, entry.clauseId)} (${entry.method})` : `Decide scope item ${entry.id}`,
    why: witness ? witnessWhy(workflow, entry)
      : `${entry.text ? `"${entry.text}" ` : ''}needs a link or a disposition from an approver of the step that defines the scope before the Story ends.`,
    groups: entry.groups ?? (witness ? [...new Set(entry.owners.flatMap((id) => approvers(workflow, id)))] : []),
    options: [{ id: witness ? 'witness' : 'disposition', label: notYet ? 'Sign it off once it is published' : witness ? 'Sign it off after inspecting it' : 'Include it, or say it exists, naming its clauses',
      // What its command would refuse names no command: a real chat printed it, under "Copilot: no verified equivalent".
      command: notYet ? null : entry.command ?? `singularity-flow evidence matrix ${workflow.workItem.id} --json`, words: notYet ? notPublishedYet(workflow, entry) : 'Only a person records it; an agent never answers it.',
      ...(notYet ? { available: false } : witness ? { humanReview: { kind: 'witness', clauseId: entry.clauseId, clauseText: entry.clauseText, slot: entry.slot, method: entry.method,
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
    options: [{ ...personalStep({ id: 'sync', label: 'Publish it', command: sync, words: 'sync publishes what was not published; nothing is decided here.',
      decidedBy: anyone('sync publishes what was not published; nothing is decided here.') }) }],
    details: { ...(entry.intentId ? { intent: entry.intentId, status: entry.status } : { commit: entry.commit ?? null }), commands: [sync] }
  };
}

/**
 * A hold this identity cannot clear whatever its groups (already approved, wrote it, not listed): who
 * can, naming the people the refusal lists, or that nobody else is listed for this Story.
 */
function othersDecide(workflow, { authorities }, { groups, people = [], anyIdentity = false, barred }, phaseId) {
  let registry = null;
  try { registry = normalizeApprovalAuthorities(authorities); } catch { registry = null; }
  const ids = groups.length ? groups : approvers(workflow, phaseId);
  const labels = ids.map((id) => groupLabel(registry, id));
  const members = ids.flatMap((id) => registry?.[id]?.members ?? []);
  // The refusal lists an email or github:<login>; a person is shown as stepDecidedBy shows them.
  const names = [...new Set(people.map((entry) => members.find((member) => member.email === entry || `github:${member.githubLogin}` === entry)?.name ?? entry))].slice(0, 5);
  const lead = barred === 'recorded' ? 'You have already approved this. ' : barred === 'author' ? 'Its author may not approve it. ' : '';
  return { groups: ids, labels, allowed: false, ...(names.length ? { people: names } : {}),
    words: `${lead}${names.length || anyIdentity ? `The ${listWords(labels)}${names.length ? ` (${listWords(names)})` : ''} decide this; ask them.`
      : `Nobody else is listed in ${listWords(labels) || 'its approval groups'} for this Story.`}`,
    share: `/sf-decide ${workflow.workItem.id}` };
}

/**
 * Who clears a hold, for the person looking: the real groups, from the facts the refusal carries
 * (`clearedBy`), whether this identity holds one, and otherwise who does. Where the refusal names
 * nobody it says so; only what truly needs no group (this checkout's own changes, what Singularity
 * Flow finishes) is open to anyone.
 */
function holdParty(hold, workflow, context) {
  const phaseId = workflow.currentPhase;
  const words = hold.action?.label ?? '';
  const clearedBy = hold.clearedBy ?? {};
  if (clearedBy.plan || /^singularity-flow decision plan /u.test(hold.action?.command ?? '')) {
    return stepDecidedBy(workflow, context, planAuthorities(workflow), clearedBy.plan ? words : 'Choose the row it belongs to and give your reason, then run it.');
  }
  if (['anyone', 'viewer-terminal'].includes(clearedBy.kind)) return anyone(`${hold.who}. ${words}`.trimEnd());
  if (hold.owner === 'this-checkout') return anyone('These changes are in this checkout, so they are for whoever works in it, not for an approval group.');
  if (hold.owner === 'machine') return anyone(`${hold.who}. ${words}`.trimEnd());
  // The author revises it; returning it for changes is an approver's step, by the route it names.
  if (hold.owner === 'author-repairs') {
    return /^singularity-flow reject /u.test(hold.action?.command ?? '') ? stepDecidedBy(workflow, context, approvers(workflow, phaseId), words)
      : { groups: [], labels: [], allowed: false, words: `${hold.who}. ${words}`.trimEnd() };
  }
  if (Array.isArray(clearedBy.people)) return othersDecide(workflow, context, { ...clearedBy, groups: clearedBy.groups ?? [] }, phaseId);
  if (clearedBy.testRun) return stepDecidedBy(workflow, context, [...new Set(clearedBy.steps.flatMap((id) => testRunRiskAuthorities(workflow, id)))], words);
  return stepDecidedBy(workflow, context, clearedBy.groups ?? [...new Set((clearedBy.steps ?? []).flatMap((id) => approvers(workflow, id)))], words);
}

/** A refusal approval names that no other item carries, with the route the approval check gives it. */
function holdItem(workflow, context, kind, hold) {
  const command = hold.action?.command ?? `singularity-flow phase show ${workflow.currentPhase} --work-id ${workflow.workItem.id} --json`;
  const decided = holdParty(hold, workflow, context);
  const rows = (hold.planRows ?? []).map((row) => (row.result ? `${row.clauseId} (${row.result})` : row.clauseId)).join('; ');
  return {
    kind, title: hold.summary.split(/(?<=[.!?])\s/u)[0].split(/;\s/u)[0].slice(0, 200), why: `${hold.message ?? hold.summary} ${decided.words}${rows ? ` The plan's rows: ${rows}.` : ''}`,
    options: [{ ...personalStep({ id: 'route', label: hold.action?.label || decided.words, command, words: decided.words, decidedBy: decided }) }],
    details: { code: hold.code, owner: hold.owner, commands: [command], ...(hold.planRows ? { planRows: hold.planRows } : {}) },
    ...(hold.action?.skill ? { routeSkill: hold.action.skill } : {})
  };
}

const rowSlug = (clauseId) => String(clauseId).toLowerCase().replace(/[^a-z0-9]+/gu, '-');

/**
 * One departure from the approved documents [CQF:REQ-024, REQ-025]. Accepting writes the record its kind
 * already has, under that record's own authority; rejecting writes a rejection, and the model restores the
 * files. A file, a supporting file and wording that names no clause share one "Accept all"; a plan row, a
 * test and wording that names a clause are decided one by one, each with its own reason (`oneByOne`), and
 * a clause by the scope's approvers. No answer is chosen and no reason suggested.
 */
function departureItem(workflow, context, entry, facts) {
  const { departure, status, groups, words } = entry;
  const workId = workflow.workItem.id;
  const name = stepName(workflow, departure.phase);
  const one = entry.acceptAll !== true;
  const files = listWords(departure.paths ?? []);
  const decide = (as, extra = '') => `singularity-flow decision departure ${workId} --fetch --departure ${departure.id} --as ${as}${extra} --reason "<REASON>"`;
  const effect = (decision, extra = {}) => ({ kind: 'departure', departure: departure.id, departureKind: departure.kind, decision, groups, ...extra });
  const reason = { reason: textNeed('', departure.kind === 'supporting' ? SUPPORTING_REASON : REASON) };
  const accept = ({ id = 'accept', label, words, changes = null, writes }) => ({ ...option(workflow, context, { id, label, words,
    effects: [effect('accept', { writes, ...(changes ? { changes } : {}) })], needs: reason }), ...(one ? { oneByOne: true } : {}) });
  let accepts = [];
  if (departure.kind === 'path' && departure.clauses?.length) {
    const changes = departure.paths.flatMap((file) => departure.clauses.map((clauseId) => ({ kind: 'add-location', clauseId, path: file })));
    accepts = [{ ...accept({ label: 'Accept', words: `${files} becomes part of ${listWords(departure.clauses.map((id) => clauseName(workflow, id)))}'s delivery: a plan amendment names it, and no step is reset.`, changes, writes: 'plan-amendment' }),
      chat: { command: decide('accepted') } }];
  } else if (departure.kind === 'path') {
    accepts = (facts.planRows ?? []).filter((row) => !row.testOnly || departure.paths.every(isTestAutomationPath)).map((row) => ({ ...accept({
      id: `accept-${rowSlug(row.clauseId)}`.slice(0, 64), label: `Accept under ${clauseName(workflow, row.clauseId)}${row.result ? `: ${row.result}` : ''}`,
      words: `${files} becomes part of ${clauseName(workflow, row.clauseId)}'s delivery: a plan amendment names it, and no step is reset.`,
      changes: departure.paths.map((file) => ({ kind: 'add-location', clauseId: row.clauseId, path: file })), writes: 'plan-amendment' }),
    chat: { command: decide('accepted', ` --clause ${row.clauseId}`) } }));
  } else if (departure.kind === 'supporting') {
    accepts = [{ ...accept({ label: 'Accept', words: `${files} is listed in the plan as a supporting change (${departure.class}) with your reason.`,
      changes: departure.paths.map((file) => ({ kind: 'add-supporting', path: file, class: departure.class })), writes: 'plan-amendment' }), chat: { command: decide('accepted') } }];
  } else if (departure.kind === 'finding') {
    // A fix on the way [CQF:REQ-066]: its files may be planned ones, so nothing in the plan changes.
    accepts = [{ ...accept({ label: 'Accept', words: `The fix stays in ${files}, and nothing in the plan changes. ${listWords(departure.findings ?? [])} ${(departure.findings ?? []).length === 1 ? 'is' : 'are'} fixed, awaiting proof in the findings register once ${name} is approved.`,
      writes: 'departure-acceptance' }), chat: { command: decide('accepted') } }];
  } else if (departure.kind === 'wording') {
    const target = stepName(workflow, departure.target?.phase);
    // A forward amendment is approved while the step that found the defect is still open.
    const open = facts.codeStepOpen === true;
    accepts = [{ ...accept({ label: 'Accept', words: `${target}'s approved document is amended to this wording as its next generation; its old approval reads as amended by ${departure.id}, and each later step that read it is listed for revalidation.`, writes: 'forward-amendment' }),
      ...(open ? { chat: { command: decide('accepted') } } : { available: false,
        words: `${target}'s wording is amended while ${name} is open. ${name} awaits approval now: return it for changes (/sf-reject), then decide this.` }) }];
  } else {
    const own = facts.acceptance?.[departure.id];
    accepts = [{ ...personalStep({ id: 'accept', label: departure.kind === 'clause' ? `Accept: change ${listWords(departure.clauses ?? [])}` : 'Accept this plan row change',
      command: own, words: departure.kind === 'clause'
        ? `An intent amendment changes the approved clauses; the scope's approvers decide it in their own terminal, and the steps that cite them reopen${facts.reopens?.[departure.id]?.length ? `: ${listWords(facts.reopens[departure.id].map((id) => stepName(workflow, id)))}` : ''}.`
        : 'A plan row correction is reviewed in your own terminal with your reason; nothing else in the plan changes.',
      decidedBy: stepDecidedBy(workflow, context, groups, 'You decide it in your own terminal.') }), oneByOne: true }];
  }
  const restore = departure.kind === 'finding' ? `The model takes the fix out of ${files} in this generation, and ${listWords(departure.findings ?? [])} ${(departure.findings ?? []).length === 1 ? 'is' : 'are'} open again in the findings register.`
    : ['path', 'supporting'].includes(departure.kind) ? `The model restores ${files} to what ${departure.paths.length === 1 ? 'it' : 'they'} held when this generation began; prepublish checks it.`
      : 'The approved document stays as it was.';
  // One label on every row, so one answer for all reads as itself on a card.
  const reject = { ...option(workflow, context, { id: 'reject', label: 'Reject', words: restore, effects: [effect('reject')], needs: reason }),
    ...(one ? { oneByOne: true } : {}), chat: { command: decide('rejected') } };
  const reopened = status === 'reopened' ? ` ${entry.acceptance?.id ?? 'Its acceptance'} accepted it, and ${listWords(entry.changed ?? [])} changed since, so it is asked again.` : '';
  const tests = facts.tests?.[departure.id]?.length ? ` Tests changed under the same clause: ${listWords(facts.tests[departure.id])}.` : '';
  // First, so a form that keeps only the opening sentences still names the findings register items it fixes [CQF:REQ-066].
  const fixes = (departure.findings ?? []).map((id) => (facts.findingTitles?.[id] ? `${id} ${facts.findingTitles[id]}` : id));
  // What the person typed that its author accounted for as this departure, quoted beside it [SCS:REQ-043].
  const asked = (workflow.askedFor ?? []).filter((entry) => entry.phase === departure.phase
    && (workflow.instructionAccounts ?? []).findLast((account) => account.phase === entry.phase && Number(account.instruction) === Number(entry.instruction))?.departure === departure.id)
    .map((entry) => `(${entry.instruction}) "${String(entry.text ?? '').replace(/\s+/gu, ' ').trim()}"`);
  return {
    kind: 'departure', title: `${departure.id}: ${words}`.slice(0, 200),
    why: `${fixes.length ? `It fixes ${listWords(fixes)} from the findings register. ` : ''}${departure.recordedBy === 'sflow' ? 'SFlow recorded it at prepublish' : 'The model recorded it'}: ${departure.reason}${reopened}${tests}${asked.length ? ` Asked for: ${asked.join('; ')}.` : ''} ${name} goes ahead with it; its approval waits for this decision.${one ? ' It is decided on its own, with its own reason.' : ''}`,
    options: [...accepts, reject],
    details: { departure: departure.id, departureKind: departure.kind, status, ...(departure.paths?.length === 1 ? { path: departure.paths[0] } : { paths: departure.paths }),
      clauses: departure.clauses ?? [], acceptAll: !one, ...(departure.findings?.length ? { findings: departure.findings } : {}), ...(departure.target ? { target: departure.target } : {}), ...(departure.diff ? { diff: departure.diff.slice(0, 4000) } : {}),
      commands: [`singularity-flow departure show ${departure.id} --work-id ${workId}`] }
  };
}

// Convergence's items as one difference each, the way a conformance verdict names it, so a fact and what an
// assisted pass proposed about the same clause are one problem [SCS:REQ-031].
const CONVERGENCE_DIFFERENCE = Object.freeze({ 'absent-observed-claim': 'missing', 'unresolved-deviation': 'contradicts', 'unclaimed-changed-path': 'unplanned' });
const CONVERGENCE_WORDS = Object.freeze({ 'absent-observed-claim': 'no recorded trace that it is delivered', 'unclaimed-changed-path': 'changed, and no clause claims it',
  'stale-claim-binding': 'a claim with no source evidence bound to it', 'missing-bound-test': 'no bound test result', 'failing-bound-test': 'a bound test did not pass',
  'claimed-withdrawn-clause': 'claimed, though the specification no longer has it', 'unresolved-deviation': 'an unresolved deviation',
  'missing-required-evidence': 'required evidence is missing', 'verdict-against-superseded-clause': 'judged against wording that has since changed',
  missing: 'proposed as missing', partial: 'proposed as partly delivered', contradicts: 'proposed as contradicting the clause', unplanned: 'proposed as unplanned' });
const DISPOSITION_EFFECT = Object.freeze({
  rework: 'The code changes to match the approved documents: once every item is decided, story rework returns the Story to the code step.',
  'update-intent': 'The approved documents change to match the code: name the clauses, and the intent amendment drafted from these decisions goes to their approvers.',
  'accepted-deviation': 'The difference stays, accepted with your reason; the clause keeps its wording.',
  dismissed: 'It is not a real difference; the record keeps your reason.',
  deferred: 'It is decided later; the record keeps your reason.'
});
const ADJUDICATION_REASON = Object.freeze({ minimum: 1, maximum: 1000 });
// A fact's own words start lower case and may start with a path, which keeps its case.
const found = (text) => (text ? `Convergence found that ${String(text).replace(/\.?$/u, '.')}` : '');

/** One row per problem: a test setup is one change; a fact and the assisted proposals that cite it, or name its clauses and difference, are one. */
function convergenceRows(list) {
  const open = list.items.filter((item) => !item.decision);
  const rows = new Map();
  const rowOf = new Map();
  const difference = (item) => item.classification ?? CONVERGENCE_DIFFERENCE[item.kind] ?? item.kind;
  for (const item of open) {
    const cited = (item.factIds ?? []).map((id) => rowOf.get(id)).find(Boolean);
    const key = cited ?? (item.group ? `group:${item.group}` : item.clauseIds.length
      ? `clause:${[...item.clauseIds].map((id) => id.toUpperCase()).sort().join(',')}:${difference(item)}` : `item:${item.id}`);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(item);
    rowOf.set(item.id, key);
  }
  return [...rows.values()];
}

/**
 * The items a person adjudicates at an open convergence step [SCS:REQ-030]: one row per problem, each
 * disposition a choice, and every choice written by `story adjudicate --answers` bound to the table's
 * own digest, under the convergence approvers' authority. No answer is chosen and no reason suggested.
 * An open upstream issue on the same clause is named here, never asked again [SCS:REQ-031].
 */
function convergenceItems(workflow, context, list) {
  const workId = workflow.workItem.id;
  const phase = list.phase;
  const issues = (context.facts.issues ?? []).filter((state) => ['open', 'expired'].includes(state.status));
  return convergenceRows(list).map((members) => {
    const ids = members.map((item) => item.id);
    const paths = [...new Set(members.flatMap((item) => item.paths))];
    const clauses = [...new Set(members.flatMap((item) => item.clauseIds))];
    const group = members.find((item) => item.group)?.group ?? null;
    const subject = group ? `Test setup ${listWords(paths)}` : clauses.length ? listWords(clauses.map((id) => clauseName(workflow, id))) : paths.length ? listWords(paths) : 'Convergence';
    const words = [...new Set(members.map((item) => CONVERGENCE_WORDS[item.classification ?? item.kind] ?? item.kind))];
    const named = issues.filter((state) => clauses.some((clause) => issueNamesClause(state.issue.about, clause)));
    const plan = members.map((item) => item.plan).find(Boolean) ?? null;
    const why = [
      ...members.map((item) => (item.classification ? `The assisted pass proposed: "${String(item.text ?? '').slice(0, 400)}"` : found(item.detail))),
      ...(group ? [list.groupWords?.[group] ?? ''] : []),
      ...(plan ? [`The plan says: ${plan.kind === 'amendment' ? `${plan.id ?? 'an amendment'}${plan.clause ? ` under ${plan.clause}` : ''}` : 'a supporting file'}${plan.text ? `, ${plan.text}` : ''}${plan.askedBecause ? `; still asked: ${plan.askedBecause}` : ''}.`] : []),
      ...named.map((state) => `${state.issue.id}, a problem reported against ${stepName(workflow, state.issue.phase)}, names it too; its approvers decide that issue.`),
      ...(ids.length > 1 ? [`One answer records each of ${listWords(ids)} by name.`] : []),
      `${stepName(workflow, phase)}'s approvers decide it; the report is generated again once every item is decided.`
    ].filter(Boolean).join(' ');
    // Rework on what the kernel found itself may go unexplained; any other answer, or one on a proposal, states its reason.
    const deterministic = members.every((item) => !item.classification);
    const shareable = members.every((item) => item.acceptAll);
    const options = (list.dispositions ?? []).map(({ id, label }) => ({ ...option(workflow, context, { id, label, words: DISPOSITION_EFFECT[id] ?? label,
      effects: [{ kind: 'convergence-adjudication', phase, items: ids, disposition: id, expect: list.digest }],
      // The clauses the spec should change, not the clauses that carry it: each host asks and confirms in these words.
      needs: { ...(id === 'update-intent' ? { clause: { known: [...new Set([...clauses, ...(list.clauses ?? [])])], words: 'The clauses the specification should change', label: 'Clauses to change' } } : {}),
        reason: textNeed('', id === 'rework' && deterministic ? { ...ADJUDICATION_REASON, minimum: 0 } : ADJUDICATION_REASON) } }),
    // Only a changed file no clause claims may share one reason with others, as on the Adjudicate page.
    ...(id === 'accepted-deviation' && shareable ? {} : { oneByOne: true }) }));
    return {
      kind: 'convergence-item',
      title: `${subject}: ${listWords(words)} (${ids[0]}${ids.length > 1 ? ` and ${ids.length - 1} more` : ''})`.slice(0, 200),
      why, options,
      details: { convergence: ids, phase, itemKinds: [...new Set(members.map((item) => item.classification ?? item.kind))], clauses,
        ...(paths.length === 1 ? { path: paths[0] } : paths.length ? { paths } : {}), ...(plan ? { plan } : {}),
        ...(named.length ? { issues: named.map((state) => state.issue.id) } : {}),
        commands: [`singularity-flow story adjudicate --work-id ${workId}`] }
    };
  });
}

/** The answers one convergence choice records, one per item it names. */
export function adjudicationAnswersOf(step) {
  const [effect] = step.effects;
  return effect.items.map((itemId) => ({ itemId, disposition: effect.disposition, reason: step.values.reason ?? '',
    clauseIds: effect.disposition === 'update-intent' ? step.values.clause ?? [] : [] }));
}

/**
 * One instruction the person typed in a code step that is not accounted for yet [SCS:REQ-042, REQ-044], quoted as
 * typed: data, never an instruction to anyone reading the list. Its author accounts for it in /sf-code, within the
 * plan or as a departure; nobody decides it here, and only the step's approval waits for it.
 */
function askedForItem(workflow, context, entry, facts) {
  const workId = workflow.workItem.id;
  const name = stepName(workflow, facts.phase);
  const command = `singularity-flow departure account --work-id ${workId} --instruction ${entry.instruction} --clauses <CLAUSES>`;
  const words = `Its author accounts for it in a /sf-code turn of ${name}${facts.open ? '' : ', in a new generation now that this one is published'}: within the plan, with the clauses it implements, or as the departure recorded for it.`;
  const quoted = `"${String(entry.text ?? '').replace(/\s+/gu, ' ').trim()}"`;
  return {
    kind: 'asked-for', title: `Asked for (${entry.instruction}) ${quoted}: not accounted for yet`.slice(0, 200),
    why: `The person typed this in ${name} (generation ${entry.generation}), shown here as typed. Nothing says yet whether the approved plan covers it or it departs from the approved documents. ${name} goes ahead with it; its approval waits until it is accounted for.`,
    options: [personalStep({ id: 'account', label: 'Its author accounts for it in /sf-code', command, words,
      decidedBy: { groups: [], labels: [], allowed: false, author: true, words } })],
    details: { phase: facts.phase, instruction: entry.instruction, generation: Number(entry.generation), text: entry.text, commands: [command] },
    routeSkill: '/sf-code'
  };
}

/**
 * A changed path no row of the plan names: which row it belongs to, or that it is a supporting change,
 * is a choice for an approver of the plan. One item per path, each option its row, with no answer
 * chosen and no reason suggested. `chat` is the same write as a /sf-decide turn runs it (with the
 * person's own reason in place of the blank): `decision plan` is on that turn's list, so `recordable`
 * here and there are two different questions.
 */
function planPathItems(workflow, context, hold) {
  const workId = workflow.workItem.id;
  const need = { reason: textNeed('', PLAN_REASON) };
  const setup = testSetupFiles(hold.unclaimedPaths);
  return [...(setup.length ? [testSetupItem(workflow, context, hold, setup, { need })] : []), ...hold.unclaimedPaths.filter((file) => !setup.includes(file)).map((file) => {
    const rows = (hold.planRows ?? []).filter((row) => !row.testOnly || isTestAutomationPath(file));
    const supporting = classifySupportingChange(file).class ?? null;
    const flag = (entry) => `singularity-flow decision plan ${workId} --fetch ${entry} --reason "<REASON>"`;
    return {
      kind: 'plan-accounting', title: `Say where ${file} belongs`,
      why: `${file} changed and no row of the plan names it, so ${hold.waits ?? 'approval waits'}. Add it to the row it serves${supporting ? `, or list it as a supporting change (${supporting})` : ''}: the code and its tests stay as they are, and no step is reset.${hold.keepOut ? ` If it is not part of this Story, keep it out instead: ${hold.keepOut} shows the private-copy route.` : ''}`,
      options: [
        ...rows.map((row) => ({ ...option(workflow, context, {
          id: `row-${String(row.clauseId).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`.slice(0, 64),
          label: `Add to ${clauseName(workflow, row.clauseId)}${row.result ? `: ${row.result}` : ''}`,
          words: `${file} becomes part of ${clauseName(workflow, row.clauseId)}'s delivery.`,
          effects: [{ kind: 'plan-amendment', change: { kind: 'add-location', clauseId: row.clauseId, path: file } }], needs: need }),
        chat: { command: flag(`--add-location ${shellQuoted(`${row.clauseId}=${file}`)}`) } })),
        ...(supporting ? [{ ...option(workflow, context, {
          id: 'supporting', label: `List it as a supporting change (${supporting})`,
          words: 'It stays out of every requirement, listed with your reason.',
          effects: [{ kind: 'plan-amendment', change: { kind: 'add-supporting', path: file, class: supporting } }], needs: { reason: textNeed('', SUPPORTING_REASON) } }),
        chat: { command: flag(`--add-supporting ${shellQuoted(`${file}=${supporting}`)} --supporting-reason "<REASON>"`) } }] : [])
      ],
      details: { path: file, commands: [`singularity-flow decision plan ${workId} --fetch --add-location <clause>=${file} --reason "<why>"`] }
    };
  })];
}

/**
 * Files that changed together for how tests run: one item, so a person decides once (src/test-support-files.mjs).
 * What can be a supporting change is listed as one; a file that cannot, such as a setup file under a test folder,
 * goes to the row a person picks, as it would alone. One amendment records every file by name.
 */
function testSetupItem(workflow, context, hold, files, { need }) {
  const workId = workflow.workItem.id;
  const classes = new Map(files.map((file) => [file, classifySupportingChange(file).class ?? null]));
  const supporting = files.filter((file) => classes.get(file));
  const located = files.filter((file) => !classes.get(file));
  const line = (changes) => {
    const flags = changes.map((change) => (change.kind === 'add-location' ? `--add-location ${shellQuoted(`${change.clauseId}=${change.path}`)}`
      : `--add-supporting ${shellQuoted(`${change.path}=${change.class}`)} --supporting-reason "<REASON>"`));
    return `singularity-flow decision plan ${workId} --fetch ${flags.join(' ')} --reason "<REASON>"`;
  };
  const listed = supporting.map((file) => ({ kind: 'add-supporting', path: file, class: classes.get(file) }));
  const reasonNeed = listed.length ? { reason: textNeed('', SUPPORTING_REASON) } : need;
  const rows = (hold.planRows ?? []).filter((row) => !row.testOnly || located.every(isTestAutomationPath));
  const rowOption = (row) => {
    const changes = [...listed, ...located.map((file) => ({ kind: 'add-location', clauseId: row.clauseId, path: file }))];
    return { ...option(workflow, context, {
      id: `setup-row-${String(row.clauseId).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`.slice(0, 64),
      label: `${listWords(located)} under ${clauseName(workflow, row.clauseId)}${row.result ? `: ${row.result}` : ''}${listed.length ? ', the rest as supporting changes' : ''}`,
      words: `${listWords(located)} ${located.length === 1 ? 'becomes' : 'become'} part of ${clauseName(workflow, row.clauseId)}'s delivery${listed.length ? `, and ${listWords(supporting)} ${supporting.length === 1 ? 'is' : 'are'} listed as supporting with your reason` : ''}.`,
      effects: [{ kind: 'plan-amendment', changes }], needs: reasonNeed }), chat: { command: line(changes) } };
  };
  return {
    kind: 'plan-accounting', title: `Say where this test setup belongs: ${listWords(files)}`,
    why: `${listWords(files)} changed together for how tests run, and no row of the plan names them, so approval waits. They are one change, so you decide once, and each is recorded by name: the code and its tests stay as they are, and no step is reset.`,
    options: located.length ? rows.map(rowOption) : [{ ...option(workflow, context, {
      id: 'supporting', label: 'List them as supporting changes',
      words: 'They stay out of every requirement, each listed with your reason.',
      effects: [{ kind: 'plan-amendment', changes: listed }], needs: reasonNeed }), chat: { command: line(listed) } }],
    details: { paths: files, commands: [line([...listed, ...located.map((file) => ({ kind: 'add-location', clauseId: '<clause>', path: file }))])] }
  };
}

/** The step's approval itself: always the list's last item. */
function approvalItem(workflow, context, phase, { heldBy, youDecide, ownTerminal }) {
  const workId = workflow.workItem.id;
  const name = stepName(workflow, phase.id);
  const approvals = (phase.approvals ?? []).filter((entry) => !entry.invalidatedAt && entry.decision === 'approved').length;
  const minimum = phase.approvalPolicy?.minimum ?? 1;
  const waiting = heldBy.length ? `It waits for ${listWords(heldBy)} first.` : 'Nothing above holds it.';
  return {
    kind: 'approval', title: `Approve ${name}`,
    why: `${approvals} of ${minimum} approval${minimum === 1 ? '' : 's'} recorded. ${waiting}${youDecide.length ? ` You answer ${youDecide.length === 1 ? 'one question' : `${youDecide.length} questions`} in the approval itself.` : ''}${ownTerminal ? ' It takes your signature, in your own terminal.' : ''}`,
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
  // A code step's departures are decided on the list too [CQF:REQ-024].
  // Convergence items too: the Adjudicate page shows only these, for one release [SCS:REQ-030, REQ-033].
  // And what the person typed that a code step has not accounted for yet [SCS:REQ-042].
  'decision-list': Object.freeze({ kinds: ['conformance-gap', 'upstream-issue', 'visual-profile', 'test-run-risk', 'test-narrowing', 'test-command', 'evidence-obligation', 'plan-accounting', 'departure', 'convergence-item', 'asked-for'] }),
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
  STORY_PUBLICATION_PENDING: 'story-publication', CONFORMANCE_BLOCKING_VERDICTS: 'conformance-gap', STORY_COMPLETION_REFUSED: 'conformance-gap',
  DEPARTURES_UNDECIDED: 'departure', INSTRUCTIONS_UNACCOUNTED: 'asked-for'
});

/**
 * The item kind that carries one approval-check hold: its own item kind, the approval itself for an
 * answer this approver gives in the approval (`you-decide`), a test-run risk for a lapsed one, and
 * otherwise a hold item of its own.
 */
export function holdItemKind(hold) {
  if (hold.owner === 'you-decide') return 'approval';
  if (hold.unclaimedPaths?.length) return 'plan-accounting';
  if (HOLD_KINDS[hold.code]) return HOLD_KINDS[hold.code];
  return (hold.clearedBy?.testRun || /test-run risk/iu.test(hold.summary ?? '')) && hold.owner === 'someone-decides' ? 'test-run-risk' : 'approval-hold';
}

// The kinds whose items are decided on this list itself; the digest binds their words and options.
const DECIDED_HERE = new Set(['conformance-gap', 'upstream-issue', 'visual-profile', 'node-pin', 'test-run-risk', 'test-narrowing', 'test-command', 'evidence-obligation', 'plan-accounting', 'departure', 'convergence-item']);

/** Kinds that wait for the step's approval, never for its submission. */
export const LATER_KINDS = Object.freeze(['owed-decision', 'departure', 'asked-for']);

/** Every item kind this list builds. */
export const PENDING_ITEM_KINDS = Object.freeze(['story-publication', 'routing-decision', 'intent-amendment', 'forward-amendment', 'appeal',
  'conformance-gap', 'upstream-issue', 'visual-profile', 'test-run-risk', 'test-narrowing', 'test-command', 'evidence-obligation', 'owed-decision',
  'plan-accounting', 'departure', 'convergence-item', 'asked-for', 'approval-hold', 'transport-intent', 'approval']);

/** The commands a person or script uses to record, with the packet digest. */
export function decisionRecordCommand(workId, { phaseId = null, choices = [], digest, values = {} } = {}) {
  return ['singularity-flow decisions record', workId, ...(phaseId ? [`--phase ${phaseId}`] : []),
    ...choiceFlags(choices, values), `--confirm ${digest}`].join(' ');
}

/**
 * What a /sf-decide turn runs for choices with a chat command of their own: each command, with the person's
 * words in it. A preview offered only `decisions record`, which no turn may run for them, so someone who had
 * just answered everything in chat was sent to a terminal (paid run, 2026-11-07). One still short of an answer is left out.
 */
export function decisionChatSteps(packet, steps) {
  const items = [...packet.items, ...(packet.offered ?? [])];
  return steps.flatMap((step) => {
    const template = items.find((item) => item.id === step.item)?.options.find((option) => option.id === step.option)?.chat?.command;
    const { reason = '', clause = [] } = step.values ?? {};
    const command = template?.replaceAll('"<REASON>"', () => (reason ? shellQuoted(reason) : '<REASON>')).replaceAll('<CLAUSES>', () => clause.join(',') || '<CLAUSES>');
    return command && !/<[A-Z][A-Z-]*>/u.test(command) ? [{ item: step.item, command }] : [];
  });
}

/** The same choices recorded with the step's approval, in its one commit [SPEC-OAP M4]: the flags approve adds. */
export function decisionApprovalFlags({ choices = [], digest, values = {} } = {}) {
  return [...choiceFlags(choices, values), `--decisions ${digest}`].join(' ');
}

// POSIX single quotes, as canonicalDisplayToken in safe-command-guidance.mjs: a JSON double-quoted
// reason would still expand `$()`, `$NAME` and backticks when the person pastes the command.
const shellQuoted = (value) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`);

function choiceFlags(choices, values) {
  const extra = Object.entries(values).flatMap(([flag, entries]) => Object.entries(entries ?? {})
    .map(([item, value]) => `--${flag} ${shellQuoted(`${item}=${value}`)}`));
  return [...choices.map(([item, chosen]) => `--choose ${item}=${chosen}`), ...extra];
}

/**
 * The packet: items, the digest over exactly what a person confirms (items, options, effects, the
 * defaults they would record, and the Story state they depend on), and the record commands.
 * `context`: { authorities, actor, at, requestedPhase, card }. `card: false` is a host with no card to open.
 */
export function decisionPacket(workflow, facts, { authorities, actor, at, requestedPhase = null, card = true } = {}) {
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
    ...(facts.convergence ? convergenceItems(workflow, context, facts.convergence) : []),
    ...(facts.visual ?? []).map((entry) => visualItem(workflow, context, entry)),
    ...(facts.nodePin ? [nodePinItem(workflow, context, facts.nodePin)] : []),
    ...(facts.testRisks ?? []).map((risk) => testRiskItem(workflow, context, risk)),
    ...(facts.testNarrowings ?? []).map((entry) => testNarrowingItem(workflow, context, entry)),
    ...(facts.testCommands ?? []).map((request) => testCommandItem(workflow, context, request)),
    ...(facts.evidence ?? []).map((entry) => evidenceItem(workflow, context, entry)),
    ...(pending.owed ?? []).filter(entry => entry.kind !== 'witness' || !(facts.evidence ?? []).some(row =>
      row.criterion === entry.clauseId && row.witnesses.some(witness => witness.slot === entry.slot)))
      .map((entry) => owedItem(workflow, context, entry)),
    ...(pending.applicability ?? []).map((entry) => applicabilityItem(workflow, context, entry)),
    // Publication would refuse these before the step could ever await approval.
    ...(facts.excludedChanges ? planPathItems(workflow, context, facts.excludedChanges) : []),
    ...(facts.departures?.entries ?? []).map((entry) => departureItem(workflow, context, entry, facts.departures)),
    ...(facts.askedFor?.entries ?? []).map((entry) => askedForItem(workflow, context, entry, facts.askedFor))
  ];
  // Each refusal approval names that no item carries becomes an item of its own; the approval itself
  // names the rest, so the list and the approval check never disagree [SPEC-OAP M3].
  const holds = awaiting ? (facts.approvalCheck?.holds ?? []) : [];
  // A row whose amendment waits for its approvers is that amendment's item, which holds the approval in its place [SCS:REQ-023].
  const amending = new Set((facts.gaps ?? []).filter((gap) => gap.status === 'amending' && gap.issue).map((gap) => gap.issue));
  const amendmentItem = (item) => ['intent-amendment', 'forward-amendment'].includes(item.kind) && amending.has(item.details?.amendment);
  const carried = new Set([...listed.map((item) => item.kind), ...(listed.some(amendmentItem) ? ['conformance-gap'] : [])]);
  // This checkout's own changes come first, as the door refuses them first, as d0 and outside the
  // digest: setting them aside changes neither which item a number means nor what a person chose.
  const dirty = holds.find((hold) => hold.owner === 'this-checkout');
  // The Story's ending names what is already on the list, so only an ending nothing lists is an item of its own.
  const ending = holds.some((hold) => hold.code === 'STORY_COMPLETION_REFUSED');
  const carriedByEnding = (hold) => hold.code === 'STORY_COMPLETION_REFUSED' && listed.some((item) => [...APPROVAL_HOLDING_KINDS, 'owed-decision'].includes(item.kind));
  const extra = holds.filter((hold) => hold !== dirty && holdItemKind(hold) !== 'approval' && !carried.has(holdItemKind(hold)) && !carriedByEnding(hold))
    .flatMap((hold) => (hold.unclaimedPaths?.length ? planPathItems(workflow, context, hold)
      : [holdItem(workflow, context, holdItemKind(hold) === 'test-run-risk' ? 'test-run-risk' : 'approval-hold', hold)]));
  const heldKinds = new Set(holds.filter((hold) => hold.owner !== 'you-decide').map(holdItemKind));
  const held = (item) => APPROVAL_HOLDING_KINDS.includes(item.kind) || extra.includes(item) || (ending && item.kind === 'owed-decision') || (awaiting && amendmentItem(item)) || (awaiting && heldKinds.has(item.kind)
    && (!item.details?.amendment || holds.some((hold) => String(hold.message ?? hold.summary).includes(item.details.amendment))));
  const built = [...listed, ...extra, ...(pending.transport ?? []).map((entry) => machineItem(workflow, entry))];
  const items = built.map((item, index) => {
    // Recommended first, then in the order built.
    const options = [...item.options].sort((left, right) => Number(right.recommended) - Number(left.recommended));
    return { id: `d${index + 1}`, ...item, options, decidedBy: itemDecidedBy(workflow, options), holdsApproval: held(item) };
  });
  const heldHere = items.filter((item) => item.holdsApproval).map((item) => item.id);
  const door = dirty ? holdItem(workflow, context, 'approval-hold', dirty) : null;
  if (awaiting) {
    const approval = approvalItem(workflow, context, phase, { heldBy: [...(door ? ['d0'] : []), ...heldHere],
      youDecide: holds.filter((hold) => hold.owner === 'you-decide' && hold.clearedBy?.kind !== 'viewer-terminal').map((hold) => hold.summary),
      ownTerminal: holds.some((hold) => hold.clearedBy?.kind === 'viewer-terminal' && hold.owner === 'you-decide') });
    items.push({ id: `d${items.length + 1}`, ...approval, decidedBy: itemDecidedBy(workflow, approval.options), holdsApproval: false });
  }
  const boundItems = items.map((item) => (item.kind === 'approval' ? { ...item, details: { ...item.details, heldBy: heldHere, ready: !heldHere.length } } : item));
  const offered = (facts.completeness ? [completenessItem(workflow, context, facts.completeness)] : []).map((item, index) => ({ id: `d${items.length + index + 1}`, ...item,
    decidedBy: itemDecidedBy(workflow, item.options), holdsApproval: false }));
  if (door) items.unshift({ id: 'd0', ...door, decidedBy: itemDecidedBy(workflow, door.options), holdsApproval: true });
  // What holds the approval: the approval item's heldBy, counted the one way. `open` counts every
  // item, the approval included: what every surface shows.
  const holding = items.filter((item) => item.holdsApproval).length;
  const workId = workflow.workItem.id;
  const phaseId = facts.phaseId;
  const decidedHere = ({ id, kind, title, why, options, details }) => ({ id, kind, title, why, details,
    options: options.map(({ id: optionId, label, recommended, effects, needs, decidedBy: who }) => ({ id: optionId, label, recommended, effects, needs, groups: who.groups })) });
  const bound = {
    revision: DECISION_LIST_REVISION, workId, phase: phaseId, at: String(at).slice(0, 10),
    // A person's own step and a refusal's words are not confirmed here: bound by what they are, not their prose.
    items: boundItems.map((item) => ((DECIDED_HERE.has(item.kind) || item.options.some((entry) => entry.recordable !== false)) && !item.details?.code ? decidedHere(item)
      : { id: item.id, kind: item.kind, details: Object.fromEntries(Object.entries(item.details ?? {}).filter(([key]) => key !== 'commands')) })),
    ...(offered.length ? { offered: offered.map(decidedHere) } : {}),
    state: facts.state ?? null
  };
  const digest = `sha256:${recordSha256(bound)}`;
  const phaseOption = requestedPhase && requestedPhase !== workflow.currentPhase ? phaseId : null;
  const recommended = items.filter((item) => item.decidedBy.allowed).map((item) => [item.id, item.options.find((entry) => entry.recommended && entry.decidedBy.allowed)?.id])
    .filter(([, chosen]) => chosen);
  const decisions = items.filter((item) => item.kind !== 'approval' && !item.machine);
  // What stops this step: what holds its approval; before it is submitted, everything but a sign-off
  // owed to the Story's ending (a test-run risk stops the submission, a sign-off stops nothing here).
  // A Node that would not suit the tests is said before any run, and nothing waits on it until one fails.
  // A departure never stops its step: publish and submit go ahead, and only the approval waits for it [CQF:REQ-023].
  const stopsStep = (item) => item.holdsApproval || (!awaiting && !LATER_KINDS.includes(item.kind) && item.details?.stage !== 'early');
  const holdingAll = decisions.filter(stopsStep).length;
  const others = decisions.length - holdingAll;
  const headline = !decisions.length && awaiting ? `${stepName(workflow, phaseId)} has nothing left to decide; its approval is next.`
    : !others ? decisionHeadline(workflow, phaseId, decisions.length)
      : holdingAll ? `${decisionHeadline(workflow, phaseId, holdingAll)} ${others === 1 ? '1 other decision does' : `${others} other decisions do`} not hold its approval.`
        : `${stepName(workflow, phaseId)} has ${others === 1 ? '1 open decision' : `${others} open decisions`}; none holds its approval.`;
  // What to do next: the first item that holds the approval; with none, the approval itself; before
  // submission, what stops the step, then whatever is left.
  // An item nobody can take yet is never the next thing to do.
  const takenNow = (item) => item.options.some((entry) => entry.available !== false);
  const first = items.find((item) => item.holdsApproval) ?? (awaiting ? items.at(-1) : items.find(stopsStep) ?? items.find(takenNow) ?? items[0]);
  // A sign-off and any choice this list records are answered on a host's card, which /sf-decide opens: no
  // route read as "no verified equivalent". A host with no card asks with `card: false`, where /sf-decide
  // would only show them again: a command no skill runs (a witness, an obligation risk), a choice a
  // /sf-decide turn may not record (an accepted test command), or a hold's route with its own skill.
  const theirsAlone = (item) => Boolean(item.routeSkill) || item.options.length > 0 && item.options.every((entry) => (entry.available === false || entry.recordable === false
    ? entry.available === false || typeof entry.action?.command === 'string' && commandLineWithoutSkill(entry.action.command) && !(card && entry.action.humanReview)
    : !card && !DECISION_LIST_CHAT_OPTIONS.includes(entry.id) && !entry.chat));
  const listRoute = decisions.length && decisions.every(theirsAlone) ? null : `/sf-decide ${workId}`;
  return {
    schemaVersion: 1, resultType: 'sflow-decisions', revision: DECISION_LIST_REVISION,
    ...(facts.repositoryPath ? { repositoryPath: facts.repositoryPath } : {}),
    recorded: (workflow.planAmendments ?? []).slice(-10).map(record => ({ id: record.id, kind: 'plan-accounting',
      at: record.at, summary: (record.changes ?? []).map(change => `${change.path} accounted for${change.clauseId ? ` under ${change.clauseId}` : ''}`).join('; ') })),
    workId, phase: phaseId, phaseLabel: stepName(workflow, phaseId), status: decisions.length ? 'decisions-needed' : 'nothing-to-decide',
    headline, rule: CONFORMANCE_GAP_RULE,
    items, holding, open: items.length,
    ...(offered.length ? { offered } : {}),
    ...(facts.inactiveTestCommands?.length ? { inactiveTestCommands: facts.inactiveTestCommands } : {}),
    next: first && !takenNow(first) ? { item: first.id, kind: first.kind, title: first.title, notYet: first.options[0]?.words ?? first.why,
      command: `singularity-flow nextsteps ${workId} --json`, copilotCommand: `/sf-next ${workId}` }
      : first ? { item: first.id, kind: first.kind, title: first.title, command: first.options[0]?.action?.command ?? `singularity-flow decisions ${workId}`,
        copilotCommand: first.kind === 'approval' ? `/sf-approve ${phaseId} --work-id ${workId}` : first.routeSkill ? `${first.routeSkill} ${workId}` : listRoute } : null,
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
 * { choose: { d1: 'reuse' }, reason: { d1: 'TEXT' }, expires: { d1: 'YYYY-MM-DD' }, cause: { ... }, clause: { d1: 'A,B' },
 * article: { d1: [{ article, decision, reason }] } }. The checklist has one answer per article, so it comes only from a file or a form.
 */
export function parseDecisionAnswers({ choose = [], reason = [], expires = [], cause = [], clause = [], article = {} } = {}) {
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
  const articles = new Map();
  for (const [item, value] of Object.entries(article ?? {})) {
    if (!/^d\d{1,3}$/u.test(item) || !Array.isArray(value)) refused(`The article answers name '${item}': each item of the list holds a list of { article, decision, reason }.`, 'DECISIONS_ANSWER_INVALID');
    articles.set(item, value);
  }
  return { choose: read('choose', choose), reason: read('reason', reason), expires: read('expires', expires), cause: read('cause', cause), clause: read('clause', clause), article: articles };
}

/** The clauses a person named for an item, spelled as the Story's index spells them. */
function namedClauses(item, text, known) {
  const named = String(text ?? '').split(/[\s,]+/u).filter(Boolean).map((entry) => {
    const upper = entry.toUpperCase();
    return known.find((id) => id === upper || id.endsWith(`:${upper}`)) ?? upper;
  });
  if (!named.length) refused(`Name the clauses that carry ${item.id}.`, 'DECISIONS_ANSWER_INVALID', { item: item.id });
  const unknown = known.length ? named.filter((id) => !known.includes(id)) : [];
  if (unknown.length) refused(`${item.id} names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a clause' : 'are not clauses'} of this Story. Its clauses: ${known.slice(0, 12).join(', ')}.`, 'DECISIONS_ANSWER_INVALID', { item: item.id, unknown });
  return [...new Set(named)];
}

/** One answer per article, and a reason for anything but satisfied: the rule the review's own record applies. */
function checkedArticles(item, given, need) {
  const answers = Array.isArray(given) ? given : [];
  const problem = need.articles.find(({ id }) => answers.filter((entry) => entry?.article === id).length !== 1)
    ? 'Answer every checklist article once'
    : answers.find((entry) => !need.decisions.includes(entry?.decision)) ? `Each article is ${need.decisions.join(', ')}`
      : answers.find((entry) => entry.decision !== 'satisfied' && !String(entry.reason ?? '').trim()) ? 'An article that is not satisfied needs its own reason'
        : answers.length !== need.articles.length ? 'Those are not this checklist\'s articles' : null;
  if (problem) refused(`${item.id}: ${problem}. A terminal asks each one with singularity-flow decisions record.`, 'DECISIONS_ANSWER_INVALID', { item: item.id });
  return answers.map(({ article, decision, reason }) => ({ article, decision, ...(decision === 'satisfied' ? {} : { reason: String(reason).trim() }) }));
}

/**
 * What recording these answers would write, item by item, in the packet's order, with every value
 * resolved (an answer, or the default the packet showed). Items this identity may not decide are
 * returned in `refused` with who may; nothing is written for them. Pure; never writes.
 */
export function decisionRecordPlan(packet, answers, { at }) {
  const steps = [];
  const refusedItems = [];
  for (const item of [...packet.items, ...(packet.offered ?? [])]) {
    const chosen = answers.choose.get(item.id);
    if (!chosen) {
      for (const flag of ['reason', 'expires', 'cause', 'clause', 'article']) {
        if (answers[flag]?.has(item.id)) refused(`--${flag} ${item.id}=... is given, but ${item.id} is not chosen with --choose.`, 'DECISIONS_ANSWER_INVALID');
      }
      continue;
    }
    const selected = item.options.find((entry) => entry.id === chosen);
    if (!selected) {
      refused(`${item.id} has no option '${chosen}'; its options are ${item.options.map((entry) => entry.id).join(', ')}.`, 'DECISIONS_ANSWER_INVALID',
        { item: item.id, options: item.options.map((entry) => entry.id) });
    }
    for (const flag of ['reason', 'expires', 'cause', 'clause', 'article']) {
      if (answers[flag]?.has(item.id) && !selected.needs[flag]) refused(`${item.id}=${chosen} takes no --${flag}.`, 'DECISIONS_ANSWER_INVALID');
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
      const { minimum, maximum } = selected.needs.reason;
      if (reason.length < minimum || reason.length > maximum) {
        refused(`The reason for ${item.id} must be ${minimum} to ${maximum} characters.`, 'DECISIONS_ANSWER_INVALID', { item: item.id });
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
    if (selected.needs.clause) values.clause = namedClauses(item, answers.clause?.get(item.id), selected.needs.clause.known ?? []);
    if (selected.needs.article) values.article = checkedArticles(item, answers.article?.get(item.id), selected.needs.article);
    steps.push({ item: item.id, title: item.title, option: chosen, label: selected.label, values,
      effects: selected.effects.map((effect) => ({ ...effect })) });
  }
  // A route moves the Story on, so everything else on this list is written first.
  const routes = (step) => step.effects.some((effect) => effect.kind === 'routing');
  return { steps: [...steps.filter((step) => !routes(step)), ...steps.filter(routes)], refused: refusedItems };
}

/** One record a plan writes, in plain words with its record kind, for summaries and reports. */
export function effectWords(workflow, effect, values = {}) {
  if (effect.kind === 'intent-amendment-draft') {
    return `draft ${stepName(workflow, effect.phase)}'s scope with a slot for ${listWords((effect.clauses ?? []).map((clause) => clauseName(workflow, clause)))}`
      + `${effect.path ? ` at ${effect.path}` : ''}; nothing is recorded or decided (intent-amendment draft)`;
  }
  if (effect.kind === 'evidence-reuse') {
    return `reuse ${stepName(workflow, effect.recordedBy)}'s recorded run for ${stepName(workflow, effect.phase)} (evidence reuse ${effect.attemptId})`;
  }
  if (effect.kind === 'upstream-issue') return `report the gap against ${stepName(workflow, effect.phase)} (new upstream issue about ${effect.about})`;
  if (effect.kind === 'test-run-risk') return `accept that ${effect.commandId} cannot run here until ${values.expires} (test-run risk)`;
  if (effect.kind === 'test-narrowing') return `accept that ${effect.commandId} ran narrowed for ${stepName(workflow, effect.phase)} (test-narrowing decision)`;
  if (effect.kind === 'test-command') return `run ${effect.request}'s command as ${stepName(workflow, effect.phase)}'s tests for this Story (test-command decision)`;
  if (effect.kind === 'visual-profile') return `record that screen size ${effect.profileId} does not apply to this Story (visual-profile decision)`;
  if (effect.kind === 'obligation-risk') return `accept the ${effect.category} risk of ${effect.obligation} until ${values.expires} (risk decision)`;
  if (effect.kind === 'plan-amendment') {
    const words = (change) => (change.kind === 'add-location' ? `add ${change.path} to ${clauseName(workflow, change.clauseId)}` : `list ${change.path} as a supporting change, ${change.class}`);
    return `${(effect.changes ?? [effect.change]).map(words).join(', ')} (plan amendment)`;
  }
  if (effect.kind === 'departure') {
    const named = (effect.departures ?? [effect.departure]).join(', ');
    if (effect.decision === 'reject') return `reject ${named}; ${['path', 'supporting', 'finding'].includes(effect.departureKind) ? 'the model restores what it changed' : 'the approved document stays as it was'} (departure rejection)`;
    if (effect.writes === 'forward-amendment') return `accept ${named}: amend the earlier step's document as its next generation (forward amendment)`;
    if (effect.writes === 'departure-acceptance') return `accept ${named}: the fix stays, and the plan is unchanged (departure acceptance)`;
    const words = (change) => (change.kind === 'add-location' ? `add ${change.path} to ${clauseName(workflow, change.clauseId)}` : `list ${change.path} as a supporting change, ${change.class}`);
    return `accept ${named}: ${(effect.changes ?? []).map(words).join(', ')} (plan amendment)`;
  }
  if (effect.kind === 'convergence-adjudication') {
    const answers = effect.answers ?? effect.items.map((itemId) => ({ itemId, disposition: effect.disposition, clauseIds: values.clause ?? [] }));
    const words = (answer) => ({ rework: 'send it back to fix', 'update-intent': `change the spec${answer.clauseIds?.length ? ` for ${answer.clauseIds.map((id) => clauseName(workflow, id)).join(', ')}` : ''}`,
      'accepted-deviation': 'accept it as is', dismissed: 'say it is not a real finding', deferred: 'decide it later' }[answer.disposition] ?? answer.disposition);
    return `${answers.map((answer) => `${words(answer)} (${answer.itemId})`).join(', ')} (convergence adjudication, as story adjudicate --answers records it)`;
  }
  if (effect.kind === 'node-pin') return `${effect.replaces ? `change ${effect.file} from ${effect.replaces} to ${effect.version}` : `create ${effect.file} holding ${effect.version}`} and list it as a supporting change, ${effect.class} (Node pin and plan amendment)`;
  if (effect.kind === 'scope-disposition') return `record scope item ${effect.item} as ${effect.disposition}${values.clause?.length ? `, carried by ${values.clause.map((id) => clauseName(workflow, id)).join(', ')}` : ''} (scope decision)`;
  if (effect.kind === 'completeness-review') return 'record that you reviewed the scope for completeness (completeness review)';
  if (effect.kind === 'applicability') return `record that ${effect.responsibility} does not apply to this Story (applicability decision)`;
  if (effect.kind === 'routing') return `send the Story ${effect.to ? (effect.to === 'end' ? 'to its end' : `to ${stepName(workflow, effect.to)}`) : `by route ${effect.option}`} (routing decision)`;
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
  const batches = planBatches(plan);
  const after = (index) => batches.slice(index + 1).flat().flatMap((later) => later.effects.map((entry) => ({ item: later.item, kind: entry.kind, effect: entry })));
  for (const [batchIndex, batch] of batches.entries()) {
    if (batch.length > 1) {
      const [first] = batch[0].effects;
      // Departures given one answer are one record: one plan amendment, or one rejection, naming each.
      const effect = first.kind === 'departure'
        ? { ...first, departure: undefined, departures: batch.map((step) => step.effects[0].departure), changes: first.changes ? batch.flatMap((step) => step.effects[0].changes) : undefined }
        // Every convergence answer is one write of the table it was read from: a second would find it changed.
        : first.kind === 'convergence-adjudication' ? { kind: first.kind, phase: first.phase, expect: first.expect, answers: batch.flatMap(adjudicationAnswersOf) }
          : { kind: 'plan-amendment', changes: batch.map((step) => step.effects[0].change) };
      try {
        const record = await apply(effect, batch[0], {});
        recorded.push(...batch.map((step) => ({ item: step.item, kind: effect.kind, record })));
      } catch (error) {
        return { recorded, failed: { item: batch[0].item, kind: effect.kind, error }, remaining: [...batch.map((step) => ({ item: step.item, kind: effect.kind, effect: step.effects[0] })), ...after(batchIndex)] };
      }
      continue;
    }
    const [step] = batch;
    const produced = {};
    for (const [effectIndex, effect] of step.effects.entries()) {
      try {
        const record = await apply(effect, step, produced);
        if (effect.kind === 'upstream-issue') produced.issue = record?.id ?? null;
        recorded.push({ item: step.item, kind: effect.kind, record });
      } catch (error) {
        return { recorded, failed: { item: step.item, kind: effect.kind, error },
          remaining: [...step.effects.slice(effectIndex).map((entry) => ({ item: step.item, kind: entry.kind, effect: entry })), ...after(batchIndex)] };
      }
    }
  }
  return { recorded, failed: null, remaining: [] };
}

const CONVERGENCE_BATCH = 'convergence';

/**
 * The plan in the order it is written, with plan paths given the same reason together: one amendment, one
 * record and one commit, which a plan amendment's format has always held. A different reason is its own.
 * Convergence answers are one batch whatever their reasons: one `story adjudicate --answers` write.
 */
export function planBatches(plan) {
  const batches = [];
  const byReason = new Map();
  for (const step of plan.steps) {
    const [effect] = step.effects;
    // A plan amendment, or departures decided alike, a wording one aside: each of those is its own forward amendment.
    const key = step.effects.length !== 1 ? null : effect.kind === 'plan-amendment' ? `plan\u0000${step.values.reason}`
      : effect.kind === 'departure' && effect.writes !== 'forward-amendment' ? `departure\u0000${effect.decision}\u0000${effect.writes ?? ''}\u0000${step.values.reason}`
        // Each convergence answer keeps its own reason in the one answers file `story adjudicate` takes.
        : effect.kind === 'convergence-adjudication' ? CONVERGENCE_BATCH : null;
    const open = key ? byReason.get(key) : null;
    if (open && (key === CONVERGENCE_BATCH || open.length < MAX_PLAN_AMENDMENT_CHANGES)) { open.push(step); continue; }
    const batch = [step];
    batches.push(batch);
    if (key) byReason.set(key, batch);
  }
  return batches;
}
