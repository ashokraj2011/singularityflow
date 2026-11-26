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
    case 'refactor-behaviour':
      return `Keep the old behaviour that ${step} changed?`;
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
      return `Was "${clip(String(details.text ?? title).replace(/\s+/gu, ' ').trim(), 80)}" a request for a change?`;
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
    case 'review-finding':
      return `Dispute the reviewer's finding ${details.finding} on ${step} version ${details.generation}?`;
    case 'check-finding':
      return `Override the check's finding ${details.code} on ${step} version ${details.generation}?`;
    // One approval question everywhere, by step and version (owner, 2026-11-19): "Approve Requirements v1?".
    case 'approval':
      return `Approve ${step}${Number.isSafeInteger(details.generation) && details.generation > 0 ? ` v${details.generation}` : ''}?`;
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
    case 'refactor-behaviour':
      return (details.failing ?? []).length ? `${capital(bare(listWords(details.failing)))} passed before the change and ${details.failing.length === 1 ? 'fails' : 'fail'} now.`
        : `The code changes what ${listWords(details.tests ?? [])} ${(details.tests ?? []).length === 1 ? 'expects' : 'expect'}.`;
    case 'owed-decision':
      if (details.scopeItem) return 'Every statement in the scope needs a clause or a reason before the Story can end.';
      if (details.responsibility) return details.declaredReason ? `The workflow leaves it out: ${bare(plainSentence(details.declaredReason, { words: 20 }))}.`
        : 'This Story leaves it out, and it can\'t end until someone says why.';
      // What is signed off and why, as the person says it [owner, 2026-11-18]: "Sign off AC-002, the layout
      // structure: tests can't check how it looks, so a person confirms it before Implementation is approved."
      if (details.clause) return signOffWhy(workflow, item);
      return plainSentence(item.why);
    case 'plan-accounting':
      return details.path ? `${details.path} changed, and no row of the plan names it.` : plainSentence(item.why);
    case 'test-run-risk':
      return `Its latest run stopped on what looks like this machine, not the change${waits ? `; ${waits}` : ''}.`;
    case 'scope-completeness':
      return 'Nothing waits on it; it records that you looked for what is missing or unclear.';
    case 'review-finding':
      return `The reviewer found: ${clip(bare(details.message ?? ''), 160)}. Its author fixes it unless you dispute it.`;
    case 'check-finding':
      return `The check found: ${clip(bare(details.message ?? ''), 160)}. Its author fixes it unless you override it.`;
    case 'approval': {
      // Each disputed finding of its review, with who disputed it and why, beside the approval [owner, 2026-11-20].
      const disputed = details.disputes?.length ? ` ${details.disputes.map((entry) => entry.words).join(' ')} Return the step if you agree with the reviewer.` : '';
      return details.ready ? `Nothing on this list holds it; its documents are ready to review${details.covers?.length ? `, with ${details.covers.map((entry) => `${entry.label} v${entry.generation}`).join(', ')}, which SFlow approved when ready` : ''}.${disputed}` : `It waits for the questions above.${disputed}`;
    }
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

/** A slot's name as people say it: "layout-structure" is "the layout structure"; a one-word name says nothing more. */
const slotWords = (slot) => (/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(String(slot ?? '')) ? `the ${String(slot).replaceAll('-', ' ')}` : null);

/** A sign-off's one line: what is signed off, why a person does it, and what waits for it. */
function signOffWhy(workflow, item) {
  const details = item.details ?? {};
  const named = slotWords(details.slot);
  const what = `Sign off ${clauseName(workflow, details.clause)}${named ? `, ${named}` : ''}`;
  const looks = details.method === 'visual' ? 'tests can\'t check how it looks' : 'tests can\'t check this file';
  const step = stepName(workflow, (details.owners ?? []).at(-1) ?? details.phase ?? workflow?.currentPhase);
  const before = ['approval', 'approval-later'].includes(item.holds) ? ` before ${step} is approved` : item.holds === 'story-end' ? ' before the Story ends' : '';
  // Its screenshot comes first: the person brings the screen up in SFlow's browser and captures it.
  return checkOf(item) ? `${what}: ${looks}, so you capture its screen and confirm it${before}.` : `${what}: ${looks}, so a person confirms it${before}.`;
}

/** The "Waiting:" line of an item that is not this person's: who decides it, else why nobody here can. */
function waitingLine(workflow, item) {
  // What the person typed waits for the step's own agent: who, in plain words, and whether a new version opens for it.
  if (item.kind === 'asked-for') {
    const step = stepName(workflow, item.details?.phase ?? workflow?.currentPhase);
    return `"${clip(String(item.details?.text ?? '').replace(/\s+/gu, ' ').trim(), 60)}": ${step}'s agent says how it handles it while writing it.`;
  }
  const labels = item.decidedBy?.labels ?? [];
  const asked = bare(question(workflow, item));
  if (labels.length) return `${asked}: waiting on ${listWords(labels)}.`;
  const words = bare(plainSentence(item.decidedBy?.words ?? '', { words: 16 }));
  return words ? `${asked}. ${words}.` : `${asked}: waiting on someone else.`;
}

/** The check SFlow offers before an item whose answer depends on one, as its first option; null when there is none. */
const checkOf = (item) => (item.check && item.check.status !== 'checked' ? item.check : null);

/**
 * What leaving an offered item as it is does, as the choice that skips it [owner, 2026-11-20: "what does Leave undecided even
 * mean?"]: its default, never "undecided", since nothing waits on it. Every host's form names its skip with it.
 */
function skipWords(item) {
  switch (item.kind) {
    case 'review-finding': return 'Don\'t dispute (the author fixes it)';
    case 'check-finding': return 'Don\'t override (the author fixes it)';
    case 'convergence-answer': return 'Keep this answer';
    case 'convergence-settled': return 'Keep what the plan says';
    default: return 'Not now (nothing waits on it)';
  }
}

/** What an offered item lets the person do, as the one line a chat may say of it; never asked as a question. */
const OFFER_WORDS = Object.freeze({ 'review-finding': 'dispute a reviewer\'s finding you disagree with',
  'check-finding': 'override a check\'s finding the check got wrong',
  'scope-completeness': 'record that you reviewed the scope for completeness',
  'convergence-answer': 'change an answer already given', 'convergence-settled': 'overrule what the plan settled' });

/**
 * An open item's plain words: `{ question, why, recommended }`, or `{ later }` when nobody can answer it yet. An offered one
 * (`optional`) carries `skip` too: what leaving it does, its default.
 */
export function plainItem(workflow, item) {
  const waiting = later(workflow, item);
  if (waiting) return { later: waiting };
  // Not this person's to answer: one "Waiting:" line naming who, never a question they cannot answer [owner, 2026-11-18].
  if (item.kind !== 'approval' && item.decidedBy && item.decidedBy.allowed === false) return { later: waitingLine(workflow, item) };
  const check = checkOf(item);
  return { question: question(workflow, item), why: why(workflow, item), recommended: recommended(item),
    ...(check ? { check: check.label } : {}), ...(item.optional ? { skip: skipWords(item) } : {}) };
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
      case 'plan-accounting': {
        // The file and the requirement whose row took it; with either unknown, the plan itself [owner, 2026-11-20].
        const file = effect.path ?? effect.file ?? (/^file:/u.test(String(entry.subject ?? '')) ? String(entry.subject).slice(5) : null);
        const clause = effect.clauseId ? clauseName(workflow, effect.clauseId) : null;
        return file && clause ? `${who} added ${file} to ${clause}'s row of the plan because ${first ? `${first} beside it` : 'that row names a file beside it'}`
          : `${who} added ${file ?? 'a file'} to the plan${first ? ` because ${first}` : ''}`;
      }
      case 'own-correction':
        return `${who} opened a new version of ${step} to correct its own work because nobody had reviewed it yet`;
      case 'review-corrections':
        return `${who} started version ${effect.toGeneration ?? 'N'} of ${step} to fix the review's findings because only the reviewer had seen version ${effect.generation ?? 'N'}`;
      // A test step's failing tests went back to the code step on their own (owner, 2026-11-20, D1).
      case 'failing-tests':
        return `${who} started version ${effect.toGeneration ?? 'N'} of ${step} to fix the tests ${stepName(workflow, effect.testPhase)} found failing, because ${stepName(workflow, effect.testPhase)} changes no code`;
      case 'tests-rerun':
        return `${who} started version ${effect.toGeneration ?? 'N'} of ${step} to run its tests again because ${stepName(workflow, effect.codePhase)} version ${effect.codeGeneration ?? 'N'} fixed them`;
      case 'person-change':
        return `${who} went back to ${step} and started version ${effect.toGeneration ?? 'N'} for the change you asked for, because you said yes`;
      default: {
        const [what, because] = String(entry.answer ?? '').split(/:\s+/u, 2);
        return because ? `${who} chose this: ${bare(what)}, because ${bare(because)}` : `${who} chose this: ${bare(what)}`;
      }
    }
  })();
  // Its undo is forward only: the version it started stays open (owner, 2026-11-19). A finding it was started for may be
  // disputed; once every one is, its author is told not to make those fixes, and the version still stays open (2026-11-20).
  const disputed = entry.disputed?.length ? ` ${entry.disputed.join(' ')}${entry.allDisputed ? ` Its author is told not to make ${entry.disputed.length === 1 ? 'that fix' : 'those fixes'}; version ${effect.toGeneration ?? 'N'} stays open, as an open version can't be withdrawn.` : ''}` : '';
  // History: its step has moved on, so it is said, with nothing to undo [owner, 2026-11-20].
  if (entry.history) return `${capital(said)}.`;
  return entry.kind === 'review-corrections' ? `${capital(said)}. Undo only makes SFlow ask you first next time; version ${effect.toGeneration ?? 'N'} stays open. To disagree with a finding, dispute it.${disputed}`
    : ['failing-tests', 'tests-rerun'].includes(entry.kind) ? `${capital(said)}. Undo only makes SFlow ask you first next time; version ${effect.toGeneration ?? 'N'} stays open.`
      : entry.kind === 'person-change' ? `${capital(said)}. Version ${effect.toGeneration ?? 'N'} stays open.`
      : `${capital(said)}. Undo if wrong.`;
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
 * now is one with a question; what was settled is never a question, nor is what is offered beside the list (`optional`):
 * nothing waits on it [owner, 2026-11-20]. `optional` is the one line a chat may say of those: "Optional on the Decide
 * card: dispute a reviewer's finding you disagree with."
 */
export function plainPacket(items, workflow = null) {
  const open = items.filter((item) => !item.settled);
  const waits = open.filter((item) => !item.optional);
  const asked = waits.filter((item) => item.plain?.question).length;
  const nothing = workflow ? nothingToRecord(workflow, items) : null;
  // What happens once the person answers, as the list's last line [owner, 2026-11-18: always end with "Next:"].
  const approval = items.find((item) => item.kind === 'approval');
  const questions = waits.filter((item) => item.plain?.question && item.kind !== 'approval').length;
  const offers = [...new Set(open.filter((item) => item.optional && item.plain?.question).map((item) => OFFER_WORDS[item.kind]).filter(Boolean))];
  const step = workflow ? stepName(workflow, approval?.details?.phase ?? workflow.currentPhase) : null;
  const afterAnswer = !workflow || !asked ? null : !questions ? 'Once it is approved, the Story moves on to its next step.'
    : `After you answer, ${approval ? `${step}'s approval is next` : `${step} goes on`}.`;
  return { headline: plainHeadline(asked), later: open.map((item) => item.plain?.later).filter(Boolean), ...(nothing ? { nothingToRecord: nothing } : {}),
    ...(afterAnswer ? { afterAnswer } : {}), ...(offers.length ? { optional: `Optional on the Decide card: ${offers.join(', or ')}.` } : {}) };
}

/** What was settled, named in a few words: "Node 22 for Implementation's tests", "starting version 3 of Implementation". */
function settledName(workflow, item) {
  const effect = item.details?.effect ?? {};
  const step = stepName(workflow, item.details?.phase ?? workflow?.currentPhase);
  switch (item.details?.settledKind) {
    case 'node-version': return `Node ${effect.version ?? ''} for ${step}'s tests`.replace('Node  ', 'Node ');
    case 'test-command': return `${effect.commandId ?? 'the test command'} as ${step}'s tests`;
    case 'plan-accounting': return `${effect.path ?? effect.file ?? String(item.subject ?? '').replace(/^file:/u, '')} in the plan`;
    case 'review-corrections': case 'own-correction': case 'failing-tests': case 'tests-rerun': case 'person-change': return `starting version ${effect.toGeneration ?? 'N'} of ${step}`;
    case 'story-selection': return `opening ${String(item.subject ?? '').split(' on ')[0] || workflow?.workItem?.id}`;
    default: return bare(item.subject ?? item.title);
  }
}

/**
 * The one line a chat or a card's first words may say of what was settled [owner, 2026-11-20]: only what can still matter
 * (no history), named, at most three, then "and N more on the Decide page"; never a question. Null when there is none.
 */
export function settledLine(workflow, settled) {
  const names = settled.filter((item) => item.settled && !item.details?.history).map((item) => settledName(workflow, item));
  if (!names.length) return null;
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  return more ? `Settled for you: ${shown.join(', ')} and ${more} more on the Decide page. Undo any there.`
    : `Settled for you: ${listWords(shown)}. Undo any on the Decide page.`;
}

/** A settled item's record, as plainSettled reads it, from what the list carries of it. */
const settlementOf = (item) => ({ kind: item.details?.settledKind, by: item.by, subject: item.subject, answer: item.answerWords ?? item.title,
  evidence: item.details?.evidence ?? [], effect: item.details?.effect ?? {}, phase: item.details?.phase ?? null, history: item.details?.history === true,
  ...(item.details?.disputed ? { disputed: item.details.disputed, allDisputed: item.details.allDisputed === true } : {}) });

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
  const line = settledLine(workflow, settled ?? []);
  return { ...packet, plain: { ...plainPacket([...items, ...(offered ?? [])], workflow), ...(line ? { settledLine: line } : {}) }, items, ...(offered ? { offered } : {}),
    ...(settled ? { settled } : {}) };
}
