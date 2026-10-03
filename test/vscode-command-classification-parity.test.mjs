import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { commandClass } from '../apps/vscode/src/cli/client.ts';
import { operationCatalog, resolveOperation } from '../src/command-registry.mjs';
import { parseArgs } from '../src/util.mjs';

const sourceRoot = fileURLToPath(new URL('../apps/vscode/src/', import.meta.url));

// Parse TypeScript, not a regex over one-line calls: generics, multiline argv and nested callbacks
// are equally covered. Only complete literal argv qualify; dynamic argv retain separate tests.
function literalInvocations(source, file = 'fixture.ts') {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const method = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : ts.isIdentifier(expression) ? expression.text : null;
      const argv = node.arguments[0];
      if (['run', 'runText', 'runWithInput'].includes(method)
          && argv && ts.isArrayLiteralExpression(argv)
          && argv.elements.length > 0 && argv.elements.every(ts.isStringLiteralLike)) {
        const args = argv.elements.map((entry) => entry.text);
        // run(['--acknowledge-self-approval']) is an action-wrapper fragment, not CLI argv.
        if (!args[0].startsWith('-')) result.push({
          args, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result;
}

async function sourceFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(file));
    else if (entry.isFile() && file.endsWith('.ts')) result.push(file);
  }
  return result.sort();
}

function resolved(args) {
  return resolveOperation({ requestedCommand: args[0], ...parseArgs(args) });
}

test('the argv audit parses multiline generic calls, prose and stdin routes without counting fragments', () => {
  assert.deepEqual(literalInvocations(`
    client.run<Result>([
      'adhoc', 'status', '--json'
    ]);
    runText(['goal', 'inspect']);
    nested(() => client.runWithInput(['configuration', 'save', 'file'], '{}'));
    run(['--acknowledge-self-approval']);
    client.run(dynamicArgs);
  `).map((entry) => entry.args), [
    ['adhoc', 'status', '--json'], ['goal', 'inspect'], ['configuration', 'save', 'file']
  ]);
});

test('every complete literal argv issued by the extension matches the CLI operation classification', async () => {
  const invocations = [];
  for (const file of await sourceFiles(sourceRoot)) {
    invocations.push(...literalInvocations(await readFile(file, 'utf8'), file)
      .map((entry) => ({ ...entry, file: path.relative(sourceRoot, file) })));
  }
  // Guard against a vacuous parser/glob success or silently shrinking to one source file.
  assert.ok(invocations.length >= 70, `only ${invocations.length} literal calls were audited`);
  for (const file of ['extension.ts', 'validation.ts', 'views/flow-impact.ts']) {
    assert.ok(invocations.some((entry) => entry.file === file), `${file} must be scanned`);
  }
  assert.ok(invocations.some((entry) => entry.args.join(' ') === 'adhoc status --json'));
  assert.ok(invocations.some((entry) => entry.args.join(' ') === 'configuration validate --json'));
  for (const { file, line, args } of invocations) {
    assert.equal(commandClass(args), resolved(args).classification, `${file}:${line} ${args.join(' ')}`);
  }
});

test('dynamic read routes and unknown commands retain explicit read versus conservative write semantics', () => {
  const reads = [
    ['adhoc', 'status'], ['impact', 'status'], ['impact', 'doctor'], ['goal', 'inspect', 'GOAL-1'],
    ['jira', 'status'], ['prompt-log', 'list'], ['prompt-log', 'status'], ['prompt-log', 'view', 'latest'],
    ['workspace', 'bootstrap', 'status'], ['configuration', 'read', 'singularity/workflow.yml'],
    ['configuration', 'validate'], ['factory-reset', '--dry-run'],
    ['integrations', 'list'], ['integrations', 'status'], ['integrations', 'test', 'team-events', '--send-test']
  ];
  const catalog = new Map(operationCatalog().map((entry) => [entry.id, entry]));
  for (const args of reads) {
    const operation = resolved(args);
    assert.equal(commandClass(args), 'read', args.join(' '));
    assert.equal(operation.classification, 'read', args.join(' '));
    assert.equal(catalog.get(operation.id)?.classification, 'read', operation.id);
  }
  for (const args of [
    ['jira', 'transition', 'ISSUE-1'], ['jira', 'unknown'], ['prompt-log', 'clear'],
    ['prompt-log', 'unknown'], ['configuration', 'future-action'], ['factory-reset', '--dry-run=false'],
    ['factory-reset', '--no-dry-run'], ['integrations', 'retry', 'sad_0123']
  ]) {
    assert.equal(commandClass(args), 'mutation', args.join(' '));
    assert.equal(resolved(args).classification, 'mutation', args.join(' '));
  }
  assert.equal(commandClass(['not-registered']), 'mutation');
  assert.throws(() => resolved(['not-registered']), /Unknown command/);
});
