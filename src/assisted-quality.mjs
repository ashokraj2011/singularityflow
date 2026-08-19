/**
 * Assisted specification-quality candidates. `[SPK:REQ-057]` `[SPK:REQ-058]` `[SPK:CON-028]` `[SPK:CON-029]`
 *
 * The deterministic analyzer answers "what is checkably wrong?" and refuses, by design, to answer
 * "is this specification any good?" — undefined terms, wording two readers would implement
 * differently, business behaviour nobody wrote down. Those are real problems and a model is
 * genuinely useful at spotting them.
 *
 * What it must never do is *sound like the analyzer*. `[SPK:CON-029]` draws the line precisely: an
 * assisted pass may reference the deterministic report, and it may not add to, remove from, suppress
 * or reclassify a single deterministic finding. So the two never merge. The deterministic report is
 * referenced by its binding hashes, never restated, and the model's output lands in a separate
 * record whose every item is called a *candidate* — a thing a reviewer may act on or dismiss, and
 * which the publication gate never reads.
 *
 * That separation is also what keeps the record honest under `[SPK:CON-028]`: a candidate is a
 * semantic observation, and semantic observations belong to people. The kernel's job here is to
 * carry one to a reviewer with enough provenance that they can weigh it — which model said it, from
 * exactly which bytes, at what cost `[SPK:REQ-058]`.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './records.mjs';
import { posix, SingularityFlowError } from './util.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';

export const ASSISTED_RECORD_SCHEMA_VERSION = currentSchemaVersion('assisted-quality');

/** The concerns a candidate may raise. Deliberately none of them overlap a deterministic finding. */
export const CANDIDATE_CONCERNS = Object.freeze([
  'undefined-term', 'ambiguous-wording', 'conflicting-requirements', 'missing-behaviour',
  'unverifiable-requirement', 'unstated-boundary'
]);

const MAX_CANDIDATES = 20;
const MAX_CANDIDATE_CHARS = 500;

/** Where the record lives: beside the deterministic evidence, outside the generation write scope. */
export function assistedRecordRelative(workDirRelativePath, phaseId, generation) {
  return posix(path.posix.join(workDirRelativePath, 'context', 'spec-quality', `${phaseId}-gen${generation}-assisted.json`));
}

/**
 * The prompt. Bounded, and bounded in a specific direction `[SPK:REQ-057]`.
 *
 * It hands over the artifact and *tells the model what the analyzer already found*, not so it can
 * agree, but so it does not spend its one pass restating machine-checkable defects a reader has
 * already seen. Every instruction that follows is about staying on the semantic side of the line.
 */
export function assistedPrompt({ report, markdown, namespace = null }) {
  return [
    'You are reviewing a software specification for semantic quality. Read it and report only',
    'concerns that a careful human reviewer would raise about meaning.',
    '',
    '## Rules',
    '',
    '- Report ONLY semantic concerns: undefined terms, wording two competent engineers would',
    '  implement differently, requirements that contradict each other, behaviour the document',
    '  implies but never states, requirements nothing could prove or disprove, and limits that are',
    '  used without being stated.',
    '- Do NOT restate, contradict, re-rank or comment on the deterministic findings listed below.',
    '  They are already recorded and are not yours to change.',
    '- Do NOT judge the specification as a whole. No verdicts, no scores, no "this looks good".',
    '- Cite the clause IDs a concern applies to. If it applies to no clause, cite none.',
    `- Report at most ${MAX_CANDIDATES} concerns, each at most ${MAX_CANDIDATE_CHARS} characters.`,
    // Asked for because it went wrong: a reply quoting the term it was discussing produced
    // `"The term "attempt" is not defined"`, which is not JSON and cannot be repaired without
    // guessing where the value ends.
    "- Do not use double quotes inside the text. Use single quotes if you need to quote a term.",
    '- If you find nothing, return an empty list. An empty list is a valid and useful answer.',
    '',
    '## Output',
    '',
    'Reply with JSON only, no prose around it, in exactly this shape:',
    '',
    '```json',
    '{"candidates":[{"concern":"ambiguous-wording","clauseIds":["APP:REQ-001"],"text":"..."}]}',
    '```',
    '',
    `The \`concern\` field must be one of: ${CANDIDATE_CONCERNS.join(', ')}.`,
    ...(namespace ? ['', `Clause IDs in this document use the \`${namespace}:\` namespace.`] : []),
    '',
    '## Deterministic findings already recorded (do not repeat or dispute)',
    '',
    ...(report.findings.length
      ? report.findings.map((finding) => `- ${finding.kind}: ${finding.message}`)
      : ['- None.']),
    '',
    '## Specification',
    '',
    markdown
  ].join('\n');
}

/**
 * The column the Copilot CLI hard-wraps its output at.
 *
 * Measured, not assumed: the CLI wraps at exactly 100 columns whether or not stdout is a terminal,
 * and it ignores `COLUMNS`. This is why every other model call in this product has the model write
 * a *file* and reads the file back — text returned on stdout has been through a formatter.
 */
const PROVIDER_WRAP_COLUMNS = 100;

/**
 * Undo the provider's line wrapping.
 *
 * The first real assisted run came back with the right candidates in an unparseable document. The
 * wrap had fallen inside JSON string values, and once inside a clause ID — `DRIVE:REQ-0`, newline,
 * `03` — where inserting a space would have silently corrupted the citation into a different clause.
 *
 * Measuring the output showed the wrap is *greedy and word-aware*: lines come back between about 93
 * and 100 characters, breaking at a space where one is available and splitting a token only when no
 * space will do. Both cases are recoverable, and telling them apart is the whole job — the wrong
 * choice either welds two words together or inserts a space into a clause ID.
 *
 * The distinguishing fact is how a greedy wrapper behaves: it splits a token only when that token
 * could not fit on a line of its own. So look at the token spanning the break — the trailing run of
 * non-space characters on this line plus the leading run on the next:
 *
 * - Longer than `width`: the wrapper had no choice but to split it. Rejoin with nothing.
 * - Otherwise the wrapper would have moved that whole token down, so the break consumed a space.
 *   Rejoin with the space it took.
 * - And a line short enough that the next word would still have fit was ended deliberately, so its
 *   newline is real and stays.
 *
 * It costs nothing when wrong: this runs only after a strict parse has failed, and the result still
 * has to parse. A bad reconstruction simply fails again and the reply is refused rather than stored.
 */
export function unwrapProviderLineBreaks(text, { width = PROVIDER_WRAP_COLUMNS } = {}) {
  const lines = String(text).split('\n').map((line) => line.replace(/\r$/, ''));
  let out = '';
  for (const [index, line] of lines.entries()) {
    out += line;
    if (index === lines.length - 1) continue;
    const next = lines[index + 1] ?? '';
    const head = /(\S*)$/.exec(line)?.[1] ?? '';
    const tail = /^(\S*)/.exec(next)?.[1] ?? '';
    if (!tail) { out += '\n'; continue; }
    // A token no wider than the line would have been moved down whole rather than split.
    if (head.length + tail.length > width) { continue; }
    // `+ 1` for the space the wrapper would have needed to keep that word on this line.
    out += line.length + 1 + tail.length > width ? ' ' : '\n';
  }
  return out;
}

/**
 * Parse the model's reply into candidates, or refuse.
 *
 * Strict on purpose. A record that stores "the model said something roughly like this" is worse than
 * no record: it looks like evidence and is not checkable. If the output is not the shape that was
 * asked for, the honest outcome is a refusal the caller can report.
 */
export function parseAssistedCandidates(output) {
  const text = String(output ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const payload = (fenced ? fenced[1] : text).trim();
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch {
    // Second attempt, and only ever a second one: see `unwrapProviderLineBreaks`.
    try { parsed = JSON.parse(unwrapProviderLineBreaks(payload)); }
    catch { parsed = undefined; }
  }
  if (parsed === undefined) {
    // Quoting what came back, bounded. "It did not return JSON" with nothing to look at leaves the
    // user unable to tell a chatty model from a broken provider from an empty answer, and the
    // output is not kept anywhere else — the audit record stores only its hash.
    throw new SingularityFlowError(
      'Assisted analysis did not return the requested JSON, so nothing was recorded. '
      + `The provider replied: ${JSON.stringify(text.slice(0, 300))}${text.length > 300 ? '…' : ''}`
    );
  }
  const candidates = Array.isArray(parsed) ? parsed : parsed?.candidates;
  if (!Array.isArray(candidates)) throw new SingularityFlowError('Assisted analysis returned no candidate list.');
  if (candidates.length > MAX_CANDIDATES) {
    throw new SingularityFlowError(`Assisted analysis returned ${candidates.length} candidates; the limit is ${MAX_CANDIDATES}.`);
  }
  return candidates.map((candidate, index) => {
    const concern = String(candidate?.concern ?? '').trim();
    if (!CANDIDATE_CONCERNS.includes(concern)) {
      throw new SingularityFlowError(`Assisted candidate ${index + 1} has concern '${concern}'; expected one of ${CANDIDATE_CONCERNS.join(', ')}.`);
    }
    const candidateText = String(candidate?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!candidateText) throw new SingularityFlowError(`Assisted candidate ${index + 1} has no text.`);
    if (candidateText.length > MAX_CANDIDATE_CHARS) {
      throw new SingularityFlowError(`Assisted candidate ${index + 1} is ${candidateText.length} characters; the limit is ${MAX_CANDIDATE_CHARS}.`);
    }
    const clauseIds = [...new Set((candidate?.clauseIds ?? []).map((id) => String(id).trim().toUpperCase()).filter(Boolean))].sort();
    return { concern, clauseIds, text: candidateText };
  }).sort((left, right) => left.concern.localeCompare(right.concern) || left.text.localeCompare(right.text));
}

/**
 * Candidates that cite a clause the specification does not contain.
 *
 * Kept and flagged rather than dropped. A model citing `APP:REQ-009` in a document that stops at
 * `REQ-004` has said something worth seeing — usually that it invented the clause, occasionally that
 * the reviewer is looking at the wrong generation — and silently deleting the citation would hide
 * both. What must never happen is the reviewer believing an invented ID is real.
 */
export function unknownCitations(candidates, clauseIds) {
  const known = new Set(clauseIds.map((id) => String(id).toUpperCase()));
  return [...new Set(candidates.flatMap((candidate) => candidate.clauseIds.filter((id) => !known.has(id))))].sort();
}

/**
 * The record `[SPK:REQ-058]` requires, bound to what produced it.
 *
 * `report` is referenced through its binding hashes rather than copied `[SPK:CON-029]`: a record
 * that carried its own copy of the deterministic findings would be a second version of them, free
 * to drift, and drifting is how "the model reclassified a finding" happens without anyone deciding
 * to do it.
 */
export function buildAssistedRecord({
  report, invocation, candidates, prompt, workId, unknownClauseIds = [], generatedAt
} = {}) {
  for (const [field, value] of Object.entries({ report, invocation, candidates, prompt, generatedAt })) {
    if (value === undefined || value === null) throw new SingularityFlowError(`Assisted analysis record is missing '${field}'.`);
  }
  return {
    schemaVersion: ASSISTED_RECORD_SCHEMA_VERSION,
    resultType: 'specification-quality-assisted',
    workId: workId ?? null,
    // Referenced, never restated.
    deterministicReport: {
      artifactPath: report.binding.artifactPath,
      artifactSha256: report.binding.artifactSha256,
      phase: report.binding.phase,
      generation: report.binding.generation,
      policySha256: report.binding.policySha256,
      findingCount: report.findings.length
    },
    model: {
      provider: invocation.provider,
      model: invocation.model ?? null,
      invocationId: invocation.invocationId,
      operationId: invocation.operationId ?? null
    },
    promptSha256: createHash('sha256').update(String(prompt), 'utf8').digest('hex'),
    usage: invocation.usage ?? { status: 'unavailable' },
    generatedAt,
    candidates,
    unknownClauseIds,
    // Said in the record, because a candidate list is at its most persuasive when it is longest.
    disclaimer: 'Assisted candidates are observations for a human reviewer. They are not deterministic '
      + 'findings, they change no deterministic finding, and no gate reads them.'
  };
}

/** Canonical bytes, so an unchanged record rewrites identically. */
export function serializeAssistedRecord(record) {
  return canonicalJson(record);
}
