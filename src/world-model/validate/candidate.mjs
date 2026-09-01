import { canonicalJson, recordSha256 } from '../../records.mjs';
import { currentSchemaVersion, readRecord } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { candidateFactReferences, parseCompositionCandidate } from '../compose/candidate.mjs';
import {
  WMB_V4_CANDIDATE_SCHEMA_SOURCE_SHA256, WMB_V4_KERNEL_SOURCE_SHA256
} from '../source-digest.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const CANDIDATE_FIELDS = new Set([
  'schemaVersion', 'kind', 'view', 'viewVersion', 'title', 'tldrMarkdown', 'sections', 'usedFactIds'
]);
const SECTION_FIELDS = new Set(['sectionId', 'markdown']);
const KERNEL_METADATA = /(?:^|\b)(?:generated-at|source-commit|source-manifest-sha256|scope-sha256|prompt-sha256|execution-unit|validator-sha256|composition-candidate-sha256)\s*:/im;
const COMMIT = /\b[0-9a-f]{40}\b/i;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/;

export const WMB_V4_CANDIDATE_SCHEMA_SHA256 = WMB_V4_CANDIDATE_SCHEMA_SOURCE_SHA256;
export const WMB_V4_VALIDATOR_SHA256 = sha({
  kind: 'wmb-v4-validator-implementation', sourceSha256: WMB_V4_KERNEL_SOURCE_SHA256
});
export const WMB_V4_VALIDATION_CHECK_IDS = Object.freeze([
  'candidate-json', 'candidate-schema', 'view-identity', 'registered-title',
  'required-sections', 'section-order', 'unregistered-sections', 'narrative-budgets',
  'factual-unit-references', 'fact-reference-integrity', 'used-fact-set',
  'required-facts', 'required-unavailable', 'contradictions', 'assurance', 'scope',
  'body-access', 'cross-view', 'kernel-metadata', 'total-output'
]);

function sha(value) { return `sha256:${recordSha256(value)}`; }
function words(value) { return String(value ?? '').trim().split(/\s+/).filter(Boolean).length; }
function bytes(value) { return Buffer.byteLength(String(value ?? ''), 'utf8'); }

function factualUnits(markdown) {
  const units = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) units.push(paragraph.join(' ').trim());
    paragraph = [];
  };
  for (const raw of String(markdown ?? '').replaceAll('\r\n', '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^#{1,6}\s/.test(line)) { flush(); continue; }
    if (/^(?:[-*+]\s|\d+[.)]\s|\|)/.test(line)) { flush(); units.push(line); continue; }
    paragraph.push(line);
  }
  flush();
  return units.filter(Boolean);
}

function referencesForUnit(unit) {
  const match = unit.match(/\[F:(FACT-[a-f0-9]{16,64}(?:,FACT-[a-f0-9]{16,64})*)\]\s*$/);
  return match ? match[1].split(',') : [];
}

function canonicalFactSentence(fact) {
  const value = fact.status === 'unavailable'
    ? fact.reason?.detail ?? 'The requested analysis is unavailable.'
    : fact.claim ?? 'Registered fact';
  return `${String(value).trim().replace(/[.\s]+$/, '')}.`;
}

function narrativeBody(unit) {
  return String(unit)
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\s*\[F:FACT-[a-f0-9]{16,64}(?:,FACT-[a-f0-9]{16,64})*\]\s*$/, '')
    .trim();
}

/**
 * Enforce the mechanical assurance guard promised by WMB v4 §38.
 *
 * Deterministic validation cannot prove unrestricted paraphrase entailment. The first registered
 * contracts therefore use one closed narrative template: exact canonical fact sentences followed
 * by the exact, sorted Fact reference set. A composer can select facts and place them in registered
 * sections, but cannot attach an unrelated true Fact ID to invented prose and have it accepted.
 */
function assertApprovedNarrativeTemplate(unit, references, factsById) {
  if (new Set(references).size !== references.length
      || JSON.stringify(references) !== JSON.stringify([...references].sort())) {
    fail('WMB_FACT_REFERENCE_UNKNOWN', 'A factual unit must end with a unique canonical Fact reference set.');
  }
  const embedded = [...narrativeBody(unit).matchAll(/\[F:[^\]]+\]/g)];
  if (embedded.length) {
    fail('WMB_FACT_REFERENCE_UNKNOWN', 'Fact references are permitted only once at the end of a factual unit.');
  }
  const expected = references.map((id) => canonicalFactSentence(factsById.get(id))).join(' ');
  const received = narrativeBody(unit);
  if (received !== expected) {
    fail(
      'WMB_FACT_ASSURANCE_UPGRADED',
      'A factual unit does not match the registered canonical narrative template for its Fact references.',
      { unitSha256: sha(unit), expectedSha256: sha(expected), factIds: references }
    );
  }
}

function fail(code, message, details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

function assertClosedObject(value, fields, label) {
  const extras = Object.keys(value).filter((key) => !fields.has(key));
  if (extras.length) fail('WMB_MODEL_OUTPUT_INVALID', `${label} contains unregistered field(s): ${extras.join(', ')}.`, { fields: extras });
}

function knownSourceTokens(ledger, evidenceCatalog) {
  const paths = new Set(evidenceCatalog.items.map((item) => item.locator?.path).filter(Boolean));
  for (const item of evidenceCatalog.items) {
    for (const value of Object.values(item.locator ?? {})) {
      if (typeof value === 'string' && (value.includes('/') || paths.has(value))) paths.add(value);
    }
  }
  const symbols = new Set([
    ...evidenceCatalog.items.map((item) => item.locator?.symbol).filter(Boolean),
    ...ledger.facts.map((fact) => fact.subject?.id).filter(Boolean)
  ]);
  return { paths, symbols };
}

const SOURCE_EXTENSION = '(?:c|cc|cpp|cs|cjs|go|h|hpp|java|js|jsx|kt|kts|mjs|php|py|rb|rs|swift|ts|tsx)';
const PATH_TOKEN = new RegExp(
  String.raw`(?:^|[\s("'\x60])((?:\.{1,2}/)?(?:[A-Za-z0-9_$@.-]+/)+[A-Za-z0-9_$@.-]+|[A-Za-z0-9_$@-]+\.${SOURCE_EXTENSION})(?=$|[\s),;:'"\x60])`,
  'gim'
);
const COMPOUND_SYMBOL = /\b(?:[A-Z_$][A-Za-z0-9_$]*|[A-Za-z_$][A-Za-z0-9_$]*#[A-Za-z_$][A-Za-z0-9_$]*)(?:[.#][A-Za-z_$][A-Za-z0-9_$]*)+\b/g;

function normalizedCandidatePath(token) {
  return String(token).replace(/[.,;:!?]+$/, '').replace(/^\.\//, '').replace(/:\d+(?:-\d+)?$/, '');
}

function assertNoInventedSourceToken(text, ledger, evidenceCatalog) {
  const { paths, symbols } = knownSourceTokens(ledger, evidenceCatalog);
  const evidenceIds = new Set(evidenceCatalog.items.map((item) => item.id));
  const factIds = new Set(ledger.facts.map((fact) => fact.id));
  for (const match of text.matchAll(/\bEV-[a-f0-9]{16,64}\b/g)) {
    if (!evidenceIds.has(match[0])) fail('WMB_EVIDENCE_REFERENCE_UNKNOWN', `Candidate cites unknown evidence '${match[0]}'.`, { id: match[0] });
  }
  for (const match of text.matchAll(/\bFACT-[a-f0-9]{16,64}\b/g)) {
    if (!factIds.has(match[0])) fail('WMB_FACT_REFERENCE_UNKNOWN', `Candidate names unknown fact '${match[0]}'.`, { id: match[0] });
  }
  // Derivation identities are not part of the model-facing request. Any DRV token therefore came
  // from the composer rather than the registered input and is refused instead of being trusted.
  if (/\bDRV-[a-f0-9]{16,64}\b/.test(text)) {
    fail('WMB_DERIVATION_INVALID', 'Candidate minted a derivation identity that was not supplied to the composer.');
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim();
    const pathLike = token.includes('/') || /\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(token);
    const symbolLike = /^[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)+$/.test(token);
    if (pathLike && ![...paths].some((known) => token === known || token.startsWith(`${known}:`))) {
      fail('WMB_SCOPE_VIOLATION', `Candidate names unregistered or out-of-scope path '${token}'.`, { token });
    }
    if (symbolLike && !symbols.has(token) && ![...symbols].some((known) => known.endsWith(`.${token}`))) {
      fail('WMB_SCOPE_VIOLATION', `Candidate names unregistered symbol '${token}'.`, { token });
    }
  }
  // A scope boundary cannot depend on Markdown styling. A model that removes backticks must not
  // turn an excluded or invented path into acceptable prose.
  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = normalizedCandidatePath(match[1]);
    if (!paths.has(token)) {
      fail('WMB_SCOPE_VIOLATION', `Candidate names unregistered or out-of-scope path '${token}'.`, { token });
    }
  }
  for (const match of text.matchAll(COMPOUND_SYMBOL)) {
    const token = match[0];
    if (!symbols.has(token) && ![...symbols].some((known) => (
      known.endsWith(`#${token}`) || known.endsWith(`.${token}`)
    ))) {
      fail('WMB_SCOPE_VIOLATION', `Candidate names unregistered symbol '${token}'.`, { token });
    }
  }
}

function assertNarrativeAssurance(unit, references, factsById) {
  for (const id of references) {
    const fact = factsById.get(id);
    if (fact.status === 'unavailable' && /\b(?:does not exist|never occurs|is absent|cannot happen)\b/i.test(unit)) {
      fail('WMB_FACT_STATUS_UPGRADED', `Unavailable fact '${id}' was strengthened into an absence claim.`, { factId: id });
    }
    if (fact.status === 'partial' && /\b(?:all|every|complete(?:ly)?|fully|always|never)\b/i.test(unit)) {
      fail('WMB_FACT_ASSURANCE_UPGRADED', `Partial fact '${id}' was strengthened into a complete claim.`, { factId: id });
    }
  }
}

/** Run the model-never WMB v4 validation pipeline and return a sealed receipt. */
export function validateCompositionCandidate(rawCandidate, {
  contract, viewFactLedger, evidenceCatalog, scopeManifest, outputBudget = null,
  candidateSchemaSha256 = WMB_V4_CANDIDATE_SCHEMA_SHA256,
  validatorSha256 = WMB_V4_VALIDATOR_SHA256
}) {
  const candidate = readRecord(
    'world-model-composition-candidate', parseCompositionCandidate(rawCandidate)
  ).record;
  assertClosedObject(candidate, CANDIDATE_FIELDS, 'Composition candidate');
  if (candidate.kind !== 'world-model-composition-candidate') {
    fail('WMB_MODEL_OUTPUT_INVALID', 'Composition candidate schema or kind is unsupported.');
  }
  if (candidate.view !== contract.id || candidate.viewVersion !== contract.version) {
    fail('WMB_VIEW_SPEC_MISMATCH', `Candidate targets ${candidate.view}@${candidate.viewVersion}, expected ${contract.id}@${contract.version}.`);
  }
  if (candidate.title !== contract.title) fail('WMB_VIEW_SPEC_MISMATCH', 'Candidate title does not match the registered View Contract.');
  if (!Array.isArray(candidate.sections) || !Array.isArray(candidate.usedFactIds)
      || typeof candidate.tldrMarkdown !== 'string') {
    fail('WMB_MODEL_OUTPUT_INVALID', 'Composition candidate collections and TL;DR are invalid.');
  }
  candidate.sections.forEach((section) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) fail('WMB_MODEL_OUTPUT_INVALID', 'Candidate section must be an object.');
    assertClosedObject(section, SECTION_FIELDS, 'Composition section');
    if (typeof section.sectionId !== 'string' || typeof section.markdown !== 'string') fail('WMB_MODEL_OUTPUT_INVALID', 'Candidate section ID and Markdown must be strings.');
  });

  const expectedSections = contract.sections.map((section) => section.id);
  const actualSections = candidate.sections.map((section) => section.sectionId);
  const missing = expectedSections.filter((id) => !actualSections.includes(id));
  if (missing.length) fail('WMB_SECTION_MISSING', `Candidate is missing section(s): ${missing.join(', ')}.`, { sections: missing });
  const extras = actualSections.filter((id) => !expectedSections.includes(id));
  if (extras.length) fail('WMB_SECTION_UNREGISTERED', `Candidate contains unregistered section(s): ${extras.join(', ')}.`, { sections: extras });
  if (new Set(actualSections).size !== actualSections.length) fail('WMB_SECTION_UNREGISTERED', 'Candidate repeats a registered section.');
  if (JSON.stringify(actualSections) !== JSON.stringify(expectedSections)) fail('WMB_SECTION_ORDER_INVALID', 'Candidate sections are not in canonical registry order.');

  if (words(candidate.tldrMarkdown) > contract.narrative.tldrMaximumWords) {
    fail('WMB_TLDR_BUDGET_EXCEEDED', 'Candidate TL;DR exceeds its registered word budget.');
  }
  for (const section of candidate.sections) {
    if (words(section.markdown) > contract.narrative.sectionMaximumWords) {
      fail('WMB_OUTPUT_BUDGET_EXCEEDED', `Section '${section.sectionId}' exceeds its registered word budget.`, { section: section.sectionId });
    }
  }
  const allNarrative = [candidate.tldrMarkdown, ...candidate.sections.map((section) => section.markdown)].join('\n');
  if (words(allNarrative) > contract.narrative.totalMaximumWords) fail('WMB_OUTPUT_BUDGET_EXCEEDED', 'Candidate exceeds its total narrative word budget.');
  const maximumOutputTokens = outputBudget?.viewBudgets?.[contract.id]?.maximumOutputTokens
    ?? contract.budgets.maximumOutputTokens;
  if (Math.ceil(bytes(canonicalJson(candidate)) / 4) > maximumOutputTokens) {
    fail('WMB_OUTPUT_BUDGET_EXCEEDED', 'Candidate exceeds its estimated output-token ceiling.');
  }

  const factsById = new Map(viewFactLedger.facts.map((fact) => [fact.id, fact]));
  const allUnits = [
    ...factualUnits(candidate.tldrMarkdown),
    ...candidate.sections.flatMap((section) => factualUnits(section.markdown))
  ];
  // Run the mechanically identifiable safety boundaries before the closed prose template so a
  // refusal reports the smallest concrete repair (remove a body, metadata, cross-view reference,
  // or unregistered source identity) instead of collapsing every violation into generic prose.
  if (!contract.bodyAccess.allowed && /(?:```|~~~|^(?: {4}|\t)\S)/m.test(allNarrative)) {
    fail('WMB_SOURCE_BODY_FORBIDDEN', 'Source/code blocks are forbidden by the View Contract.');
  }
  if (KERNEL_METADATA.test(allNarrative) || COMMIT.test(allNarrative) || TIMESTAMP.test(allNarrative) || /^---\s*$/m.test(allNarrative)) {
    fail('WMB_KERNEL_METADATA_FORBIDDEN', 'Candidate contains kernel-owned provenance or generation metadata.');
  }
  if (!contract.crossViewReferences.allowed && /\[(?:view|world-model):[^\]]+\]/i.test(allNarrative)) {
    fail('WMB_CROSS_VIEW_REFERENCE_FORBIDDEN', 'Candidate cross-references an unrequested view.');
  }
  assertNoInventedSourceToken(allNarrative, viewFactLedger, evidenceCatalog);
  for (const unit of allUnits) {
    const references = referencesForUnit(unit);
    if (!references.length) fail('WMB_FACT_REFERENCE_UNKNOWN', 'A factual unit has no trailing registered Fact reference.', { unitSha256: sha(unit) });
    for (const id of references) {
      if (!factsById.has(id)) fail('WMB_FACT_REFERENCE_UNKNOWN', `Candidate cites unknown fact '${id}'.`, { id });
    }
    assertApprovedNarrativeTemplate(unit, references, factsById);
    assertNarrativeAssurance(unit, references, factsById);
  }
  const referenced = candidateFactReferences(candidate);
  const rawUsed = candidate.usedFactIds;
  const used = [...new Set(rawUsed)].sort();
  if (rawUsed.some((id) => typeof id !== 'string')
      || rawUsed.length !== used.length
      || JSON.stringify(rawUsed) !== JSON.stringify(used)
      || JSON.stringify(used) !== JSON.stringify(referenced)) {
    fail('WMB_FACT_REFERENCE_UNKNOWN', 'usedFactIds must equal the exact referenced Fact set.', { used, referenced });
  }
  for (const id of viewFactLedger.requiredFactIds ?? []) {
    if (!referenced.includes(id)) fail('WMB_REQUIRED_FACT_MISSING', `Required fact '${id}' is not narrated.`, { id });
  }
  for (const id of viewFactLedger.requiredUnavailableFactIds ?? []) {
    if (!referenced.includes(id)) fail('WMB_REQUIRED_UNAVAILABLE_FACT_MISSING', `Required unavailable fact '${id}' is not narrated.`, { id });
  }
  const tldrReferences = candidateFactReferences({ tldrMarkdown: candidate.tldrMarkdown, sections: [] });
  const contradictionSectionIds = new Set(contract.sections
    .filter((section) => section.sectionKind === 'contradiction')
    .map((section) => section.id));
  const relevantFallbackSection = contract.sections.find(
    (section) => !['contradiction', 'unavailable'].includes(section.sectionKind)
  )?.id;
  for (const id of viewFactLedger.materialContradictionFactIds ?? []) {
    const relevantSections = contradictionSectionIds.size
      ? contradictionSectionIds
      : new Set(relevantFallbackSection ? [relevantFallbackSection] : []);
    const appearsInRelevantSection = candidate.sections.some((section) => (
      relevantSections.has(section.sectionId)
        && candidateFactReferences({ sections: [section] }).includes(id)
    ));
    if (!tldrReferences.includes(id) || !appearsInRelevantSection) {
      fail('WMB_CONTRADICTION_SUPPRESSED', `Material contradiction '${id}' must appear in the TL;DR and a registered section.`, { id });
    }
  }
  if (!HASH.test(contract.contractSha256) || !HASH.test(viewFactLedger.ledgerSha256)
      || !HASH.test(scopeManifest.scopeSha256)) fail('WMB_VIEW_SPEC_MISMATCH', 'Validation inputs are not content-addressed.');
  const receiptBase = {
    schemaVersion: currentSchemaVersion('world-model-view-validation-receipt'),
    kind: 'world-model-view-validation-receipt',
    viewId: contract.id,
    viewVersion: contract.version,
    candidateSha256: sha(candidate),
    candidateSchemaSha256,
    viewSpecSha256: contract.contractSha256,
    factLedgerSha256: viewFactLedger.ledgerSha256,
    scopeSha256: scopeManifest.scopeSha256,
    checks: WMB_V4_VALIDATION_CHECK_IDS.map((id) => ({ id, status: 'pass' })),
    status: 'passed',
    validatorSha256
  };
  return Object.freeze({
    candidate: structuredClone(candidate),
    receipt: { ...receiptBase, receiptSha256: sha(receiptBase) }
  });
}
