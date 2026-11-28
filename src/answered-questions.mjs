/**
 * Ask once (owner, 2026-11-28: "no one should get stuck"): every answer a person already gave in this Story, found before
 * anything asks again. A reviewer asked a cloned Story's person the same thing three rounds in a row, each answer pinned to
 * one version only (graph-plotter Story, 2026-11-20); a new version's author was told to reuse replies of its own version
 * alone. Read for the reviewer's packet (source-review-lifecycle.mjs) and for a step's questions (clarifications.mjs), so
 * neither asks, or raises as a finding, what the person already answered:
 *   - each step's clarification answers, every version, the intake's among them;
 *   - each send-back's reason (a person's change request; SFlow's own returns are not answers);
 *   - each upstream issue a person decided, with their reason;
 *   - on the reviewed step, each finding a person decided on its earlier reviews, with their reason.
 * The same for every step, whatever its workflow. Loaded only when a step may ask or a review is read.
 *
 * And SFlow's own notes are never the person's words: SFLOW_REQUEST_NOTES are the lines older builds wrote into a cloned
 * Story's request (story-clone.mjs no longer does), shown to the reviewer as SFlow's, never a requirement.
 */
const MAXIMUM = 20;
const clean = (value, maximum) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);

/** The lines SFlow itself once wrote into a person's request: never a requirement, a gap or a question to ask. */
export const SFLOW_REQUEST_NOTES = Object.freeze([
  /^Request copied from Story \S+ at [0-9a-f]{7,64}\.$/u,
  /^Supporting documents were not copied\. Attach needed documents and images to this new Story\.$/u
]);

/** The lines of `text` SFlow wrote, each with its 1-based line number. */
export function sflowNotesIn(text) {
  return String(text ?? '').split(/\r?\n/u).flatMap((line, index) => {
    const words = line.replace(/^[\s>*#-]+/u, '').trim();
    return SFLOW_REQUEST_NOTES.some((pattern) => pattern.test(words)) ? [{ line: index + 1, text: words }] : [];
  });
}

/** What the reviewer is told about the answers and SFlow's notes in its packet. */
export const ANSWERED_GUIDANCE = 'The person already answered each of answeredEarlier in this Story: what an answer settles is settled. '
  + 'Never raise a finding that only asks one of them again, in other words or under another id; a gap an answer leaves open is still a finding, and names that answer\'s id. '
  + 'Each line in sflowNotes is SFlow\'s own note, not the person\'s request: never a requirement, a gap or a finding.';

/**
 * Every answer a person gave in this Story, newest last, at most 20: `{ id, kind, step, version, question, answer }`.
 * `except`: clarification record paths already in front of the reader (a packet's own `clarifications`). `reviewOf`: the
 * step whose earlier review answers to add. Never throws: a record that cannot be read is left out.
 */
export async function answeredEarlier(root, config, workflow, { except = [], reviewOf = null } = {}) {
  const found = [];
  const skip = new Set(except.filter(Boolean));
  const { readClarificationRecord } = await import('./clarifications.mjs');
  for (const id of workflow?.phaseOrder ?? []) {
    const phase = workflow.phases?.[id];
    if (!phase) continue;
    // Each published version's clarification, as its publication recorded it (state.mjs keeps one per version).
    for (const reference of (phase.clarifications ?? []).slice(-30)) {
      const generation = Number(reference?.generation);
      if (!Number.isSafeInteger(generation) || skip.has(reference.path)) continue;
      const record = await readClarificationRecord(root, config, workflow, phase, generation).catch(() => null);
      for (const response of record?.responses ?? []) {
        if (response?.status === 'deferred' || !clean(response?.question, 1) || !clean(response?.answer, 1)) continue;
        found.push({ id: `${id}-v${generation}-${clean(response.id, 40) || found.length + 1}`, kind: 'clarification', step: id, version: generation,
          question: clean(response.question, 300), answer: clean(response.answer, 400) });
      }
    }
  }
  for (const request of workflow?.changeRequests ?? []) {
    const words = clean(request?.comment, 400);
    if (!request?.id || request.automatic || request.identityAssurance === 'automatic' || !words || words === 'Changes requested.') continue;
    const step = workflow.phases?.[request.sourcePhase]?.label ?? request.sourcePhase;
    found.push({ id: request.id, kind: 'send-back', step: request.targetPhase, version: Number(request.sourceGeneration ?? 0),
      question: `What should change after ${step} version ${request.sourceGeneration ?? ''}?`.replace(' ?', '?'), answer: words });
  }
  const issues = new Map((workflow?.upstreamIssues ?? []).map((issue) => [issue?.id, issue]));
  for (const decision of workflow?.upstreamIssueDecisions ?? []) {
    const issue = issues.get(decision?.issue);
    if (!issue || !clean(decision.reason, 1)) continue;
    found.push({ id: issue.id, kind: 'upstream-issue', step: issue.phase ?? null, version: null,
      question: clean(issue.problem ?? issue.about, 300), answer: clean(`${decision.outcome ?? 'decided'}: ${decision.reason}`, 400) });
  }
  if (reviewOf) {
    const answers = await (await import('./source-review-lifecycle.mjs')).sourceReviewAnsweredEarlier(root, config, workflow, reviewOf).catch(() => []);
    for (const entry of answers.slice(0, 10)) found.push({ id: `${reviewOf}-review-v${entry.version}-${clean(entry.id, 60)}`, kind: 'review-answer', step: reviewOf,
      version: entry.version, question: `The review's finding ${clean(entry.id, 80)} on version ${entry.version}`, answer: clean(entry.reason, 400) });
  }
  return found.slice(-MAXIMUM);
}
