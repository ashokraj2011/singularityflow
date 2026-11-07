import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import * as core from '../src/kernel/artifact-content.mjs';
import * as identities from '../src/foundation/traceability-ids.mjs';
import * as compatibilityIds from '../src/traceability-ids.mjs';
import * as compatibilityMarkdown from '../src/markdown-structure.mjs';
import * as native from '../src/publication-preflight.mjs';
import * as reader from '../src/artifact-review-read.mjs';
import { artifactContentCases, observeArtifactContent } from './helpers/artifact-content-cases.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
test('26 original parser/grammar/rule bodies and all unchanged public aliases retain identity', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-artifact-content/native-v1.json', import.meta.url), 'utf8'));
  const declarations = new Map();
  for (const file of ['../src/kernel/artifact-content.mjs', '../src/foundation/traceability-ids.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) if (ts.isFunctionDeclaration(node)) declarations.set(node.name.text, node.body.getText(ast));
  }
  for (const [name, expected] of Object.entries(baseline.functions)) assert.equal(hash(declarations.get(name)), expected, name);
  for (const [name, value] of Object.entries(compatibilityIds)) assert.equal(value, identities[name], name);
  for (const [name, value] of Object.entries(compatibilityMarkdown)) assert.equal(value, core[name], name);
  for (const name of ['authoredArtifactText', 'inspectManagedArtifactMetadata', 'maskBlock', 'artifactTextCheckoutMatches',
    'MANAGED_INPUTS', 'MANAGED_METADATA', 'MANAGED_METADATA_MARKER']) assert.equal(reader[name], core[name], name);
  for (const name of ['artifactPlaceholderFindings', 'repairPreparedArtifactMetadata']) assert.equal(native[name], core[name], name);
});

test('37 complete native content, metadata and repair results keep their pre-extraction serialized hashes', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-artifact-content/native-v1.json', import.meta.url), 'utf8'));
  for (const [index, entry] of artifactContentCases().entries()) {
    assert.equal(entry.name, baseline.cases[index].name);
    assert.equal(hash(JSON.stringify(observeArtifactContent(native, entry))), baseline.cases[index].sha256, entry.name);
  }
});

test('portable structural observations and explicit hash facts inspect each custom phase without mutating policy', () => {
  for (const entry of artifactContentCases()) {
    const before = structuredClone(entry), phase = structuredClone(entry.phase);
    phase.authoringBaseline &&= { ...phase.authoringBaseline, fingerprint: reader.authoredArtifactFingerprint(entry.complete) };
    const observation = core.artifactContentObservation(entry.text), fingerprint = 'sha256:' + hash(observation.fingerprintText);
    const contract = core.requiredArtifactContentContract(phase, entry.options);
    const inspected = core.inspectArtifactContentObservation(observation, { path: phase.requiredArtifact.path, contract,
      baseline: phase.authoringBaseline, fingerprint });
    assert.deepEqual(inspected, native.inspectArtifactContent(entry.text, { path: phase.requiredArtifact.path, contract, baseline: phase.authoringBaseline }));
    assert.equal(observation.bytes, Buffer.byteLength(observation.authored)); assert.ok(Object.isFrozen(observation));
    const metadata = phase.authoringBaseline == null ? null : core.inspectManagedArtifactMetadata(entry.text);
    const findings = core.requiredArtifactContentFindings(inspected, { path: phase.requiredArtifact.path, metadata,
      rawBytes: core.artifactMetadataInvalid(metadata) ? Buffer.byteLength(entry.text) : null, placeholders: entry.options.placeholders ?? true });
    assert.deepEqual(findings, native.inspectRequiredArtifactText(entry.text, phase, { path: phase.requiredArtifact.path, ...entry.options }));
    assert.deepEqual(entry, before);
  }
});

test('UTF-8 sizes preserve every UTF-16 code unit, surrogate boundaries and multibyte characters', () => {
  for (let code = 0; code < 65536; code++) {
    const value = String.fromCharCode(code);
    assert.equal(core.utf8Bytes(value), Buffer.byteLength(value), code.toString(16));
  }
  for (const value of ['\ud800\udc00', '\udbff\udfff', '\ud800x\udfff', '\udfff\ud800', '🧭 日本語 e\u0301\r\n', '']) {
    assert.equal(core.utf8Bytes(value), Buffer.byteLength(value));
  }
});

test('multi-member findings keep metadata/authoring priority before member and line order', () => {
  const findings = [
    { code: 'artifact.placeholder.unresolved', path: 'z.md', line: 2 },
    { code: 'artifact.heading.missing', path: 'a.md', line: 1 },
    { code: 'artifact.placeholder.unresolved', path: 'a.md', line: 8 },
    { code: 'artifact.metadata.invalid', path: 'z.md', line: 10 },
    { code: 'artifact.placeholder.unresolved', path: 'a.md', line: 3 }
  ];
  const identity = findings;
  assert.equal(core.sortArtifactFindings(findings, { byPath: true }), identity);
  assert.deepEqual(findings.map(finding => [finding.code, finding.path, finding.line]), [
    ['artifact.metadata.invalid', 'z.md', 10], ['artifact.placeholder.unresolved', 'a.md', 3],
    ['artifact.placeholder.unresolved', 'a.md', 8], ['artifact.placeholder.unresolved', 'z.md', 2],
    ['artifact.heading.missing', 'a.md', 1]
  ]);
});

test('binary contracts use exact observed sizes and refuse text-only obligations or malformed byte facts', () => {
  const phase = { requiredArtifact: { minimumBytes: 10, maximumBytes: 20 } };
  assert.deepEqual(core.inspectBinaryArtifactSize(15, phase, { path: 'data.bin' }), []);
  assert.equal(core.inspectBinaryArtifactSize(9, phase, { path: 'data.bin' })[0].code, 'artifact.required.too-short');
  assert.equal(core.inspectBinaryArtifactSize(21, phase, { path: 'data.bin' })[0].code, 'artifact.required.too-large');
  assert.deepEqual(core.inspectBinaryArtifactSize(0, phase, { path: 'data.bin', minimumBytes: false }), []);
  phase.requiredArtifact.validation = { requiredHeadings: ['Overview'] };
  assert.equal(core.inspectBinaryArtifactSize(15, phase, { path: 'data.bin' })[0].code, 'artifact.binary.text-contract');
  for (const bytes of [-1, Infinity, NaN, '15']) assert.throws(() => core.inspectBinaryArtifactSize(bytes, phase), { code: 'ARTIFACT_OBSERVATION_INVALID' });
  const observation = core.artifactContentObservation('A complete result.');
  for (const fingerprint of [undefined, null, 'invalid', {}, 'sha256:' + 'x'.repeat(64)]) assert.throws(
    () => core.inspectArtifactContentObservation(observation, { fingerprint }), { code: 'ARTIFACT_OBSERVATION_INVALID' });
});

test('all structural/authoring checks execute without filesystem, hashing, processes or provider imports', () => {
  const url = new URL('../src/kernel/artifact-content.mjs', import.meta.url).href;
  const source = `
    import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('node:'))throw new Error(specifier);return next(specifier,context);}});
    const core=await import(${JSON.stringify(url)}),text='# Result\\n\\n## Overview\\nTODO\\n';
    const observation=core.artifactContentObservation(text);
    const inspected=core.inspectArtifactContentObservation(observation,{contract:{minimumBytes:1},fingerprint:'sha256:'+'a'.repeat(64)});
    if(!inspected.findings.some(finding=>finding.code==='artifact.placeholder.unresolved'))throw new Error('missing marker');
    if(core.inspectManagedArtifactMetadata(text).status!=='missing')throw new Error('metadata');
    if(core.inspectBinaryArtifactSize(5,{requiredArtifact:{minimumBytes:1}}).length)throw new Error('binary');
    hook.deregister();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
