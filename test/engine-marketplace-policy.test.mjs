import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createMarketplacePolicyCompiler, NETWORK_ADDRESS_SYNTAX_PROFILE } from '../src/kernel/configuration-policy.mjs';
import { worldModelStateAuthority } from '../src/kernel/configuration-declarations.mjs';
import { NODE_NETWORK_ADDRESS_SYNTAX } from '../src/engine-compatibility/node-network-syntax.mjs';
import { createWorkflowConfigurationCompiler } from '../src/kernel/workflow-configuration.mjs';
import { captureConfigurationCompiler } from './helpers/configuration-compiler-capture.mjs';
import { remoteAddressResults, remoteUrlResults, marketplaceConfigurationResults, stateAuthorityResults, marketplacePolicyModules } from './helpers/marketplace-policy-cases.mjs';

const capture = captureConfigurationCompiler();
let installed;
try { await import('../src/config.mjs'); installed = capture.value; }
finally { capture.close(); }
const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-marketplace-policy/native-v1.json', import.meta.url), 'utf8'));
const compiler = createMarketplacePolicyCompiler(NODE_NETWORK_ADDRESS_SYNTAX);
const printer = ts.createPrinter({ removeComments: true });
const hash = text => createHash('sha256').update(text).digest('hex');

test('all 118 original IP cases and blocked-range boundaries retain exact native outcomes', () => {
  assert.deepEqual(remoteAddressResults(baseline.subnets), baseline.addresses);
  assert.deepEqual(remoteAddressResults(baseline.subnets, compiler), baseline.addresses);
});

test('all 28 URL and 27 marketplace declarations preserve errors, origins, whitespace and hashes', () => {
  assert.deepEqual(remoteUrlResults(), baseline.urls);
  assert.deepEqual(remoteUrlResults(compiler), baseline.urls);
  assert.deepEqual(marketplaceConfigurationResults(), baseline.marketplaces);
  assert.deepEqual(marketplaceConfigurationResults(compiler), baseline.marketplaces);
  assert.deepEqual(Object.fromEntries(Object.entries(marketplacePolicyModules).map(([name, api]) => [name, Object.keys(api).sort()])), baseline.exports);
});

test('the existing Git-configuration projection keeps every fallback priority and frozen result', () => {
  assert.deepEqual(stateAuthorityResults(), baseline.authority);
  assert.deepEqual(stateAuthorityResults({ worldModelStateAuthority }), baseline.authority);
  assert.equal(marketplacePolicyModules.authority.worldModelStateAuthority, worldModelStateAuthority);
});

test('six moved rule bodies and both private constants retain their original syntax', async () => {
  const functions = new Set(), constants = new Set();
  for (const file of [...new Set(Object.values(baseline.functions).map(entry => entry.owner))]) {
    const ast = ts.createSourceFile(file, await readFile(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node, factory = null) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'createMarketplacePolicyCompiler') factory = 'marketplace';
      if (ts.isFunctionDeclaration(node)) for (const [key, expected] of Object.entries(baseline.functions)) {
        if (expected.owner === file && key.endsWith(':' + node.name?.text)
            && (file.endsWith('configuration-declarations.mjs') ? factory === null : factory === 'marketplace')) {
          assert.equal(hash(printer.printNode(ts.EmitHint.Unspecified, node.body, ast)), expected.sha256, key);
          functions.add(key);
        }
      }
      if (factory === 'marketplace' && ts.isVariableDeclaration(node) && node.initializer) for (const [key, expected] of Object.entries(baseline.constants)) {
        if (expected.owner === file && key.endsWith(':' + node.name.getText(ast))) {
          assert.equal(hash(printer.printNode(ts.EmitHint.Unspecified, node.initializer, ast)), expected.sha256, key);
          constants.add(key);
        }
      }
      ts.forEachChild(node, child => visit(child, factory));
    }; visit(ast);
  }
  assert.deepEqual([...functions].sort(), Object.keys(baseline.functions).sort());
  assert.deepEqual([...constants].sort(), Object.keys(baseline.constants).sort());
});

test('all 17 native network, DNS, index and fetch function bodies are unchanged', async () => {
  const seen = new Set();
  for (const file of [...new Set(Object.values(baseline.unchangedBodies).map(entry => entry.owner))]) {
    const ast = ts.createSourceFile(file, await readFile(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of ast.statements.filter(ts.isFunctionDeclaration)) {
      const key = file + ':' + node.name.text, expected = baseline.unchangedBodies[key];
      if (expected) { assert.equal(hash(printer.printNode(ts.EmitHint.Unspecified, node.body, ast)), expected.sha256, key); seen.add(key); }
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(baseline.unchangedBodies).sort());
});

test('compilation owns both former rules and native consumers share the actual core bindings', () => {
  assert.equal(Object.keys(installed.dependencies).length, 8);
  assert.equal(installed.dependencies.networkAddressSyntax, NODE_NETWORK_ADDRESS_SYNTAX);
  for (const name of ['normalizeMarketplaces', 'worldModelStateAuthority']) {
    assert.equal(Object.hasOwn(installed.dependencies, name), false);
    assert.throws(() => createWorkflowConfigurationCompiler({ ...installed.dependencies, [name]: () => ({ ready: true }) }),
      { code: 'ENGINE_CONFIGURATION_COMPILER_INVALID' });
  }
  assert.equal(marketplacePolicyModules.marketplaces.normalizeMarketplaces, compiler.normalizeMarketplaces);
  assert.equal(marketplacePolicyModules.remote.isPublicRemoteAddress, compiler.isPublicRemoteAddress);
  assert.equal(marketplacePolicyModules.remote.validatePublicHttpsUrl, compiler.validatePublicHttpsUrl);
  assert.equal(createMarketplacePolicyCompiler(NODE_NETWORK_ADDRESS_SYNTAX), compiler);
  assert.equal(Object.isFrozen(compiler), true);
  assert.equal(Object.values(compiler).some(value => value instanceof RegExp), false);
});

test('the kernel supplies all 26 unchanged frozen subnet pairs and rechecks each request', () => {
  let classifications = 0, memberships = 0;
  const observed = {};
  const port = Object.freeze({ profile: NETWORK_ADDRESS_SYNTAX_PROFILE,
    isIP(value) { classifications++; return NODE_NETWORK_ADDRESS_SYNTAX.isIP(value); },
    containsSubnets(address, family, subnets) {
      memberships++;
      assert.equal(Object.isFrozen(subnets), true);
      assert.equal(subnets.every(row => Object.isFrozen(row)), true);
      observed[family] = subnets;
      return NODE_NETWORK_ADDRESS_SYNTAX.containsSubnets(address, family, subnets);
    } });
  const rules = createMarketplacePolicyCompiler(port);
  assert.equal(classifications, 0); assert.equal(memberships, 0);
  for (const address of ['8.8.8.8', '8.8.8.8', '2001:4860:4860::8888']) assert.equal(rules.isPublicRemoteAddress(address), true);
  assert.equal(classifications, 3); assert.equal(memberships, 3);
  assert.deepEqual(observed, baseline.subnets);
});

test('syntax capture rejects unsupported capabilities without calling primitives or bind accessors', () => {
  let calls = 0;
  const primitive = () => { calls++; throw new Error('not during capture'); };
  Object.defineProperty(primitive, 'bind', { get() { throw new Error('bind accessor'); } });
  const valid = Object.freeze({ profile: NETWORK_ADDRESS_SYNTAX_PROFILE, isIP: primitive, containsSubnets: primitive });
  createMarketplacePolicyCompiler(valid);
  const invalid = [null, {}, { ...valid }, Object.freeze({ ...valid, extra: true }), Object.freeze({ ...valid, profile: 'other' }),
    Object.freeze({ ...valid, isIP: false }), Object.freeze(Object.create(valid)),
    Object.freeze(Object.defineProperty({ ...valid }, 'isIP', { get() { throw new Error('getter'); } })),
    Object.freeze(Object.defineProperty({ ...valid }, 'containsSubnets', { value: primitive, enumerable: false }))];
  for (const value of invalid) assert.throws(() => createMarketplacePolicyCompiler(value), { code: 'ENGINE_NETWORK_ADDRESS_SYNTAX_INVALID' });
  assert.equal(calls, 0);
});

test('bad primitive results and genuine failures stay explicit; membership is never a cached verdict', () => {
  const base = { profile: NETWORK_ADDRESS_SYNTAX_PROFILE, isIP: () => 4, containsSubnets: () => false };
  assert.throws(() => createMarketplacePolicyCompiler(Object.freeze({ ...base, isIP: () => '4' })).isPublicRemoteAddress('8.8.8.8'), { code: 'ENGINE_NETWORK_ADDRESS_SYNTAX_RESULT_INVALID' });
  assert.throws(() => createMarketplacePolicyCompiler(Object.freeze({ ...base, containsSubnets: () => 0 })).isPublicRemoteAddress('8.8.8.8'), { code: 'ENGINE_NETWORK_ADDRESS_SYNTAX_RESULT_INVALID' });
  let blocked = false;
  const rules = createMarketplacePolicyCompiler(Object.freeze({ ...base, containsSubnets: () => blocked }));
  assert.equal(rules.isPublicRemoteAddress('8.8.8.8'), true);
  blocked = true;
  assert.equal(rules.isPublicRemoteAddress('8.8.8.8'), false);
  const failure = new Error('genuine address syntax failure');
  assert.throws(() => createMarketplacePolicyCompiler(Object.freeze({ ...base, isIP() { throw failure; } })).isPublicRemoteAddress('8.8.8.8'), error => error === failure);
  assert.throws(() => NODE_NETWORK_ADDRESS_SYNTAX.containsSubnets('8.8.8.8', 'ipv4', []), { code: 'ENGINE_NETWORK_SUBNET_INPUT_INVALID' });
});
