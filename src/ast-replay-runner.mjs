import { createHash } from 'node:crypto';

import { BUILTIN_AST_EXTRACTOR, extractBuiltinAstFacts } from './ast-builtin-extractor.mjs';
import { extractPolyglotSyntax } from './polyglot-syntax-core.mjs';
import { applySelectionPriority } from './ast-fact-order.mjs';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function recordSha256(value) {
  const bytes = `${JSON.stringify(canonicalize(value), null, 2)}\n`;
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assuranceSatisfies(actual, required) {
  return ['text', 'syntax', 'semantic'].indexOf(actual) >= ['text', 'syntax', 'semantic'].indexOf(required);
}

function materializeFileFacts(input, bytes) {
  const extractor = structuredClone(BUILTIN_AST_EXTRACTOR);
  const generated = input.generated === true;
  const skeleton = extractBuiltinAstFacts(bytes, input.language, input.path);
  return [
    {
      kind: 'file', path: input.path, language: input.language, bytes: bytes.length,
      sha256: sha256(bytes), generated, assurance: extractor.assurance, extractor
    },
    ...skeleton.map((fact) => fact.kind === 'symbol'
      ? {
          ...fact,
          at: `${input.path}:${fact.line}`, path: input.path,
          assurance: fact.assurance, generated, extractor
        }
      : { kind: 'import', from: input.path, target: fact.target, assurance: fact.assurance, generated, extractor })
  ];
}

function materializePolyglotFacts(input, bytes, extractor) {
  const generated = input.generated === true;
  const { facts } = extractPolyglotSyntax(bytes, input.language);
  const assurance = extractor.assurance ?? 'text';
  return facts.map((fact) => {
    const normalized = fact.kind === 'symbol' ? { ...fact, line: fact.span.startLine } : fact;
    if (normalized.kind === 'symbol') {
      return {
        ...normalized, at: `${input.path}:${normalized.span?.startLine ?? normalized.line}`,
        path: input.path, assurance, generated, extractor
      };
    }
    if (normalized.kind === 'import') return { ...normalized, from: input.path, assurance, generated, extractor };
    if (normalized.kind === 'module' || normalized.kind === 'diagnostic') {
      return { ...normalized, path: input.path, assurance, generated, extractor };
    }
    return { ...normalized, from: input.path, assurance, generated, extractor };
  });
}

function materializeAdapterFacts(input, facts, extractor) {
  const generated = input.generated === true;
  return facts.map((fact) => {
    const normalized = fact.kind === 'symbol' ? { ...fact, line: fact.span?.startLine ?? fact.line } : fact;
    if (normalized.kind === 'symbol') return {
      ...normalized, at: `${input.path}:${normalized.span?.startLine ?? normalized.line}`,
      path: input.path, assurance: normalized.assurance ?? extractor.assurance,
      generated, extractor
    };
    if (normalized.kind === 'import') return {
      ...normalized, from: input.path, assurance: normalized.assurance ?? extractor.assurance,
      generated, extractor
    };
    if (normalized.kind === 'module' || normalized.kind === 'diagnostic') return {
      ...normalized, path: input.path, assurance: normalized.assurance ?? extractor.assurance,
      generated, extractor
    };
    return {
      ...normalized, from: input.path, assurance: normalized.assurance ?? extractor.assurance,
      generated, extractor
    };
  });
}

function uniqueExtractors(facts) {
  return [...new Map(facts.flatMap((fact) => [fact.extractor, ...(fact.extractors ?? [])])
    .filter(Boolean).map((extractor) => [recordSha256(extractor), structuredClone(extractor)])).values()]
    .sort((left, right) => recordSha256(left).localeCompare(recordSha256(right)));
}

function replayPredicates(facts, predicates = [], envelopeAssurance = 'text') {
  return predicates.map((predicate) => {
    const configuredAssurance = predicate.minimumAssurance ?? 'text';
    const minimumByType = {
      'symbol-exists': 'syntax', 'import-boundary': 'syntax', 'annotation-present': 'syntax',
      'inherits-from': 'syntax', 'conforms-to': 'semantic', 'override-exists': 'semantic',
      'public-signature-changed': 'syntax', 'module-dependency': 'semantic'
    };
    const floor = minimumByType[predicate.type] ?? 'text';
    const requiredAssurance = assuranceSatisfies(configuredAssurance, floor) ? configuredAssurance : floor;
    const isRichPredicate = !['path-exists', 'symbol-exists'].includes(predicate.type);
    const selectedLanguages = new Set(facts.filter((fact) => fact.kind === 'file').map((fact) => fact.language));
    const profiles = new Set(facts.flatMap((fact) => [fact.extractor, ...(fact.extractors ?? [])])
      .map((extractor) => extractor?.derivation?.profile).filter(Boolean));
    const languageApplicable = !isRichPredicate || predicate.languages.includes('*')
      || predicate.languages.some((language) => selectedLanguages.has(language));
    const profileApplicable = !isRichPredicate || predicate.profiles.includes('*')
      || predicate.profiles.some((profile) => profiles.has(profile));
    const symbolMatches = (fact, value) => fact.kind === 'symbol'
      && [fact.id, fact.name, fact.qualifiedName].includes(value);
    const v2Eligible = (fact) => !isRichPredicate || ![fact.extractor, ...(fact.extractors ?? [])]
      .some((extractor) => extractor?.legacyProtocol === 1);
    const targetMatches = (actual, expected) => actual === expected
      || String(actual).endsWith(`.${expected}`) || String(actual).startsWith(`${expected}.`);
    const symbols = facts.filter((fact) => symbolMatches(fact, predicate.symbol));
    const symbolIds = new Set(symbols.flatMap((fact) => [fact.id, fact.name, fact.qualifiedName]).filter(Boolean));
    let matching = [];
    let negativeConstraint = false;
    let observedSha256 = null;
    if (predicate.type === 'path-exists') matching = facts.filter((fact) => fact.kind === 'file' && fact.path === predicate.path);
    else if (predicate.type === 'symbol-exists') matching = symbols;
    else if (predicate.type === 'annotation-present') matching = symbols.filter((fact) => fact.annotations?.includes(predicate.annotation));
    else if (predicate.type === 'inherits-from') matching = facts.filter((fact) => fact.kind === 'relationship'
      && fact.type === 'extends' && symbolIds.has(fact.sourceId) && targetMatches(fact.target, predicate.target));
    else if (predicate.type === 'conforms-to') matching = facts.filter((fact) => fact.kind === 'relationship'
      && ['implements', 'conforms-to'].includes(fact.type) && symbolIds.has(fact.sourceId) && targetMatches(fact.target, predicate.target));
    else if (predicate.type === 'override-exists') matching = facts.filter((fact) => fact.kind === 'relationship'
      && fact.type === 'overrides' && symbolIds.has(fact.sourceId) && targetMatches(fact.target, predicate.target));
    else if (predicate.type === 'module-dependency') matching = facts.filter((fact) => fact.kind === 'relationship'
      && fact.type === 'imports' && fact.sourceId === predicate.module && targetMatches(fact.target, predicate.target));
    else if (predicate.type === 'import-boundary') {
      negativeConstraint = true;
      matching = facts.filter((fact) => fact.kind === 'import'
        && String(fact.from ?? fact.path ?? '').startsWith(predicate.path)
        && targetMatches(fact.target, predicate.target));
    } else if (predicate.type === 'public-signature-changed') {
      const publicSymbols = facts.filter((fact) => fact.kind === 'symbol'
        && String(fact.path ?? '').startsWith(predicate.path)
        && (['public', 'open'].includes(fact.visibility)
          || (fact.extractor?.derivation?.language === 'python' && !fact.name.startsWith('_'))));
      observedSha256 = recordSha256(publicSymbols.map((fact) => ({
        id: fact.id, qualifiedName: fact.qualifiedName, signature: fact.signature, path: fact.path
      })).sort((left, right) => `${left.path}\0${left.id}`.localeCompare(`${right.path}\0${right.id}`)));
      matching = observedSha256 !== predicate.expectedSha256 ? publicSymbols : [];
    }
    matching = matching.filter(v2Eligible);
    let outcome = 'unknown';
    const adequate = matching.some((fact) => assuranceSatisfies(fact.assurance ?? 'text', requiredAssurance));
    if (!languageApplicable || !profileApplicable) outcome = 'unknown';
    else if (negativeConstraint && assuranceSatisfies(envelopeAssurance, requiredAssurance)) outcome = matching.length ? 'fail' : 'pass';
    else if (predicate.type === 'public-signature-changed' && assuranceSatisfies(envelopeAssurance, requiredAssurance)) {
      outcome = observedSha256 !== predicate.expectedSha256 ? 'pass' : 'fail';
    } else if (adequate) outcome = 'pass';
    else if (!matching.length && assuranceSatisfies(envelopeAssurance, requiredAssurance)) outcome = 'fail';
    const { id: _id, mode: _mode, minimumAssurance: _minimum, ...inputs } = predicate;
    return {
      id: predicate.id, mode: predicate.mode, requiredAssurance, outcome,
      applicable: languageApplicable && profileApplicable,
      inputs,
      ...(observedSha256 ? { observedSha256 } : {}),
      extractors: uniqueExtractors(matching.length ? matching : facts)
    };
  });
}

/** Recreate the broker's deterministic fact ordering from retained source bytes and overlays. */
export function replayBuiltInFacts(files, manifest, overlays = []) {
  const polyglot = manifest.adapters?.find((entry) => entry.id === 'sflow-polyglot-syntax') ?? null;
  const polyglotLanguages = new Set(['java', 'python', 'kotlin', 'swift']);
  const byPath = new Map();
  for (const entry of overlays) {
    const current = byPath.get(entry.path) ?? [];
    current.push(entry); byPath.set(entry.path, current);
  }
  return files.flatMap((file) => [
    ...materializeFileFacts(file.input, file.bytes),
    ...(polyglot && polyglotLanguages.has(file.input.language)
      ? materializePolyglotFacts(file.input, file.bytes, polyglot)
      : []),
    ...(byPath.get(file.input.path) ?? []).flatMap((entry) => materializeAdapterFacts(file.input, entry.facts, entry.extractor))
  ]);
}

/** The retained, self-contained deterministic computation invoked by the broker during replay. */
export function replayBuiltInDerivation(files, manifest, overlays = []) {
  const polyglot = manifest.adapters?.find((entry) => entry.id === 'sflow-polyglot-syntax') ?? null;
  const polyglotLanguages = new Set(['java', 'python', 'kotlin', 'swift']);
  const facts = replayBuiltInFacts(files, manifest, overlays);
  const semanticPaths = new Set(overlays.filter((entry) => entry.extractor?.assurance === 'semantic').map((entry) => entry.path));
  const envelopeAssurance = files.length && files.every((file) => polyglot && polyglotLanguages.has(file.input.language))
    ? files.every((file) => semanticPaths.has(file.input.path)) ? 'semantic' : polyglot.assurance ?? 'text'
    : 'text';
  const predicates = manifest.subject.operation === 'gate'
    ? replayPredicates(facts, manifest.replayRecipe.predicates ?? [], envelopeAssurance)
    : null;
  const selected = applySelectionPriority(facts, manifest.replayRecipe?.priority ?? null);
  const page = manifest.outputs.page
    ? selected.slice(manifest.outputs.page.offset, manifest.outputs.page.offset + manifest.outputs.page.returned)
    : null;
  return {
    factsSha256: recordSha256(facts),
    extractorFactSets: [...new Set(facts.map((fact) => fact.extractor?.id ?? 'unknown'))].sort().map((id) => {
      const selected = facts.filter((fact) => (fact.extractor?.id ?? 'unknown') === id);
      return { id, count: selected.length, factsSha256: recordSha256(selected) };
    }),
    predicateResultsSha256: predicates ? recordSha256(predicates) : null,
    pageFactsSha256: page ? recordSha256(page) : null
  };
}
