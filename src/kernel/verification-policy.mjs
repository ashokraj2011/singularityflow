/** Verification witness contracts and approved verification intent over explicit value primitives. */
import {normalizeQualifiedClauseId,clauseTagsInComment} from '../foundation/traceability-ids.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,textDigestCapability} from '../foundation/record-schema.mjs';
import {configurationPathSyntax} from './configuration-path-policies.mjs';
import {collectDraftDiagnostic,draftDiagnosticSummary,inspectDraftValue,pathDefect,shown} from './draft-diagnostics.mjs';

export const VERIFICATION_METHODS = Object.freeze(['test', 'inspection', 'visual']);

/** Captures path/hash syntax only. No evidence reader, readiness callback or authority is accepted. */
export function verificationContractPolicies(pathSyntax,digests) {
const {path}=configurationPathSyntax(pathSyntax);
const {sha256Utf8}=textDigestCapability(digests);
const recordSha256=value=>sha256Utf8(canonicalJson(value));

const UNSUPPORTED_METHODS = Object.freeze(['measurement', 'analysis', 'browser-check', 'security-scan', 'operational', 'manual']);

const SLOT_ID = /^[a-z][a-z0-9-]{0,31}$/u;

const AC_ID = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u;

const REQUIRED_COLUMNS = Object.freeze(['criterion', 'slot', 'method', 'witness']);

const OPTIONAL_COLUMNS = Object.freeze(['role', 'required assurance', 'combination', 'reason']);

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

function exactPath(value, label) {
  const candidate = String(value ?? '');
  const normalized = path.posix.normalize(candidate);
  if (!candidate || candidate !== candidate.trim() || normalized !== candidate || candidate === '.'
      || candidate.startsWith('../') || candidate === '..' || path.posix.isAbsolute(candidate)
      || candidate.includes('\\') || /^[A-Za-z]:/u.test(candidate) || /^[a-z][a-z0-9+.-]*:/iu.test(candidate)
      || /[\0-\x1f\x7f*?[\]{}<>$]/u.test(candidate) || candidate.endsWith('/')) {
    const defect = pathDefect(candidate);
    throw invalid(`${label} must be one exact repository-relative path in backticks; ${shown(candidate)} is not${defect ? `: ${defect}` : ''}.`);
  }
  return candidate;
}

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

function proseVerificationDeclarations(markdown) {
  return visibleLines(markdown).flatMap((line, index) => {
    const method = line.match(/\bprimary\s+(visual|inspection)\s+verification\s+contract\b/iu)?.[1]?.toLowerCase();
    if (!method) return [];
    const clauseIds = [...line.matchAll(/\b([A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3})\b/giu)]
      .map(match => match[1].toUpperCase());
    return [{ method, clauseIds: [...new Set(clauseIds)], line: index + 1 }];
  });
}

function validateRetainedEvidenceDeclarations(markdown, plannedClaims, { evidenceRoot } = {}) {
  if (!evidenceRoot) return;
  const declared = new Set(Object.values(plannedClaims).filter(claim => claim.fulfillment === 'evidence')
    .flatMap(claim => claim.expectedPaths ?? []));
  for (const match of visibleLines(markdown).join('\n').matchAll(/`([^`\n]+)`/gu)) {
    const candidate = match[1];
    if (candidate.startsWith(`${evidenceRoot}/`) && !declared.has(candidate)) throw invalid(
      `Retained file ${candidate} is named outside a typed evidence row. Put its exact path in Expected paths with Fulfillment evidence, and define a primary visual/inspection slot in the Verification contracts table.`,
      { path: candidate, correction: 'type-retained-evidence' });
  }
}

const WITNESS_SHAPE = {
  test: 'one planned test file, such as `test/orders.test.js`',
  inspection: 'one exact file a reviewer inspects, such as `docs/runbook.md`',
  visual: 'one screen or scenario, such as `Order confirmation page`'
};

function witnessCell(method, cell, label) {
  const source = String(cell ?? '').trim();
  const values = [...source.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]);
  const rest = source.replace(/`[^`\n]+`/gu, '').trim();
  if (values.length !== 1 || rest) {
    throw invalid(`${label} must name exactly one witness in backticks and nothing else; it holds ${shown(source)}. `
      + `A ${method} witness is ${WITNESS_SHAPE[method]}; an assurance level goes in the Required assurance column, and why in Reason.`);
  }
  if (method === 'visual') {
    const target = values[0].trim();
    if (!target || target.length > 200 || /[\0-\x1f\x7f]/u.test(target)) throw invalid(`${label} must name the screen or scenario its visual evidence shows, in at most 200 characters.`);
    return { target };
  }
  return { path: exactPath(values[0], label) };
}

function parseVerificationContracts(markdown, { clauseIds = [], plannedClaims = {}, diagnostics: suppliedDiagnostics = null } = {}) {
  const diagnostics = suppliedDiagnostics ?? [];
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
      collectDraftDiagnostic(diagnostics, invalid(`The verification contracts table at line ${index + 1} must start with Criterion | Slot | Method | Witness and may add Role, Required assurance, Combination and Reason, each once.`),
        { line: index + 1, field: 'header' });
      inside = false; continue;
    }
    const divider = cells(lines[index + 1] ?? '');
    if (!divider || divider.length !== names.length || !divider.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
      collectDraftDiagnostic(diagnostics, invalid(`The verification contracts table at line ${index + 1} must be followed by a Markdown divider row.`),
        { line: index + 1, field: 'divider' });
      inside = false; continue;
    }
    for (index += 2; index < lines.length; index += 1) {
      const row = cells(lines[index]);
      if (!row) { index -= 1; break; }
      if (row.length !== names.length) {
        collectDraftDiagnostic(diagnostics, invalid(`Verification contract row at line ${index + 1} must have ${names.length} columns.`),
          { line: index + 1, field: 'row' });
        continue;
      }
      if (rows.length >= MAX_ROWS) throw invalid(`A plan may state at most ${MAX_ROWS} verification contract rows.`);
      rows.push({ line: index + 1, value: (name) => (names.indexOf(name) < 0 ? '' : row[names.indexOf(name)]) });
    }
    inside = false;
  }
  const byClause = new Map();
  for (const row of rows) {
    const where = `Verification contract row at line ${row.line}`;
    const clauseId = unwrap(row.value('criterion')).toUpperCase();
    let rowValid = true;
    const check = (field, read) => {
      const result = inspectDraftValue(diagnostics, read, { line: row.line,
        clauseId: AC_ID.test(clauseId) ? clauseId : null, field, actual: row.value(field) });
      rowValid &&= result.valid;
      return result.value;
    };
    check('criterion', () => {
      if (!AC_ID.test(clauseId)) throw invalid(`${where} must name one namespace-qualified acceptance criterion, such as ORDER:AC-001: the Story's namespace, a colon, AC and three digits.`);
      if (known.size && !known.has(clauseId)) throw invalid(`${where} names ${clauseId}, which is not a criterion of this Story.`);
    });
    const slot = unwrap(row.value('slot')).toLowerCase();
    check('slot', () => { if (!SLOT_ID.test(slot)) throw invalid(`${where} needs a slot name of lowercase letters, digits and hyphens, such as unit or review.`); });
    const method = unwrap(row.value('method')).toLowerCase();
    check('method', () => { if (!VERIFICATION_METHODS.includes(method)) {
      throw invalid(UNSUPPORTED_METHODS.includes(method)
        ? `${where} uses ${method}, which this repository cannot verify yet; use ${VERIFICATION_METHODS.join(', ')}, or record a risk decision when the Story ends.`
        : `${where} must use one method of ${VERIFICATION_METHODS.join(', ')}.`, { clauseId, method });
    } });
    const role = unwrap(row.value('role')).toLowerCase() || 'primary';
    check('role', () => { if (!['primary', 'supporting'].includes(role)) throw invalid(`${where} must be primary or supporting.`); });
    const requiredAssurance = unwrap(row.value('required assurance')).toLowerCase() || null;
    check('required assurance', () => {
    if (requiredAssurance === 'exact-authenticated') {
      throw invalid(`${where} requires exact-authenticated, which needs qualified execution this repository does not have; require exact-local-observed or less.`);
    }
    if (requiredAssurance && !Object.values(METHOD_ASSURANCE).flat().includes(requiredAssurance)) {
      throw invalid(`${where} requires a known assurance value, not scenario or reviewer prose: write ${(METHOD_ASSURANCE[method] ?? Object.values(METHOD_ASSURANCE).flat()).join(' or ')} alone, or leave the column empty.`);
    }
    if (requiredAssurance && METHOD_ASSURANCE[method] && !METHOD_ASSURANCE[method].includes(requiredAssurance)) {
      throw invalid(`${where} may require only ${METHOD_ASSURANCE[method].join(' or ')} for a ${method} witness; its Required assurance holds ${shown(row.value('required assurance'))}. `
        + `Write one of those words alone in that column, or leave it empty for the default; the Witness column holds only ${WITNESS_SHAPE[method]}.`);
    }
    });
    const combination = unwrap(row.value('combination')).toLowerCase() || null;
    check('combination', () => { if (combination && !['all', 'any'].includes(combination)) throw invalid(`${where} must combine with all or any.`); });
    const reason = String(row.value('reason') ?? '').trim() || null;
    check('reason', () => {
    if (reason && (reason.length < 10 || reason.length > 500 || /[\0-\x1f\x7f]/u.test(reason))) {
      throw invalid(`${where} needs a reason of 10 to 500 characters.`);
    }
    });
    const witness = VERIFICATION_METHODS.includes(method)
      ? check('witness', () => witnessCell(method, row.value('witness'), `${where}'s witness`)) : null;
    if (!rowValid) continue;
    const contract = byClause.get(clauseId) ?? { clauseId, combinations: new Set(), reasons: [], slots: [] };
    if (contract.slots.some((entry) => entry.slot === slot)) {
      collectDraftDiagnostic(diagnostics, invalid(`${clauseId} names slot ${slot} more than once.`),
        { line: row.line, clauseId, field: 'slot' });
      continue;
    }
    if (combination) contract.combinations.add(combination);
    if (reason) contract.reasons.push(reason);
    contract.slots.push({ slot, method, role, witness, requiredAssurance });
    byClause.set(clauseId, contract);
  }
  const contracts = [];
  for (const contract of [...byClause.values()].sort((left, right) => left.clauseId.localeCompare(right.clauseId))) {
    const inspected = inspectDraftValue(diagnostics, () => {
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
      if (['not-applicable', 'non-test'].includes(planned?.testDisposition)) {
        throw invalid(`${contract.clauseId} plans no tests (${planned.testDisposition}), so its slot ${entry.slot} cannot be a test.`);
      }
      if (planned?.tests?.length && !planned.tests.includes(entry.witness.path)) {
        throw invalid(`${contract.clauseId}'s test slot ${entry.slot} names ${entry.witness.path}, which is not among its planned tests (${planned.tests.join(', ')}).`);
      }
    }
    return {
      clauseId: contract.clauseId, combination,
      ...(contract.reasons.length ? { reason: contract.reasons.join(' ') } : {}),
      slots: contract.slots.sort((left, right) => left.slot.localeCompare(right.slot))
    };
    }, { clauseId: contract.clauseId, field: 'contract' });
    if (inspected.valid) contracts.push(inspected.value);
  }
  for (const [id, planned] of Object.entries(plannedClaims)) {
    if (planned.fulfillment !== 'evidence' || !AC_ID.test(id)) continue;
    if (!contracts.find((contract) => contract.clauseId === id)?.slots.some((slot) =>
      slot.role === 'primary' && ['inspection', 'visual'].includes(slot.method))) {
      collectDraftDiagnostic(diagnostics, invalid(`${id} delivers retained evidence: name a primary visual or inspection contract; file presence alone cannot verify the criterion.`),
        { clauseId: id, field: 'primaryWitness' });
    }
  }
  for (const declaration of proseVerificationDeclarations(markdown)) {
    for (const clauseId of declaration.clauseIds) {
      if (!contracts.some(contract => contract.clauseId === clauseId && contract.slots.some(slot =>
        slot.role === 'primary' && slot.method === declaration.method))) collectDraftDiagnostic(diagnostics, invalid(
        `${clauseId} declares a primary ${declaration.method} contract in prose, but has no matching primary slot in the Verification contracts table. Prose never replaces the structured verification contract.`,
        { clauseId, line: declaration.line, correction: 'register-verification-contract' }), { field: 'primaryWitness' });
    }
  }
  if (!suppliedDiagnostics && diagnostics.length) {
    const first = diagnostics[0];
    throw invalid(first.message, { ...first.details, diagnostics, diagnosticSummary: draftDiagnosticSummary(diagnostics) });
  }
  return diagnostics.length ? [] : contracts;
}

function normalizeVerificationContracts(value) {
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

function mergedVerificationContracts(plannedRecords = []) {
  const contracts = new Map();
  for (const record of plannedRecords) {
    for (const contract of record?.verificationContracts ?? []) contracts.set(contract.clauseId, contract);
  }
  return contracts;
}

function effectiveContract(clauseId, contracts, plannedClaim = null) {
  const stated = contracts?.get?.(clauseId) ?? null;
  if (stated) return { ...stated, stated: true };
  if (plannedClaim?.testDisposition === 'not-applicable') return null;
  return {
    clauseId, combination: 'all', stated: false,
    slots: [{ slot: 'tests', method: 'test', role: 'primary', witness: { paths: [...(plannedClaim?.tests ?? [])].sort() }, requiredAssurance: null }]
  };
}

function contractRequiresTestTag(contract) {
  return Boolean(contract?.slots?.some((entry) => entry.method === 'test' && entry.role === 'primary'));
}
function requiredAcceptanceFromPlan(clauseIds,planned,contracts,phaseId){
  return [...new Set(clauseIds.filter(id=>{
    const claim=planned[id]??planned[String(id).toUpperCase()],steps=claim?.steps??[];
    return (!steps.length||steps.includes(phaseId))&&contractRequiresTestTag(effectiveContract(String(id).toUpperCase(),contracts,claim??null));
  }))].sort();
}

function testSlotFor(contract, witness) {
  const tests = (contract?.slots ?? []).filter((entry) => entry.method === 'test');
  return tests.find((entry) => entry.witness?.path === witness.testSource)
    ?? tests.find((entry) => !entry.witness?.path) ?? null;
}

function contractSha256(contract) {
  if (!contract) return null;
  const { stated, ...core } = contract;
  return digest({ ...core, stated: stated === true });
}

function witnessMappingCore(witness, { clauseBodySha256, contract }) {
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

function witnessMappingSha256(core) {
  return digest(core);
}

return Object.freeze({proseVerificationDeclarations,validateRetainedEvidenceDeclarations,parseVerificationContracts,normalizeVerificationContracts,mergedVerificationContracts,effectiveContract,contractRequiresTestTag,requiredAcceptanceFromPlan,testSlotFor,contractSha256,witnessMappingCore,witnessMappingSha256});
}


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
  if (!primary.length || primary.some(slot => !['visual', 'inspection'].includes(slot.method))) return null;
  if (intent && intent.methods.some(method => !primary.some(slot => slot.method === method))) return null;
  if (intent && contract.combination === 'any'
      && primary.some(slot => intent.methods.some(method => slot.method !== method))) return null;
  return contract;
}


/** Plans must implement approved methods, never downgrade them to supporting proof or an exemption. */
export function validatePlannedVerification(claims, contracts = [], clauses = []) {
  const byCriterion = new Map(contracts.map(contract => [contract.clauseId, contract]));
  const byClause = new Map(clauses.map(clause => [clause.id, clause]));
  for (const [id, claim] of Object.entries(claims)) {
    const intent = byClause.get(id)?.verification;
    if (claim.testDisposition === 'non-test') {
      if ((!AC.test(id) && !intent) || (intent && claim.verificationCriterion !== intent.criterionId)
          || !nonTestVerification(id, claim, byCriterion, intent)) {
        const criterion = claim.verificationCriterion ?? intent?.criterionId ?? (AC.test(id) ? id : null);
        const missing = !AC.test(id) && !intent ? `${id} is not an acceptance criterion and has no approved Verification intent`
          : intent && claim.verificationCriterion !== intent.criterionId ? `Planned tests says verification: ${claim.verificationCriterion ?? 'nothing'}, but the approved criterion is ${intent.criterionId}`
            : !byCriterion.get(criterion) ? `the Verification contracts table has no row with Criterion \`${criterion}\``
              : `${criterion}'s contract rows have no primary visual or inspection slot${intent ? ` for every method ${id} lists (${intent.methods.join(', ')})` : ''}`;
        throw invalid(`${id} non-test proof needs its approved AC Criterion and exact primary visual/inspection contract; it cannot waive an automated test. Missing: ${missing}.`, { clauseId: id });
      }
    }
    if (!intent) continue;
    const contract = byCriterion.get(intent.criterionId);
    const primary = contract?.slots?.filter(slot => slot.role === 'primary')
      ?? (claims[intent.criterionId]?.tests?.length ? [{ method: 'test', role: 'primary' }] : []);
    if (intent.methods.includes('test') && (!claim.tests.length || claim.testDisposition !== 'applicable')) {
      throw invalid(`${id} requires automated tests in the approved Specification; plan exact test paths instead of an exemption.`, { clauseId: id });
    }
    for (const method of intent.methods) {
      // Exact planned test paths implement the historical default test contract. Other methods
      // always need a typed primary slot, including when a requirement shares an AC's proof.
      if (method === 'test' && !contract && (!intent.criterionId || intent.criterionId === id)) continue;
      if (!primary.some(slot => slot.method === method)) {
        throw invalid(`${id} requires primary ${method} proof under ${intent.criterionId}; a supporting slot does not satisfy approved intent.`, { clauseId: id });
      }
    }
    if (contract?.combination === 'any' && primary.some(slot => intent.methods.some(method => slot.method !== method))) {
      throw invalid(`${id} requires all approved verification methods; Combination any would weaken the Specification.`, { clauseId: id });
    }
  }
}


export const ASSURANCE = Object.freeze([
  'none', 'declared', 'source-bound', 'module-observed', 'exact-local-observed', 'exact-authenticated'
]);
export const TEST_ADAPTER_PROFILES = Object.freeze({
  'node-test-v1': Object.freeze({ language: 'javascript', framework: 'node:test', resultAdapter: 'node-tap', ceiling: 'exact-local-observed' }),
  'jest-static-v2': Object.freeze({ language: 'javascript', framework: 'jest', resultAdapter: 'jest-json', ceiling: 'exact-local-observed' }),
  'vitest-static-v2': Object.freeze({ language: 'javascript', framework: 'vitest', resultAdapter: 'vitest-json', ceiling: 'exact-local-observed' }),
  'junit5-surefire-v2': Object.freeze({ language: 'java', framework: 'junit5', runner: 'surefire', resultAdapter: 'junit-xml', ceiling: 'exact-local-observed' }),
  'junit5-gradle-v2': Object.freeze({ language: 'java', framework: 'junit5', runner: 'gradle', resultAdapter: 'junit-xml', ceiling: 'exact-local-observed' }),
  // Each Playwright test and each pytest test reports its own result [TCE:REQ-071, TCE:REQ-074].
  'playwright-json-v1': Object.freeze({ language: 'javascript', framework: 'playwright', resultAdapter: 'playwright-json', ceiling: 'exact-local-observed' }),
  'pytest-junit-v1': Object.freeze({ language: 'python', framework: 'pytest', resultAdapter: 'junit-xml', ceiling: 'exact-local-observed' }),
  'module-counts-v1': Object.freeze({ language: null, framework: null, resultAdapter: null, ceiling: 'module-observed' })
});
/** Actual adapter interpretation shared by native planning and namespace publication. */
export function verificationExecutionProfiles(pathSyntax) {
const {path}=configurationPathSyntax(pathSyntax);


const MAVEN = new Set(['mvn', 'mvnw', 'mvn.cmd', 'mvnw.cmd']);

const GRADLE = new Set(['gradle', 'gradlew', 'gradle.bat', 'gradlew.bat']);


function executableName(value) {
  return path.posix.basename(String(value ?? '').replaceAll('\\', '/')).toLowerCase();
}


/** The profile that reads one normalized test command. Unknown shapes only count tests. */
function profileForCommand(command) {
  const adapter = command?.result?.adapter;
  if (adapter === 'node-tap') return 'node-test-v1';
  if (adapter === 'jest-json') return 'jest-static-v2';
  if (adapter === 'vitest-json') return 'vitest-static-v2';
  if (adapter === 'playwright-json') return 'playwright-json-v1';
  if (adapter === 'junit-xml') {
    const executable = executableName(command?.argv?.[0]);
    if (MAVEN.has(executable)) return 'junit5-surefire-v2';
    if (GRADLE.has(executable)) return 'junit5-gradle-v2';
    if (/^(?:py(?:thon[\d.]*)?(?:\.exe)?|uv|poetry)$/u.test(executable) && command.argv.includes('pytest')) return 'pytest-junit-v1';
  }
  return 'module-counts-v1';
}


function testAdapterProfile(id) {
  const profile = TEST_ADAPTER_PROFILES[id];
  if (!profile) throw new Error(`Unknown test adapter profile '${id}'.`);
  return { id, ...profile };
}


/** True when the profile can tie a criterion to one exact test. */
function profileIsExact(id) {
  return testAdapterProfile(id).ceiling === 'exact-local-observed';
}


return Object.freeze({profileForCommand,testAdapterProfile,profileIsExact,profileCeiling});
}

/** Planning capability declarations share native slot and runner rules without changing the original contract factory. */
export function plannedTestCapabilityPolicies(pathSyntax,digests) {
const {effectiveContract}=verificationContractPolicies(pathSyntax,digests),profiles=verificationExecutionProfiles(pathSyntax);
/** Primary executable slots owned by one code step; supporting slots never establish acceptance. */
function plannedTestSlots(claims,contracts,step) {
  return Object.entries(claims)
    .filter(([,claim])=>!(claim.steps??[]).length||claim.steps.includes(step))
    .flatMap(([id,claim])=>(effectiveContract(id,contracts,claim)?.slots??[])
      .filter(slot=>slot.method==='test'&&slot.role==='primary')
      .flatMap(slot=>(slot.witness.path?[slot.witness.path]:slot.witness.paths??[]).map(testPath=>({id,slot,testPath}))));
}
function plannedTestAssuranceProblem({id,slot,testPath},command) {
  const ceiling=profiles.profileCeiling(profiles.profileForCommand(command));
  return slot.requiredAssurance&&ASSURANCE.indexOf(slot.requiredAssurance)>ASSURANCE.indexOf(ceiling)
    ?`${id}: ${testPath} runs under ${command.id}, which reaches ${ceiling}, but its contract requires ${slot.requiredAssurance}`:null;
}
return Object.freeze({plannedTestSlots,plannedTestAssuranceProblem});
}

/** Shared acceptance marker vocabulary; native and headless readers use these exact rules. */
/** True for a namespace-qualified acceptance-criterion ID such as `PAY-1:AC-001`. */
export function isQualifiedAcceptanceId(value) {
  return /:AC-\d{3}$/u.test(normalizeQualifiedClauseId(value) ?? '');
}

/** The qualified criterion IDs named by `@ac:` markers in one comment's text. */
export function acceptanceTagsInComment(text) {
  return clauseTagsInComment(text).filter(entry => entry.tag === 'ac').map(entry => entry.clauseId);
}

/** Whether a whitespace run between two comments, or a comment and code, keeps them adjacent. */
export function adjacentWhitespace(text) {
  return /^[ \t\r]*\n?[ \t\r]*$/u.test(String(text ?? ''));
}

/**
 * The criterion tags directly above a line in plain source lines: walk upward through contiguous
 * comment lines (no blank line) and collect their markers. Used for languages whose parser reports
 * a declaration's start offset but not its comments.
 */
export function acceptanceTagsAboveLine(lines, lineIndex) {
  const ids = [];
  const commentLines = [];
  let inBlock = false;
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const line = String(lines[index] ?? '').trim();
    if (!line) break;
    if (inBlock) {
      commentLines.push(index);
      if (line.startsWith('/*')) inBlock = false;
      ids.unshift(...acceptanceTagsInComment(line));
      continue;
    }
    if (line.startsWith('//') || line.startsWith('#')) {
      commentLines.push(index);
      ids.unshift(...acceptanceTagsInComment(line));
      continue;
    }
    if (line.endsWith('*/')) {
      commentLines.push(index);
      ids.unshift(...acceptanceTagsInComment(line));
      inBlock = !line.startsWith('/*');
      continue;
    }
    break;
  }
  return { clauseIds: [...new Set(ids)], firstCommentLine: commentLines.length ? Math.min(...commentLines) : null };
}

/** Every `@ac:` marker in a file's comment lines, with its 1-based line, wherever it is. */
export function acceptanceTagLines(source) {
  const found = [];
  const lines = String(source ?? '').split(/\r?\n/u);
  let inBlock = false;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const comment = inBlock || line.startsWith('//') || line.startsWith('#') || line.startsWith('/*') || line.startsWith('*');
    if (line.startsWith('/*') && !line.includes('*/')) inBlock = true;
    else if (inBlock && line.includes('*/')) inBlock = false;
    if (!comment) continue;
    for (const clauseId of acceptanceTagsInComment(line)) found.push({ clauseId, line: index + 1 });
  }
  return found;
}

/** The strongest assurance a profile can produce; unknown profiles only count tests. */
export function profileCeiling(id) {
  return TEST_ADAPTER_PROFILES[id]?.ceiling ?? 'module-observed';
}
