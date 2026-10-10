import { sha256 } from '../../../canonical-json.mjs';
import { contractFailure } from '../../contracts.mjs';
import { validateEvidenceCatalog } from '../../extract/evidence-catalog.mjs';
import { validateDerivationCatalog } from '../../extract/derivation-catalog.mjs';
import {
  IMPORT_DEPENDENCY_ID, IMPORT_DEPENDENCY_VERSION, IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256
} from '../../extract/adapters/import-dependency.mjs';
import {
  INTERFACE_CONTRACT_ID, INTERFACE_CONTRACT_VERSION, INTERFACE_CONTRACT_IMPLEMENTATION_SHA256
} from '../../extract/adapters/interface-contract.mjs';
import { classifyScopePath } from '../../scope/matcher.mjs';
import { sourceFileMap } from '../../source/snapshot.mjs';

const TYPES = new Set(['dependency-edge', 'import-dependency', 'interface', 'schema-contract',
  'protocol-field', 'consumer-dependency']);
const PRODUCERS = new Map([
  [IMPORT_DEPENDENCY_ID, [IMPORT_DEPENDENCY_VERSION, IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256]],
  [INTERFACE_CONTRACT_ID, [INTERFACE_CONTRACT_VERSION, INTERFACE_CONTRACT_IMPLEMENTATION_SHA256]]
]);

/** Translate registered structure, never prose, into architecture declarations. */
export function createCalmFactBridge({ factLedger, evidenceCatalog, derivationCatalog,
  sourceSnapshot, scopeManifest, capabilitySnapshot, sourceManifestSha256, scopeSha256 }) {
  if (!evidenceCatalog && !derivationCatalog) return () => null;
  if (!evidenceCatalog || !derivationCatalog || !sourceSnapshot || !scopeManifest) {
    contractFailure('CALM fact mapping requires complete pinned extraction inputs.', 'WMC_FACT_SET_INVALID');
  }
  const evidence = validateEvidenceCatalog(evidenceCatalog);
  // Index and validate the source once; rebuilding the entire snapshot map for every evidence
  // row would make this bridge quadratic on a large repository.
  const sourceFiles = sourceFileMap(sourceSnapshot);
  for (const item of evidence.items) {
    if (sourceFiles.get(item.locator.path)?.contentSha256 !== item.sourceContentSha256
        || classifyScopePath(item.locator.path, scopeManifest).status !== 'inside') {
      contractFailure('CALM evidence does not bind in-scope pinned source bytes.', 'WMC_FACT_SET_INVALID');
    }
  }
  const derivations = validateDerivationCatalog(derivationCatalog, { evidenceCatalog: evidence, factLedger });
  if (evidence.sourceManifestSha256 !== sourceManifestSha256
      || evidence.scopeManifestSha256 !== scopeSha256
      || sourceSnapshot.sourceManifestSha256 !== sourceManifestSha256
      || scopeManifest.scopeSha256 !== scopeSha256) {
    contractFailure('CALM facts do not bind the selected source and scope.', 'WMC_FACT_SET_INVALID');
  }
  const evidenceById = new Map(evidence.items.map((item) => [item.id, item]));
  const derivationById = new Map(derivations.derivations.map((item) => [item.id, item]));
  const capabilities = capabilitySnapshot.capabilities.filter((item) => item.kind === 'delivery');
  const owner = (file) => {
    const matches = capabilities.flatMap((capability) => (capability.sourceRoots ?? [])
      .filter((root) => file === root || file.startsWith(`${root}/`))
      .map((root) => ({ id: capability.id, length: root.length })));
    const length = Math.max(-1, ...matches.map((item) => item.length));
    const ids = new Set(matches.filter((item) => item.length === length).map((item) => item.id));
    if (ids.size === 1) return { id: [...ids][0] };
    if (ids.size > 1) return { reason: 'capability-ownership-ambiguous' };
    // Shared paths and explicitly unowned paths must not inherit the selected capability.
    if (classifyScopePath(file, scopeManifest).match?.classification === 'shared') {
      return { reason: 'capability-ownership-unavailable' };
    }
    const selected = capabilities.find((item) => item.id === scopeManifest.capabilityId
      && !(item.sourceRoots ?? []).length);
    if (selected) return { id: selected.id };
    if (capabilities.length === 1 && !(capabilities[0].sourceRoots ?? []).length) {
      return { id: capabilities[0].id };
    }
    return { reason: 'capability-ownership-unavailable' };
  };
  const locatorFor = (fact) => {
    const derivation = derivationById.get(fact.derivationId);
    const expected = PRODUCERS.get(derivation?.extractor.id);
    if (!expected || derivation.extractor.version !== expected[0]
        || derivation.extractor.implementationSha256 !== expected[1]) return null;
    if (fact.status !== 'available') return { reason: 'structural-fact-not-available' };
    const items = fact.evidenceIds.map((id) => evidenceById.get(id));
    if (items.length !== 1 || !items[0] || items[0].subjectSha256 !== sha256(fact.subject)) {
      return { reason: 'structural-evidence-ambiguous' };
    }
    return { item: items[0], producer: derivation.extractor.id };
  };
  const interfaceOwners = new Map();
  for (const fact of factLedger.facts) {
    if (fact.factType !== 'interface') continue;
    const located = locatorFor(fact);
    if (located?.producer !== INTERFACE_CONTRACT_ID || located.item?.kind !== 'signature') continue;
    const ownership = owner(located.item.locator.path);
    if (!ownership.id) continue;
    const symbol = located.item.locator.symbol;
    const entries = interfaceOwners.get(symbol) ?? [];
    entries.push({ node: ownership.id, path: located.item.locator.path });
    interfaceOwners.set(symbol, entries);
  }
  return (fact) => {
    if (!TYPES.has(fact.factType)) return null;
    const located = locatorFor(fact);
    if (!located) return null;
    if (located.reason) return { gap: located.reason };
    const { item, producer } = located;
    const { path: file, symbol, target } = item.locator;
    const ownership = owner(file);
    if (!ownership.id) return { gap: ownership.reason };
    const source = ownership.id;
    if (producer === IMPORT_DEPENDENCY_ID && fact.factType === 'dependency-edge'
        && item.kind === 'dependency-edge' && target) {
      if (!sourceFiles.has(target)) return { gap: 'dependency-target-outside-source-snapshot' };
      const destination = owner(target);
      if (!destination.id) return { gap: destination.reason };
      return { claim: { source, destination: destination.id,
        description: `${file} imports the source module ${target}; runtime communication is not established.` },
        internal: source === destination.id };
    }
    if (producer === IMPORT_DEPENDENCY_ID && fact.factType === 'import-dependency'
        && item.kind === 'import' && target) {
      // Only closed JS package specifiers are external-module declarations. An unresolved
      // relative/polyglot import is not evidence of an external service or network endpoint.
      if (!/\.[cm]?[jt]sx?$/u.test(file)
          || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9_-][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/iu.test(target)) {
        return { gap: 'import-target-not-architecture-classified' };
      }
      return { claim: { source, destination: `external-module:${sha256(target).slice(7, 31)}`,
        external: true, name: target,
        description: `Declared external module ${target}; no deployment or runtime transport is inferred.` } };
    }
    if (producer !== INTERFACE_CONTRACT_ID) return { gap: 'structural-evidence-kind-unsupported' };
    if (fact.factType === 'consumer-dependency' && item.kind === 'interface-implementation') {
      const candidates = interfaceOwners.get(target) ?? [];
      // Prefer a same-file declaration; otherwise require a unique declaration, not a name guess.
      const local = candidates.filter((entry) => entry.path === file);
      const selected = local.length ? local : candidates;
      if (selected.length !== 1) return { gap: 'interface-target-ambiguous-or-unavailable' };
      return { claim: { source, destination: selected[0].node,
        description: `${file} explicitly implements ${target}; runtime communication is not established.` },
        internal: source === selected[0].node };
    }
    if ((fact.factType === 'interface' || fact.factType === 'protocol-field')
        && item.kind === 'signature' && symbol) {
      return { claim: { node: source, id: `source-contract:${sha256({ file, symbol }).slice(7, 31)}`,
        type: fact.factType === 'interface' ? 'sflow-source-interface' : 'sflow-source-field',
        value: `${file}#${symbol}` } };
    }
    if ((fact.factType === 'schema-contract' || fact.factType === 'protocol-field')
        && item.kind === 'configuration-object') {
      return { claim: { node: source,
        id: `source-contract:${sha256({ file, target: target ?? null }).slice(7, 31)}`,
        type: fact.factType === 'schema-contract' ? 'sflow-schema-contract' : 'sflow-schema-field',
        value: target ? `${file}#${target}` : file } };
    }
    return { gap: 'structural-evidence-kind-unsupported' };
  };
}
