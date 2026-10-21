import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

test('test harness imports use file URLs instead of native path builders', async () => {
  const root = new URL('./', import.meta.url);
  const problems = [];
  for (const file of (await readdir(root)).filter(name => name.endsWith('.mjs'))) {
    const source = await readFile(new URL(file, root), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const pathBuilder = expression => ts.isCallExpression(expression)
      && ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.expression.getText(ast) === 'path'
      && ['join', 'resolve'].includes(expression.expression.name.text);
    const helpers = new Set();
    for (const statement of ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const entry of statement.declarationList.declarations) {
        if (ts.isIdentifier(entry.name) && entry.initializer && ts.isArrowFunction(entry.initializer)
            && pathBuilder(entry.initializer.body)) helpers.add(entry.name.text);
      }
    }
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && (pathBuilder(argument) || (ts.isCallExpression(argument)
            && ts.isIdentifier(argument.expression) && helpers.has(argument.expression.text)))) {
          problems.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  assert.deepEqual(problems, [], 'pathToFileURL(...).href is required for portable ESM imports');
});
