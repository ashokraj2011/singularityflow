import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PACKAGE_ROOT } from '../../package-root.mjs';
import { canonicalJson, recordSha256 } from '../../records.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { compareText } from '../canonicalize.mjs';

export const WMB_V4_REQUEST_BOUNDARY = '<!-- ===== REQUEST INPUTS: volatile tail ===== -->';
export const WMB_V4_FACT_REFERENCE_GRAMMAR = Object.freeze({
  syntax: '[F:FACT-<16-to-64-lowercase-hex>[,FACT-<16-to-64-lowercase-hex>...]]',
  placement: 'Every factual unit ends with exactly one trailing reference group.',
  ordering: 'Fact IDs in a group are unique and lexically sorted.',
  authority: 'Every Fact ID must exist in the supplied View Fact Ledger.'
});

const PLACEHOLDERS = Object.freeze([
  '{{fact_reference_grammar}}',
  '{{composition_candidate_schema}}',
  '{{registered_view_contract}}'
]);

const pinnedCorePath = path.join(PACKAGE_ROOT, 'templates', 'world-model', 'pinned-core-v4.md');
const candidateSchemaPath = path.join(
  PACKAGE_ROOT, 'schemas', 'world-model-composition-candidate.schema.json'
);

function hash(value) { return `sha256:${recordSha256(value)}`; }

export function assertWmbV4PromptInputBudget(prompt, viewContract) {
  const estimatedInputTokens = Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4);
  const maximumInputTokens = viewContract.budgets.maximumInputTokens;
  if (estimatedInputTokens > maximumInputTokens) {
    throw new SingularityFlowError(
      `View '${viewContract.id}' requires an estimated ${estimatedInputTokens} input tokens, above its registered ${maximumInputTokens}-token ceiling.`,
      {
        code: 'WMB_INPUT_BUDGET_EXCEEDED',
        details: { estimatedInputTokens, maximumInputTokens }
      }
    );
  }
  return estimatedInputTokens;
}

function normalizedPinnedCore(text) {
  text = text.replaceAll('\r\n', '\n');
  const first = text.indexOf(WMB_V4_REQUEST_BOUNDARY);
  if (first < 0 || first !== text.lastIndexOf(WMB_V4_REQUEST_BOUNDARY)) {
    throw new SingularityFlowError('Pinned WMB v4 core must contain exactly one request-input boundary.', {
      code: 'WMB_PINNED_CORE_INVALID'
    });
  }
  for (const placeholder of PLACEHOLDERS) {
    if (text.split(placeholder).length !== 2 || text.indexOf(placeholder) > first) {
      throw new SingularityFlowError(
        `Pinned WMB v4 core must contain exactly one stable '${placeholder}' placeholder above REQUEST INPUTS.`,
        { code: 'WMB_PINNED_CORE_INVALID' }
      );
    }
  }
  const stable = `${text.slice(0, first + WMB_V4_REQUEST_BOUNDARY.length).trimEnd()}\n`;
  return Object.freeze({ text: stable, sha256: hash(stable), path: pinnedCorePath });
}

export async function loadPinnedCoreV4() {
  return normalizedPinnedCore(await readFile(pinnedCorePath, 'utf8'));
}

export function loadPinnedCoreV4Sync() {
  return normalizedPinnedCore(readFileSync(pinnedCorePath, 'utf8'));
}

function region(id, value, cacheClass) {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  const bytes = Buffer.byteLength(text, 'utf8');
  return Object.freeze({
    id,
    sha256: hash(text),
    bytes,
    estimatedTokens: Math.ceil(bytes / 4),
    cacheClass,
    text
  });
}

function compositionCandidateSchema() {
  let parsed;
  try { parsed = JSON.parse(readFileSync(candidateSchemaPath, 'utf8')); }
  catch (error) {
    throw new SingularityFlowError(
      `WMB v4 composition-candidate schema could not be loaded: ${error.message}`,
      { code: 'WMB_PINNED_CORE_INVALID', cause: error }
    );
  }
  return canonicalJson(parsed);
}

function instantiateStablePrefix(core, viewContract) {
  const replacements = new Map([
    ['{{fact_reference_grammar}}', canonicalJson(WMB_V4_FACT_REFERENCE_GRAMMAR).trimEnd()],
    ['{{composition_candidate_schema}}', compositionCandidateSchema().trimEnd()],
    ['{{registered_view_contract}}', canonicalJson(viewContract).trimEnd()]
  ]);
  let text = core.text;
  for (const [placeholder, value] of replacements) text = text.replace(placeholder, value);
  if (text.includes('{{')) {
    throw new SingularityFlowError('Pinned WMB v4 core contains an unresolved placeholder.', {
      code: 'WMB_PINNED_CORE_INVALID'
    });
  }
  return text;
}

function typeBalancedFacts(facts) {
  const queues = new Map();
  for (const fact of [...facts].sort((left, right) => (
    compareText(String(left.factType), String(right.factType))
      || compareText(String(left.id), String(right.id))
  ))) {
    if (!queues.has(fact.factType)) queues.set(fact.factType, []);
    queues.get(fact.factType).push(fact);
  }
  const ordered = [];
  const types = [...queues.keys()].sort(compareText);
  let offset = 0;
  while (true) {
    let added = false;
    for (const type of types) {
      const fact = queues.get(type)[offset];
      if (!fact) continue;
      ordered.push(fact);
      added = true;
    }
    if (!added) return ordered;
    offset += 1;
  }
}

function compositionFactPacket(viewFactLedger, facts) {
  return Object.freeze({
    schemaVersion: 1, // schema-transient: bounded model input, never persisted as authority
    kind: 'world-model-composition-fact-packet',
    viewId: viewFactLedger.viewId,
    viewVersion: viewFactLedger.viewVersion,
    sourceViewFactLedgerSha256: viewFactLedger.ledgerSha256,
    facts: Object.freeze(facts.map((fact) => structuredClone(fact))),
    requiredFactIds: Object.freeze([...(viewFactLedger.requiredFactIds ?? [])]),
    requiredUnavailableFactIds: Object.freeze([
      ...(viewFactLedger.requiredUnavailableFactIds ?? [])
    ]),
    materialContradictionFactIds: Object.freeze([
      ...(viewFactLedger.materialContradictionFactIds ?? [])
    ]),
    availableFactCount: viewFactLedger.facts.length,
    admittedFactCount: facts.length
  });
}

function mandatoryFactIds(viewFactLedger) {
  return new Set([
    ...(viewFactLedger.requiredFactIds ?? []),
    ...(viewFactLedger.requiredUnavailableFactIds ?? []),
    ...(viewFactLedger.materialContradictionFactIds ?? [])
  ]);
}

function assembleWithCore(core, {
  viewContract,
  scopeManifest,
  viewFactLedger,
  evidenceCatalog,
  consumerProfile,
  outputBudget
}) {
  const candidateSchema = compositionCandidateSchema();
  const stablePrefix = instantiateStablePrefix(core, viewContract);
  const factsById = new Map(viewFactLedger.facts.map((fact) => [fact.id, fact]));
  const mandatoryIds = mandatoryFactIds(viewFactLedger);
  const missingMandatoryIds = [...mandatoryIds].filter((id) => !factsById.has(id)).sort();
  if (missingMandatoryIds.length) {
    throw new SingularityFlowError(
      `View '${viewContract.id}' composition input is missing mandatory registered Facts.`,
      { code: 'WMB_FACT_NOT_REGISTERED', details: { factIds: missingMandatoryIds } }
    );
  }
  const admitted = viewFactLedger.facts
    .filter((fact) => mandatoryIds.has(fact.id))
    .sort((left, right) => compareText(left.id, right.id));
  const optional = typeBalancedFacts(
    viewFactLedger.facts.filter((fact) => !mandatoryIds.has(fact.id))
  );

  const materialize = (facts) => {
    const selectedEvidenceIds = new Set(
      facts.flatMap((fact) => fact.evidenceIds ?? [])
    );
    const minimalEvidence = {
      schemaVersion: evidenceCatalog.schemaVersion,
      kind: 'world-model-evidence-descriptors',
      items: evidenceCatalog.items
        .filter((item) => selectedEvidenceIds.has(item.id))
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          label: item.locator?.symbol ?? item.locator?.path ?? item.id,
          ...(item.locator?.path ? { path: item.locator.path } : {})
        }))
    };
    const factPacket = compositionFactPacket(viewFactLedger, facts);
    const prompt = [
      stablePrefix.trimEnd(),
      '',
      '## Consumer Profile', canonicalJson(consumerProfile).trimEnd(),
      '## Output Budget', canonicalJson(outputBudget).trimEnd(),
      '## Scope Manifest', canonicalJson(scopeManifest).trimEnd(),
      '## Composition Fact Packet', canonicalJson(factPacket).trimEnd(),
      '## Evidence Catalog', canonicalJson(minimalEvidence).trimEnd(),
      ''
    ].join('\n');
    return { factPacket, minimalEvidence, prompt };
  };

  const maximumInputTokens = viewContract.budgets.maximumInputTokens;
  let assembled = materialize(admitted);
  for (const fact of optional) {
    const attempted = materialize([...admitted, fact]);
    if (Math.ceil(Buffer.byteLength(attempted.prompt, 'utf8') / 4) > maximumInputTokens) {
      continue;
    }
    admitted.push(fact);
    assembled = attempted;
  }
  const { factPacket, minimalEvidence, prompt } = assembled;
  const regions = [
    region('stable-core', core.text, 'stable-prefix'),
    region('fact-reference-grammar', WMB_V4_FACT_REFERENCE_GRAMMAR, 'stable-prefix'),
    region('composition-candidate-schema', candidateSchema, 'stable-prefix'),
    region('view-contract', viewContract, 'stable-view'),
    region('consumer-profile', consumerProfile, 'task'),
    region('output-budget', outputBudget, 'task'),
    region('scope-manifest', scopeManifest, 'dynamic'),
    region('composition-fact-packet', factPacket, 'dynamic'),
    region('evidence-catalog', minimalEvidence, 'dynamic')
  ];
  const contextBase = {
    schemaVersion: currentSchemaVersion('world-model-context-manifest'),
    kind: 'world-model-context-manifest',
    viewId: viewContract.id,
    promptSha256: hash(prompt),
    regions: regions.map(({ text: _text, ...entry }) => entry)
  };
  const contextManifest = {
    ...contextBase,
    manifestSha256: hash(contextBase)
  };
  const admittedIds = new Set(admitted.map((entry) => entry.id));
  return Object.freeze({
    prompt,
    contextManifest,
    coreSha256: core.sha256,
    regions,
    admittedFactIds: Object.freeze(admitted.map((fact) => fact.id).sort(compareText)),
    omittedFactIds: Object.freeze(viewFactLedger.facts
      .filter((fact) => !admittedIds.has(fact.id))
      .map((fact) => fact.id)
      .sort(compareText))
  });
}

/** Assemble stable, task, and dynamic regions without allowing volatile data above the boundary. */
export async function assembleWmbV4Prompt(inputs) {
  return assembleWithCore(await loadPinnedCoreV4(), inputs);
}

/** Synchronous verifier counterpart used only while reading an already published Git projection. */
export function assembleWmbV4PromptSync(inputs) {
  return assembleWithCore(loadPinnedCoreV4Sync(), inputs);
}
