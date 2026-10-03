/**
 * The accepted-scope inventory of a Story [E2G-006].
 *
 * Every normative statement the extractor identifies in the Story's sources (its pinned source
 * record, its active documents and its answered clarifications) becomes one item, and every item
 * carries a disposition:
 *
 * - included: a clause states it (its normalized text equals or contains the statement, or a
 *   person linked the clauses), so the clause's own row carries its evidence;
 * - existing: behaviour that already exists, linked to the clauses that verify it;
 * - excluded, deferred: a scope decision a person recorded with a reason, never an exception;
 * - informative, duplicate, superseded: not a requirement of this Story, said by a person (or, for a
 *   statement repeated verbatim in another source, by the inventory itself);
 * - unresolved: nobody has said yet. An unresolved item blocks completion.
 *
 * A source the extractor cannot read is listed as unreadable: it can never count as reviewed until
 * a person records a decision for it. Pure apart from reading the Story's files; never throws for a
 * source problem, which it reports instead.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { extractNormativeStatements, normalizeStatement, scopeItemId, storySourceStatements } from './extract.mjs';
import { extractSourceText, isTextualSource } from '../source-text.mjs';

export const SCOPE_INVENTORY_VERSION = 'scope-inventory/v1';
export const SCOPE_DISPOSITIONS = Object.freeze([
  'included', 'existing', 'excluded', 'deferred', 'unresolved', 'informative', 'duplicate', 'superseded'
]);
/** Dispositions a person records with `decision scope`. */
export const DECIDABLE_SCOPE_DISPOSITIONS = Object.freeze(['included', 'existing', 'excluded', 'deferred', 'informative', 'duplicate', 'superseded']);
/** Dispositions that must name the clauses that carry the statement. */
export const CLAUSE_LINKED_DISPOSITIONS = Object.freeze(['included', 'existing']);
const MAX_SOURCE_TEXT = 1024 * 1024;
const MIN_CONTAINMENT = 12;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** The text of one document, or why it has none. */
async function documentText(root, record) {
  if (record.type === 'url') return { readable: false, reason: 'external-reference' };
  if (record.storage?.kind === 'local' || !record.path) return { readable: false, reason: 'machine-local-storage' };
  let bytes;
  try { bytes = await readFile(path.join(root, record.path)); } catch { return { readable: false, reason: 'missing' }; }
  if (bytes.length === 0) return { readable: false, reason: 'empty-text' };
  if (isTextualSource(record.mimeType, record.sourceName ?? record.path)) {
    const text = bytes.toString('utf8');
    return text.length > MAX_SOURCE_TEXT ? { readable: false, reason: 'too-large-to-cite' } : { readable: true, text };
  }
  const extracted = await extractSourceText(bytes, record.mimeType);
  if (extracted?.status !== 'extracted' || !extracted.text?.trim()) return { readable: false, reason: extracted?.reason ?? 'no-text-layer' };
  return extracted.text.length > MAX_SOURCE_TEXT ? { readable: false, reason: 'too-large-to-cite' } : { readable: true, text: extracted.text };
}

/** Every source the inventory reads, with the statements found in it or why it could not be read. */
async function scopeSources(root, directory, workflow, source) {
  const sources = [];
  if (source) {
    const text = JSON.stringify(source);
    sources.push({ id: 'story', kind: 'story', path: path.relative(root, path.join(directory, 'source.json')), sha256: sha256(text), readable: true, statements: storySourceStatements(source) });
  }
  const manifest = await readJson(path.join(directory, 'documents.json'));
  for (const record of manifest?.documents ?? []) {
    if (record.status === 'detached' || !record.id) continue;
    const read = await documentText(root, record);
    sources.push({
      id: record.id, kind: 'document', name: record.name ?? record.label ?? record.id, path: record.path ?? record.url ?? null,
      sha256: record.sha256 ?? null, readable: read.readable, ...(read.readable ? {} : { reason: read.reason }),
      statements: read.readable ? extractNormativeStatements(read.text, { sourceId: record.id }) : []
    });
  }
  let entries = [];
  try { entries = (await readdir(path.join(directory, 'context'))).filter((name) => /^clarifications-.+-gen\d+\.json$/u.test(name)).sort(); } catch { entries = []; }
  for (const name of entries) {
    const record = await readJson(path.join(directory, 'context', name));
    for (const response of record?.responses ?? []) {
      if (response?.status !== 'answered' || typeof response.answer !== 'string') continue;
      const id = `clarification:${record.phase}:${response.id}`;
      sources.push({
        id, kind: 'clarification', path: path.relative(root, path.join(directory, 'context', name)), sha256: sha256(response.answer),
        readable: true, statements: extractNormativeStatements(response.answer, { sourceId: id })
      });
    }
  }
  return sources;
}

/** The clauses whose statement is this one, by normalized equality or clear containment. */
function matchingClauses(text, clauses) {
  const wanted = normalizeStatement(text);
  return clauses.filter((clause) => {
    const body = normalizeStatement(clause.body);
    if (!body || !wanted) return false;
    if (body === wanted) return true;
    const shorter = body.length < wanted.length ? body : wanted;
    const longer = shorter === body ? wanted : body;
    return shorter.length >= MIN_CONTAINMENT && longer.includes(shorter);
  }).map((clause) => clause.id).sort();
}

/** The latest decision a person recorded for each item or source, kept only while its statement is unchanged. */
function decisionsByItem(workflow) {
  const decided = new Map();
  for (const entry of workflow?.scopeDispositions ?? []) {
    if (entry?.withdrawnAt) continue;
    decided.set(entry.item, entry);
  }
  return decided;
}

/**
 * Build the inventory from the Story's sources and clauses. `clauses` are the clause records of the
 * Story's active specification indexes.
 */
export async function buildScopeInventory(root, directory, workflow, { source, clauses, scopeNotApplicable = false }) {
  const sources = await scopeSources(root, directory, workflow, source);
  const decided = decisionsByItem(workflow);
  const firstSeen = new Map();
  const items = [];
  for (const entry of sources) {
    if (!entry.readable) {
      const decision = decided.get(entry.id);
      items.push({
        id: entry.id, kind: 'source', sourceId: entry.id, line: null,
        text: `${entry.name ?? entry.id} could not be read (${entry.reason})`, statementSha256: entry.sha256 ?? null,
        disposition: decision && (decision.statementSha256 ?? null) === (entry.sha256 ?? null) ? decision.disposition : 'unresolved',
        clauseIds: decision?.clauseIds ?? [], decision: decision ?? null, reason: entry.reason
      });
      continue;
    }
    for (const statement of entry.statements) {
      const id = scopeItemId(entry.id, statement.text);
      const decision = decided.get(id);
      const current = decision && decision.statementSha256 === statement.statementSha256 ? decision : null;
      const matched = matchingClauses(statement.text, clauses);
      let disposition = 'unresolved';
      let clauseIds = [];
      let duplicateOf = null;
      if (current) {
        disposition = current.disposition;
        clauseIds = [...(current.clauseIds ?? [])];
      } else if (matched.length) {
        disposition = 'included';
        clauseIds = matched;
      } else if (firstSeen.has(statement.statementSha256)) {
        disposition = 'duplicate';
        duplicateOf = firstSeen.get(statement.statementSha256);
      }
      if (!firstSeen.has(statement.statementSha256)) firstSeen.set(statement.statementSha256, id);
      items.push({
        id, kind: 'statement', sourceId: entry.id, line: statement.line, field: statement.field ?? null, signal: statement.signal,
        text: statement.text, statementSha256: statement.statementSha256, disposition, clauseIds,
        ...(duplicateOf ? { duplicateOf } : {}), decision: current ?? null,
        ...(decision && !current ? { staleDecision: true } : {})
      });
    }
  }
  // A person in the omission's group decided this Story has no scope to define: that decision covers
  // every statement nobody dispositioned, and the inventory says so rather than hiding them.
  if (scopeNotApplicable) {
    for (const item of items) {
      if (item.disposition === 'unresolved') Object.assign(item, { disposition: 'informative', coveredBy: 'scope-not-applicable' });
    }
  }
  const summary = Object.fromEntries(SCOPE_DISPOSITIONS.map((name) => [name, items.filter((item) => item.disposition === name).length]));
  const core = items.map(({ id, statementSha256: digest, disposition, clauseIds, coveredBy }) => ({ id, statementSha256: digest, disposition, clauseIds, coveredBy: coveredBy ?? null }));
  return Object.freeze({
    schema: SCOPE_INVENTORY_VERSION,
    workId: workflow.workItem.id,
    sources: sources.map(({ statements, ...rest }) => ({ ...rest, statements: statements.length })),
    sourceSetSha256: `sha256:${sha256(JSON.stringify(sources.map(({ id, sha256: digest, readable }) => ({ id, sha256: digest, readable }))))}`,
    items,
    summary,
    // Structurally complete: every identified item has a disposition. Whether a person reviewed the
    // interpretation is a separate decision, never implied by this.
    structurallyComplete: summary.unresolved === 0,
    inventorySha256: `sha256:${sha256(JSON.stringify(core))}`
  });
}
