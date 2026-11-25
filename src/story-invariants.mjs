/**
 * What must hold after every step a person or an agent takes on a Story (owner, 2026-11-23: "do 1 and 2", after a week of
 * d-story bugs that every test passed: a second return refused, a stale evidence index, a lean naming a choice not offered).
 * The tests checked the outcomes they were written for; these are checked wherever the CLI reads or writes the state they
 * are about, in every test, and after every action of the Story fuzzer (test/story-fuzzer.test.mjs):
 *
 * - a decision list's recommendation names only a choice it shows (recommended-not-offered, lean-names-missing-choice);
 * - an open item a person may answer has a choice they can take (open-item-without-choice);
 * - a return the list offers can run now, and so can every other return chosen with it, in list order
 *   (return-not-runnable, later-return-not-runnable);
 * - a release document SFlow wrote from its records, still sealed, says what those records say when its step is
 *   submitted (stale-record-document);
 * - a refusal's route is never the refused command again (refusal-routes-to-itself).
 *
 * Off unless SINGULARITY_FLOW_INVARIANTS names a file: the test runners set it (scripts/test-machine-state.mjs) and fail
 * the run on any line written there that test/fixtures/known-invariant-violations.json does not list. Nothing here
 * changes what the CLI does or prints, and a check that cannot run says nothing.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { optionOutcome } from './decision-list.mjs';
import { upstreamReturnJoin, upstreamReturnLegal } from './upstream-routes.mjs';

export const INVARIANTS_LOG = 'SINGULARITY_FLOW_INVARIANTS';
export const invariantsOn = (env = process.env) => Boolean(env[INVARIANTS_LOG]);

// Shown as a choice: one the list records, or a person's own step it names (its `action`), never one marked not available.
const available = (option) => option.available !== false;
const live = (item) => !item.settled && !item.optional && !item.plain?.later;
const RETURN_EFFECT = (effect) => effect.kind === 'upstream-issue-decision' && effect.outcome === 'return';

// What a lean says to do, and the outcomes that do it: it may name only a choice the item offers.
const LEAN_VERBS = Object.freeze([
  { verb: 'return', words: /\breturn (?:the work|it|the step)\b/iu, outcomes: ['return'] },
  { verb: 'dismiss', words: /\bdismiss (?:it|the gap|the row)\b/iu, outcomes: ['dismiss'] },
  { verb: 'accept as a risk', words: /\baccept (?:it |the gap |the risk )?(?:as a risk|for now)\b/iu, outcomes: ['accept-risk'] }
]);

/** What is wrong with one decision list as built for `workflow`: [] when everything it shows can be done as it says. */
export function packetViolations(workflow, packet, { at = new Date().toISOString() } = {}) {
  const found = [];
  const add = (invariant, item, words, extra = {}) => found.push({ invariant, item: item?.id ?? null, kind: item?.kind ?? null, words, ...extra });
  const items = (packet?.items ?? []).filter((item) => item && !item.settled);
  for (const item of items) {
    const options = item.options ?? [];
    const recommended = item.recommended ?? null;
    if (recommended?.option && !options.some((option) => option.id === recommended.option && available(option))) {
      add('recommended-not-offered', item, `recommends '${recommended.option}', which it does not offer as a choice`, { option: recommended.option });
    }
    if (recommended && !recommended.option) {
      const said = String(recommended.words ?? recommended.why ?? '');
      for (const lean of LEAN_VERBS) {
        if (lean.words.test(said) && !options.some((option) => available(option) && lean.outcomes.includes(optionOutcome(item, option)))) {
          add('lean-names-missing-choice', item, `its recommendation says to ${lean.verb}, which it does not offer: "${said.slice(0, 160)}"`, { verb: lean.verb });
        }
      }
    }
    if (live(item) && item.decidedBy?.allowed && item.kind !== 'approval' && !options.some(available) && !item.check) {
      add('open-item-without-choice', item, 'waits on this person and offers no choice they can take');
    }
    for (const option of options.filter(available)) {
      for (const effect of (option.effects ?? []).filter(RETURN_EFFECT)) {
        if (!returnRunnable(workflow, effect)) add('return-not-runnable', item, `offers '${option.id}', a return to ${effect.issuePhase} that cannot run now`, { option: option.id });
      }
    }
  }
  // Every return on the list chosen together, as one answer for all or one by one: each in turn must still run after the
  // ones before it (d-story, 2026-11-23: the second of two returns to Verification was refused).
  let state = structuredClone(workflow);
  for (const item of items) {
    const option = (item.options ?? []).find((entry) => available(entry) && (entry.effects ?? []).some(RETURN_EFFECT));
    if (!option) continue;
    const effect = option.effects.find(RETURN_EFFECT);
    if (!returnRunnable(state, effect)) {
      add('later-return-not-runnable', item, `its return to ${effect.issuePhase} cannot run once the returns listed before it are recorded`, { option: option.id });
      continue;
    }
    state = afterReturn(state, effect, at);
  }
  return found;
}

function issueOf(workflow, effect) {
  return effect.issue ? (workflow.upstreamIssues ?? []).find((entry) => entry.id === effect.issue) ?? null : null;
}

/** Whether a return of `effect`'s issue runs on `workflow` now: from the current step, or joining an open return. */
export function returnRunnable(workflow, effect) {
  const issue = issueOf(workflow, effect);
  return upstreamReturnLegal(workflow, effect.issuePhase) || Boolean(issue && upstreamReturnJoin(workflow, issue));
}

/** The Story as a recorded return of `effect` leaves it, as far as the next return's legality reads it. */
function afterReturn(workflow, effect, at) {
  const issue = issueOf(workflow, effect);
  if (issue && upstreamReturnJoin(workflow, issue)) return workflow;
  const next = structuredClone(workflow);
  const order = next.phaseOrder ?? [];
  const from = order.indexOf(next.currentPhase);
  const to = order.indexOf(effect.issuePhase);
  for (const id of order.slice(to, from + 1)) if (next.phases?.[id]) next.phases[id].status = id === effect.issuePhase ? 'in_progress' : 'pending';
  next.currentPhase = effect.issuePhase;
  next.changeRequests = [...(next.changeRequests ?? []), { id: `CR-${String((next.changeRequests ?? []).length + 1).padStart(3, '0')}`, status: 'open',
    targetPhase: effect.issuePhase, requestedAt: at }];
  return next;
}

const MARKER = /<!-- singularity-flow:record-document sha256:([a-f0-9]{64}) -->/u;

/**
 * Release documents SFlow wrote from its records and nobody edited since, which no longer say what the records say: the
 * report and its evidence index. Checked when the step is submitted: publishing wrote them, and nothing they read
 * moves between that and the submission.
 */
export async function recordDocumentViolations(root, config, workflow, phase) {
  const records = await import('./record-documents.mjs');
  if (await records.recordDocumentKind(workflow, phase) !== 'release') return [];
  const rendered = await records.renderRecordDocument(root, config, workflow, phase).catch(() => null);
  if (!rendered) return [];
  const { readFile } = await import('node:fs/promises');
  const { requiredRepoPath } = await import('./story-state-validation.mjs');
  const report = path.join(root, requiredRepoPath(config, workflow, phase));
  const found = [];
  const text = await readFile(report, 'utf8').catch(() => null);
  if (text != null && await records.writtenBySflow(text) && await records.rewritesTheSame(root, config, workflow, phase, text) === false) {
    found.push({ invariant: 'stale-record-document', phase: phase.id, path: path.relative(root, report), words: `${phase.id}'s report is SFlow's and no longer says what its records say` });
  }
  if (rendered.index) {
    const file = path.join(path.dirname(report), 'verification/evidence-index.md');
    const index = await readFile(file, 'utf8').catch(() => null);
    if (index != null && await records.writtenBySflow(index) && index.match(MARKER)?.[1] !== (await records.sealed(rendered.index)).match(MARKER)?.[1]) {
      found.push({ invariant: 'stale-record-document', phase: phase.id, path: path.relative(root, file), words: `${phase.id}'s evidence index is SFlow's and no longer says what its records say` });
    }
  }
  return found;
}

const NOISE = new Set(['--json', '--for-agent', '--no-model', '--fetch', '--yes']);
const commandWords = (text) => String(text ?? '').trim().replace(/^singularity-flow\s+/u, '').split(/\s+/u).filter((word) => word && !NOISE.has(word)).join(' ');

/** A refusal whose route is the command just refused, with the same arguments: following it loops. */
export function refusalViolations(argv, error) {
  const route = error?.details?.nextAction?.command;
  if (!route || !argv?.length) return [];
  // The same command handed to a person's own terminal (a presence signature, a confirmation only a person gives) runs
  // there, where it was refused here for want of a person: a hand-over, not a loop.
  if (error.details.nextAction.where === 'own-terminal') return [];
  return commandWords(route) === commandWords(argv.join(' '))
    ? [{ invariant: 'refusal-routes-to-itself', code: error.code ?? null, words: `refused '${commandWords(argv.join(' '))}' and routed to the same command` }]
    : [];
}

/** Append what was found to the run's log, one JSON line each, with the command that found it. Never throws. */
export function reportViolations(violations, context = {}, env = process.env) {
  const file = env[INVARIANTS_LOG];
  if (!file || !violations?.length) return;
  try {
    const argv = process.argv.slice(2).filter((arg) => !/^--(?:reason|problem)=/u.test(arg));
    for (const violation of violations) {
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...violation, ...context, argv: argv.slice(0, 24) })}\n`);
    }
  } catch { /* a check never changes what the command does */ }
}

/** Read the run's log: every violation found, in order. */
export async function readViolations(file) {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

/**
 * The violations no entry of `known` (test/fixtures/known-invariant-violations.json) covers. An entry names the invariant
 * and what it is about (`kind`, `code` or `path` suffix), and why it is known; the list only shrinks.
 */
export function unknownViolations(violations, known = []) {
  const covers = (entry, violation) => entry.invariant === violation.invariant
    && (!entry.kind || entry.kind === violation.kind) && (!entry.code || entry.code === violation.code)
    && (!entry.path || String(violation.path ?? '').endsWith(entry.path)) && (!entry.option || entry.option === violation.option);
  return violations.filter((violation) => !known.some((entry) => covers(entry, violation)));
}
