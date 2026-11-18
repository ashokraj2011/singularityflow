/**
 * Every item of the decision list in plain words, the same on every host [owner, 2026-11-16]: "why is it giving
 * something that is not clearly understood". The card counted items instead of naming them, repeated its table below
 * itself, put a sign-off nobody could give yet in a row of its own, and told the person to run a check SFlow could run
 * itself, in the engine's internal words ("stands in front of the DOM environment's under Vitest", "Holds this step").
 *
 * So each open item carries `plain`: what is asked, as a question; why, in one sentence; and "Recommended: …". An item
 * nobody can answer yet carries `plain.later` instead ("Sign off AC-001 after Implementation publishes its
 * screenshot"), and what SFlow settled for the person `plain.settled` ("SFlow opened WORK-1 because …. Undo if wrong.").
 * The packet carries `plain` too: its headline in counts a person reads, and the later lines in one place. Copilot
 * CLI's card, VS Code's Decide page and the terminal's `decisions` all print these words and nothing else of an item.
 *
 * Pure and deterministic, read from the facts the item was built from, and added where the list is read
 * (withPlainWords, decision-list-reads.mjs). Nothing here decides, preselects or records, and nothing enters the
 * list's digest.
 */
import { stepName } from './upstream-routes.mjs';

const listWords = (values) => {
  const items = [...values];
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
};
const squeeze = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();
const bare = (text) => squeeze(text).replace(/[\s.!?:;,]+$/u, '');
const capital = (text) => squeeze(text).replace(/^./u, (first) => first.toUpperCase());
const clip = (text, size) => {
  const value = squeeze(text);
  if (value.length <= size) return value;
  const cut = value.slice(0, size - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), size / 2)).replace(/[\s,;:]+$/u, '')}…`;
};
// A person's command or an internal record route is not a reason: the hosts show where to answer it themselves.
const COMMAND = /\bsingularity-flow\s|(?:^|\s)\/sf-[a-z]/u;

/**
 * The first sentence of `text` that is not a command, at most `words` words: a longer one keeps its first clause
 * (up to a ";"), and only one with no clause to stop at is cut.
 */
export function plainSentence(text, { words = 28 } = {}) {
  const sentences = squeeze(text).split(/(?<=[.!?])\s+(?=["'(A-Z0-9])/u).filter(Boolean);
  const found = sentences.find((entry) => !COMMAND.test(entry)) ?? '';
  const parts = found.split(' ');
  if (parts.length <= words) return found && !/[.!?…]$/u.test(found) ? `${found}.` : found;
  const clause = found.split(/;\s+/u)[0];
  if (clause !== found && clause.split(' ').length <= words) return `${clause.replace(/[\s,:]+$/u, '')}.`;
  return `${parts.slice(0, words).join(' ').replace(/[\s,;:]+$/u, '')}…`;
}

const clauseName = (workflow, clauseId) => {
  const prefix = `${workflow?.workItem?.id ?? ''}:`;
  return String(clauseId ?? '').toUpperCase().startsWith(prefix.toUpperCase()) ? String(clauseId).slice(prefix.length) : String(clauseId ?? '');
};
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/iu;
/** What a sign-off is about, as a person says it: "the screenshot", a file's name, or "its evidence". */
// A visual sign-off with no file yet is about a screenshot too: SFlow takes it (visual-sign-off-capture.mjs).
const evidenceName = (files = [], method = '') => (files.length === 1 ? (IMAGE.test(files[0]) || method === 'visual' ? 'the screenshot' : files[0])
  : files.length ? 'the files' : method === 'visual' ? 'the screenshot' : 'its evidence');
const evidenceNoun = (files = [], method = '') => ((files.length === 1 && IMAGE.test(files[0])) || (files.length < 2 && method === 'visual') ? 'its screenshot'
  : files.length > 1 ? 'its files' : 'its evidence');

/** What blocks while it waits, in one clause: "Implementation can't be approved" or "the Story can't end". */
function waitsWords(workflow, item) {
  const step = stepName(workflow, item.details?.phase ?? workflow?.currentPhase);
  switch (item.holds) {
    case 'this-step': return `${step} can't be published until it is decided`;
    case 'submission': return 'the Story can\'t end until it is decided';
    case 'step-completion': return `${step} can't be submitted until it is decided`;
    case 'approval': case 'approval-later': return `${step} can't be approved until it is decided`;
    case 'story-end': return 'the Story can\'t end until it is decided';
    case 'story': return 'nothing else begins until it is decided';
    case 'nothing-yet': return 'nothing waits on it until a test run fails';
    default: return null;
  }
}

/** The question an item asks, by its kind; an unknown kind asks its title. */
function question(workflow, item) {
  const details = item.details ?? {};
  const step = stepName(workflow, details.phase ?? workflow?.currentPhase);
  const title = bare(item.title);
  switch (item.kind) {
    case 'node-pin':
      return details.replaces ? `Change ${details.file} to Node ${details.version} for ${step}'s tests?` : `Run ${step}'s tests on Node ${details.version}?`;
    case 'owed-decision':
      if (details.scopeItem) return details.statement ? `Is "${clip(details.statement, 120)}" part of this Story?` : `Is scope item ${details.scopeItem} part of this Story?`;
      if (details.responsibility) return `Does ${details.responsibility} apply to this Story?`;
      if (details.clause) return `Does ${evidenceName(details.files, details.method)} show what ${clauseName(workflow, details.clause)} asks for?`;
      return `${title}?`;
    case 'evidence-obligation':
      return item.options.some((entry) => entry.action?.humanReview || /^witness-/u.test(entry.id))
        ? `Does the evidence show what ${clauseName(workflow, details.criterion)} asks for?` : `Accept ${clauseName(workflow, details.criterion)}'s missing evidence as a risk?`;
    case 'plan-accounting':
      return details.path ? `Which requirement does ${details.path} serve?` : `Where does this test setup belong in the plan: ${listWords(details.paths ?? [])}?`;
    case 'departure':
      // A fix names what it fixes from the findings register, first [CQF:REQ-066].
      if ((details.findings ?? []).length) return `Keep the fix for ${listWords(details.findings)} (${details.departure})?`;
      return details.path && details.departureKind === 'path' ? `Where does ${details.path} belong?` : `Keep this change (${details.departure}): ${clip(title.replace(/^[A-Z]+-\d+:\s*/u, ''), 120)}?`;
    case 'test-run-risk':
      return `Accept that ${details.commandId} can't run here, until a date?`;
    case 'test-narrowing':
      return `Accept the narrowed run of ${details.commandId}?`;
    case 'test-command':
      return /^Stop running/u.test(title) ? `${title}?` : /^Re-pin/u.test(title) ? `Use the changed ${details.command?.id ?? 'test'} command for ${step}?`
        : `Run ${details.command?.id ?? 'this command'} as ${step}'s tests for this Story?`;
    case 'visual-profile':
      return `Capture a screenshot at ${details.label ?? 'this screen size'}?`;
    case 'conformance-gap': {
      const names = listWords((details.clauses ?? []).map((id) => clauseName(workflow, id))) || title;
      return (details.differences ?? []).some((entry) => entry.difference) || ['deviated', 'contradicted'].some((verdict) => (details.verdicts ?? []).includes(verdict))
        ? `${names}: is the code or the clause right?` : `Accept ${names} as ${listWords(details.verdicts ?? []) || 'reported'}, or send it back?`;
    }
    case 'upstream-issue':
      return `${title}: is it real?`;
    case 'convergence-item':
      return `${title}: is the code or the approved document right?`;
    case 'convergence-answer':
      return `Change the answer for ${title.replace(/, answered .*$/u, '')}?`;
    case 'convergence-settled':
      return `Overrule what the plan says for ${title.replace(/: settled by the plan.*$/u, '')}?`;
    case 'scope-completeness':
      return 'Record that you reviewed the scope for completeness?';
    case 'asked-for':
      return `Has what was asked been accounted for: ${clip(String(details.text ?? title), 120)}?`;
    case 'routing-decision':
      return `Where does the Story go next: ${clip(title.replace(/^Choose where .*? goes after [^:]+:\s*/u, ''), 120)}?`;
    case 'intent-amendment':
      return details.status === 'approved' ? `Acknowledge intent amendment ${details.amendment ?? ''}?`.replace(' ?', '?') : `Approve intent amendment ${details.amendment ?? title.replace(/^Decide intent amendment /u, '')}?`;
    case 'forward-amendment':
      return `Approve forward amendment ${details.amendment ?? title.replace(/^Decide forward amendment /u, '')}?`;
    case 'revalidation':
      return `Does ${stepName(workflow, details.phase)} still hold after ${details.amendment}?`;
    case 'appeal':
      return `${title}?`;
    case 'generation-rollover':
      return `${title}?`;
    case 'approval':
      return `Approve ${step}?`;
    // A refusal's own route: what clears it, asked of what it says.
    case 'approval-hold':
      return `Clear this first: ${title}?`;
    default:
      return /[?]$/u.test(squeeze(item.title)) ? squeeze(item.title) : `${title}?`;
  }
}

/** Why it is asked, in one sentence, from the item's facts. */
function why(workflow, item) {
  const details = item.details ?? {};
  const waits = waitsWords(workflow, item);
  switch (item.kind) {
    case 'node-pin':
      return details.cause ? `${capital(bare(details.cause))}.` : plainSentence(item.why);
    case 'owed-decision':
      if (details.scopeItem) return 'Every statement in the scope needs a clause or a reason before the Story can end.';
      if (details.responsibility) return details.declaredReason ? `The workflow leaves it out: ${bare(plainSentence(details.declaredReason, { words: 20 }))}.`
        : 'This Story leaves it out, and it can\'t end until someone says why.';
      // SFlow takes the screenshot first, when the person asks for it; then they look at it [owner, 2026-11-18].
      if (details.clause && checkOf(item)) return `SFlow takes the screenshot of what was published first, then you look at it and sign it off${waits ? `; ${waits}` : ''}.`;
      if (details.clause) return `A person must look at it and sign it off${waits ? `; ${waits}` : ''}.`;
      return plainSentence(item.why);
    case 'plan-accounting':
      return details.path ? `${details.path} changed, and no row of the plan names it.` : plainSentence(item.why);
    case 'test-run-risk':
      return `Its latest run stopped on what looks like this machine, not the change${waits ? `; ${waits}` : ''}.`;
    case 'scope-completeness':
      return 'Nothing waits on it; it records that you looked for what is missing or unclear.';
    case 'approval':
      return details.ready ? 'Nothing on this list holds it; its documents are ready to review.' : 'It waits for the questions above.';
    default:
      return plainSentence(item.why);
  }
}

const label = (option) => bare(option?.label ?? '');

/** "Recommended: …", always: an option, a check to run first, or what to do. */
function recommended(item) {
  const advice = item.recommended;
  if (!advice) return null;
  // An approval waits on what is above it; the item numbers it names are no words for a person.
  if (item.kind === 'approval' && item.details?.ready === false) return 'Recommended: Answer the questions above first; the approval waits for them.';
  const reason = plainSentence(advice.why, { words: 24 });
  if (advice.check && item.check) return `Recommended: ${item.check.kind === 'screenshot' ? item.check.label : 'Check first'}. ${reason}`.trim();
  const option = advice.option ? item.options.find((entry) => entry.id === advice.option) : null;
  if (option) return `Recommended: ${label(option)}. ${reason}`.trim();
  return `Recommended: ${capital(reason || 'decide it on its own facts.')}`;
}

/** The later line of an item nobody can answer yet, or null. */
function later(workflow, item) {
  const live = item.options.filter((entry) => entry.available !== false);
  // A check SFlow runs when asked (a screenshot to take) is something the person can do now.
  if (live.length || !item.options.length || checkOf(item)) return null;
  const details = item.details ?? {};
  // SFlow cannot take the screenshot: the person's own, saved where SFlow would have saved it, is asked here.
  if (item.kind === 'owed-decision' && details.clause && details.capture?.status === 'unavailable') {
    return `Sign off ${clauseName(workflow, details.clause)} once its screenshot is saved as ${details.capture.file}: SFlow cannot take it (${bare(details.capture.reason)}).`;
  }
  if (item.kind === 'owed-decision' && details.clause) {
    const steps = (details.owners ?? []).map((id) => stepName(workflow, id));
    return `Sign off ${clauseName(workflow, details.clause)} after ${listWords(steps) || 'its step'} ${steps.length > 1 ? 'publish' : 'publishes'} ${evidenceNoun(details.files, details.method)}.`;
  }
  return `${bare(item.title)}: ${bare(plainSentence(item.options[0]?.words ?? item.why, { words: 20 })).replace(/^./u, (first) => first.toLowerCase())}.`;
}

/** The check SFlow offers before an item whose answer depends on one, as its first option; null when there is none. */
const checkOf = (item) => (item.check && item.check.status !== 'checked' ? item.check : null);

/** An open item's plain words: `{ question, why, recommended }`, or `{ later }` when nobody can answer it yet. */
export function plainItem(workflow, item) {
  const waiting = later(workflow, item);
  if (waiting) return { later: waiting };
  const check = checkOf(item);
  return { question: question(workflow, item), why: why(workflow, item), recommended: recommended(item),
    ...(check ? { check: check.label } : {}) };
}

/**
 * What SFlow or the agent settled for the person, in one line [owner, 2026-11-16]: "SFlow chose <what> because <why>.
 * Undo if wrong." From the settlement record itself: its kind, answer, effect and evidence.
 */
export function plainSettled(workflow, entry) {
  const who = entry.by === 'agent' ? 'The agent' : 'SFlow';
  const effect = entry.effect ?? {};
  const first = entry.evidence?.[0]?.what ? bare(entry.evidence[0].what) : null;
  const step = stepName(workflow, entry.phase ?? workflow?.currentPhase);
  const said = (() => {
    switch (entry.kind) {
      case 'story-selection': {
        const workId = String(entry.subject ?? '').split(' on ')[0] || workflow?.workItem?.id;
        return `${who} opened ${workId} because its branch is the one checked out here`;
      }
      case 'node-version':
        return `${who} pinned Node ${effect.version ?? ''} for ${step}'s tests because ${first ?? 'the repository asks for it'}`.replace('Node  ', 'Node ');
      case 'test-command':
        return `${who} chose ${effect.commandId ?? 'the declared test command'} as ${step}'s tests because it is the only one the repository declares`;
      case 'plan-accounting':
        return `${who} added ${effect.path ?? 'the file'} to ${clauseName(workflow, effect.clauseId)}'s row of the plan because ${first ?? 'that row names the file beside it'} beside it`;
      case 'own-correction':
        return `${who} opened a new version of ${step} to correct its own work because nobody had reviewed it yet`;
      default: {
        const [what, because] = String(entry.answer ?? '').split(/:\s+/u, 2);
        return because ? `${who} chose this: ${bare(what)}, because ${bare(because)}` : `${who} chose this: ${bare(what)}`;
      }
    }
  })();
  return `${capital(said)}. Undo if wrong.`;
}

/** "One question for you." / "3 questions for you." / "Nothing waits on you now.", from what is asked now. */
export function plainHeadline(asked) {
  return !asked ? 'Nothing waits on you now.' : asked === 1 ? 'One question for you.' : `${asked} questions for you.`;
}

/** Whether this person can do something about an open item now: a choice to record, a check, a review or their own step. */
function actionable(item) {
  if (!item.decidedBy?.allowed) return false;
  if (checkOf(item)) return true;
  return item.options.some((entry) => entry.available !== false && entry.decidedBy?.allowed !== false
    && (entry.recordable !== false || entry.action?.command || entry.action?.humanReview));
}

/**
 * When nothing open is this person's to act on now, why, in one line, with what its approval waits for: the Decide
 * card offered "Review and record" over a list nothing on could be recorded, and clicking it did nothing visible
 * [owner, 2026-11-18]. Null when something is theirs to do, or nothing is open.
 */
export function nothingToRecord(workflow, items) {
  const open = items.filter((item) => !item.settled && item.kind !== 'approval');
  if (!open.length || open.some(actionable)) return null;
  const why = open.map((item) => item.plain?.later
    ?? (item.decidedBy?.allowed ? `${bare(item.plain?.question ?? item.title)}: ${bare(plainSentence(item.options[0]?.words ?? item.why, { words: 24 }))}.`
      : `${bare(item.plain?.question ?? item.title)}: ${bare(item.decidedBy?.words || 'someone else decides it')}.`));
  const approval = items.find((item) => item.kind === 'approval' && item.details?.heldBy?.length);
  const held = approval ? ` Approving ${stepName(workflow, approval.details?.phase ?? workflow?.currentPhase)} waits for ${open.length === 1 ? 'it' : 'them'}.` : '';
  return `Nothing here can be recorded yet. ${why.join(' ')}${held}`;
}

/**
 * The list's own plain words: its headline from what is asked now, and every later line in one place. An item asked
 * now is one with a question; what was settled is never a question.
 */
export function plainPacket(items, workflow = null) {
  const open = items.filter((item) => !item.settled);
  const asked = open.filter((item) => item.plain?.question).length;
  const nothing = workflow ? nothingToRecord(workflow, items) : null;
  return { headline: plainHeadline(asked), later: open.map((item) => item.plain?.later).filter(Boolean), ...(nothing ? { nothingToRecord: nothing } : {}) };
}

/** A settled item's record, as plainSettled reads it, from what the list carries of it. */
const settlementOf = (item) => ({ kind: item.details?.settledKind, by: item.by, subject: item.subject, answer: item.answerWords ?? item.title,
  evidence: item.details?.evidence ?? [], effect: item.details?.effect ?? {}, phase: item.details?.phase ?? null });

/**
 * The list with every item's plain words and its own (`plain`), as `decisions` reads it for every host. Applied where
 * the list is read (decision-list-reads.mjs), so the pure builder and what loads it eagerly stay as they were; what a
 * person confirms, the digest, is unchanged.
 */
export function withPlainWords(workflow, packet) {
  const word = (item) => ({ ...item, plain: item.settled ? { settled: plainSettled(workflow, settlementOf(item)) } : plainItem(workflow, item) });
  const items = (packet.items ?? []).map(word);
  const offered = packet.offered ? packet.offered.map(word) : null;
  const settled = packet.settled ? packet.settled.map(word) : null;
  return { ...packet, plain: plainPacket([...items, ...(offered ?? [])], workflow), items, ...(offered ? { offered } : {}), ...(settled ? { settled } : {}) };
}
