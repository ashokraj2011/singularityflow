/**
 * What every item of the decision list recommends, and what each of its choices does to the Story, in one
 * plain line each [owner, 2026-11-13]: "Decisions are really confusing", because a card asked a question
 * with no recommended answer and no idea what each choice does. Every item carries `recommended`
 * ({ option, why, words }) and every option `does`; an item a person may answer yes or no in chat carries
 * `chatYesNo` and `yesNo`.
 *
 * Deterministic and model-free: a recommendation is read from the facts the item was built from (its
 * kind, details and options), never guessed. Every item recommends [owner, 2026-11-16]: where no one option
 * is right whatever the facts, it says which one to pick when ("Recommended: fix the code if the clause says
 * what the product should do; otherwise update the spec"), and where the answer depends on a check SFlow can
 * run itself (decision-probes.mjs), it recommends from that check's result, or "Check first" until it has one.
 * Nothing here chooses, preselects or records anything, and nothing enters the list's digest: what a person
 * confirms is the option they pick, under the same checks as before.
 */
import { personClass } from './person-change-class.mjs';
import { stepName } from './upstream-routes.mjs';

const listWords = (values) => {
  const items = [...values];
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
};
const clauseName = (workflow, clauseId) => {
  const prefix = `${workflow?.workItem?.id ?? ''}:`;
  return String(clauseId ?? '').toUpperCase().startsWith(prefix.toUpperCase()) ? String(clauseId).slice(prefix.length) : String(clauseId ?? '');
};
// The first sentence of an option's own words, for a choice no rule below describes.
const firstSentence = (text) => String(text ?? '').split(/(?<=[.!?])\s/u)[0].trim();

/** "opens generation 3 of Implementation; generation 2 and its evidence stay": what returning work to a step does. */
export function reopenWords(workflow, phaseId) {
  const phase = workflow?.phases?.[phaseId];
  const now = Number(phase?.generation ?? 0);
  const next = Math.max(now, Number(phase?.generationHighWatermark ?? 0)) + 1;
  return `opens generation ${next} of ${stepName(workflow, phaseId)}${now ? `; generation ${now} and its evidence stay` : ''}, and the steps after it run again`;
}

const until = (entry) => (entry.needs?.expires ? `until ${entry.needs.expires.default} (or the day you choose)` : 'until the day you choose');

const SCOPE_DOES = Object.freeze({
  included: 'Records that the clause you name states it; this Story delivers it through that clause.',
  existing: 'Records that the product already does it, verified by the clauses you name; this Story changes nothing for it.',
  excluded: 'Records it as outside this Story, with your reason; nothing delivers it.',
  deferred: 'Records it for later work, with your reason; this Story does not deliver it.',
  informative: 'Records that it informs and asks for nothing; nothing delivers it.',
  duplicate: 'Records that another statement already says it; that one is decided instead.',
  superseded: 'Records that a later statement replaces it; the later one is decided instead.'
});

const CONVERGENCE_DOES = Object.freeze({
  rework: 'Sends it back to fix: once every item is decided, the Story returns to the code step and the code changes to match the approved documents.',
  'update-intent': 'Changes the spec: the clauses you name are amended to match the code, and their approvers decide that amendment.',
  'accepted-deviation': 'Accepts it as is: the difference stays with your reason, and the clause keeps its wording.',
  dismissed: 'Not a real finding: nothing changes, and the record keeps your reason.',
  deferred: 'Decides it later: nothing changes now, and it is asked again.'
});

function planChangeWords(workflow, change) {
  return change.kind === 'add-location' ? `adds ${change.path} to ${clauseName(workflow, change.clauseId)}'s row of the plan`
    : `lists ${change.path} in the plan as a supporting change`;
}

/** What one choice does to the Story, in one plain line. */
export function optionDoes(workflow, item, entry) {
  if (typeof entry.does === 'string' && entry.does) return entry.does;
  const effects = entry.effects ?? [];
  const kinds = effects.map((effect) => effect.kind);
  const decision = effects.find((effect) => effect.kind === 'upstream-issue-decision');
  const reuse = effects.find((effect) => effect.kind === 'evidence-reuse');
  if (reuse) {
    return `${stepName(workflow, reuse.recordedBy)}'s recorded run counts for ${stepName(workflow, reuse.phase)}: no new run and nothing reset${decision
      ? `; the reported problem is accepted as a risk ${until(entry)}` : ''}.`;
  }
  if (decision) {
    if (decision.outcome === 'accept-risk') return `Accepted as a risk ${until(entry)}: the verdict stays as written, tests still run, and it is asked again after that day.`;
    if (decision.outcome === 'dismiss') return 'Closed as not a real problem, with your reason kept in the history; nothing else changes.';
    if (decision.outcome === 'return') return `Returns the work to ${stepName(workflow, decision.issuePhase)}: ${reopenWords(workflow, decision.issuePhase)}.`;
  }
  const [effect] = effects;
  switch (effect?.kind) {
    case 'intent-amendment-draft':
      return `Writes a draft of ${stepName(workflow, effect.phase)}'s spec change to finish and propose; nothing is recorded or decided yet.`;
    case 'test-run-risk':
      return `Accepted ${until(entry)}: the tests still run at every publication and submission, and this run stays failed, never a pass.`;
    case 'test-narrowing':
      return `The narrowed run counts for ${stepName(workflow, effect.phase)}; a run narrowed further, or under a changed pin, is refused again.`;
    case 'test-command':
      return `${item.details?.command?.id ?? 'This command'} becomes ${stepName(workflow, effect.phase)}'s tests for this Story; they run at every publication and submission and must pass.`;
    case 'visual-profile':
      return `${item.details?.label ?? 'This screen size'} is recorded as not applying to this Story; every other screen size is still checked.`;
    case 'plan-amendment': {
      const words = (effect.changes ?? [effect.change]).filter(Boolean).map((change) => planChangeWords(workflow, change));
      return `${listWords(words).replace(/^./u, (first) => first.toUpperCase())}; the code and its tests stay as they are, and no step is reset.`;
    }
    case 'node-pin':
      return `${effect.replaces ? `Changes ${effect.file} from ${effect.replaces} to Node ${effect.version}` : `Creates ${effect.file} with Node ${effect.version}`} and adds it to the plan; the code stays the same.`;
    case 'obligation-risk':
      return `The evidence reads as excepted ${until(entry)}; the verdict does not change, and a changed result needs a new decision.`;
    case 'scope-disposition':
      return SCOPE_DOES[effect.disposition] ?? 'Records the disposition with your reason.';
    case 'completeness-review':
      return 'Records your answers against this exact inventory; a later change to the scope makes the review no longer current. Nothing waits on it.';
    case 'applicability':
      return `Records that ${effect.responsibility} does not apply to this Story; the Story can then end without it.`;
    case 'departure': {
      const kind = effect.departureKind ?? item.details?.departureKind;
      if (effect.decision === 'reject') {
        return ['path', 'supporting'].includes(kind) ? 'The model restores the changed files to what they held when this generation began: the change is undone.'
          : kind === 'finding' ? 'The fix is taken out, and the findings it fixed are open again.' : 'The approved document stays as it was, and the change is undone.';
      }
      if (effect.writes === 'plan-amendment' && effect.changes?.length) {
        // A named row that cannot take the files is left out, and the words say so [owner, 2026-11-19].
        const leftOut = kind === 'path' && item.details?.leftOut?.words ? ` ${item.details.leftOut.words}` : '';
        return `${listWords(effect.changes.map((change) => planChangeWords(workflow, change))).replace(/^./u, (first) => first.toUpperCase())}; the change stays and no step is reset.${leftOut}`;
      }
      if (effect.writes === 'forward-amendment') return 'The earlier step\'s approved document is amended to this wording as its next version; each later step that read it is listed to be checked again.';
      // The exact rows, as the card shows them before a person keeps them [owner, 2026-11-19].
      if (effect.writes === 'plan-row-correction') return `${firstSentence(entry.words)} No step is reset.`;
      if (effect.writes === 'departure-acceptance') return 'The fix stays and the plan is unchanged; the findings it fixes await proof once the step is approved.';
      return 'The change stays, and the plan records it; no step is reset.';
    }
    case 'convergence-adjudication':
      return CONVERGENCE_DOES[effect.disposition] ?? firstSentence(entry.words);
    case 'intent-amendment-decision':
      return effect.decision === 'approve' ? 'The approved clauses change as shown, and the steps that cite them reopen.'
        : 'The approved clauses stay as they are, and every submission stays valid.';
    case 'intent-amendment-refresh':
      return 'Rejects this proposal and proposes the same change again against the step as it is now; the scope\'s approvers decide that one.';
    case 'intent-amendment-acknowledge':
      return 'Records that you read it; the steps it reopened can then be submitted again.';
    case 'review-dispute':
      return `Records your dispute of ${effect.finding} with your reason: it no longer blocks ${stepName(workflow, effect.phase)}, its author is told not to make that fix, and its approvers see why.`;
    case 'finding-override':
      return `Records your override of ${effect.finding} with your reason: it stops blocking this version and shows as overridden, never passed.`;
    case 'amendment-revalidation':
      return effect.outcome === 'unchanged' ? `${stepName(workflow, effect.phase)}'s approval stands, bound to the amended document; nothing runs again.`
        : `Returns the Story to ${stepName(workflow, effect.phase)}: ${reopenWords(workflow, effect.phase)}.`;
    case 'routing':
      return effect.to ? (effect.to === 'end' ? 'Finishes the Story here.' : `The Story goes to ${stepName(workflow, effect.to)} next.`)
        : `The Story takes this route: ${entry.label}.`;
    case 'settled-undo':
      // Undoing what was settled for the person hands its question back on its own route (settled-decisions.mjs).
      return `Makes it your question again: ${entry.words ?? 'it is asked on its own route.'}`;
    default:
      break;
  }
  if (kinds.length) return firstSentence(entry.words) || entry.label;
  // A person's own step: what taking it does.
  if (entry.id === 'capture') return 'You capture the screenshot at this size and record it; the visual check then has its evidence.';
  if (entry.action?.humanReview) {
    const files = entry.action.humanReview.files ?? [];
    return `Records your sign-off once you look at ${files.length ? listWords(files) : 'the file'} and answer its three checks; ${clauseName(workflow, entry.action.humanReview.clauseId)} is then proven for this change.`;
  }
  if (entry.id === 'sync') return 'Publishes what did not land; nothing is decided.';
  if (/^choose-/u.test(entry.id)) return `The Story takes this route once you choose it in your own terminal: ${entry.label}.`;
  return firstSentence(entry.words) || entry.label;
}

// Each recommendation says its form, which the advice record keeps [owner, 2026-11-19, Q13]: one named option, what to do
// first, a lean (which option when) or a check SFlow runs first.
const rec = (item, optionId, why) => {
  const entry = item.options.find((candidate) => candidate.id === optionId);
  return entry ? { option: entry.id, form: 'option', why, words: `Recommended: ${entry.label.replace(/[.!?]+$/u, '')}. ${why}` } : null;
};
// A step that is not one of the choices, said as what to do first.
const first = (why) => ({ option: null, form: 'first', why, words: `Recommended first: ${why}` });
// No one choice is right whatever the facts: which one, when [owner, 2026-11-16]. Still a recommendation.
const lean = (advice) => ({ option: null, form: 'lean', why: advice, words: `Recommended: ${advice.replace(/^./u, (letter) => letter.toUpperCase())}` });
// The answer depends on a check SFlow runs itself, which has no result for this code yet: the check comes first.
const checkFirst = (why) => ({ option: null, form: 'check', check: true, why, words: `Recommended: Check first. ${why}` });
const live = (item) => item.options.filter((entry) => entry.available !== false);

/**
 * The answer SFlow recommends for one item, from the facts it was built from, or why it recommends none. An option the
 * builder already marked recommended (a recorded run on unchanged code, an issue a run already covers, a stale amendment
 * to refresh) is the recommendation, with the reason those facts give.
 */
export function itemRecommendation(workflow, item) {
  if (item.recommended && typeof item.recommended === 'object') return item.recommended;
  const options = live(item);
  const details = item.details ?? {};
  const marked = options.find((entry) => entry.recommended === true);
  const only = options.length === 1 ? options[0] : null;
  // A sign-off whose screenshot SFlow takes when asked: taking it comes first [owner, 2026-11-18].
  if (item.kind === 'owed-decision' || item.kind === 'evidence-obligation') {
    if (item.check?.kind === 'screenshot' && item.check.status !== 'checked') {
      return checkFirst(item.check.failed ? `${firstSentence(item.check.failed)} Take it again once that is fixed.` : 'SFlow opens what was published; you bring up the screen and capture it, then sign it off.');
    }
  }
  if (!options.length) return lean(item.options[0]?.words ? firstSentence(item.options[0].words) : 'answer it once it can be answered.');
  switch (item.kind) {
    case 'conformance-gap': {
      if (marked?.id === 'reuse' && details.reuse) {
        return rec(item, 'reuse', `${stepName(workflow, details.reuse.recordedBy)}'s recorded run on unchanged code covers ${listWords((details.clauses ?? []).map((id) => clauseName(workflow, id)))}; nothing has to run again.`);
      }
      if (options.some((entry) => entry.id === 'correct-report')) return rec(item, 'correct-report', 'The recorded evidence reads every clause satisfied, so the report is what to look at again, not the step before it.');
      if (details.draft && options.some((entry) => entry.id === 'update-spec')) return rec(item, 'update-spec', 'A draft of the spec change for these clauses is already written; writing it as the code does it and proposing it is next.');
      if (details.differences?.length) {
        return lean('fix the code if the clause says what the product should do; otherwise update the spec. Accept it for now only if both can differ until a date.');
      }
      if (options.some((entry) => entry.id === 'return')) {
        return rec(item, 'return', `The report marks it ${listWords(details.verdicts ?? [])} and no recorded run covers it, so ${stepName(workflow, details.owner)} delivers it again. Accept the risk only if the Story may ship without it until a date.`);
      }
      return lean(`accept it as a risk only if the Story may ship with ${listWords((details.clauses ?? []).map((id) => clauseName(workflow, id)))} ${listWords(details.verdicts ?? [])} until a date; dismiss it if the gap is not real.`);
    }
    case 'upstream-issue': {
      if (marked?.id === 'accept-risk') return rec(item, 'accept-risk', 'The recorded run already accepted for a later step covers it; nothing is left unproven.');
      const proposed = details.proposed === 'accept-risk' ? 'accept-risk' : details.proposed === 'return' ? 'return' : null;
      if (proposed && options.some((entry) => entry.id === proposed)) return rec(item, proposed, `The step that reported it proposed ${proposed === 'return' ? 'returning the work' : 'accepting it as a risk'}.`);
      if (details.status === 'expired' && options.some((entry) => entry.id === 'return')) {
        return rec(item, 'return', `Its accepted risk ended and the problem is still open, so ${stepName(workflow, details.phase)} corrects it.`);
      }
      return lean('return the work if the reported problem is real, and dismiss it if it is not; accept it as a risk only if the Story may ship with it until a date.');
    }
    case 'visual-profile':
      return options.some((entry) => entry.id === 'capture')
        ? rec(item, 'capture', 'A screenshot at this size is the evidence the visual check asks for. Say it does not apply only if the change never ships at this size.')
        : lean('say it does not apply only if the change never ships at this screen size.');
    case 'node-pin':
      // From SFlow's own check of this code on that Node (decision-probes.mjs), never from the Node's number.
      return details.tried === true ? rec(item, 'pin-node', `Tests pass on Node ${details.version} (checked).`)
        : details.tried === false ? lean(`leave it: tests fail on Node ${details.version} too (checked), so the Node is not the cause.`)
          : checkFirst(details.probe?.cutShort ? `The check did not finish within ${details.probe.seconds} second${details.probe.seconds === 1 ? '' : 's'}.`
            : `Whether the tests pass on Node ${details.version} is not known yet.`);
    case 'test-run-risk': {
      // From SFlow's own run of the same command on the commit this Story started from (`tests base`) [owner, 2026-11-16].
      const base = details.base;
      const step = stepName(workflow, details.phase);
      if (base?.status === 'checked' && base.verdict === 'fails-on-base') {
        return rec(item, 'accept-test-risk', 'It fails without this change too (checked), so the change is not the cause.');
      }
      if (base?.status === 'checked' && base.verdict === 'passes-on-base') {
        return lean(`don't accept it: it passes without this change (checked), so repair it in ${step}.`);
      }
      if (base?.status === 'checked' && base.verdict === 'partly-on-base') {
        return lean(`repair what fails only with this change in ${step}; the rest fails without it too (checked).`);
      }
      if (base && base.status !== 'checked') {
        return checkFirst(base.cutShort ? `The check did not finish within ${base.seconds} second${base.seconds === 1 ? '' : 's'}.`
          : `Whether it fails without this change too is not known yet.`);
      }
      return first(`fix the environment and run ${details.commandId ?? 'the tests'} again. Accept it only if this environment cannot run them before the date: the run stays failed either way.`);
    }
    case 'test-narrowing':
      return first(`remove the narrowing and run ${details.commandId ?? 'the tests'} again. Accept it only if the narrowed run covers everything this step changed.`);
    case 'test-command': {
      if (options.some((entry) => entry.id === 'return-step-first')) return rec(item, 'return-step-first', 'Accepting it while the step awaits approval would make that review stale.');
      if (details.repin?.dropped) return lean(`accept it only if the tests it drops no longer apply (${firstSentence(details.repin.dropped).replace(/\.$/u, '')}).`);
      if (details.repin) return rec(item, 'accept-test-command', 'Only this Story\'s pin changes, and its tests must still pass.');
      return lean(`accept it if ${details.command?.id ?? 'this command'} runs the tests that prove this step.`);
    }
    case 'evidence-obligation': {
      const sign = options.find((entry) => entry.action?.humanReview || /^witness-/u.test(entry.id));
      if (sign) return rec(item, sign.id, 'Looking at the evidence and signing it off proves the criterion; a risk leaves it unproven until the date.');
      return lean('choose the risk category that fits; the verdict stays as written whichever you choose.');
    }
    case 'owed-decision': {
      if (details.responsibility) {
        return details.declaredReason
          ? rec(item, 'does-not-apply', `The workflow says why: ${firstSentence(details.declaredReason).replace(/\.+$/u, '')}. Record it if that holds for this Story.`)
          : lean(`record it only if ${details.responsibility} truly does not apply to this Story.`);
      }
      if (details.scopeItem) {
        return lean('included, naming its clause, if this Story delivers it; already in the product if it did that before; otherwise exclude or defer it.');
      }
      const sign = options.find((entry) => entry.id === 'witness');
      return sign ? rec(item, 'witness', 'It is the only way this criterion is proven for this change.')
        : lean('sign it off once its evidence is published.');
    }
    case 'plan-accounting': {
      // A dependency, a build, CI or runner configuration, or governance metadata is weighed by a person [owner, 2026-11-19, C3].
      const files = details.paths ?? (details.path ? [details.path] : []);
      const weighed = files.find((file) => personClass(file));
      if (weighed) {
        const named = personClass(weighed);
        return lean(`list ${weighed} as a supporting change only if this change needs it (${named.words.replace(/, so a person decides it\.$/u, '').replace(/^It /u, 'it ').replace(/\.$/u, '')}); otherwise add it to the row it serves.`);
      }
      const supporting = options.find((entry) => entry.id === 'supporting');
      if (supporting) return rec(item, 'supporting', 'It is a supporting file (its kind serves no single requirement), so it belongs in the plan as a supporting change.');
      if (only) return rec(item, only.id, 'The plan has one row it can join.');
      return lean(`add ${details.path ?? 'it'} to the row of the requirement it serves.`);
    }
    case 'departure': {
      if (details.status === 'reopened') return lean('it changed again after it was accepted: accept it only if the change still belongs in this Story.');
      const accept = options.find((entry) => entry.id === 'accept');
      if (accept && details.departureKind === 'finding') return rec(item, 'accept', 'It fixes findings from the register; rejecting it opens them again.');
      // A row change recorded without what the row becomes: the kind its own reason names [office laptop, 2026-11-19].
      if (marked && /^accept-/u.test(marked.id) && ['plan-row', 'test'].includes(details.departureKind)) {
        return rec(item, marked.id, 'The departure\'s own reason names what the row becomes; choose another if it should become something else.');
      }
      // A new dependency, a build, CI or runner configuration, or governance metadata is weighed, never waved through
      // [owner, 2026-11-19, C3]: which answer depends on whether the change needs it.
      if (accept && details.departureKind === 'supporting' && ['dependency', 'build', 'governance'].includes(details.personClass)) {
        return lean(details.personClass === 'dependency' ? 'accept it if the change needs this third-party code and its version; reject it to undo it.'
          : details.personClass === 'build' ? 'accept it if the change needs this build, CI or test configuration and it runs no fewer tests; reject it to undo it.'
            : 'accept it if this change to who reviews the repository, or what runs when it opens, belongs in this Story; reject it to undo it.');
      }
      if (accept && details.departureKind === 'supporting') return rec(item, 'accept', 'It is a supporting file the change needs; accepting lists it in the plan, and no step is reset.');
      if (accept && details.departureKind === 'path' && details.clauses?.length) {
        const kept = details.clauses.filter((id) => !(details.leftOut?.clauses ?? []).includes(id));
        return rec(item, 'accept', `The code step names ${listWords(kept.map((id) => clauseName(workflow, id)))} as what it serves; accepting adds it to the plan, and no step is reset.`);
      }
      // No row of the plan can take its files: Accept is not offered, and keeping them needs the scope to change first.
      if (details.departureKind === 'path' && !options.some((entry) => /^accept/u.test(entry.id))) {
        return lean('reject it to undo the change, unless the scope should change so a row of the plan can take these files.');
      }
      return lean('accept it if the change belongs in this Story; reject it to undo it.');
    }
    case 'convergence-item': {
      const found = ['absent-observed-claim', 'failing-bound-test', 'missing-bound-test', 'missing-required-evidence', 'stale-claim-binding'];
      if ((details.itemKinds ?? []).length && details.itemKinds.every((kind) => found.includes(kind)) && options.some((entry) => entry.id === 'rework')) {
        return rec(item, 'rework', 'Convergence found it in the records themselves: the code does not show what the approved documents say.');
      }
      return lean('send it back to fix if the approved documents are right; change the spec if the code is.');
    }
    case 'convergence-answer':
      return lean('keep it: it is already answered; change it only if you disagree.');
    case 'convergence-settled':
      return lean('keep what the approved plan says; answer only if you disagree.');
    case 'scope-completeness':
      return lean('record it only after you looked for what is missing, ambiguous or unmeasurable; nothing waits on it.');
    case 'asked-for':
      if (details.typed === 'unsure') return lean('say it was not a request if it asked for no change; otherwise the agent writing the step handles it.');
      return only ? rec(item, only.id, `What you typed is handled before the step's ${workflow?.phases?.[details.phase]?.approvalPolicy?.mode === 'none' ? 'submission, which completes it' : 'approval'}; only the agent writing it can say how.`) : lean('the agent writing the step handles it.');
    case 'routing-decision': {
      const routes = options.filter((entry) => /^choose-/u.test(entry.id));
      // A decision that enforces its recorded conditions offers only the route they choose, and the earlier steps it may reopen:
      // its advice names those, never "move on as it is", which is not offered there [limit audit, item 12].
      if (details.reason === 'limit' && routes.length === 1) {
        const reopen = options.filter((entry) => /^to-/u.test(entry.id));
        return lean(`all its rounds are used, and it offers only "${routes[0].label}"${reopen.length ? `; or reopen ${listWords(reopen.map((entry) => `"${entry.label}"`))}` : ''}.`);
      }
      if (details.reason === 'limit') return lean('move on as it is unless another round would clearly help: all its rounds are used.');
      if (routes.length === 1) return rec(item, routes[0].id, 'It is the route the recorded values choose.');
      return lean(`choose the route the Story's state fits: ${listWords(routes.map((entry) => `"${entry.label}"`))}.`);
    }
    case 'intent-amendment': {
      if (details.status === 'approved') return rec(item, 'acknowledge', 'It is approved already; once you acknowledge it, the steps it reopened can be submitted again.');
      if (marked?.id === 'refresh') return rec(item, 'refresh', 'The Story moved on after it was proposed, so it cannot be approved as it is; refreshing proposes the same change against the step as it is now.');
      return lean('approve it only if the approved clauses should change as shown; approving reopens the steps that cite them.');
    }
    case 'forward-amendment':
      return only ? rec(item, only.id, 'Only an approver of that step decides it; the Story cannot end until they do.') : lean('approve it if the corrected document is right.');
    case 'revalidation':
      // D1 [CIC:REQ-021]: still holds when its document names neither the changed clauses its prompt held nor their paths, else redo.
      if (details.reason === 'prompt-held') return rec(item, details.recommend === 'return' ? 'return-step' : 'still-holds', details.because);
      return lean(`say ${stepName(workflow, details.phase)} still holds if what it was built and checked against reads the same under the amended document.`);
    case 'appeal':
      return only ? rec(item, only.id, 'An approver of the plan reviews the exact diff; nothing else accounts for the scope.') : lean('review the exact diff; account for it only if the changes belong in scope.');
    // A dispute goes against the reviewer, so it is never recommended [owner, 2026-11-20].
    case 'review-finding':
      return lean('dispute it only if the reviewer is wrong; otherwise its author fixes it, and nothing needs your answer.');
    // An override goes against the check, so it is never recommended either [owner, 2026-11-23].
    case 'check-finding':
      return lean('override it only if the check is wrong; otherwise its author fixes it, and nothing needs your answer.');
    case 'generation-rollover':
      // Starting the version is asked on its own (its preview's question): this row only leaves the change out.
      if (details.asked) return lean(`answer the question about version ${details.next} first; leave the change out only if it does not belong in this step.`);
      return details.requested ? rec(item, 'start-next-generation', 'The person asked for this change after the step was published.')
        : (details.paths ?? []).length === 1 ? lean(`keep ${details.paths[0]} in a new version if it belongs in this step; otherwise set it aside.`)
          : lean(`keep ${listWords(details.paths ?? []) || 'the changed files'} in a new version if they belong in this step; otherwise set them aside.`);
    case 'approval':
      return details.ready ? rec(item, 'approve', 'Nothing on this list holds it, and its checks are recorded: review the documents and approve.')
        : first(`decide ${listWords(details.heldBy ?? [])} above; the approval waits for ${details.heldBy?.length === 1 ? 'it' : 'them'}.`);
    default:
      // A refusal's own route, what SFlow publishes itself, a person's own step: the one way forward.
      return only ? rec(item, only.id, firstSentence(item.why) || 'It is the one way this clears.') : marked ? rec(item, marked.id, firstSentence(marked.words) || 'SFlow marks it recommended.')
        : lean('pick the choice whose effect below fits this Story.');
  }
}

/**
 * Whether a chat may ask this item as a plain yes or no [owner, 2026-11-13]: every choice it offers is one a chat
 * records with the person's own typed answer (`chat.command`, bound by copilot-answer-binding.mjs), it needs only a
 * reason, and it is one choice (yes, or leave it) or an accept beside a reject (yes or no). A generation rollover is
 * asked by its step's own skill, as it is today. Anything else is answered on the Decide card.
 *
 * An amendment's "still holds" row, an SCS revalidation or a CIC D1 question [owner, 2026-11-14]: yes is "still holds"
 * (`unchanged`) and no is "redo" (`return`), each with its own revalidate command; the question says which answer is
 * recommended and why, in one line. A row SF Guard signs carries no chat command, so it is never asked here.
 */
export function yesNoOf(workflow, item) {
  // Offered beside the list, nothing waits on it: a chat never asks it [owner, 2026-11-20].
  if (item.settled || item.machine || item.optional) return null;
  if (item.kind === 'generation-rollover') {
    const start = item.options.find((entry) => entry.id === 'start-next-generation' && entry.available !== false);
    return start && item.details?.chatRoute ? { question: `${start.label}?`, yes: start.id, no: null, route: item.details.chatRoute } : null;
  }
  if (item.kind === 'revalidation') return stillHoldsYesNo(workflow, item);
  if (['approval', 'routing-decision', 'convergence-item', 'convergence-answer', 'convergence-settled', 'scope-completeness'].includes(item.kind)) return null;
  const options = live(item);
  if (!options.length || options.length > 2 || !options.every((entry) => entry.chat?.command)) return null;
  if (options.some((entry) => entry.needs?.clause || entry.needs?.article || entry.needs?.expires || entry.needs?.cause)) return null;
  if (options.length === 2 && !options.some((entry) => entry.id === 'reject')) return null;
  const yes = options.find((entry) => entry.id !== 'reject');
  // Reject alone is no yes or no: the item says why there is nothing to accept (a departure no row of the plan can take).
  if (!yes) return null;
  const no = options.find((entry) => entry.id === 'reject') ?? null;
  // The question names its row, as the answer binding reads it (a departure's ID, a responsibility, a path), says which answer
  // is recommended and why, and asks for a reason only on the side that takes one [owner, 2026-11-14; C10, 2026-11-19].
  const advice = item.recommended ?? itemRecommendation(workflow, item);
  const said = advice?.option === yes.id ? ` Recommended: yes. ${advice.why}` : no && advice?.option === no.id ? ` Recommended: no. ${advice.why}` : '';
  return { question: `${String(item.title ?? '').replace(/[.!?]+$/u, '')}. ${yes.label.replace(/[.!?]+$/u, '')}?${said.replace(/\s*$/u, '')}${reasonWords(options, { yes, no })}`, yes: yes.id, no: no?.id ?? null,
    route: `/sf-decide ${workflow?.workItem?.id ?? '<WORK-ID>'}` };
}

/**
 * " Say why in at least 20 characters.": the longest minimum the answers' reasons take, or '' when none needs one. When only
 * one side takes a reason (the other is the recommended one, which needs none), it names that side [C10, 2026-11-19].
 */
function reasonWords(options, { yes = null, no = null } = {}) {
  const minimum = (entry) => Number(entry?.needs?.reason?.minimum ?? 0);
  const most = Math.max(0, ...options.map(minimum));
  if (!most) return '';
  if (yes && no && !minimum(yes) !== !minimum(no)) return ` ${minimum(yes) ? 'A yes' : 'A no'} says why in at least ${most} characters.`;
  if (yes && !no && !minimum(yes)) return '';
  return ` Say why in at least ${most} characters.`;
}

function stillHoldsYesNo(workflow, item) {
  const options = live(item);
  const outcome = (entry) => (entry.effects ?? []).find((effect) => effect.kind === 'amendment-revalidation')?.outcome;
  const yes = options.find((entry) => outcome(entry) === 'unchanged');
  const no = options.find((entry) => outcome(entry) === 'return');
  if (options.length !== 2 || !yes?.chat?.command || !no?.chat?.command) return null;
  const advice = itemRecommendation(workflow, item);
  const said = advice.option === yes.id ? `Recommended: yes. ${advice.why}` : advice.option === no.id ? `Recommended: no, redo it. ${advice.why}` : advice.words;
  // The step by its name, and by its ID where the name does not say it, so the answer binding reads which row this is.
  const phase = String(item.details?.phase ?? '');
  const name = stepName(workflow, phase);
  const plain = (text) => String(text).toLowerCase().replace(/[-_\s]+/gu, ' ').trim();
  const shown = plain(name).includes(plain(phase)) ? name : `${name} (${phase})`;
  return { question: `Does ${shown} still hold after ${item.details?.amendment}? ${said.replace(/\s*$/u, '')}${reasonWords(options, { yes, no })}`, yes: yes.id, no: no.id,
    route: `/sf-decide ${workflow?.workItem?.id ?? '<WORK-ID>'}` };
}

/**
 * One item with its recommendation, each option's effect, and its yes-or-no form when it has one. What was settled for
 * the person recommends nothing: it is no question, its own words say to undo it only if it is wrong, and its Undo
 * says what undoing does.
 */
export function advisedItem(workflow, item) {
  const options = item.options.map((entry) => ({ ...entry, does: optionDoes(workflow, item, entry) }));
  const advised = { ...item, options };
  // What was settled is never a chat question: nothing waits on it, and its undo is on the Decide card [owner, 2026-11-20:
  // a chat asked "Undo: ask me instead for all 6" with no way to keep them].
  if (item.settled) return { ...advised, chatYesNo: false };
  const recommended = itemRecommendation(workflow, advised);
  // The reasons are settled before the question is asked: its words say which side takes one (C10).
  const reasoned = { ...advised, options: reasonOptional(item, options, recommended), recommended };
  const yesNo = yesNoOf(workflow, reasoned);
  return { ...reasoned, chatYesNo: Boolean(yesNo), ...(yesNo ? { yesNo } : {}) };
}

/**
 * Effects that record an exception [owner, 2026-11-19, C10, kind 3]: an accepted risk, a dated exception, a narrowed or
 * failed run that counts, a responsibility or screen size that does not apply, a finding accepted, a difference accepted
 * as it is. Recommended or not, the person says why in their own words, on every surface. Reusing a recorded run on
 * unchanged code is no exception (owner 2026-11-06), unless it also accepts a risk.
 */
const EXCEPTION_EFFECTS = new Set(['obligation-risk', 'test-run-risk', 'test-narrowing', 'finding-risk', 'visual-profile', 'applicability', 'review-dispute', 'finding-override']);
export function exceptionOption(entry) {
  if (entry?.needs?.expires) return true;
  return (entry?.effects ?? []).some((effect) => EXCEPTION_EFFECTS.has(effect.kind) || effect.outcome === 'accept-risk'
    || (effect.kind === 'convergence-adjudication' && effect.disposition === 'accepted-deviation'));
}

// What a reason may be left out for: an item that commits the Story or decides an exception or verdict (kinds 2 to 4).
// An intent amendment's decision (kind 1) keeps its own optional reason, and an approval takes none.
const OWN_REASON_KINDS = new Set(['intent-amendment', 'approval', 'settled']);
export const RECOMMENDATION_REASON = 'Followed SFlow\'s recommendation: ';
// The chat commands that check --recommended themselves (recommended-answer.mjs).
const RECOMMENDED_COMMANDS = /^singularity-flow (?:decision (?:departure|plan)|upstream-issue (?:revalidate|decide)) /u;

/**
 * No reason is asked when the person picks the item's single recommended option [owner, 2026-11-19, C10]: picked as it is,
 * its record keeps "Followed SFlow's recommendation: <why>", which every command's and schema's minimum still takes. Any
 * other option keeps its reason (the person says why they disagree), an exception always does, and so does every option of
 * an item that names no single option (a lean, a check, a first step), until a recommendation names one. Runs before the
 * list's digest binds what each option needs, so every surface and the engine agree.
 */
export function reasonOptional(item, options, recommended) {
  if (!recommended?.option || OWN_REASON_KINDS.has(item.kind)) return options;
  return options.map((entry) => {
    const need = entry.needs?.reason;
    // An exception keeps its reason even when it is the recommended answer: the person says why it may stand.
    if (entry.id !== recommended.option || !need || exceptionOption(entry) || entry.recordable === false || need.minimum === 0) return entry;
    const because = `${RECOMMENDATION_REASON}${String(recommended.why ?? '').replace(/\s+/gu, ' ').trim()}`.slice(0, need.maximum);
    // In chat, after the person's own Yes, its command says --recommended and carries no reason: the command checks it [C10].
    const command = entry.chat?.command;
    // Their own words, when they give some anyway, still go in the command that takes them (`withReason`).
    const chat = command && RECOMMENDED_COMMANDS.test(command)
      ? { chat: { ...entry.chat, command: command.replace(/ --supporting-reason "<REASON>"/gu, '').replace(/ --reason "<REASON>"/u, ' --recommended'), withReason: command } } : {};
    return { ...entry, ...chat, needs: { ...entry.needs, reason: { ...need, minimum: 0, default: because, recommended: true } } };
  });
}
