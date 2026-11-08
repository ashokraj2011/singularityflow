import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as core from '../src/kernel/configuration-path-policies.mjs';
import * as native from '../src/engine-compatibility/node-configuration-path.mjs';
import { NODE_CONFIGURATION_PATH_SYNTAX } from '../src/engine-compatibility/node-configuration-path.mjs';
import { createWorkflowConfigurationCompiler } from '../src/kernel/workflow-configuration.mjs';
import { captureConfigurationCompiler } from './helpers/configuration-compiler-capture.mjs';

const capture = captureConfigurationCompiler();
let installed;
try { await import('../src/config.mjs'); installed = capture.value; }
finally { capture.close(); }
const { configurationPathResults, pathModules } = await import('./helpers/configuration-path-cases.mjs');
const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-configuration-paths/native-v1.json', import.meta.url), 'utf8'));
const printer = ts.createPrinter({ removeComments: true });
const digest = text => createHash('sha256').update(text).digest('hex');
const syntax = grammar => Object.freeze({ profile: core.CONFIGURATION_PATH_SYNTAX, grammar: grammar.sep === '\\' ? 'win32' : 'posix',
  isAbsolute: grammar.isAbsolute, normalize: grammar.normalize, parse: grammar.parse,
  posixIsAbsolute: path.posix.isAbsolute, posixNormalize: path.posix.normalize, posixBasename: path.posix.basename,
  toPosix: value => value.split(grammar.sep).join('/') });
function modules(port) {
  return { scope: core.sourceScopePolicies(port), sourcePaths: core, location: core.workItemLocationPolicies(port),
    sets: core.artifactSetPolicies(port), ast: core.astConfigurationPolicies(port), faults: core.faultRepairConfigurationPolicies(port),
    constitution: core.constitutionConfigurationPolicies(port), injection: core.injectionConfigurationPolicies(port),
    commands: core.externalCommandConfigurationPolicies(port), environment: core, recovery: core.testRecoveryConfigurationPolicies(port),
    documents: core.trpDocumentPolicies(port), selection: core.testSelectionPolicies(port), util: { posix: core.configurationPathSyntax(port).posix } };
}

test('152 pre-extraction path outcomes retain POSIX and Win32 value semantics without native Windows execution', () => {
  for (const [name,grammar] of [['posix',path.posix],['win32',path.win32]]) {
    assert.deepEqual(configurationPathResults(modules(syntax(grammar))), baseline.profiles[name], name);
  }
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  assert.deepEqual(configurationPathResults(), baseline.profiles[platform]);
  assert.deepEqual(Object.fromEntries(Object.entries(pathModules).map(([family,module]) => [family,Object.keys(module).sort()])), baseline.exports);
});

test('29 moved rule bodies, the legacy separator helper and 31 declaration initializers retain their syntax', async () => {
  const seenFunctions = new Set(), seenConstants = new Set();
  for (const owner of [...new Set([...Object.values(baseline.functions),...Object.values(baseline.constants)].map(entry => entry.owner))]) {
    const source = ts.createSourceFile(owner, await readFile(new URL('../' + owner, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node,factory = null) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text.endsWith('Policies')) factory = node.name.text;
      if (ts.isFunctionDeclaration(node)) {
        const entry = Object.entries(baseline.functions).find(([name,value]) => value.owner === owner && value.factory === factory && name.endsWith(':' + node.name.text));
        if (entry) { assert.equal(digest(printer.printNode(ts.EmitHint.Unspecified,node.body,source)), entry[1].sha256, entry[0]); seenFunctions.add(entry[0]); }
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const entry = Object.entries(baseline.constants).find(([name,value]) => value.owner === owner && value.factory === factory && name.endsWith(':' + node.name.getText(source)));
        if (entry) { assert.equal(digest(printer.printNode(ts.EmitHint.Unspecified,node.initializer,source)), entry[1].sha256, entry[0]); seenConstants.add(entry[0]); }
      }
      ts.forEachChild(node,child => visit(child,factory));
    }; visit(source);
  }
  assert.deepEqual([...seenFunctions].sort(), Object.keys(baseline.functions).sort());
  assert.deepEqual([...seenConstants].sort(), Object.keys(baseline.constants).sort());
});

test('native APIs and compiler use the same cached policies over the one native primitive port', async () => {
  const families = modules(NODE_CONFIGURATION_PATH_SYNTAX);
  for (const [file,entry] of Object.entries(baseline.owners)) {
    const api = await import(new URL('../' + file, import.meta.url));
    const binding = entry.factory ? core[entry.factory](NODE_CONFIGURATION_PATH_SYNTAX) : core;
    for (const name of entry.exports) assert.equal(api[name], binding[name], file + ':' + name);
  }
  for (const value of ['a/b', 'a\\b', `a${path.sep}b`]) {
    assert.equal(pathModules.util.posix(value), NODE_CONFIGURATION_PATH_SYNTAX.toPosix(value));
  }
  assert.equal(installed.dependencies.pathSyntax, NODE_CONFIGURATION_PATH_SYNTAX);
  assert.equal(core.sourceScopePolicies(NODE_CONFIGURATION_PATH_SYNTAX), families.scope);
  assert.equal(native.normalizeSourceRoots, families.scope.normalizeSourceRoots);
  assert.equal(Object.isFrozen(families.recovery), true);
  assert.equal(Object.keys(installed.dependencies).length, 8);
  for (const name of [...baseline.compilerDependencies,...baseline.primitiveDependencies]) {
    assert.equal(Object.hasOwn(installed.dependencies,name), false, name);
    assert.throws(() => createWorkflowConfigurationCompiler({ ...installed.dependencies, [name]: () => ({ ready: true }) }),
      { code: 'ENGINE_CONFIGURATION_COMPILER_INVALID' }, name);
  }
});

test('syntax admission does not call primitives, access getters or accept mutable/extended ports', () => {
  let calls = 0, getter = false;
  const supplied = Object.fromEntries(Object.keys(NODE_CONFIGURATION_PATH_SYNTAX).map(key => [key,
    key === 'profile' ? NODE_CONFIGURATION_PATH_SYNTAX.profile : key === 'grammar' ? 'posix' : () => { calls++; throw new Error('not a constructor effect'); }]));
  const valid = Object.freeze(supplied);
  core.configurationPathSyntax(valid);
  for (const factory of [...new Set(Object.values(baseline.owners).map(entry => entry.factory).filter(Boolean))]) core[factory](valid);
  assert.equal(calls, 0);
  const accessor = { ...NODE_CONFIGURATION_PATH_SYNTAX };
  Object.defineProperty(accessor,'isAbsolute',{enumerable:true,get(){getter=true;return path.isAbsolute;}});
  for (const bad of [null,{}, {...NODE_CONFIGURATION_PATH_SYNTAX},Object.freeze(accessor),
    Object.freeze({...NODE_CONFIGURATION_PATH_SYNTAX,profile:'unknown/v2'}),Object.freeze({...NODE_CONFIGURATION_PATH_SYNTAX,grammar:'unknown'}),
    Object.freeze({...NODE_CONFIGURATION_PATH_SYNTAX,approve:()=>true})]) {
    assert.throws(() => core.sourceScopePolicies(bad), { code: 'ENGINE_CONFIGURATION_PATH_SYNTAX_INVALID' });
  }
  assert.equal(getter, false); assert.equal(calls, 0);
});

test('artifact boundaries, runtime roots, secret environment declarations and repair limits stay enforced', () => {
  assert.throws(() => native.normalizeWorkItemRoot('../outside'), /repository-relative/);
  assert.throws(() => native.normalizeFaultRepairPolicy({ protectedPaths: ['../outside'] }), /repository-relative/);
  assert.throws(() => native.normalizeTestRecoveryPolicy({ enabled: true, maxDistinctAutomaticAttempts: 4 }), { code: 'TRP_POLICY_INVALID' });
  assert.equal(core.declarableEnvironmentVariable('PATH'), false);
  assert.equal(core.declarableEnvironmentVariable('SINGULARITY_FLOW_TEST'), false);
  assert.throws(() => core.sourcePathPolicy({ testConfigurationPaths: ['.git/config'] }), /cannot include Git/);
});
