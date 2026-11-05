/**
 * Proposals: what Copilot offers a specification draft, and how a person takes them (SPEC-SPA v1.3
 * §4.1, §5 part A, milestone S4).
 *
 * A proposal file is `{ proposals: [...], assistedCheck? }`. Each entry is one of a closed table of
 * kinds, validated when it is staged; any refused entry refuses the whole file, so nothing half-lands:
 * - `edit`: the whole prose, proposed against the draft as it is now;
 * - `research`: a code fact, cited by path and lines (and the cited text as `quote`). A bad span is
 *   refused here; a fact that cites nothing is staged as unverified and can support no gap;
 * - `gap`: a gap with its kind, question, evidence and up to four options;
 * - `finding`: an assisted (A) checklist finding on one starter article. It is pending at once, and
 *   a reviewed publication waits until the person settles it.
 * `assistedCheck: true` says the assisted check ran, so part A reads "run" even with no finding.
 *
 * Nothing lands in the draft until a person accepts it (`spec author accept`); accepting checks it
 * again, and a proposal made against older prose or a span that has since changed is refused as stale.
 * Nothing here calls a model, reads Git except to verify a cited span, or decides for anyone.
 */
import { createHash } from 'node:crypto';

import { committedFileBytes } from '../git.mjs';
import { spanSha256 } from '../knowledge/items.mjs';
import { SingularityFlowError } from '../util.mjs';
import { CHECKLIST_ARTICLES, GAP_KINDS, normalizeOptions, openGap } from './draft-model.mjs';
import { nextNumber } from './ids.mjs';
import { normalizeArea } from './research.mjs';

export const PROPOSAL_KINDS = Object.freeze(['edit', 'research', 'gap', 'finding']);
export const FINDING_OUTCOMES = Object.freeze(['gap', 'fixed', 'dismissed']);
export const MAXIMUM_PROPOSALS = 32;
const MAXIMUM_SPEC_BYTES = 256 * 1024;
const MAXIMUM_TEXT = 1000;
const PROPOSAL_ID = /^P-\d{3,}$/u;
const FINDING_ID = /^A-\d{3,}$/u;
// An accepted finding becomes the gap kind its article asks about.
const FINDING_GAP_KIND = Object.freeze({ ambiguity: 'vague-term', 'boundary-conditions': 'missing-boundary' });

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const text = (value) => String(value ?? '').trim();
const who = (actor) => (actor ? { name: actor.name ?? null, email: actor.email ?? null } : null);
const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const words = (value) => text(value).replace(/\s+/gu, ' ');
export const specDigest = (spec) => `sha256:${createHash('sha256').update(String(spec ?? '')).digest('hex')}`;
const formatId = (prefix, number) => `${prefix}${String(number).padStart(3, '0')}`;
const clauseList = (value) => (Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : []);

/** The proposals and assisted findings a draft holds; a draft saved before S4 has none. */
export const draftProposals = (draft) => draft.proposals ?? [];
export const draftAssisted = (draft) => ({ runs: draft.assisted?.runs ?? [], findings: draft.assisted?.findings ?? [] });

/** Read one cited span at `ref`, or the reason it cannot be cited. */
function citedSpan(root, ref, citation) {
  if (!plain(citation)) return { reason: 'citation must be { path, lines: [first, last], quote }' };
  let file;
  try { file = normalizeArea(citation.path); } catch { return { reason: `${citation.path} is not a path inside the repository` }; }
  const lines = citation.lines;
  if (!file || !Array.isArray(lines) || lines.length !== 2 || !lines.every(Number.isSafeInteger) || lines[0] < 1 || lines[1] < lines[0]) {
    return { reason: 'citation needs path and lines: [first, last], 1 or more, first no later than last' };
  }
  const bytes = committedFileBytes(root, ref, file);
  if (!bytes) return { reason: `${file} is not in ${ref}` };
  const all = bytes.toString('utf8').split(/\r?\n/u);
  if (lines[1] > all.length) return { reason: `${file} has ${all.length} lines, so ${lines[0]}-${lines[1]} is not a span of it` };
  const sha = spanSha256(all, lines[0], lines[1]);
  if (citation.spanSha256 !== undefined && citation.spanSha256 !== sha) return { reason: `${file}:${lines[0]}-${lines[1]} does not hash to the given spanSha256` };
  if (citation.quote !== undefined && !words(all.slice(lines[0] - 1, lines[1]).join('\n')).includes(words(citation.quote))) {
    return { reason: `${file}:${lines[0]}-${lines[1]} does not contain the quoted text` };
  }
  return { citation: { path: file, lines: [lines[0], lines[1]], spanSha256: sha } };
}

/**
 * The closed operation table: each kind's validation, returning the staged body and its findings
 * (`{ field, code, message }`). A finding refuses the whole proposal file.
 */
export function applyFocusedEdits(spec, patches) {
  if (!Array.isArray(patches) || !patches.length || patches.length > 16) fail('Use 1 to 16 exact text changes.', 'SPEC_PROPOSAL_PATCH_INVALID');
  let next = spec;
  for (const patch of patches) {
    if (!plain(patch) || Object.keys(patch).some(key => !['before', 'after'].includes(key))
        || typeof patch.before !== 'string' || !patch.before || typeof patch.after !== 'string'
        || patch.before === patch.after) fail('Every change needs different before and after text.', 'SPEC_PROPOSAL_PATCH_INVALID');
    const at = next.indexOf(patch.before);
    if (at < 0 || next.indexOf(patch.before, at + 1) >= 0) fail('The selected wording changed or is ambiguous. Compare the proposal with the current draft.', 'SPEC_PROPOSAL_STALE');
    next = next.slice(0, at) + patch.after + next.slice(at + patch.before.length);
    if (Buffer.byteLength(next) > MAXIMUM_SPEC_BYTES) fail('The changed draft exceeds 256 KiB. Split the specification before accepting it.', 'SPEC_PROPOSAL_TOO_LARGE');
  }
  return next;
}

const KINDS = Object.freeze({
  edit(entry, at, { draft }) {
    if (entry.patches !== undefined) {
      if (entry.spec !== undefined) return { findings: [{ field: at, code: 'SPEC_PROPOSAL_PATCH_INVALID', message: 'Use patches or a whole specification, not both.' }] };
      try { return { body: { patches: entry.patches, spec: applyFocusedEdits(draft.spec, entry.patches) } }; }
      catch (error) { return { findings: [{ field: at + '.patches', code: error.code, message: error.message }] }; }
    }
    if (typeof entry.spec !== 'string' || !entry.spec.trim()) return { findings: [{ field: `${at}.spec`, code: 'SPEC_PROPOSAL_EDIT_EMPTY', message: 'an edit proposal carries the whole prose as spec' }] };
    if (Buffer.byteLength(entry.spec) > MAXIMUM_SPEC_BYTES) return { findings: [{ field: `${at}.spec`, code: 'SPEC_PROPOSAL_TOO_LARGE', message: `the prose is over ${MAXIMUM_SPEC_BYTES / 1024} KiB` }] };
    if (entry.spec === draft.spec) return { findings: [{ field: `${at}.spec`, code: 'SPEC_PROPOSAL_EDIT_UNCHANGED', message: 'the proposed prose is the draft as it is' }] };
    return { body: { spec: entry.spec } };
  },
  research(entry, at, { root, ref, commit }) {
    if (!text(entry.summary)) return { findings: [{ field: `${at}.summary`, code: 'SPEC_PROPOSAL_RESEARCH_EMPTY', message: 'a research proposal states its fact as summary' }] };
    if (entry.citation === undefined || entry.citation === null) return { body: { summary: text(entry.summary), citation: null }, notes: ['unverified: it cites nothing, so it can support no gap'] };
    const span = citedSpan(root, ref, entry.citation);
    if (span.reason) return { findings: [{ field: `${at}.citation`, code: 'SPEC_PROPOSAL_SPAN_INVALID', message: span.reason }] };
    return { body: { summary: text(entry.summary), citation: { ...span.citation, commit } } };
  },
  gap(entry, at, { draft }) {
    const findings = [];
    if (!GAP_KINDS.includes(entry.gapKind)) findings.push({ field: `${at}.gapKind`, code: 'SPEC_GAP_KIND_INVALID', message: `gapKind is one of ${GAP_KINDS.join(', ')}` });
    if (!text(entry.question)) findings.push({ field: `${at}.question`, code: 'SPEC_GAP_QUESTION_MISSING', message: 'a gap needs its question' });
    const evidence = clauseList(entry.evidence);
    for (const id of evidence) {
      const item = draft.research.find((candidate) => candidate.id === id);
      if (!item) findings.push({ field: `${at}.evidence`, code: 'SPEC_GAP_EVIDENCE_UNKNOWN', message: `${id} is not a research item of this draft` });
      else if (item.basis === 'code' && !item.citation) findings.push({ field: `${at}.evidence`, code: 'SPEC_GAP_EVIDENCE_UNVERIFIED', message: `${id} cites nothing, so it can support no gap` });
    }
    let options = [];
    try { options = normalizeOptions(entry.options ?? []); } catch (error) { findings.push({ field: `${at}.options`, code: error.code, message: error.message }); }
    return findings.length ? { findings } : { body: { gapKind: entry.gapKind, question: text(entry.question), evidence, clauses: clauseList(entry.clauses), options } };
  },
  finding(entry, at) {
    if (!CHECKLIST_ARTICLES.includes(entry.article)) return { findings: [{ field: `${at}.article`, code: 'SPEC_ARTICLE_UNKNOWN', message: `article is one of ${CHECKLIST_ARTICLES.join(', ')}` }] };
    if (!text(entry.message) || text(entry.message).length > MAXIMUM_TEXT) return { findings: [{ field: `${at}.message`, code: 'SPEC_PROPOSAL_FINDING_EMPTY', message: `a finding says what is wrong in 1 to ${MAXIMUM_TEXT} characters` }] };
    return { body: { article: entry.article, message: text(entry.message), clauses: clauseList(entry.clauses) } };
  }
});

const SHARED_FIELDS = new Set(['kind', 'summary']);
const FIELDS = Object.freeze({
  edit: new Set(['spec', 'patches']), research: new Set(['citation']), gap: new Set(['gapKind', 'question', 'evidence', 'clauses', 'options']),
  finding: new Set(['article', 'message', 'clauses'])
});

/**
 * Validate a proposal file against the draft. Returns `{ entries, findings, assistedCheck }`; with
 * any finding nothing may be staged.
 */
export function validateProposals(root, draft, payload, { ref = 'HEAD', commit = null } = {}) {
  if (!plain(payload) || !Array.isArray(payload.proposals)) {
    return { entries: [], findings: [{ field: 'proposals', code: 'SPEC_PROPOSAL_INVALID', message: 'a proposal file is { "proposals": [ … ] }' }], assistedCheck: false };
  }
  const extra = Object.keys(payload).filter((key) => !['proposals', 'assistedCheck'].includes(key));
  const findings = extra.map((key) => ({ field: key, code: 'SPEC_PROPOSAL_INVALID', message: `a proposal file has no field ${key}` }));
  if (payload.assistedCheck !== undefined && typeof payload.assistedCheck !== 'boolean') findings.push({ field: 'assistedCheck', code: 'SPEC_PROPOSAL_INVALID', message: 'assistedCheck is true or false' });
  if (!payload.proposals.length && payload.assistedCheck !== true) findings.push({ field: 'proposals', code: 'SPEC_PROPOSAL_INVALID', message: 'give at least one proposal, or assistedCheck: true for an assisted check that found nothing' });
  if (payload.proposals.length > MAXIMUM_PROPOSALS) findings.push({ field: 'proposals', code: 'SPEC_PROPOSAL_INVALID', message: `at most ${MAXIMUM_PROPOSALS} proposals at a time` });
  const entries = [];
  payload.proposals.slice(0, MAXIMUM_PROPOSALS).forEach((entry, index) => {
    const at = `proposals[${index}]`;
    if (!plain(entry) || !PROPOSAL_KINDS.includes(entry.kind)) return findings.push({ field: `${at}.kind`, code: 'SPEC_PROPOSAL_KIND_UNKNOWN', message: `kind is one of ${PROPOSAL_KINDS.join(', ')}` });
    const unknown = Object.keys(entry).filter((key) => !SHARED_FIELDS.has(key) && !FIELDS[entry.kind].has(key));
    if (unknown.length) return findings.push({ field: at, code: 'SPEC_PROPOSAL_INVALID', message: `a ${entry.kind} proposal has no field ${unknown.join(', ')}` });
    if (entry.summary !== undefined && (typeof entry.summary !== 'string' || entry.summary.length > MAXIMUM_TEXT)) return findings.push({ field: `${at}.summary`, code: 'SPEC_PROPOSAL_INVALID', message: `summary is text of at most ${MAXIMUM_TEXT} characters` });
    const checked = KINDS[entry.kind](entry, at, { root, ref, commit, draft });
    if (checked.findings?.length) return findings.push(...checked.findings);
    entries.push({ kind: entry.kind, summary: text(entry.summary) || null, body: checked.body, notes: checked.notes ?? [] });
  });
  if (entries.filter((entry) => entry.kind === 'edit').length > 1) findings.push({ field: 'proposals', code: 'SPEC_PROPOSAL_INVALID', message: 'one edit proposal at a time: it carries the whole prose' });
  return { entries, findings, assistedCheck: payload.assistedCheck === true };
}

/** Stage validated entries into the draft: proposals wait for a person, findings are pending at once. */
export function stageProposals(draft, { entries, assistedCheck }, { actor, at, sequence }) {
  draft.proposals = draftProposals(draft);
  draft.assisted = draftAssisted(draft);
  const basis = { sequence, specSha256: specDigest(draft.spec) };
  const staged = [];
  for (const entry of entries) {
    if (entry.kind === 'finding') {
      const id = formatId('A-', nextNumber(draft.assisted.findings.map((finding) => finding.id), 'A-'));
      draft.assisted.findings.push({ id, ...entry.body, status: 'pending', basis, proposedBy: who(actor), at });
      staged.push(id);
      continue;
    }
    const id = formatId('P-', nextNumber(draft.proposals.map((proposal) => proposal.id), 'P-'));
    draft.proposals.push({ id, kind: entry.kind, summary: entry.summary, ...entry.body, notes: entry.notes, status: 'staged', basis, proposedBy: who(actor), at });
    staged.push(id);
  }
  if (assistedCheck || entries.some((entry) => entry.kind === 'finding')) draft.assisted.runs.push({ at, by: who(actor), findings: entries.filter((entry) => entry.kind === 'finding').length });
  return { draft, staged };
}

function requireStaged(draft, ids) {
  if (!ids.length) fail('Name the proposals to take: P-001, P-002 and so on.', 'SPEC_PROPOSAL_UNKNOWN');
  return ids.map((id) => {
    const proposal = PROPOSAL_ID.test(id) && draftProposals(draft).find((entry) => entry.id === id);
    if (!proposal) fail(`${id} is not a proposal of this draft.`, 'SPEC_PROPOSAL_UNKNOWN', { proposal: id });
    if (proposal.status !== 'staged') fail(`${id} was already ${proposal.status}.`, 'SPEC_PROPOSAL_DECIDED', { proposal: id, status: proposal.status });
    return proposal;
  });
}

/**
 * Accept proposals into the draft, in one snapshot. `edited` replaces an edit proposal's prose with
 * the person's own (the only way to take an edit proposed against older prose).
 */
export function acceptProposals(root, draft, ids, { edited = null }, { actor, at, ref = 'HEAD', commit = null }) {
  const proposals = requireStaged(draft, ids);
  const edits = proposals.filter((proposal) => proposal.kind === 'edit');
  if (edited !== null && edits.length !== 1) fail('--edit FILE replaces the prose of exactly one edit proposal; name one.', 'SPEC_PROPOSAL_EDIT_TARGET', { proposals: ids });
  const results = {};
  for (const proposal of proposals) {
    if (proposal.kind === 'edit') {
      if (edited === null && !proposal.patches && specDigest(draft.spec) !== proposal.basis.specSha256) {
        fail(`${proposal.id} was proposed against snapshot ${proposal.basis.sequence}, and the prose has changed since; nothing was accepted. Ask for a new proposal on the draft as it is, or take it with your own merge: --edit FILE.`,
          'SPEC_PROPOSAL_STALE', { proposal: proposal.id, basis: proposal.basis.sequence });
      }
      draft.spec = edited ?? (proposal.patches ? applyFocusedEdits(draft.spec, proposal.patches) : proposal.spec);
      results[proposal.id] = 'the prose';
    } else if (proposal.kind === 'research') {
      let citation = null;
      if (proposal.citation) {
        const span = citedSpan(root, ref, proposal.citation);
        if (span.reason) fail(`${proposal.id}'s cited span changed since it was proposed (${span.reason}); nothing was accepted. Ask for it again on the code as it is.`, 'SPEC_PROPOSAL_STALE', { proposal: proposal.id });
        citation = { ...span.citation, commit };
      }
      const id = formatId('R-', nextNumber(draft.research.map((item) => item.id), 'R-'));
      draft.research.push({ id, basis: 'code', kind: 'proposed', summary: proposal.summary, subject: citation ? { path: citation.path, symbol: null } : null,
        citation, proposal: proposal.id, proposedBy: proposal.proposedBy, addedBy: who(actor), at });
      results[proposal.id] = id;
    } else {
      const { gap } = openGap(draft, { kind: proposal.gapKind, question: proposal.question, evidence: proposal.evidence, clauses: proposal.clauses, options: proposal.options }, { actor, at });
      draft.gaps.at(-1).proposal = proposal.id;
      results[proposal.id] = gap;
    }
    Object.assign(proposal, { status: 'accepted', decidedBy: who(actor), decidedAt: at, result: results[proposal.id] });
  }
  return { draft, results };
}

export function rejectProposals(draft, ids, { reason }, { actor, at }) {
  if (!text(reason)) fail('Rejecting a proposal needs a reason: --reason TEXT.', 'SPEC_DECISION_REASON_MISSING', { proposals: ids });
  for (const proposal of requireStaged(draft, ids)) Object.assign(proposal, { status: 'rejected', decidedBy: who(actor), decidedAt: at, reason: text(reason) });
  return draft;
}

/**
 * Settle assisted findings: `{ 'A-001': 'gap' | 'fixed' | 'dismissed' }`. A dismissal needs the
 * reason; `fixed` needs prose changed since the finding; `gap` opens one from the finding's text.
 */
export function settleFindings(draft, outcomes, { reason = null }, { actor, at }) {
  draft.assisted = draftAssisted(draft);
  const opened = {};
  for (const [id, outcome] of Object.entries(outcomes).sort(([left], [right]) => left.localeCompare(right))) {
    const finding = FINDING_ID.test(id) && draft.assisted.findings.find((entry) => entry.id === id);
    if (!finding) fail(`${id} is not an assisted finding of this draft.`, 'SPEC_FINDING_UNKNOWN', { finding: id });
    if (finding.status !== 'pending') fail(`${id} is already settled (${finding.status}).`, 'SPEC_FINDING_SETTLED', { finding: id, status: finding.status });
    if (!FINDING_OUTCOMES.includes(outcome)) fail(`'${outcome}' is not how a finding is settled; use ${FINDING_OUTCOMES.join(', ')}.`, 'SPEC_FINDING_OUTCOME_INVALID', { finding: id, outcome });
    if (outcome === 'dismissed' && !text(reason)) fail(`Dismissing ${id} needs --reason TEXT.`, 'SPEC_DECISION_REASON_MISSING', { finding: id });
    if (outcome === 'fixed' && specDigest(draft.spec) === finding.basis.specSha256) {
      fail(`${id} cannot be settled as fixed: the prose has not changed since it was found. Edit the specification first, or open it as a gap.`, 'SPEC_FINDING_NOT_FIXED', { finding: id });
    }
    if (outcome === 'gap') {
      opened[id] = openGap(draft, { kind: FINDING_GAP_KIND[finding.article] ?? 'open-question', question: finding.message, clauses: finding.clauses }, { actor, at }).gap;
      draft.gaps.at(-1).finding = id;
    }
    // A finding opened as a gap is decided there; the reason belongs to a dismissal or a fix.
    Object.assign(finding, { status: outcome, settledBy: who(actor), settledAt: at, reason: outcome === 'gap' ? null : text(reason) || null, ...(opened[id] ? { gap: opened[id] } : {}) });
  }
  return { draft, opened };
}

/** Part A of the quality report: not run until an assisted check was staged; pending until settled. */
export function assistedReport(draft) {
  const { runs, findings } = draftAssisted(draft);
  const brief = ({ id, article, message, clauses }) => ({ id, article, message, clauses });
  return {
    status: runs.length || findings.length ? 'run' : 'not-run',
    pending: findings.filter((finding) => finding.status === 'pending').map(brief),
    settled: findings.filter((finding) => finding.status !== 'pending').map((finding) => ({ ...brief(finding), outcome: finding.status, reason: finding.reason ?? null, gap: finding.gap ?? null }))
  };
}

/** The open (staged) proposals for a host: every field a person needs to judge each one. */
export function stagedProposals(draft) {
  const current = specDigest(draft.spec);
  const stale = proposal => { if (!proposal.patches) return proposal.basis.specSha256 !== current; try { applyFocusedEdits(draft.spec, proposal.patches); return false; } catch { return true; } };
  return draftProposals(draft).filter((proposal) => proposal.status === 'staged').map(({ id, kind, summary, notes, basis, proposedBy, at, ...body }) => ({
    id, kind, summary, notes, basis, proposedBy, at,
    ...(kind === 'edit' ? { spec: body.spec, ...(body.patches ? { patches: body.patches } : {}), stale: stale({ ...body, basis }) } : {}),
    ...(kind === 'research' ? { citation: body.citation, verified: Boolean(body.citation) } : {}),
    ...(kind === 'gap' ? { gapKind: body.gapKind, question: body.question, evidence: body.evidence, clauses: body.clauses, options: body.options } : {})
  }));
}

