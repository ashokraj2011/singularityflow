/**
 * Verification contracts: how each acceptance criterion must be verified [E2G-013].
 *
 * A plan states them in its own `## Verification contracts` table, separate from the planned-
 * evidence table, and they are validated when the plan is published, before any code exists. Each
 * row is one witness slot of one criterion: its method (an automated test, an inspection of an
 * exact file, or visual evidence), the planned witness, whether it is primary or only supporting,
 * and the assurance it must reach. A criterion's primary slots combine with `all` (the default) or,
 * with a reviewed reason, `any`. Supporting slots never satisfy a criterion, and an empty primary set
 * is refused, so no witness set can ever produce a pass. A criterion with no row keeps the default
 * contract: one test slot over its planned tests.
 *
 * Pure: no file, process or network access, so the evaluator and every surface can use it.
 */
import path from 'node:path';

import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';

export const VERIFICATION_METHODS = Object.freeze(['test', 'inspection', 'visual']);
const UNSUPPORTED_METHODS = Object.freeze(['measurement', 'analysis', 'browser-check', 'security-scan', 'operational', 'manual']);
const SLOT_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const AC_ID = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u;
const REQUIRED_COLUMNS = Object.freeze(['criterion', 'slot', 'method', 'witness']);
const OPTIONAL_COLUMNS = Object.freeze(['role', 'required assurance', 'combination', 'reason']);
/** What each method can reach; nothing here is authenticated before qualified execution (M4). */
const METHOD_ASSURANCE = Object.freeze({
  test: Object.freeze(['module-observed', 'exact-local-observed']),
  inspection: Object.freeze(['declared', 'source-bound']),
  visual: Object.freeze(['declared', 'source-bound'])
});
const MAX_ROWS = 1000;

function invalid(message, details = {}) {
  return new SingularityFlowError(message, { code: 'SPEC_VERIFICATION_CONTRACT_INVALID', details });
}

function digest(value) {
  return `sha256:${recordSha256(value)}`;
}

function cells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

function unwrap(cell) {
  let value = String(cell ?? '').trim();
  if (value.startsWith('`') && value.endsWith('`') && value.length > 1 && value.indexOf('`', 1) === value.length - 1) value = value.slice(1, -1).trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1).trim();
  return value;
}

/** One exact repository-relative path: no traversal, globs, placeholders or platform syntax. */
function exactPath(value, label) {
  const candidate = String(value ?? '');
  const normalized = path.posix.normalize(candidate);
  if (!candidate || candidate !== candidate.trim() || normalized !== candidate || candidate === '.'
      || candidate.startsWith('../') || candidate === '..' || path.posix.isAbsolute(candidate)
      || candidate.includes('\\') || /^[A-Za-z]:/u.test(candidate) || /^[a-z][a-z0-9+.-]*:/iu.test(candidate)
      || /[\0-\x1f\x7f*?[\]{}<>$]/u.test(candidate) || candidate.endsWith('/')) {
    throw invalid(`${label} must be one exact repository-relative path in backticks.`);
  }
  return candidate;
}

/** The authored lines that count: fenced code blocks are examples, never contracts. */
function visibleLines(markdown) {
  let fence = null;
  return String(markdown ?? '').split(/\r?\n/u).map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      return '';
    }
    return fence ? '' : line;
  });
}

function witnessCell(method, cell, label) {
  const source = String(cell ?? '').trim();
  const values = [...source.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]);
  const rest = source.replace(/`[^`\n]+`/gu, '').trim();
  if (values.length !== 1 || rest) throw invalid(`${label} must name exactly one witness in backticks.`);
  if (method === 'visual') {
    const target = values[0].trim();
    if (!target || target.length > 200 || /[\0-\x1f\x7f]/u.test(target)) throw invalid(`${label} must name the screen or scenario its visual evidence shows, in at most 200 characters.`);
    return { target };
  }
  return { path: exactPath(values[0], label) };
}

/**
 * Parse the plan's `## Verification contracts` table. `clauseIds` are the Story's indexed clause
 * IDs and `plannedClaims` its planned claim map claims, so a test slot can be checked against the
 * criterion's planned tests. Returns the contracts sorted by criterion; throws on any defect.
 */
export function parseVerificationContracts(markdown, { clauseIds = [], plannedClaims = {} } = {}) {
  const known = new Set(clauseIds.map((id) => String(id).toUpperCase()));
  const lines = visibleLines(markdown);
  const rows = [];
  let inside = false;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) { inside = /^verification contracts$/iu.test(heading[2].trim()); continue; }
    if (!inside) continue;
    const header = cells(lines[index]);
    if (!header) continue;
    const names = header.map((cell) => cell.toLowerCase().replace(/\s+/gu, ' '));
    if (names.slice(0, 4).join('|') !== REQUIRED_COLUMNS.join('|')
        || names.slice(4).some((name) => !OPTIONAL_COLUMNS.includes(name)) || new Set(names).size !== names.length) {
      throw invalid(`The verification contracts table at line ${index + 1} must start with Criterion | Slot | Method | Witness and may add Role, Required assurance, Combination and Reason, each once.`);
    }
    const divider = cells(lines[index + 1] ?? '');
    if (!divider || divider.length !== names.length || !divider.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
      throw invalid(`The verification contracts table at line ${index + 1} must be followed by a Markdown divider row.`);
    }
    for (index += 2; index < lines.length; index += 1) {
      const row = cells(lines[index]);
      if (!row) { index -= 1; break; }
      if (row.length !== names.length) throw invalid(`Verification contract row at line ${index + 1} must have ${names.length} columns.`);
      if (rows.length >= MAX_ROWS) throw invalid(`A plan may state at most ${MAX_ROWS} verification contract rows.`);
      rows.push({ line: index + 1, value: (name) => (names.indexOf(name) < 0 ? '' : row[names.indexOf(name)]) });
    }
    inside = false;
  }
  const byClause = new Map();
  for (const row of rows) {
    const where = `Verification contract row at line ${row.line}`;
    const clauseId = unwrap(row.value('criterion')).toUpperCase();
    if (!AC_ID.test(clauseId)) throw invalid(`${where} must name one namespace-qualified acceptance criterion, such as ORDER:AC-001.`);
    if (known.size && !known.has(clauseId)) throw invalid(`${where} names ${clauseId}, which is not a criterion of this Story.`);
    const slot = unwrap(row.value('slot')).toLowerCase();
    if (!SLOT_ID.test(slot)) throw invalid(`${where} needs a slot name of lowercase letters, digits and hyphens, such as unit or review.`);
    const method = unwrap(row.value('method')).toLowerCase();
    if (!VERIFICATION_METHODS.includes(method)) {
      throw invalid(UNSUPPORTED_METHODS.includes(method)
        ? `${where} uses ${method}, which this repository cannot verify yet; use ${VERIFICATION_METHODS.join(', ')}, or record a risk decision when the Story ends.`
        : `${where} must use one method of ${VERIFICATION_METHODS.join(', ')}.`, { clauseId, method });
    }
    const role = unwrap(row.value('role')).toLowerCase() || 'primary';
    if (!['primary', 'supporting'].includes(role)) throw invalid(`${where} must be primary or supporting.`);
    const requiredAssurance = unwrap(row.value('required assurance')).toLowerCase() || null;
    if (requiredAssurance === 'exact-authenticated') {
      throw invalid(`${where} requires exact-authenticated, which needs qualified execution this repository does not have; require exact-local-observed or less.`);
    }
    if (requiredAssurance && !METHOD_ASSURANCE[method].includes(requiredAssurance)) {
      throw invalid(`${where} may require only ${METHOD_ASSURANCE[method].join(' or ')} for a ${method} witness.`);
    }
    const combination = unwrap(row.value('combination')).toLowerCase() || null;
    if (combination && !['all', 'any'].includes(combination)) throw invalid(`${where} must combine with all or any.`);
    const reason = String(row.value('reason') ?? '').trim() || null;
    if (reason && (reason.length < 10 || reason.length > 500 || /[\0-\x1f\x7f]/u.test(reason))) {
      throw invalid(`${where} needs a reason of 10 to 500 characters.`);
    }
    const witness = witnessCell(method, row.value('witness'), `${where}'s witness`);
    const contract = byClause.get(clauseId) ?? { clauseId, combinations: new Set(), reasons: [], slots: [] };
    if (contract.slots.some((entry) => entry.slot === slot)) throw invalid(`${clauseId} names slot ${slot} more than once.`);
    if (combination) contract.combinations.add(combination);
    if (reason) contract.reasons.push(reason);
    contract.slots.push({ slot, method, role, witness, requiredAssurance });
    byClause.set(clauseId, contract);
  }
  const contracts = [];
  for (const contract of [...byClause.values()].sort((left, right) => left.clauseId.localeCompare(right.clauseId))) {
    if (contract.combinations.size > 1) throw invalid(`${contract.clauseId} combines its witnesses with both all and any; choose one.`);
    const combination = [...contract.combinations][0] ?? 'all';
    if (combination === 'any' && !contract.reasons.length) {
      throw invalid(`${contract.clauseId} accepts any of its witnesses; say why one alternative is enough with a Reason, so the plan's reviewer decides it.`);
    }
    if (!contract.slots.some((entry) => entry.role === 'primary')) {
      throw invalid(`${contract.clauseId} has only supporting witnesses; a supporting witness never verifies a criterion, so name at least one primary witness.`);
    }
    const planned = plannedClaims[contract.clauseId] ?? null;
    for (const entry of contract.slots.filter((candidate) => candidate.method === 'test')) {
      if (planned?.testDisposition === 'not-applicable') {
        throw invalid(`${contract.clauseId} plans no tests (not-applicable), so its slot ${entry.slot} cannot be a test.`);
      }
      if (planned?.tests?.length && !planned.tests.includes(entry.witness.path)) {
        throw invalid(`${contract.clauseId}'s test slot ${entry.slot} names ${entry.witness.path}, which is not among its planned tests (${planned.tests.join(', ')}).`);
      }
    }
    contracts.push({
      clauseId: contract.clauseId, combination,
      ...(contract.reasons.length ? { reason: contract.reasons.join(' ') } : {}),
      slots: contract.slots.sort((left, right) => left.slot.localeCompare(right.slot))
    });
  }
  for (const [id, planned] of Object.entries(plannedClaims)) {
    if (planned.fulfillment !== 'evidence' || !AC_ID.test(id)) continue;
    if (!contracts.find((contract) => contract.clauseId === id)?.slots.some((slot) =>
      slot.role === 'primary' && ['inspection', 'visual'].includes(slot.method))) {
      throw invalid(`${id} delivers retained evidence: name a primary visual or inspection contract; file presence alone cannot verify the criterion.`);
    }
  }
  return contracts;
}

/** Validate contracts read back from a record: the same rules, without the Markdown. */
export function normalizeVerificationContracts(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw invalid('verificationContracts must be a list.');
  const seen = new Set();
  return value.map((contract) => {
    const clauseId = String(contract?.clauseId ?? '').toUpperCase();
    if (!AC_ID.test(clauseId) || seen.has(clauseId)) throw invalid(`verificationContracts names ${clauseId || 'a criterion'} invalidly or twice.`);
    seen.add(clauseId);
    if (!['all', 'any'].includes(contract.combination) || (contract.combination === 'any' && !contract.reason)) {
      throw invalid(`The contract of ${clauseId} has an invalid combination.`);
    }
    const slots = Array.isArray(contract.slots) ? contract.slots : [];
    if (!slots.length || !slots.some((entry) => entry?.role === 'primary')) throw invalid(`The contract of ${clauseId} has no primary witness.`);
    const names = new Set();
    for (const entry of slots) {
      if (!SLOT_ID.test(entry?.slot ?? '') || names.has(entry.slot) || !VERIFICATION_METHODS.includes(entry.method)
          || !['primary', 'supporting'].includes(entry.role)
          || (entry.requiredAssurance != null && !METHOD_ASSURANCE[entry.method].includes(entry.requiredAssurance))
          || (entry.method === 'visual' ? typeof entry.witness?.target !== 'string' : exactPath(entry.witness?.path, `${clauseId}.${entry.slot}`) !== entry.witness.path)) {
        throw invalid(`The contract of ${clauseId} has an invalid slot ${entry?.slot ?? ''}.`);
      }
      names.add(entry.slot);
    }
    return { ...structuredClone(contract), clauseId };
  });
}

/** Every contract the Story's planned claim maps state, later maps replacing earlier ones per criterion. */
export function mergedVerificationContracts(plannedRecords = []) {
  const contracts = new Map();
  for (const record of plannedRecords) {
    for (const contract of record?.verificationContracts ?? []) contracts.set(contract.clauseId, contract);
  }
  return contracts;
}

/**
 * The contract a criterion is held to: its stated one, or by default one primary test slot over its
 * planned tests. A criterion whose tests the plan reviewed as not applicable has none (null).
 */
export function effectiveContract(clauseId, contracts, plannedClaim = null) {
  const stated = contracts?.get?.(clauseId) ?? null;
  if (stated) return { ...stated, stated: true };
  if (plannedClaim?.testDisposition === 'not-applicable') return null;
  return {
    clauseId, combination: 'all', stated: false,
    slots: [{ slot: 'tests', method: 'test', role: 'primary', witness: { paths: [...(plannedClaim?.tests ?? [])].sort() }, requiredAssurance: null }]
  };
}

/** True when a criterion's contract needs an `@ac` tag: one of its primary slots is a test. */
export function contractRequiresTestTag(contract) {
  return Boolean(contract?.slots?.some((entry) => entry.method === 'test' && entry.role === 'primary'));
}

/** The test slot a witness serves: the slot naming its file, or the default slot. */
export function testSlotFor(contract, witness) {
  const tests = (contract?.slots ?? []).filter((entry) => entry.method === 'test');
  return tests.find((entry) => entry.witness?.path === witness.testSource)
    ?? tests.find((entry) => !entry.witness?.path) ?? null;
}

export function contractSha256(contract) {
  if (!contract) return null;
  const { stated, ...core } = contract;
  return digest({ ...core, stated: stated === true });
}

/**
 * What a reviewer decides about one exact witness [E2G-014]: the criterion's exact text, the test's
 * exact identity and revision (body and lifecycle support), its adapter profile and the contract
 * slot it serves. Any change to any of them is a new mapping, so a decision carries forward only
 * while every digest is unchanged.
 */
export function witnessMappingCore(witness, { clauseBodySha256, contract }) {
  const slot = testSlotFor(contract, witness);
  return {
    clauseId: witness.clauseId,
    witnessType: 'test',
    executionProfile: witness.profile,
    logicalTestId: witness.logicalTestId,
    sourcePath: witness.testSource,
    sourceDeclarationSha256: `sha256:${String(witness.declarationSha256 ?? '').replace(/^sha256:/u, '')}`,
    supportSha256: witness.supportSha256 ? `sha256:${String(witness.supportSha256).replace(/^sha256:/u, '')}` : null,
    clauseBodySha256: `sha256:${String(clauseBodySha256 ?? '').replace(/^sha256:/u, '')}`,
    contractSha256: contractSha256(contract),
    slot: slot?.slot ?? null
  };
}

export function witnessMappingSha256(core) {
  return digest(core);
}
