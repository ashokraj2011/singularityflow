import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as core from '../src/kernel/workflow-obligations.mjs';
import * as roles from '../src/kernel/phase-responsibilities.mjs';
import * as format from '../src/foundation/record-schema.mjs';
import * as records from '../src/records.mjs';
import { createWorkflowConfigurationCompiler } from '../src/kernel/workflow-configuration.mjs';
import { captureConfigurationCompiler } from './helpers/configuration-compiler-capture.mjs';

const capture = captureConfigurationCompiler();
let installed;
try { await import('../src/config.mjs'); installed = capture.value; }
finally { capture.close(); }
const { workflowObligationResults, recordSerializationResults, obligationModules } =
  await import('./helpers/workflow-obligation-cases.mjs');
const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-workflow-obligations/native-v1.json', import.meta.url), 'utf8'));
const printer = ts.createPrinter({ removeComments: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const compile = core.createWorkflowObligationCompiler(records.NODE_TEXT_DIGESTS);

test('22 original workflow graphs retain findings, route guarantees, pinned bytes and both content identities', () => {
  assert.deepEqual(workflowObligationResults(), baseline.graphs);
  assert.deepEqual(workflowObligationResults({ graph: { ...core, compileObligationGraph: compile }, roles }), baseline.graphs);
  assert.deepEqual(Object.keys(obligationModules.graph).sort(), baseline.exports.graph);
  assert.deepEqual(Object.keys(obligationModules.roles).sort(), baseline.exports.roles);
  assert.deepEqual(Object.keys(obligationModules.records).sort(), [...baseline.exports.records, 'NODE_TEXT_DIGESTS'].sort());
});

test('27 original record cases preserve pretty/compact serialization, hashes and legacy exceptions', () => {
  assert.deepEqual(recordSerializationResults(), baseline.records);
  const primitive = format.textDigestCapability(records.NODE_TEXT_DIGESTS);
  assert.deepEqual(recordSerializationResults({ ...format, recordSha256: value => primitive.sha256Utf8(format.canonicalJson(value)) }), baseline.records);
  assert.equal(records.canonicalJson, format.canonicalJson);
  assert.equal(records.compactCanonicalJson, format.compactCanonicalJson);
});

test('all 18 rule/formatter bodies and eight constant initializers preserve their original syntax', async () => {
  const seenFunctions = new Set(), seenConstants = new Set();
  for (const owner of [...new Set([...Object.values(baseline.functions), ...Object.values(baseline.constants)].map(entry => entry.owner))]) {
    const ast = ts.createSourceFile(owner, await readFile(new URL('../' + owner, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node, factory = null) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'createWorkflowObligationCompiler') factory = node.name.text;
      if (ts.isFunctionDeclaration(node)) for (const [key, expected] of Object.entries(baseline.functions)) {
        if (expected.owner === owner && expected.factory === factory && key.endsWith(':' + node.name.text)) {
          assert.equal(hash(printer.printNode(ts.EmitHint.Unspecified, node.body, ast)), expected.sha256, key); seenFunctions.add(key);
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer) for (const [key, expected] of Object.entries(baseline.constants)) {
        if (expected.owner === owner && key.endsWith(':' + node.name.getText(ast))) {
          assert.equal(hash(printer.printNode(ts.EmitHint.Unspecified, node.initializer, ast)), expected.sha256, key); seenConstants.add(key);
        }
      }
      ts.forEachChild(node, child => visit(child, factory));
    }; visit(ast);
  }
  assert.deepEqual([...seenFunctions].sort(), Object.keys(baseline.functions).sort());
  assert.deepEqual([...seenConstants].sort(), Object.keys(baseline.constants).sort());
});

test('rewired callers retain their complete non-import syntax', async () => {
  for (const [file, expected] of Object.entries(baseline.importOnlyBodies)) {
    const ast = ts.createSourceFile(file, await readFile(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const body = ts.factory.updateSourceFile(ast, ast.statements.filter(node => !ts.isImportDeclaration(node)));
    assert.equal(hash(printer.printFile(body)), expected, file);
  }
});

test('native graph APIs and the compiler use one cached rule function; results are never cached', () => {
  assert.equal(obligationModules.graph.compileObligationGraph, compile);
  assert.equal(obligationModules.graph.pinnedObligationGraph, core.pinnedObligationGraph);
  assert.equal(obligationModules.roles.phaseResponsibilities, roles.phaseResponsibilities);
  assert.equal(core.createWorkflowObligationCompiler(records.NODE_TEXT_DIGESTS), compile);
  assert.equal(Object.keys(installed.dependencies).length, 9);
  assert.equal(installed.dependencies.textDigests, records.NODE_TEXT_DIGESTS);
  assert.equal(Object.hasOwn(installed.dependencies, 'compileObligationGraph'), false);
  assert.throws(() => createWorkflowConfigurationCompiler({ ...installed.dependencies, compileObligationGraph: () => ({ ready: true }) }),
    { code: 'ENGINE_CONFIGURATION_COMPILER_INVALID' });
  const input = structuredClone(baseline.graphs[2].input), first = compile(input);
  input.phases.pop();
  assert.notEqual(compile(input).digest, first.digest);
  assert.deepEqual(compile(baseline.graphs[2].input), first);
});

test('digest admission captures no getter or primitive execution and rejects open or mutable capabilities', () => {
  let calls = 0, getter = false;
  const method = text => { calls++; return hash(text); };
  Object.defineProperty(method, 'bind', { get() { throw new Error('a supplied bind accessor must not run'); } });
  const port = Object.freeze({ profile: format.TEXT_DIGEST_PROFILE, sha256Utf8: method });
  const bound = core.createWorkflowObligationCompiler(port);
  assert.equal(calls, 0);
  bound({ phases: [] }); assert.equal(calls, 0);
  bound(baseline.graphs[2].input); assert.equal(calls, 2);
  const accessor = { profile: format.TEXT_DIGEST_PROFILE };
  Object.defineProperty(accessor, 'sha256Utf8', { enumerable: true, get() { getter = true; return hash; } });
  for (const value of [null, {}, { ...port }, Object.freeze(accessor),
    Object.freeze({ ...port, profile: 'unknown/v1' }), Object.freeze({ ...port, ready: true }),
    Object.freeze({ ...port, [Symbol('hidden')]: true }), Object.freeze(Object.create(port))]) {
    assert.throws(() => core.createWorkflowObligationCompiler(value), { code: 'ENGINE_TEXT_DIGEST_PORT_INVALID' });
  }
  assert.equal(getter, false);
});

test('digest results are exact UTF-8 SHA-256 and native errors retain their identity', () => {
  const primitive = format.textDigestCapability(records.NODE_TEXT_DIGESTS);
  assert.equal(primitive.sha256Utf8(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(primitive.sha256Utf8('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const text of ['é', 'e\u0301', '\ud800', '\u0000\n']) assert.equal(primitive.sha256Utf8(text), hash(text));
  assert.throws(() => primitive.sha256Utf8({}), { code: 'ENGINE_TEXT_DIGEST_INPUT_INVALID' });
  for (const value of [null, true, { ready: true }, 'sha256:' + 'a'.repeat(64), 'A'.repeat(64), 'a'.repeat(63)]) {
    const port = Object.freeze({ profile: format.TEXT_DIGEST_PROFILE, sha256Utf8: () => value });
    assert.throws(() => core.createWorkflowObligationCompiler(port)(baseline.graphs[2].input), { code: 'ENGINE_TEXT_DIGEST_RESULT_INVALID' });
  }
  const failure = new Error('native digest unavailable');
  const port = Object.freeze({ profile: format.TEXT_DIGEST_PROFILE, sha256Utf8() { throw failure; } });
  assert.throws(() => core.createWorkflowObligationCompiler(port)(baseline.graphs[2].input), error => error === failure);
});

test('a digest primitive and request readiness fields never waive missing workflow responsibilities', () => {
  const input = { ...baseline.graphs[5].input, ready: true, findings: [], startable: true };
  const port = Object.freeze({ profile: format.TEXT_DIGEST_PROFILE, sha256Utf8: () => '0'.repeat(64) });
  const result = core.createWorkflowObligationCompiler(port)(input);
  assert.equal(core.obligationGraphStartable(result), false);
  assert.ok(result.findings.some(finding => finding.code === 'OBLIGATION_ROUTE_DROPS_RESPONSIBILITY'));
});

test('kernel/foundation rules and the native binding have no repository or process discovery', async () => {
  for (const file of ['src/kernel/workflow-obligations.mjs', 'src/kernel/phase-responsibilities.mjs', 'src/foundation/record-schema.mjs']) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:|process\.|safeCommandGuidance|readFile|createHash/);
  }
  const source = await readFile(new URL('../src/engine-compatibility/node-workflow-obligations.mjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('binding', source, ts.ScriptTarget.Latest, true);
  assert.deepEqual(ast.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text).sort(),
    ['../kernel/workflow-obligations.mjs', '../records.mjs']);
  assert.equal(ast.statements.some(ts.isFunctionDeclaration), false);
});
