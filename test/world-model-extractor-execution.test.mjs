import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compareText, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import {
  createCompletenessRecordFromExtractionExecution, validateExtractionExecutionReceipt
} from '../src/world-model/extract/index.mjs';
import {
  extractChangeRegions
} from '../src/world-model/extract/adapters/change-region.mjs';
import {
  scanRuleObjectsWithLimitations
} from '../src/world-model/extract/adapters/rule-definition.mjs';
import {
  runDeterministicRegistration as runRegistration
} from '../src/world-model/extract/runner.mjs';
import {
  scanProtocolFieldsWithLimitations
} from '../src/world-model/extract/adapters/closed-structure.mjs';
import {
  BUILTIN_EXTRACTOR_REGISTRY, resolveExtractorExecutionContract,
  resolveExtractorManifest
} from '../src/world-model/registry/extractors.mjs';
import {
  BUILTIN_VIEW_REGISTRY, resolveViewContract
} from '../src/world-model/registry/views.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import {
  createDiscoveredCandidateRoster, createExactSourceSnapshot, worldModelSourceGitTimeoutClass
} from '../src/world-model/source/snapshot.mjs';
import {
  validateWorldModelDiscoveredCandidateRoster
} from '../src/world-model/history/candidate-roster-owner.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runDeterministicRegistration(options) {
  return runRegistration({ ...options, captureExtractorExecutions: true });
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-execution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'extractor-execution@example.invalid');
  git(root, 'config', 'user.name', 'Extractor Execution');
  await mkdir(path.join(root, '.github'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, '.github', 'CODEOWNERS'), [
    'src/* @fixture/owners',
    'bad\\ path @fixture/owners',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'README.md'), '# execution fixture\n');
  await writeFile(path.join(root, 'src', 'empty.js'), 'void 0;\n');
  await writeFile(path.join(root, 'src', 'invalid.js'), Buffer.from([0xff, 0xfe]));
  await writeFile(path.join(root, 'test', 'unsupported.swift'), 'func example() {}\n');
  await symlink('../README.md', path.join(root, 'src', 'link.js'));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'execution fixture');
  return root;
}

function scope() {
  return createScopeManifest({
    capabilityId: 'extractor-execution',
    allowedPaths: ['**'],
    allowedSubjects: [
      'analysis', 'configuration', 'contract', 'dependency-edge', 'file', 'human-record',
      'rule', 'symbol', 'test'
    ]
  });
}

function manifest(reference) {
  return resolveExtractorManifest(BUILTIN_EXTRACTOR_REGISTRY, reference);
}

test('current execution coverage is fixed by the exact installed manifest', () => {
  const nonExecutable = new Set(['legacy-migration-resolution']);
  for (const value of BUILTIN_EXTRACTOR_REGISTRY.manifests) {
    if (nonExecutable.has(value.id)) {
      assert.throws(
        () => resolveExtractorExecutionContract(value),
        (error) => error?.code === 'WMB_EXTRACTOR_EXECUTION_BOUNDARY_MISSING'
      );
      continue;
    }
    const contract = resolveExtractorExecutionContract(value);
    const globals = new Set([
      'change-region', 'human-confirmed-knowledge-import',
      'required-fact-coverage', 'runtime-observation-import'
    ]);
    assert.equal(contract.coverage, globals.has(value.id) ? 'global' : 'path', value.id);
    assert.equal(contract.manifestSha256, value.manifestSha256);
    assert.equal(Object.isFrozen(contract), true);
  }

  const original = manifest('signature-and-export@1.0.0');
  const changed = structuredClone(original);
  changed.languages = [...changed.languages, 'invented-language'].sort();
  delete changed.manifestSha256;
  const resealed = sealRecord(changed, 'manifestSha256');
  assert.throws(
    () => resolveExtractorExecutionContract(resealed),
    (error) => error?.code === 'WMB_EXTRACTOR_EXECUTION_BOUNDARY_MISMATCH'
  );
});

test('ordinary registration does not allocate per-path execution rows before production activation', async (t) => {
  const root = await repository(t);
  const registration = runRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: ['repository-files@1.0.0']
  });
  assert.equal(Object.hasOwn(registration, 'extractorExecutions'), false);
  assert.equal(Object.hasOwn(registration, 'resolvedViewContracts'), false);
  assert.equal(Object.hasOwn(registration, 'extractionExecutionReceipt'), false);
});

test('capture freezes only its retained View Contracts, not a caller-owned registry', async (t) => {
  const root = await repository(t);
  const callerRegistry = structuredClone(BUILTIN_VIEW_REGISTRY);
  const callerContract = callerRegistry.contracts.find((entry) => entry.id === 'biz.rules');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: ['repository-files@1.0.0'],
    requestedViews: ['biz.rules@4'],
    viewRegistry: callerRegistry
  });

  assert.equal(Object.isFrozen(callerRegistry), false);
  assert.equal(Object.isFrozen(callerContract), false);
  assert.equal(Object.isFrozen(registration.resolvedViewContracts[0]), true);
  assert.notEqual(registration.resolvedViewContracts[0], callerContract);
});

test('path execution records zero-fact success, parse failure, non-applicability, and symlinks', async (t) => {
  const root = await repository(t);
  const signature = manifest('signature-and-export@1.0.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${signature.id}@${signature.version}`]
  });
  assert.equal(registration.extractorExecutions.length, 1);
  const execution = registration.extractorExecutions[0];
  assert.equal(execution.coverage, 'path');
  assert.equal(execution.globalOutcome, null);
  assert.equal(Object.isFrozen(execution), true);
  assert.equal(Object.isFrozen(execution.pathOutcomes), true);
  assert.equal(Object.isFrozen(registration.extractionExecutionReceipt), true);
  assert.equal(
    validateExtractionExecutionReceipt(registration.extractionExecutionReceipt),
    registration.extractionExecutionReceipt
  );
  assert.equal(
    registration.extractionExecutionReceipt.sourceManifestSha256,
    registration.sourceSnapshot.sourceManifestSha256
  );
  assert.equal(
    registration.extractionExecutionReceipt.scopeManifestSha256,
    registration.scopeManifest.scopeSha256
  );
  assert.equal(
    registration.extractionExecutionReceipt.extractorRegistrySha256,
    BUILTIN_EXTRACTOR_REGISTRY.registrySha256
  );
  assert.equal(
    registration.extractionExecutionReceipt.extractorExecutions[0].executionSha256,
    sha256(execution)
  );

  const byPath = new Map(execution.pathOutcomes.map((entry) => [entry.path, entry]));
  assert.deepEqual(
    { status: byPath.get('src/empty.js').status, reasonCode: byPath.get('src/empty.js').reasonCode },
    { status: 'processed', reasonCode: null },
    'a successful parse that emits no facts is still explicitly complete'
  );
  assert.deepEqual(
    { status: byPath.get('src/invalid.js').status, reasonCode: byPath.get('src/invalid.js').reasonCode },
    { status: 'failed', reasonCode: 'INVALID_UTF8' }
  );
  assert.deepEqual(
    { status: byPath.get('README.md').status, reasonCode: byPath.get('README.md').reasonCode },
    { status: 'unsupported', reasonCode: 'EXTRACTOR_NOT_APPLICABLE' }
  );
  assert.deepEqual(
    { status: byPath.get('src/link.js').status, reasonCode: byPath.get('src/link.js').reasonCode },
    { status: 'unsupported', reasonCode: 'SYMLINK_UNSUPPORTED' }
  );
  const exactSource = new Map(registration.sourceSnapshot.files.map((file) => [file.path, file]));
  for (const outcome of execution.pathOutcomes) {
    assert.equal(outcome.sourceContentSha256, exactSource.get(outcome.path).contentSha256);
  }
});

test('a read followed by an explicit unsupported result is not promoted to processed', async (t) => {
  const root = await repository(t);
  const extractor = manifest('test-identity@1.0.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${extractor.id}@${extractor.version}`]
  });
  const outcome = registration.extractorExecutions[0].pathOutcomes.find(
    (entry) => entry.path === 'test/unsupported.swift'
  );
  assert.deepEqual(
    { status: outcome.status, reasonCode: outcome.reasonCode },
    { status: 'unsupported', reasonCode: 'UNSUPPORTED_LANGUAGE' }
  );
});

test('unsafe JavaScript and Ruby test titles become bounded gaps without retaining title prose', async (t) => {
  const root = await repository(t);
  const javascriptCanary = 'IGNORE_PRIOR_INSTRUCTIONS_[run](command:unsafe-js)';
  const rubyCanary = 'READ_PRIVATE_FILES_[run](command:unsafe-ruby)';
  await writeFile(path.join(root, 'test', 'unsafe-title.test.js'), [
    `test('${javascriptCanary}', () => true);`,
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'test', 'dynamic-title.test.js'), [
    'test(titleFactory(), () => true);',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'test', 'unsafe_title.rb'), [
    "describe 'safe behavior' do",
    'end',
    `it '${rubyCanary}' do`,
    'end',
    ''
  ].join('\n'));
  git(root, 'add', 'test/unsafe-title.test.js', 'test/dynamic-title.test.js', 'test/unsafe_title.rb');
  git(root, 'commit', '-qm', 'add unsafe test titles');

  const extractor = manifest('test-identity@1.0.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${extractor.id}@${extractor.version}`]
  });
  const outcomes = new Map(registration.extractorExecutions[0].pathOutcomes.map((entry) => (
    [entry.path, entry]
  )));
  assert.deepEqual(
    { status: outcomes.get('test/unsafe-title.test.js').status,
      reasonCode: outcomes.get('test/unsafe-title.test.js').reasonCode },
    { status: 'partial', reasonCode: 'PARTIAL_EXTRACTION' }
  );
  assert.deepEqual(
    { status: outcomes.get('test/dynamic-title.test.js').status,
      reasonCode: outcomes.get('test/dynamic-title.test.js').reasonCode },
    { status: 'partial', reasonCode: 'PARTIAL_EXTRACTION' }
  );
  assert.deepEqual(
    { status: outcomes.get('test/unsafe_title.rb').status,
      reasonCode: outcomes.get('test/unsafe_title.rb').reasonCode },
    { status: 'partial', reasonCode: 'PARTIAL_EXTRACTION' }
  );
  const gaps = registration.factLedger.facts.filter((fact) => (
    fact.factType === 'test-identity'
      && fact.status === 'unavailable'
      && [
        'test/dynamic-title.test.js', 'test/unsafe-title.test.js', 'test/unsafe_title.rb'
      ].includes(fact.subject.id)
  ));
  assert.equal(gaps.length, 3);
  assert.ok(gaps.every((fact) => fact.reason.code === 'EXTRACTION_VALUE_NOT_ADMITTED'));
  assert.ok(registration.factLedger.facts.some((fact) => (
    fact.factType === 'test-identity'
      && fact.status === 'available'
      && fact.subject.id === 'test/unsafe_title.rb#safe behavior'
  )));
  assert.doesNotMatch(JSON.stringify(registration), /IGNORE_PRIOR_INSTRUCTIONS|READ_PRIVATE_FILES|command:unsafe/);
});

test('overlong closed signatures produce one bounded gap and a partial path', async (t) => {
  const root = await repository(t);
  const rejectedCanary = 'SHOULD_NOT_BE_RETAINED';
  const parameters = Array.from(
    { length: 24 }, (_, index) => `parameter${index}${rejectedCanary}: string`
  ).join(', ');
  await writeFile(path.join(root, 'src', 'long-signature.ts'), [
    'export function retained(): void;',
    `export function rejected(${parameters}): void;`,
    ''
  ].join('\n'));
  git(root, 'add', 'src/long-signature.ts');
  git(root, 'commit', '-qm', 'add overlong signature');

  const extractor = manifest('signature-and-export@1.0.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${extractor.id}@${extractor.version}`]
  });
  const outcome = registration.extractorExecutions[0].pathOutcomes.find(
    (entry) => entry.path === 'src/long-signature.ts'
  );
  assert.deepEqual(
    { status: outcome.status, reasonCode: outcome.reasonCode },
    { status: 'partial', reasonCode: 'PARTIAL_EXTRACTION' }
  );
  const gap = registration.factLedger.facts.find((fact) => (
    fact.factType === 'signature'
      && fact.status === 'unavailable'
      && fact.subject.id === 'src/long-signature.ts'
  ));
  assert.equal(gap.reason.code, 'EXTRACTION_LIMIT_REACHED');
  assert.ok(registration.factLedger.facts.some((fact) => (
    fact.factType === 'signature'
      && fact.status === 'available'
      && fact.subject.id === 'src/long-signature.ts#retained'
  )));
  assert.doesNotMatch(JSON.stringify(registration), new RegExp(rejectedCanary));
});

test('overlong protocol fields return a closed limitation and partial path without rejected text', async (t) => {
  const rejectedCanary = 'PROTOCOL_TEXT_MUST_NOT_ESCAPE';
  const parameters = Array.from(
    { length: 20 }, (_, index) => `parameter${index}${rejectedCanary}: string`
  ).join(', ');
  const source = [
    'export interface Service {',
    `  execute(${parameters}): void;`,
    '}',
    ''
  ].join('\n');
  const scan = scanProtocolFieldsWithLimitations(source, 'typescript');
  assert.deepEqual(scan.items, []);
  assert.deepEqual(scan.limitations, [{ code: 'EXTRACTION_LIMIT_REACHED', line: 2 }]);
  assert.doesNotMatch(JSON.stringify(scan), new RegExp(rejectedCanary));

  const root = await repository(t);
  await writeFile(path.join(root, 'src', 'long-interface.ts'), source);
  git(root, 'add', 'src/long-interface.ts');
  git(root, 'commit', '-qm', 'add overlong protocol field');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: ['interface-contract@1.1.0']
  });
  const outcome = registration.extractorExecutions[0].pathOutcomes.find(
    (entry) => entry.path === 'src/long-interface.ts'
  );
  assert.deepEqual(
    { status: outcome.status, reasonCode: outcome.reasonCode },
    { status: 'partial', reasonCode: 'PARTIAL_EXTRACTION' }
  );
  assert.equal(registration.factLedger.facts.some(
    (fact) => fact.reason?.code === 'EXTRACTION_LIMIT_REACHED'
  ), true);
  assert.doesNotMatch(JSON.stringify(registration), new RegExp(rejectedCanary));
});

test('a file with useful output and a parse gap is reported as partial', async (t) => {
  const root = await repository(t);
  const extractor = manifest('ownership-maintainer-record@1.0.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${extractor.id}@${extractor.version}`]
  });
  const outcome = registration.extractorExecutions[0].pathOutcomes.find(
    (entry) => entry.path === '.github/CODEOWNERS'
  );
  assert.deepEqual(
    { status: outcome.status, reasonCode: outcome.reasonCode },
    { status: 'partial', reasonCode: 'PARTIAL_EXTRACTION' }
  );
});

test('file-scoped analysis failures close their exact path even when the Fact subject is qualified', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'src', 'oversized#source.js'), 'x'.repeat((512 * 1024) + 1));
  git(root, 'add', 'src/oversized#source.js');
  git(root, 'commit', '-qm', 'add oversized source');
  const extractor = manifest('call-reference-edge@1.0.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${extractor.id}@${extractor.version}`]
  });
  const outcome = registration.extractorExecutions[0].pathOutcomes.find(
    (entry) => entry.path === 'src/oversized#source.js'
  );
  assert.deepEqual(
    { status: outcome.status, reasonCode: outcome.reasonCode },
    { status: 'failed', reasonCode: 'PARSE_FAILURE' }
  );
});

test('rule extraction does not report malformed generic configuration as processed', async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config', 'settings.json'), '{ invalid json\n');
  git(root, 'add', 'config/settings.json');
  git(root, 'commit', '-qm', 'add malformed generic configuration');
  const extractor = manifest('rule-definition@1.0.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${extractor.id}@${extractor.version}`]
  });
  const outcome = registration.extractorExecutions[0].pathOutcomes.find(
    (entry) => entry.path === 'config/settings.json'
  );
  assert.deepEqual(
    { status: outcome.status, reasonCode: outcome.reasonCode },
    { status: 'failed', reasonCode: 'PARSE_FAILURE' }
  );
});

test('bounded rule extraction caps items and reports partial coverage at its depth limit', async (t) => {
  const bounded = scanRuleObjectsWithLimitations({
    rules: Object.fromEntries(Array.from(
      { length: 1_001 }, (_, index) => [`rule-${String(index).padStart(4, '0')}`, { when: true }]
    ))
  });
  assert.equal(bounded.rules.length, 1_000);
  assert.equal(bounded.truncated, true);

  const root = await repository(t);
  await mkdir(path.join(root, 'config'), { recursive: true });
  const nested = {};
  let cursor = nested;
  for (let index = 0; index < 10; index += 1) {
    cursor[`level-${index}`] = {};
    cursor = cursor[`level-${index}`];
  }
  await writeFile(path.join(root, 'config', 'rules.json'), `${JSON.stringify({
    rules: {
      retained: { when: true },
      'RULE_IDENTIFIER_MUST_NOT_ESCAPE [unsafe]': { when: true }
    },
    nested
  })}\n`);
  git(root, 'add', 'config/rules.json');
  git(root, 'commit', '-qm', 'add bounded rule inventory');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: ['rule-definition@1.0.0']
  });
  const outcome = registration.extractorExecutions[0].pathOutcomes.find(
    (entry) => entry.path === 'config/rules.json'
  );
  assert.deepEqual(
    { status: outcome.status, reasonCode: outcome.reasonCode },
    { status: 'partial', reasonCode: 'PARTIAL_EXTRACTION' }
  );
  assert.equal(registration.factLedger.facts.some(
    (fact) => fact.reason?.code === 'EXTRACTION_LIMIT_REACHED'
  ), true);
  assert.equal(registration.factLedger.facts.some(
    (fact) => fact.reason?.code === 'EXTRACTION_VALUE_NOT_ADMITTED'
  ), true);
  assert.doesNotMatch(JSON.stringify(registration), /RULE_IDENTIFIER_MUST_NOT_ESCAPE/);
});

test('closed lexical configuration refuses unrecognized lines instead of claiming full processing', async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config', 'settings.properties'), 'good=1\nweird key=2\n');
  git(root, 'add', 'config/settings.properties');
  git(root, 'commit', '-qm', 'add configuration outside closed grammar');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: ['configuration-object@1.0.0']
  });
  const outcome = registration.extractorExecutions[0].pathOutcomes.find(
    (entry) => entry.path === 'config/settings.properties'
  );
  assert.deepEqual(
    { status: outcome.status, reasonCode: outcome.reasonCode },
    { status: 'failed', reasonCode: 'PARSE_FAILURE' }
  );
});

test('interface extraction reports an explicit gap for schema-named lexical configuration', async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, 'schemas'), { recursive: true });
  await writeFile(
    path.join(root, 'schemas', 'service.schema.properties'),
    'kind=record\nname=Thing\n'
  );
  git(root, 'add', 'schemas/service.schema.properties');
  git(root, 'commit', '-qm', 'add lexical schema configuration');
  const extractor = manifest('interface-contract@1.1.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${extractor.id}@${extractor.version}`]
  });
  const outcome = registration.extractorExecutions[0].pathOutcomes.find(
    (entry) => entry.path === 'schemas/service.schema.properties'
  );
  assert.deepEqual(
    { status: outcome.status, reasonCode: outcome.reasonCode },
    { status: 'unsupported', reasonCode: 'UNSUPPORTED_LANGUAGE' }
  );
});

test('schema extraction reports partial coverage for unsafe or over-limit property names', async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, 'schemas'), { recursive: true });
  const properties = Object.fromEntries(Array.from(
    { length: 257 }, (_, index) => [`field-${String(index).padStart(3, '0')}`, { type: 'string' }]
  ));
  properties['unsafe field'] = { type: 'string' };
  await writeFile(
    path.join(root, 'schemas', 'service.schema.json'),
    `${JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', properties })}\n`
  );
  git(root, 'add', 'schemas/service.schema.json');
  git(root, 'commit', '-qm', 'add bounded schema inventory');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: ['interface-contract@1.1.0']
  });
  const outcome = registration.extractorExecutions[0].pathOutcomes.find(
    (entry) => entry.path === 'schemas/service.schema.json'
  );
  assert.deepEqual(
    { status: outcome.status, reasonCode: outcome.reasonCode },
    { status: 'partial', reasonCode: 'PARTIAL_EXTRACTION' }
  );
  assert.equal(registration.factLedger.facts.some(
    (fact) => fact.reason?.code === 'EXTRACTION_LIMIT_REACHED'
  ), true);
  assert.equal(registration.factLedger.facts.some(
    (fact) => fact.reason?.code === 'EXTRACTION_VALUE_NOT_ADMITTED'
  ), true);
});

test('global extractors publish an explicit terminal result instead of fabricated path coverage', async (t) => {
  const root = await repository(t);
  const change = manifest('change-region@1.0.0');
  const firstCommit = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${change.id}@${change.version}`]
  }).extractorExecutions[0];
  assert.equal(firstCommit.coverage, 'global');
  assert.deepEqual(firstCommit.pathOutcomes, []);
  assert.deepEqual(firstCommit.globalOutcome, {
    status: 'unsupported', reasonCode: 'NO_BASELINE'
  });

  const runtime = manifest('runtime-observation-import@1.0.0');
  const unavailableInput = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${runtime.id}@${runtime.version}`]
  }).extractorExecutions[0];
  assert.deepEqual(unavailableInput.globalOutcome, {
    status: 'unsupported', reasonCode: 'EXTRACTOR_NOT_APPLICABLE'
  });
});

test('change-region distinguishes a Git failure from a valid root commit with no baseline', async (t) => {
  const root = await repository(t);
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: ['repository-files@1.0.0']
  });
  let terminal = null;
  let observedGitBoundary = null;
  extractChangeRegions({
    root: path.join(root, 'missing-repository'),
    sourceSnapshot: registration.sourceSnapshot,
    scopeManifest: registration.scopeManifest,
    changeRegionGitObserver: (args, boundary) => {
      assert.deepEqual(args.slice(0, 3), ['rev-list', '--parents', '-n']);
      observedGitBoundary = boundary;
    },
    adapterExecutionRecorder: (outcome) => {
      if (outcome.scope === 'global') terminal = outcome;
    }
  });
  assert.deepEqual(observedGitBoundary, {
    timeoutMs: 30_000,
    lazyFetch: '1',
    terminalPrompt: '0',
    credentialManagerInteractive: 'Never'
  });
  assert.deepEqual(terminal, {
    scope: 'global', signal: 'failed', reasonCode: 'PARSE_FAILURE'
  });
});

test('change-region reports a deletion without inventing current-source evidence', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'src', 'deleted.js'), 'export const removed = true;\n');
  git(root, 'add', 'src/deleted.js');
  git(root, 'commit', '-qm', 'add source that will be deleted');
  await unlink(path.join(root, 'src', 'deleted.js'));
  git(root, 'add', '-u', 'src/deleted.js');
  git(root, 'commit', '-qm', 'delete source');

  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: ['change-region@1.0.0']
  });
  assert.deepEqual(registration.extractorExecutions[0].globalOutcome, {
    status: 'partial', reasonCode: 'PARTIAL_EXTRACTION'
  });
  assert.equal(registration.factLedger.facts.length, 0);
  assert.equal(registration.evidenceCatalog.items.length, 0);
});

function completeness(
  registration, resolvedViewContracts = registration.resolvedViewContracts
) {
  return createCompletenessRecordFromExtractionExecution({
    sourceSnapshot: registration.sourceSnapshot,
    scopeManifest: registration.scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    extractorExecutions: registration.extractorExecutions,
    evidenceCatalog: registration.evidenceCatalog,
    derivationCatalog: registration.derivationCatalog,
    factLedger: registration.factLedger,
    resolvedViewContracts,
    viewFactLedgers: registration.viewFactLedgers,
    extractionExecutionReceipt: registration.extractionExecutionReceipt
  });
}

test('terminal executions bridge to an exact completeness record without invented exclusions', async (t) => {
  const root = await repository(t);
  const rule = manifest('rule-definition@1.0.0');
  const view = resolveViewContract(BUILTIN_VIEW_REGISTRY, 'biz.rules@4');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${rule.id}@${rule.version}`],
    requestedViews: ['biz.rules@4']
  });
  const record = completeness(registration, [view]);

  assert.equal(record.sourceManifestSha256, registration.sourceSnapshot.sourceManifestSha256);
  assert.equal(record.scopeManifestSha256, registration.scopeManifest.scopeSha256);
  assert.equal(record.extractorRegistrySha256, BUILTIN_EXTRACTOR_REGISTRY.registrySha256);
  assert.equal(record.counts.totalPaths, registration.sourceSnapshot.files.length);
  assert.equal(record.counts.excludedPaths, 0);
  assert.deepEqual(registration.extractionExecutionReceipt.viewContracts, [{
    id: view.id,
    version: view.version,
    contractSha256: view.contractSha256
  }]);
  assert.deepEqual(registration.extractionExecutionReceipt.viewFactLedgers, [{
    viewId: registration.viewFactLedgers[0].viewId,
    viewVersion: registration.viewFactLedgers[0].viewVersion,
    viewSpecSha256: registration.viewFactLedgers[0].viewSpecSha256,
    ledgerSha256: registration.viewFactLedgers[0].ledgerSha256
  }]);
  assert.deepEqual(
    record.extractorReferences.map((entry) => [entry.id, entry.coverage]),
    [['required-fact-coverage', 'global'], ['rule-definition', 'path']]
  );
  assert.deepEqual(
    record.requiredSubjects.map((entry) => [entry.id, entry.status, entry.reasonCode]),
    [
      ['business-meaning', 'unavailable', 'NO_REGISTERED_PRODUCER'],
      ['rule-definition', 'unavailable', 'NO_REGISTERED_PRODUCER']
    ]
  );
  assert.equal(record.pathOutcomes.every((entry) => entry.status === 'unsupported'), true);
  assert.equal(Object.isFrozen(record), true);
  assert.throws(
    () => completeness(registration, []),
    (error) => error?.code === 'WMP_COMPLETENESS_VIEW_LEDGER_MISMATCH'
  );
  assert.throws(
    () => createCompletenessRecordFromExtractionExecution({
      ...registration,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      resolvedViewContracts: [],
      viewFactLedgers: []
    }),
    (error) => error?.code === 'WMP_EXTRACTION_RECEIPT_BINDING_MISMATCH'
  );
});

test('pre-scope discovery owns every selected and excluded completeness path', async (t) => {
  const root = await repository(t);
  const narrowScope = createScopeManifest({
    capabilityId: 'extractor-execution',
    allowedPaths: ['src/**'],
    excludedPaths: ['src/link.js'],
    allowedSubjects: ['file']
  });
  const sourceSnapshot = createExactSourceSnapshot(root, {
    subjectId: 'extractor-execution', scopeManifest: narrowScope
  });
  const candidateRoster = createDiscoveredCandidateRoster(root, {
    sourceSnapshot, scopeManifest: narrowScope
  });
  const registration = runDeterministicRegistration({
    root,
    sourceSnapshot,
    scopeManifest: narrowScope,
    extractorReferences: ['repository-files@1.0.0']
  });
  const record = createCompletenessRecordFromExtractionExecution({
    ...registration,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    candidateRoster
  });

  assert.equal(candidateRoster.source.tree, git(root, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(candidateRoster.counts.discoveredPaths, 6);
  assert.equal(candidateRoster.counts.selectedPaths, sourceSnapshot.files.length);
  assert.equal(candidateRoster.counts.excludedPaths, 4);
  const selectedSource = new Map(sourceSnapshot.files.map((entry) => [entry.path, entry]));
  for (const candidate of candidateRoster.candidates) {
    if (candidate.status === 'selected') {
      const source = selectedSource.get(candidate.path);
      assert.equal(candidate.contentSha256, source.contentSha256);
      assert.equal(candidate.bytes, source.bytes);
      assert.equal(candidate.objectId, git(root, 'rev-parse', `HEAD:${candidate.path}`));
    } else {
      assert.equal(candidate.contentSha256, null);
      assert.equal(candidate.bytes, null);
    }
  }
  assert.equal(record.counts.excludedPaths, 4);
  assert.deepEqual(
    record.pathOutcomes.filter((entry) => entry.status === 'excluded')
      .map((entry) => [entry.path, entry.reasonCode]),
    [
      ['.github/CODEOWNERS', 'OUTSIDE_SCOPE'],
      ['README.md', 'OUTSIDE_SCOPE'],
      ['src/link.js', 'EXCLUDED_BY_SCOPE'],
      ['test/unsupported.swift', 'OUTSIDE_SCOPE']
    ]
  );

  const misclassified = structuredClone(candidateRoster);
  const outside = misclassified.candidates.find((entry) => entry.path === 'README.md');
  outside.status = 'selected';
  outside.reasonCode = null;
  outside.contentSha256 = sha256({ forged: 'out-of-scope-content' });
  outside.bytes = 1;
  misclassified.counts.selectedPaths += 1;
  misclassified.counts.excludedPaths -= 1;
  const selfConsistent = sealRecord(misclassified, 'candidateRosterSha256');
  assert.doesNotThrow(() => validateWorldModelDiscoveredCandidateRoster(selfConsistent));
  assert.throws(
    () => createCompletenessRecordFromExtractionExecution({
      ...registration,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      candidateRoster: selfConsistent
    }),
    (error) => error?.code === 'WMP_CANDIDATE_ROSTER_SCOPE_MISMATCH'
  );

  const contentMismatch = structuredClone(candidateRoster);
  const mismatchedSelected = contentMismatch.candidates.find(
    (entry) => entry.status === 'selected'
  );
  mismatchedSelected.contentSha256 = sha256({ forged: 'selected-content' });
  mismatchedSelected.bytes += 1;
  const contentMismatchSealed = sealRecord(contentMismatch, 'candidateRosterSha256');
  assert.doesNotThrow(
    () => validateWorldModelDiscoveredCandidateRoster(contentMismatchSealed)
  );
  assert.throws(
    () => createCompletenessRecordFromExtractionExecution({
      ...registration,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      candidateRoster: contentMismatchSealed
    }),
    (error) => error?.code === 'WMP_CANDIDATE_ROSTER_SOURCE_MISMATCH'
  );

  const invented = structuredClone(candidateRoster);
  invented.candidates.push({
    ...invented.candidates[0],
    path: 'invented/path.js',
    status: 'excluded',
    reasonCode: 'OUTSIDE_SCOPE'
  });
  invented.candidates.sort((left, right) => compareText(left.path, right.path));
  invented.counts.discoveredPaths += 1;
  invented.counts.excludedPaths += 1;
  const inventedSealed = sealRecord(invented, 'candidateRosterSha256');
  assert.throws(
    () => validateWorldModelDiscoveredCandidateRoster(inventedSealed),
    (error) => error?.code === 'WMP_CANDIDATE_ROSTER_TREE_MISMATCH'
  );
});

test('pre-scope discovery fails with a typed result when a local Git read exceeds its deadline', async (t) => {
  const root = await repository(t);
  const sourceSnapshot = createExactSourceSnapshot(root, {
    subjectId: 'extractor-execution', scopeManifest: scope()
  });
  const executableDirectory = path.join(root, 'timeout-bin');
  const executable = path.join(
    executableDirectory, process.platform === 'win32' ? 'git.cmd' : 'git'
  );
  await mkdir(executableDirectory);
  await writeFile(executable, process.platform === 'win32'
    ? '@echo off\r\n:loop\r\ngoto loop\r\n'
    : '#!/bin/sh\nwhile :; do :; done\n');
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  const started = Date.now();
  assert.throws(
    () => createDiscoveredCandidateRoster(root, {
      sourceSnapshot,
      scopeManifest: scope(),
      env: {
        ...process.env,
        PATH: `${executableDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        SINGULARITY_FLOW_GIT_LOCAL_TIMEOUT_MS: '25'
      }
    }),
    (error) => error?.code === 'WMB_SOURCE_READ_TIMEOUT'
      && error?.details?.cause === 'SUBPROCESS_TIMEOUT'
  );
  assert.ok(Date.now() - started < 2_000, 'the bounded local read must not wait for the child');
});

test('source Git deadlines apply only to read-only operations', () => {
  for (const args of [
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    ['status', '--porcelain=v1'],
    ['ls-tree', '-r', 'HEAD'],
    ['log', '-1', '--format=%H'],
    ['cat-file', 'blob', 'object-id'],
    ['ls-files', '-z'],
    ['show', '-s', '--format=%ct', 'HEAD'],
    ['hash-object', '--stdin']
  ]) {
    assert.equal(worldModelSourceGitTimeoutClass(args), 'local-read', args.join(' '));
  }

  for (const args of [
    ['hash-object', '-w', '--stdin'],
    ['read-tree', '--empty'],
    ['update-index', '--add', '--cacheinfo', '100644,object-id,path'],
    ['write-tree'],
    ['-c', 'commit.gpgSign=false', 'commit-tree', 'tree-id'],
    ['update-ref', 'refs/singularity-flow/world-model-candidates/example', 'commit-id'],
    ['future-mutating-operation']
  ]) {
    assert.equal(worldModelSourceGitTimeoutClass(args), null, args.join(' '));
  }
});

test('completeness bridge refuses missing source paths and substituted view requirements', async (t) => {
  const root = await repository(t);
  const signature = manifest('signature-and-export@1.0.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${signature.id}@${signature.version}`]
  });
  const incompleteExecutions = structuredClone(registration.extractorExecutions);
  incompleteExecutions[0].pathOutcomes.pop();
  assert.throws(
    () => createCompletenessRecordFromExtractionExecution({
      ...registration,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      extractorExecutions: incompleteExecutions
    }),
    (error) => error?.code === 'WMP_EXTRACTION_RECEIPT_BINDING_MISMATCH'
  );

  const view = resolveViewContract(BUILTIN_VIEW_REGISTRY, 'biz.rules@4');
  assert.throws(
    () => completeness(registration, [view]),
    (error) => error?.code === 'WMP_COMPLETENESS_VIEW_LEDGER_MISMATCH'
  );
});

test('completeness bridge refuses a global-only execution roster', async (t) => {
  const root = await repository(t);
  const runtime = manifest('runtime-observation-import@1.0.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [`${runtime.id}@${runtime.version}`]
  });
  assert.throws(
    () => completeness(registration),
    (error) => error?.code === 'WMP_COMPLETENESS_PATH_EXTRACTOR_REQUIRED'
  );
});

test('completeness bridge binds the exact execution producer roster and resolved view input', async (t) => {
  const root = await repository(t);
  const repositoryFiles = manifest('repository-files@1.0.0');
  const signature = manifest('signature-and-export@1.0.0');
  const registration = runDeterministicRegistration({
    root,
    scopeManifest: scope(),
    extractorReferences: [
      `${repositoryFiles.id}@${repositoryFiles.version}`,
      `${signature.id}@${signature.version}`
    ]
  });
  assert.equal(Object.isFrozen(registration.resolvedViewContracts), true);
  assert.throws(
    () => createCompletenessRecordFromExtractionExecution({
      ...registration,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      extractorExecutions: registration.extractorExecutions.slice(1),
      resolvedViewContracts: registration.resolvedViewContracts
    }),
    (error) => error?.code === 'WMP_EXTRACTION_RECEIPT_BINDING_MISMATCH'
  );
  const withoutViews = { ...registration, extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY };
  delete withoutViews.resolvedViewContracts;
  assert.throws(
    () => createCompletenessRecordFromExtractionExecution(withoutViews),
    (error) => error?.code === 'WMP_COMPLETENESS_VIEW_REQUIREMENTS_REQUIRED'
  );
  const withoutReceipt = {
    ...registration,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY
  };
  delete withoutReceipt.extractionExecutionReceipt;
  assert.throws(
    () => createCompletenessRecordFromExtractionExecution(withoutReceipt),
    (error) => error?.code === 'WMP_EXTRACTION_RECEIPT_REQUIRED'
  );
});

test('completeness bridge refuses a legacy full-repository snapshot as scoped completeness', async (t) => {
  const root = await repository(t);
  const narrowScope = createScopeManifest({
    capabilityId: 'narrow-execution',
    allowedPaths: ['src/**'],
    allowedSubjects: ['file', 'symbol']
  });
  const fullSourceSnapshot = createExactSourceSnapshot(root);
  const registration = runDeterministicRegistration({
    root,
    sourceSnapshot: fullSourceSnapshot,
    scopeManifest: narrowScope,
    extractorReferences: ['repository-files@1.0.0']
  });
  assert.throws(
    () => completeness(registration),
    (error) => error?.code === 'WMP_COMPLETENESS_SOURCE_SCOPE_MISMATCH'
      && error?.details?.path === '.github/CODEOWNERS'
  );
});
