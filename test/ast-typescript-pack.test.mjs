/**
 * The bundled TypeScript/JavaScript packs: the compiler's parser for syntax facts, its type checker
 * for resolved call edges, and their use by repository knowledge in place of name matching.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundledAstAdapters } from '../src/ast-adapter-contract.mjs';
import { astCacheStatus, astCommand, astQuery, buildAstCache } from '../src/ast-intelligence.mjs';
import { astSemanticWarmCommand } from '../src/ast-semantic-warm.mjs';
import { resolveTypeScript, semanticCalls, syntaxFacts } from '../src/ast-packs/typescript-core.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typescript = resolveTypeScript()?.module;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(t, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-typescript-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), text);
  }
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'add', '-A');
  git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture');
  return directory;
}

const FILES = {
  'package.json': '{ "name": "cart", "type": "module" }\n',
  'tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true } }\n',
  'src/money.ts': 'export function round(cents: number): number { return Math.round(cents); }\n'
    + 'export function add(a: number, b: number): number { return round(a + b); }\n',
  'src/cart.ts': "import { add as plus } from './money';\n\n"
    + 'export class Cart {\n'
    + '  private total = 0;\n'
    + '  add(cents: number): void { this.total = plus(this.total, cents); }\n'
    + '  checkout(): number { this.add(0); return this.total; }\n'
    + '}\n\n'
    + 'export function fill(cart: Cart): void { cart.add(500); JSON.stringify(cart); }\n'
};

test('the syntax pack names declarations once, with the identities the semantic pack uses', { skip: !typescript }, () => {
  const facts = syntaxFacts(typescript, 'src/cart.ts', FILES['src/cart.ts']);
  const ids = facts.filter((fact) => fact.kind === 'symbol').map((fact) => fact.id);
  assert.deepEqual(ids, [
    'ts:src/cart.ts#Cart:class', 'ts:src/cart.ts#Cart.add:method', 'ts:src/cart.ts#Cart.checkout:method', 'ts:src/cart.ts#fill:function'
  ]);
  assert.ok(facts.some((fact) => fact.kind === 'import' && fact.target === './money' && fact.importedNames.includes('add')));
  assert.ok(facts.every((fact) => fact.assurance === 'syntax'));
});

test('the type checker resolves calls through imports, aliases and methods, and leaves library calls out', { skip: !typescript }, async (t) => {
  const directory = await repository(t, FILES);
  const edges = semanticCalls(typescript, directory, ['src/cart.ts', 'src/money.ts'])
    .flatMap((file) => file.facts).map((fact) => `${fact.sourceId.split('#')[1]} -> ${fact.target.replace('ts:', '')}`);
  assert.deepEqual(edges.sort(), [
    // `plus` is an alias of money.add; `cart.add` and `this.add` are the method, not the function add.
    'Cart.add:method -> src/money.ts#add:function',
    'Cart.checkout:method -> src/cart.ts#Cart.add:method',
    'add:function -> src/money.ts#round:function',
    'fill:function -> src/cart.ts#Cart.add:method'
  ]);
});

test('the AST layer runs the packs: syntax at once, resolved callers after an explicit warm-up', { skip: !typescript }, async (t) => {
  const adapters = await bundledAstAdapters();
  assert.deepEqual(adapters.filter((adapter) => adapter.id.startsWith('sflow-typescript')).map((adapter) => `${adapter.id}:${adapter.stage}`),
    ['sflow-typescript-syntax:syntax', 'sflow-typescript:semantic']);
  const directory = await repository(t, FILES);
  const built = await buildAstCache(directory, { all: true });
  assert.equal(built.status, 'complete', 'an unwarmed bundled semantic pack is not a degradation');
  assert.ok(built.provenance.adapters.some((entry) => entry.id === 'sflow-typescript-syntax'));
  const before = await astQuery(directory, { predicate: 'references', value: 'ts:src/cart.ts#Cart.add:method', all: true });
  assert.equal(before.facts.length, 0, 'no resolved edges before the project is warmed');

  const plan = await astSemanticWarmCommand(directory, { semantic: true, provider: 'sflow-typescript', profile: 'default', 'dry-run': true });
  assert.equal(plan.ready, true);
  assert.equal(plan.effects.executesRepositoryConfiguration, false);
  assert.deepEqual(plan.commands.map((command) => command.kind), ['toolchain-version']);
  await astSemanticWarmCommand(directory, { semantic: true, provider: 'sflow-typescript', profile: 'default', confirm: plan.confirmation });
  const method = 'ts:src/cart.ts#Cart.add:method';
  const after = await astQuery(directory, { predicate: 'references', value: method, all: true });
  // `references` matches both ends: who calls Cart.add, and what Cart.add calls.
  assert.deepEqual(after.facts.filter((fact) => fact.target === method).map((fact) => fact.sourceId).sort(),
    ['ts:src/cart.ts#Cart.checkout:method', 'ts:src/cart.ts#fill:function']);
  assert.deepEqual(after.facts.filter((fact) => fact.sourceId === method).map((fact) => fact.target), ['ts:src/money.ts#add:function']);
  assert.ok(after.facts.every((fact) => fact.type === 'calls' && fact.assurance === 'semantic'));
});

test('knowledge uses resolved calls once warmed and keeps name matching until then', { skip: !typescript }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-typescript-shop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'shop'), directory, { recursive: true });
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'add', '-A');
  git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture');
  const unwarmed = (await buildKnowledge(directory, { history: false })).knowledge;
  assert.ok(unwarmed.metrics.callsMatchedByName > 0, 'without a warmed pack, calls are matched by name');
  assert.equal(unwarmed.metrics.callsResolved, 0);
  assert.equal(unwarmed.metrics.callResolution.status, 'not-warmed');
  assert.equal((await astCacheStatus(directory)).exists, false, 'nothing is parsed before a project is warmed');

  const plan = await astSemanticWarmCommand(directory, { semantic: true, provider: 'sflow-typescript', profile: 'default', 'dry-run': true });
  await astSemanticWarmCommand(directory, { semantic: true, provider: 'sflow-typescript', profile: 'default', confirm: plan.confirmation });
  const warmed = await buildKnowledge(directory, { history: false });
  assert.equal(warmed.cache, 'miss', 'warming a pack rebuilds the knowledge');
  const { metrics, graph } = warmed.knowledge;
  assert.equal(metrics.callsMatchedByName, 0);
  assert.ok(metrics.callsResolved >= 8, JSON.stringify(metrics));
  assert.deepEqual(metrics.callResolution.providers, ['sflow-typescript']);
  assert.ok(graph.calls.some(([from, to, how]) => from === 'total' && to === 'subtotal' && how === 'resolved'));
  assert.equal(metrics.invalidCitations, 0);
});

test('pack list reports the TypeScript packs as bundled', { skip: !typescript }, async () => {
  const listed = await astCommand(root, ['pack', 'list'], {});
  for (const id of ['sflow-typescript-syntax', 'sflow-typescript']) {
    assert.equal(listed.packs.find((pack) => pack.id === id)?.source, 'bundled', id);
  }
});
