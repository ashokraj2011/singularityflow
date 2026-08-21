import { createHash } from 'node:crypto';

export const POLYGLOT_SYNTAX_PACK = Object.freeze({
  id: 'sflow-polyglot-syntax',
  packVersion: '1.0.0',
  extractorVersion: '1.0.0',
  parserEngine: 'sflow-structural-parser',
  parserVersion: '1.0.0',
  languages: Object.freeze({
    java: Object.freeze({ grammarId: 'sflow-java-structural', grammarVersion: '1.0.0' }),
    python: Object.freeze({ grammarId: 'sflow-python-structural', grammarVersion: '1.0.0' }),
    kotlin: Object.freeze({ grammarId: 'sflow-kotlin-structural', grammarVersion: '1.0.0' }),
    swift: Object.freeze({ grammarId: 'sflow-swift-structural', grammarVersion: '1.0.0' })
  })
});

const RELATIONSHIPS = new Set(['contains', 'extends', 'implements', 'conforms-to', 'annotated-by', 'imports', 'exports']);
const VISIBILITY = new Set(['public', 'private', 'protected', 'internal', 'open', 'fileprivate']);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function maskSourceLines(lines, language) {
  let blockDepth = 0;
  let tripleQuote = null;
  const nestedBlockComments = language === 'kotlin' || language === 'swift';
  return lines.map((line) => {
    const output = [...line];
    let quote = null; let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const pair = line.slice(index, index + 2);
      const triple = line.slice(index, index + 3);
      if (tripleQuote) {
        output[index] = ' ';
        if (triple === tripleQuote) {
          output[index + 1] = ' '; output[index + 2] = ' ';
          index += 2; tripleQuote = null;
        }
        continue;
      }
      if (blockDepth > 0) {
        output[index] = ' ';
        if (nestedBlockComments && pair === '/*') {
          output[index + 1] = ' '; blockDepth += 1; index += 1;
        } else if (pair === '*/') {
          output[index + 1] = ' '; blockDepth -= 1; index += 1;
        }
        continue;
      }
      if (escaped) { output[index] = ' '; escaped = false; continue; }
      if (quote) {
        output[index] = ' ';
        if (line[index] === '\\') escaped = true;
        else if (line[index] === quote) quote = null;
        continue;
      }
      if (language === 'python' && (triple === '\"\"\"' || triple === "'''")) {
        output[index] = ' '; output[index + 1] = ' '; output[index + 2] = ' ';
        tripleQuote = triple; index += 2; continue;
      }
      if (pair === '/*' && language !== 'python') {
        output[index] = ' '; output[index + 1] = ' '; blockDepth = 1; index += 1; continue;
      }
      if ((pair === '//' && language !== 'python') || (line[index] === '#' && language === 'python')) {
        for (let rest = index; rest < output.length; rest += 1) output[rest] = ' ';
        break;
      }
      if (line[index] === '"' || line[index] === "'") { quote = line[index]; output[index] = ' '; }
    }
    return output.join('');
  });
}

function normalizedSignature(line) {
  const declaration = String(line).trim().replace(/\s+/g, ' ')
    .replace(/\s*\{.*$/, '').replace(/\s*=>.*$/, '').replace(/\s*=\s*.+$/, ' = <literal>')
    .replace(/(['"])(?:\\.|(?!\1).)*\1/g, '<literal>');
  return declaration.slice(0, 500);
}

function spanFor(lineNumber, raw, matchIndex = 0, matchLength = 1) {
  const startColumn = Math.max(1, matchIndex + 1);
  return {
    startLine: lineNumber, startColumn,
    endLine: lineNumber, endColumn: Math.max(startColumn, Math.min(raw.length + 1, startColumn + Math.max(1, matchLength)))
  };
}

function visibilityAndModifiers(prefix) {
  const words = String(prefix).trim().split(/\s+/).filter(Boolean);
  const visibility = words.find((word) => VISIBILITY.has(word)) ?? 'default';
  return { visibility, modifiers: [...new Set(words.filter((word) => word !== visibility))].sort() };
}

function symbolId(language, qualifiedName, declarationKind, signature, occurrence) {
  const discriminator = digest(`${language}\0${qualifiedName}\0${declarationKind}\0${signature}\0${occurrence}`).slice(0, 12);
  return `${language}:${qualifiedName}#${declarationKind}:${discriminator}`;
}

function createSymbol({ language, name, qualifiedName, declarationKind, signature, containerId = null,
  prefix = '', annotations = [], lineNumber, raw, matchIndex = 0, occurrence = 0 }) {
  const normalized = normalizedSignature(signature || raw);
  const access = visibilityAndModifiers(prefix);
  return {
    kind: 'symbol',
    id: symbolId(language, qualifiedName, declarationKind, normalized, occurrence),
    name, qualifiedName, declarationKind, signature: normalized,
    containerId, visibility: access.visibility, modifiers: access.modifiers,
    annotations: [...new Set(annotations)].sort(),
    span: spanFor(lineNumber, raw, matchIndex, name.length), line: lineNumber,
    assurance: 'syntax'
  };
}

function importFact(target, lineNumber, raw, { names = [], aliases = [], importKind = 'module' } = {}) {
  return {
    kind: 'import', target, importedNames: [...new Set(names)].sort(), aliases: [...new Set(aliases)].sort(),
    importKind, span: spanFor(lineNumber, raw, Math.max(0, raw.indexOf(target)), target.length), assurance: 'syntax'
  };
}

function relationship(sourceId, type, target, lineNumber, raw) {
  if (!RELATIONSHIPS.has(type)) return null;
  return {
    kind: 'relationship', sourceId, type, target,
    span: spanFor(lineNumber, raw, 0, raw.trim().length), assurance: 'syntax'
  };
}

function moduleFact(id, name, lineNumber, raw) {
  return { kind: 'module', id, name, span: spanFor(lineNumber, raw, Math.max(0, raw.indexOf(name)), name.length), assurance: 'syntax' };
}

function annotationsFrom(line, language) {
  if (language === 'swift') return [...line.matchAll(/@([A-Za-z_][\w.]*)/g)].map((match) => match[1]);
  return [...line.matchAll(/@([A-Za-z_][\w.]*)/g)].map((match) => match[1]);
}

function balancedDiagnostics(lines, language) {
  let braces = 0; let parentheses = 0; let brackets = 0;
  for (const raw of lines) {
    const line = raw;
    braces += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    parentheses += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    brackets += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
  }
  const diagnostics = [];
  if (language !== 'python' && braces !== 0) diagnostics.push({ code: 'AST_SYNTAX_UNBALANCED_BRACES' });
  if (parentheses !== 0) diagnostics.push({ code: 'AST_SYNTAX_UNBALANCED_PARENTHESES' });
  if (brackets !== 0) diagnostics.push({ code: 'AST_SYNTAX_UNBALANCED_BRACKETS' });
  if (language === 'python' && lines.some((line) => /^\s*(?:async\s+def|def|class)\b/.test(line) && !line.includes(':'))) {
    diagnostics.push({ code: 'AST_SYNTAX_EXPECTED_COLON' });
  }
  return diagnostics;
}

function javaFacts(lines, parsedLines) {
  const facts = []; let packageName = ''; let pendingAnnotations = []; const containers = []; const occurrences = new Map();
  const nextOccurrence = (key) => { const value = occurrences.get(key) ?? 0; occurrences.set(key, value + 1); return value; };
  for (let offset = 0; offset < lines.length; offset += 1) {
    const raw = lines[offset]; const lineNumber = offset + 1; const line = parsedLines[offset].trim();
    if (!line) continue;
    const packageMatch = /^package\s+([\w.]+)\s*;/.exec(line);
    if (packageMatch) { packageName = packageMatch[1]; facts.push(moduleFact(`java:${packageName}`, packageName, lineNumber, raw)); continue; }
    const importMatch = /^import\s+(static\s+)?([\w.*]+)\s*;/.exec(line);
    if (importMatch) { facts.push(importFact(importMatch[2], lineNumber, raw, { importKind: importMatch[1] ? 'static' : 'module' })); continue; }
    const annotations = annotationsFrom(line, 'java');
    if (/^(?:@[\w.]+(?:\([^)]*\))?\s*)+$/.test(line)) { pendingAnnotations.push(...annotations); continue; }
    const declarationLine = line.replace(/^(?:@[\w.]+(?:\([^)]*\))?\s*)+/, '');
    const type = /^(?<prefix>(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*)?(?<kind>class|interface|enum|record|@interface)\s+(?<name>[\p{L}_$][\p{L}\p{N}_$]*)(?<tail>[^\{;]*)/u.exec(declarationLine);
    if (type?.groups) {
      const parent = containers.at(-1) ?? null;
      const qualified = [packageName, ...containers.map((item) => item.name), type.groups.name].filter(Boolean).join('.');
      const symbol = createSymbol({ language: 'java', name: type.groups.name, qualifiedName: qualified,
        declarationKind: type.groups.kind === '@interface' ? 'annotation' : type.groups.kind,
        signature: line, containerId: parent?.id ?? null, prefix: type.groups.prefix,
        annotations: [...pendingAnnotations, ...annotations], lineNumber, raw,
        matchIndex: raw.indexOf(type.groups.name), occurrence: nextOccurrence(qualified) });
      facts.push(symbol); if (parent) facts.push(relationship(parent.id, 'contains', symbol.id, lineNumber, raw));
      const extension = /\bextends\s+([\w.$]+)/.exec(type.groups.tail);
      if (extension) facts.push(relationship(symbol.id, 'extends', extension[1], lineNumber, raw));
      const implementation = /\bimplements\s+([^\{]+)/.exec(type.groups.tail);
      for (const target of implementation?.[1]?.split(',').map((item) => item.trim().split(/\s/)[0]).filter(Boolean) ?? []) {
        facts.push(relationship(symbol.id, 'implements', target, lineNumber, raw));
      }
      containers.push({ id: symbol.id, name: type.groups.name, depth: (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length });
      pendingAnnotations = [];
      continue;
    }
    const method = /^(?<prefix>(?:(?:public|protected|private|abstract|final|static|synchronized|native|default|strictfp)\s+)*)(?:<[^>]+>\s*)?(?<return>[\p{L}\p{N}_.$<>?,\[\]\s]+?)\s+(?<name>[\p{L}_$][\p{L}\p{N}_$]*)\s*\((?<params>[^)]*)\)/u.exec(declarationLine);
    if (method && containers.length && !/^(if|for|while|switch|catch)$/.test(method.groups.name)) {
      const container = containers.at(-1); const qualified = `${packageName ? `${packageName}.` : ''}${containers.map((item) => item.name).join('.')}.${method.groups.name}`;
      const symbol = createSymbol({ language: 'java', name: method.groups.name, qualifiedName: qualified,
        declarationKind: method.groups.name === container.name ? 'constructor' : 'method', signature: line,
        containerId: container.id, prefix: method.groups.prefix, annotations: [...pendingAnnotations, ...annotations],
        lineNumber, raw, matchIndex: raw.indexOf(method.groups.name), occurrence: nextOccurrence(qualified) });
      facts.push(symbol, relationship(container.id, 'contains', symbol.id, lineNumber, raw)); pendingAnnotations = [];
    }
    const delta = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (containers.length) {
      containers[containers.length - 1].depth += delta;
      while (containers.length && containers.at(-1).depth <= 0) containers.pop();
    }
  }
  return facts.filter(Boolean);
}

function pythonFacts(lines, parsedLines) {
  const facts = []; const containers = []; let pendingDecorators = []; const occurrences = new Map();
  const nextOccurrence = (key) => { const value = occurrences.get(key) ?? 0; occurrences.set(key, value + 1); return value; };
  for (let offset = 0; offset < lines.length; offset += 1) {
    const raw = lines[offset]; const lineNumber = offset + 1; const cleaned = parsedLines[offset]; const line = cleaned.trim();
    if (!line) continue;
    const indent = raw.match(/^\s*/)?.[0].replace(/\t/g, '    ').length ?? 0;
    while (containers.length && indent <= containers.at(-1).indent) containers.pop();
    if (line.startsWith('@')) { pendingDecorators.push(...annotationsFrom(line, 'python')); continue; }
    const fromImport = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
    if (fromImport) {
      const parts = fromImport[2].split(',').map((item) => item.trim()).filter(Boolean);
      facts.push(importFact(fromImport[1], lineNumber, raw, {
        names: parts.map((item) => item.split(/\s+as\s+/)[0]), aliases: parts.map((item) => item.split(/\s+as\s+/)[1]).filter(Boolean), importKind: 'from'
      })); continue;
    }
    const directImport = /^import\s+(.+)$/.exec(line);
    if (directImport) {
      for (const item of directImport[1].split(',').map((value) => value.trim())) {
        const [target, alias] = item.split(/\s+as\s+/); facts.push(importFact(target, lineNumber, raw, { aliases: alias ? [alias] : [] }));
      }
      continue;
    }
    const declaration = /^(?<async>async\s+)?(?<kind>class|def)\s+(?<name>[\p{L}_][\p{L}\p{N}_]*)(?<tail>[^:]*)\s*:/u.exec(line);
    if (!declaration?.groups) { pendingDecorators = []; continue; }
    const qualified = [...containers.map((item) => item.name), declaration.groups.name].join('.');
    const parent = containers.at(-1) ?? null;
    const symbol = createSymbol({ language: 'python', name: declaration.groups.name, qualifiedName: qualified,
      declarationKind: declaration.groups.kind === 'class' ? 'class' : parent ? 'method' : declaration.groups.async ? 'async-function' : 'function',
      signature: line, containerId: parent?.id ?? null, prefix: declaration.groups.async ?? '', annotations: pendingDecorators,
      lineNumber, raw, matchIndex: raw.indexOf(declaration.groups.name), occurrence: nextOccurrence(qualified) });
    facts.push(symbol); if (parent) facts.push(relationship(parent.id, 'contains', symbol.id, lineNumber, raw));
    if (declaration.groups.kind === 'class') {
      const bases = /^\(([^)]*)\)/.exec(declaration.groups.tail.trim())?.[1]?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
      for (const base of bases) facts.push(relationship(symbol.id, 'extends', base, lineNumber, raw));
    }
    containers.push({ id: symbol.id, name: declaration.groups.name, indent }); pendingDecorators = [];
  }
  return facts.filter(Boolean);
}

function kotlinFacts(lines, parsedLines) {
  const facts = []; let packageName = ''; let pendingAnnotations = []; const containers = []; const occurrences = new Map();
  const nextOccurrence = (key) => { const value = occurrences.get(key) ?? 0; occurrences.set(key, value + 1); return value; };
  for (let offset = 0; offset < lines.length; offset += 1) {
    const raw = lines[offset]; const lineNumber = offset + 1; const line = parsedLines[offset].trim();
    if (!line) continue;
    const packageMatch = /^package\s+([\w.]+)/.exec(line);
    if (packageMatch) { packageName = packageMatch[1]; facts.push(moduleFact(`kotlin:${packageName}`, packageName, lineNumber, raw)); continue; }
    const importMatch = /^import\s+([\w.*]+)(?:\s+as\s+(\w+))?/.exec(line);
    if (importMatch) { facts.push(importFact(importMatch[1], lineNumber, raw, { aliases: importMatch[2] ? [importMatch[2]] : [] })); continue; }
    const annotations = annotationsFrom(line, 'kotlin');
    if (/^(?:@[\w.]+(?:\([^)]*\))?\s*)+$/.test(line)) { pendingAnnotations.push(...annotations); continue; }
    const declarationLine = line.replace(/^(?:@[\w.]+(?:\([^)]*\))?\s*)+/, '');
    const type = /^(?<prefix>(?:(?:public|private|protected|internal|open|abstract|final|sealed|data|value|enum|annotation|expect|actual|inner)\s+)*)(?<kind>class|interface|object)\s+(?<name>[\p{L}_][\p{L}\p{N}_]*)(?<tail>[^\{]*)/u.exec(declarationLine);
    if (type?.groups) {
      const parent = containers.at(-1) ?? null; const qualified = [packageName, ...containers.map((item) => item.name), type.groups.name].filter(Boolean).join('.');
      const modifiers = type.groups.prefix.trim();
      const symbol = createSymbol({ language: 'kotlin', name: type.groups.name, qualifiedName: qualified,
        declarationKind: modifiers.includes('data') ? 'data-class' : modifiers.includes('value') ? 'value-class' : modifiers.includes('sealed') ? 'sealed-class' : type.groups.kind,
        signature: line, containerId: parent?.id ?? null, prefix: type.groups.prefix, annotations: [...pendingAnnotations, ...annotations],
        lineNumber, raw, matchIndex: raw.indexOf(type.groups.name), occurrence: nextOccurrence(qualified) });
      facts.push(symbol); if (parent) facts.push(relationship(parent.id, 'contains', symbol.id, lineNumber, raw));
      const inherited = /:\s*([^\{]+)/.exec(type.groups.tail)?.[1]?.split(',').map((item) => item.trim().split(/[<(]/)[0]).filter(Boolean) ?? [];
      for (const target of inherited) facts.push(relationship(symbol.id, 'conforms-to', target, lineNumber, raw));
      containers.push({ id: symbol.id, name: type.groups.name, depth: (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length || 1 }); pendingAnnotations = [];
      continue;
    }
    const callable = /^(?<prefix>(?:(?:public|private|protected|internal|open|abstract|final|override|operator|infix|inline|tailrec|suspend|external|expect|actual)\s+)*)fun\s+(?:(?<receiver>[\p{L}\p{N}_?.<>]+)\.)?(?<name>[\p{L}_][\p{L}\p{N}_]*)\s*\(/u.exec(declarationLine);
    if (callable?.groups) {
      const parent = containers.at(-1) ?? null; const qualified = [packageName, ...containers.map((item) => item.name), callable.groups.name].filter(Boolean).join('.');
      const symbol = createSymbol({ language: 'kotlin', name: callable.groups.name, qualifiedName: qualified,
        declarationKind: callable.groups.receiver ? 'extension-function' : parent ? 'method' : 'function', signature: line,
        containerId: parent?.id ?? null, prefix: callable.groups.prefix, annotations: [...pendingAnnotations, ...annotations],
        lineNumber, raw, matchIndex: raw.indexOf(callable.groups.name), occurrence: nextOccurrence(qualified) });
      facts.push(symbol); if (parent) facts.push(relationship(parent.id, 'contains', symbol.id, lineNumber, raw)); pendingAnnotations = [];
    }
    const delta = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (containers.length) { containers.at(-1).depth += delta; while (containers.length && containers.at(-1).depth <= 0) containers.pop(); }
  }
  return facts.filter(Boolean);
}

function swiftFacts(lines, parsedLines) {
  const facts = []; let pendingAttributes = []; const containers = []; const occurrences = new Map();
  const nextOccurrence = (key) => { const value = occurrences.get(key) ?? 0; occurrences.set(key, value + 1); return value; };
  for (let offset = 0; offset < lines.length; offset += 1) {
    const raw = lines[offset]; const lineNumber = offset + 1; const line = parsedLines[offset].trim();
    if (!line) continue;
    const importMatch = /^import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?([\w.]+)/.exec(line);
    if (importMatch) { facts.push(importFact(importMatch[1], lineNumber, raw)); continue; }
    const attributes = annotationsFrom(line, 'swift');
    if (/^(?:@[\w.]+(?:\([^)]*\))?\s*)+$/.test(line)) { pendingAttributes.push(...attributes); continue; }
    const declarationLine = line.replace(/^(?:@[\w.]+(?:\([^)]*\))?\s*)+/, '');
    const type = /^(?<prefix>(?:(?:public|private|fileprivate|internal|open|final|indirect|nonisolated)\s+)*)(?<kind>class|struct|actor|enum|protocol|extension)\s+(?<name>[\p{L}_][\p{L}\p{N}_]*)(?<tail>[^\{]*)/u.exec(declarationLine);
    if (type?.groups) {
      const parent = containers.at(-1) ?? null; const qualified = [...containers.map((item) => item.name), type.groups.name].join('.');
      const symbol = createSymbol({ language: 'swift', name: type.groups.name, qualifiedName: qualified,
        declarationKind: type.groups.kind, signature: line, containerId: parent?.id ?? null, prefix: type.groups.prefix,
        annotations: [...pendingAttributes, ...attributes], lineNumber, raw, matchIndex: raw.indexOf(type.groups.name), occurrence: nextOccurrence(qualified) });
      facts.push(symbol); if (parent) facts.push(relationship(parent.id, 'contains', symbol.id, lineNumber, raw));
      const inherited = /:\s*([^\{]+)/.exec(type.groups.tail)?.[1]?.split(',').map((item) => item.trim().split(/[<(]/)[0]).filter(Boolean) ?? [];
      for (const target of inherited) facts.push(relationship(symbol.id, 'conforms-to', target, lineNumber, raw));
      containers.push({ id: symbol.id, name: type.groups.name, depth: (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length || 1 }); pendingAttributes = [];
      continue;
    }
    const callable = /^(?<prefix>(?:(?:public|private|fileprivate|internal|open|final|static|class|mutating|nonmutating|override|required|convenience|distributed|nonisolated)\s+)*)(?<kind>func|init)\s*(?<name>[\p{L}_][\p{L}\p{N}_]*)?\s*\(/u.exec(declarationLine);
    if (callable?.groups) {
      const parent = containers.at(-1) ?? null; const name = callable.groups.kind === 'init' ? 'init' : callable.groups.name;
      const qualified = [...containers.map((item) => item.name), name].join('.');
      const symbol = createSymbol({ language: 'swift', name, qualifiedName: qualified, declarationKind: callable.groups.kind === 'init' ? 'initializer' : parent ? 'method' : 'function',
        signature: line, containerId: parent?.id ?? null, prefix: callable.groups.prefix, annotations: [...pendingAttributes, ...attributes],
        lineNumber, raw, matchIndex: raw.indexOf(name), occurrence: nextOccurrence(qualified) });
      facts.push(symbol); if (parent) facts.push(relationship(parent.id, 'contains', symbol.id, lineNumber, raw)); pendingAttributes = [];
    }
    const delta = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (containers.length) { containers.at(-1).depth += delta; while (containers.length && containers.at(-1).depth <= 0) containers.pop(); }
  }
  return facts.filter(Boolean);
}

/** Parse declarations only. Source bodies and doc text never cross this return boundary. */
export function extractPolyglotSyntax(bytes, language) {
  const source = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : Buffer.from(bytes).toString('utf8');
  const lines = source.split(/\r?\n/);
  const parsedLines = maskSourceLines(lines, language);
  let facts;
  if (language === 'java') facts = javaFacts(lines, parsedLines);
  else if (language === 'python') facts = pythonFacts(lines, parsedLines);
  else if (language === 'kotlin') facts = kotlinFacts(lines, parsedLines);
  else if (language === 'swift') facts = swiftFacts(lines, parsedLines);
  else facts = [];
  return { facts, diagnostics: balancedDiagnostics(parsedLines, language) };
}
