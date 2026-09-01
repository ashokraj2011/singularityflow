import { canonicalJson, recordSha256 } from '../../records.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';

function sha(value) { return `sha256:${recordSha256(value)}`; }
function bytesSha(value) {
  // canonical record hashing is used for identity everywhere in WMB; wrap raw bytes so line-ending
  // and trailing-newline differences remain visible without relying on object insertion order.
  return sha({ utf8: String(value) });
}

export function materializeWorldModelView({
  candidate, contract, viewFactLedger, scopeManifest, sourceSnapshot,
  evidenceCatalog, derivationCatalog, validationReceipt, contextManifest,
  executionUnit = 'deterministic-renderer@1', model = null,
  generatedAt = new Date().toISOString()
}) {
  const factsById = new Map(viewFactLedger.facts.map((fact) => [fact.id, fact]));
  const facts = [...new Set(candidate.usedFactIds)].sort().map((id) => structuredClone(factsById.get(id)));
  const factsBlock = {
    schema_version: 1,
    view: contract.id,
    view_version: contract.version,
    view_spec_sha256: contract.contractSha256,
    scope_sha256: scopeManifest.scopeSha256,
    fact_ledger_sha256: viewFactLedger.ledgerSha256,
    facts
  };
  const header = `<!--\nSFlow World-Model View\nsource: ${sourceSnapshot.subject.id}@${sourceSnapshot.revision.commit}\nsource-manifest-sha256: ${sourceSnapshot.sourceManifestSha256}\nscope-sha256: ${scopeManifest.scopeSha256}\nview: ${contract.id}@${contract.version}\nview-spec-sha256: ${contract.contractSha256}\nfact-ledger-sha256: ${viewFactLedger.ledgerSha256}\ncomposer-core-sha256: ${contextManifest.regions.find((entry) => entry.id === 'stable-core')?.sha256 ?? 'unavailable'}\ncomposition-candidate-sha256: ${validationReceipt.candidateSha256}\nvalidator-sha256: ${validationReceipt.validatorSha256}\n-->`;
  const narrative = [
    header,
    '',
    `# ${contract.title} {#${contract.id}}`,
    '',
    `**TL;DR** ${candidate.tldrMarkdown}`,
    '',
    ...candidate.sections.flatMap((section) => {
      const registered = contract.sections.find((entry) => entry.id === section.sectionId);
      return [`## ${registered.title} {#${contract.id}.${section.sectionId}}`, '', section.markdown, ''];
    }),
    `## Facts {#${contract.id}.facts}`,
    '',
    '```json',
    canonicalJson(factsBlock).trimEnd(),
    '```',
    ''
  ].join('\n');
  const compositionViewSha256 = bytesSha(narrative);
  const stamp = [
    '---',
    `generated-at: ${generatedAt}`,
    `source-commit: ${sourceSnapshot.revision.commit}`,
    `view-sha256: ${compositionViewSha256}`,
    `prompt-sha256: ${contextManifest.promptSha256}`,
    `execution-unit: ${executionUnit}`,
    `model: ${model ?? 'unavailable'}`,
    'assurance: validated-derived-view',
    '---',
    ''
  ].join('\n');
  const markdown = `${narrative}${stamp}`;
  return Object.freeze({
    markdown,
    factsBlock,
    compositionViewSha256,
    viewSha256: bytesSha(markdown),
    bytes: Buffer.byteLength(markdown, 'utf8'),
    dependencies: Object.freeze({
      sourceManifestSha256: sourceSnapshot.sourceManifestSha256,
      scopeManifestSha256: scopeManifest.scopeSha256,
      evidenceCatalogSha256: evidenceCatalog.catalogSha256,
      derivationCatalogSha256: derivationCatalog.catalogSha256,
      viewFactLedgerSha256: viewFactLedger.ledgerSha256,
      validationReceiptSha256: validationReceipt.receiptSha256
    })
  });
}

export function usageObservation({ viewId, prompt, output, usage = null }) {
  const promptBytes = Buffer.byteLength(String(prompt ?? ''), 'utf8');
  const outputBytes = Buffer.byteLength(String(output ?? ''), 'utf8');
  const base = {
    schemaVersion: currentSchemaVersion('world-model-usage-observation'),
    kind: 'world-model-usage-observation',
    viewId,
    promptBytes,
    estimatedInputTokens: Math.ceil(promptBytes / 4),
    providerInputTokens: Number.isFinite(usage?.inputTokens) ? usage.inputTokens : null,
    providerCachedTokens: Number.isFinite(usage?.cachedInputTokens) ? usage.cachedInputTokens : null,
    outputBytes,
    estimatedOutputTokens: Math.ceil(outputBytes / 4),
    providerOutputTokens: Number.isFinite(usage?.outputTokens) ? usage.outputTokens : null,
    cost: {
      currency: 'USD',
      amount: Number.isFinite(usage?.providerCost) ? usage.providerCost : null,
      assurance: Number.isFinite(usage?.providerCost) ? 'provider-reported' : 'unavailable'
    },
    assurance: {
      promptBytes: 'exact',
      estimatedTokens: 'estimated',
      providerTokens: Number.isFinite(usage?.inputTokens) || Number.isFinite(usage?.outputTokens)
        ? 'provider-reported' : 'unavailable'
    }
  };
  return Object.freeze({ ...base, observationSha256: sha(base) });
}
