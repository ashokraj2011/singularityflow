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
import { recordSha256 } from './records.mjs';
import { testRunRiskAuthorities } from './test-run-risk.mjs';
import { decisionGroups, decisionRefusalLead } from './decision-list-facts.mjs';
import { CONFORMANCE_GAP_RULE, decisionHeadline, issueNamesClause, stepName } from './upstream-routes.mjs';
import { SingularityFlowError } from './util.mjs';

export { decisionGroups, decisionHeadline, decisionRefusalLead, stepName };
export const DECISION_LIST_REVISION = 'decision-list-v1';
/** Options that write only upstream-issue records (a raise needs no authority; a decision needs its step's approvers). */
export const ISSUE_ONLY_OPTIONS = Object.freeze(['accept-risk', 'dismiss', 'return']);
export const DEFAULT_RISK_DAYS = 30;
const MAX_RISK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
// The order a chosen option's records are written in: an issue exists before it is decided.
const EFFECT_ORDER = Object.freeze(['upstream-issue', 'evidence-reuse', 'test-run-risk', 'visual-profile', 'upstream-issue-decision']);
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
  const words = unavailable
    ? `Nobody can decide this yet: ${stepName(workflow, unavailable.effect.issuePhase ?? unavailable.effect.phase)} has no approval group.`
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

function returnLegal(workflow, ownerPhase) {
  const current = workflow?.phases?.[workflow?.currentPhase];
  const order = workflow?.phaseOrder ?? [];
  return Boolean(current) && ['in_progress', 'awaiting_approval'].includes(current.status)
    && order.indexOf(ownerPhase) >= 0 && order.indexOf(ownerPhase) < order.indexOf(current.id);
}

/** One item for a conformance gap, with the open upstream issue that names its clauses when there is one. */
function gapItem(workflow, context, group) {
  const { issue, owner, gaps } = group;
  const clauses = gaps.map((gap) => gap.clauseId);
  const names = listWords(clauses.map((clause) => clauseName(workflow, clause)));
  const verdicts = [...new Set(gaps.map((gap) => gap.verdict))];
  const reports = [...new Set(gaps.map((gap) => gap.report))];
  const reportWords = listWords(reports.map((id) => `${stepName(workflow, id)} report`));
  const isAre = clauses.length === 1 ? 'is' : 'are';
  const ownerName = stepName(workflow, owner);
  const candidate = coveringCandidate(context.facts.candidates, clauses);
  const problem = context.facts.reuseProblems?.find((entry) => clauses.some((clause) => (entry.clauses ?? []).some((id) => sameClause(id, clause))))
    ?? context.facts.reuseProblems?.[0] ?? null;
  const why = [`The ${reportWords} marks ${names} ${listWords(verdicts)}; ${ownerName} delivered ${clauses.length === 1 ? 'it' : 'them'}.`];
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
      commands: (gaps.flatMap((gap) => gap.choices ?? []).map((choice) => choice.command).filter(Boolean)) }
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
      commands: [`singularity-flow upstream-issue decide ${issue.id} --work-id ${workflow.workItem.id} --outcome plan-correction|amend|return|accept-risk|dismiss --reason "<why>"`] }
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

/** One item for a test command of a step whose latest run stopped before any test executed. */
function testRiskItem(workflow, context, risk) {
  const name = stepName(workflow, risk.phase);
  const stopped = risk.status === 'blocked' ? 'was blocked' : 'failed';
  const exit = Number.isInteger(risk.exitCode) ? ` (exit code ${risk.exitCode})` : '';
  return {
    kind: 'test-run-risk',
    title: `${name}'s tests could not run here (${risk.commandId})`,
    why: `The latest run of ${risk.commandId} ${stopped} before any test ran${exit}, so it says nothing about the change.`
      + `${risk.lapsed ? ` An earlier acceptance ${risk.lapsed === 'expired' ? 'expired' : 'was revoked'}.` : ''}`
      + ' Fix the environment and run it again, or accept the risk until a date: the tests still run every time, and a run in which tests fail is never covered.',
    options: [option(workflow, context, {
      id: 'accept-test-risk', label: 'Accept that these tests cannot run here, until a date',
      words: 'The run stays failed; it is never counted as a pass.',
      effects: [{ kind: 'test-run-risk', phase: risk.phase, commandId: risk.commandId, argvSha256: risk.argvSha256 ?? null, attemptId: risk.attemptId ?? null }],
      needs: { cause: textNeed(`No test ran: the latest run of ${risk.commandId} ${stopped} before any test executed${exit}.`, CAUSE),
        reason: textNeed(`The tests of ${risk.commandId} run again at every publication and submission; this environment cannot run them now.`, REASON),
        expires: expiryNeed(context.at, { endOfDay: true }) }
    })],
    details: { phase: risk.phase, commandId: risk.commandId, attemptId: risk.attemptId ?? null, status: risk.status, exitCode: risk.exitCode ?? null,
      commands: [`singularity-flow decision test-risk ${workflow.workItem.id} --phase ${risk.phase} --command ${risk.commandId} --cause "<what stops it>" --reason "<why>" --expires <YYYY-MM-DD>`] }
  };
}

/** The commands a person or script uses to record, with the packet digest. */
export function decisionRecordCommand(workId, { phaseId = null, choices = [], digest, values = {} } = {}) {
  // POSIX single quotes, as canonicalDisplayToken in safe-command-guidance.mjs: a JSON double-quoted
  // reason would still expand `$()`, `$NAME` and backticks when the person pastes the command.
  const quote = (value) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`);
  const extra = Object.entries(values).flatMap(([flag, entries]) => Object.entries(entries ?? {})
    .map(([item, value]) => `--${flag} ${quote(`${item}=${value}`)}`));
  return ['singularity-flow decisions record', workId, ...(phaseId ? [`--phase ${phaseId}`] : []),
    ...choices.map(([item, chosen]) => `--choose ${item}=${chosen}`), ...extra, `--confirm ${digest}`].join(' ');
}

/**
 * The packet: items, the digest over exactly what a person confirms (items, options, effects, the
 * defaults they would record, and the Story state they depend on), and the record commands.
 * `context`: { authorities, actor, at, requestedPhase }.
 */
export function decisionPacket(workflow, facts, { authorities, actor, at, requestedPhase = null } = {}) {
  const context = { workflow, facts, authorities, actor, at };
  const groups = decisionGroups(workflow, { gaps: facts.gaps, issues: facts.issues, includeAllIssues: facts.endsStory === true });
  const built = [
    ...groups.map((group) => (group.kind === 'conformance-gap' ? gapItem(workflow, context, group) : issueItem(workflow, context, group.state))),
    ...(facts.visual ?? []).map((entry) => visualItem(workflow, context, entry)),
    ...(facts.testRisks ?? []).map((risk) => testRiskItem(workflow, context, risk))
  ];
  const items = built.map((item, index) => {
    // Recommended first, then in the order built.
    const options = [...item.options].sort((left, right) => Number(right.recommended) - Number(left.recommended));
    return { id: `d${index + 1}`, ...item, options, decidedBy: itemDecidedBy(workflow, options) };
  });
  const workId = workflow.workItem.id;
  const phaseId = facts.phaseId;
  const bound = {
    revision: DECISION_LIST_REVISION, workId, phase: phaseId, at: String(at).slice(0, 10),
    items: items.map(({ id, kind, title, why, options, details }) => ({ id, kind, title, why, details,
      options: options.map(({ id: optionId, label, recommended, effects, needs, decidedBy: who }) => ({ id: optionId, label, recommended, effects, needs, groups: who.groups })) })),
    state: facts.state ?? null
  };
  const digest = `sha256:${recordSha256(bound)}`;
  const phaseOption = requestedPhase && requestedPhase !== workflow.currentPhase ? phaseId : null;
  const recommended = items.filter((item) => item.decidedBy.allowed).map((item) => [item.id, item.options.find((entry) => entry.recommended && entry.decidedBy.allowed)?.id])
    .filter(([, chosen]) => chosen);
  const headline = decisionHeadline(workflow, phaseId, items.length);
  return {
    schemaVersion: 1, resultType: 'sflow-decisions', revision: DECISION_LIST_REVISION,
    workId, phase: phaseId, phaseLabel: stepName(workflow, phaseId), status: items.length ? 'decisions-needed' : 'nothing-to-decide',
    headline, rule: CONFORMANCE_GAP_RULE,
    items,
    packetSha256: digest,
    record: {
      form: `singularity-flow decisions record ${workId}${phaseOption ? ` --phase ${phaseOption}` : ''} --choose <ITEM>=<OPTION> [--reason <ITEM>=TEXT] [--expires <ITEM>=YYYY-MM-DD] [--cause <ITEM>=TEXT] --confirm ${digest}`,
      recommended: recommended.length ? decisionRecordCommand(workId, { phaseId: phaseOption, choices: recommended, digest }) : null,
      interactive: `singularity-flow decisions record ${workId}${phaseOption ? ` --phase ${phaseOption}` : ''}`,
      share: `/sf-decide ${workId}`
    },
    ...(facts.unavailable?.length ? { unavailable: facts.unavailable } : {})
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
        ? `${item.id}=${chosen} is your action, not a recorded decision: take the screenshot and run ${selected.action.command}`
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
