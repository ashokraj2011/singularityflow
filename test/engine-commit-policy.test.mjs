import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import * as rules from '../src/kernel/configuration-policy.mjs';
import { PolicyViolation, SingularityFlowError } from '../src/foundation/failures.mjs';
import { REPOSITORY_COMMIT_POLICY_SCHEMAS, textValueSyntax, TEXT_VALUE_SYNTAX_PROFILE } from '../src/foundation/record-schema.mjs';
import { NODE_RECORD_BYTES, NODE_TEXT_VALUE_SYNTAX } from '../src/records.mjs';
import { schemaFamily, migrationRegistrySnapshot } from '../src/schema-migrations.mjs';
import { createWorkflowConfigurationCompiler } from '../src/kernel/workflow-configuration.mjs';
import { captureConfigurationCompiler } from './helpers/configuration-compiler-capture.mjs';
import { commitPolicyResults, commitProfileResults, commitPatternResults, commitMessageResults, commitPolicyModules, declaredPolicy } from './helpers/commit-policy-cases.mjs';

const capture = captureConfigurationCompiler();
let installed;
try { await import('../src/config.mjs'); installed = capture.value; }
finally { capture.close(); }
const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-commit-policy/native-v1.json', import.meta.url), 'utf8'));
const core = rules.createRepositoryCommitPolicyCompiler(NODE_RECORD_BYTES, NODE_TEXT_VALUE_SYNTAX);
const printer = ts.createPrinter({ removeComments: true });
const hash = text => createHash('sha256').update(text).digest('hex');
const semantic = rows => rows.map(row => {
  if (!row.error?.details?.nextAction) return row;
  const { nextAction: _guidance, ...details } = row.error.details;
  return { ...row, error: { ...row.error, constructor: 'PolicyViolation', details } };
});

test('107 original RCP policy/profile/pattern/message cases preserve native values, errors and hashes', () => {
  for (const [run, key] of [[commitPolicyResults, 'policies'], [commitProfileResults, 'profiles'], [commitPatternResults, 'patterns'], [commitMessageResults, 'messages']])
    assert.deepEqual(run(), baseline[key], key);
  assert.deepEqual(Object.fromEntries(Object.entries(commitPolicyModules).map(([name, api]) => [name, Object.keys(api).sort()])), baseline.exports);
  for (const [key, signature] of Object.entries(baseline.functionSignatures)) {
    const [file, name] = key.split(':');
    const fn = commitPolicyModules[path.basename(file, '.mjs')][name];
    assert.equal(fn.name, signature.name, key); assert.equal(fn.length, signature.length, key);
  }
});

test('the kernel performs the same rules while native adapters alone attach command guidance', () => {
  for (const [run, key] of [[commitPolicyResults, 'policies'], [commitProfileResults, 'profiles'], [commitMessageResults, 'messages']])
    assert.deepEqual(run(core), semantic(baseline[key]), key);
  assert.deepEqual(commitPatternResults(rules), baseline.patterns);
  assert.equal(commitPolicyModules.pattern.compileCommitPattern, rules.compileCommitPattern);
  assert.throws(() => core.normalizeCommitPolicy({ unknown: true }), error => {
    assert.ok(error instanceof PolicyViolation); assert.equal(error.code, 'RCP_POLICY_INVALID');
    assert.equal(Object.hasOwn(error.details, 'nextAction'), false); return true;
  });
  assert.throws(() => commitPolicyModules.policy.normalizeCommitPolicy({ unknown: true }), error => {
    assert.equal(error.constructor.name, 'SingularityFlowError');
    assert.equal(error.details.nextAction.copilot, '/sf-git-policy show'); return true;
  });
});

test('original rule bodies and constants retain syntax except explicit primitive/format bindings', async () => {
  const functions = new Set(), constants = new Set();
  for (const file of [...new Set([...Object.values(baseline.functions), ...Object.values(baseline.constants)].map(entry => entry.owner))]) {
    const ast = ts.createSourceFile(file, await readFile(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node, factory = null) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'createRepositoryCommitPolicyCompiler') factory = node.name.text;
      if (ts.isFunctionDeclaration(node)) for (const [key, entry] of Object.entries(baseline.functions)) {
        if (entry.owner === file && entry.factory === factory && key.endsWith(':' + node.name?.text)) {
          let body = printer.printNode(ts.EmitHint.Unspecified, node.body, ast);
          body = body.replaceAll('textSyntax.byteLengthUtf8(', 'Buffer.byteLength(')
            .replace('textSyntax.sha256Utf8(JSON.stringify(sorted(value)))', "createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex')")
            .replaceAll('readPolicyRecord(', 'readRecord(');
          assert.equal(hash(body), entry.sha256, key); functions.add(key);
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer) for (const [key, entry] of Object.entries(baseline.constants)) {
        if (entry.owner === file && entry.factory === factory && key.endsWith(':' + node.name.getText(ast))) {
          assert.equal(hash(printer.printNode(ts.EmitHint.Unspecified, node.initializer, ast)), entry.sha256, key); constants.add(key);
        }
      }
      ts.forEachChild(node, child => visit(child, factory));
    }; visit(ast);
  }
  assert.deepEqual([...functions].sort(), Object.keys(baseline.functions).sort());
  assert.deepEqual([...constants].sort(), Object.keys(baseline.constants).sort());
});

test('both v1 policy schemas and every exported vocabulary value retain their native meaning', () => {
  for (const family of Object.keys(baseline.families)) assert.deepEqual(schemaFamily(family), baseline.families[family]);
  assert.deepEqual(migrationRegistrySnapshot().filter(entry => Object.hasOwn(baseline.families, entry.id)), baseline.registry);
  assert.equal(rules.RCP_SCHEMA_VERSION, REPOSITORY_COMMIT_POLICY_SCHEMAS.policy.currentVersion);
  assert.deepEqual(Object.fromEntries(Object.keys(baseline.vocabulary).map(name => [name, commitPolicyModules.policy[name]])), baseline.vocabulary);
  assert.equal(commitPolicyModules.profile.REGISTERED_COMMIT_CHECKS, rules.REGISTERED_COMMIT_CHECKS);
  assert.equal(rules.createRepositoryCommitPolicyCompiler(NODE_RECORD_BYTES, NODE_TEXT_VALUE_SYNTAX), core);
  assert.equal(Object.isFrozen(core), true);
});

test('text primitives retain exact UTF-8 sizing and native invalid-value exceptions', () => {
  const syntax = textValueSyntax(NODE_TEXT_VALUE_SYNTAX);
  for (const value of ['', 'ascii', 'é', '🧭', '\ud800', new Uint8Array([1, 2])]) {
    assert.equal(syntax.byteLengthUtf8(value), Buffer.byteLength(value));
    assert.equal(syntax.sha256Utf8(value), createHash('sha256').update(value).digest('hex'));
  }
  assert.throws(() => syntax.sha256Utf8(undefined), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('construction captures closed primitive capabilities without calling methods or bind accessors', () => {
  let calls = 0;
  const primitive = () => { calls++; throw new Error('not during capture'); };
  Object.defineProperty(primitive, 'bind', { get() { throw new Error('bind getter'); } });
  const port = Object.freeze({ profile: TEXT_VALUE_SYNTAX_PROFILE, byteLengthUtf8: primitive, sha256Utf8: primitive });
  rules.createRepositoryCommitPolicyCompiler(NODE_RECORD_BYTES, port);
  const syntax = textValueSyntax(port); assert.equal(Object.isFrozen(syntax), true);
  assert.equal(textValueSyntax(port), syntax); assert.equal(calls, 0);
  for (const invalid of [null, {}, { ...port }, Object.freeze({ ...port, extra: true }), Object.freeze({ ...port, profile: 'other' }),
    Object.freeze({ ...port, byteLengthUtf8: false }), Object.freeze(Object.create(port)),
    Object.freeze(Object.defineProperty({ ...port }, 'sha256Utf8', { get() { throw new Error('getter'); } }))])
    assert.throws(() => textValueSyntax(invalid), { code: 'ENGINE_TEXT_VALUE_SYNTAX_INVALID' });
  assert.equal(calls, 0);
  assert.throws(() => textValueSyntax(Object.freeze({ ...port, byteLengthUtf8: () => -1 })).byteLengthUtf8('x'), { code: 'ENGINE_TEXT_VALUE_SYNTAX_RESULT_INVALID' });
  assert.throws(() => textValueSyntax(Object.freeze({ ...port, sha256Utf8: () => 'bad' })).sha256Utf8('x'), { code: 'ENGINE_TEXT_VALUE_SYNTAX_RESULT_INVALID' });
});

test('runtime availability is a no-input assertion and cannot substitute an accepted policy', () => {
  assert.equal(Object.keys(installed.dependencies).length, 8);
  assert.equal(Object.hasOwn(installed.dependencies, 'normalizeCommitPolicyRuntime'), false);
  assert.throws(() => createWorkflowConfigurationCompiler({ ...installed.dependencies, normalizeCommitPolicyRuntime: () => ({ mode: 'off' }) }), { code: 'ENGINE_CONFIGURATION_COMPILER_INVALID' });
  let calls = 0;
  const port = Object.freeze({ profile: rules.COMMIT_POLICY_RUNTIME_PROFILE, assertAvailable() { assert.equal(arguments.length, 0); calls++; } });
  const runtime = rules.commitPolicyRuntimeCompatibility(port);
  assert.equal(calls, 0); runtime.assertAvailable(); assert.equal(calls, 1);
  assert.equal(rules.commitPolicyRuntimeCompatibility(port), runtime);
  assert.throws(() => rules.commitPolicyRuntimeCompatibility(Object.freeze({ ...port, assertAvailable: () => ({ ready: true }) })).assertAvailable(), { code: 'ENGINE_COMMIT_POLICY_RUNTIME_RESULT_INVALID' });
  for (const invalid of [null, {}, { ...port }, Object.freeze({ ...port, extra: true }), Object.freeze({ ...port, profile: 'other' }),
    Object.freeze(Object.defineProperty({ ...port }, 'assertAvailable', { get() { throw new Error('getter'); } }))])
    assert.throws(() => rules.commitPolicyRuntimeCompatibility(invalid), { code: 'ENGINE_COMMIT_POLICY_RUNTIME_INVALID' });
});

test('the actual native availability adapter retains load/ABI failures without invoking validation', async () => {
  const file = 'src/config.mjs';
  const ast = ts.createSourceFile(file, await readFile(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const loader = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'requireCommitPolicyRuntime');
  assert.ok(loader);
  const bind = new Function('process', 'path', 'PACKAGE_ROOT', 'createRequire', 'SingularityFlowError', 'return (' + loader.getText(ast) + ');');
  const frameworkRoot = path.resolve(os.tmpdir(), 'sflow-runtime-adapter-contract');
  let loads = 0, validations = 0;
  const api = { normalizeCommitPolicy() { validations++; } };
  const load = bind({ features: { require_module: true } }, path, frameworkRoot, manifest => {
    assert.equal(manifest, path.join(frameworkRoot, 'package.json'));
    return file => { assert.equal(file, path.join(frameworkRoot, 'src/repository-commit-policy/policy.mjs')); loads++; return api; };
  }, SingularityFlowError);
  assert.equal(load(), api); assert.equal(loads, 1); assert.equal(validations, 0);
  const unavailable = bind({ features: { require_module: false } }, path, frameworkRoot, () => { throw new Error('must not load'); }, SingularityFlowError);
  assert.throws(() => unavailable(), { code: 'RCP_RUNTIME_UNSUPPORTED' });
  const incompatible = bind({ features: { require_module: true } }, path, frameworkRoot, () => () => ({}), SingularityFlowError);
  assert.throws(() => incompatible(), error => error instanceof TypeError && /normalizeCommitPolicy is not a function/u.test(error.message));
  const failure = new Error('genuine loader failure'); failure.code = 'MODULE_NOT_FOUND';
  const failed = bind({ features: { require_module: true } }, path, frameworkRoot, () => () => { throw failure; }, SingularityFlowError);
  assert.throws(() => failed(), error => error === failure);
});

test('RCP normalization and bounded patterns execute without a checkout or Git on PATH', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-commit-policy-independent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rulesUrl = new URL('../src/kernel/configuration-policy.mjs', import.meta.url).href;
  const valuesUrl = new URL('../src/records.mjs', import.meta.url).href;
  const probe = `import assert from 'node:assert/strict';
    const rules=await import(${JSON.stringify(rulesUrl)}),values=await import(${JSON.stringify(valuesUrl)});
    const compiler=rules.createRepositoryCommitPolicyCompiler(values.NODE_RECORD_BYTES,values.NODE_TEXT_VALUE_SYNTAX);
    const policy=compiler.normalizeCommitPolicy(${JSON.stringify(declaredPolicy())});
    assert.equal(compiler.renderCommitMessage(policy,'Change',{trackingKey:'WEB-221'}),'WEB-221: Change');
    assert.equal(rules.compileCommitPattern('^[A-Z]+-[0-9]+$')('WEB-221'),true);
    assert.throws(()=>compiler.normalizeCommitPolicy({mode:'enforce'}),{code:'SCHEMA_VERSION_MISSING'});
    console.log('portable-commit-policy');`;
  const env = { ...process.env, SINGULARITY_FLOW_NO_NETWORK: '1' };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = '';
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '--eval', probe], { cwd: root, env, encoding: 'utf8', timeout: 15000, windowsHide: true }).trim(), 'portable-commit-policy');
  assert.deepEqual(await readdir(root), []);
});
