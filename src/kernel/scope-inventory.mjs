/** Inventory from actual observed sources, clauses and admitted person records. No file reads. */
import {textDigestCapability} from '../foundation/record-schema.mjs';
import {scopeStatementPolicies,CLAUSE_LINKED_DISPOSITIONS} from './scope-statements.mjs';
export const SCOPE_INVENTORY_VERSION = 'scope-inventory/v1';
export const SCOPE_DISPOSITIONS = Object.freeze(['included','existing','excluded','deferred','unresolved','informative','duplicate','superseded']);

export function scopeInventoryPolicies(port) {
const {sha256Utf8:sha256}=textDigestCapability(port),{normalizeStatement,scopeItemId,clauseScopeItems}=scopeStatementPolicies(port);
const MIN_CONTAINMENT=12;
/** The clauses whose statement is this one, by normalized equality or clear containment. */
function matchingClauses(text, clauses, itemId) {
  const wanted = normalizeStatement(text);
  return clauses.filter((clause) => {
    const body = normalizeStatement(String(clause.body ?? '').replace(/\[scope:SRI-[0-9a-f]{12}\]/gu, ''));
    if (!body || !wanted) return false;
    // A short request such as "test cases" needs an explicit authored coverage claim, not a
    // lowered substring threshold that would silently satisfy unrelated short requirements.
    if (clauseScopeItems(clause.body).includes(itemId) && body.length >= MIN_CONTAINMENT) return true;
    if (body === wanted) return true;
    const shorter = body.length < wanted.length ? body : wanted;
    const longer = shorter === body ? wanted : body;
    return shorter.length >= MIN_CONTAINMENT && longer.includes(shorter);
  }).map((clause) => clause.id).sort();
}

const ATTACHMENT_WORDS = Object.freeze({
  'machine-local-storage': 'kept on one machine', 'external-reference': 'a link', 'no-text-layer': 'no text to read',
  'too-large-to-cite': 'too large to cite', 'empty-text': 'empty'
});

/** The clauses that cite a document by its ID, as text or as a `[scope:DOC-…]` reference. */
function citingClauses(documentId, clauses) {
  const named = new RegExp(`(?<![A-Za-z0-9-])${documentId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![A-Za-z0-9-])`, 'u');
  return clauses.filter((clause) => named.test(clause.body ?? '') || clauseScopeItems(clause.body ?? '').includes(documentId))
    .map((clause) => clause.id).sort();
}

function decisionIsCurrent(decision, statementSha, knownClauses) {
  return decision && (decision.statementSha256 ?? null) === (statementSha ?? null)
    && (!CLAUSE_LINKED_DISPOSITIONS.includes(decision.disposition)
      || decision.clauseIds?.length > 0 && decision.clauseIds.every(id => knownClauses.has(id)));
}

/**
 * Build the inventory from the Story's sources and clauses. `clauses` are the clause records of the
 * Story's active specification indexes.
 */
function buildScopeInventoryValue(workflow,{sources,clauses,scopeNotApplicable=false,decisions=[]}) {
  const decided=new Map(decisions.map(entry=>[entry.item,entry]));
  const knownClauses = new Set(clauses.map(clause => clause.id));
  const firstSeen = new Map();
  const items = [];
  for (const entry of sources) {
    if (!entry.readable) {
      const decision = decided.get(entry.id);
      const current = decisionIsCurrent(decision, entry.sha256, knownClauses);
      // A person's decision wins; a stale one (its clauses gone) stays for that person to make again,
      // and a file the record names but nobody can find stays open.
      const attachment = entry.kind === 'document' && entry.reason !== 'missing' && !decision;
      const citing = attachment ? citingClauses(entry.id, clauses) : [];
      items.push({
        id: entry.id, kind: 'source', sourceId: entry.id, line: null,
        text: attachment ? `${entry.name ?? entry.id} is attached (${ATTACHMENT_WORDS[entry.reason] ?? 'no text to read'})`
          : `${entry.name ?? entry.id} could not be read (${entry.reason})`, statementSha256: entry.sha256 ?? null,
        disposition: current ? decision.disposition : attachment ? (citing.length ? 'included' : 'informative') : 'unresolved',
        clauseIds: current ? decision.clauseIds ?? [] : citing, decision: current ? decision : null,
        ...(attachment ? { coveredBy: citing.length ? 'clause-citation' : 'attached-document' } : {}),
        ...(decision && !current ? { staleDecision: true } : {}), reason: entry.reason
      });
      continue;
    }
    for (const statement of entry.statements) {
      const id = scopeItemId(entry.id, statement.text);
      const decision = decided.get(id);
      const current = decisionIsCurrent(decision, statement.statementSha256, knownClauses) ? decision : null;
      const matched = matchingClauses(statement.text, clauses, id);
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

return Object.freeze({buildScopeInventoryValue});
}
