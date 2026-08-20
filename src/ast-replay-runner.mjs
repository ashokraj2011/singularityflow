import { createHash } from 'node:crypto';

import { BUILTIN_AST_EXTRACTOR, extractBuiltinAstFacts } from './ast-builtin-extractor.mjs';

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
          kind: 'symbol', name: fact.name, declarationKind: fact.declarationKind,
          at: `${input.path}:${fact.line}`, assurance: fact.assurance, generated, extractor
        }
      : { kind: 'import', from: input.path, target: fact.target, assurance: fact.assurance, generated, extractor })
  ];
}

function replayPredicates(facts, predicates = []) {
  return predicates.map((predicate) => {
    const configuredAssurance = predicate.minimumAssurance ?? 'text';
    const requiredAssurance = predicate.mode === 'required' && predicate.type === 'symbol-exists'
      && !assuranceSatisfies(configuredAssurance, 'syntax') ? 'syntax' : configuredAssurance;
    const matching = predicate.type === 'path-exists'
      ? facts.filter((fact) => fact.kind === 'file' && fact.path === predicate.path)
      : facts.filter((fact) => fact.kind === 'symbol' && fact.name === predicate.symbol);
    let outcome = 'unknown';
    if (matching.some((fact) => assuranceSatisfies(fact.assurance ?? 'text', requiredAssurance))) outcome = 'pass';
    else if (!matching.length && assuranceSatisfies('text', requiredAssurance)) outcome = 'fail';
    return {
      id: predicate.id, mode: predicate.mode, requiredAssurance, outcome,
      extractors: [structuredClone(BUILTIN_AST_EXTRACTOR)]
    };
  });
}

/** The retained, self-contained deterministic computation invoked by the broker during replay. */
export function replayBuiltInDerivation(files, manifest) {
  const facts = files.flatMap((file) => materializeFileFacts(file.input, file.bytes));
  const predicates = manifest.subject.operation === 'gate'
    ? replayPredicates(facts, manifest.replayRecipe.predicates ?? [])
    : null;
  const page = manifest.outputs.page
    ? facts.slice(manifest.outputs.page.offset, manifest.outputs.page.offset + manifest.outputs.page.returned)
    : null;
  return {
    factsSha256: recordSha256(facts),
    predicateResultsSha256: predicates ? recordSha256(predicates) : null,
    pageFactsSha256: page ? recordSha256(page) : null
  };
}
