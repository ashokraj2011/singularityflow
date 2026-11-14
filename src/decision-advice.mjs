/**
 * What every item of the decision list recommends, and what each of its choices does to the Story, in one
 * plain line each [owner, 2026-11-13]: "Decisions are really confusing", because a card asked a question
 * with no recommended answer and no idea what each choice does. Every item carries `recommended`
 * ({ option, why, words }) and every option `does`; an item a person may answer yes or no in chat carries
 * `chatYesNo` and `yesNo`.
 *
 * Deterministic and model-free: a recommendation is read from the facts the item was built from (its
 * kind, details and options), never guessed. Where SFlow cannot tell, it says so: "No recommendation: <what
 * the person must weigh>". Nothing here chooses, preselects or records anything, and nothing enters the
 * list's digest: what a person confirms is the option they pick, under the same checks as before.
 */
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
      return `${effect.replaces ? `Changes ${effect.file} from ${effect.replaces} to Node ${effect.version}` : `Creates ${effect.file} holding Node ${effect.version}`} and lists it in the plan; the tests then run on that Node, and the code stays as it is.`;
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
        return `${listWords(effect.changes.map((change) => planChangeWords(workflow, change))).replace(/^./u, (first) => first.toUpperCase())}; the change stays and no step is reset.`;
      }
      if (effect.writes === 'forward-amendment') return 'The earlier step\'s approved document is amended to this wording as its next generation; each later step that read it is listed to revalidate.';
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
      return 'Records that you read it; the steps it reopened can then revalidate.';
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

const rec = (item, optionId, why) => {
  const entry = item.options.find((candidate) => candidate.id === optionId);
  return entry ? { option: entry.id, why, words: `Recommended: ${entry.label.replace(/[.!?]+$/u, '')}. ${why}` } : null;
};
// A step that is not one of the choices, said as what to do first.
const first = (why) => ({ option: null, why, words: `Recommended first: ${why}` });
const none = (why) => ({ option: null, why, words: `No recommendation: ${why}` });
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
  if (!options.length) return none(item.options[0]?.words ? firstSentence(item.options[0].words) : 'nothing can be answered yet.');
  switch (item.kind) {
    case 'conformance-gap': {
      if (marked?.id === 'reuse' && details.reuse) {
        return rec(item, 'reuse', `${stepName(workflow, details.reuse.recordedBy)}'s recorded run on unchanged code covers ${listWords((details.clauses ?? []).map((id) => clauseName(workflow, id)))}; nothing has to run again.`);
      }
      if (options.some((entry) => entry.id === 'correct-report')) return rec(item, 'correct-report', 'The recorded evidence reads every clause satisfied, so the report is what to look at again, not the step before it.');
      if (details.draft && options.some((entry) => entry.id === 'update-spec')) return rec(item, 'update-spec', 'A draft of the spec change for these clauses is already written; writing it as the code does it and proposing it is next.');
      if (details.differences?.length) {
        return none(`whether the code or the clause is right. Fix the code if the clause says what the product should do; update the spec if the code does. Accept it for now only if both can differ until a date.`);
      }
      if (options.some((entry) => entry.id === 'return')) {
        return rec(item, 'return', `The report marks it ${listWords(details.verdicts ?? [])} and no recorded run covers it, so ${stepName(workflow, details.owner)} delivers it again; accept it as a risk only if the Story may ship without it until a date.`);
      }
      return none(`whether the Story may ship with ${listWords((details.clauses ?? []).map((id) => clauseName(workflow, id)))} ${listWords(details.verdicts ?? [])} until a date, or the gap is not real.`);
    }
    case 'upstream-issue': {
      if (marked?.id === 'accept-risk') return rec(item, 'accept-risk', 'The recorded run already accepted for a later step covers it; nothing is left unproven.');
      const proposed = details.proposed === 'accept-risk' ? 'accept-risk' : details.proposed === 'return' ? 'return' : null;
      if (proposed && options.some((entry) => entry.id === proposed)) return rec(item, proposed, `The step that reported it proposed ${proposed === 'return' ? 'returning the work' : 'accepting it as a risk'}.`);
      if (details.status === 'expired' && options.some((entry) => entry.id === 'return')) {
        return rec(item, 'return', `Its accepted risk ended and the problem is still open, so ${stepName(workflow, details.phase)} corrects it.`);
      }
      return none(`whether the reported problem is real. Return the work if it is, dismiss it if it is not; accept it as a risk only if the Story may ship with it until a date.`);
    }
    case 'visual-profile':
      return options.some((entry) => entry.id === 'capture')
        ? rec(item, 'capture', 'A screenshot at this size is the evidence the visual check asks for; say it does not apply only if the change never ships at this size.')
        : none('whether the change ships at this screen size at all.');
    case 'node-pin':
      return details.tried === true ? rec(item, 'pin-node', `The tests passed on Node ${details.version} here, on a throwaway copy of this checkout.`)
        : details.tried === false ? none(`the tests did not pass on Node ${details.version} here: pinning it may not help. Installing the Node the tests ask for needs no choice.`)
          : none(`whether the tests pass on Node ${details.version} is not known yet; try it first (singularity-flow tests node), which records nothing.`);
    case 'test-run-risk':
      return first(`fix the environment and run ${details.commandId ?? 'the tests'} again. Accept it only if this environment cannot run them before the date: the run stays failed either way.`);
    case 'test-narrowing':
      return first(`remove the narrowing and run ${details.commandId ?? 'the tests'} again. Accept it only if the narrowed run covers everything this step changed.`);
    case 'test-command': {
      if (options.some((entry) => entry.id === 'return-step-first')) return rec(item, 'return-step-first', 'Accepting it while the step awaits approval would make that review stale.');
      if (details.repin?.dropped) return none(`the changed command drops tests (${firstSentence(details.repin.dropped)}); accept it only if those tests no longer apply.`);
      if (details.repin) return rec(item, 'accept-test-command', 'Only this Story\'s pin changes, and its tests must still pass.');
      return none(`whether ${details.command?.id ?? 'this command'} runs the tests that prove this step; accepting it makes them this step's tests for this Story.`);
    }
    case 'evidence-obligation': {
      const sign = options.find((entry) => entry.action?.humanReview || /^witness-/u.test(entry.id));
      if (sign) return rec(item, sign.id, 'Looking at the evidence and signing it off proves the criterion; a risk leaves it unproven until the date.');
      return none('which risk category fits: the verdict stays as written whichever you choose.');
    }
    case 'owed-decision': {
      if (details.responsibility) {
        return details.declaredReason
          ? rec(item, 'does-not-apply', `The workflow says why: ${firstSentence(details.declaredReason).replace(/\.+$/u, '')}. Record it if that holds for this Story.`)
          : none(`whether ${details.responsibility} truly does not apply to this Story.`);
      }
      if (details.scopeItem) {
        return none('whether a clause of this Story states it (Included, naming the clause), the product already does it (Already in the product), or it is outside this Story (Exclude or Defer).');
      }
      const sign = options.find((entry) => entry.id === 'witness');
      return sign ? rec(item, 'witness', 'Looking at the file and signing it off is the only way this criterion is proven for this change.')
        : none('it can be signed off only once its evidence is published.');
    }
    case 'plan-accounting': {
      const supporting = options.find((entry) => entry.id === 'supporting');
      if (supporting) return rec(item, 'supporting', 'It is a supporting file (its kind serves no single requirement), so it belongs in the plan as a supporting change.');
      if (only) return rec(item, only.id, 'The plan has one row it can join.');
      return none(`which requirement ${details.path ?? 'it'} serves: add it to that row.`);
    }
    case 'departure': {
      if (details.status === 'reopened') return none('it changed again after it was accepted: whether the change still belongs in this Story.');
      const accept = options.find((entry) => entry.id === 'accept');
      if (accept && details.departureKind === 'finding') return rec(item, 'accept', 'It fixes findings from the register; rejecting it opens them again.');
      if (accept && details.departureKind === 'supporting') return rec(item, 'accept', 'It is a supporting file the change needs; accepting lists it in the plan, and no step is reset.');
      if (accept && details.departureKind === 'path' && details.clauses?.length) {
        return rec(item, 'accept', `The code step names ${listWords(details.clauses.map((id) => clauseName(workflow, id)))} as what it serves; accepting adds it to the plan, and no step is reset.`);
      }
      return none('whether the approved documents should say this. Accept it if the change belongs in this Story; reject it to undo it.');
    }
    case 'convergence-item': {
      const found = ['absent-observed-claim', 'failing-bound-test', 'missing-bound-test', 'missing-required-evidence', 'stale-claim-binding'];
      if ((details.itemKinds ?? []).length && details.itemKinds.every((kind) => found.includes(kind)) && options.some((entry) => entry.id === 'rework')) {
        return rec(item, 'rework', 'Convergence found it in the records themselves: the code does not show what the approved documents say.');
      }
      return none('whether the code or the approved documents are right: send it back to fix the code, or change the spec, or accept it as is with a reason.');
    }
    case 'convergence-answer':
      return none('it is already answered; change it only if you disagree.');
    case 'convergence-settled':
      return none('the approved plan accounts for it; answer only if you disagree.');
    case 'scope-completeness':
      return none('nothing waits on this review; record it only after you looked for what is missing, ambiguous or unmeasurable.');
    case 'asked-for':
      return only ? rec(item, only.id, 'What the person typed must be accounted for before the step\'s approval; only its author can.') : none('who accounts for it.');
    case 'routing-decision': {
      const routes = options.filter((entry) => /^choose-/u.test(entry.id));
      if (details.reason === 'limit') return none('all its rounds are used: whether another round is worth it, or the Story moves on as it is.');
      if (routes.length === 1) return rec(item, routes[0].id, 'It is the route the recorded values choose.');
      return none(`which route fits: ${listWords(routes.map((entry) => `"${entry.label}"`))}.`);
    }
    case 'intent-amendment': {
      if (details.status === 'approved') return rec(item, 'acknowledge', 'It is approved already; acknowledging it lets the steps it reopened revalidate.');
      if (marked?.id === 'refresh') return rec(item, 'refresh', 'The Story moved on after it was proposed, so it cannot be approved as it is; refreshing proposes the same change against the step as it is now.');
      return none('whether the approved clauses should change as shown; approving reopens the steps that cite them.');
    }
    case 'forward-amendment':
      return only ? rec(item, only.id, 'Only an approver of that step decides it; the Story cannot end until they do.') : none('whether the corrected document is right.');
    case 'revalidation':
      // D1 [CIC:REQ-021]: still holds when its document names neither the changed clauses its prompt held nor their paths, else redo.
      if (details.reason === 'prompt-held') return rec(item, details.recommend === 'return' ? 'return-step' : 'still-holds', details.because);
      return none(`whether ${stepName(workflow, details.phase)} still holds under the amended document: say it holds if what it was built and checked against reads the same.`);
    case 'appeal':
      return only ? rec(item, only.id, 'An approver of the plan reviews the exact diff; nothing else accounts for the scope.') : none('whether the changes belong in scope.');
    case 'generation-rollover':
      return details.requested ? rec(item, 'start-next-generation', 'The person asked for this change after the step was published.')
        : (details.paths ?? []).length === 1 ? none(`whether ${details.paths[0]} belongs in this step: keep it in a new generation, or set it aside.`)
          : none(`whether ${listWords(details.paths ?? []) || 'the changed files'} belong in this step: keep them in a new generation, or set them aside.`);
    case 'approval':
      return details.ready ? rec(item, 'approve', 'Nothing on this list holds it, and its checks are recorded: review the documents and approve.')
        : first(`decide ${listWords(details.heldBy ?? [])} above; the approval waits for ${details.heldBy?.length === 1 ? 'it' : 'them'}.`);
    default:
      // A refusal's own route, what SFlow publishes itself, a person's own step: the one way forward.
      return only ? rec(item, only.id, firstSentence(item.why) || 'It is the one way this clears.') : marked ? rec(item, marked.id, firstSentence(marked.words) || 'SFlow marks it recommended.')
        : none('each choice below says what it does to the Story.');
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
  if (item.settled || item.machine) return null;
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
  const no = options.find((entry) => entry.id === 'reject') ?? null;
  // The question names its row, as the answer binding reads it (a departure's ID, a responsibility, a path), and says how
  // long a reason the command takes [owner, 2026-11-14].
  return { question: `${String(item.title ?? '').replace(/[.!?]+$/u, '')}. ${yes.label.replace(/[.!?]+$/u, '')}?${reasonWords(options)}`, yes: yes.id, no: no?.id ?? null,
    route: `/sf-decide ${workflow?.workItem?.id ?? '<WORK-ID>'}` };
}

/** " Say why in at least 20 characters.": the longest minimum the answers' reasons take, or '' when none needs one. */
function reasonWords(options) {
  const minimum = Math.max(0, ...options.map((entry) => Number(entry.needs?.reason?.minimum ?? 0)));
  return minimum ? ` Say why in at least ${minimum} characters.` : '';
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
  return { question: `Does ${shown} still hold after ${item.details?.amendment}? ${said.replace(/\s*$/u, '')}${reasonWords(options)}`, yes: yes.id, no: no.id,
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
  if (item.settled) return { ...advised, chatYesNo: false };
  const yesNo = yesNoOf(workflow, advised);
  return { ...advised, recommended: itemRecommendation(workflow, advised), chatYesNo: Boolean(yesNo), ...(yesNo ? { yesNo } : {}) };
}
