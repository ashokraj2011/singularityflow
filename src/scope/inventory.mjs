/**
 * The accepted-scope inventory of a Story [E2G-006].
 *
 * Every normative statement the extractor identifies in the Story's sources (its pinned source
 * record, its active documents and its answered clarifications) becomes one item, and every item
 * carries a disposition:
 *
 * - included: a clause states it (its normalized text equals or contains the statement, an
 *   authored source reference links it, or a person linked the clauses), so the clause's own row
 *   carries its evidence; a link is never a test result or an approval;
 * - existing: behaviour that already exists, linked to the clauses that verify it;
 * - excluded, deferred: a scope decision a person recorded with a reason, never an exception;
 * - informative, duplicate, superseded: not a requirement of this Story, said by a person (or, for a
 *   statement repeated verbatim in another source, by the inventory itself);
 * - unresolved: nobody has said yet. An unresolved item blocks completion.
 *
 * A source the extractor cannot read is listed as unreadable. An attached document among them (an
 * image, a file kept only on one machine, a link) is not a decision of its own: a clause that cites
 * it by ID covers it, and otherwise it is background, reviewed with the specification that cites or
 * omits it. It used to wait as an open decision nobody was asked, and blocked the Story's last step
 * (ws-graph, 2026-10-27). Pure apart from reading the Story's files; never throws for a source
 * problem, which it reports instead.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { countedRecords, inDecisionOrder, isWithdrawn } from '../presence/counted.mjs';

import {extractNormativeStatements,storySourceStatements} from './extract.mjs';
import {scopeInventory} from '../engine-compatibility/node-scope-policy.mjs';
export {SCOPE_INVENTORY_VERSION,SCOPE_DISPOSITIONS} from '../kernel/scope-inventory.mjs';
import { extractSourceText, isTextualSource } from '../source-text.mjs';

const MAX_SOURCE_TEXT = 1024 * 1024;

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

/** The latest decision a person recorded for each item or source, kept only while its statement is unchanged. */
function decisionsByItem(workflow) {
  const decided = new Map();
  for (const entry of inDecisionOrder(workflow, countedRecords(workflow, workflow?.scopeDispositions))) {
    if (isWithdrawn(workflow, entry)) continue;
    decided.set(entry.item, entry);
  }
  return decided;
}


export async function buildScopeInventory(root,directory,workflow,{source,clauses,scopeNotApplicable=false}) {
  const sources=await scopeSources(root,directory,workflow,source);
  return scopeInventory.buildScopeInventoryValue(workflow,{sources,clauses,scopeNotApplicable,decisions:[...decisionsByItem(workflow).values()]});
}
