import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createSkillPhaseContractCompiler } from '../src/kernel/skill-phase-contract.mjs';
import * as pathRules from '../src/kernel/configuration-path-policies.mjs';
import * as portable from '../src/foundation/portable-paths.mjs';
import { NODE_CONFIGURATION_PATH_SYNTAX } from '../src/engine-compatibility/node-configuration-path.mjs';
import { NODE_TEXT_DIGESTS } from '../src/records.mjs';
import { createWorkflowConfigurationCompiler } from '../src/kernel/workflow-configuration.mjs';
import { captureConfigurationCompiler } from './helpers/configuration-compiler-capture.mjs';

const capture = captureConfigurationCompiler();
let installed;
try { await import('../src/config.mjs'); installed = capture.value; }
finally { capture.close(); }
const { skillContractResults, portableValueResults, assetPathResults, skillModules } =
  await import('./helpers/skill-phase-contract-cases.mjs');
const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-skill-phase-contracts/native-v1.json', import.meta.url), 'utf8'));
const compiler = createSkillPhaseContractCompiler(NODE_CONFIGURATION_PATH_SYNTAX, NODE_TEXT_DIGESTS);
const printer = ts.createPrinter({ removeComments: true });
const hash = text => createHash('sha256').update(text).digest('hex');
const legacySyntax = () => Object.freeze(Object.fromEntries(Object.entries({ ...NODE_CONFIGURATION_PATH_SYNTAX,
  profile: pathRules.CONFIGURATION_PATH_SYNTAX }).filter(([key]) => !['posixDirname', 'posixRelative', 'win32IsAbsolute'].includes(key))));

test('30 original skill-contract outcomes preserve compilation, proposals, confirmations, bindings and exact refusals', () => {
  assert.deepEqual(skillContractResults(), baseline.contracts);
  assert.deepEqual(skillContractResults(compiler), baseline.contracts);
  assert.deepEqual(Object.keys(skillModules.native).sort(), baseline.exports.native);
});

test('portable component/identifier values and configuration asset boundaries preserve all original outcomes', () => {
  assert.deepEqual(portableValueResults(), baseline.portable);
  assert.deepEqual(portableValueResults(portable), baseline.portable);
  assert.deepEqual(assetPathResults(), baseline.assets);
  const assets = pathRules.configurationAssetPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
  assert.deepEqual(assetPathResults({ ...assets, portableFilesystemPathIdentity: portable.portableFilesystemPathIdentity }), baseline.assets);
  assert.deepEqual(Object.keys(skillModules.paths).sort(), baseline.exports.paths);
  assert.deepEqual(Object.keys(skillModules.portable).sort(), baseline.exports.portable);
});

test('all 35 relocated rule bodies and 17 declarations retain their original syntax', async () => {
  const seenFunctions = new Set(), seenConstants = new Set();
  for (const owner of [...new Set([...Object.values(baseline.functions), ...Object.values(baseline.constants)].map(entry => entry.owner))]) {
    const ast = ts.createSourceFile(owner, await readFile(new URL('../' + owner, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node, factory = null) => {
      if (ts.isFunctionDeclaration(node) && ['createSkillPhaseContractCompiler', 'configurationAssetPolicies'].includes(node.name?.text)) factory = node.name.text;
      if (ts.isFunctionDeclaration(node)) for (const [key, entry] of Object.entries(baseline.functions)) {
        if (entry.owner === owner && entry.factory === factory && key.endsWith(':' + node.name.text)) {
          assert.equal(hash(printer.printNode(ts.EmitHint.Unspecified, node.body, ast)), entry.sha256, key); seenFunctions.add(key);
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer) for (const [key, entry] of Object.entries(baseline.constants)) {
        if (entry.owner === owner && entry.factory === factory && key.endsWith(':' + node.name.getText(ast))) {
          assert.equal(hash(printer.printNode(ts.EmitHint.Unspecified, node.initializer, ast)), entry.sha256, key); seenConstants.add(key);
        }
      }
      ts.forEachChild(node, child => visit(child, factory));
    }; visit(ast);
  }
  assert.deepEqual([...seenFunctions].sort(), Object.keys(baseline.functions).sort());
  assert.deepEqual([...seenConstants].sort(), Object.keys(baseline.constants).sort());
});

test('native readers share exact compiler functions; the workflow compiler cannot accept a replacement validator', () => {
  for (const [name, fn] of Object.entries(compiler)) assert.equal(skillModules.native[name], fn, name);
  assert.equal(createSkillPhaseContractCompiler(NODE_CONFIGURATION_PATH_SYNTAX, NODE_TEXT_DIGESTS), compiler);
  assert.equal(Object.isFrozen(compiler), true);
  assert.equal(Object.keys(installed.dependencies).length, 7);
  assert.equal(Object.hasOwn(installed.dependencies, 'validateConfiguredSkillPhase'), false);
  assert.throws(() => createWorkflowConfigurationCompiler({ ...installed.dependencies, validateConfiguredSkillPhase: () => ({ ready: true }) }),
    { code: 'ENGINE_CONFIGURATION_COMPILER_INVALID' });
});

test('path v1 keeps its original closed shape while full compilation requires explicit v2 primitives', () => {
  const legacy = legacySyntax(), value = pathRules.configurationPathSyntax(legacy);
  assert.deepEqual(Object.keys(value.path.posix).sort(), ['basename', 'isAbsolute', 'normalize']);
  assert.equal(Object.hasOwn(value.path, 'win32'), false);
  assert.deepEqual(pathRules.sourceScopePolicies(legacy).normalizeSourceRoots(['src/']), ['src']);
  assert.throws(() => createSkillPhaseContractCompiler(legacy, NODE_TEXT_DIGESTS), { code: 'ENGINE_CONFIGURATION_PATH_SYNTAX_UNSUPPORTED' });
  const current = pathRules.configurationPathSyntaxV2(NODE_CONFIGURATION_PATH_SYNTAX);
  assert.equal(current.path.posix.dirname('artifacts/review/report.md'), 'artifacts/review');
  assert.equal(current.path.posix.relative('artifacts/review', 'artifacts/review/risks.md'), 'risks.md');
  assert.equal(current.path.win32.isAbsolute('C:/outside'), true);
  assert.throws(() => pathRules.configurationPathSyntax(Object.freeze({ ...legacy, posixDirname: path.posix.dirname })),
    { code: 'ENGINE_CONFIGURATION_PATH_SYNTAX_INVALID' });
});

test('compiler construction does not invoke primitives, bind getters or capture mutable data', () => {
  let calls = 0;
  const method = () => { calls++; throw new Error('not a constructor effect'); };
  Object.defineProperty(method, 'bind', { get() { throw new Error('bind accessor must not run'); } });
  const syntax = Object.freeze(Object.fromEntries(Object.entries(NODE_CONFIGURATION_PATH_SYNTAX).map(([key, value]) =>
    [key, typeof value === 'function' ? method : value])));
  const digests = Object.freeze({ profile: NODE_TEXT_DIGESTS.profile, sha256Utf8: method });
  createSkillPhaseContractCompiler(syntax, digests);
  assert.equal(calls, 0);
  assert.throws(() => createSkillPhaseContractCompiler({ ...syntax }, digests), { code: 'ENGINE_CONFIGURATION_PATH_SYNTAX_INVALID' });
});

test('each full read rechecks policy hashes and does not infer package or actor authority from a header', () => {
  const ordinary = baseline.contracts.find(value => value.label === 'ordinary');
  const value = structuredClone(ordinary.configured);
  value.artifact.minimumBytes++;
  assert.throws(() => compiler.validateConfiguredSkillPhase(value, ordinary.compiled.phaseId), { code: 'SKP_PHASE_BINDING_INVALID' });
  assert.deepEqual(compiler.validateConfiguredSkillPhase(ordinary.configured, ordinary.compiled.phaseId), ordinary.binding);
  const stale = structuredClone(ordinary.before); stale.phase.label += ' changed';
  assert.throws(() => compiler.compileConfirmedSkillPhase(stale), { code: 'SKP_CONTRACT_UNCONFIRMED' });
});

test('new pure owners contain no host effects or native hashing implementation', async () => {
  for (const file of ['src/kernel/skill-phase-contract.mjs', 'src/foundation/portable-paths.mjs']) {
    const text = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /node:|process\.|readFile|createHash|safeCommandGuidance/);
  }
});
