/** Parse the complete admitted ESM graph without evaluating any application module. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const HOST_GLOBALS = new Set([
  'process', 'global', 'globalThis', 'require', 'eval', 'Function', 'fetch', 'WebSocket', 'XMLHttpRequest', 'Worker'
]);

export async function inspectPureModuleGraph({ root, entries, allowed }) {
  const admitted = new Set(allowed.map(file => path.resolve(root, file)));
  const pending = entries.map(file => path.resolve(root, file));
  const visited = new Set();
  const problems = [];
  const relative = file => path.relative(root, file).split(path.sep).join('/');

  while (pending.length) {
    const absolute = pending.pop();
    if (visited.has(absolute)) continue;
    if (!admitted.has(absolute)) {
      problems.push({ file: relative(absolute), kind: 'outside-boundary' });
      continue;
    }
    visited.add(absolute);
    const text = await readFile(absolute, 'utf8');
    const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    // A parameter named `require` is data in the frozen SDA v1 contract. Resolve lexical bindings
    // instead of treating a spelling as ambient authority. No libraries or imports are type-loaded.
    const options = { allowJs: true, noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.Latest };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = file => file === absolute ? source : undefined;
    host.fileExists = file => file === absolute;
    host.readFile = file => file === absolute ? text : undefined;
    const checker = ts.createProgram([absolute], options, host).getTypeChecker();
    const report = (node, kind, dependency) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      problems.push({ file: relative(absolute), line, kind, dependency });
    };
    const dependency = (node, specifier) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        report(node, 'nonliteral-import', null);
      } else if (!specifier.text.startsWith('./') && !specifier.text.startsWith('../')) {
        report(node, 'external-import', specifier.text);
      } else {
        const target = path.resolve(path.dirname(absolute), specifier.text);
        if (!admitted.has(target)) report(node, 'outside-boundary', relative(target));
        else pending.push(target);
      }
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        dependency(node, node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        dependency(node, node.arguments[0]);
      }
      if (ts.isIdentifier(node) && HOST_GLOBALS.has(node.text)) {
        // Property names are data, not access to an ambient host capability.
        const propertyName = (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
          || (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
          || (ts.isMethodDeclaration(node.parent) && node.parent.name === node);
        const symbol = checker.getSymbolAtLocation(node);
        const localBinding = symbol?.declarations?.some(declaration => declaration.getSourceFile() === source);
        if (!propertyName && !localBinding) report(node, 'ambient-host-access', node.text);
      }
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        report(node, 'ambient-module-context', 'import.meta');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { modules: [...visited].map(relative).sort(), problems };
}
