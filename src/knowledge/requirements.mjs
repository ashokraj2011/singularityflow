/**
 * Approved Story specifications as cited sources.
 *
 * Code says what a repository does; an approved specification says what it was asked to do. A
 * requirement is read only from a phase artifact the Story's own record lists as approved, at
 * HEAD, and only while its committed bytes are the ones approved: a specification edited after
 * approval is listed as skipped, never read as approved. Each clause (`[WORK-1:AC-001]`) becomes
 * one item citing its line, linked exactly to code and tests that tag it (`@clause`, `@ac`) and,
 * separately and labelled as such, to rules whose words it shares.
 */
import { createHash } from 'node:crypto';

import { readRefTreeResult } from '../git-ref-tree.mjs';
import { extractClauses } from '../specifications.mjs';
import { normalizeWorkItemRoot } from '../work-item-location.mjs';
import { stemOf } from './render.mjs';

export const REQUIREMENT_SOURCE_LIMITS = Object.freeze({
  maximumStories: 500,
  maximumDocuments: 400,
  maximumDocumentBytes: 256 * 1024,
  maximumTotalBytes: 8 * 1024 * 1024
});

const ANCHORED = /\[([A-Za-z0-9][A-Za-z0-9._-]{0,63}):(REQ|BEH|IFC|AC|CON)-(\d{3})\]/giu;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function workItemRootOf(definition) {
  try { return normalizeWorkItemRoot(definition?.workItemRoot ?? undefined); } catch { return 'singularity/work-items'; }
}

/** The approved Markdown artifacts a Story record lists, in phase order. */
function approvedArtifacts(workflow) {
  // Phases are keyed by id; the Story's phase order says which came first.
  const record = workflow?.phases && typeof workflow.phases === 'object' ? workflow.phases : {};
  const order = Array.isArray(workflow?.phaseOrder) ? workflow.phaseOrder : Object.keys(record);
  const phases = order.map((id) => (record[id] ? { ...record[id], id: record[id].id ?? id } : null)).filter(Boolean);
  const story = workflow?.workItem?.id ?? null;
  return phases.flatMap((phase) => (phase?.status !== 'approved' ? [] : (phase.artifacts ?? [])
    .filter((artifact) => artifact?.status === 'approved' && /\.md$/iu.test(String(artifact.path ?? '')))
    .map((artifact) => ({
      story, title: workflow?.workItem?.title ?? null, phase: phase.id ?? null, path: artifact.path, sha256: artifact.sha256 ?? null,
      approvedAt: artifact.approvedAt ?? phase.approvedAt ?? null, approvedBy: artifact.approvedBy ?? phase.approvedBy ?? null
    }))));
}

/**
 * Read every approved specification at HEAD. Returns the documents (with their lines, for
 * citations) and the clauses each one defines; never throws for one bad document.
 */
export function readApprovedRequirements(root, definition = {}, { limits = REQUIREMENT_SOURCE_LIMITS } = {}) {
  const base = workItemRootOf(definition);
  const records = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/[^/]+/workflow\\.json$`, 'u');
  const skipped = [];
  const listing = readRefTreeResult(root, 'HEAD', [base], {
    pathFilter: (relative) => records.test(relative),
    maxObjectBytes: limits.maximumDocumentBytes
  });
  if (listing.status !== 'ok') return { documents: [], clauses: [], skipped, root: base };
  const wanted = [];
  for (const [, text] of [...listing.contents].sort(([a], [b]) => a.localeCompare(b, 'en')).slice(0, limits.maximumStories)) {
    let workflow;
    try { workflow = JSON.parse(text); } catch { continue; }
    wanted.push(...approvedArtifacts(workflow));
  }
  if (!wanted.length) return { documents: [], clauses: [], skipped, root: base };
  const byPath = new Map(wanted.slice(0, limits.maximumDocuments).map((entry) => [entry.path, entry]));
  let total = 0;
  const read = readRefTreeResult(root, 'HEAD', [base], {
    pathFilter: (relative) => byPath.has(relative),
    filter: (relative, entry) => {
      if (total + entry.size > limits.maximumTotalBytes) { skipped.push({ path: relative, reason: 'total-budget' }); return false; }
      total += entry.size;
      return true;
    },
    maxObjectBytes: limits.maximumDocumentBytes
  });
  if (read.status !== 'ok') return { documents: [], clauses: [], skipped, root: base };
  const documents = [];
  const clauses = [];
  const byStory = new Map();
  for (const [relative, text] of [...read.contents].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const approved = byPath.get(relative);
    // A specification edited after approval is not the approved text.
    if (approved.sha256 && digest(text) !== String(approved.sha256).replace(/^sha256:/u, '')) {
      skipped.push({ path: relative, reason: 'changed-after-approval', story: approved.story });
      continue;
    }
    const document = { ...approved, lines: text.split(/\r?\n/u), text };
    documents.push(document);
    if (!byStory.has(approved.story)) byStory.set(approved.story, []);
    byStory.get(approved.story).push(document);
  }
  for (const [, storyDocuments] of byStory) {
    // A later phase cites an earlier phase's clauses; every anchor in the Story resolves them.
    const known = [...new Set(storyDocuments.flatMap((document) => [...document.text.matchAll(ANCHORED)]
      .map((match) => `${match[1].toUpperCase()}:${match[2].toUpperCase()}-${match[3]}`)))];
    const defined = new Set();
    for (const document of storyDocuments) {
      let parsed;
      try {
        parsed = extractClauses(document.text, { sourcePath: document.path, externalClauseIds: known });
      } catch (error) {
        skipped.push({ path: document.path, reason: 'unreadable-clauses', detail: String(error.message).slice(0, 200), story: document.story });
        continue;
      }
      for (const clause of parsed) {
        if (defined.has(clause.id)) continue;
        defined.add(clause.id);
        clauses.push({ ...clause, story: document.story, title: document.title, phase: document.phase,
          approvedAt: document.approvedAt, approvedBy: document.approvedBy });
      }
    }
  }
  for (const document of documents) delete document.text;
  return { documents, clauses, skipped, root: base };
}

/** The end of a clause's statement in its document: its own line through the next blank line. */
export function clauseEndLine(document, line) {
  let end = line;
  while (end < document.lines.length && document.lines[end]?.trim() && !/^\s*(?:#|[-*] |\d+\. |\|)/u.test(document.lines[end])) end += 1;
  return Math.min(end, line + 8);
}

/** Words too common in specifications to say two texts are about the same thing. */
const COMMON = new Set(['when', 'with', 'that', 'this', 'must', 'shall', 'should', 'will', 'have', 'from', 'than', 'then',
  'given', 'each', 'only', 'into', 'more', 'less', 'least', 'most', 'user', 'system', 'able', 'also', 'which', 'there',
  'their', 'been', 'being', 'does', 'what', 'they', 'them', 'some', 'every', 'other', 'value', 'return', 'true', 'false',
  'null', 'function', 'const', 'error', 'test', 'show', 'sees', 'make', 'used', 'using', 'after', 'before', 'where']);

/** The stems and numbers a text or identifier uses: `FREE_SHIPPING_THRESHOLD` and "free shipping" meet. */
export function textTerms(value) {
  const words = String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_$.]/gu, ' ')
    .toLowerCase()
    .match(/[a-z]{4,}|\d+(?:\.\d+)?/gu) ?? [];
  return new Set(words.filter((word) => !COMMON.has(word)).map((word) => (/^\d/u.test(word) ? word : stemOf(word)))
    .filter((term) => term.length >= 4 || /^\d+/u.test(term)));
}

/**
 * Code items whose words a requirement shares: two or more distinct stems, or one stem and one
 * number. Returned best first; a word match is a lead for a reader, never an implementation link.
 */
export function wordMatches(requirementText, candidates, { limit = 3 } = {}) {
  const wanted = textTerms(requirementText);
  if (!wanted.size) return [];
  const scored = [];
  for (const candidate of candidates) {
    const shared = [...candidate.terms].filter((term) => wanted.has(term));
    const words = shared.filter((term) => !/^\d/u.test(term));
    if (words.length >= 2 || (words.length === 1 && shared.length >= 2)) scored.push({ id: candidate.id, group: candidate.group ?? candidate.id, shared, score: shared.length + (candidate.weight ?? 0) });
  }
  // One lead per function: its best-matching rule stands for the rest.
  const best = new Map();
  for (const entry of scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en'))) if (!best.has(entry.group)) best.set(entry.group, entry);
  return [...best.values()].slice(0, limit);
}
