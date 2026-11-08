import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as policy from '../src/kernel/specification-policy.mjs';
import * as headers from '../src/kernel/skill-binding-header.mjs';
import * as phases from '../src/kernel/phase-policy.mjs';
import { createWorkflowConfigurationCompiler } from '../src/kernel/workflow-configuration.mjs';
import { captureConfigurationCompiler } from './helpers/configuration-compiler-capture.mjs';

const capture = captureConfigurationCompiler();
let installed;
try { await import('../src/config.mjs'); installed = capture.value; }
finally { capture.close(); }
const { configurationSpecificationResults, specificationModules, specificationDeclarationData } =
  await import('./helpers/configuration-specification-cases.mjs');
const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-configuration-specifications/native-v1.json', import.meta.url), 'utf8'));
const printer = ts.createPrinter({ removeComments: true });
const digest = value => createHash('sha256').update(value).digest('hex');
const pure = { quality: policy, roles: policy, binding: headers };

test('74 original specification/header outcomes preserve values, mutations, legacy roles and exact refusals', () => {
  assert.deepEqual(configurationSpecificationResults(), baseline.results);
  assert.deepEqual(configurationSpecificationResults(pure), baseline.results);
  assert.deepEqual(Object.fromEntries(Object.entries(specificationModules).map(([family, module]) => [family, Object.keys(module).sort()])), baseline.exports);
});

test('all 11 rule bodies and 15 constant initializers retain their original syntax', async () => {
  const seenFunctions = new Set(), seenConstants = new Set();
  for (const owner of [...new Set([...Object.values(baseline.functions), ...Object.values(baseline.constants)].map(entry => entry.owner))]) {
    const ast = ts.createSourceFile(owner, await readFile(new URL('../' + owner, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) {
      if (ts.isFunctionDeclaration(node)) {
        const entry = Object.entries(baseline.functions).find(([key, value]) => value.owner === owner && key.endsWith(':' + node.name.text));
        if (entry) { assert.equal(digest(printer.printNode(ts.EmitHint.Unspecified, node.body, ast)), entry[1].sha256, entry[0]); seenFunctions.add(entry[0]); }
      }
      if (ts.isVariableStatement(node)) for (const variable of node.declarationList.declarations) {
        const entry = Object.entries(baseline.constants).find(([key, value]) => value.owner === owner && key.endsWith(':' + variable.name.getText(ast)));
        if (entry) { assert.equal(digest(printer.printNode(ts.EmitHint.Unspecified, variable.initializer, ast)), entry[1].sha256, entry[0]); seenConstants.add(entry[0]); }
      }
    }
  }
  assert.deepEqual([...seenFunctions].sort(), Object.keys(baseline.functions).sort());
  assert.deepEqual([...seenConstants].sort(), Object.keys(baseline.constants).sort());
});

test('native APIs are exact kernel aliases; policy defaults, checklist content and persisted hashes are unchanged', async () => {
  for (const [file, entry] of Object.entries(baseline.owners)) {
    const native = await import(new URL('../' + file, import.meta.url)), core = await import(new URL('../' + entry.owner, import.meta.url));
    for (const name of entry.exports) assert.equal(native[name], core[name], file + ':' + name);
  }
  assert.deepEqual(specificationDeclarationData(), baseline.data);
  assert.equal(specificationModules.quality.STARTER_CHECKLIST.id, policy.SPECIFICATION_CHECKLIST_ID);
  const { recordSha256 } = await import('../src/records.mjs');
  assert.equal(recordSha256(specificationModules.quality.STARTER_CHECKLIST), baseline.checklistSha256);
  for (const entry of baseline.policyHashes) {
    const value = baseline.results.find(result => result.id === entry.id).value;
    assert.equal(specificationModules.quality.policyHash(policy.specificationQualityPolicy(value)), entry.sha256);
  }
  assert.equal(phases.PHASE_SEMANTICS_PROFILE, baseline.data.phaseProfile);
});

test('the compiler owns specification meaning and rejects all five former collaborator overrides', () => {
  assert.equal(Object.keys(installed.dependencies).length, 8);
  for (const name of baseline.compilerDependencies) {
    assert.equal(Object.hasOwn(installed.dependencies, name), false, name);
    assert.throws(() => createWorkflowConfigurationCompiler({ ...installed.dependencies, [name]: () => ({ ready: true }) }),
      { code: 'ENGINE_CONFIGURATION_COMPILER_INVALID' }, name);
  }
});

test('a supported header never substitutes for configured phase validation or package/actor authority', () => {
  const header = { schemaVersion: 1, compiler: 'skp-contract/v1', parserProfile: 'skp-skill-text/v1',
    compilationSha256: `sha256:${'a'.repeat(64)}`, bindingRefs: {} };
  assert.equal(headers.validateSkillPhaseBindingHeader(header), header);
  assert.throws(() => specificationModules.binding.validateConfiguredSkillPhase({ kind: 'skill', skillBinding: header }, 'criteria'),
    { code: 'SKP_PHASE_BINDING_INVALID' });
  assert.equal(policy.isSpecificationDefinitionPhase({}), true, 'absent legacy kinds still retain approved clauses');
  assert.equal(policy.isSpecificationDefinitionPhase({ artifact: { kind: 'test-evidence' } }), false);
});

test('core specification rules contain no native dependencies, document reader or checklist questions', async () => {
  for (const [file, allowed] of [
    ['src/kernel/specification-policy.mjs', new Set(['../foundation/failures.mjs', './skill-binding-header.mjs'])],
    ['src/kernel/skill-binding-header.mjs', new Set(['../foundation/failures.mjs'])]
  ]) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:|process\.|safeCommandGuidance|readFile|recordSha256|Does the specification cover|Are latency, availability/);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const node of ast.statements.filter(ts.isImportDeclaration)) assert.ok(allowed.has(node.moduleSpecifier.text), file + ':' + node.moduleSpecifier.text);
  }
  assert.equal(specificationModules.quality.STARTER_CHECKLIST.articles.length, 6);
});
