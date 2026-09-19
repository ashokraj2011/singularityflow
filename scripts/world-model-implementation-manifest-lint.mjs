import { builtinModules } from 'node:module';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.mts']);

function fail(message, code, details = {}) {
  const error = new TypeError(message);
  error.code = code;
  error.details = details;
  throw error;
}

function sourceLocation(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    path: sourceFile.fileName.replaceAll('\\', '/'),
    line: start.line + 1,
    column: start.character + 1
  };
}

function normalizePackagePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
      || value.includes('\\')) {
    fail(`${label} must be a non-empty POSIX package-relative path.`,
      'WMP_IMPLEMENTATION_SOURCE_PATH_INVALID', { path: value ?? null });
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../')
      || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    fail(`${label} is not a safe package-relative path.`,
      'WMP_IMPLEMENTATION_SOURCE_PATH_INVALID', { path: value });
  }
  return normalized;
}

function isBelow(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

function ordinarySourceFile(packageRoot, relative, context = {}) {
  const normalized = normalizePackagePath(relative, 'Implementation source path');
  const lexical = path.resolve(packageRoot, ...normalized.split('/'));
  if (!isBelow(packageRoot, lexical)) {
    fail(`Implementation source '${normalized}' escapes the package root.`,
      'WMP_IMPLEMENTATION_IMPORT_ESCAPE', { ...context, path: normalized });
  }

  let current = packageRoot;
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      fail(`Implementation import '${normalized}' does not resolve to a packaged source file.`,
        'WMP_IMPLEMENTATION_IMPORT_UNRESOLVED', {
          ...context, path: normalized, cause: error?.code ?? null
        });
    }
    if (stats.isSymbolicLink()) {
      fail(`Implementation source '${normalized}' traverses a symbolic link.`,
        'WMP_IMPLEMENTATION_SOURCE_SYMLINK_UNSAFE', { ...context, path: normalized });
    }
  }

  const stats = lstatSync(lexical);
  if (!stats.isFile()) {
    fail(`Implementation import '${normalized}' must resolve to an ordinary source file.`,
      'WMP_IMPLEMENTATION_IMPORT_UNRESOLVED', { ...context, path: normalized });
  }
  if (!SOURCE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    fail(`Implementation import '${normalized}' is not a supported ESM source file.`,
      'WMP_IMPLEMENTATION_SOURCE_TYPE_UNSUPPORTED', { ...context, path: normalized });
  }
  const canonical = realpathSync(lexical);
  if (!isBelow(packageRoot, canonical)) {
    fail(`Implementation source '${normalized}' resolves outside the package root.`,
      'WMP_IMPLEMENTATION_IMPORT_ESCAPE', { ...context, path: normalized });
  }
  return { absolute: lexical, relative: normalized };
}

function packageName(specifier, context) {
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    if (segments.length < 2 || !segments[0].slice(1) || !segments[1]) {
      fail(`Invalid package import '${specifier}'.`, 'WMP_IMPLEMENTATION_IMPORT_UNRESOLVED', context);
    }
    return `${segments[0]}/${segments[1]}`;
  }
  if (!segments[0]) {
    fail(`Invalid package import '${specifier}'.`, 'WMP_IMPLEMENTATION_IMPORT_UNRESOLVED', context);
  }
  return segments[0];
}

function literalModuleSpecifier(sourceFile, node, kind) {
  if (!node || (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node))) {
    fail(`${kind} must use a string-literal module specifier.`,
      'WMP_IMPLEMENTATION_DYNAMIC_IMPORT_NONLITERAL', sourceLocation(sourceFile, node ?? sourceFile));
  }
  return node.text;
}

function parseSource(absolute, relative) {
  const text = readFileSync(absolute, 'utf8');
  const extension = path.extname(relative).toLowerCase();
  const scriptKind = extension === '.ts' || extension === '.mts'
    ? ts.ScriptKind.TS
    : extension === '.tsx'
      ? ts.ScriptKind.TSX
      : extension === '.jsx'
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  if (diagnostics.length) {
    const diagnostic = diagnostics[0];
    const location = diagnostic.start === undefined
      ? { path: relative, line: null, column: null }
      : sourceLocation(sourceFile, { getStart: () => diagnostic.start });
    fail(`Implementation source '${relative}' cannot be parsed: ${ts.flattenDiagnosticMessageText(
      diagnostic.messageText, '\n')}`,
      'WMP_IMPLEMENTATION_SOURCE_PARSE_FAILED', location);
  }
  return sourceFile;
}

function moduleSpecifiers(sourceFile) {
  const imports = [];
  const namedCall = (expression, name) => (
    (ts.isIdentifier(expression) && expression.text === name)
    || (ts.isPropertyAccessExpression(expression)
      && ((ts.isIdentifier(expression.expression) && expression.expression.text === name)
        || expression.name.text === name))
    || (ts.isElementAccessExpression(expression)
      && ts.isStringLiteralLike(expression.argumentExpression)
      && expression.argumentExpression.text === name)
  );
  function add(node, specifier, kind) {
    imports.push({
      specifier: literalModuleSpecifier(sourceFile, specifier, kind),
      location: sourceLocation(sourceFile, node)
    });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) add(node, node.moduleSpecifier, 'Static import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!node.isTypeOnly) add(node, node.moduleSpecifier, 'Static export');
    } else if (ts.isImportEqualsDeclaration(node)) {
      fail('TypeScript import-equals/CommonJS loading is not allowed in a reviewed implementation.',
        'WMP_IMPLEMENTATION_COMMONJS_IMPORT_UNSUPPORTED', sourceLocation(sourceFile, node));
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length < 1) {
          fail('Dynamic import must contain a string-literal module specifier.',
            'WMP_IMPLEMENTATION_DYNAMIC_IMPORT_NONLITERAL', sourceLocation(sourceFile, node));
        }
        add(node, node.arguments[0], 'Dynamic import');
      } else if (namedCall(node.expression, 'require')) {
        fail('CommonJS require() is not allowed in a reviewed ESM implementation.',
          'WMP_IMPLEMENTATION_COMMONJS_IMPORT_UNSUPPORTED', sourceLocation(sourceFile, node));
      } else if (namedCall(node.expression, 'eval')) {
        fail('eval() is not allowed in a reviewed implementation.',
          'WMP_IMPLEMENTATION_EVAL_UNSUPPORTED', sourceLocation(sourceFile, node));
      } else if (namedCall(node.expression, 'createRequire')) {
        fail('createRequire() is not allowed in a reviewed ESM implementation.',
          'WMP_IMPLEMENTATION_CREATE_REQUIRE_UNSUPPORTED', sourceLocation(sourceFile, node));
      }
    }

    if (ts.isIdentifier(node) && ['createRequire', 'require', 'eval'].includes(node.text)) {
      const code = node.text === 'createRequire'
        ? 'WMP_IMPLEMENTATION_CREATE_REQUIRE_UNSUPPORTED'
        : node.text === 'require'
          ? 'WMP_IMPLEMENTATION_COMMONJS_IMPORT_UNSUPPORTED'
          : 'WMP_IMPLEMENTATION_EVAL_UNSUPPORTED';
      fail(`${node.text} is not allowed in a reviewed ESM implementation.`, code,
        sourceLocation(sourceFile, node));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

function resolveSpecifier(packageRoot, importer, imported) {
  const { specifier, location } = imported;
  if (specifier.includes('\\') || specifier.includes('\0')) {
    fail(`Implementation import '${specifier}' is not a portable ESM specifier.`,
      'WMP_IMPLEMENTATION_IMPORT_UNRESOLVED', { ...location, importer, specifier });
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (specifier.includes('?') || specifier.includes('#')) {
      fail(`Local implementation import '${specifier}' may not contain a query or fragment.`,
        'WMP_IMPLEMENTATION_IMPORT_UNRESOLVED', { ...location, specifier });
    }
    const lexical = path.resolve(packageRoot, path.dirname(importer), specifier);
    if (!isBelow(packageRoot, lexical)) {
      fail(`Implementation import '${specifier}' from '${importer}' escapes the package root.`,
        'WMP_IMPLEMENTATION_IMPORT_ESCAPE', { ...location, importer, specifier });
    }
    const relative = path.relative(packageRoot, lexical).split(path.sep).join('/');
    return {
      kind: 'local',
      value: ordinarySourceFile(packageRoot, relative, { ...location, importer, specifier }).relative
    };
  }
  if (specifier.startsWith('node:')) {
    const name = specifier.slice('node:'.length);
    if (!BUILTINS.has(name)) {
      fail(`Unknown Node.js builtin import '${specifier}'.`,
        'WMP_IMPLEMENTATION_IMPORT_UNRESOLVED', { ...location, importer, specifier });
    }
    return { kind: 'builtin', value: `node:${name}` };
  }
  if (BUILTINS.has(specifier)) {
    return { kind: 'builtin', value: `node:${specifier}` };
  }
  if (specifier.startsWith('/') || specifier.startsWith('file:') || specifier.startsWith('data:')
      || specifier.startsWith('http:') || specifier.startsWith('https:')
      || specifier.startsWith('#') || /^[a-zA-Z][a-zA-Z+.-]*:/.test(specifier)) {
    fail(`Unsupported implementation import '${specifier}'.`,
      'WMP_IMPLEMENTATION_IMPORT_UNRESOLVED', { ...location, importer, specifier });
  }
  return { kind: 'package', value: packageName(specifier, { ...location, importer, specifier }) };
}

function exactSortedStrings(values, label) {
  if (!Array.isArray(values)) {
    fail(`${label} must be an array.`, 'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID', { field: label });
  }
  const result = values.map((value) => {
    if (typeof value !== 'string' || !value) {
      fail(`${label} must contain only non-empty strings.`,
        'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID', { field: label });
    }
    return value;
  });
  if (new Set(result).size !== result.length) {
    fail(`${label} contains duplicate entries.`,
      'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID', { field: label });
  }
  return result.sort();
}

function modulePaths(manifest) {
  if (!Array.isArray(manifest?.modules)) {
    fail('Reviewed implementation manifest modules must be an array.',
      'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID', { field: 'modules' });
  }
  const paths = manifest.modules.map((module) => {
    if (!module || typeof module !== 'object' || Array.isArray(module)) {
      fail('Reviewed implementation manifest modules must be source descriptors.',
        'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID', { field: 'modules' });
    }
    return normalizePackagePath(module.path, 'Reviewed implementation module');
  });
  if (new Set(paths).size !== paths.length) {
    fail('Reviewed implementation manifest modules contain duplicate paths.',
      'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID', { field: 'modules' });
  }
  return paths.sort();
}

function compareExact(label, declared, discovered) {
  const missing = discovered.filter((value) => !declared.includes(value));
  const extra = declared.filter((value) => !discovered.includes(value));
  if (missing.length || extra.length) {
    fail(`Reviewed implementation ${label} do not match the discovered ESM closure.`,
      'WMP_IMPLEMENTATION_SOURCE_MANIFEST_MISMATCH', { field: label, missing, extra });
  }
}

/**
 * Discover the exact local ESM dependency closure reachable from reviewed entrypoints.
 *
 * This is intentionally build-time code: TypeScript is the parser of record, while packaged
 * runtime code consumes the already-reviewed manifest without taking a parser dependency.
 */
export function discoverImplementationSourceClosure({ packageRoot, entrypoints } = {}) {
  if (typeof packageRoot !== 'string' || !packageRoot) {
    fail('Implementation discovery requires a package root.',
      'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID', { field: 'packageRoot' });
  }
  let root;
  try {
    root = realpathSync(path.resolve(packageRoot));
  } catch (error) {
    fail('Implementation discovery package root is unavailable.',
      'WMP_IMPLEMENTATION_SOURCE_PATH_INVALID', { path: packageRoot, cause: error?.code ?? null });
  }
  const roots = exactSortedStrings(entrypoints, 'entrypoints')
    .map((entry) => normalizePackagePath(entry, 'Implementation entrypoint'));
  if (!roots.length) {
    fail('Implementation discovery requires at least one entrypoint.',
      'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID', { field: 'entrypoints' });
  }

  const pending = [...roots];
  const modules = new Set();
  const builtins = new Set();
  const packages = new Set();
  const localImports = new Map();
  while (pending.length) {
    const relative = pending.shift();
    if (modules.has(relative)) continue;
    const source = ordinarySourceFile(root, relative, { importer: null, specifier: relative });
    modules.add(source.relative);
    const dependencies = [];
    for (const imported of moduleSpecifiers(parseSource(source.absolute, source.relative))) {
      const resolved = resolveSpecifier(root, source.relative, imported);
      if (resolved.kind === 'local') {
        dependencies.push(resolved.value);
        if (!modules.has(resolved.value)) pending.push(resolved.value);
      } else if (resolved.kind === 'builtin') builtins.add(resolved.value);
      else packages.add(resolved.value);
    }
    localImports.set(source.relative, Object.freeze([...new Set(dependencies)].sort()));
  }

  return Object.freeze({
    entrypoints: Object.freeze([...roots]),
    modules: Object.freeze([...modules].sort()),
    builtins: Object.freeze([...builtins].sort()),
    packages: Object.freeze([...packages].sort()),
    localImports: Object.freeze(Object.fromEntries([...localImports.entries()].sort((left, right) => (
      left[0].localeCompare(right[0])
    ))))
  });
}

/** Verify that a reviewed manifest is the exact reachable implementation graph. */
export function auditReviewedImplementationSourceManifest(manifest, { packageRoot } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('Reviewed implementation source manifest is required.',
      'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID');
  }
  const entrypoints = exactSortedStrings(manifest.entrypoints, 'entrypoints')
    .map((entry) => normalizePackagePath(entry, 'Implementation entrypoint'));
  const declaredModules = modulePaths(manifest);
  const declaredBuiltins = exactSortedStrings(manifest.builtins, 'builtins');
  const declaredPackages = exactSortedStrings(manifest.packages, 'packages');
  const discovered = discoverImplementationSourceClosure({ packageRoot, entrypoints });
  compareExact('modules', declaredModules, discovered.modules);
  compareExact('builtins', declaredBuiltins, discovered.builtins);
  compareExact('packages', declaredPackages, discovered.packages);
  return discovered;
}
