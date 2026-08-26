import { lineNumbers } from './text-lines.mjs';

export const BUILTIN_AST_EXTRACTOR = Object.freeze({
  id: 'builtin-text', version: 1, assurance: 'text', protocolVersion: 2
});

const SYMBOL_LANGUAGES = new Set(['javascript', 'typescript']);

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
