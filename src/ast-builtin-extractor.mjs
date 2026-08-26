export const BUILTIN_AST_EXTRACTOR = Object.freeze({
  id: 'builtin-text', version: 1, assurance: 'text', protocolVersion: 2
});

const SYMBOL_LANGUAGES = new Set(['javascript', 'typescript']);

/**
 * A copy of `text-lines.mjs`, and deliberately a copy.
 *
 * This module is bundled for evidence replay: `ast-evidence.mjs` declares the exact file set that is
 * hashed for engine identity and base64-copied into a replay bundle, and `ast-replay.mjs` checks the
 * restored bundle against a fixed expected set of the same size. Importing a shared helper here made
 * the extractor unloadable inside a replayed bundle — `ERR_MODULE_NOT_FOUND` on a file nothing had
 * been told to copy — and adding it to those three lists widens what every recorded piece of
 * evidence has to carry, to save an import of forty lines.
 *
 * So the sharing stops at the boundary of the replay bundle. Editing this file is fine; growing its
 * import graph is not, and that is the rule worth writing down rather than the duplication.
 */
function lineNumbers(text) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

function extractSymbols(text, relative) {
  const symbols = [];
  const lineAt = lineNumbers(text);
  const declaration = /^export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of text.matchAll(declaration)) {
    const [, keyword, name] = match;
    symbols.push({
      name,
      kind: keyword.startsWith('function') ? 'function' : keyword === 'class' ? 'class' : 'binding',
      at: `${relative}:${lineAt(match.index)}`
    });
  }
  return symbols;
}

function extractImports(text) {
  const targets = [];
  for (const match of text.matchAll(/^\s*(?:import|export)[\s\S]{0,200}?from\s*['"]([^'"]+)['"]/gm)) targets.push(match[1]);
  for (const match of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) targets.push(match[1]);
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) targets.push(match[1]);
  return [...new Set(targets)];
}

/**
 * Pure L0 extraction shared by live AST reads and cache-independent evidence replay.
 * Source bytes enter only this function and are never copied into a result or receipt.
 */
export function extractBuiltinAstFacts(bytes, language, filePath) {
  if (!SYMBOL_LANGUAGES.has(language)) return [];
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : Buffer.from(bytes).toString('utf8');
  const facts = [];
  for (const symbol of extractSymbols(text, filePath)) {
    facts.push({
      kind: 'symbol', name: symbol.name, declarationKind: symbol.kind,
      line: Number(symbol.at.slice(symbol.at.lastIndexOf(':') + 1)), assurance: 'text'
    });
  }
  for (const target of extractImports(text)) facts.push({ kind: 'import', target, assurance: 'text' });
  return facts;
}
