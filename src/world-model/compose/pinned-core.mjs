import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PACKAGE_ROOT } from '../../package-root.mjs';
import { canonicalJson, recordSha256 } from '../../records.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';

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

function assembleWithCore(core, {
  viewContract,
  scopeManifest,
  viewFactLedger,
  evidenceCatalog,
  consumerProfile,
  outputBudget
}) {
  const selectedEvidenceIds = new Set(
    viewFactLedger.facts.flatMap((fact) => fact.evidenceIds ?? [])
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
  const candidateSchema = compositionCandidateSchema();
  const stablePrefix = instantiateStablePrefix(core, viewContract);
  const regions = [
    region('stable-core', core.text, 'stable-prefix'),
    region('fact-reference-grammar', WMB_V4_FACT_REFERENCE_GRAMMAR, 'stable-prefix'),
    region('composition-candidate-schema', candidateSchema, 'stable-prefix'),
    region('view-contract', viewContract, 'stable-view'),
    region('consumer-profile', consumerProfile, 'task'),
    region('output-budget', outputBudget, 'task'),
    region('scope-manifest', scopeManifest, 'dynamic'),
    region('fact-ledger', viewFactLedger, 'dynamic'),
    region('evidence-catalog', minimalEvidence, 'dynamic')
  ];
  const prompt = [
    stablePrefix.trimEnd(),
    '',
    '## Consumer Profile', canonicalJson(consumerProfile).trimEnd(),
    '## Output Budget', canonicalJson(outputBudget).trimEnd(),
    '## Scope Manifest', canonicalJson(scopeManifest).trimEnd(),
    '## View Fact Ledger', canonicalJson(viewFactLedger).trimEnd(),
    '## Evidence Catalog', canonicalJson(minimalEvidence).trimEnd(),
    ''
  ].join('\n');
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
  return Object.freeze({ prompt, contextManifest, coreSha256: core.sha256, regions });
}

/** Assemble stable, task, and dynamic regions without allowing volatile data above the boundary. */
export async function assembleWmbV4Prompt(inputs) {
  return assembleWithCore(await loadPinnedCoreV4(), inputs);
}

/** Synchronous verifier counterpart used only while reading an already published Git projection. */
export function assembleWmbV4PromptSync(inputs) {
  return assembleWithCore(loadPinnedCoreV4Sync(), inputs);
}
