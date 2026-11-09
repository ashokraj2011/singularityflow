/** Shared, pure scope-to-plan verification contract. A non-test method is proof, not a waiver. */
import { SingularityFlowError } from '../util.mjs';
import { VERIFICATION_METHODS } from './contracts.mjs';
import { shown } from '../draft-diagnostics.mjs';

const AC = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u;
const cells = line => line.trim().startsWith('|') && line.trim().endsWith('|')
  ? line.trim().slice(1, -1).split('|').map(cell => cell.trim()) : null;
const unwrap = value => String(value ?? '').trim().replace(/^`([^`]+)`$/u, '$1').toUpperCase();
const invalid = (message, details = {}) => new SingularityFlowError(message, {
  code: 'SPEC_VERIFICATION_INTENT_INVALID', details: { repairScope: 'current-draft', ...details }
});

/** The caller supplies author-visible Markdown (no managed inputs, comments or fenced examples). */
export function parseVerificationIntent(markdown, clauses = [], { externalClauses = [] } = {}) {
  const lines = String(markdown).split(/\r?\n/u);
  const known = new Map([...externalClauses, ...clauses].map(clause => [clause.id, clause]));
  const declaredIds = new Set(clauses.map(clause => clause.id));
  const intents = new Map();
  let inside = false;
  let declared = false;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^#{1,6}\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      inside = /^verification intent$/iu.test(heading[1].trim());
      if (inside && declared) throw invalid('Declare Verification intent once.');
      declared ||= inside;
      continue;
    }
    if (!inside) continue;
    const header = cells(lines[index]);
    if (!header) continue;
    if (header.map(cell => cell.toLowerCase()).join('|') !== 'clause|methods|criterion') {
      throw invalid(`Verification intent needs one table whose header is exactly Clause | Methods | Criterion; the table at line ${index + 1} has ${shown(header.join(' | '))}. Keep any legend or notes outside the table.`, { line: index + 1 });
    }
    const divider = cells(lines[++index] ?? '');
    if (divider?.length !== 3 || !divider.every(cell => /^:?-{3,}:?$/u.test(cell))) {
      throw invalid('Verification intent needs a Markdown divider row.', { line: index + 1 });
    }
    while (index + 1 < lines.length && cells(lines[index + 1])) {
      const row = cells(lines[++index]);
      const id = unwrap(row[0]);
      if (row.length !== 3) {
        throw invalid(`Verification intent row at line ${index + 1} has ${row.length} cells; Clause | Methods | Criterion has three.`, { line: index + 1 });
      }
      if (intents.has(id)) {
        throw invalid(`Verification intent lists ${id} twice (line ${index + 1}); give each clause one row.`, { clauseId: id, line: index + 1 });
      }
      if (!declaredIds.has(id)) {
        const local = [...declaredIds].find(candidate => candidate.endsWith(`:${id}`));
        throw invalid(`Verification intent row at line ${index + 1} names ${shown(row[0])}, which is not a clause this draft declares; `
          + (local ? `write it in full, as \`${local}\`.` : 'write a declared clause ID in full, such as `ORDER:REQ-001`.'), { clauseId: id, line: index + 1 });
      }
      const methods = row[1].split(',').map(method => unwrap(method).toLowerCase());
      if (!methods.length || new Set(methods).size !== methods.length || methods.some(method => !VERIFICATION_METHODS.includes(method))) {
        throw invalid(`${id} Methods must be test, visual, inspection, or a comma-separated combination (all required); it holds ${shown(row[1])}.`, { clauseId: id, line: index + 1 });
      }
      const rawCriterion = unwrap(row[2]);
      const criterionId = !rawCriterion || rawCriterion === '-' ? (AC.test(id) ? id : null) : rawCriterion;
      if (criterionId && (!AC.test(criterionId) || !known.has(criterionId) || (AC.test(id) && criterionId !== id))) {
        throw invalid(`${id} Criterion must be its own AC ID, or a declared AC proving this requirement, such as \`ORDER:AC-001\`, or -; it holds ${shown(row[2])}.`, { clauseId: id, line: index + 1 });
      }
      if (methods.some(method => method !== 'test') && !criterionId) {
        throw invalid(`${id} needs an AC Criterion for its visual/inspection proof.`, { clauseId: id, line: index + 1 });
      }
      intents.set(id, { methods: methods.sort(), criterionId });
    }
  }
  if (!declared) return intents; // Historical publications remain readable without inventing intent.
  const missing = [...declaredIds].filter(id => !intents.has(id));
  if (missing.length) throw invalid(`Verification intent is missing clauses: ${missing.join(', ')}.`, { clauses: missing });
  for (const [id, intent] of intents) {
    const criterion = intents.get(intent.criterionId) ?? known.get(intent.criterionId)?.verification;
    const uncovered = intent.criterionId ? intent.methods.filter(method => !criterion?.methods.includes(method)) : [];
    if (uncovered.length) {
      // Name the missing methods and both ways out: "must be covered" alone sent an author to edit
      // the requirement's prose, twice, instead of this table (graph-plot, 2026-10-26).
      throw invalid(`${id} is proven by ${intent.methods.join(', ')}, but its criterion ${intent.criterionId} lists only `
        + `${criterion?.methods?.length ? criterion.methods.join(', ') : 'no methods'} in Verification intent: add ${uncovered.join(', ')} `
        + `to ${intent.criterionId}'s Methods, or remove ${uncovered.length === 1 ? 'it' : 'them'} from ${id}'s.`, { clauseId: id, uncovered });
    }
  }
  return intents;
}

/** No filename/prose inference: only exact primary slots can declare non-executable proof. */
export function nonTestVerification(clauseId, claim, contracts, intent = null) {
  if (intent?.methods.includes('test')) return null;
  if (!AC.test(clauseId) && !intent) return null;
  if (intent && claim?.verificationCriterion && claim.verificationCriterion !== intent.criterionId) return null;
  const criterionId = claim?.verificationCriterion ?? intent?.criterionId ?? (AC.test(clauseId) ? clauseId : null);
  if (AC.test(clauseId) && criterionId !== clauseId) return null;
  const contract = contracts?.get?.(criterionId);
  const primary = contract?.slots?.filter(slot => slot.role === 'primary') ?? [];
  // A requirement proven under another clause's AC borrows only the methods its approved intent names;
  // that AC's own primary test slot still binds the AC, so it waives nothing here. A criterion claimed
  // non-test itself must have no primary test slot, or an automated test would be waived.
  const borrowed = Boolean(intent) && criterionId !== clauseId;
  if (!primary.length || (!borrowed && primary.some(slot => !['visual', 'inspection'].includes(slot.method)))) return null;
  if (intent && intent.methods.some(method => !primary.some(slot => slot.method === method))) return null;
  if (intent && contract.combination === 'any'
      && primary.some(slot => intent.methods.some(method => slot.method !== method))) return null;
  return contract;
}

/**
 * Plans must implement approved methods, never downgrade them to supporting proof or an exemption.
 * A refusal's `cause` says whose output it judges [PHR:REQ-001]: `plan-row` is the plan's own row or
 * contract, its author's to correct; `intent-not-met` is the plan falling short of the approved intent,
 * which the plan may correct, or the step that defined the clause may, when the intent is what is wrong.
 */
export function validatePlannedVerification(claims, contracts = [], clauses = []) {
  const byCriterion = new Map(contracts.map(contract => [contract.clauseId, contract]));
  const byClause = new Map(clauses.map(clause => [clause.id, clause]));
  for (const [id, claim] of Object.entries(claims)) {
    const intent = byClause.get(id)?.verification;
    if (claim.testDisposition === 'non-test') {
      if ((!AC.test(id) && !intent) || (intent && claim.verificationCriterion !== intent.criterionId)
          || !nonTestVerification(id, claim, byCriterion, intent)) {
        const criterion = claim.verificationCriterion ?? intent?.criterionId ?? (AC.test(id) ? id : null);
        const primary = byCriterion.get(criterion)?.slots?.filter(slot => slot.role === 'primary') ?? [];
        const tested = criterion === id && primary.some(slot => !['visual', 'inspection'].includes(slot.method));
        const missing = !AC.test(id) && !intent ? `${id} is not an acceptance criterion and has no approved Verification intent`
          : intent && claim.verificationCriterion !== intent.criterionId ? `Planned tests says verification: ${claim.verificationCriterion ?? 'nothing'}, but the approved criterion is ${intent.criterionId}`
            : !byCriterion.get(criterion) ? `the Verification contracts table has no row with Criterion \`${criterion}\``
              // Its own contract has a primary test slot: plan that test for it rather than call it non-test.
              : tested ? `${criterion}'s own contract has a primary test slot, so plan its test paths instead of verification: ${criterion}`
                : `${criterion}'s contract rows have no primary visual or inspection slot${intent ? ` for every method ${id} lists (${intent.methods.join(', ')})` : ''}`;
        throw invalid(`${id} non-test proof needs its approved AC Criterion and exact primary visual/inspection contract; it cannot waive an automated test. Missing: ${missing}.`, { clauseId: id, cause: 'plan-row' });
      }
    }
    if (!intent) continue;
    const contract = byCriterion.get(intent.criterionId);
    const primary = contract?.slots?.filter(slot => slot.role === 'primary')
      ?? (claims[intent.criterionId]?.tests?.length ? [{ method: 'test', role: 'primary' }] : []);
    if (intent.methods.includes('test') && (!claim.tests.length || claim.testDisposition !== 'applicable')) {
      throw invalid(`${id} requires automated tests in the approved Specification; plan exact test paths instead of an exemption.`, { clauseId: id, cause: 'intent-not-met' });
    }
    for (const method of intent.methods) {
      // Exact planned test paths implement the historical default test contract. Other methods
      // always need a typed primary slot, including when a requirement shares an AC's proof.
      if (method === 'test' && !contract && (!intent.criterionId || intent.criterionId === id)) continue;
      if (!primary.some(slot => slot.method === method)) {
        throw invalid(`${id} requires primary ${method} proof under ${intent.criterionId}; a supporting slot does not satisfy approved intent.`, { clauseId: id, cause: 'intent-not-met' });
      }
    }
    if (contract?.combination === 'any' && primary.some(slot => intent.methods.some(method => slot.method !== method))) {
      throw invalid(`${id} requires all approved verification methods; Combination any would weaken the Specification.`, { clauseId: id, cause: 'intent-not-met' });
    }
  }
}
