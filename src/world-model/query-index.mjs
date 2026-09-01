/** Rebuildable, model-free index over a verified WMB v4 graph. */
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { readPrivateSidecar, writeMutablePrivateSidecar } from '../private-sidecar.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { canonicalJson, compareText, sealRecord } from './canonicalize.mjs';
import { validateDerivationCatalog } from './extract/derivation-catalog.mjs';
import { validateEvidenceCatalog } from './extract/evidence-catalog.mjs';
import { validateFactLedger } from './extract/fact-ledger.mjs';
import { readWorldModelV4Manifest } from './publish/manifest.mjs';
import {
  ASSURANCE_LEVELS, EVIDENCE_KINDS, FACT_STATUSES, FACT_TYPES, SUBJECT_KINDS
} from './vocabularies.mjs';

const FAMILY = 'world-model-query-index';
const KIND = 'world-model-query-index';
const MAXIMUM_INDEX_BYTES = 64 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const VIEW_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
const FACT_ID = /^FACT-[a-f0-9]{16,64}$/;
const EVIDENCE_ID = /^EV-[a-f0-9]{16,64}$/;
const DERIVATION_ID = /^DRV-[a-f0-9]{16,64}$/;

function fail(message, code = 'WMB_QUERY_INDEX_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} contains missing or unknown fields.`, 'WMB_QUERY_INDEX_INVALID', { actual, expected: wanted });
  }
}

function indexPath(root, manifestSha256) {
  if (!SHA256.test(String(manifestSha256 ?? ''))) fail('WMB query-index manifest digest is invalid.');
  const hex = manifestSha256.slice('sha256:'.length);
  return path.join(gitCommonDir(root), 'singularity-flow', 'world-model-cache', 'v4',
    'query-indexes', hex.slice(0, 2), `${hex}.json`);
}

function projectedEvidence(catalog) {
  return catalog.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    path: item.locator.path,
    symbol: item.locator.symbol ?? null,
    target: item.locator.target ?? null,
    subjectSha256: item.subjectSha256,
    evidenceSha256: item.evidenceSha256
  })).sort((left, right) => compareText(left.id, right.id));
}

function projectedFacts(ledger) {
  return ledger.facts.map((fact) => ({
    id: fact.id,
    factType: fact.factType,
    status: fact.status,
    assurance: fact.assurance,
    subjectKind: fact.subject.kind,
    subjectId: fact.subject.id,
    evidenceIds: [...fact.evidenceIds],
    derivationId: fact.derivationId,
    factSha256: fact.factSha256
  })).sort((left, right) => compareText(left.id, right.id));
}

export function buildWorldModelQueryIndex({
  manifest: manifestValue, evidenceCatalog: evidenceValue,
  derivationCatalog: derivationValue, factLedger: factValue
} = {}) {
  const manifest = readWorldModelV4Manifest(manifestValue);
  const evidence = validateEvidenceCatalog(evidenceValue);
  const factLedger = validateFactLedger(factValue, {
    evidenceCatalog: evidence,
    derivationIds: new Set((derivationValue?.derivations ?? []).map((item) => item.id))
  });
  const derivations = validateDerivationCatalog(derivationValue, {
    evidenceCatalog: evidence, factLedger
  });
  if (manifest.sourceManifestSha256 !== evidence.sourceManifestSha256
      || manifest.sourceManifestSha256 !== factLedger.sourceManifestSha256
      || manifest.scopeManifestSha256 !== evidence.scopeManifestSha256
      || manifest.scopeManifestSha256 !== factLedger.scopeManifestSha256
      || manifest.evidenceCatalogSha256 !== evidence.catalogSha256
      || manifest.derivationCatalogSha256 !== derivations.catalogSha256
      || manifest.factLedgerSha256 !== factLedger.ledgerSha256) {
    fail('WMB query-index inputs do not bind the same verified graph.',
      'WMB_QUERY_INDEX_BINDING_INVALID');
  }
  return validateWorldModelQueryIndex(sealRecord({
    schemaVersion: currentSchemaVersion(FAMILY),
    kind: KIND,
    manifestSha256: manifest.manifestSha256,
    sourceManifestSha256: manifest.sourceManifestSha256,
    views: manifest.views.map((view) => ({
      id: view.viewId, version: view.viewVersion, status: view.status,
      viewSha256: view.viewSha256
    })).sort((left, right) => compareText(`${left.id}@${left.version}`, `${right.id}@${right.version}`)),
    facts: projectedFacts(factLedger),
    evidence: projectedEvidence(evidence)
  }, 'indexSha256'));
}

export function validateWorldModelQueryIndex(value) {
  let index;
  try { index = readRecord(FAMILY, value).record; }
  catch (error) { fail(`WMB query index schema is invalid: ${error.message}`); }
  exactKeys(index, [
    'schemaVersion', 'kind', 'manifestSha256', 'sourceManifestSha256',
    'views', 'facts', 'evidence', 'indexSha256'
  ], 'WMB query index');
  if (index.kind !== KIND) fail('WMB query index kind is invalid.');
  for (const field of ['manifestSha256', 'sourceManifestSha256', 'indexSha256']) {
    if (!SHA256.test(index[field])) fail(`WMB query index ${field} is invalid.`);
  }
  if (!Array.isArray(index.views) || !Array.isArray(index.facts) || !Array.isArray(index.evidence)) {
    fail('WMB query index collections must be arrays.');
  }
  let previous = '';
  for (const view of index.views) {
    exactKeys(view, ['id', 'version', 'status', 'viewSha256'], 'WMB query-index view');
    if (!VIEW_ID.test(view.id) || !Number.isSafeInteger(view.version) || view.version < 1
        || !['available', 'unavailable'].includes(view.status)
        || !(view.viewSha256 === null || SHA256.test(view.viewSha256))) {
      fail('WMB query-index view fields are invalid.');
    }
    const key = `${view.id}@${view.version}`;
    if (compareText(previous, key) >= 0) fail('WMB query-index views are duplicated or unordered.');
    previous = key;
  }
  previous = '';
  for (const fact of index.facts) {
    exactKeys(fact, [
      'id', 'factType', 'status', 'assurance', 'subjectKind', 'subjectId',
      'evidenceIds', 'derivationId', 'factSha256'
    ], 'WMB query-index Fact');
    if (!FACT_ID.test(fact.id) || !FACT_TYPES.includes(fact.factType)
        || !FACT_STATUSES.includes(fact.status) || !ASSURANCE_LEVELS.includes(fact.assurance)
        || !SUBJECT_KINDS.includes(fact.subjectKind)
        || typeof fact.subjectId !== 'string' || !fact.subjectId
        || !Array.isArray(fact.evidenceIds)
        || fact.evidenceIds.some((id) => !EVIDENCE_ID.test(id))
        || new Set(fact.evidenceIds).size !== fact.evidenceIds.length
        || !DERIVATION_ID.test(fact.derivationId) || !SHA256.test(fact.factSha256)) {
      fail('WMB query-index Fact fields are invalid.');
    }
    if (compareText(previous, fact.id) >= 0) fail('WMB query-index Facts are duplicated or unordered.');
    previous = fact.id;
  }
  previous = '';
  for (const evidence of index.evidence) {
    exactKeys(evidence, [
      'id', 'kind', 'path', 'symbol', 'target', 'subjectSha256', 'evidenceSha256'
    ], 'WMB query-index Evidence');
    if (!EVIDENCE_ID.test(evidence.id) || !EVIDENCE_KINDS.includes(evidence.kind)
        || typeof evidence.path !== 'string' || !evidence.path
        || !(evidence.symbol === null || typeof evidence.symbol === 'string')
        || !(evidence.target === null || typeof evidence.target === 'string')
        || !SHA256.test(evidence.subjectSha256) || !SHA256.test(evidence.evidenceSha256)) {
      fail('WMB query-index Evidence fields are invalid.');
    }
    if (compareText(previous, evidence.id) >= 0) fail('WMB query-index Evidence is duplicated or unordered.');
    previous = evidence.id;
  }
  const unsealed = structuredClone(index);
  delete unsealed.indexSha256;
  if (sealRecord(unsealed, 'indexSha256').indexSha256 !== index.indexSha256) {
    fail('WMB query index self hash does not verify.', 'WMB_QUERY_INDEX_CORRUPT');
  }
  return Object.freeze(index);
}

export async function storeWorldModelQueryIndex(root, graph) {
  const index = buildWorldModelQueryIndex(graph);
  const target = indexPath(root, index.manifestSha256);
  const bytes = Buffer.from(canonicalJson(index));
  if (bytes.length > MAXIMUM_INDEX_BYTES) fail('WMB query index exceeds its byte ceiling.');
  try {
    const existing = await readWorldModelQueryIndex(root, index.manifestSha256, {
      optional: true
    });
    if (existing?.index.indexSha256 === index.indexSha256) {
      return Object.freeze({ index, path: target, written: false });
    }
  } catch {
    // This is rebuildable Derived Memory. A corrupt prior index has no authority and is replaced
    // atomically from the independently verified manifest/evidence graph below.
  }
  const publication = await writeMutablePrivateSidecar(root, target, bytes, {
    maximumBytes: MAXIMUM_INDEX_BYTES
  });
  const installed = await readWorldModelQueryIndex(root, index.manifestSha256);
  if (installed.index.indexSha256 !== index.indexSha256) {
    fail('WMB query index did not verify after rebuild.', 'WMB_QUERY_INDEX_CORRUPT');
  }
  return Object.freeze({
    index, path: target, written: true, replaced: !publication.created
  });
}

export async function readWorldModelQueryIndex(root, manifestSha256, { optional = false } = {}) {
  const target = indexPath(root, manifestSha256);
  const bytes = await readPrivateSidecar(root, target, {
    maximumBytes: MAXIMUM_INDEX_BYTES, optional
  });
  if (!bytes) return null;
  const index = validateWorldModelQueryIndex(bytes);
  if (!Buffer.from(canonicalJson(index)).equals(bytes)) fail('WMB query index is not canonical JSON.');
  return Object.freeze({ index, path: target });
}

export function queryWorldModelIndex(indexValue, selector = {}, { maximumResults = 100 } = {}) {
  const index = validateWorldModelQueryIndex(indexValue);
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > 1000) {
    fail('WMB query maximumResults must be an integer from 1 through 1000.');
  }
  exactKeys(selector, Object.keys(selector), 'WMB query selector');
  const allowed = new Set([
    'viewId', 'factId', 'factType', 'factStatus', 'subjectKind', 'subjectId',
    'evidenceId', 'evidenceKind', 'path', 'target'
  ]);
  for (const key of Object.keys(selector)) if (!allowed.has(key)) {
    fail(`Unknown WMB query selector '${key}'.`, 'WMB_QUERY_INVALID');
  }
  const equals = (actual, wanted) => wanted == null || actual === wanted;
  const views = index.views.filter((view) => equals(view.id, selector.viewId));
  const facts = index.facts.filter((fact) => (
    equals(fact.id, selector.factId)
    && equals(fact.factType, selector.factType)
    && equals(fact.status, selector.factStatus)
    && equals(fact.subjectKind, selector.subjectKind)
    && equals(fact.subjectId, selector.subjectId)
    && (selector.evidenceId == null || fact.evidenceIds.includes(selector.evidenceId))
  ));
  const evidence = index.evidence.filter((item) => (
    equals(item.id, selector.evidenceId)
    && equals(item.kind, selector.evidenceKind)
    && equals(item.path, selector.path)
    && equals(item.target, selector.target)
  ));
  return Object.freeze({
    manifestSha256: index.manifestSha256,
    views: Object.freeze(views.slice(0, maximumResults)),
    facts: Object.freeze(facts.slice(0, maximumResults)),
    evidence: Object.freeze(evidence.slice(0, maximumResults)),
    truncated: views.length > maximumResults || facts.length > maximumResults
      || evidence.length > maximumResults
  });
}
