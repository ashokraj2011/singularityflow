import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PACKAGE_ROOT } from '../../package-root.mjs';
import { canonicalJson, recordSha256 } from '../../records.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';

export const WMB_V4_REQUEST_BOUNDARY = '<!-- ===== REQUEST INPUTS: volatile tail ===== -->';

const pinnedCorePath = path.join(PACKAGE_ROOT, 'templates', 'world-model', 'pinned-core-v4.md');

function hash(value) { return `sha256:${recordSha256(value)}`; }

function normalizedPinnedCore(text) {
  text = text.replaceAll('\r\n', '\n');
  const first = text.indexOf(WMB_V4_REQUEST_BOUNDARY);
  if (first < 0 || first !== text.lastIndexOf(WMB_V4_REQUEST_BOUNDARY)) {
    throw new SingularityFlowError('Pinned WMB v4 core must contain exactly one request-input boundary.', {
      code: 'WMB_PINNED_CORE_INVALID'
    });
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
  const regions = [
    region('stable-core', core.text, 'stable-prefix'),
    region('view-contract', viewContract, 'stable-view'),
    region('consumer-profile', consumerProfile, 'task'),
    region('output-budget', outputBudget, 'task'),
    region('scope-manifest', scopeManifest, 'dynamic'),
    region('fact-ledger', viewFactLedger, 'dynamic'),
    region('evidence-catalog', minimalEvidence, 'dynamic')
  ];
  const prompt = [
    core.text.trimEnd(),
    '',
    '## Registered View Contract', canonicalJson(viewContract).trimEnd(),
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
