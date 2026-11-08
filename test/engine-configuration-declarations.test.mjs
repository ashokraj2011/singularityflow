import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as core from '../src/kernel/configuration-declarations.mjs';
import { createWorkflowConfigurationCompiler } from '../src/kernel/workflow-configuration.mjs';
import { captureConfigurationCompiler } from './helpers/configuration-compiler-capture.mjs';

const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-configuration-declarations/native-v1.json', import.meta.url), 'utf8'));
const owner = 'src/kernel/configuration-declarations.mjs';
const printer = ts.createPrinter({ removeComments: true });
const digest = text => createHash('sha256').update(text).digest('hex');
const capture = captureConfigurationCompiler();
let installed;
try { await import('../src/config.mjs'); installed = capture.value; }
finally { capture.close(); }
const { configurationDeclarationResults, declarationModules } = await import('./helpers/configuration-declaration-cases.mjs');

test('67 pre-extraction declaration outcomes preserve values, mutations and exact errors', () => {
  assert.deepEqual(configurationDeclarationResults(), baseline.results);
  assert.deepEqual(Object.fromEntries(Object.entries(declarationModules).map(([family,module]) => [family,Object.keys(module).sort()])), baseline.exports);
});

test('every original extracted rule body and constant retains its original definition', async () => {
  const source = ts.createSourceFile(owner, await readFile(new URL('../' + owner, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = new Set(), constants = new Set();
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node)) {
      const entry = Object.entries(baseline.functions).find(([name]) => name.endsWith(':' + node.name.text));
      if (!entry) {
        assert.equal(node.name.text, 'worldModelStateAuthority', 'additional rules need their own captured baseline');
        continue;
      }
      assert.equal(digest(printer.printNode(ts.EmitHint.Unspecified, node.body, source)), entry[1].sha256, entry[0]); functions.add(entry[0]);
    }
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      const entry = Object.entries(baseline.constants).find(([name]) => name.endsWith(':' + declaration.name.text));
      assert.ok(entry, declaration.name.text);
      if (entry[1].literalKeys) {
        const elements = declaration.initializer.arguments[0].elements.map(value => value.text);
        assert.deepEqual(elements, entry[1].literalKeys);
        assert.deepEqual(elements, Object.keys(core.DEFAULT_ANALYSIS_LIMITS));
      } else assert.equal(digest(printer.printNode(ts.EmitHint.Unspecified, declaration.initializer, source)), entry[1].sha256, entry[0]);
      constants.add(entry[0]);
    }
  }
  assert.deepEqual([...functions].sort(), Object.keys(baseline.functions).sort());
  assert.deepEqual([...constants].sort(), Object.keys(baseline.constants).sort());
});

test('compatibility exports retain the shared identities and diagnostic state', async () => {
  for (const [file,entry] of Object.entries(baseline.owners)) {
    const native = await import(new URL('../' + file, import.meta.url));
    for (const name of entry.exports) assert.equal(native[name], core[name], file + ':' + name);
  }
  for (const value of [core.DEFAULT_ANALYSIS_LIMITS,core.SOURCE_BOUNDARIES,core.LOG_LEVELS]) assert.equal(Object.isFrozen(value), true);
  const definition = { architectureIntent: { enabled: true }, worldModel: { views: {} } };
  core.dropRemovedSettings(definition);
  assert.deepEqual(declarationModules.removed.removedSettings(definition), ['architectureIntent','worldModel.views']);
});

test('the installed compiler binds these rules directly and refuses all 16 replacements', () => {
  assert.equal(Object.keys(installed.dependencies).length, 8);
  for (const name of baseline.compilerDependencies) {
    assert.equal(Object.hasOwn(installed.dependencies, name), false, name);
    assert.throws(() => createWorkflowConfigurationCompiler({ ...installed.dependencies, [name]: () => ({ ready: true }) }),
      { code: 'ENGINE_CONFIGURATION_COMPILER_INVALID' }, name);
  }
});

test('bounds, source-only code scope, human convergence and declaration defaults remain enforced', () => {
  assert.throws(() => core.analysisLimits({ maxArtifactBytes: 0 }), /must be a positive integer/);
  assert.throws(() => core.assertNoAutonomousConvergence({ autoAdvance: true }), /human disposition/);
  assert.throws(() => core.assertCodeDeliveryConfiguration({ id: 'repair', generation: { task: 'code' }, writeScope: 'artifact-only' }), { code: 'CODE_DELIVERY_SCOPE_INVALID' });
  assert.throws(() => core.normalizeLedgerConfig({ trustTier: 'T2', signing: 'off' }), /requires ledger.signing/);
  assert.throws(() => core.validateTokenReportingPolicy({ pricing: { sample: { input: -1 } } }), /non-negative/);
  assert.deepEqual(core.pinCodeDeliveryTask({ id: 'implementation', artifact: { kind: 'implementation-summary', path: 'summary.md' }, writeScope: 'source-and-artifact' }), { task: 'code' });
});
