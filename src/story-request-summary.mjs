/**
 * The Story request in a few bounded lines, for the top of what an agent reads first.
 *
 * The pinned source is complete and authoritative in the composed prompt's "Pinned Story source",
 * but that section sits after the phase contract and the artifact template, and agent entry packets
 * carried the request only inside `context.text`. In a live Copilot run an agent that truncated its
 * reads asked for the change it had been given. This projection is presentation only: it never
 * replaces, rewrites or authorises anything in the pinned source.
 *
 * A step after the first works from the approved outputs of the steps before it, which refine this
 * request. A code step that read only the summary ("Implement hex operator", criteria "test cases")
 * asked the person what its approved plan already settled, so a refined request says so.
 */
const OUTCOME_LIMIT = 600;
const CRITERION_LIMIT = 200;
const CRITERIA_SHOWN = 5;

function oneLine(value, limit) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function criterionText(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return entry.text ?? entry.description ?? entry.title ?? entry.statement ?? null;
  return null;
}

/** `null` when the source names no request; otherwise title, outcome and the first criteria. */
export function storyRequestSummary(source, { refinedBy = [] } = {}) {
  if (!source || typeof source !== 'object') return null;
  const title = oneLine(source.title, OUTCOME_LIMIT);
  // Sources keep unanswered fields as empty strings, so take the first field that says something.
  const outcome = oneLine(source.desiredOutcome, OUTCOME_LIMIT) ?? oneLine(source.description, OUTCOME_LIMIT);
  const criteria = source.acceptanceCriteria;
  const all = Array.isArray(criteria) ? criteria
    : typeof criteria === 'string' ? criteria.split(/\r?\n/u).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '')) : [];
  const stated = all.map((entry) => oneLine(criterionText(entry), CRITERION_LIMIT)).filter(Boolean);
  const acceptanceCriteria = stated.slice(0, CRITERIA_SHOWN);
  if (!title && !outcome && !acceptanceCriteria.length) return null;
  return {
    title, outcome, acceptanceCriteria,
    ...(stated.length > acceptanceCriteria.length ? { moreAcceptanceCriteria: stated.length - acceptanceCriteria.length } : {}),
    authority: refinedBy.length
      ? `Projection of the pinned Story source: the original request. This step's approved inputs, the outputs of ${refinedBy.join(', ')} right after the phase contract in the composed context, refine it and settle its detail: read them, never ask what they answer.`
      : 'Projection of the pinned Story source; the composed prompt carries the full, authoritative request.',
    ...(refinedBy.length ? { refinedBy: [...refinedBy] } : {})
  };
}

/** The same request as one prompt line, or `null`. */
export function requestedOutcomeLine(source, { refinedBy = [] } = {}) {
  const summary = storyRequestSummary(source);
  if (!summary) return null;
  const head = [summary.title, summary.outcome].filter(Boolean);
  const text = [...new Set(head)].join(' — ') || summary.acceptanceCriteria[0];
  return `- Requested outcome: ${text} (full request: Pinned Story source below)${refinedBy.length
    ? `; refined by this step's approved inputs from ${refinedBy.join(', ')} (Approved upstream artifact evidence below), which settle its detail` : ''}`;
}
