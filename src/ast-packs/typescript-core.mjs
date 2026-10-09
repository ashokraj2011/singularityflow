/**
 * TypeScript and JavaScript structure from the TypeScript compiler itself.
 *
 * The syntax stage parses each file with the compiler's parser (no type information) and reports
 * declarations, imports and inheritance at syntax assurance. The semantic stage builds one
 * compiler Program for the requested files and asks the type checker which declaration each call
 * resolves to, so `cart.add()` names the `add` that runs, not every function called `add`.
 *
 * Both stages give a declaration the same stable identity (path, qualified name, kind), so a
 * semantic call edge joins the syntax skeleton without guessing. The compiler is Singularity
 * Flow's own dependency: nothing from the analyzed repository's node_modules is loaded or run.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

export const TYPESCRIPT_SYNTAX_PACK = Object.freeze({ id: 'sflow-typescript-syntax', packVersion: '1.0.0', extractorVersion: '1.0.0' });
export const TYPESCRIPT_SEMANTIC_PACK = Object.freeze({ id: 'sflow-typescript', packVersion: '1.0.0', extractorVersion: '1.0.0' });
export const TYPESCRIPT_LANGUAGES = Object.freeze({
  typescript: Object.freeze(['.ts', '.tsx']),
  javascript: Object.freeze(['.js', '.jsx', '.mjs', '.cjs'])
});

/**
 * Singularity Flow's own compiler; null when it is not installed. An adapter replayed from retained
 * evidence passes the retained compiler file; otherwise it resolves from this package's location.
 */
export function resolveTypeScript(compilerPath = null) {
  try {
    const require = createRequire(import.meta.url);
    const entry = compilerPath ?? require.resolve('typescript');
    return { entry, packageJson: path.join(path.dirname(entry), '..', 'package.json'), module: require(entry) };
  } catch {
    return null;
  }
}

const span = (sf, start, end) => {
  const from = sf.getLineAndCharacterOfPosition(start);
  const to = sf.getLineAndCharacterOfPosition(end);
  return { startLine: from.line + 1, startColumn: from.character + 1, endLine: to.line + 1, endColumn: Math.max(1, to.character + 1) };
};

function isFunctionLike(ts, node) {
  return node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/**
 * Walk a file's declarations once, in source order, calling `visit(node, record)` for each one
 * Singularity Flow models: callables (functions, methods, constructors, accessors, function-valued
 * variables and object-literal members) and containers (classes, interfaces, enums, type aliases).
 * Records carry the identity both stages share.
 */
export function declarations(ts, sf, relativePath) {
  const records = [];
  const byNode = new Map();
  const seen = new Map();
  const add = (node, nameNode, name, kind, container) => {
    const qualifiedName = container ? `${container.qualifiedName}.${name}` : name;
    const base = `ts:${relativePath}#${qualifiedName}:${kind}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const record = {
      id: count ? `${base}~${count + 1}` : base,
      node, name, qualifiedName, kind,
      containerId: container?.id ?? null,
      span: span(sf, node.getStart(sf), node.getEnd()),
      nameLine: sf.getLineAndCharacterOfPosition((nameNode ?? node).getStart(sf)).line + 1
    };
    records.push(record);
    byNode.set(node, record);
    return record;
  };
  const visit = (node, container) => {
    let next = container;
    if (ts.isFunctionDeclaration(node) && node.name && node.body) next = add(node, node.name, node.name.text, 'function', container);
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = node.name?.text ?? (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : null);
      if (name) next = add(node, node.name ?? node.parent.name, name, 'class', container);
    } else if (ts.isInterfaceDeclaration(node)) next = add(node, node.name, node.name.text, 'interface', container);
    else if (ts.isEnumDeclaration(node)) next = add(node, node.name, node.name.text, 'enum', container);
    else if (ts.isTypeAliasDeclaration(node)) next = add(node, node.name, node.name.text, 'type', container);
    else if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
        && node.body && node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isPrivateIdentifier(node.name))) {
      next = add(node, node.name, node.name.text, 'method', container);
    } else if (ts.isConstructorDeclaration(node) && node.body) next = add(node, node, 'constructor', 'constructor', container);
    else if (ts.isPropertyDeclaration(node) && isFunctionLike(ts, node.initializer) && node.name && ts.isIdentifier(node.name)) {
      next = add(node, node.name, node.name.text, 'method', container);
    } else if (ts.isPropertyAssignment(node) && isFunctionLike(ts, node.initializer) && ts.isIdentifier(node.name)) {
      next = add(node, node.name, node.name.text, 'method', container);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isFunctionLike(ts, node.initializer)) next = add(node, node.name, node.name.text, 'function', container);
      else if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        // `const api = { load() {} }`: its members are named through the variable.
        next = { id: null, qualifiedName: container ? `${container.qualifiedName}.${node.name.text}` : node.name.text };
      }
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(sf, null);
  return { records, byNode };
}

function scriptKind(ts, relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX
    : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/**
 * A declaration's header without its body: `function total(cart: Cart): number`, `class Cart
 * extends Base`, `type Price =`. Facts never carry source bodies.
 */
function signature(ts, sf, node) {
  const callable = node.body ? node : node.initializer;
  let end = callable?.body ? callable.body.getStart(sf)
    : node.members ? node.members.pos - 1
      : ts.isTypeAliasDeclaration(node) ? node.type.getStart(sf)
        : node.getEnd();
  if (end <= node.getStart(sf)) end = node.getEnd();
  return sf.text.slice(node.getStart(sf), end).replace(/\s+/gu, ' ').trim().slice(0, 300);
}

/** Syntax-stage facts for one file: declarations, imports and inheritance. */
export function syntaxFacts(ts, relativePath, text) {
  const sf = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, scriptKind(ts, relativePath));
  const { records } = declarations(ts, sf, relativePath);
  const facts = [];
  for (const record of records) {
    facts.push({
      kind: 'symbol', id: record.id, name: record.name, qualifiedName: record.qualifiedName,
      declarationKind: record.kind, signature: signature(ts, sf, record.node),
      containerId: record.containerId, span: record.span,
      visibility: ts.getCombinedModifierFlags(record.node) & ts.ModifierFlags.Export ? 'exported' : 'default',
      assurance: 'syntax'
    });
    if (record.containerId) facts.push({ kind: 'relationship', type: 'contains', sourceId: record.containerId, target: record.id, span: record.span, assurance: 'syntax' });
    const heritage = record.node.heritageClauses ?? [];
    for (const clause of heritage) {
      for (const type of clause.types) {
        facts.push({
          kind: 'relationship', type: clause.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends',
          sourceId: record.id, target: type.expression.getText(sf).slice(0, 200),
          span: span(sf, type.getStart(sf), type.getEnd()), assurance: 'syntax'
        });
      }
    }
  }
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const names = [];
    if (clause?.name) names.push(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) names.push((element.propertyName ?? element.name).text);
    }
    facts.push({
      kind: 'import', target: statement.moduleSpecifier.text, importedNames: names,
      importKind: clause?.isTypeOnly ? 'type' : 'module',
      span: span(sf, statement.getStart(sf), statement.getEnd()), assurance: 'syntax'
    });
  }
  return facts;
}

/** Compiler options: the project's own tsconfig/jsconfig when present, otherwise JavaScript-friendly defaults. */
export function programOptions(ts, root, projectRoot = '.') {
  const directory = path.resolve(root, projectRoot);
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(directory, name);
    if (!ts.sys.fileExists(file)) continue;
    const read = ts.readConfigFile(file, ts.sys.readFile);
    if (read.error) break;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, directory, undefined, file);
    return { ...parsed.options, noEmit: true, skipLibCheck: true, allowJs: parsed.options.allowJs ?? name === 'jsconfig.json', composite: false, incremental: false, tsBuildInfoFile: undefined };
  }
  return {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, resolveJsonModule: true, types: []
  };
}

/**
 * Semantic call edges for the requested files. Each edge names the innermost modeled declaration
 * the call is in (`sourceId`) and the declaration the checker resolves it to (`target`). Calls
 * into node_modules, declaration files or anywhere outside the repository are left out: they are
 * not part of the code being explained.
 */
export function semanticCalls(ts, root, relativePaths, { projectRoot = '.' } = {}) {
  const absoluteRoot = path.resolve(root);
  const program = ts.createProgram(relativePaths.map((relative) => path.resolve(root, relative)), programOptions(ts, root, projectRoot));
  const checker = program.getTypeChecker();
  const maps = new Map();
  const relativeOf = (fileName) => path.relative(absoluteRoot, path.resolve(fileName)).split(path.sep).join('/');
  const inRepository = (sf) => {
    if (!sf || sf.isDeclarationFile) return false;
    const relative = relativeOf(sf.fileName);
    return !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.split('/').includes('node_modules');
  };
  const mapFor = (sf) => {
    if (!maps.has(sf.fileName)) maps.set(sf.fileName, declarations(ts, sf, relativeOf(sf.fileName)).byNode);
    return maps.get(sf.fileName);
  };
  const targetOf = (expression) => {
    const location = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    let symbol = checker.getSymbolAtLocation(location);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      try { symbol = checker.getAliasedSymbol(symbol); } catch { /* keep the alias */ }
    }
    const candidates = symbol?.declarations ?? [];
    // An overloaded function resolves to its implementation, the declaration with a body.
    const ordered = [...candidates].sort((left, right) => Number(Boolean(right.body)) - Number(Boolean(left.body)));
    for (const declaration of ordered) {
      const sf = declaration.getSourceFile();
      if (!inRepository(sf)) return null;
      const record = mapFor(sf).get(declaration)
        // `new Cart()` resolves to the class; a call through a class property resolves to its member.
        ?? (ts.isClassDeclaration(declaration) ? [...mapFor(sf).values()].find((entry) => entry.node.parent === declaration && entry.kind === 'constructor') ?? mapFor(sf).get(declaration) : null);
      if (record) return record;
    }
    return null;
  };
  const files = [];
  for (const relative of relativePaths) {
    const sf = program.getSourceFile(path.resolve(root, relative));
    if (!sf) { files.push({ path: relative, facts: [], missing: true }); continue; }
    const byNode = mapFor(sf);
    const facts = [];
    const seen = new Set();
    const walk = (node, owner) => {
      const record = byNode.get(node);
      const current = record && ['function', 'method', 'constructor'].includes(record.kind) ? record : owner;
      if (current && (ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression) {
        const target = targetOf(node.expression);
        // One edge per caller and callee, at its first call: a call graph, not a list of call sites.
        const key = target && target.id !== current.id ? `${current.id}>${target.id}` : null;
        if (key && !seen.has(key)) {
          seen.add(key);
          facts.push({
            kind: 'relationship', type: 'calls', sourceId: current.id, target: target.id,
            span: span(sf, node.getStart(sf), node.getEnd()), assurance: 'semantic'
          });
        }
      }
      ts.forEachChild(node, (child) => walk(child, current));
    };
    walk(sf, null);
    files.push({ path: relative, facts });
  }
  return files;
}
