/**
 * The assisted-interpretation relay, as an explicit contract. `[INT:CON-069]` `[INT:CON-098]` `[INT:CON-099]`
 *
 * "The existing relay contract" was, until this module, a pattern rather than a contract: the
 * convergence pass (`assisted-convergence.mjs`, `[SPK:REQ-076]`) hands a host model the deterministic
 * facts and accepts back only candidates that cite them. This makes that shape reusable and
 * checkable for impact and investigation.
 *
 * The kernel never calls a model, so with no model available every deterministic read, explicit
 * command and ceremony still works `[INT:CON-151]`. It returns a relay request — the fact set, its hash, and the one
 * response shape it will accept — and a host that has a model answers with interpretations. Each
 * interpretation is a risk, a question or a hypothesis, cites at least one fact by ID, and carries
 * no confidence number. A response that tries to add, remove or reclassify a fact is rejected
 * whole; a single interpretation citing a fact that does not exist is rejected alone. The facts in
 * the result are the deterministic facts, untouched, whatever came back.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../specifications.mjs';

export const RELAY_CONTRACT = 'sflow-assisted-relay-v1';
export const INTERPRETATION_KINDS = Object.freeze(['risk', 'question', 'hypothesis']);
const MAX_INTERPRETATIONS = 12;
const MAX_TEXT = 600;
/** Keys a response may not carry: each is a way of reaching into the deterministic facts. */
const FORBIDDEN_KEYS = Object.freeze(['facts', 'findings', 'add', 'remove', 'delete', 'reclassify', 'affected', 'confidence']);

/** Stable IDs for a fact list, so a citation names the same fact in every recomputation. */
export function relayFacts(entries) {
  return entries.map((entry) => ({
    id: `F-${createHash('sha256').update(canonicalJson([entry.kind, entry.statement])).digest('hex').slice(0, 10)}`,
    kind: entry.kind,
    statement: String(entry.statement).slice(0, 300)
  }));
}

export function relayRequest(operationId, facts) {
  return Object.freeze({
    contract: RELAY_CONTRACT,
    operation: operationId,
    factSetHash: `sha256:${createHash('sha256').update(canonicalJson(facts)).digest('hex')}`,
    facts,
    response: {
      shape: { factSetHash: 'the factSetHash above', interpretations: [{ kind: INTERPRETATION_KINDS.join('|'), text: 'string', cites: ['F-…'] }] },
      rules: [
        'Interpret; do not restate, add, remove or re-rank any fact.',
        'Every interpretation cites at least one fact ID from this request.',
        `At most ${MAX_INTERPRETATIONS} interpretations of at most ${MAX_TEXT} characters; no numeric confidence.`
      ]
    }
  });
}

/** Check a host's answer against the request it answers. Never throws; reports what it refused. */
export function validateInterpretation(request, text) {
  let response;
  try { response = typeof text === 'string' ? JSON.parse(text) : text; } catch {
    return { status: 'rejected', reason: 'not-json', accepted: [], rejected: [] };
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { status: 'rejected', reason: 'not-an-object', accepted: [], rejected: [] };
  }
  const touched = FORBIDDEN_KEYS.filter((key) => Object.hasOwn(response, key));
  if (touched.length) return { status: 'rejected', reason: 'interpretation-touches-facts', touched, accepted: [], rejected: [] };
  if (response.factSetHash !== request.factSetHash) return { status: 'rejected', reason: 'fact-set-mismatch', accepted: [], rejected: [] };
  const known = new Set(request.facts.map((fact) => fact.id));
  const accepted = [];
  const rejected = [];
  for (const [index, entry] of (Array.isArray(response.interpretations) ? response.interpretations : []).slice(0, MAX_INTERPRETATIONS).entries()) {
    const cites = Array.isArray(entry?.cites) ? entry.cites.map(String) : [];
    const problem = !INTERPRETATION_KINDS.includes(entry?.kind) ? 'unknown-kind'
      : typeof entry?.text !== 'string' || !entry.text.trim() ? 'no-text'
        : !cites.length ? 'cites-nothing'
          : cites.some((id) => !known.has(id)) ? 'cites-unknown-fact'
            : Object.keys(entry).some((key) => !['kind', 'text', 'cites'].includes(key)) ? 'unknown-field' : null;
    if (problem) rejected.push({ index, reason: problem });
    else accepted.push(Object.freeze({ kind: entry.kind, text: entry.text.slice(0, MAX_TEXT), cites, source: 'assisted' }));
  }
  return { status: 'accepted', accepted, rejected };
}
