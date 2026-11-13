import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import * as policy from '../src/kernel/configuration-policy.mjs';
import * as phases from '../src/kernel/phase-policy.mjs';
import { APPLICATION_REVIEW_POLICY_SCHEMA, admitRecordSchemaVersion, recordJsonSyntax, RECORD_BYTES_PROFILE, recordReadTargetVersion } from '../src/foundation/record-schema.mjs';
import { NODE_RECORD_BYTES } from '../src/records.mjs';
import { schemaFamily, migrationRegistrySnapshot } from '../src/schema-migrations.mjs';
import { createWorkflowConfigurationCompiler } from '../src/kernel/workflow-configuration.mjs';
import { captureConfigurationCompiler } from './helpers/configuration-compiler-capture.mjs';
import { applicationReviewPolicyResults, applicationReviewPhaseResults, reviewRecordSyntaxResults, reviewPolicyModules } from './helpers/application-review-policy-cases.mjs';

const capture = captureConfigurationCompiler();
let installed;
try { await import('../src/config.mjs'); installed = capture.value; }
finally { capture.close(); }
const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-application-review-policy/native-v1.json', import.meta.url), 'utf8'));
const normalizeApplicationReview = policy.createApplicationReviewPolicyValidator(NODE_RECORD_BYTES);
const printer = ts.createPrinter({ removeComments: true });
const digest = node => createHash('sha256').update(node).digest('hex');

test('54 captured application-review policies preserve normalization, defaults, exact errors and hashes', () => {
  assert.deepEqual(applicationReviewPolicyResults(), baseline.policies);
  assert.deepEqual(applicationReviewPolicyResults({ normalizeApplicationReview }), baseline.policies);
  assert.deepEqual(Object.fromEntries(Object.entries(reviewPolicyModules).map(([name, module]) => [name, Object.keys(module).sort()])), baseline.exports);
  assert.deepEqual(Object.fromEntries(Object.keys(baseline.vocabulary).map(name => [name, reviewPolicyModules.native[name]])), baseline.vocabulary);
});

test('phase selection, pinned authoring and test scope retain all 17 captured results', () => {
  assert.deepEqual(applicationReviewPhaseResults(), baseline.phases);
  assert.deepEqual(applicationReviewPhaseResults(phases), baseline.phases);
  for (const name of ['storyTestScope', 'workflowCodeGeneration', 'configuredAuthoringSkill', 'applicationReviewPhase', 'TEST_SCOPES'])
    assert.equal(reviewPolicyModules.native[name], phases[name], name);
});

test('one byte-value reader preserves all 24 record cases and native schema-registry metadata', () => {
  assert.deepEqual(reviewRecordSyntaxResults(), baseline.records);
  const syntax = recordJsonSyntax(NODE_RECORD_BYTES);
  assert.deepEqual(reviewRecordSyntaxResults(value => admitRecordSchemaVersion(APPLICATION_REVIEW_POLICY_SCHEMA, syntax.parseObject(value))), baseline.records);
  assert.deepEqual(schemaFamily('application-review-policy'), baseline.schema);
  assert.deepEqual(migrationRegistrySnapshot().find(entry => entry.id === APPLICATION_REVIEW_POLICY_SCHEMA.id), baseline.registry);
  assert.equal(policy.ARA_VERSION, APPLICATION_REVIEW_POLICY_SCHEMA.currentVersion);
});

test('relocated rule bodies and defaults are unchanged apart from explicit schema-reader binding', async () => {
  const functions = new Set(), constants = new Set();
  for (const file of [...new Set([...Object.values(baseline.functions), ...Object.values(baseline.constants)].map(entry => entry.owner))]) {
    const ast = ts.createSourceFile(file, await readFile(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isFunctionDeclaration(node) && baseline.functions[node.name?.text]?.owner === file) {
        let body = printer.printNode(ts.EmitHint.Unspecified, node.body, ast);
        if (node.name.text === 'normalizeApplicationReview') {
          const boundary = 'admitRecordSchemaVersion(APPLICATION_REVIEW_POLICY_SCHEMA, syntax.parseObject(value));';
          assert.equal(body.split(boundary).length, 2, 'only the original reader call changes');
          body = body.replace(boundary, "readRecord('application-review-policy', value);");
        }
        assert.equal(digest(body), baseline.functions[node.name.text].sha256, node.name.text);
        functions.add(node.name.text);
      }
      if (ts.isVariableDeclaration(node) && baseline.constants[node.name.getText(ast)]?.owner === file) {
        const name = node.name.getText(ast);
        assert.equal(digest(printer.printNode(ts.EmitHint.Unspecified, node.initializer, ast)), baseline.constants[name].sha256, name);
        constants.add(name);
      }
      ts.forEachChild(node, visit);
    }; visit(ast);
  }
  assert.deepEqual([...functions].sort(), Object.keys(baseline.functions).sort());
  assert.deepEqual([...constants].sort(), Object.keys(baseline.constants).sort());
});

test('native version migration still executes its original deterministic reader after shared parsing', async () => {
  const file = 'src/schema-migrations.mjs';
  const ast = ts.createSourceFile(file, await readFile(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const reader = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readRecord');
  // The earlier preservation-profile extraction delegates this one target expression to foundation.
  // Keep the original reader fingerprint, with that exact, separately checked substitution only.
  const body=printer.printNode(ts.EmitHint.Unspecified,reader.body,ast),target='recordReadTargetVersion(entry, storedVersion)';
  assert.equal(body.split(target).length,2);
  assert.equal(digest(body.replace(target,'entry.currentVersion')),baseline.nativeRecordReader.readRecord.sha256);
  assert.equal(recordReadTargetVersion({currentVersion:2,migrationPolicy:'migrate-on-read'},1),2);
  assert.equal(recordReadTargetVersion({currentVersion:2,migrationPolicy:'preserve-versions'},1),1);
  assert.equal(recordReadTargetVersion({currentVersion:2,migrationPolicy:'preserve-versions'},2),2);
  const parser = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'parsedRecord');
  assert.equal(parser.body.statements.length, 1);
  assert.equal(parser.body.statements[0].expression.getText(ast), 'recordSyntax.parseObject(rawBytes)');
});

test('the configuration compiler owns policy admission and accepts syntax, not a replacement validator', () => {
  assert.equal(Object.hasOwn(installed.dependencies, 'normalizeApplicationReview'), false);
  assert.equal(installed.dependencies.recordBytes, NODE_RECORD_BYTES);
  assert.throws(() => createWorkflowConfigurationCompiler({ ...installed.dependencies, normalizeApplicationReview: () => ({ mode: 'off' }) }),
    { code: 'ENGINE_CONFIGURATION_COMPILER_INVALID' });
  assert.equal(reviewPolicyModules.native.normalizeApplicationReview, normalizeApplicationReview);
  assert.equal(reviewPolicyModules.facade.normalizeApplicationReview, normalizeApplicationReview);
  assert.equal(policy.createApplicationReviewPolicyValidator(NODE_RECORD_BYTES), normalizeApplicationReview);
});

test('byte capabilities are immutable closed values and construction invokes no primitive or bind getter', () => {
  let calls = 0;
  const primitive = () => { calls++; throw new Error('not at construction'); };
  Object.defineProperty(primitive, 'bind', { get() { throw new Error('bind getter'); } });
  const valid = Object.freeze({ profile: RECORD_BYTES_PROFILE, isBytes: primitive, decodeUtf8: primitive });
  const syntax = recordJsonSyntax(valid);
  policy.createApplicationReviewPolicyValidator(valid);
  assert.equal(recordJsonSyntax(valid), syntax);
  assert.equal(Object.isFrozen(syntax), true);
  assert.equal(calls, 0);
  const invalid = [null, {}, { ...valid }, Object.freeze({ ...valid, profile: 'other' }),
    Object.freeze({ ...valid, extra: true }), Object.freeze({ ...valid, isBytes: null }),
    Object.freeze(Object.create(valid)), Object.freeze(Object.defineProperty({ ...valid }, 'isBytes', { get() { throw new Error('accessor'); } })),
    Object.freeze(Object.defineProperty({ ...valid }, 'decodeUtf8', { value: primitive, enumerable: false }))];
  for (const value of invalid) assert.throws(() => recordJsonSyntax(value), { code: 'ENGINE_RECORD_BYTES_PORT_INVALID' });
  assert.equal(calls, 0);
});

test('syntax cannot weaken policy fields, mutate input records or conceal actual byte errors', () => {
  const input = { quality: ['check output'], capture: { viewport: { width: 1200, height: 800 } } };
  const parsed = recordJsonSyntax(NODE_RECORD_BYTES).parseObject(input);
  parsed.capture.viewport.width = 2000;
  assert.equal(input.capture.viewport.width, 1200);
  const fake = Object.freeze({ profile: RECORD_BYTES_PROFILE, isBytes: () => false, decodeUtf8: () => '{}' });
  const normalize = policy.createApplicationReviewPolicyValidator(fake);
  assert.throws(() => normalize({ mode: 'approved' }), { code: 'ARA_POLICY_INVALID' });
  assert.throws(() => normalize({ schemaVersion: 2 }), { code: 'SCHEMA_VERSION_FUTURE' });
  assert.throws(() => normalize({ approvedBy: 'model' }), { code: 'ARA_INPUT_INVALID' });
  assert.throws(() => recordJsonSyntax(Object.freeze({ ...fake, isBytes: () => 1 })).parseObject(new Uint8Array()), { code: 'ENGINE_RECORD_BYTES_RESULT_INVALID' });
  assert.throws(() => recordJsonSyntax(Object.freeze({ ...fake, isBytes: () => true, decodeUtf8: () => null })).parseObject(new Uint8Array()), { code: 'ENGINE_RECORD_BYTES_RESULT_INVALID' });
  const failure = new Error('genuine byte failure');
  assert.throws(() => recordJsonSyntax(Object.freeze({ ...fake, isBytes: () => true, decodeUtf8() { throw failure; } })).parseObject(new Uint8Array()), error => error === failure);
});

test('policy execution needs no checkout, Git executable, native registry or machine state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-policy-independent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyUrl = new URL('../src/kernel/configuration-policy.mjs', import.meta.url).href;
  const formatUrl = new URL('../src/foundation/record-schema.mjs', import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';
    const {createApplicationReviewPolicyValidator} = await import(${JSON.stringify(policyUrl)});
    const {recordJsonSyntax,RECORD_BYTES_PROFILE} = await import(${JSON.stringify(formatUrl)});
    const bytes=Object.freeze({profile:RECORD_BYTES_PROFILE,
      isBytes:value=>Buffer.isBuffer(value)||value instanceof Uint8Array,
      decodeUtf8:value=>Buffer.from(value).toString('utf8')});
    const normalize=createApplicationReviewPolicyValidator(bytes);
    const input=recordJsonSyntax(bytes).parseObject(Buffer.from('{"mode":"required","surface":"backend"}'));
    const policy=normalize(input);
    assert.equal(policy.schemaVersion,1);
    assert.equal(policy.surface,'backend');
    assert.equal(policy.mode,'required');
    assert.throws(()=>normalize({mode:'approved'}),{code:'ARA_POLICY_INVALID'});
    assert.throws(()=>normalize({schemaVersion:2}),{code:'SCHEMA_VERSION_FUTURE'});
    console.log('portable-policy');
  `;
  const env = { ...process.env, SINGULARITY_FLOW_NO_NETWORK: '1' };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = '';
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '--eval', probe],
    { cwd: root, env, encoding: 'utf8', timeout: 15000, windowsHide: true }).trim(), 'portable-policy');
  assert.deepEqual(await readdir(root), []);
});
