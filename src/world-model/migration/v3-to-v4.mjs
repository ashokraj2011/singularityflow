import { currentSchemaVersion, readRecord } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { sealRecord, sha256 } from '../canonicalize.mjs';
import {
  FACT_ID_PATTERN, assertCanonicalOrder, assertExactKeys, assertInteger, assertPlainRecord,
  assertSelfHash, assertSha256, assertString, assertStringArray
} from '../contracts.mjs';
import { validateEvidenceCatalog } from '../extract/evidence-catalog.mjs';
import { validateFactLedger } from '../extract/fact-ledger.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';
import { validateSourceSnapshot } from '../source/snapshot.mjs';
import {
  LEGACY_WORLD_MODEL_CLASSIFICATION, readLegacyWorldModelView
} from './v3-reader.mjs';

export const WORLD_MODEL_MIGRATION_RECEIPT_FAMILY = 'world-model-migration-receipt';

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function evidenceCandidateMap(catalog) {
  const map = new Map();
  for (const item of catalog.items) {
    const withSymbol = item.locator.symbol ? `${item.locator.path}#${item.locator.symbol}` : null;
    if (withSymbol) {
      if (!map.has(withSymbol)) map.set(withSymbol, new Set());
      map.get(withSymbol).add(item.id);
    }
  }
  return map;
}

function claimMatches(claim, fact) {
  if (typeof fact.claim !== 'string' || normalizeText(fact.claim) !== normalizeText(claim.text)) return false;
  return true;
}

/**
 * Conservatively map legacy prose to current registered facts. Exact claim text is mandatory;
 * path#symbol strings merely narrow candidates and never become Evidence IDs by themselves.
 */
export function mapLegacyClaimsToRegisteredFacts({ legacyView, evidenceCatalog, factLedger } = {}) {
  const legacy = legacyView?.classification === LEGACY_WORLD_MODEL_CLASSIFICATION
    ? legacyView : readLegacyWorldModelView(legacyView);
  const evidence = validateEvidenceCatalog(evidenceCatalog);
  const facts = validateFactLedger(factLedger, { evidenceCatalog: evidence });
  const registeredEvidence = evidenceCandidateMap(evidence);
  const mappings = [];
  const unresolved = [];
  for (const claim of legacy.claims) {
    const candidateEvidenceIds = new Set(claim.evidenceCandidates.flatMap((candidate) => (
      [...(registeredEvidence.get(candidate) ?? [])]
    )));
    const matches = facts.facts.filter((fact) => claimMatches(claim, fact)
      && (!claim.evidenceCandidates.length
        || fact.evidenceIds.some((id) => candidateEvidenceIds.has(id))));
    if (matches.length === 1) {
      mappings.push(Object.freeze({
        sourceClaimIndex: claim.index,
        sourceClaimSha256: claim.claimSha256,
        factId: matches[0].id,
        factSha256: matches[0].factSha256,
        status: matches[0].status
      }));
    } else {
      unresolved.push(Object.freeze({
        sourceClaimIndex: claim.index,
        sourceClaimSha256: claim.claimSha256,
        status: 'unavailable',
        reason: matches.length > 1 ? 'ambiguous-registered-fact-match' : 'no-registered-fact-match',
        evidenceCandidates: Object.freeze([...claim.evidenceCandidates])
      }));
    }
  }
  return Object.freeze({ legacy, mappings: Object.freeze(mappings), unresolved: Object.freeze(unresolved) });
}

const UNRESOLVED_REASONS = new Set([
  'ambiguous-registered-fact-match', 'no-registered-fact-match'
]);

/**
 * Validate the durable claim-by-claim migration proof against the current registered facts.
 * Legacy prose remains untrusted; this receipt records exactly which legacy claim index was mapped
 * to which immutable Fact, and which claim indexes remained explicitly unavailable.
 */
export function validateWorldModelMigrationReceipt(value, {
  sourceSnapshot = null,
  scopeManifest = null,
  evidenceCatalog = null,
  factLedger = null,
  availableViews = null
} = {}) {
  const receipt = readRecord(WORLD_MODEL_MIGRATION_RECEIPT_FAMILY, value).record;
  assertSelfHash(receipt, 'receiptSha256', 'World-model migration receipt');
  const mappings = receipt.mappings;
  const unresolved = receipt.unresolvedClaims;
  assertCanonicalOrder(mappings, (entry) => String(entry.sourceClaimIndex).padStart(12, '0'),
    'World-model migration mappings');
  assertCanonicalOrder(unresolved, (entry) => String(entry.sourceClaimIndex).padStart(12, '0'),
    'World-model unresolved migration claims');

  const facts = factLedger?.facts ?? [];
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  for (const [index, mapping] of mappings.entries()) {
    assertPlainRecord(mapping, `Migration mapping[${index}]`);
    assertExactKeys(mapping, {
      required: ['sourceClaimIndex', 'sourceClaimSha256', 'factId', 'factSha256', 'status'],
      label: `Migration mapping[${index}]`
    });
    assertInteger(mapping.sourceClaimIndex, `Migration mapping[${index}] sourceClaimIndex`);
    assertSha256(mapping.sourceClaimSha256, `Migration mapping[${index}] sourceClaimSha256`);
    assertString(mapping.factId, `Migration mapping[${index}] factId`, { pattern: FACT_ID_PATTERN });
    assertSha256(mapping.factSha256, `Migration mapping[${index}] factSha256`);
    assertString(mapping.status, `Migration mapping[${index}] status`);
    if (factLedger) {
      const fact = factsById.get(mapping.factId);
      if (!fact || fact.factSha256 !== mapping.factSha256 || fact.status !== mapping.status) {
        throw new SingularityFlowError(
          `World-model migration mapping for claim ${mapping.sourceClaimIndex} does not bind an exact current registered Fact.`,
          { code: 'WMB_MIGRATION_RECEIPT_INVALID', details: { sourceClaimIndex: mapping.sourceClaimIndex } }
        );
      }
    }
  }
  for (const [index, entry] of unresolved.entries()) {
    assertPlainRecord(entry, `Unresolved migration claim[${index}]`);
    assertExactKeys(entry, {
      required: ['sourceClaimIndex', 'sourceClaimSha256', 'status', 'reason', 'evidenceCandidates'],
      label: `Unresolved migration claim[${index}]`
    });
    assertInteger(entry.sourceClaimIndex, `Unresolved migration claim[${index}] sourceClaimIndex`);
    assertSha256(entry.sourceClaimSha256, `Unresolved migration claim[${index}] sourceClaimSha256`);
    if (entry.status !== 'unavailable' || !UNRESOLVED_REASONS.has(entry.reason)) {
      throw new SingularityFlowError(
        `World-model migration claim ${entry.sourceClaimIndex} is not a typed unavailable result.`,
        { code: 'WMB_MIGRATION_RECEIPT_INVALID', details: { sourceClaimIndex: entry.sourceClaimIndex } }
      );
    }
    assertStringArray(entry.evidenceCandidates,
      `Unresolved migration claim[${index}] evidenceCandidates`, { sorted: true });
  }

  const allIndexes = [...mappings, ...unresolved].map((entry) => entry.sourceClaimIndex).sort((a, b) => a - b);
  const expectedIndexes = Array.from({ length: receipt.claims.total }, (_unused, index) => index);
  const contradicted = mappings.filter((entry) => entry.status === 'contradicted').length;
  if (JSON.stringify(allIndexes) !== JSON.stringify(expectedIndexes)
      || receipt.claims.mappedToRegisteredFacts !== mappings.length
      || receipt.claims.unresolved !== unresolved.length
      || receipt.claims.contradicted !== contradicted) {
    throw new SingularityFlowError(
      'World-model migration receipt does not account for every legacy claim exactly once.',
      { code: 'WMB_MIGRATION_RECEIPT_INVALID' }
    );
  }
  if (sourceSnapshot && receipt.sourceManifestSha256 !== sourceSnapshot.sourceManifestSha256
      || scopeManifest && receipt.scopeManifestSha256 !== scopeManifest.scopeSha256
      || evidenceCatalog && receipt.evidenceCatalogSha256 !== evidenceCatalog.catalogSha256
      || factLedger && receipt.factLedgerSha256 !== factLedger.ledgerSha256) {
    throw new SingularityFlowError(
      'World-model migration receipt does not bind the exact current source, scope, evidence, and facts.',
      { code: 'WMB_MIGRATION_RECEIPT_INVALID' }
    );
  }
  if (availableViews && !availableViews.some((entry) => (
    entry.status === 'available' && entry.viewSha256 === receipt.targetViewSha256
  ))) {
    throw new SingularityFlowError(
      'World-model migration receipt target is not an available view in the current manifest.',
      { code: 'WMB_MIGRATION_RECEIPT_INVALID' }
    );
  }
  return Object.freeze(receipt);
}

/** Create the receipt only after a separately validated v4 target view exists. */
export function createWorldModelMigrationReceipt({
  legacyView, targetViewSha256, sourceSnapshot, scopeManifest, evidenceCatalog, factLedger
} = {}) {
  const source = validateSourceSnapshot(sourceSnapshot);
  const scope = validateScopeManifest(scopeManifest);
  const evidence = validateEvidenceCatalog(evidenceCatalog, { sourceSnapshot: source, scopeManifest: scope });
  const facts = validateFactLedger(factLedger, {
    sourceSnapshot: source, scopeManifest: scope, evidenceCatalog: evidence
  });
  assertSha256(targetViewSha256, 'Migration target view SHA-256');
  const mapping = mapLegacyClaimsToRegisteredFacts({ legacyView, evidenceCatalog: evidence, factLedger: facts });
  const contradicted = mapping.mappings.filter((entry) => entry.status === 'contradicted').length;
  const receipt = sealRecord({
    schemaVersion: currentSchemaVersion(WORLD_MODEL_MIGRATION_RECEIPT_FAMILY),
    kind: 'world-model-migration-receipt',
    sourceFormat: 'wmb-v3',
    targetFormat: 'wmb-v4',
    sourceViewSha256: mapping.legacy.sourceViewSha256,
    targetViewSha256,
    sourceManifestSha256: source.sourceManifestSha256,
    scopeManifestSha256: scope.scopeSha256,
    evidenceCatalogSha256: evidence.catalogSha256,
    factLedgerSha256: facts.ledgerSha256,
    claims: {
      total: mapping.legacy.claims.length,
      mappedToRegisteredFacts: mapping.mappings.length,
      unresolved: mapping.unresolved.length,
      contradicted
    },
    mappings: mapping.mappings,
    unresolvedClaims: mapping.unresolved
  }, 'receiptSha256');
  validateWorldModelMigrationReceipt(receipt, {
    sourceSnapshot: source,
    scopeManifest: scope,
    evidenceCatalog: evidence,
    factLedger: facts,
    availableViews: [{ status: 'available', viewSha256: targetViewSha256 }]
  });
  return Object.freeze({
    receipt: Object.freeze(receipt),
    mappings: mapping.mappings,
    unresolved: mapping.unresolved,
    classification: LEGACY_WORLD_MODEL_CLASSIFICATION
  });
}
