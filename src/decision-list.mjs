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
import { ISSUE_ONLY_OPTIONS, PERSON_STEPS } from './person-step-catalog.mjs';
import { countedRecords, presenceRequires } from './presence/counted.mjs';
import { MAX_PLAN_AMENDMENT_CHANGES, outsidePlanSettled, planAuthorities } from './plan-amendments.mjs';
import { clausesTakingPaths, leftOutWords, ROW_FULFILLMENTS, rowChangeMissing, rowChangeWords, rowTakesPaths } from './plan-row-fit.mjs';
import { classifySupportingChange } from './supporting-changes.mjs';
import { personClass } from './person-change-class.mjs';
import { matchApprovalAuthority, normalizeApprovalAuthorities, sameApprover } from './approval-authority.mjs';
import { commandLineWithoutSkill, DECISION_LIST_CHAT_OPTIONS } from './command-skills.mjs';
import { modelFreeCommandForCommand } from './model-free-commands.mjs';
import { recordSha256 } from './records.mjs';
import { evidenceWords, reraisedRoute, settledByWords, settledDecisions, settlementMatters } from './settled-decisions.mjs';
import { pinDiffWords, testCommandReviewHold } from './story-test-commands.mjs';
import { testSetupFiles } from './test-support-files.mjs';
import { testRunCauseWords } from './test-run-cause.mjs';
import { testRunRiskAuthorities } from './test-run-risk.mjs';
import { decisionGroups, decisionRefusalLead } from './decision-list-facts.mjs';
import { automaticApprovalsBefore, coveredStep, finalScopeStep, isConformancePhase, ownerStepChecks } from './phase-roles.mjs';
import { CONFORMANCE_GAP_RULE, decidableUpstreamStep, decisionHeadline, DIFFERENCE_VERDICTS, issueNamesClause, stepName, upstreamIssueOutcomes, upstreamReturnJoin, upstreamReturnLegal } from './upstream-routes.mjs';
import { SingularityFlowError } from './util.mjs';
import { advisedItem, reopenWords } from './decision-advice.mjs';
import { findingOverrideCommand, returnRoute, reviewDisputeCommand, sendBackCommand } from './action-command-map.mjs';
import { disputedFindingWords } from './review-dispute-words.mjs';
import { behaviourCommands, testEditWords } from './refactor-behaviour.mjs';
import { adviceForStep } from './step-advice.mjs';

export { decisionGroups, decisionHeadline, decisionRefusalLead, stepName };
export const DECISION_LIST_REVISION = 'decision-list-v1';
export { ISSUE_ONLY_OPTIONS } from './person-step-catalog.mjs';
export const DEFAULT_RISK_DAYS = 30;
const MAX_RISK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
// The order a chosen option's records are written in: an issue exists before it is decided.
// A draft writes no record, so it goes first: a later record that fails leaves only a file a person may delete.
export const EFFECT_ORDER = Object.freeze(['settled-undo', 'intent-amendment-draft', 'upstream-issue', 'evidence-reuse', 'test-run-risk', 'test-narrowing', 'test-command', 'visual-profile', 'plan-amendment', 'departure', 'node-pin', 'obligation-risk', 'scope-disposition', 'completeness-review', 'applicability', 'convergence-adjudication', 'intent-amendment-acknowledge', 'asked-for-note', 'review-dispute', 'finding-override', 'refactor-behaviour', 'witness-exception-renewal', 'forward-amendment-decision', 'amendment-revalidation', 'intent-amendment-refresh', 'intent-amendment-decision', 'routing', 'upstream-issue-decision']);
// Effects that carry the groups their own command checks, read where the list's facts are read.
const EFFECTS_NAMING_GROUPS = Object.freeze(['obligation-risk', 'scope-disposition', 'completeness-review', 'applicability', 'routing', 'departure', 'intent-amendment-decision', 'intent-amendment-refresh']);
/**
 * Choices recorded alone in their run, each its own commit: a decision on an intent amendment changes the approved
 * clauses or reopens steps, and a refresh is a rejection and a proposal [owner, 2026-11-13].
 */
export const ALONE_EFFECTS = Object.freeze(['intent-amendment-decision', 'intent-amendment-refresh']);
// A decision on an intent amendment takes a reason only when the person gives one, as its own command does.
const OPTIONAL_REASON = Object.freeze({ minimum: 0, maximum: 1000 });
const REASON = Object.freeze({ minimum: 20, maximum: 1000 });
const CAUSE = Object.freeze({ minimum: 10, maximum: 300 });
// `decision plan`'s own limits: a supporting change states its reason in at most 500 characters.
const PLAN_REASON = Object.freeze({ minimum: 20, maximum: 1000 });
const SUPPORTING_REASON = Object.freeze({ minimum: 20, maximum: 500 });
// `decision choose` asks only for a reason the log can keep.
const ROUTING_REASON = Object.freeze({ minimum: 1, maximum: 1000 });
// DECIDABLE_SCOPE_DISPOSITIONS in src/scope/extract.mjs, as a person reads them; a test pins the two equal.
// "Included" and "existing" both name clauses; an office agent answered "existing" for a statement this Story's own
// criterion covers, so each label says which one it is [office, 2026-11-12].
const SCOPE_CHOICES = Object.freeze([['included', 'Included: a clause of this Story states it', true], ['existing', 'Already in the product before this Story', true],
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
  // A revalidation is the revalidated step's own approvers' [UIF-M3].
  if (effect.kind === 'amendment-revalidation') return issueGroups(workflow, effect.phase);
  // A dispute of its reviewer's finding is for whoever the step's approval rules name (`review-source dispute`).
  if (effect.kind === 'review-dispute') return issueGroups(workflow, effect.phase);
  // So is overriding its check's finding (`decision override-finding`).
  if (effect.kind === 'finding-override') return issueGroups(workflow, effect.phase);
  // Keeping or accepting a refactor's behaviour is its code step's approvers' word, as a return of it would be.
  if (effect.kind === 'refactor-behaviour') return issueGroups(workflow, effect.phase);
  // A forward amendment is decided by the amended step's own approvers (`upstream-issue decide-amendment`).
  if (effect.kind === 'forward-amendment-decision') return issueGroups(workflow, effect.phase);
  // Drafting an amendment decides nothing, and its own command checks no group; the scope approvers decide the amendment.
  // Anyone working on the Story acknowledges an approved one [owner, 2026-11-13, D2].
  // So does undoing what was settled for a person: it only hands the question back [owner, 2026-11-13].
  // And calls words they typed a note, not a request [owner, 2026-11-18].
  if (['upstream-issue', 'intent-amendment-draft', 'intent-amendment-acknowledge', 'settled-undo', 'asked-for-note'].includes(effect.kind)) return null;
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
 * The return choice of an issue about `owner`, or null: a return from the current step, or, when the work already goes back
 * through `owner` for an open return, the same return joined (upstream-routes.mjs). On d-story (2026-11-23) the second of
 * two issues about Verification lost its return once the first had sent the work back, and could only be accepted or dismissed.
 */
function returnOption(workflow, context, { issue, target, raise = [], words, reason }) {
  const ownerName = stepName(workflow, target.phase);
  const joined = issue?.id ? upstreamReturnJoin(workflow, issue) : null;
  if (joined) {
    return option(workflow, context, {
      id: 'return', label: `Fix it in the redo of ${ownerName} already under way`,
      words: `${ownerName} already went back (${joined.id}); this records that the same redo fixes this too, and nothing is sent back again.`,
      effects: [...raise, { ...issueDecision(target, 'return'), joins: joined.id }],
      needs: { reason: textNeed(`${ownerName} is being redone (${joined.id}); the same redo fixes this.`, REASON) }
    });
  }
  if (!returnLegal(workflow, target.phase)) return null;
  return option(workflow, context, { id: 'return', label: `Return the work to ${ownerName}`, words,
    effects: [...raise, issueDecision(target, 'return')], needs: { reason: textNeed(reason, REASON) } });
}

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
      words: `The code is changed to do what ${names} ${clauses.length === 1 ? 'says' : 'say'}; the steps after it run again and the report is written again.`,
      does: `Returns the Story to ${stepName(workflow, fix.owner)}: ${reopenWords(workflow, fix.owner)}; the code changes to do what ${names} ${clauses.length === 1 ? 'says' : 'say'}.` }),
    decidedBy: decidedBy(workflow, [{ kind: 'upstream-issue-decision', issuePhase: reports[0] }], context) });
  }
  if (update && drafted) {
    // The wording is a person's or the Story's agent's [SCS:REQ-021]: propose refuses while a slot is left.
    const scopeName = stepName(workflow, update.owner);
    // Propose reads the Story's own draft by default: no Git-private path to type [owner, 2026-11-20].
    const propose = `singularity-flow story intent-amendment propose --work-id ${workflow.workItem.id} --reason "<why the specification changes>"`;
    const words = `The draft is at ${draft.path}. Write ${clauses.length === 1 ? 'the clause' : 'each clause'} in place of its sflow-draft slot and delete the closing line, `
      + `or ask the Story's agent (/sf-amend propose); then propose it. ${scopeName}'s approvers decide it.`;
    const step = personalStep({ id: 'update-spec', label: 'Update the spec: write the draft and propose it', command: propose, words,
      does: `Proposes the drafted change to ${scopeName}'s spec once you write it; ${scopeName}'s approvers decide it, and nothing is rewound until they do.`,
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
      command: corrected.command, words: 'Its author checks the verdict against the recorded evidence and publishes it again; nothing before it changes.',
      does: `Returns ${stepName(workflow, reports[0])} to its author: ${reopenWords(workflow, reports[0])}; nothing before it changes.` }),
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
  const back = returnOption(workflow, context, { issue, target, raise,
    words: `${ownerName} delivers ${names} again and the steps after it run again; working files are kept.`,
    reason: `Returned to ${ownerName} so it delivers ${names}.` });
  if (back) options.push(back);
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
function issueItem(workflow, context, state, { early = false } = {}) {
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
  const back = returnOption(workflow, context, { issue, target: issue,
    words: `${ownerName} is corrected and the steps after it run again; working files are kept.`,
    reason: `Returned to ${ownerName} to correct ${aboutName}.` });
  if (back) options.push(back);
  return {
    kind: 'upstream-issue',
    title: `${aboutName}: a problem reported in ${ownerName}`,
    why: why.join(' '),
    options,
    details: { issue: issue.id, phase: issue.phase, about: issue.about, status: state.status, proposed: issue.proposed ?? null, ...(early ? { early: true } : {}),
      supersedes: (context.facts.issues ?? []).filter((entry) => entry.supersededBy === issue.id).map((entry) => entry.issue.id),
      coveredBy: covering.map((entry) => entry.id),
      commands: [`singularity-flow upstream-issue decide ${issue.id} --work-id ${workflow.workItem.id} --outcome ${upstreamIssueOutcomes(workflow, issue.phase, issue)} --reason "<why>"`] }
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
function personalStep({ id, label, command, words, decidedBy = nobodyNamed(words), does = null }) {
  return { id, label, recommended: false, words, ...(does ? { does } : {}), effects: [], needs: {}, recordable: false,
    action: { command, alternativeCommands: [] }, decidedBy };
}

const RISK_CATEGORY_WORDS = Object.freeze({ 'external-dependency': 'it depends on something outside this change', 'known-failure': 'a known failure',
  'assurance-shortfall': 'less assurance than was asked for', 'deferred-verification': 'it will be verified later', 'accepted-deviation': 'an accepted deviation' });

/**
 * One item per criterion whose evidence approval waits on a person for: witness each slot after
 * looking at it, or accept the obligation as a dated risk. Both are the person's own commands.
 */
/**
 * Whether a sign-off with no screenshot can be given: the step that delivers what it is about was submitted or approved
 * (so there is something to check, and no next version of it is being written), and the sign-off is bound to this change. Before that it is only waiting, like the screenshot.
 */
const canAttest = (workflow, owed) => Boolean(owed?.clauseId && owed.slot && /^sha256:[a-f0-9]{64}$/u.test(String(owed.contextBinding ?? ''))
  && (owed.owners ?? []).some((owner) => ['awaiting_approval', 'approved'].includes(workflow.phases?.[owner]?.status)));

/**
 * The sign-off with no screenshot (owner, 2026-11-22): a person who may witness the criterion checked it themselves and says
 * what they checked. Offered beside a sign-off whose file is not there yet, so a missing screenshot never holds the Story.
 */
function attestOption(workflow, context, owed, groups) {
  if (!canAttest(workflow, owed)) return null;
  const words = 'You checked it yourself and say what you checked; your sign-off is its evidence, with no screenshot.';
  const step = personalStep({ id: `witness-${owed.slot}-self`, label: 'Sign it off without a screenshot: I checked it myself',
    command: `singularity-flow decision witness ${workflow.workItem.id} --criterion ${owed.clauseId} --slot ${owed.slot} --attest --confirm states-the-outcome --confirm matches-the-criterion --confirm current-for-this-change --reason "<what you checked>"`,
    words, decidedBy: stepDecidedBy(workflow, context, groups, words) });
  return { ...step, action: { ...step.action, humanReview: { kind: 'witness', attest: true, clauseId: owed.clauseId, clauseText: owed.clauseText, slot: owed.slot,
    method: owed.method, files: [], owners: owed.owners, contextBinding: owed.contextBinding } } };
}

function evidenceItem(workflow, context, entry) {
  const name = clauseName(workflow, entry.criterion);
  const slots = entry.witnesses.map((witness) => witness.files.length === 1 ? witness.files[0] : `slot ${witness.slot}`);
  const owedFor = (witness) => (context.facts.pending?.owed ?? []).find(row => row.kind === 'witness' && row.clauseId === entry.criterion && row.slot === witness.slot);
  const notYet = (witness) => owedFor(witness)?.available === false;
  // SFlow's own screenshot, taken when a person asks, is the file a sign-off the plan names none for is given [owner, 2026-11-18].
  const check = entry.witnesses.map((witness) => screenshotCheck(workflow, owedFor(witness))).find(Boolean) ?? null;
  const options = [
    ...entry.witnesses.map((witness) => {
      const owed = owedFor(witness);
      const words = notYet(witness) ? notPublishedYet(workflow, owed) : 'You look at the evidence yourself and record the witness with its three confirmations; nothing is decided here.';
      const step = personalStep({
      id: `witness-${witness.slot}`,
      label: notYet(witness) ? (witness.files.length ? `Sign off ${listWords(witness.files)} once it is published` : `Sign off the ${witness.method} evidence for slot ${witness.slot} once it has a file`)
        : witness.files.length === 1 ? `Sign off ${witness.files[0]} after looking at it` : `Sign off the ${witness.method} evidence for slot ${witness.slot}: witness it`,
      command: notYet(witness) ? null : witness.command,
      words,
      decidedBy: stepDecidedBy(workflow, context, owed?.groups ?? witness.groups ?? [...new Set((owed?.owners ?? []).flatMap(id => approvers(workflow, id)))], words)
      });
      if (notYet(witness)) return [{ ...step, available: false }, attestOption(workflow, context, owed, owed?.groups ?? witness.groups ?? [])].filter(Boolean);
      return owed ? { ...step,
        action: { ...step.action, humanReview: { kind: 'witness', clauseId: owed.clauseId, clauseText: owed.clauseText, slot: owed.slot, method: owed.method,
          files: owed.files, owners: owed.owners, contextBinding: owed.contextBinding } } } : step;
    }).flat(),
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
    ...(check ? { check } : {}),
    // The same title the sign-off carried from its first publication: one item for one subject [decision map, finding 3].
    title: slots.length ? `Sign off ${name}` : `Decide the open evidence for ${name}`, subject: `sign-off:${entry.criterion}`,
    why: `${name} is ${entry.result}: ${slots.length ? `approval waits for a person to witness ${listWords(slots)} for this change` : 'an obligation is still open'}. `
      + 'Witness it if it shows the outcome, or accept a dated risk; the verdict itself does not change.',
    options,
    details: { criterion: entry.criterion, result: entry.result,
      witnesses: entry.witnesses.map((witness) => (notYet(witness) ? { ...witness, command: null } : witness)), risks: entry.risks, categories: entry.categories,
      commands: [...entry.witnesses.filter((witness) => !notYet(witness)).map((witness) => witness.command), ...entry.risks.map((risk) => risk.command)] }
  };
}

/**
 * One item for a test command of a step whose latest run the environment stopped, by its classified cause. Whether it
 * fails without this change too is SFlow's own run on the base commit (`tests base`), run before the card asks
 * (decision-probes.mjs) [owner, 2026-11-16]; until it has that answer the item carries `check`, offered first.
 */
function testRiskItem(workflow, context, risk) {
  const name = stepName(workflow, risk.phase);
  const stopped = risk.status === 'blocked' ? 'was blocked' : 'failed';
  const exit = Number.isInteger(risk.exitCode) ? ` (exit code ${risk.exitCode})` : '';
  const because = risk.causeClass ? `: ${testRunCauseWords(risk.causeClass)} (${risk.causeClass})` : '';
  const base = risk.base ?? null;
  return {
    kind: 'test-run-risk',
    ...(base && base.status !== 'checked' ? { check: { kind: 'base-tests', status: base.status, label: `Check first: run ${risk.commandId} without this change`,
      does: 'SFlow runs them once on the commit this Story started from; nothing is recorded.',
      command: `singularity-flow tests base --work-id ${workflow.workItem.id} --phase ${risk.phase} --command ${risk.commandId}`,
      ...(base.cutShort ? { cutShort: true, seconds: base.seconds } : {}) } } : {}),
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
      causeClass: risk.causeClass ?? null, ...(base ? { base } : {}),
      commands: [`singularity-flow decision test-risk ${workflow.workItem.id} --phase ${risk.phase} --command ${risk.commandId}${risk.causeClass ? ` --cause-class ${risk.causeClass}` : ''} --cause "<what stops it>" --reason "<why>" --expires <YYYY-MM-DD>`] }
  };
}

/**
 * One choice for a Node that does not suit the tests: a person pins an installed one, and that one
 * answer creates the file and accounts for it in the plan (src/node-pin.mjs). Before any run it is listed
 * and stops nothing; after a failed run it is what the step waits on.
 *
 * Whether the tests pass on that Node is SFlow's own check, run before the card shows it (decision-probes.mjs) and
 * kept for this code: never a command the person is told to run [owner, 2026-11-16]. Until it has a result for this
 * code the item carries `check`, which every host offers first.
 */
function nodePinItem(workflow, context, pin) {
  const name = stepName(workflow, pin.phase);
  const workId = workflow.workItem.id;
  const tryIt = `singularity-flow tests node --work-id ${workId} --phase ${pin.phase} --node ${pin.version}`;
  const { replaces = null } = pin;
  const probe = pin.probe ?? { status: pin.tried ? 'checked' : 'unknown' };
  return {
    kind: 'node-pin',
    title: `${name}'s tests need another Node`,
    // What the pin changes is its option's effect (decision-advice.mjs): the plan, never the code or its tests.
    why: `${pin.words}${pin.words.includes(`Node ${pin.node}`) ? '' : ` Node ${pin.node} is installed here.`} ${pin.tried?.words ?? 'Not yet tried on it: SFlow checks first and records nothing.'}${replaces ? ` Or install Node ${replaces} and there is nothing to choose.` : ''}`,
    ...(probe.status === 'checked' ? {} : { check: { kind: 'node-tests', status: probe.status, label: `Check first: run the tests on Node ${pin.version}`,
      does: 'SFlow runs them once on a copy of this checkout; nothing is recorded.',
      command: tryIt, ...(probe.cutShort ? { cutShort: true, seconds: probe.seconds } : {}) } }),
    options: [option(workflow, context, {
      id: 'pin-node', label: replaces ? `Change ${pin.file} from ${replaces} to Node ${pin.version}` : `Pin Node ${pin.version}`,
      // Its effect is in `does`; these are the words a person weighs on its own form, with nothing internal in them.
      words: `Your reason goes into the plan with it, and SFlow then runs this repository's tests on Node ${pin.node}.`,
      effects: [{ kind: 'node-pin', phase: pin.phase, file: pin.file, version: pin.version, class: NODE_PIN_CLASS, ...(replaces ? { replaces } : {}) }],
      needs: { reason: textNeed('', SUPPORTING_REASON) }
    })],
    details: { phase: pin.phase, file: pin.file, version: pin.version, node: pin.node, running: pin.running ?? null, stage: pin.stage, commandId: pin.commandId ?? null, ...(replaces ? { replaces } : {}),
      ...(pin.tried ? { tried: pin.tried.passed === true } : {}), probe: { status: probe.status, ...(probe.cutShort ? { cutShort: true, seconds: probe.seconds } : {}) },
      ...(pin.cause ? { cause: pin.cause } : {}),
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

/**
 * A refactor's behaviour change while its code is written (refactor-behaviour.mjs) [ITW:REQ-015]: a test that passed before
 * the change fails in a run of this version, or the version changes what an existing test expects. The code step's
 * publication waits for the person: keep the old behaviour (the code step restores it, SFlow putting back what any changed
 * test expected) or accept the new one (the code goes back to the plan and the task becomes a change). SFlow recommends keeping it,
 * as a refactor promises (decision-advice.mjs). The person's own step: on the card, or `work behaviour` in their terminal.
 */
function behaviourItem(workflow, context, facts) {
  const name = stepName(workflow, facts.phase);
  const { keep, accept } = behaviourCommands(workflow.workItem.id);
  const said = [...(facts.failing.length ? [`${listWords(facts.failing)} passed before the change and ${facts.failing.length === 1 ? 'fails' : 'fail'} now`] : []),
    ...(facts.tests.length ? [`the code changes ${listWords(facts.tests.map(testEditWords))}`] : [])];
  const effect = (choice) => [{ kind: 'refactor-behaviour', phase: facts.phase, generation: facts.generation, choice }];
  return {
    kind: 'refactor-behaviour', title: `The refactor changes behaviour in ${name} version ${facts.generation}`,
    why: `${said.join('; ').replace(/^./u, (first) => first.toUpperCase())}. A refactor keeps what passed before; only a person changes that.`,
    options: [
      { ...option(workflow, context, { id: 'keep-behaviour', label: 'Keep the old behaviour', recommended: true, effects: effect('keep'), needs: { reason: textNeed('', OPTIONAL_REASON) },
        words: `${name} goes on and restores it${facts.tests.length ? '; SFlow puts back what the changed tests expected' : ''}.` }), terminal: keep },
      { ...option(workflow, context, { id: 'accept-behaviour', label: 'Accept the new behaviour', effects: effect('accept'), needs: { reason: textNeed('', OPTIONAL_REASON) },
        words: `The task becomes a change: ${name} goes back to the plan, which SFlow starts again to say what changes; the code waits for it.` }), terminal: accept }],
    details: { phase: facts.phase, generation: facts.generation, checks: facts.undecided, failing: facts.failing, tests: facts.tests.map((entry) => entry.path),
      commands: [keep, accept] }
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
      does: `Returns ${name} for changes: ${reopenWords(workflow, request.phase)}; the command is decided after that.`,
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
/**
 * Whether this read could tell who the person is for these groups: a Git email or GitHub login to match, and, for a group
 * whose members are named only by GitHub login, that login looked up. Not, and "not yours" was a guess: VS Code's chat was
 * told there was nothing to decide while the approval was theirs [owner's Story, 2026-11-20, hardening C].
 */
function identityUnknown(registry, groups, actor) {
  if (!String(actor?.email ?? '').trim() && !String(actor?.login ?? '').trim()) return true;
  // Only a lookup that says it did not resolve (git.mjs identity: not-checked or unavailable) leaves a login unknown.
  if (actor?.login || !actor?.githubLookup || actor.githubLookup === GITHUB_RESOLVED) return false;
  return groups.some((id) => !registry?.[id]?.allowAnyGitIdentity && (registry?.[id]?.members ?? []).some((member) => member.githubLogin && !member.email));
}
const GITHUB_RESOLVED = 'resolved';

function stepDecidedBy(workflow, { authorities, actor }, groups, words) {
  if (!groups?.length) return nobodyNamed(words);
  let registry = null;
  try { registry = normalizeApprovalAuthorities(authorities); } catch { registry = null; }
  const labels = groups.map((id) => groupLabel(registry, id));
  let allowed = false;
  try { allowed = matchApprovalAuthority(authorities, { authorities: groups }, actor).authorized; } catch { allowed = false; }
  if (allowed) return { groups, labels, allowed: true, words: `You may do this (${listWords(labels)}). ${words}`.trimEnd() };
  // Not established here: still not recorded as theirs, and said so; the step's own command checks it when they take it.
  if (identityUnknown(registry, groups, actor)) {
    return { groups, labels, allowed: false, established: false,
      words: `SFlow could not tell here whether you are one of the ${listWords(labels)}: it checks that when you do this. ${words}`.trimEnd(),
      share: `/sf-decide ${workflow?.workItem?.id ?? '<WORK-ID>'}` };
  }
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
  const details = { key: pending.key, decision: pending.decision, after: pending.after, reason: pending.reason ?? null };
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

// Why rule E8 could not keep a step (phase-retention.mjs amendmentRetentionCandidates), as a person reads it.
const NOT_KEPT_WORDS = Object.freeze({ 'not-approved': 'it is not approved yet', code: 'it writes code', decision: 'it feeds or follows a decision',
  skill: 'it runs a skill', 'plans-new-clause': 'it plans, and the amendment adds a clause to plan', approvals: 'its approval is not complete',
  changed: 'something it decided over changed since its approval' });

function effectReason(workflow, reason) {
  const clauses = (ids) => listWords(ids.map((id) => clauseName(workflow, id)));
  if (reason.kind === 'cites') return `it cites ${clauses(reason.clauses)}`;
  if (reason.kind === 'radius') return `${reason.path} is in the change's reach`;
  if (reason.kind === 'unreadable') return `${reason.path} is missing or cannot be read`;
  if (reason.kind === 'code-step') return `it writes code, and the change affects ${reason.claims} ${reason.claims === 1 ? 'claim' : 'claims'}`;
  if (reason.kind === 'convergence') return 'it compares the code with the scope';
  if (reason.kind === 'after-reset') return `it comes after ${stepName(workflow, reason.phase)}`;
  if (reason.kind === 'not-kept') return NOT_KEPT_WORDS[reason.why] ?? NOT_KEPT_WORDS.changed;
  // Under SPEC-CIC switch 1 a step whose record does not show what it depended on counts as affected [CIC:REQ-006].
  if (reason.kind === 'unresolved-record') return `what it depended on is not fully recorded (${(reason.reasons ?? []).join(', ')})`;
  return null;
}

/**
 * What approving an intent amendment does, one sentence per step after the scope, from its effect (state.mjs
 * intentAmendmentEffect, the computation approval applies) [CIC:REQ-012]: the step it reopens and why, those that
 * run again after it, those rule E8 keeps (with the changed clauses their prompt held, D1), and those whose
 * approvers say whether they still hold. A step that never ran reads the amended scope when it starts, so it is
 * named only when the Story returns to it. The preview and every card say it in these words.
 */
export function amendmentEffectWords(workflow, effect, { steps: most = 8 } = {}) {
  const lines = [];
  for (const step of effect?.steps ?? []) {
    if (step.outcome === 'unchanged' || (step.outcome === 'reset' && !(step.generation > 0))) continue;
    const name = stepName(workflow, step.phase);
    const why = [...new Set((step.reasons ?? []).map((reason) => effectReason(workflow, reason)).filter(Boolean))].slice(0, 3).join('; ');
    const held = step.inPrompt?.length ? `, though ${listWords(step.inPrompt.map((id) => clauseName(workflow, id)))} ${step.inPrompt.length === 1 ? 'was' : 'were'} in its prompt` : '';
    // D1 [CIC:REQ-021]: its approvers are asked whether it still holds, with what is recommended.
    const asked = step.stillHolds ? `; its prompt held ${listWords(step.stillHolds.clauses.map((id) => clauseName(workflow, id)))}, so its approvers say whether it still holds `
      + `(recommended: ${step.stillHolds.recommend === 'return' ? 'redo it' : 'it still holds'})` : '';
    // Signed rows win (owner, 2026-11-15): its record is incomplete, and the rows the amendment carries for it are its own answer.
    const rows = step.signedRows === 'signed' ? '; what it depended on is not fully recorded, and its approvers signed the rows the amendment carries for it'
      : step.signedRows === 'unsigned' ? '; what it depended on is not fully recorded, so it keeps its approval once its approvers sign the rows the amendment carries for it' : '';
    lines.push(step.outcome === 'kept' ? `${name} keeps its approval (rule E8): it cites none of the changed clauses${held}${asked}${rows}.`
      : step.outcome === 'still-holds' ? `${name}'s approvers say whether it still holds, or return the Story to it.`
        // An editorial change carries the evidence of the clauses it rewords [CIC:REQ-014].
        : step.outcome === 'carried' ? `${name} ${step.status === 'approved' ? 'keeps its approval' : 'goes on as it is'}, and its evidence of the reworded clauses is carried: the change is editorial.`
        : `${name} ${step.outcome === 'reopened' ? 'is reopened' : 'runs again'}${why ? `: ${why}` : ''}.`);
  }
  return lines.length > most ? [...lines.slice(0, most), `And ${lines.length - most} more steps.`] : lines;
}

/** The clauses an amendment changes again, and those it puts back as an earlier revision held them [CIC:REQ-016, D4]. */
export function amendmentRepeatWords(workflow, repeats) {
  const clause = (id) => clauseName(workflow, id);
  return [...(repeats?.repeated ?? []).map((entry) => `${clause(entry.clause)} has now been changed ${entry.times} times on this Story.`),
    ...((repeats?.reversed ?? []).length ? [`${listWords(repeats.reversed.map(clause))} ${repeats.reversed.length === 1 ? 'goes' : 'go'} back to a statement an earlier scope revision held.`] : [])];
}

/** What an approved amendment did, from its own record. */
function appliedWords(workflow, applied) {
  const names = (ids) => listWords(ids.map((id) => stepName(workflow, id)));
  return [applied.kept?.length ? `It kept the approval of ${names(applied.kept)} (rule E8).` : '',
    applied.reopened ? `It reopened ${stepName(workflow, applied.reopened)}${applied.reset?.length ? `; ${names(applied.reset)} ${applied.reset.length === 1 ? 'runs' : 'run'} again after it` : ''}.` : '',
    applied.asked?.length ? `${names(applied.asked)} ${applied.asked.length === 1 ? 'has' : 'have'} a row for ${applied.asked.length === 1 ? 'its' : 'their'} approvers to say whether ${applied.asked.length === 1 ? 'it still holds' : 'they still hold'}.` : '']
    .filter(Boolean);
}

// A statement as a person reads it: on one line, without its own anchor, and short enough to read on a card.
const statementWords = (text) => String(text ?? '').replace(/\s*\[[A-Za-z0-9._-]+:[A-Z]+-\d{3,}\]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 300);

/**
 * What an amendment changes and reaches, in the words every surface shows [owner, 2026-11-13, D1]: one line per
 * clause it adds, revises or removes with its statement, then who proposed it and what it reaches. From the
 * amendment's own record (decision-list-reads.mjs reads it for a full list); empty when the record was not read.
 */
function amendmentShown(workflow, card) {
  if (!card) return {};
  const lines = (card.changes ?? []).map(({ clause, change, before, after }) => {
    const name = clauseName(workflow, clause);
    if (change === 'added') return `${name} is added: "${statementWords(after)}"`;
    if (change === 'removed') return `${name} is removed; it said: "${statementWords(before)}"`;
    return `${name} is revised from "${statementWords(before)}" to "${statementWords(after)}"`;
  });
  const by = card.proposer ? `${card.proposer} proposed it${card.authored === 'governed-agent' ? '; Copilot wrote the wording'
    : card.authored === 'human' ? '; a person wrote the wording' : ''}${card.reason ? `: "${statementWords(card.reason)}"` : ''}.` : null;
  const names = (values, more, noun) => (values?.length ? `${noun}: ${listWords([...values, ...(more ? [`${more} more`] : [])])}.` : '');
  // Exactly what approving it does, step by step, or what an approved one did [CIC:REQ-012].
  const dependents = card.effect?.dependents?.length && !card.effect.carried ? [`${listWords(card.effect.dependents.map((id) => clauseName(workflow, id)))} ${card.effect.dependents.length === 1 ? 'depends' : 'depend'} on a changed clause.`] : [];
  const effect = card.effect ? [...dependents, ...amendmentEffectWords(workflow, card.effect), ...amendmentRepeatWords(workflow, card.effect.repeats)]
    : card.applied ? appliedWords(workflow, card.applied) : [];
  // Under SPEC-CIC switch 3, how big it is, why and who decides it, first [CIC:REQ-013, REQ-014].
  const reach = [...(card.size?.lines ?? []), card.radius?.summary ?? '', names(card.radius?.artifacts, card.radius?.moreArtifacts, 'Files'), names(card.radius?.tests, card.radius?.moreTests, 'Tests'),
    effect.length ? `${card.effect ? 'If it is approved: ' : ''}${effect.join(' ')}` : ''].filter(Boolean).join(' ');
  return { changes: card.changes ?? [], lines: [...lines, ...(card.moreChanges ? [`And ${card.moreChanges} more changed clauses.`] : [])],
    ...(by ? { proposedBy: by } : {}), ...(reach ? { reach } : {}) };
}

const CLASS_LABEL = Object.freeze({ editorial: 'editorial', refinement: 'a refinement', material: 'a material change' });

/** Why a pending amendment no longer matches the Story, in words; null while it still does. */
function staleWords(workflow, stale) {
  if (!stale) return null;
  const step = stepName(workflow, stale.phase);
  return stale.cause === 'source-step' ? `${step} moved on after it was proposed`
    : stale.cause === 'source-evidence' ? `the code or ${step}'s document changed after it was proposed` : `the approved ${step} changed after it was proposed`;
}

/**
 * An intent amendment: one proposed and still undecided, or one approved whose changed clauses nobody has
 * acknowledged yet. A requirements (scope) approver approves or rejects a pending one on the decisions card,
 * with what it changes and reaches in front of them; the record is the same decision the terminal's
 * `story intent-amendment decide` writes, with every check it makes [owner, 2026-11-13, D1, reversing SPEC-OAP's
 * "nothing new is recordable from the list" for this item]. A proposal the Story moved under is refreshed with
 * one choice (D3), and anyone working on the Story acknowledges an approved one there (D2). Each option keeps
 * its exact terminal command beside it: SF Guard takes its signature in the person's own terminal.
 */
function intentAmendmentItem(workflow, context, amendment) {
  const workId = workflow.workItem.id;
  const id = amendment.id;
  const clauses = listWords((amendment.changedClauses ?? []).map((clause) => clauseName(workflow, clause))) || 'the approved scope';
  const status = `singularity-flow story intent-amendment status --work-id ${workId} --json`;
  const shown = amendmentShown(workflow, amendment.card ?? null);
  if (amendment.status === 'approved') {
    const acknowledge = `singularity-flow story intent-amendment acknowledge ${id} --work-id ${workId}`;
    return {
      kind: 'intent-amendment', title: `Acknowledge intent amendment ${id}`,
      // Which steps, and what acknowledging lets them do, in plain words [owner, 2026-11-18: "the reopened step can revalidate"].
      why: `${id} was approved and changed ${clauses}, so ${listWords((amendment.affectedPhases ?? []).map((phaseId) => stepName(workflow, phaseId))) || 'the steps it reopened'} can be submitted again once someone acknowledges it.`,
      // A bound yes in chat too, unless SF Guard signs it [owner, 2026-11-19].
      options: [{ ...option(workflow, context, { id: 'acknowledge', label: `I read ${id}: acknowledge it`,
        words: 'Anyone working on this Story may acknowledge it, here or in their own terminal, once they have read what it changed.',
        effects: [{ kind: 'intent-amendment-acknowledge', amendment: id }], needs: {} }), oneByOne: true, terminal: acknowledge,
      ...(presenceRequires(workflow) ? {} : { chat: { command: acknowledge } }) }],
      details: { amendment: id, status: 'approved', statusCommand: status, ...shown, commands: [acknowledge] }
    };
  }
  const scope = context.facts.scopePhase ?? null;
  const scopeName = scope ? stepName(workflow, scope) : 'the scope';
  // The step it was proposed in waits while it is pending: the engine refuses its begin, prepare, publish and submit.
  // Its summary names it; an older one, its proposal's history entry.
  const sourcePhase = amendment.sourcePhase ?? (workflow.history ?? []).findLast((entry) => entry?.event === 'intent_amendment_proposed'
    && String(entry.detail ?? '').startsWith(`${id} `))?.phase ?? null;
  const decide = (decision) => `singularity-flow story intent-amendment decide ${id} --decision ${decision} --confirm ${id} --work-id ${workId}`;
  // The rows it carries for a separate plan: that plan's approvers sign them by deciding it, and the plan keeps its approval [PHR:REQ-008].
  const plans = (amendment.planCorrections ?? []).map((entry) => entry.ownerPhase);
  const carries = plans.length ? ` It carries the rows ${listWords(plans.map((phaseId) => stepName(workflow, phaseId)))} needs for the clauses it adds, removes or revises: `
    + `an approver of ${listWords(plans.map((phaseId) => stepName(workflow, phaseId)))} signs them by deciding it, and ${plans.length === 1 ? 'that plan keeps its' : 'those plans keep their'} approval.` : '';
  const scopeGroups = scope ? approvers(workflow, scope) : [];
  const card = amendment.card ?? null;
  // Approving takes a scope approver (for a material change, the scope-change authority), or an approver of a plan whose rows
  // it carries, as decideIntentAmendment checks; rejecting a scope approver.
  const plansGroups = plans.flatMap((phaseId) => approvers(workflow, phaseId));
  const approveGroups = [...new Set([...(card?.size?.groups ?? scopeGroups), ...plansGroups])];
  const stale = staleWords(workflow, card?.stale);
  const counted = amendment.approvals?.reached ? ` ${amendment.approvals.reached} of ${amendment.approvals.required} approvals are recorded`
    + `${amendment.approvals.planSignOffsMissing?.length ? `; an approver of ${listWords(amendment.approvals.planSignOffsMissing.map((phaseId) => stepName(workflow, phaseId)))} still signs the rows it carries` : ''}.` : '';
  const effect = (decision, groups, raise = null) => ({ kind: 'intent-amendment-decision', amendment: id, decision, proposalSha256: amendment.proposalSha256 ?? null, groups,
    ...(raise ? { raise } : {}) });
  const decision = (decisionId, words, groups, raise = null) => ({ ...option(workflow, context, { id: raise ? `approve-${raise}` : decisionId,
    label: `${decisionId === 'approve' ? 'Approve' : 'Reject'} ${id}${raise ? ` as ${CLASS_LABEL[raise]}` : ''}`, words,
    effects: [effect(decisionId, groups, raise)], needs: { reason: textNeed('', OPTIONAL_REASON) } }), oneByOne: true, terminal: `${decide(decisionId)}${raise ? ` --class ${raise}` : ''}` });
  // What its own command would refuse is said here, never offered: an approval already given, the proposer's own
  // where the scope's policy forbids it, and a proposal the Story moved under.
  const mine = (who) => Boolean(who && context.actor && sameApprover(who, context.actor));
  const approvedAlready = (card?.decisions ?? []).some((entry) => entry.decision === 'approved' && mine(entry.actor));
  const ownProposal = mine(amendment.proposedBy) && scope && workflow.phases?.[scope]?.approvalPolicy?.allowSelfApproval === false;
  const held = stale ? `It cannot be approved as it is: ${stale}. Refresh it, or reject it.`
    : approvedAlready ? 'You approved it already; another approver decides next.'
      : ownProposal ? `You proposed it, and ${scopeName}'s policy has someone else approve it.` : null;
  const signs = plans.length ? ' Your decision signs the plan rows it carries if you approve that plan.' : '';
  const sized = card?.size?.effective ?? null;
  const approve = decision('approve', held ?? (sized === 'editorial'
    ? `The new wording is approved as editorial: no step runs again or is asked, and the evidence of the reworded clauses is carried.${signs}`
    : `The approved clauses change as shown, so the steps that cite them reopen${sized ? `; you approve it as ${CLASS_LABEL[sized]}` : ''}.${signs}`), approveGroups);
  // An approver may raise its class while approving, never lower it [owner decision 1]; who decides the stricter class decides that choice.
  const raises = (card?.size?.raises ?? []).map((entry) => decision('approve', held ?? `Approves it as ${CLASS_LABEL[entry.class]}: ${entry.class === 'material'
    ? `a material change, which only ${listWords(entry.groups)} ${entry.groups.length === 1 ? 'approves' : 'approve'}` : 'a refinement, so the steps that cite the changed clauses reopen'}.${signs}`,
  [...new Set([...entry.groups, ...plansGroups])], entry.class));
  const reject = decision('reject', 'The approved clauses stay as they are, and every submission stays valid.', scopeGroups);
  // One choice refreshes a proposal the step moved under: the same change, proposed again against the step as it is now (D3).
  const refresh = stale ? [{ ...option(workflow, context, { id: 'refresh', recommended: true, label: `Refresh ${id} against the step as it is now`,
    words: `Rejects ${id} and proposes the same change again, with its reason and its author, against the step as it is now; ${scopeName}'s approvers then decide that one. If it no longer applies, nothing is recorded and you are told why.`,
    effects: [{ kind: 'intent-amendment-refresh', amendment: id, proposalSha256: amendment.proposalSha256 ?? null, groups: scopeGroups }], needs: {} }), oneByOne: true }] : [];
  return {
    kind: 'intent-amendment', title: `Decide intent amendment ${id}`,
    why: `${id} proposes changing ${clauses}. Rejecting it keeps every submission as it is; approving it changes the approved clauses, so the steps that cite them reopen.${carries}${counted}`
      + `${sourcePhase && workflow.phases?.[sourcePhase] ? ` ${stepName(workflow, sourcePhase)} waits until it is decided.` : ''}${stale ? ` It no longer matches the Story: ${stale}.` : ''}`,
    options: [...refresh, reject, ...[approve, ...raises].map((entry) => (held ? { ...entry, recordable: false, available: false } : entry))],
    details: { amendment: id, status: 'proposed', scopePhase: scope, ...(sourcePhase ? { sourcePhase } : {}), statusCommand: status, ...shown, ...(stale ? { stale } : {}),
      commands: [decide('approve'), decide('reject')] }
  };
}

/**
 * A forward amendment or a revalidation it asked for, as the Story's ending reads them. A forward amendment's approvers approve or
 * reject it here, each a choice this list records [owner, 2026-11-28]: once one route for both, `--decision approve|reject`, which
 * no shell could run and only the person's own terminal took.
 */
function forwardAmendmentItem(workflow, context, blocker) {
  if (blocker.code === 'AMENDMENT_REVALIDATION_REQUIRED') return revalidationItem(workflow, context, blocker);
  const name = stepName(workflow, blocker.phase);
  const decide = (decision, label, words) => option(workflow, context, { id: `${decision}-amendment`, label, words,
    effects: [{ kind: 'forward-amendment-decision', amendment: blocker.amendment, phase: blocker.phase, decision }],
    needs: { reason: textNeed('', REASON) } });
  const command = (decision) => `singularity-flow upstream-issue decide-amendment ${blocker.amendment} --work-id ${workflow.workItem.id} --decision ${decision} --reason "<why>" --confirm ${blocker.amendment}`;
  return {
    kind: 'forward-amendment', title: `Decide forward amendment ${blocker.amendment}`,
    // Why the person is asked is the amended step's own line in the advice table (step-advice.mjs), by what that step is for.
    why: `${blocker.message} ${adviceForStep(workflow, blocker.phase).decides}`,
    options: [decide('approve', `Approve ${blocker.amendment}: the corrected document becomes ${name}'s next version`,
      `${name} gets its next version from the corrected document; each later step that read it is listed to be checked again.`),
    decide('reject', `Reject ${blocker.amendment}: ${name} keeps its approved document`, `Nothing changes in ${name}; the problem it answered stays open.`)],
    details: { blocker: blocker.code, amendment: blocker.amendment, phase: blocker.phase, commands: [command('approve'), command('reject')] }
  };
}

/**
 * Each witness exception a step's approval recorded whose date has passed: the Story cannot end on it (the final check), and
 * a person who approves that step renews it here with a new date and their reason [owner, 2026-11-28], as `decision
 * witness-exception` does in a terminal. Once that refusal said "renews it on the Decide card" and the card had no row for it.
 */
function witnessExceptionItems(workflow, context) {
  const at = Date.parse(context.at);
  const renewed = (phaseId, generation, mapping) => [...countedRecords(workflow, workflow?.witnessExceptionRenewals)].reverse()
    .find((entry) => entry?.phase === phaseId && Number(entry.generation) === Number(generation) && entry.mappingSha256 === mapping)?.expiresAt ?? null;
  const items = [];
  for (const phaseId of workflow?.phaseOrder ?? []) {
    const phase = workflow.phases?.[phaseId];
    for (const approval of (phase?.approvals ?? []).filter((entry) => !entry?.invalidatedAt && entry?.decision === 'approved' && Number(entry.generation) === Number(phase.generation))) {
      for (const mapping of approval.witnessMappings ?? []) {
        if (mapping?.decision !== 'exception' || !/^sha256:[a-f0-9]{64}$/u.test(String(mapping.mappingSha256 ?? ''))) continue;
        const expiresAt = renewed(phaseId, approval.generation, mapping.mappingSha256) ?? mapping.expiresAt ?? null;
        if (!(Date.parse(expiresAt ?? '') <= at)) continue;
        const name = stepName(workflow, phaseId);
        const clause = mapping.clauseId ? clauseName(workflow, mapping.clauseId) : 'its criterion';
        const until = String(expiresAt).slice(0, 10);
        items.push({
          kind: 'witness-exception', title: `Renew ${name}'s witness exception for ${clause}`, subject: `witness-exception:${mapping.mappingSha256}`,
          why: `${name}'s approval accepted a test for ${clause} until ${until}, which has passed, so the Story cannot end on it. Only ${name}'s approvers can renew it.`,
          options: [option(workflow, context, { id: 'renew-exception', label: `Renew it until a date`,
            words: `The same test keeps standing in for ${clause}'s evidence until then; nothing runs again and no step goes back.`,
            effects: [{ kind: 'witness-exception-renewal', phase: phaseId, generation: Number(phase.generation), mappingSha256: mapping.mappingSha256, clauseId: mapping.clauseId ?? null }],
            needs: { expires: expiryNeed(context.at, { endOfDay: true }), reason: textNeed('', { minimum: 10, maximum: 1000 }) } })],
          details: { phase: phaseId, clause: mapping.clauseId ?? null, expiresAt, mappingSha256: mapping.mappingSha256,
            commands: [`singularity-flow decision witness-exception ${workflow.workItem.id} --phase ${phaseId} --mapping ${mapping.mappingSha256} --expires <YYYY-MM-DD> --reason "<why the exception still stands>"`] }
        });
      }
    }
  }
  return items;
}

/**
 * Whether SF Guard signs the record an effect writes, by the rule that signs it: on a Story SF Guard requires (counted.mjs
 * presenceRequires), each record of a person family (person-step-catalog.mjs PERSON_STEPS, by the effect it records) that
 * the family counts as a person's (presence/person-steps.mjs signNewPersonRecords). A raised issue is anyone's record, in
 * no family. Signed with the approver's Touch ID, which only their own terminal takes, it is never recorded in chat.
 */
function guardSigns(workflow, effect) {
  return effect?.kind !== 'upstream-issue' && presenceRequires(workflow)
    && PERSON_STEPS.some((row) => row.family && [row.effect].flat().includes(effect?.kind) && row.family.isPerson({ by: 'person', ...effect }));
}

/**
 * Under SF Guard no row offers chat [owner, 2026-11-14]: a row whose chat choice records what SF Guard signs loses every
 * chat command, so no chat asks it as a yes or no or records it, and every host says it is recorded in the person's own
 * terminal (itemAnswer). The card still holds it, and hands it to that terminal.
 */
function underGuard(workflow, item) {
  const chat = (entry) => entry.available !== false && (entry.chat || DECISION_LIST_CHAT_OPTIONS.includes(entry.id));
  if (!item.options.some((entry) => chat(entry) && (entry.effects ?? []).some((effect) => guardSigns(workflow, effect)))) return item;
  return { ...item, guardSigns: true, options: item.options.map(({ chat: _chat, ...entry }) => entry) };
}

/**
 * A "still holds" row's yes and no in a /sf-decide chat [owner, 2026-11-14]: each the row's own revalidate command, at
 * the person's reason, which the answer binding holds to what they typed and to the yes or no they gave. Under SF Guard
 * none (underGuard): the row is signed in the approver's own terminal, and the chat only points there.
 */
function stillHoldsChat(blocker) {
  const form = /--outcome <unchanged\|return> --reason "<why>"/u;
  return (outcome) => (form.test(blocker.command ?? '') ? { chat: { command: blocker.command.replace(form, `--outcome ${outcome} --reason "<REASON>"`) } } : {});
}

/**
 * A step that read an earlier document an amendment changed [UIF-M3, SCS:REQ-022]: its own approvers say
 * it still holds, which binds its approval to the amended generation, or return the Story to it, as a
 * rejection does. A conformance step's approver confirms its report or returns it for a new one. Recorded
 * here with `upstream-issue revalidate`'s own function, and in a /sf-decide chat as a yes or no with that
 * same command (stillHoldsChat), unless SF Guard signs it.
 */
/**
 * D1 [CIC:REQ-021]: why a kept step's approvers are recommended to say it still holds, or to redo it, in one line: its
 * document names neither the changed clauses its prompt held nor any path they expect, or it names one of those paths.
 */
export function stillHoldsBecause(workflow, blocker) {
  const name = stepName(workflow, blocker.phase);
  const clauses = listWords((blocker.clauses ?? []).map((id) => clauseName(workflow, id)));
  return blocker.recommend === 'return'
    ? `${name}'s document names ${listWords(blocker.namedPaths ?? [])}, which ${clauses} ${(blocker.clauses ?? []).length === 1 ? 'expects' : 'expect'}.`
    : `${name}'s document names neither ${clauses} nor any path ${(blocker.clauses ?? []).length === 1 ? 'it expects' : 'they expect'}.`;
}

function revalidationItem(workflow, context, blocker) {
  const name = stepName(workflow, blocker.phase);
  const producer = blocker.producer ? stepName(workflow, blocker.producer) : 'the earlier step';
  if (blocker.reason === 'prompt-held') return stillHoldsItem(workflow, context, blocker, name, producer);
  const report = isConformancePhase(workflow.phases?.[blocker.phase]);
  const effect = (outcome) => [{ kind: 'amendment-revalidation', amendment: blocker.amendment, phase: blocker.phase, outcome }];
  const chat = stillHoldsChat(blocker);
  // Only a step's own approvers answer its row. "Still holds" may be one answer, with one reason, for every row
  // this person approves, worded alike on each host; each row keeps its own record. A return is row by row.
  const shared = (built) => ({ ...built, sharedLabel: 'Still holds', ...chat('unchanged') });
  const own = (built) => ({ ...built, oneByOne: true, ...chat('return') });
  return {
    kind: 'revalidation', title: `Revalidate ${name} after ${blocker.amendment}`,
    why: `${name} read ${producer} before ${blocker.amendment} amended it. ${report
      ? `Its approvers confirm the report still holds under the amended ${producer}, or return it for a new report.`
      : `Its approvers say it still holds under the amended ${producer}, which keeps its approval, or return the Story to it.`}`,
    options: [
      shared(option(workflow, context, { id: 'still-holds', label: report ? 'Confirm the report: it still holds' : `${name} still holds`,
        words: report ? `The report stands as written, read against the amended ${producer}; its approval comes next, as always.`
          : `Its approval stands, bound to the amended ${producer}.`, effects: effect('unchanged'),
        needs: { reason: textNeed(`${name} still holds under ${blocker.amendment}: the amended ${producer} says what it was built and checked against.`, REASON) } })),
      own(option(workflow, context, { id: 'return-step', label: report ? 'Return it for a new report' : `Return the Story to ${name}`,
        words: report ? `${name} is written again against the amended ${producer}.` : `${name} runs again against the amended ${producer}, and the steps after it with it.`,
        effects: effect('return'), needs: { reason: textNeed('', REASON) } }))
    ],
    details: { code: blocker.code, amendment: blocker.amendment, phase: blocker.phase, producer: blocker.producer ?? null, commands: [blocker.command] }
  };
}

/**
 * D1 [CIC:REQ-021]: a step an intent amendment kept (rule E8) whose prompt held a changed clause its document does not
 * cite. Its own approvers say it still holds, or return the Story to it; the item recommends one, says why in one
 * line, and is never settled for them. Until it is answered the approval of each step that reads it waits, and so
 * does the Story's end; nothing else does.
 */
function stillHoldsItem(workflow, context, blocker, name, producer) {
  const clauses = listWords((blocker.clauses ?? []).map((id) => clauseName(workflow, id)));
  const waits = (blocker.consumers ?? []).length ? `the approval of ${listWords(blocker.consumers.map((id) => stepName(workflow, id)))} and the Story's end wait` : 'the Story\'s end waits';
  const effect = (outcome) => [{ kind: 'amendment-revalidation', amendment: blocker.amendment, phase: blocker.phase, outcome }];
  const chat = stillHoldsChat(blocker);
  return {
    kind: 'revalidation', title: `Say whether ${name} still holds after ${blocker.amendment}`,
    why: `${blocker.amendment} kept ${name}'s approval: its document cites none of the changed clauses, but its prompt held ${clauses}. `
      + `Its approvers say it still holds under the amended ${producer}, or return the Story to it; until then ${waits} for it.`,
    options: [
      { ...option(workflow, context, { id: 'still-holds', label: `${name} still holds`, words: `Its approval stands, bound to the amended ${producer}.`, effects: effect('unchanged'),
        needs: { reason: textNeed(`${name} still holds under ${blocker.amendment}: it does not rely on what changed in ${clauses}.`, REASON) } }), sharedLabel: 'Still holds', ...chat('unchanged') },
      { ...option(workflow, context, { id: 'return-step', label: `Redo ${name}: return the Story to it`,
        words: `${name} runs again against the amended ${producer}, and the steps after it with it.`, effects: effect('return'), needs: { reason: textNeed('', REASON) } }), oneByOne: true, ...chat('return') }
    ],
    details: { code: blocker.code, amendment: blocker.amendment, phase: blocker.phase, producer: blocker.producer ?? null, reason: 'prompt-held',
      clauses: blocker.clauses ?? [], recommend: blocker.recommend ?? 'unchanged', ...(blocker.namedPaths?.length ? { namedPaths: blocker.namedPaths } : {}),
      consumers: blocker.consumers ?? [], because: stillHoldsBecause(workflow, blocker), commands: [blocker.command] }
  };
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

/**
 * Why a witness of evidence no step has published cannot be recorded yet (WITNESS_EVIDENCE_UNPUBLISHED), and what gets
 * it a file. A visual sign-off the plan names no file for read "nothing has published  for AC-002" with no way on: it is
 * now given SFlow's own screenshot, taken when a person asks (visual-sign-off-capture.mjs) [owner, 2026-11-18].
 */
function notPublishedYet(workflow, entry) {
  const owners = listWords((entry.owners ?? []).map((id) => stepName(workflow, id)));
  const name = clauseName(workflow, entry.clauseId);
  const capture = entry.capture ?? null;
  if (capture?.status === 'needed') {
    return `It cannot be signed off yet: there is no screenshot for ${name}. Choose "${screenshotLabel(capture)}", bring up ${capture.target ? `the screen (${capture.target})` : 'the screen'} and capture it.`;
  }
  if (capture?.status === 'unavailable') {
    return `It cannot be signed off yet: SFlow cannot take a screenshot for ${name}: ${capture.reason}. Save one as ${capture.file}, then sign it off here.`;
  }
  if (!entry.files?.length) return `It cannot be signed off yet: the plan names no screenshot for ${name}. SFlow takes one once ${owners} publishes; sign it off after that.`;
  return `It cannot be signed off yet: nothing has published ${listWords(entry.files)} for ${name}. ${owners} publishes it with its delivery; sign it off after that.`;
}

const screenshotLabel = (capture) => (capture?.failed ? 'Take the screenshot again' : 'Take the screenshot');

/**
 * The step a visual sign-off with no file offers first [owner, 2026-11-18: "SFlow should take a screenshot and ask for
 * approval"]: SFlow builds what the step published and opens it in its own browser, where the person brings up the
 * screen the criterion is about and captures it (`decision screenshot`, the card's button runs `command`). It waits
 * for the person, so it runs only when they ask (`onRequest`), never as a card's check. Null when there is nothing to take.
 */
function screenshotCheck(workflow, entry) {
  const capture = entry?.capture;
  if (capture?.status !== 'needed' || entry.available !== false) return null;
  const owners = listWords((entry.owners ?? []).map((id) => stepName(workflow, id)));
  const { width, height } = capture.viewport ?? {};
  const name = clauseName(workflow, entry.clauseId);
  // Every size the criterion names, from the one screen the person brings up [owner, 2026-11-18].
  const sizes = (capture.viewports ?? []).map((size) => `${size.width}×${size.height}`).join(' and ');
  const sized = capture.viewports?.length > 1 ? ` SFlow captures that screen at ${sizes}, side by side in one screenshot.` : '';
  const opens = `SFlow builds what ${owners} published (${capture.build.words}) and opens it at ${width}×${height}. Bring up the screen${capture.target ? ` (${capture.target})` : ''} and click "Capture this screen for ${name}".`;
  return { kind: 'screenshot', status: capture.failed ? 'failed' : 'unknown', onRequest: true, criterion: entry.clauseId, slot: entry.slot,
    label: screenshotLabel(capture), command: capture.command,
    does: `${opens}${sized}`,
    ...(capture.failed ? { failed: `The last screenshot failed: ${capture.failed}` } : {}) };
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
  // A Story that states no clause: nothing can carry the statement, so included and existing are never offered [owner, 2026-11-23].
  const noClauses = Array.isArray(entry.clauses) && entry.clauses.length === 0;
  return {
    kind: 'owed-decision', title: `Decide scope item ${entry.id}`,
    why: `${entry.text ? `"${entry.text}" ` : ''}${noClauses ? 'needs a disposition from an approver of a step that defines the scope; this Story states no clause to link it to.'
      : 'needs a link or a disposition from an approver of a step that defines the scope.'}`,
    options: SCOPE_CHOICES.filter(([, , linked]) => !(noClauses && linked)).map(([disposition, label, linked]) => ({ ...option(workflow, context, { id: `scope-${disposition}`, label,
      words: disposition === 'included' ? 'Name the clause of this Story that states it, such as the acceptance criterion that covers it.'
        : disposition === 'existing' ? 'Only for behaviour the product had before this Story; name the clauses that verify it.'
          : 'The statement stays in the inventory with your reason.',
      effects: [{ kind: 'scope-disposition', item: entry.id, disposition, groups: entry.groups }],
      needs: { ...(linked ? { clause: { known: entry.clauses ?? [] } } : {}), reason: textNeed('', REASON) } }),
    chat: { command: `singularity-flow decision scope ${workId} --fetch --item ${entry.id} --as ${disposition}${linked ? ' --clause <CLAUSES>' : ''} --reason "<REASON>"` } })),
    details: { scopeItem: entry.id, ...(entry.text ? { statement: entry.text } : {}), ...(entry.source ? { source: entry.source } : {}) }, subject: `scope:${entry.id}`
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
    details: { responsibility: entry.responsibility, authority: entry.authority, declaredReason: entry.declaredReason ?? null }, subject: `responsibility:${entry.responsibility}`
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
  const check = witness ? screenshotCheck(workflow, entry) : null;
  // SFlow cannot take the screenshot: the person's own dated risk is a way through beside their own screenshot.
  const risk = notYet && entry.capture?.status === 'unavailable' && entry.capture.riskCommand ? [{ id: 'accept-risk', label: 'Accept it as a dated risk, in your terminal',
    command: entry.capture.riskCommand, words: 'You record a dated risk in your own terminal; the criterion stays unproven until that date.' }]
    // The screenshot shows another screen: the person captures the right one again before signing it off.
    : !notYet && entry.capture?.status === 'taken' && entry.capture.again ? [{ id: 'capture', label: 'Take the screenshot again, of the screen it is about',
      command: entry.capture.again, words: 'SFlow opens what was published again; you bring up the screen and capture it, replacing this screenshot.' }] : [];
  // A Story that adopted application review: its live review is the other way to satisfy it [owner, 2026-11-18].
  const appReview = notYet && entry.capture?.appReview ? [{ id: 'review', label: 'Or accept it in the application review',
    command: entry.capture.appReview.command,
    words: `Accepting its visual dimension in the live review satisfies ${clauseName(workflow, entry.clauseId)}: ${entry.capture.appReview.copilot} in Copilot, ${entry.capture.appReview.vscode} in VS Code, or this command in your terminal.` }] : [];
  const item = stepItem(workflow, context, {
    kind: 'owed-decision', title: witness ? `Sign off ${clauseName(workflow, entry.clauseId)} (${entry.method})` : `Decide scope item ${entry.id}`,
    why: witness ? witnessWhy(workflow, entry)
      : `${entry.text ? `"${entry.text}" ` : ''}needs a link or a disposition from an approver of a step that defines the scope.`,
    groups: entry.groups ?? (witness ? [...new Set(entry.owners.flatMap((id) => approvers(workflow, id)))] : []),
    options: [{ id: witness ? 'witness' : 'disposition', label: notYet ? (entry.capture?.status === 'needed' ? 'Sign it off once SFlow has taken its screenshot'
      : entry.capture?.status === 'unavailable' ? `Sign it off once ${entry.capture.file} is saved` : 'Sign it off once it is published')
      : witness ? 'Sign it off after looking at it' : 'Include it, or say it exists, naming its clauses',
      // What its command would refuse names no command: a real chat printed it, under "Copilot: no verified equivalent".
      command: notYet ? null : entry.command ?? `singularity-flow evidence matrix ${workflow.workItem.id} --json`, words: notYet ? notPublishedYet(workflow, entry) : 'Only a person records it; an agent never answers it.',
      ...(notYet ? { available: false } : witness ? { humanReview: { kind: 'witness', clauseId: entry.clauseId, clauseText: entry.clauseText, slot: entry.slot, method: entry.method,
        files: entry.files, owners: entry.owners, contextBinding: entry.contextBinding } } : {}) },
    ...(entry.otherCommand ? [{ id: 'other-disposition', label: 'Exclude, defer or set it aside, with a reason', command: entry.otherCommand,
      words: 'Only a person records it; an agent never answers it.' }] : []),
    // No screenshot yet: the person's own check is a way through, beside the screenshot (owner, 2026-11-22).
    ...(notYet && canAttest(workflow, entry) ? [{ id: 'witness-self', label: 'Sign it off without a screenshot: I checked it myself',
      command: `singularity-flow decision witness ${workflow.workItem.id} --criterion ${entry.clauseId} --slot ${entry.slot} --attest --confirm states-the-outcome --confirm matches-the-criterion --confirm current-for-this-change --reason "<what you checked>"`,
      words: 'You checked it yourself and say what you checked; your sign-off is its evidence, with no screenshot.',
      humanReview: { kind: 'witness', attest: true, clauseId: entry.clauseId, clauseText: entry.clauseText, slot: entry.slot, method: entry.method,
        files: [], owners: entry.owners, contextBinding: entry.contextBinding } }] : []),
    ...risk, ...appReview],
    // Whose delivery publishes its evidence and what it is: a sign-off nobody can give yet says when it can [owner, 2026-11-16].
    details: witness ? { clause: entry.clauseId, slot: entry.slot, contextBinding: entry.contextBinding, owners: entry.owners ?? [], files: entry.files ?? [], method: entry.method ?? null,
      ...(entry.capture ? { capture: { status: entry.capture.status, file: entry.capture.file, ...(entry.capture.reason ? { reason: entry.capture.reason } : {}),
        ...(entry.capture.build ? { build: entry.capture.build.words } : {}), ...(entry.capture.failed ? { failed: entry.capture.failed } : {}) } } : {}) }
      : { scopeItem: entry.id, ...(entry.text ? { statement: entry.text } : {}) }
  });
  // The steps that answer for a sign-off: with owner-step checks, the approval of each is refused until it is given.
  return witness ? { ...(check ? { check } : {}), ...item, owners: entry.owners ?? [], subject: `sign-off:${entry.clauseId}` } : { ...item, subject: `scope:${entry.id}` };
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
  if (clearedBy.plan || clearedBy.planRoute || /^singularity-flow decision plan /u.test(hold.action?.command ?? '')) {
    const typed = /^singularity-flow decision plan /u.test(hold.action?.command ?? '');
    return stepDecidedBy(workflow, context, planAuthorities(workflow), clearedBy.plan || !typed ? words : 'Choose the row it belongs to and give your reason, then run it.');
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

/** The class of person's question a file departure is, by its files: the first named class, else what the product does. */
function departurePersonClass(paths) {
  const named = paths.map(personClass).find(Boolean);
  return named ?? { class: 'behaviour', words: 'It can change what the product does, so a person decides it.' };
}

// A sentence said before an item's own why, which stays as it is.
const prefixed = (lead, text) => (lead ? `${lead} ${text}` : text);
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
  // A row that only checks tests takes no file that is not a test: accepting there would be refused, so it is never
  // offered; the named rows that can take the files are, and the words say which was left out and why [owner, 2026-11-19].
  const fit = departure.kind === 'path' ? clausesTakingPaths(departure.clauses, facts.planRows ?? [], departure.paths ?? []) : { takes: [], testOnly: [], noRow: [] };
  const many = (departure.paths ?? []).length !== 1;
  const them = many ? 'them' : 'it';
  const said = { name: (id) => clauseName(workflow, id), subject: many ? 'these files' : 'this file', plural: many };
  const leftOut = leftOutWords(fit, said);
  const also = leftOut ? ` ${leftOut}` : '';
  let noRow = '';
  if (departure.kind === 'path' && fit.takes.length) {
    const changes = departure.paths.flatMap((file) => fit.takes.map((clauseId) => ({ kind: 'add-location', clauseId, path: file })));
    accepts = [{ ...accept({ label: 'Accept', words: `${files} becomes part of ${listWords(fit.takes.map((id) => clauseName(workflow, id)))}'s delivery: a plan amendment names it, and no step is reset.${also}`, changes, writes: 'plan-amendment' }),
      chat: { command: decide('accepted') } }];
  } else if (departure.kind === 'path') {
    accepts = (facts.planRows ?? []).filter((row) => rowTakesPaths(row, departure.paths)).slice(0, 40).map((row) => ({ ...accept({
      id: `accept-${rowSlug(row.clauseId)}`.slice(0, 64), label: `Accept under ${clauseName(workflow, row.clauseId)}${row.result ? `: ${row.result}` : ''}`,
      words: `${files} becomes part of ${clauseName(workflow, row.clauseId)}'s delivery: a plan amendment names it, and no step is reset.${also}`,
      changes: departure.paths.map((file) => ({ kind: 'add-location', clauseId: row.clauseId, path: file })), writes: 'plan-amendment' }),
    chat: { command: decide('accepted', ` --clause ${row.clauseId}`) } }));
    if (!accepts.length) {
      // No row can take them: said plainly, with what is left, and never a choice that would be refused.
      noRow = leftOut ? `${leftOutWords(fit, { ...said, mode: 'cannot' })} No other row of the plan can take ${them}.`
        : (facts.planRows ?? []).length ? `Every row of the plan only checks tests, so no row can take ${files}.` : `The plan has no row to add ${files} to.`;
      const words = `${noRow} Reject it, and the model restores ${them}; or change the scope first (/sf-amend), which its approvers decide.`;
      accepts = [{ ...accept({ label: 'Accept', words, writes: 'plan-amendment' }), available: false, recordable: false, does: words }];
    }
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
    // Submitted: its approvers return it first, by the filled command, never one the person composes [owner, 2026-11-19].
    const submitted = !open && workflow.phases?.[departure.phase]?.status === 'awaiting_approval';
    const back = returnRoute(workflow, workflow.phases?.[departure.phase] ?? { id: departure.phase }).command;
    accepts = [{ ...accept({ label: 'Accept', words: `${target}'s approved document takes this wording as its next version, amended by ${departure.id}; each later step that read it is checked again.`, writes: 'forward-amendment' }),
      ...(open ? { chat: { command: decide('accepted') } } : { available: false,
        words: `${target}'s wording is amended while ${name} is open. ${name} awaits approval now: ${submitted ? `return it for changes (${back}), then decide this.` : 'return it for changes (/sf-reject), then decide this.'}` }) },
    ...(submitted ? [{ ...personalStep({ id: 'return', label: `Return ${name} for changes, then accept this`, command: back,
      words: `${name} is submitted, so the wording is amended once its approvers return it; then ${departure.id} is decided here.`,
      does: `Returns ${name} to its author: ${reopenWords(workflow, departure.phase)}; then ${departure.id} can be accepted.` }),
    decidedBy: decidedBy(workflow, [{ kind: 'upstream-issue-decision', issuePhase: departure.phase }], context) }] : [])];
  } else if (['plan-row', 'test'].includes(departure.kind) && rowChangeMissing(departure.change).length) {
    // Recorded without its value [office laptop, 2026-11-19]: the person chooses it here. What a row becomes is a choice
    // among the kinds, the one the departure's reason names first; anything else its author records again, or it is rejected.
    const missing = rowChangeMissing(departure.change);
    const row = clauseName(workflow, departure.change?.clauseId);
    if (missing.every((key) => key === 'fulfillment')) {
      const named = ROW_FULFILLMENTS.find((kind) => new RegExp(`\\b${kind}\\b`, 'iu').test(String(departure.reason ?? '')));
      accepts = [...(named ? [named] : []), ...ROW_FULFILLMENTS.filter((kind) => kind !== named)].map((kind) => ({ ...accept({ id: `accept-${kind}`,
        label: `Accept: ${row} becomes ${kind}`, words: `The plan changes exactly so: ${departure.change?.clauseId} becomes ${kind}. A plan row correction records it with your reason; no step is reset.`,
        writes: 'plan-row-correction' }), ...(kind === named ? { recommended: true } : {}), effects: [effect('accept', { writes: 'plan-row-correction', fulfillment: kind })],
      oneByOne: true, chat: { command: decide('accepted', ` --fulfillment ${kind}`) },
      terminal: `singularity-flow decision plan ${workId} --fetch --set-fulfillment ${departure.change?.clauseId}=${kind} --reason "<REASON>"` }));
    } else {
      const words = `${departure.id} does not say its ${missing.join(' and ')}, so the change cannot be made as recorded. ${name}'s agent records it again with that named, or reject it.`;
      accepts = [{ ...accept({ label: 'Accept', words, writes: 'plan-row-correction' }), available: false, recordable: false, does: words }];
    }
  } else if (['plan-row', 'test'].includes(departure.kind)) {
    // A plan row or test change is kept here, on the card or in /sf-decide, with the exact rows shown, by an approver of
    // the plan; it records the plan row correction it names [owner, 2026-11-19]. A person's own terminal still works.
    const change = rowChangeWords(departure.change);
    accepts = [{ ...accept({ label: 'Accept', words: `The plan changes exactly so: ${change}. A plan row correction records it with your reason; nothing else in the plan changes, and no step is reset.`,
      writes: 'plan-row-correction' }), oneByOne: true, chat: { command: decide('accepted') },
    ...(facts.acceptance?.[departure.id] ? { terminal: facts.acceptance[departure.id] } : {}) }];
  } else {
    const own = facts.acceptance?.[departure.id];
    accepts = [{ ...personalStep({ id: 'accept', label: `Accept: change ${listWords(departure.clauses ?? [])}`,
      command: own, words: `An intent amendment changes the approved clauses; the scope's approvers decide it in their own terminal, and the steps that cite them reopen${facts.reopens?.[departure.id]?.length ? `: ${listWords(facts.reopens[departure.id].map((id) => stepName(workflow, id)))}` : ''}.`,
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
  // Why a person decides it and SFlow does not, by its class [owner, 2026-11-19, C3]: a dependency, how the product is built,
  // shipped or tested, who governs the repository, or what the product does.
  const person = ['path', 'supporting'].includes(departure.kind) ? departurePersonClass(departure.paths ?? []) : null;
  const completion = (text) => (noApproval(workflow, departure.phase) ? text.replace('; its approval waits for this decision.', '; nobody approves it, so its submission waits for this decision.') : text);
  const asked = (workflow.askedFor ?? []).filter((entry) => entry.phase === departure.phase
    && (workflow.instructionAccounts ?? []).findLast((account) => account.phase === entry.phase && Number(account.instruction) === Number(entry.instruction))?.departure === departure.id)
    .map((entry) => `(${entry.instruction}) "${String(entry.text ?? '').replace(/\s+/gu, ' ').trim()}"`);
  return {
    // A changed file the plan does not name is asked the way it was before publishing: one question for one file.
    kind: 'departure', title: (departure.kind === 'path' && departure.paths?.length
      ? `Say where ${files} ${departure.paths.length === 1 ? 'belongs' : 'belong'} (${departure.id})` : `${departure.id}: ${words}`).slice(0, 200),
    ...(departure.kind === 'path' && departure.paths?.length === 1 ? { subject: `file:${departure.paths[0]}` } : {}),
    // No row can take the files: said first, so a form that keeps only the opening sentence says why there is no Accept.
    // Why a person decides it comes first, after a missing row; a step nobody approves waits at its submission [C3, Q6].
    why: completion(prefixed(noRow, prefixed(person?.words, `${fixes.length ? `It fixes ${listWords(fixes)} from the findings register. ` : ''}${departure.recordedBy === 'sflow' ? 'SFlow recorded it at prepublish' : 'The model recorded it'}: ${departure.reason}${reopened}${tests}${asked.length ? ` Asked for: ${asked.join('; ')}.` : ''} ${name} goes ahead with it; its approval waits for this decision.${one ? ' It is decided on its own, with its own reason.' : ''}`))),
    options: [...accepts, reject],
    details: { departure: departure.id, departureKind: departure.kind, status, ...(person ? { personClass: person.class } : {}), ...(departure.paths?.length === 1 ? { path: departure.paths[0] } : { paths: departure.paths }),
      clauses: departure.clauses ?? [], ...(leftOut ? { leftOut: { clauses: [...fit.testOnly, ...fit.noRow], words: leftOut } } : {}), acceptAll: !one, ...(departure.findings?.length ? { findings: departure.findings } : {}), ...(departure.target ? { target: departure.target } : {}), ...(departure.diff ? { diff: departure.diff.slice(0, 4000) } : {}),
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
const foundWords = (text) => (text ? `Convergence found that ${String(text).replace(/\.?$/u, '.')}` : '');

/**
 * One row per problem: a test setup is one change; a fact and the assisted proposals that cite it, or name its clauses and difference, are one.
 * `decided` rows are what is already answered, one row only while its items carry the same answer: changing a row changes each of them alike.
 */
function convergenceRows(list, { decided = false } = {}) {
  const chosen = list.items.filter((item) => Boolean(item.decision) === decided);
  const rows = new Map();
  const rowOf = new Map();
  const difference = (item) => item.classification ?? CONVERGENCE_DIFFERENCE[item.kind] ?? item.kind;
  const answer = (item) => (decided ? `\u0000${item.decision.disposition}\u0000${String(item.decision.reason ?? '').trim()}\u0000${[...(item.decision.clauseIds ?? [])]
    .map((id) => id.toUpperCase()).sort().join(',')}` : '');
  for (const item of chosen) {
    const cited = (item.factIds ?? []).map((id) => rowOf.get(id)).find(Boolean);
    const problem = cited ?? (item.group ? `group:${item.group}` : item.clauseIds.length
      ? `clause:${[...item.clauseIds].map((id) => id.toUpperCase()).sort().join(',')}:${difference(item)}` : `item:${item.id}`);
    const key = `${problem}${answer(item)}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(item);
    rowOf.set(item.id, problem);
  }
  return [...rows.values()];
}

// The plan's own words end a sentence of their own: never two full stops.
const planSays = (plan) => `The plan says: ${plan.kind === 'amendment' ? `${plan.id ?? 'an amendment'}${plan.clause ? ` under ${plan.clause}` : ''}` : 'a supporting file'}${
  plan.text ? `, ${String(plan.text).replace(/\.+$/u, '')}` : ''}${plan.askedBecause ? `; still asked: ${String(plan.askedBecause).replace(/\.+$/u, '')}` : ''}.`;

/** What one row is about, in the words its title and why use: the same for a question and for an answer given. */
function convergenceSubject(workflow, members) {
  const ids = members.map((item) => item.id);
  const paths = [...new Set(members.flatMap((item) => item.paths))];
  const clauses = [...new Set(members.flatMap((item) => item.clauseIds))];
  const group = members.find((item) => item.group)?.group ?? null;
  const subject = group ? `Test setup ${listWords(paths)}` : clauses.length ? listWords(clauses.map((id) => clauseName(workflow, id))) : paths.length ? listWords(paths) : 'Convergence';
  const words = [...new Set(members.map((item) => CONVERGENCE_WORDS[item.classification ?? item.kind] ?? item.kind))];
  const plan = members.map((item) => item.plan).find(Boolean) ?? null;
  const found = members.map((item) => (item.classification ? `The assisted pass proposed: "${String(item.text ?? '').slice(0, 400)}"` : foundWords(item.detail)));
  // Only what the kernel found itself may be sent back unexplained: an assisted proposal's rework states its reason.
  const deterministic = members.every((item) => !item.classification);
  return { ids, paths, clauses, group, plan, found, deterministic, title: `${subject}: ${listWords(words)} (${ids[0]}${ids.length > 1 ? ` and ${ids.length - 1} more` : ''})` };
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
    const { ids, paths, clauses, group, plan, found, deterministic, title } = convergenceSubject(workflow, members);
    const named = issues.filter((state) => clauses.some((clause) => issueNamesClause(state.issue.about, clause)));
    const why = [
      ...found,
      ...(group ? [list.groupWords?.[group] ?? ''] : []),
      ...(plan ? [planSays(plan)] : []),
      ...named.map((state) => `${state.issue.id}, a problem reported against ${stepName(workflow, state.issue.phase)}, names it too; its approvers decide that issue.`),
      ...(ids.length > 1 ? [`One answer records each of ${listWords(ids)} by name.`] : []),
      `${stepName(workflow, phase)}'s approvers decide it; the report is generated again once every item is decided.`
    ].filter(Boolean).join(' ');
    // Rework on what the kernel found itself may go unexplained; any other answer, or one on a proposal, states its reason.
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
      title: title.slice(0, 200),
      why, options,
      details: { convergence: ids, phase, itemKinds: [...new Set(members.map((item) => item.classification ?? item.kind))], clauses,
        ...(paths.length === 1 ? { path: paths[0] } : paths.length ? { paths } : {}), ...(plan ? { plan } : {}),
        ...(named.length ? { issues: named.map((state) => state.issue.id) } : {}),
        commands: [`singularity-flow story adjudicate --work-id ${workId}`] }
    };
  });
}

/**
 * Each answer already given at an open convergence step, offered beside the list so its approvers may choose again
 * [SCS:REQ-034]: one row per problem whose items carry the same answer. It holds nothing and is never counted. A change
 * is the same `story adjudicate --answers` write bound to the table's digest, always with a reason, and the record
 * keeps the answer it replaces and whose it was.
 *
 * Each changed file the approved plan settled is offered too, one row each, as the Adjudicate page shows it
 * [SCS:REQ-035]: nobody is asked about it unless they disagree, and an answer on it overrules the plan through the
 * same write. Once overruled, it reads as any answer given.
 */
function convergenceAnswerItems(workflow, context, list) {
  // Only while the step is open: once its generation is published, `story adjudicate` changes nothing.
  if (list.status !== 'open' || workflow.currentPhase !== list.phase || workflow.phases?.[list.phase]?.status !== 'in_progress') return [];
  const workId = workflow.workItem.id;
  const label = (id) => (list.dispositions ?? []).find((entry) => entry.id === id)?.label ?? id;
  // The person's reason as they typed it, quoted: never run into the sentence around it.
  const given = (answer) => `${label(answer.disposition)}${answer.actor ? `, by ${answer.actor}` : ''}${answer.at ? ` on ${String(answer.at).slice(0, 10)}` : ''}${
    String(answer.reason ?? '').trim() ? ` ("${String(answer.reason).trim()}")` : ', with no reason given'}`;
  const until = (verb) => `Nothing waits on it: ${stepName(workflow, list.phase)}'s approvers may ${verb} it until the step is published.`;
  const row = ({ ids, paths, clauses, plan, found, deterministic, title }, current, settledBy = null) => {
    const changes = current?.disposition === 'update-intent' && current.clauseIds?.length ? ` Clauses to change: ${listWords(current.clauseIds.map((id) => clauseName(workflow, id)))}.` : '';
    // The latest first: each answer replaced the one after it.
    const earlier = [...(current?.replaced ?? [])].reverse();
    const why = [
      ...(current ? [`Decided: ${given(current)}.${changes}`] : []),
      ...(earlier.length ? [`Earlier: ${earlier.map(given).join('; before that, ')}.`] : []),
      ...found,
      ...(plan ? [planSays(plan)] : []),
      ...(settledBy && current ? ['This answer overrules what the plan settled.'] : []),
      ...(ids.length > 1 ? [`A change records each of ${listWords(ids)} by name.`] : []),
      current ? `Choosing again records your answer and reason in its place; the record keeps this one and whose it was. ${until('change')}`
        : `The approved plan accounts for it, so nobody is asked about it unless they disagree. If you do, choose what it should be instead, with your reason. ${until('answer')}`
    ].filter(Boolean).join(' ');
    const options = (list.dispositions ?? []).map(({ id, label: words }) => ({ ...option(workflow, context, { id, label: words, words: DISPOSITION_EFFECT[id] ?? words,
      effects: [{ kind: 'convergence-adjudication', phase: list.phase, items: ids, disposition: id, expect: list.digest,
        ...(current ? { replaces: { disposition: current.disposition, actor: current.actor ?? null } } : {}) }],
      needs: { ...(id === 'update-intent' ? { clause: { known: [...new Set([...clauses, ...(list.clauses ?? [])])], words: 'The clauses the specification should change', label: 'Clauses to change' } } : {}),
        // Sending back to fix may go unexplained, as on the Adjudicate page (owner, 2026-11-09); any other change, or word
        // against the plan, says why. The kernel lets only what it found itself, or the plan settled, go unexplained.
        reason: textNeed('', id === 'rework' && deterministic ? { ...ADJUDICATION_REASON, minimum: 0 } : ADJUDICATION_REASON) } }),
    // An answer someone gave, or what the plan settled, is changed on its own row with its own reason: never by one answer for all.
    oneByOne: true }));
    return {
      kind: current ? 'convergence-answer' : 'convergence-settled',
      // What it is, then the answer it has: a choice reads after it as "…, answered Decide later: Accept as is".
      title: current ? `${title.slice(0, 170)}, answered ${label(current.disposition)}` : title.slice(0, 200),
      why, options,
      details: { convergence: ids, phase: list.phase, clauses,
        ...(current ? { answer: { disposition: current.disposition, reason: current.reason ?? null, clauseIds: current.clauseIds ?? [], actor: current.actor ?? null, at: current.at ?? null },
          replaced: current.replaced ?? [] } : {}),
        ...(settledBy ? { settledBy } : {}),
        ...(paths.length === 1 ? { path: paths[0] } : paths.length ? { paths } : {}), ...(plan && !settledBy ? { plan } : {}),
        commands: [`singularity-flow story adjudicate --work-id ${workId}`] }
    };
  };
  const settled = (list.settled ?? []).map((entry) => {
    const paths = entry.paths ?? [];
    // A settled path is one the kernel found changed: rework on it may go unexplained.
    const subject = { ids: [entry.id], paths, clauses: entry.clauseIds ?? [], plan: entry.settledBy, found: [], deterministic: true, title: `${listWords(paths) || entry.id}: settled by the plan (${entry.id})` };
    return row(subject, entry.decision, entry.settledBy ?? {});
  });
  return [...convergenceRows(list, { decided: true }).map((members) => row(convergenceSubject(workflow, members), members[0].decision)), ...settled];
}

/** The answers one convergence choice records, one per item it names. */
export function adjudicationAnswersOf(step) {
  const [effect] = step.effects;
  return effect.items.map((itemId) => ({ itemId, disposition: effect.disposition, reason: step.values.reason ?? '',
    clauseIds: effect.disposition === 'update-intent' ? step.values.clause ?? [] : [] }));
}

/** Whether nobody approves the step: its submission completes it, so what waits for an approval waits for that instead. */
const noApproval = (workflow, phaseId) => workflow.phases?.[phaseId]?.approvalPolicy?.mode === 'none';

/**
 * One instruction the person typed in a code step that is not accounted for yet [SCS:REQ-042, REQ-044], quoted as
 * typed: data, never an instruction to anyone reading the list. Its author accounts for it in /sf-code, within the
 * plan or as a departure, and only the step's approval waits for it. Words SFlow cannot tell are a request (asked-for.mjs
 * typedKind `unsure`) are also the person's to call a note, with one click [owner, 2026-11-18].
 */
function askedForItem(workflow, context, entry, facts) {
  const workId = workflow.workItem.id;
  const name = stepName(workflow, facts.phase);
  const account = `singularity-flow departure account --work-id ${workId} --instruction ${entry.instruction} --clauses <CLAUSES>`;
  // A plain chat's prompt keeps its mark however long its words: they are cut to fit the title instead [PCR:REQ-002].
  const where = entry.plainChat ? ' (plain chat)' : '';
  const typed = String(entry.text ?? '').replace(/\s+/gu, ' ').trim();
  const quoted = `"${where && typed.length > 140 ? `${typed.slice(0, 139)}…` : typed}"`;
  // "That was not a request": the person's own words, kept as a note; nothing changes and nothing waits for them.
  const note = entry.typed === 'unsure' ? [option(workflow, context, { id: 'not-a-request', label: 'That was not a request',
    words: 'Keeps the words as a note: nothing changes for them, and nothing waits for them.',
    effects: [{ kind: 'asked-for-note', phase: facts.phase, instruction: entry.instruction }], needs: {} })] : [];
  const item = (option, routeSkill) => ({
    kind: 'asked-for', title: `Asked for (${entry.instruction}) ${quoted}${where}: not handled yet`.slice(0, 200),
    // What it holds, in the step's own terms: a step nobody approves completes at its submission, which waits instead (daily run, 2026-11-17).
    why: `You typed it in ${name} version ${entry.generation}${entry.plainChat ? ' (a plain chat that changed the work)' : ''}. ${name}'s ${noApproval(workflow, facts.phase) ? 'submission' : 'approval'} waits until its agent says how it handles it.`,
    options: [option, ...note],
    details: { phase: facts.phase, instruction: entry.instruction, generation: Number(entry.generation), text: entry.text, ...(entry.plainChat ? { plainChat: true } : {}),
      ...(note.length ? { typed: 'unsure' } : {}), commands: [...new Set([option.action.command, account])] },
    routeSkill
  });
  // A step in progress accounts for it, written or published, which `departure account` refuses otherwise: a submitted
  // step comes back to its author from its approvers first.
  if (workflow.phases?.[facts.phase]?.status === 'awaiting_approval') {
    const words = `${name} is submitted, so its approvers return it first; then its agent says how it handles it in /sf-code: in the plan, as a change from it, or as a question.`;
    return item({ ...personalStep({ id: 'return', label: `Return it to ${name} to handle it`,
      command: `singularity-flow reject ${facts.phase} --work-id ${workId} --to ${facts.phase} --reason <reason>`, words,
      does: `Returns ${name} to its author: ${reopenWords(workflow, facts.phase)}; its author handles it there.` }),
    decidedBy: decidedBy(workflow, [{ kind: 'upstream-issue-decision', issuePhase: facts.phase }], context) }, '/sf-reject');
  }
  // In progress: its author accounts for it here; else the next version, which opens only on the person's yes [D3, OSA:REQ-030],
  // by the route the facts name (its preview).
  const words = `${name}'s agent says how it handles it in /sf-code${facts.open ? '' : ', in a new version that opens only if you say yes'}: in the plan, as a change from it, or as a question.`;
  return item(personalStep({ id: 'account', label: `${name}'s agent handles it in /sf-code`, command: facts.open ? account : facts.route?.command ?? `singularity-flow phase rollover ${facts.phase} --json`, words,
    decidedBy: { groups: [], labels: [], allowed: false, author: true, words } }), '/sf-code');
}

/**
 * No row of the plan can take these files and none is a supporting change: said plainly, with what is left, and never a
 * choice that would be refused [owner, 2026-11-19]. Adding is shown as not available with why; keeping them out of this
 * Story is whoever works in the checkout's own step, and changing the scope is /sf-amend's.
 */
function noPlanRowChoices(workflow, context, hold, files) {
  const them = files.length === 1 ? 'it' : 'them';
  const lead = `No row of the plan can take ${listWords(files)}${(hold.planRows ?? []).length ? ': every row only checks tests' : ''}.`;
  const words = `${lead} ${hold.keepOut ? `Keep ${them} out of this Story (${hold.keepOut}), or change` : 'Change'} the scope first (/sf-amend), which its approvers decide.`;
  const add = { ...option(workflow, context, { id: 'add-to-row', label: 'Add to a row of the plan', words, effects: [{ kind: 'plan-amendment', changes: [] }], needs: {} }),
    available: false, recordable: false, does: words };
  const keepOut = hold.keepOut ? personalStep({ id: 'keep-out', label: `Keep ${them} out of this Story`, command: hold.keepOut,
    words: `Shows how to take ${listWords(files)} out of this Story into a private copy; nothing is deleted.`,
    decidedBy: anyone('These changes are in this checkout, so they are for whoever works in it, not for an approval group.') }) : null;
  return { lead, options: [add, ...(keepOut ? [keepOut] : [])] };
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
    const rows = (hold.planRows ?? []).filter((row) => rowTakesPaths(row, [file]));
    const supporting = classifySupportingChange(file).class ?? null;
    const flag = (entry) => `singularity-flow decision plan ${workId} --fetch ${entry} --reason "<REASON>"`;
    const none = !rows.length && !supporting ? noPlanRowChoices(workflow, context, hold, [file]) : null;
    return {
      kind: 'plan-accounting', title: `Say where ${file} belongs`, subject: `file:${file}`,
      why: prefixed(none?.lead, `${file} changed and no row of the plan names it, so ${hold.waits ?? 'approval waits'}. Add it to the row it serves${supporting ? `, or list it as a supporting change (${supporting})` : ''}: the code and its tests stay as they are, and no step is reset.${hold.keepOut ? ` If it is not part of this Story, keep it out instead: ${hold.keepOut} shows the private-copy route.` : ''}`),
      options: none ? none.options : [
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
  const rows = (hold.planRows ?? []).filter((row) => rowTakesPaths(row, located));
  const rowOption = (row) => {
    const changes = [...listed, ...located.map((file) => ({ kind: 'add-location', clauseId: row.clauseId, path: file }))];
    return { ...option(workflow, context, {
      id: `setup-row-${String(row.clauseId).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`.slice(0, 64),
      label: `${listWords(located)} under ${clauseName(workflow, row.clauseId)}${row.result ? `: ${row.result}` : ''}${listed.length ? ', the rest as supporting changes' : ''}`,
      words: `${listWords(located)} ${located.length === 1 ? 'becomes' : 'become'} part of ${clauseName(workflow, row.clauseId)}'s delivery${listed.length ? `, and ${listWords(supporting)} ${supporting.length === 1 ? 'is' : 'are'} listed as supporting with your reason` : ''}.`,
      effects: [{ kind: 'plan-amendment', changes }], needs: reasonNeed }), chat: { command: line(changes) } };
  };
  const none = located.length && !rows.length ? noPlanRowChoices(workflow, context, hold, located) : null;
  return {
    kind: 'plan-accounting', title: `Say where this test setup belongs: ${listWords(files)}`,
    why: prefixed(none?.lead, `${listWords(files)} changed together for how tests run, and no row of the plan names them, so approval waits. They are one change, so you decide once, and each is recorded by name: the code and its tests stay as they are, and no step is reset.`),
    options: none ? none.options : located.length ? rows.map(rowOption) : [{ ...option(workflow, context, {
      id: 'supporting', label: 'List them as supporting changes',
      words: 'They stay out of every requirement, each listed with your reason.',
      effects: [{ kind: 'plan-amendment', changes: listed }], needs: reasonNeed }), chat: { command: line(listed) } }],
    details: { paths: files, commands: [line([...listed, ...located.map((file) => ({ kind: 'add-location', clauseId: '<clause>', path: file }))])] }
  };
}

const SETTLED_SHOWN = 20;

// How a group of settled files reads in one line [owner, 2026-11-19, C3].
const SETTLED_GROUP_WORDS = Object.freeze({ 'test-support': ['test-support file', 'listed as supporting changes'], documentation: ['documentation file', 'listed as supporting changes'],
  'repository-metadata': ['ignore file', 'listed as supporting changes'], row: ['file', 'added to the row of the file beside it'],
  'out-of-plan': ['file', 'changed outside the plan, taken up with the step'] });

/**
 * One file taken up because it changed outside the plan, as the code approval lists it [WCB:REQ-014]: who changed it, and
 * for Copilot the reason it wrote in the step's document.
 */
export function outsidePlanWords(entry) {
  // A supporting change (a scratch note, a test helper) is committed as one; Copilot owes no reason for it [owner, 2026-11-28].
  if (entry.supporting) {
    return entry.writer === 'copilot' ? `${entry.file}: by Copilot${entry.reason ? `: ${entry.reason}` : ''}, as a supporting change` : `${entry.file}: by you, as a supporting change`;
  }
  return entry.writer === 'copilot' ? `${entry.file}: by Copilot: ${entry.reason ?? 'no reason written'}` : `${entry.file}: by you`;
}

/**
 * What SFlow settled into the plan of `phaseId` and still stands, grouped by what it did, one line each: "12 test-support files
 * listed as supporting changes", each line with every settlement behind it, so each keeps its own undo [C3]. The delivered
 * code's approval lists these: what was settled is reviewed there after the fact.
 */
export function settledLedger(workflow, phaseId = null) {
  const groups = new Map();
  for (const entry of settledDecisions(workflow).filter((item) => !item.undone && item.kind === 'plan-accounting' && (!phaseId || item.phase === phaseId))) {
    const key = entry.effect?.class ?? 'row';
    const group = groups.get(key) ?? { kind: key, settled: [] };
    group.settled.push({ id: entry.id, file: entry.effect?.path ?? entry.effect?.file ?? String(entry.subject).replace(/^file:/u, ''), answer: entry.answer,
      undo: `singularity-flow decisions undo ${workflow.workItem.id} --settled ${entry.id}` });
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const [noun, did] = SETTLED_GROUP_WORDS[group.kind] ?? ['file', 'settled into the plan'];
    const count = group.settled.length;
    return { ...group, words: `${count} ${noun}${count === 1 ? '' : 's'} ${did.replace(/^listed as supporting changes$/u, count === 1 ? 'listed as a supporting change' : did)}` };
  });
}

/**
 * What the agent or SFlow settled for the person and that still stands, newest first [owner, 2026-11-13]: never a
 * question, so it holds nothing and is not counted; each shows its answer and evidence, and one option, Undo,
 * which makes it the person's question again on its own route (settled-decisions.mjs). Every host shows these under
 * its own "Settled for you" heading, so the title is the answer itself, and `evidence` is one line per fact it rests on.
 */
function settledItems(workflow, context) {
  const workId = workflow.workItem.id;
  return settledDecisions(workflow).filter((entry) => !entry.undone).reverse().slice(0, SETTLED_SHOWN).map((entry) => {
    // History (a step already approved, a version since superseded): on the full list with its evidence,
    // never offered to undo here, never in a headline or a chat [owner, 2026-11-20].
    const history = !settlementMatters(workflow, entry);
    const route = reraisedRoute(workflow, entry);
    const by = settledByWords(entry);
    const evidence = evidenceWords(entry);
    const undo = `singularity-flow decisions undo ${workId} --settled ${entry.id}`;
    // The version SFlow started for a review's findings, being written now: each finding it was started for may be disputed here
    // too, and one already disputed is said, with that its author is told not to make that fix [owner, 2026-11-20].
    const findings = history ? [] : startedFindings(context.facts?.reviewDisputes, entry);
    const disputes = findings.filter((finding) => !finding.disputed).slice(0, 5).map((finding) => disputeOption(workflow, context, context.facts.reviewDisputes, finding, `dispute-${finding.id}`));
    const disputed = findings.filter((finding) => finding.disputed).map((finding) => disputedFindingWords(finding.id, finding.disputed));
    // A file the open code step took up that is still only in the checkout: kept out in one step, its take-up undone and the
    // file set aside with a private copy [WCB:REQ-015, owner 2026-11-28]. The person's own terminal step, nothing to compose.
    const keptFile = !history && context.facts?.keepOut?.[entry.effect?.file] === entry.id ? entry.effect.file : null;
    const keepOut = keptFile ? personalStep({ id: 'keep-out', label: `Keep ${keptFile} out of this Story`,
      command: `${undo} --keep-out ${keptFile}`,
      words: `SFlow undoes taking ${keptFile} up and sets it aside: a private copy is kept, and your checkout goes back to its committed bytes.`,
      does: `Leaves ${keptFile} out of ${stepName(workflow, entry.phase)}; nothing else changes.`,
      decidedBy: anyone(`Whoever works on ${stepName(workflow, entry.phase)} takes this step.`) }) : null;
    return {
      kind: 'settled', settled: true, title: String(entry.answer).slice(0, 200), subject: entry.subject,
      answerWords: entry.answer, evidenceWords: evidence, evidence: (entry.evidence ?? []).map((fact) => `${fact.what} (${fact.where})`), by: entry.by, at: entry.at,
      why: [`${by.replace(/^./u, (first) => first.toUpperCase())} settled this from the evidence below; nobody was asked. ${history ? 'Its step has moved on, so there is nothing to undo here.' : 'Undo it only if it is wrong.'}`,
        keptFile ? `If ${keptFile} is not part of this Story, keep it out: that undoes the take-up and sets the file aside with a private copy.` : '',
        findings.length ? 'Dispute a finding it was started for if the reviewer is wrong.' : ''].filter(Boolean).join(' '),
      // Undone on the Decide card or in the person's own terminal, never asked in chat: nothing waits on it [owner, 2026-11-20].
      options: history ? [] : [{ ...option(workflow, context, { id: 'undo', label: 'Undo: ask me instead', words: route.words,
        effects: [{ kind: 'settled-undo', settled: entry.id }], needs: { reason: textNeed('', OPTIONAL_REASON) } }), terminal: undo },
        ...(keepOut ? [keepOut] : []), ...disputes],
      // What it changed, for its one line on every host (decision-plain.mjs) [owner, 2026-11-16].
      details: { settledId: entry.id, settledKind: entry.kind, ...(entry.phase ? { phase: entry.phase } : {}), evidence: entry.evidence, ...(entry.effect ? { effect: entry.effect } : {}),
        reraised: route, ...(disputed.length ? { disputed, allDisputed: findings.every((finding) => finding.disputed) } : {}), ...(history ? { history: true } : {}),
        commands: history ? [] : [undo, ...(keepOut ? [keepOut.action.command] : []), ...disputes.map((entry) => entry.terminal)] }
    };
  });
}

/**
 * Dispute this finding (owner, 2026-11-20): the reviewer's blocking finding, disputed with the person's own reason, under
 * the step's approval rules (review-finding-dispute.mjs). A choice against the reviewer: it always takes a reason, and no
 * surface recommends it (decision-advice.mjs). A bound yes in /sf-decide too, unless SF Guard signs it.
 */
function disputeOption(workflow, context, facts, finding, id = 'dispute') {
  const name = stepName(workflow, facts.phase);
  const command = reviewDisputeCommand(workflow.workItem.id, facts.phase, finding.id);
  return { ...option(workflow, context, { id, label: id === 'dispute' ? 'Dispute this finding' : `Dispute the reviewer's finding ${finding.id}`,
    words: `Say why the reviewer is wrong, in your own words. ${finding.id} then blocks neither ${name}'s next version nor its submission, and ${name}'s approvers see your reason when they approve it; they may still return the step.`,
    effects: [{ kind: 'review-dispute', phase: facts.phase, finding: finding.id, generation: facts.generation, reportSha256: facts.reportSha256 }],
    needs: { reason: textNeed('', REASON) } }), oneByOne: true, terminal: command, ...(presenceRequires(workflow) ? {} : { chat: { command } }) };
}

/**
 * Each blocking finding the step's own check raises now that a person may override, while its author writes the version
 * (finding-overrides.mjs) [owner, 2026-11-23]. Offered, never asked: by default the author fixes it. One already overridden
 * is no row: it blocks nothing, and the list says who overrode it and why.
 */
function checkFindingItems(workflow, context, facts) {
  if (!facts) return [];
  const name = stepName(workflow, facts.phase);
  return facts.findings.map((finding) => {
    const command = findingOverrideCommand(workflow.workItem.id, facts.phase, finding.key);
    const where = finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ''})` : '';
    const override = { ...option(workflow, context, { id: 'override', label: 'Override: the check is wrong',
      words: `Say why the check is wrong, in your own words. It then no longer blocks version ${facts.generation} of ${name}; it is recorded as overridden, never as passed, and ${name}'s approvers see your reason and may still return the step.`,
      effects: [{ kind: 'finding-override', phase: facts.phase, finding: finding.key, generation: facts.generation }],
      needs: { reason: textNeed('', REASON) } }), oneByOne: true, terminal: command, ...(presenceRequires(workflow) ? {} : { chat: { command } }) };
    return {
      kind: 'check-finding', title: `The check's finding ${finding.code} on ${name} version ${facts.generation}`,
      why: `The check found: ${finding.message}${where}. Its author fixes it by default. Override it only if the check is wrong.`,
      options: [override],
      details: { phase: facts.phase, generation: facts.generation, finding: finding.key, code: finding.code, message: finding.message,
        ...(finding.path ? { path: finding.path } : {}), ...(finding.value ? { clauseId: finding.value } : {}), commands: [command] }
    };
  });
}

/** The findings of the review a settled start of a version was for, while that version is being written; none otherwise. */
function startedFindings(facts, entry) {
  if (!facts?.open || entry.kind !== 'review-corrections' || entry.phase !== facts.phase || Number(entry.effect?.toGeneration) !== Number(facts.open.version)) return [];
  const named = new Set(entry.effect?.findings ?? []);
  const listed = facts.findings.filter((finding) => named.has(finding.id));
  return listed.length ? listed : facts.findings;
}

/**
 * Each blocking finding the reviewer raised on the step's published version, while its author is to fix it (offered: nothing
 * waits on a dispute; by default the author fixes it) [owner, 2026-11-20]. One already disputed is no row: it blocks nothing.
 * Never asked in chat: a row on the card for a person who disagrees. Once the version that fixes it is published, the review
 * read is that version's own (review-finding-dispute.mjs reads the published generation), and once the step is submitted
 * there is no row at all: the author is done, and the new version's review judges it.
 */
function reviewFindingItems(workflow, context, facts) {
  if (!facts || facts.status !== 'in_progress') return [];
  const name = stepName(workflow, facts.phase);
  return facts.findings.filter((finding) => !finding.disputed).map((finding) => {
    const dispute = disputeOption(workflow, context, facts, finding);
    const where = finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ''})` : '';
    return {
      kind: 'review-finding', title: `The reviewer's finding ${finding.id} on ${name} version ${facts.generation}`,
      why: `The reviewer found: ${String(finding.message).replace(/\s+/gu, ' ').slice(0, 400)}${where}. ${facts.open ? `Version ${facts.open.version} is being written to fix it.` : 'Its author fixes it in the next version.'} Dispute it only if the reviewer is wrong.`,
      options: [dispute],
      details: { phase: facts.phase, generation: facts.generation, finding: finding.id, message: finding.message, ...(finding.check ? { check: finding.check } : {}),
        ...(finding.clauseId ? { clauseId: finding.clauseId } : {}), ...(finding.path ? { path: finding.path } : {}), ...(facts.open ? { writing: facts.open.version } : {}),
        commands: [dispute.terminal] }
    };
  });
}

/**
 * The next version a published step needs [owner, 2026-11-13]: its files changed after publication, or the person
 * asked for a change since, and the published version holds neither, so it is not submitted with them. Once only
 * the step's own skill asked it, in chat ("Would you like me to open generation 2?"); it is on the card now, each
 * choice with what it does. Both stay the person's own steps: their terminal previews the next version and asks them to
 * confirm, and the step's skill still asks it yes or no in chat. Nothing is recorded from the list. `asked`: its preview
 * waits for the person's yes, or their yes is kept, so that question asks it once [D3, OSA:REQ-030] and this row keeps
 * only leaving the change out.
 */
function rolloverItem(workflow, context, entry) {
  const name = stepName(workflow, entry.phase);
  const shown = entry.paths.length ? `${listWords(entry.paths.slice(0, 5))}${entry.paths.length > 5 ? ` and ${entry.paths.length - 5} more` : ''}` : null;
  const asked = entry.requests.length ? `The person asked for a change after it was published: ${entry.requests.map((text) => `"${text}"`).join('; ')}.` : '';
  const kept = `version ${entry.generation} and its ${entry.code ? 'evidence and test results' : 'review'} stay as published`;
  const anyoneHere = (words) => anyone(`Whoever works on ${name} takes this step. ${words}`.trim());
  const options = entry.asked ? [] : [personalStep({ id: 'start-next-generation', label: `Start version ${entry.next} of ${name}${shown ? ` with ${shown}` : ' for the change'}`,
    command: entry.command, words: `Your terminal previews version ${entry.next} and asks you to confirm it; ${kept}.`,
    does: `Opens version ${entry.next} of ${name} with the change; ${kept}.`, decidedBy: anyoneHere('') })];
  if (entry.keepOut) {
    options.push(personalStep({ id: 'set-aside', label: `Leave the change out: set ${shown} aside`, command: entry.keepOut,
      words: `Recovery shows the set-aside route; a private copy is kept, and version ${entry.generation} is submitted as it is.`,
      does: `Sets the changed files aside with a private copy; version ${entry.generation} goes ahead as published, without them.`,
      decidedBy: anyoneHere('') }));
  }
  return {
    kind: 'generation-rollover', title: entry.asked ? `Leave the change out of ${name} instead of starting version ${entry.next}` : `Start version ${entry.next} of ${name}, or leave the change out`,
    why: [shown ? `${shown} changed after version ${entry.generation} of ${name} was published, and that version does not hold ${entry.paths.length === 1 ? 'it' : 'them'}, so it is not submitted with ${entry.paths.length === 1 ? 'it' : 'them'}.` : '',
      asked, entry.asked ? `Starting version ${entry.next} with the change is asked on its own; or leave the change out.` : `Start version ${entry.next} with the change, or leave it out.`].filter(Boolean).join(' '),
    options,
    details: { phase: entry.phase, generation: entry.generation, next: entry.next, paths: entry.paths, requested: entry.requests.length > 0, ...(entry.asked ? { asked: true } : {}),
      ...(entry.chatRoute ? { chatRoute: entry.chatRoute } : {}), commands: options.map((option) => option.action.command) }
  };
}

/**
 * Code committed on a Story with no code step at all [WCB:REQ-017]: nothing checks it against a clause and a test, and it
 * would reach the pull request, so its submission waits until the commit is taken out. The row of a generation rollover,
 * so every reader of that kind shows it; `committedCode` says which. One choice, the take-out, in the person's terminal.
 */
function uncheckedCodeItem(workflow, context, facts) {
  const name = stepName(workflow, facts.phase);
  const files = facts.committed.paths;
  const shown = `${listWords(files.slice(0, 5))}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`;
  const options = [personalStep({ id: 'take-out', label: `Take the commit of ${shown} out`, command: facts.committed.takeOut,
    words: 'Git adds a commit that takes it out; your history keeps the original, and a task with a code step can deliver it.',
    does: `Takes ${shown} out of this Story's branch; ${name} is then submitted as it is.`,
    decidedBy: anyone(`Whoever works on ${name} takes this step.`) })];
  return {
    kind: 'generation-rollover', title: `Take ${shown} out: no step of this Story checks code`,
    why: `${shown} ${files.length === 1 ? 'was' : 'were'} committed on this Story, which has no code step: nothing checks ${files.length === 1 ? 'it' : 'them'} against a clause and a test.`,
    options,
    details: { phase: facts.phase, paths: files, committedCode: true, commits: facts.committed.commits.map((entry) => entry.commit),
      commands: options.map((option) => option.action.command) }
  };
}

/** The step's approval itself: always the list's last item. */
function approvalItem(workflow, context, phase, { heldBy, youDecide, ownTerminal }) {
  const workId = workflow.workItem.id;
  const name = stepName(workflow, phase.id);
  const approvals = (phase.approvals ?? []).filter((entry) => !entry.invalidatedAt && entry.decision === 'approved').length;
  const minimum = phase.approvalPolicy?.minimum ?? 1;
  const waiting = heldBy.length ? `It waits for ${listWords(heldBy)} first.` : 'Nothing above holds it.';
  // What SFlow settled into this step's plan, and what earlier steps were found to get wrong, reviewed here after the fact
  // [owner, 2026-11-19, C3, Q12]: the approval is where a settlement is last undone, by returning the step.
  const ledger = settledLedger(workflow, phase.id);
  const raised = (workflow.upstreamIssues ?? []).filter((issue) => issue.raisedIn?.phase === phase.id).map((issue) => issue.id);
  // Each finding of its review a person disputed, with their reason: the approver decides with it in view [owner, 2026-11-20].
  const disputes = (context.facts?.reviewDisputes?.status === 'awaiting_approval' && context.facts.reviewDisputes.phase === phase.id ? context.facts.reviewDisputes.findings : [])
    .filter((finding) => finding.disputed).map((finding) => ({ finding: finding.id, message: finding.message, by: finding.disputed.by, reason: finding.disputed.reason,
      ...(finding.disputed.carriedFrom ? { carriedFrom: finding.disputed.carriedFrom } : {}), words: disputedFindingWords(finding.id, finding.disputed) }));
  // Each check finding a person overrode for this version, with their reason [owner, 2026-11-23]: overridden, never passed.
  const overrides = countedRecords(workflow, workflow.findingOverrides).filter((entry) => entry.phase === phase.id
    && Number(entry.generation) === Number(phase.generation) && !entry.withdrawnAt)
    .map((entry) => `${entry.code}${entry.path ? ` on ${entry.path}` : ''} was overridden by ${entry.actor ?? 'a person'}: "${entry.reason}". Recorded as overridden, not passed.`);
  // Every file taken up because it changed outside the plan, one line each, with who changed it and why [WCB:REQ-014].
  const outside = outsidePlanSettled(workflow, phase.id).map((entry) => ({ file: entry.file, by: entry.writer, reason: entry.reason,
    ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.supporting ? { supporting: entry.supporting } : {}), settled: entry.id, words: outsidePlanWords(entry) }));
  // A Story with no code step: the code base files left in its checkout, which nothing delivers [WCB:REQ-017].
  const leftOut = context.facts?.noCodeStep?.uncommitted ?? [];
  const reviewed = [...(leftOut.length ? [`Not part of this task: ${listWords(leftOut.slice(0, 8))}${leftOut.length > 8 ? ` and ${leftOut.length - 8} more` : ''}, left in your checkout; nothing delivers ${leftOut.length === 1 ? 'it' : 'them'}.`] : []),
    ...ledger.map((group) => `Settled for you: ${group.words}.`),
    // Why they are shown and the way on, in one line before them: nothing stopped for them, and a return drops one [owner, 2026-11-28].
    ...(outside.length ? [`No row of the approved plan names ${outside.length === 1 ? 'the file below' : `the ${outside.length} files below`}; SFlow committed ${outside.length === 1 ? 'it' : 'them'} with ${name} so nothing stopped. Approving keeps ${outside.length === 1 ? 'it' : 'them'}; to drop one, return ${name} on the approval page.`] : []),
    ...outside.map((entry) => `Changed outside the plan: ${entry.words.replace(/[.\s]+$/u, '')}.`),
    ...(raised.length ? [`Raised here against earlier steps: ${listWords(raised)}.`] : []),
    ...disputes.map((entry) => entry.words), ...overrides];
  // Why the person is asked and what each choice does, by what the step is for, never by its workflow (step-advice.mjs).
  const advice = adviceForStep(workflow, phase.id, context.facts?.stepIntent ?? null);
  const standing = `${approvals} of ${minimum} approval${minimum === 1 ? '' : 's'} recorded. ${waiting}${youDecide.length ? ` You answer ${youDecide.length === 1 ? 'one question' : `${youDecide.length} questions`} in the approval itself.` : ''}${ownTerminal ? ' It takes your signature, in your own terminal.' : ''}`;
  return {
    kind: 'approval', title: `Approve ${name}`,
    why: `${advice.decides} ${standing}`,
    options: [{ ...personalStep({ id: 'approve', label: heldBy.length ? `Approve ${name} once ${listWords(heldBy)} ${heldBy.length === 1 ? 'is' : 'are'} done` : `Review and approve ${name}`,
      command: `singularity-flow approve ${phase.id} --work-id ${workId} --fetch`, words: `You read its documents and say Yes to "Approve ${name} v${Number(phase.generation ?? 0)}?" once: on the approval page, with /sf-approve or in your own terminal.`,
      does: `${advice.yes}${minimum > 1 ? ` The Story moves on when ${minimum} approvals are recorded.` : ''}` }),
    decidedBy: stepDecidedBy(workflow, context, approvers(workflow, phase.id), 'You read its documents and say Yes once.') }],
    // Send back, filled but for the person's reason: the approval page runs it with theirs [owner, 2026-11-28].
    details: { phase: phase.id, generation: Number(phase.generation ?? 0), approvals, minimum, heldBy, youDecide, ready: !heldBy.length, advice,
      sendBack: sendBackCommand(workId, phase.id),
      ...(reviewed.length ? { ledger: { settled: ledger, issues: raised }, lines: reviewed } : {}),
      ...(leftOut.length ? { notPartOfTask: leftOut } : {}),
      ...(outside.length ? { outsidePlan: outside } : {}),
      ...(disputes.length ? { disputes } : {}),
      // The one approval screen opens its documents, and those of the steps SFlow approved since the last approval (approve twice).
      documents: [...new Set((phase.artifacts ?? []).map((artifact) => artifact?.path).filter((file) => typeof file === 'string' && file))],
      ...(() => { const covers = automaticApprovalsBefore(workflow, phase.id).map(coveredStep); return covers.length ? { covers } : {}; })(),
      commands: [`singularity-flow approve ${phase.id} --work-id ${workId} --fetch`] }
  };
}

/**
 * A code step's approval starts with what its change does, in one line, and the read that prints the whole page
 * (change-story-read.mjs) [CSP:REQ-007]. Information only: it holds and asks nothing.
 */
function changeStoryFirst(item, change) {
  if (!change?.summary || change.phase !== item.details?.phase) return item;
  return { ...item, details: { ...item.details, changeStory: { summary: change.summary, path: change.path, command: change.command },
    lines: [`What this change does: ${change.summary} The whole page: ${change.command}`, ...(item.details.lines ?? [])] } };
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
  // And the next generation a published step needs, once asked only in chat [owner, 2026-11-13].
  // And a refactor's behaviour change while its code is written [ITW:REQ-015].
  'decision-list': Object.freeze({ kinds: ['conformance-gap', 'upstream-issue', 'visual-profile', 'node-pin', 'test-run-risk', 'test-narrowing', 'test-command', 'evidence-obligation', 'plan-accounting', 'departure', 'convergence-item', 'asked-for', 'generation-rollover', 'refactor-behaviour'] }),
  'routing-decision': Object.freeze({ kinds: ['routing-decision'] }),
  // And a witness exception whose date passed, renewed here by its step's approvers [owner, 2026-11-28].
  'owed-witnesses-and-scope-items': Object.freeze({ kinds: ['owed-decision', 'evidence-obligation', 'witness-exception'] }),
  'intent-amendments': Object.freeze({ kinds: ['intent-amendment'] }),
  'forward-amendments': Object.freeze({ kinds: ['forward-amendment', 'revalidation'] }),
  appeals: Object.freeze({ kinds: ['appeal'] }),
  'repair-journal': Object.freeze({ kinds: ['approval-hold'], codes: ['PHASE_REPAIR_RECHECK_REQUIRED', 'PHASE_REPAIR_JOURNAL_INVALID'] }),
  'trp-risks': Object.freeze({ kinds: ['approval-hold'], codes: ['TRP_DOCUMENT_GATE_BLOCKED', 'TRP_PHASE_GATE_BLOCKED'] }),
  'quality-risks': Object.freeze({ kinds: ['approval-hold'], codes: ['ARTIFACT_AUTHORING_INCOMPLETE', 'PHASE_VALIDATION_FAILED'] })
});

/** Approval-check holds another item already carries: the approval names that item instead of repeating it. */
const HOLD_KINDS = Object.freeze({
  APPROVAL_INTENT_AMENDMENT_PENDING: 'intent-amendment', INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED: 'intent-amendment', INTENT_AMENDMENT_PENDING_PAUSE: 'intent-amendment',
  DECISION_REQUIRED: 'routing-decision', PHASE_APPEAL_REVIEW_REQUIRED: 'appeal', PHASE_APPEAL_INTEGRITY: 'appeal',
  STORY_PUBLICATION_PENDING: 'story-publication', CONFORMANCE_BLOCKING_VERDICTS: 'conformance-gap', STORY_COMPLETION_REFUSED: 'conformance-gap',
  DEPARTURES_UNDECIDED: 'departure', INSTRUCTIONS_UNACCOUNTED: 'asked-for', AMENDMENT_STILL_HOLDS_REQUIRED: 'revalidation'
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
const DECIDED_HERE = new Set(['conformance-gap', 'upstream-issue', 'visual-profile', 'node-pin', 'test-run-risk', 'test-narrowing', 'test-command', 'evidence-obligation', 'plan-accounting', 'departure', 'convergence-item', 'refactor-behaviour',
  'witness-exception', 'forward-amendment']);

/** Kinds that wait for the step's approval, never for its submission. */
export const LATER_KINDS = Object.freeze(['owed-decision', 'departure', 'asked-for']);

/** Every item kind this list builds. */
export const PENDING_ITEM_KINDS = Object.freeze(['story-publication', 'routing-decision', 'intent-amendment', 'forward-amendment', 'revalidation', 'appeal',
  'conformance-gap', 'upstream-issue', 'visual-profile', 'node-pin', 'test-run-risk', 'test-narrowing', 'test-command', 'evidence-obligation', 'owed-decision',
  'plan-accounting', 'departure', 'convergence-item', 'asked-for', 'generation-rollover', 'refactor-behaviour', 'approval-hold', 'transport-intent', 'approval', 'witness-exception']);

/**
 * The command that records choices. Only choices a /sf-decide turn records after the person's yes carry
 * the packet digest, which that turn passes on. Any other choice is the person's, in their own terminal,
 * which shows the summary and asks them to confirm, binding the digest it derives itself: a person never
 * reads or types a digest [no hashes shown]. `digest: null` leaves it out.
 */
export function decisionRecordCommand(workId, { phaseId = null, choices = [], digest, values = {} } = {}) {
  const inChat = choices.length > 0 && choices.every(([, option]) => DECISION_LIST_CHAT_OPTIONS.includes(option));
  return ['singularity-flow decisions record', workId, ...(phaseId ? [`--phase ${phaseId}`] : []),
    ...choiceFlags(choices, values), ...(digest && inChat ? [`--confirm ${digest}`] : [])].join(' ');
}

/**
 * What a /sf-decide turn runs for choices with a chat command of their own: each command, with the person's
 * words in it. A preview offered only `decisions record`, which no turn may run for them, so someone who had
 * just answered everything in chat was sent to a terminal (paid run, 2026-11-07). One still short of an answer is left out.
 */
export function decisionChatSteps(packet, steps) {
  const items = [...packet.items, ...(packet.offered ?? [])];
  return steps.flatMap((step) => {
    const chat = items.find((item) => item.id === step.item)?.options.find((option) => option.id === step.option)?.chat;
    const { reason = '', clause = [] } = step.values ?? {};
    // The recommended answer runs with --recommended; the person's own words, when they gave some, with them [C10].
    const template = reason && chat?.withReason ? chat.withReason : chat?.command;
    const command = template?.replaceAll('"<REASON>"', () => (reason ? shellQuoted(reason) : '<REASON>')).replaceAll('<CLAUSES>', () => clause.join(',') || '<CLAUSES>');
    return command && !/<[A-Z][A-Z-]*>/u.test(command) ? [{ item: step.item, command }] : [];
  });
}

/** The same choices recorded with the step's approval, in its one commit [SPEC-OAP M4]: the flags approve adds. */
export function decisionApprovalFlags({ choices = [], digest, values = {} } = {}) {
  return [...choiceFlags(choices, values), ...(digest ? [`--decisions ${digest}`] : [])].join(' ');
}

// POSIX single quotes, as canonicalDisplayToken in safe-command-guidance.mjs: a JSON double-quoted
// reason would still expand `$()`, `$NAME` and backticks when the person pastes the command.
const shellQuoted = (value) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`);

function choiceFlags(choices, values) {
  const extra = Object.entries(values).flatMap(([flag, entries]) => Object.entries(entries ?? {})
    .map(([item, value]) => `--${flag} ${shellQuoted(`${item}=${value}`)}`));
  return [...choices.map(([item, chosen]) => `--choose ${item}=${chosen}`), ...extra];
}

/** What an item holds back, as every surface says it [decision map, finding 1]. */
const HOLDS_WORDS = Object.freeze({
  'this-step': 'Holds this step: decide it before the step is published or submitted.',
  submission: 'Holds this step\'s submission: the Story cannot end until it is decided.',
  'step-completion': 'Holds this step\'s submission, which completes it: the step needs no approval.',
  approval: 'Holds this step\'s approval.',
  'approval-later': 'Holds this step\'s approval once it is submitted.',
  'story-end': 'Holds the Story\'s end, not this step.',
  'later-step': 'Holds the steps it reopens, not this one.',
  story: 'Holds the Story: nothing else begins until it is decided.',
  'nothing-yet': 'Holds nothing until a test run fails.',
  nothing: 'Holds nothing.'
});

/**
 * One set of answers across every kind [decision map, recommendation 3]: each option says which of these it is, so
 * accepting, accepting as a dated risk, returning work, changing the spec, saying it does not apply, deciding later and
 * dismissing read the same on every item. A route choice and a person's own step are named for what they are.
 */
export const DECISION_OUTCOMES = Object.freeze({
  accept: 'Accept', 'accept-risk': 'Accept as a risk until a date', return: 'Return to a step', 'change-spec': 'Change the spec',
  'not-applicable': 'Not applicable', defer: 'Decide later', dismiss: 'Dismiss: not real', route: 'Choose the route', 'own-step': 'Your own step',
  undo: 'Undo: ask me instead', dispute: 'Dispute: the reviewer is wrong', override: 'Override: the check is wrong'
});

/** The outcome an option is, from its kind and ID; anything not named below accepts what the item asks about. */
export function optionOutcome(item, entry) {
  const id = String(entry.id ?? '');
  if (id === 'dispute' || id.startsWith('dispute-')) return 'dispute';
  if (id === 'override') return 'override';
  if (item.kind === 'settled') return 'undo';
  if (item.kind === 'routing-decision' || /^(?:choose|to)-/u.test(id) || id === 'route') return 'route';
  // Approving an intent amendment changes the approved clauses.
  if (item.kind === 'intent-amendment' && /^approve(?:-|$)/u.test(id)) return 'change-spec';
  // So does approving a forward amendment, and rejecting it keeps the document, as rejecting an intent amendment does.
  if (item.kind === 'forward-amendment') return id === 'approve-amendment' ? 'change-spec' : 'dismiss';
  // Renewing a lapsed witness exception keeps it standing until a date, as a dated risk does.
  if (id === 'accept-risk' || id === 'accept-test-risk' || id === 'renew-exception' || id.startsWith('accept-obligation-risk-')) return 'accept-risk';
  if (['return', 'return-step', 'return-step-first', 'fix-code', 'rework'].includes(id) || (id === 'reject' && item.kind === 'departure')) return 'return';
  if (['update-spec', 'update-intent'].includes(id)) return 'change-spec';
  if (['does-not-apply', 'not-applicable', 'scope-informative', 'scope-excluded', 'other-disposition'].includes(id)) return 'not-applicable';
  if (['deferred', 'scope-deferred'].includes(id)) return 'defer';
  if (['dismiss', 'dismissed', 'scope-duplicate', 'scope-superseded'].includes(id) || id === 'reject') return 'dismiss';
  if (['sync', 'review', 'decide', 'capture'].includes(id)) return 'own-step';
  return 'accept';
}

/** Whether a listed item carries an approval hold itself: an open scope statement, or a sign-off the step answers for. */
function carriesHold(item, hold) {
  if (item.kind !== 'owed-decision' && item.kind !== 'evidence-obligation') return false;
  if (hold.code === 'SCOPE_ITEMS_UNRESOLVED') return Boolean(item.details?.scopeItem);
  if (hold.code !== 'EVIDENCE_INSPECTION_MISSING') return false;
  const clause = item.details?.clause ?? item.details?.criterion;
  // A hold that does not name its sign-offs is carried by every sign-off on the list.
  return Boolean(clause) && (!hold.signOffs?.length || hold.signOffs.some((entry) => entry.clauseId === clause && (!item.details?.slot || entry.slot === item.details.slot)));
}

/**
 * Each item's `holds`, from the checks themselves: what approval and the final evaluation refuse for, never the kind
 * alone. While a step awaits approval an item holds that approval or the Story's end. Before then: the last step that
 * defines the scope is approved only once its open statements are decided, and a step whose Story pinned owner-step
 * checks only once the sign-offs it answers for are given; the step that ends the Story is submitted only once its
 * open scope statements and left-out responsibilities are decided; a departure or a typed request holds the approval
 * once submitted; everything else stops the step now.
 */
function itemHolds(workflow, facts, awaiting) {
  const phaseId = facts.phaseId;
  const pinned = ownerStepChecks(workflow);
  const scopeHere = pinned && finalScopeStep(workflow)?.id === phaseId;
  const endsStory = facts.endsStory === true;
  return (item) => {
    const holds = (() => {
      if (item.kind === 'approval' || item.machine) return 'nothing';
      if (item.holdsApproval) return 'approval';
      if (item.kind === 'routing-decision') return 'story';
      // An approved amendment's acknowledgement holds the steps it reopened; a correction of an earlier document, and
      // every owed sign-off, scope statement or evidence row, the Story's end.
      if (item.kind === 'intent-amendment' && item.details?.status === 'approved') return 'later-step';
      // A "still holds" question holds this step only when it reads the kept step: at its approval, or at its submission when
      // that completes it [CIC:REQ-021]; otherwise only the Story's end.
      if (item.kind === 'revalidation' && item.details?.reason === 'prompt-held' && (item.details.consumers ?? []).includes(phaseId)) {
        return workflow.phases?.[phaseId]?.approvalPolicy?.mode === 'none' ? 'this-step' : 'approval-later';
      }
      if (['forward-amendment', 'revalidation', 'upstream-issue', 'evidence-obligation', 'witness-exception'].includes(item.kind)) return 'story-end';
      if (awaiting) return item.kind === 'owed-decision' ? 'story-end' : 'nothing';
      // A pending intent amendment pauses the step it was proposed in until a scope approver decides it [owner, 2026-11-13, D3].
      if (item.kind === 'intent-amendment' && item.details?.status === 'proposed' && item.details.sourcePhase === phaseId) return 'this-step';
      if (item.details?.stage === 'early') return 'nothing-yet';
      // What a step nobody approves has typed into it waits for its submission, which completes it [SCS:REQ-042], and so does a
      // change outside its plan: the plan's approvers decide it there, or nobody ever would [owner, 2026-11-19, Q6].
      if (['asked-for', 'departure'].includes(item.kind) && noApproval(workflow, phaseId)) return 'step-completion';
      if (['departure', 'asked-for', 'appeal', 'intent-amendment'].includes(item.kind)) return 'approval-later';
      if (item.kind !== 'owed-decision') return 'this-step';
      if (item.details?.scopeItem) return scopeHere ? 'approval-later' : endsStory ? 'submission' : 'story-end';
      if (item.details?.responsibility) return endsStory ? 'submission' : 'story-end';
      return pinned && (item.owners ?? []).includes(phaseId) ? 'approval-later' : 'story-end';
    })();
    return { holds, holdsWords: HOLDS_WORDS[holds] };
  };
}

/**
 * The decisions that do not stop this step now, by what each holds: "1 other decision holds the Story's end." beside
 * a count of what stops it, or "it holds the Story's end." / "2 hold its approval once it is submitted; 1 holds the
 * Story's end." on their own.
 */
function laterWords(items, { others = false, step = 'it' } = {}) {
  // What each waits for, in plain words [owner, 2026-11-18: "four hold implementation approval after submission"].
  const verb = (count) => (count === 1 ? 'is' : 'are');
  const groups = [['approval-later', `needed when ${step} is submitted for approval`], ['story', 'needed before the next step'],
    ['later-step', 'needed before the steps it reopened are submitted again'], ['story-end', 'needed before the Story ends']]
    .map(([key, words]) => [items.filter((item) => item.holds === key).length, words]);
  const rest = items.length - groups.reduce((sum, [count]) => sum + count, 0);
  const parts = [...groups.filter(([count]) => count), ...(rest ? [[rest, 'not needed yet']] : [])];
  if (parts.length === 1) {
    const [[count, words]] = parts;
    const subject = others ? (count === 1 ? '1 other decision' : `${count} other decisions`) : (count === 1 ? 'it' : 'they');
    return `${subject} ${verb(count)} ${words}.`;
  }
  const list = parts.map(([count, words]) => `${count} ${verb(count)} ${words}`).join('; ');
  return others ? `The other ${items.length}: ${list}.` : `${list}.`;
}

/**
 * Where an item can be answered, said on the item itself [decision map, finding 11]: in a /sf-decide chat (an option a
 * turn may record, bound to the person's own answer), on the Decide card or in the person's terminal (a choice this
 * list records), only in the person's own terminal (their own command), or by the step's author. `also` is what a
 * Decide card adds beside the row, where it can be answered besides the card: yes or no in chat, or, for a row SF Guard
 * signs, the person's own terminal.
 */
function itemAnswer(item, workId) {
  const live = item.options.filter((entry) => entry.available !== false);
  if (!live.length) return { where: 'later', words: 'Nothing can be answered yet.' };
  if (live.every((entry) => entry.decidedBy?.author)) return { where: 'author', words: 'Its author answers it while writing the step.' };
  // One place: the Decide card holds every person decision, and /sf-decide opens it [owner, 2026-11-13]. A yes-or-no
  // item may still be answered in chat, bound to the person's own typed answer; a step SF Guard signs, in their terminal.
  const card = `Answer it on the Decide card: /sf-decide ${workId} opens it`;
  if (item.guardSigns) {
    const also = `SF Guard signs it, so it is recorded in your own terminal (singularity-flow decisions record ${workId}), never in chat.`;
    return { where: 'terminal', words: `${card}. ${also}`, also };
  }
  // Nothing waits on it: never a question in chat, and the card holds it only for a person who disagrees [owner, 2026-11-20].
  if (item.optional) return { where: 'card', words: `Nothing waits on it. Answer it on the Decide card (/sf-decide ${workId} opens it) only if you disagree; a chat never asks it.` };
  const yesNo = item.yesNo ? `, or answer yes or no in chat (${item.yesNo.route})` : '';
  const also = item.yesNo ? { also: `Or answer yes or no in chat (${item.yesNo.route}).` } : {};
  if (live.some((entry) => DECISION_LIST_CHAT_OPTIONS.includes(entry.id) || entry.chat)) return { where: 'chat', words: `${card}${yesNo}.`, ...also };
  if (live.some((entry) => (entry.recordable !== false && !entry.action) || entry.action?.humanReview)) {
    return { where: 'card', words: `${card}. A chat turn cannot record it; when SF Guard signs it, the card opens your own terminal.` };
  }
  return { where: 'terminal', words: `Start it from the Decide card (/sf-decide ${workId}): it runs in your own terminal${yesNo}.`, ...also };
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
  // Every open upstream issue is shown from the moment it is raised, on every step's list [owner, 2026-11-19, Q12]: one no gap
  // names holds only the Story's end (`early`), so nothing that stops a step changes; at the step that ends the Story, as before.
  const converging = facts.convergence ? convergenceItems(workflow, context, facts.convergence) : [];
  // An issue a convergence row names is decided there, never asked again [SCS:REQ-031].
  const namedThere = new Set(converging.flatMap((item) => item.details?.issues ?? []));
  const groups = decisionGroups(workflow, { gaps: facts.gaps, issues: facts.issues, includeAllIssues: true })
    .filter((group) => group.kind !== 'upstream-issue' || !namedThere.has(group.state.issue.id));
  const early = facts.endsStory !== true;
  const listed = [
    ...(pending.publication ? [machineItem(workflow, pending.publication)] : []),
    ...(pending.routing ? [routingItem(workflow, context, pending.routing)] : []),
    ...(pending.intentAmendments ?? []).map((amendment) => intentAmendmentItem(workflow, context, amendment)),
    ...(pending.forwardAmendments ?? []).map((blocker) => forwardAmendmentItem(workflow, context, blocker)),
    ...(pending.appeals ?? []).map((appeal) => appealItem(workflow, context, appeal)),
    ...groups.map((group) => (group.kind === 'conformance-gap' ? gapItem(workflow, context, group) : issueItem(workflow, context, group.state, { early }))),
    ...converging,
    ...(facts.visual ?? []).map((entry) => visualItem(workflow, context, entry)),
    ...(facts.nodePin ? [nodePinItem(workflow, context, facts.nodePin)] : []),
    ...(facts.testRisks ?? []).map((risk) => testRiskItem(workflow, context, risk)),
    ...(facts.testNarrowings ?? []).map((entry) => testNarrowingItem(workflow, context, entry)),
    ...(facts.testCommands ?? []).map((request) => testCommandItem(workflow, context, request)),
    ...(facts.behaviourChange?.undecided?.length ? [behaviourItem(workflow, context, facts.behaviourChange)] : []),
    ...(facts.evidence ?? []).map((entry) => evidenceItem(workflow, context, entry)),
    ...witnessExceptionItems(workflow, context),
    ...(pending.owed ?? []).filter(entry => entry.kind !== 'witness' || !(facts.evidence ?? []).some(row =>
      row.criterion === entry.clauseId && row.witnesses.some(witness => witness.slot === entry.slot)))
      .map((entry) => owedItem(workflow, context, entry)),
    ...(pending.applicability ?? []).map((entry) => applicabilityItem(workflow, context, entry)),
    // Publication would refuse these before the step could ever await approval.
    ...(facts.excludedChanges ? planPathItems(workflow, context, facts.excludedChanges) : []),
    ...(facts.rollover ? [rolloverItem(workflow, context, facts.rollover)] : []),
    ...(facts.noCodeStep?.committed ? [uncheckedCodeItem(workflow, context, facts.noCodeStep)] : []),
    ...(facts.departures?.entries ?? []).map((entry) => departureItem(workflow, context, entry, facts.departures)),
    ...(facts.askedFor?.entries ?? []).map((entry) => askedForItem(workflow, context, entry, facts.askedFor))
  ];
  // Each refusal approval names that no item carries becomes an item of its own; the approval itself
  // names the rest, so the list and the approval check never disagree [SPEC-OAP M3].
  const holds = awaiting ? (facts.approvalCheck?.holds ?? []) : [];
  // A row whose amendment waits for its approvers is that amendment's item, which holds the approval in its place [SCS:REQ-023].
  const amending = new Set((facts.gaps ?? []).filter((gap) => gap.status === 'amending' && gap.issue).map((gap) => gap.issue));
  const amendmentItem = (item) => ['intent-amendment', 'forward-amendment', 'revalidation'].includes(item.kind) && amending.has(item.details?.amendment);
  const carried = new Set([...listed.map((item) => item.kind), ...(listed.some(amendmentItem) ? ['conformance-gap'] : [])]);
  // This checkout's own changes come first, as the door refuses them first, as d0 and outside the
  // digest: setting them aside changes neither which item a number means nor what a person chose.
  const dirty = holds.find((hold) => hold.owner === 'this-checkout');
  // The Story's ending names what is already on the list, so only an ending nothing lists is an item of its own.
  const ending = holds.some((hold) => hold.code === 'STORY_COMPLETION_REFUSED');
  // A step still to revalidate fails the input check the approval and the ending run, so its row carries those holds,
  // and the history check's for the report's own amendment until its approvers confirm the report [SCS:REQ-022].
  const revalidating = listed.filter((item) => item.details?.code === 'AMENDMENT_REVALIDATION_REQUIRED');
  const carriedByRows = (hold) => revalidating.length > 0 && (hold.code === 'STORY_COMPLETION_REFUSED'
    || (hold.code === 'STORY_REVIEW_INTERVENING_COMMIT' && revalidating.some((item) => item.details.phase === facts.phaseId
      && String(hold.message ?? hold.summary).includes(item.details.amendment))));
  const carriedByEnding = (hold) => hold.code === 'STORY_COMPLETION_REFUSED' && listed.some((item) => [...APPROVAL_HOLDING_KINDS, 'owed-decision'].includes(item.kind));
  // The last step that defines the scope waits for its open statements, and a step for the sign-offs it answers for
  // (owner-step checks): those listed items hold its approval themselves, never a second item beside them that
  // routes back to this list [decision map, finding 1].
  const carriedByItem = (hold) => listed.some((item) => carriesHold(item, hold));
  const extra = holds.filter((hold) => hold !== dirty && holdItemKind(hold) !== 'approval' && !carried.has(holdItemKind(hold)) && !carriedByEnding(hold) && !carriedByRows(hold) && !carriedByItem(hold))
    .flatMap((hold) => (hold.unclaimedPaths?.length ? planPathItems(workflow, context, hold)
      : [holdItem(workflow, context, holdItemKind(hold) === 'test-run-risk' ? 'test-run-risk' : 'approval-hold', hold)]));
  const heldKinds = new Set(holds.filter((hold) => hold.owner !== 'you-decide').map(holdItemKind));
  const held = (item) => (APPROVAL_HOLDING_KINDS.includes(item.kind) && !item.details?.early) || extra.includes(item) || (ending && item.kind === 'owed-decision') || (awaiting && amendmentItem(item))
    || (awaiting && holds.some((hold) => carriesHold(item, hold)))
    // A "still holds" row holds only the approval of the step it is about or one that reads it (CIC:REQ-021); the engine says which.
    || (awaiting && revalidating.includes(item) && (item.details.reason !== 'prompt-held'
      || holds.some((hold) => (hold.stillHolds ?? []).some((row) => row.amendment === item.details.amendment && row.phase === item.details.phase))))
    || (awaiting && heldKinds.has(item.kind) && item.details?.reason !== 'prompt-held'
    && (!item.details?.amendment || holds.some((hold) => String(hold.message ?? hold.summary).includes(item.details.amendment))));
  const built = [...listed, ...extra, ...(pending.transport ?? []).map((entry) => machineItem(workflow, entry))];
  const holdsOf = itemHolds(workflow, facts, awaiting);
  const items = built.map((item, index) => {
    // What it holds is read from the item as built; under SF Guard it offers no chat (underGuard).
    const shown = underGuard(workflow, item);
    // Recommended first, then in the order built.
    const options = [...shown.options].sort((left, right) => Number(right.recommended) - Number(left.recommended));
    const withOutcomes = options.map((entry) => { const outcome = optionOutcome(item, entry); return { ...entry, outcome, outcomeWords: DECISION_OUTCOMES[outcome] }; });
    // Its recommended answer and what each choice does, on every item and every host [owner, 2026-11-13].
    const numbered = advisedItem(workflow, { id: `d${index + 1}`, ...shown, options: withOutcomes, decidedBy: itemDecidedBy(workflow, options), holdsApproval: held(item) });
    return { ...numbered, ...holdsOf(numbered), answer: itemAnswer(numbered, workflow.workItem.id) };
  });
  const heldHere = items.filter((item) => item.holdsApproval).map((item) => item.id);
  const door = dirty ? holdItem(workflow, context, 'approval-hold', dirty) : null;
  if (awaiting) {
    const approval = changeStoryFirst(approvalItem(workflow, context, phase, { heldBy: [...(door ? ['d0'] : []), ...heldHere],
      youDecide: holds.filter((hold) => hold.owner === 'you-decide' && hold.clearedBy?.kind !== 'viewer-terminal').map((hold) => hold.summary),
      ownTerminal: holds.some((hold) => hold.clearedBy?.kind === 'viewer-terminal' && hold.owner === 'you-decide') }), facts.changeStory);
    // The approval starts from the card too: its row opens the review page [owner, 2026-11-13].
    const advised = advisedItem(workflow, { id: `d${items.length + 1}`, ...approval, decidedBy: itemDecidedBy(workflow, approval.options), holdsApproval: false });
    items.push({ ...advised, answer: { where: 'card', words: `Open it from the Decide card (/sf-decide ${workflow.workItem.id}), which opens its documents to review and approve; or /sf-approve ${phase.id}.` } });
  }
  const boundItems = items.map((item) => (item.kind === 'approval' ? { ...item, details: { ...item.details, heldBy: heldHere, ready: !heldHere.length } } : item));
  // Nothing waits on these: a review of the scope, each convergence answer its approvers may change [SCS:REQ-034], and each
  // reviewer's finding its author fixes unless someone disputes it. Each is `optional` [owner, 2026-11-20: ask a person only
  // what waits on them]: a row on the card and the list, never a question a chat asks, never counted as one.
  const offered = [...(facts.completeness ? [completenessItem(workflow, context, facts.completeness)] : []),
    ...(facts.convergence ? convergenceAnswerItems(workflow, context, facts.convergence) : []),
    ...reviewFindingItems(workflow, context, facts.reviewDisputes), ...checkFindingItems(workflow, context, facts.findingOverrides)].map((item) => underGuard(workflow, item)).map((item, index) => advisedItem(workflow, { id: `d${items.length + index + 1}`, ...item,
    optional: true,
    options: item.options.map((entry) => ({ ...entry, outcome: optionOutcome(item, entry), outcomeWords: DECISION_OUTCOMES[optionOutcome(item, entry)] })),
    decidedBy: itemDecidedBy(workflow, item.options), holdsApproval: false, holds: 'nothing', holdsWords: HOLDS_WORDS.nothing }))
    .map((item) => ({ ...item, answer: itemAnswer(item, workflow.workItem.id) }));
  // Settled for you: numbered after everything else, so no item's number changes when one is settled or undone. No
  // recommendation: each says to undo it only if it is wrong, and its Undo says what undoing does (decision-advice.mjs).
  const settled = settledItems(workflow, context).map((item, index) => advisedItem(workflow, { id: `d${items.length + offered.length + index + 1}`, ...item,
    options: item.options.map((entry) => ({ ...entry, outcome: optionOutcome(item, entry), outcomeWords: DECISION_OUTCOMES[optionOutcome(item, entry)] })),
    // History has nothing to decide: nobody undoes it here, and every host says why in these words.
    decidedBy: item.options.length ? itemDecidedBy(workflow, item.options) : { groups: [], labels: [], allowed: false, words: 'Nothing to undo here: its step has moved on.' },
    holdsApproval: false, holds: 'nothing', holdsWords: HOLDS_WORDS.nothing }))
    .map((item) => ({ ...item, answer: item.details?.history ? { where: 'later', words: 'Nothing to answer, and nothing to undo here: its step has moved on.' }
      : { where: 'card', words: `Nothing to answer. Undo it on the Decide card (/sf-decide ${workflow.workItem.id} opens it) only if it is wrong; a chat never asks it.` } }));
  if (door) {
    const advised = advisedItem(workflow, { id: 'd0', ...door, decidedBy: itemDecidedBy(workflow, door.options), holdsApproval: true, holds: 'approval', holdsWords: HOLDS_WORDS.approval });
    items.unshift({ ...advised, answer: itemAnswer(advised, workflow.workItem.id) });
  }
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
    // An undo from a card that showed another settlement is refused like any changed list.
    ...(settled.length ? { settled: settled.map(decidedHere) } : {}),
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
  // Every count reads the item's own `holds`, the same holds the approval and the submission check [decision map, finding 1].
  const stopsStep = (item) => (awaiting ? item.holds === 'approval' : ['this-step', 'submission', 'step-completion'].includes(item.holds));
  const holdingAll = decisions.filter(stopsStep).length;
  const others = decisions.filter((item) => !stopsStep(item));
  const headline = !decisions.length && awaiting ? `${stepName(workflow, phaseId)} has nothing left to decide; its approval is next.`
    : !others.length ? decisionHeadline(workflow, phaseId, decisions.length)
      : holdingAll ? `${decisionHeadline(workflow, phaseId, holdingAll)} ${laterWords(others, { others: true, step: stepName(workflow, phaseId) }).replace(/^./u, (first) => first.toUpperCase())}`
        : `${stepName(workflow, phaseId)} has ${others.length === 1 ? '1 open decision' : `${others.length} open decisions`}: ${laterWords(others, { step: stepName(workflow, phaseId) })}`;
  // What to do next: the first item that holds the approval; with none, the approval itself; before
  // submission, what stops the step, then whatever is left.
  // An item nobody can take yet is never the next thing to do.
  // A sign-off whose screenshot the person takes now, on the card or in their terminal, is something to do now.
  const shoots = (item) => item.check?.kind === 'screenshot' && typeof item.check.command === 'string';
  const takenNow = (item) => item.options.some((entry) => entry.available !== false) || shoots(item);
  const first = items.find((item) => item.holdsApproval) ?? (awaiting ? items.at(-1) : items.find(stopsStep) ?? items.find(takenNow) ?? items[0]);
  // A sign-off and any choice this list records are answered on a host's card, which /sf-decide opens: no
  // route read as "no verified equivalent". A host with no card asks with `card: false`, where /sf-decide
  // would only show them again: a command no skill runs (a witness, an obligation risk), a choice a
  // /sf-decide turn may not record (an accepted test command), or a hold's route with its own skill.
  // The card takes a sign-off's screenshot ("Take the screenshot"), so it is never theirs alone where there is a card: a route
  // said "Copilot: no verified equivalent" for it while /sf-decide was exactly that route (owner, 2026-11-18).
  const theirsAlone = (item) => !(card && shoots(item)) && (Boolean(item.routeSkill) || item.options.length > 0 && item.options.every((entry) => (entry.available === false || entry.recordable === false
    ? entry.available === false || typeof entry.action?.command === 'string' && commandLineWithoutSkill(entry.action.command) && !(card && entry.action.humanReview)
    : !card && !DECISION_LIST_CHAT_OPTIONS.includes(entry.id) && !entry.chat)));
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
    ...(settled.length ? { settled } : {}),
    // More settled than the card lists: one line per group, each settlement with its own undo behind it [C3].
    ...(settledDecisions(workflow).filter((entry) => !entry.undone).length > SETTLED_SHOWN ? { settledGroups: settledLedger(workflow) } : {}),
    ...(facts.inactiveTestCommands?.length ? { inactiveTestCommands: facts.inactiveTestCommands } : {}),
    // With its VS Code route: the Decide card for the list itself, never "not available" beside it (paid run, 2026-11-14).
    next: first && !takenNow(first) ? { item: first.id, kind: first.kind, title: first.title, notYet: first.options[0]?.words ?? first.why,
      command: `singularity-flow nextsteps ${workId} --json`, copilotCommand: `/sf-next ${workId}` }
      : first ? ((command) => ({ item: first.id, kind: first.kind, title: first.title, command,
        copilotCommand: first.kind === 'approval' ? `/sf-approve ${phaseId} --work-id ${workId}` : first.routeSkill ? `${first.routeSkill} ${workId}` : listRoute,
        ...(modelFreeCommandForCommand(command) ? { modelFreeCommand: modelFreeCommandForCommand(command) } : {}) }))(shoots(first) && first.options[0]?.available === false ? first.check.command
        : first.options[0]?.action?.command ?? `singularity-flow decisions ${workId}`) : null,
    packetSha256: digest,
    record: {
      // In a person's own terminal it shows the summary and asks them to confirm; `packetSha256` is the digest a script passes as --confirm.
      form: `singularity-flow decisions record ${workId}${phaseOption ? ` --phase ${phaseOption}` : ''} --choose <ITEM>=<OPTION> [--reason <ITEM>=TEXT] [--expires <ITEM>=YYYY-MM-DD] [--cause <ITEM>=TEXT]`,
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
    // A short ID is the one clause it ends with; one ending several is never guessed (stage 7 run, 2026-11-15).
    const ending = known.includes(upper) ? [upper] : upper.includes(':') ? [] : known.filter((id) => id.endsWith(`:${upper}`));
    if (ending.length > 1) refused(`${item.id} names ${entry}, which could mean ${ending.join(' or ')}; name it in full.`, 'DECISIONS_ANSWER_INVALID', { item: item.id, candidates: ending });
    return ending[0] ?? upper;
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
  // An item that is not on this list was dropped without a word, or read as "you may not decide what
  // you chose" when it was the only one: name it and the items there are [agent input repairs].
  const listed = [...packet.items, ...(packet.offered ?? []), ...(packet.settled ?? [])].map((item) => item.id);
  for (const flag of ['choose', 'reason', 'expires', 'cause', 'clause', 'article']) {
    const unknown = [...(answers[flag]?.keys() ?? [])].filter((item) => !listed.includes(item));
    if (unknown.length) refused(`--${flag} names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not an item' : 'are not items'} of this list; its items are ${listed.join(', ') || 'none'}. Nothing was recorded.`,
      'DECISIONS_ANSWER_INVALID', { items: listed, unknown });
  }
  for (const item of [...packet.items, ...(packet.offered ?? []), ...(packet.settled ?? [])]) {
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
    const typed = String(answers.reason.get(item.id) ?? '').trim();
    if (selected.needs.reason) {
      const { minimum, maximum } = selected.needs.reason;
      // A reason that may be left out takes the option's own when left blank, as a card sends it: only the recommended choice
      // has one [C10, 2026-11-19]. Any other blank stays blank, so a card's empty field never records SFlow's sentence.
      const reason = minimum === 0 ? (typed || String(selected.needs.reason.default ?? '').trim())
        : String(answers.reason.get(item.id) ?? selected.needs.reason.default).trim();
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
      effects: selected.effects.map((effect) => ({ ...effect })),
      // Whether the answer followed SFlow's recommendation, written with the decision [owner, 2026-11-19, Q13].
      ...(item.kind === 'settled' ? {} : { advice: adviceOf(item, selected, { typed: Boolean(typed) && Boolean(selected.needs.reason), phase: packet.phase ?? null }) }) });
  }
  // A decision on an intent amendment is its own run and its own commit [owner, 2026-11-13]: never mixed with another choice.
  const alone = steps.find((step) => step.effects.some((effect) => ALONE_EFFECTS.includes(effect.kind)));
  if (alone && answers.choose.size > 1) {
    refused(`${alone.item} decides intent amendment ${alone.effects[0].amendment}, which is recorded on its own, as its own commit. Choose only ${alone.item} and record it, then decide the rest. Nothing was recorded.`,
      'DECISIONS_CHOOSE_ALONE', { item: alone.item, chosen: [...answers.choose.keys()] });
  }
  // A route moves the Story on, so everything else on this list is written first.
  const routes = (step) => step.effects.some((effect) => effect.kind === 'routing' || (effect.kind === 'amendment-revalidation' && effect.outcome === 'return'));
  return { steps: [...steps.filter((step) => !routes(step)), ...steps.filter(routes)], refused: refusedItems };
}

/** What an item was about, as the advice record names it: its departure, issue, file or row; null when nothing names it. */
function adviceSubject(item) {
  const details = item.details ?? {};
  return details.departure ?? details.issue ?? (details.amendment && details.phase ? `${details.amendment} ${details.phase}` : null)
    ?? item.subject ?? (details.path ? `file:${details.path}` : null) ?? details.clause ?? details.criterion ?? details.request ?? null;
}

/**
 * One answer against the item's recommendation, as the advice record keeps it [owner, 2026-11-19, Q13]: no free text, no
 * file contents, no actor (the decision's own record keeps those). `matched` is null when no single option was recommended.
 */
export function adviceOf(item, selected, { typed = false, phase = null } = {}) {
  const recommended = item.recommended ?? null;
  const option = recommended?.option ?? null;
  return { kind: item.kind, subject: adviceSubject(item), phase: item.details?.phase ?? phase,
    recommended: { form: recommended?.form ?? (option ? 'option' : recommended ? 'lean' : 'none'), option },
    chosen: { option: selected.id, outcome: selected.outcome ?? null }, matched: option ? option === selected.id : null,
    reason: !selected.needs?.reason ? 'none' : typed ? 'typed' : selected.needs.reason.recommended ? 'recommendation' : 'default' };
}

/** One record a plan writes, in plain words with its record kind, for summaries and reports. */
export function effectWords(workflow, effect, values = {}) {
  if (effect.kind === 'amendment-revalidation') {
    return effect.outcome === 'unchanged' ? `record that ${stepName(workflow, effect.phase)} still holds under ${effect.amendment} (amendment still-holds record)`
      : `return the Story to ${stepName(workflow, effect.phase)} after ${effect.amendment} (amendment still-holds record and return)`;
  }
  if (effect.kind === 'intent-amendment-decision') {
    return effect.decision === 'approve' ? `approve ${effect.amendment}${effect.raise ? ` as ${CLASS_LABEL[effect.raise] ?? effect.raise}` : ''}: the approved clauses change and the steps that cite them reopen (intent amendment decision)`
      : `reject ${effect.amendment}: the approved clauses stay as they are (intent amendment decision)`;
  }
  if (effect.kind === 'intent-amendment-refresh') {
    return `reject ${effect.amendment} and propose the same change again against the step as it is now (intent amendment refresh)`;
  }
  if (effect.kind === 'intent-amendment-acknowledge') return `acknowledge ${effect.amendment} (intent amendment acknowledgement)`;
  if (effect.kind === 'asked-for-note') return `keep instruction ${effect.instruction} of ${stepName(workflow, effect.phase)} as a note, not a request (instruction account)`;
  if (effect.kind === 'settled-undo') return `undo ${effect.settled}, so it is a question for a person again (undo of a settled decision)`;
  if (effect.kind === 'review-dispute') return `dispute the reviewer's finding ${effect.finding} on ${stepName(workflow, effect.phase)} version ${effect.generation} with your reason; it no longer blocks the step (review dispute)`;
  if (effect.kind === 'finding-override') return `override the check's finding ${effect.finding} on ${stepName(workflow, effect.phase)} version ${effect.generation} with your reason (finding override)`;
  if (effect.kind === 'forward-amendment-decision') return effect.decision === 'approve'
    ? `approve ${effect.amendment}: the corrected document becomes ${stepName(workflow, effect.phase)}'s next version (forward amendment decision)`
    : `reject ${effect.amendment}: ${stepName(workflow, effect.phase)} keeps its approved document (forward amendment decision)`;
  if (effect.kind === 'witness-exception-renewal') return `renew ${stepName(workflow, effect.phase)}'s witness exception${effect.clauseId ? ` for ${clauseName(workflow, effect.clauseId)}` : ''} until ${values.expires} (witness exception renewal)`;
  if (effect.kind === 'refactor-behaviour') return effect.choice === 'keep'
    ? `keep the old behaviour: ${stepName(workflow, effect.phase)} version ${effect.generation} restores it (refactor behaviour)`
    : `accept the new behaviour: ${stepName(workflow, effect.phase)} goes back to the plan and the task becomes a change (refactor behaviour)`;
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
    // A changed answer names the one it replaces, which the record keeps [SCS:REQ-034].
    const replaces = effect.replaces ? `, in place of ${words({ disposition: effect.replaces.disposition })}${effect.replaces.actor ? ` from ${effect.replaces.actor}` : ''}, which the record keeps` : '';
    return `${answers.map((answer) => `${words(answer)} (${answer.itemId})`).join(', ')}${replaces} (convergence adjudication, as story adjudicate --answers records it)`;
  }
  if (effect.kind === 'node-pin') return `${effect.replaces ? `change ${effect.file} from ${effect.replaces} to ${effect.version}` : `create ${effect.file} holding ${effect.version}`} and list it as a supporting change, ${effect.class} (Node pin and plan amendment)`;
  if (effect.kind === 'scope-disposition') return `record scope item ${effect.item} as ${effect.disposition}${values.clause?.length ? `, carried by ${values.clause.map((id) => clauseName(workflow, id)).join(', ')}` : ''} (scope decision)`;
  if (effect.kind === 'completeness-review') return 'record that you reviewed the scope for completeness (completeness review)';
  if (effect.kind === 'applicability') return `record that ${effect.responsibility} does not apply to this Story (applicability decision)`;
  if (effect.kind === 'routing') return `send the Story ${effect.to ? (effect.to === 'end' ? 'to its end' : `to ${stepName(workflow, effect.to)}`) : `by route ${effect.option}`} (routing decision)`;
  const what = { 'accept-risk': `accept it as a risk until ${values.expires}`, dismiss: 'dismiss it',
    return: effect.joins ? `fix it in the redo of ${stepName(workflow, effect.issuePhase)} already under way (${effect.joins})` : `return the work to ${stepName(workflow, effect.issuePhase)}` }[effect.outcome] ?? effect.outcome;
  return `${what} (decision on ${effect.issue ?? 'the new upstream issue'})`;
}

/**
 * Write a plan's effects in order through `apply(effect, step, produced, batch)`, which records one effect (`batch`: the
 * steps one write records together, when there are several)
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
        const record = await apply(effect, batch[0], {}, batch);
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
