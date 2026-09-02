/**
 * Assisted convergence candidates. `[SPK:REQ-076]` `[SPK:REQ-077]` `[SPK:CON-034]` `[SPK:CON-035]`
 *
 * The deterministic facts say what the *record* is missing. They cannot say whether the code actually
 * satisfies a requirement, contradicts one, or implements something nobody asked for — and those are
 * the questions a reviewer most wants answered before verification.
 *
 * So this pass proposes candidates of `missing`, `partial`, `contradicts` or `unplanned`. Three
 * constraints keep it from quietly becoming the answer:
 *
 * - It **consumes** the deterministic facts and cannot replace, suppress or mutate one
 *   `[SPK:CON-034]`. The facts go into the prompt as context and come back out untouched; candidates
 *   live in their own record and are merged nowhere.
 * - Every candidate cites the clause IDs, the evidence, and the facts it relates to `[SPK:REQ-077]`,
 *   plus a model-input receipt — so a reviewer can check the claim rather than take it.
 * - A candidate is advisory until a human adjudicates it `[SPK:CON-035]`. Nothing here produces a
 *   governed finding; `story adjudicate` does, and only with a person's identity on it.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { itemId } from './convergence.mjs';
import { canonicalJson, recordSha256 as hashRecord } from './records.mjs';
import { posix, SingularityFlowError } from './util.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';

export const ASSISTED_CONVERGENCE_SCHEMA_VERSION = currentSchemaVersion('assisted-convergence');

export function assistedConvergenceRecordSha256(record) {
  const core = structuredClone(record);
  delete core.recordSha256;
  return hashRecord(core);
}

export function assertAssistedConvergenceIntegrity(record) {
  const computed = assistedConvergenceRecordSha256(record);
  if (!/^[0-9a-f]{64}$/.test(String(record?.recordSha256 ?? ''))
      || record.recordSha256 !== computed) {
    throw new SingularityFlowError(
      `Assisted convergence provenance hash mismatch: stored ${record?.recordSha256 ?? 'missing'}, computed ${computed}.`,
      { code: 'CONVERGENCE_CANDIDATE_RECORD_HASH_MISMATCH' }
    );
  }
  return record;
}

/** What a candidate may claim `[SPK:REQ-076]`. */
export const CANDIDATE_KINDS = Object.freeze(['missing', 'partial', 'contradicts', 'unplanned']);

const MAX_CANDIDATES = 25;
const MAX_CANDIDATE_CHARS = 600;

export function assistedConvergenceRelative(workDirRelativePath, iteration, sourceSha256 = null) {
  const suffix = sourceSha256 == null ? '' : `-${String(sourceSha256).replace(/^sha256:/, '').slice(0, 16)}`;
  return posix(path.posix.join(
    workDirRelativePath, 'context', 'convergence', `candidates-iter${iteration}${suffix}.json`
  ));
}

/**
 * The prompt: approved intent on one side, bounded current evidence on the other.
 *
 * Bounded is the operative word. The model gets the clause text, the claim verdicts, the changed
 * paths reconciliation already reported and the deterministic facts — not the repository. A pass
 * that could go looking would be re-deriving what reconciliation already owns `[SPK:CON-032]`, at a
 * different altitude, with no record of what it read.
 */
export function assistedConvergencePrompt({ clauses = [], observedClaims = {}, changedPaths = [], facts = [], namespace = null }) {
  return [
    'You are checking whether an implementation appears to satisfy approved requirements. You can see',
    'the requirements, what the team claimed about each one, which paths changed, and what the kernel',
    'already determined deterministically.',
    '',
    '## Rules',
    '',
    '- Report only candidate gaps between approved intent and the implementation evidence shown.',
    `- Each candidate is one of: ${CANDIDATE_KINDS.join(', ')}. 'unplanned' means changed paths that`,
    '  serve no approved requirement; \'contradicts\' means evidence that conflicts with a requirement.',
    '- Do NOT repeat, dispute, re-rank or re-word the deterministic facts below. They are recorded and',
    '  are not yours to change. You may reference a fact ID as supporting context.',
    '- Cite the clause IDs a candidate concerns, and the paths or tests that led you to it.',
    '- You are proposing, not deciding. A human adjudicates every candidate.',
    `- At most ${MAX_CANDIDATES} candidates, each at most ${MAX_CANDIDATE_CHARS} characters.`,
    '- Do not use double quotes inside the text. Use single quotes if you need to quote a term.',
    '- An empty list is a valid and useful answer.',
    '',
    '## Output',
    '',
    'Reply with JSON only, in exactly this shape:',
    '',
    '```json',
    '{"candidates":[{"kind":"partial","clauseIds":["APP:REQ-001"],"evidence":["src/a.ts"],"factIds":["CF-..."],"text":"..."}]}',
    '```',
    ...(namespace ? ['', `Clause IDs use the \`${namespace}:\` namespace.`] : []),
    '',
    '## Approved requirements',
    '',
    ...(clauses.length
      ? clauses.map((clause) => `- ${clause.id}: ${String(clause.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)}`)
      : ['- None indexed.']),
    '',
    '## What the team claimed',
    '',
    ...(Object.keys(observedClaims).length
      ? Object.entries(observedClaims).sort(([left], [right]) => left.localeCompare(right)).map(([id, claim]) =>
        `- ${id}: ${claim.verdict}${(claim.observedPaths ?? []).length ? ` via ${claim.observedPaths.join(', ')}` : ' with no cited paths'}`)
      : ['- Nothing claimed.']),
    '',
    '## Paths reconciliation reported as changed',
    '',
    ...(changedPaths.length ? changedPaths.map((entry) => `- ${entry.path} (${entry.verdict})`) : ['- None.']),
    '',
    '## Deterministic facts already recorded (do not repeat or dispute)',
    '',
    ...(facts.length ? facts.map((item) => `- ${item.id} ${item.kind}: ${item.detail}`) : ['- None.'])
  ].join('\n');
}

/**
 * Parse the reply, or refuse.
 *
 * Shares the wrap reconstruction with assisted specification quality: the provider hard-wraps its
 * output and a correct JSON reply arrives broken. Anything the reconstruction cannot make parse is
 * refused rather than half-understood — a candidate record that stores an approximation of what the
 * model said is worse than none, because a reviewer will read it as a quotation.
 */
export function parseConvergenceCandidates(output, { unwrap }) {
  const text = String(output ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const payload = (fenced ? fenced[1] : text).trim();
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch {
    try { parsed = JSON.parse(unwrap(payload)); }
    catch {
      throw new SingularityFlowError(
        'Assisted convergence did not return the requested JSON, so no candidates were recorded. '
        + `The provider replied: ${JSON.stringify(text.slice(0, 300))}${text.length > 300 ? '…' : ''}`
      );
    }
  }
  const candidates = Array.isArray(parsed) ? parsed : parsed?.candidates;
  if (!Array.isArray(candidates)) throw new SingularityFlowError('Assisted convergence returned no candidate list.');
  if (candidates.length > MAX_CANDIDATES) {
    throw new SingularityFlowError(`Assisted convergence returned ${candidates.length} candidates; the limit is ${MAX_CANDIDATES}.`);
  }
  return candidates.map((candidate, index) => {
    const classification = String(candidate?.kind ?? candidate?.classification ?? '').trim();
    if (!CANDIDATE_KINDS.includes(classification)) {
      throw new SingularityFlowError(`Assisted candidate ${index + 1} has kind '${classification}'; expected one of ${CANDIDATE_KINDS.join(', ')}.`);
    }
    const body = String(candidate?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!body) throw new SingularityFlowError(`Assisted candidate ${index + 1} has no text.`);
    if (body.length > MAX_CANDIDATE_CHARS) {
      throw new SingularityFlowError(`Assisted candidate ${index + 1} is ${body.length} characters; the limit is ${MAX_CANDIDATE_CHARS}.`);
    }
    const list = (values) => [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
    const shape = {
      classification,
      clauseIds: list(candidate?.clauseIds).map((id) => id.toUpperCase()),
      evidence: list(candidate?.evidence).map(posix),
      factIds: list(candidate?.factIds),
      text: body
    };
    // `CC-`, not `CF-`: a candidate and a fact must never be mistaken for one another, and an ID that
    // reads the same is the easiest way for that to happen in a list or a commit message.
    return { id: itemId('CC', shape), ...shape };
  }).sort((left, right) => left.classification.localeCompare(right.classification) || left.text.localeCompare(right.text));
}

/**
 * Candidates citing a fact or clause that does not exist.
 *
 * Reported, not dropped. A model inventing `CF-0000` is worth seeing; so is a reviewer looking at
 * candidates from a stale iteration. What must not happen is either one reading as real.
 */
export function unknownReferences(candidates, { factIds = [], clauseIds = [] } = {}) {
  const facts = new Set(factIds);
  const clauses = new Set(clauseIds.map((id) => String(id).toUpperCase()));
  return {
    factIds: [...new Set(candidates.flatMap((candidate) => candidate.factIds.filter((id) => !facts.has(id))))].sort(),
    clauseIds: [...new Set(candidates.flatMap((candidate) => candidate.clauseIds.filter((id) => !clauses.has(id))))].sort()
  };
}

/**
 * The candidate record `[SPK:REQ-077]`.
 *
 * The model-input receipt is the point: prompt hash, the bindings the facts were computed from, and
 * the fact IDs that were in scope. Without it a candidate is an assertion from an unnamed source
 * about an unnamed revision, which no reviewer should have to weigh.
 */
export function buildAssistedConvergenceRecord({
  workId, bindings, facts = [], candidates, invocation, prompt, unknown = { factIds: [], clauseIds: [] }, generatedAt
} = {}) {
  for (const [field, value] of Object.entries({ workId, bindings, candidates, invocation, prompt, generatedAt })) {
    if (value === undefined || value === null) throw new SingularityFlowError(`Assisted convergence record is missing '${field}'.`);
  }
  const record = {
    schemaVersion: ASSISTED_CONVERGENCE_SCHEMA_VERSION,
    resultType: 'convergence-candidates',
    workId,
    iteration: bindings.iteration,
    // Referenced, never restated `[SPK:CON-034]`. There is no copy of a deterministic fact in this
    // record, so there is nothing here for an assisted pass to have changed.
    deterministic: {
      reconciliationSha256: bindings.reconciliation.sha256,
      sourceTargetCommit: bindings.sourceTargetCommit,
      clauseIndexSha256: bindings.clauseIndexSha256,
      factIds: facts.map((item) => item.id)
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
    unknownReferences: unknown,
    disclaimer: 'Candidates are proposals for a human to adjudicate. They are not deterministic facts, '
      + 'they change no deterministic fact, and none of them is a governed finding until a person disposes of it.'
  };
  return { ...record, recordSha256: assistedConvergenceRecordSha256(record) };
}

export function serializeAssistedConvergence(record) {
  return canonicalJson(record);
}
