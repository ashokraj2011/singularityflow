import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import {
  astAdapterManifestSha256, astAdapterRequest, bundledAstAdapters, validateAstAdapterManifest,
  validateAstAdapterResponse
} from '../src/ast-adapter-contract.mjs';
import { readAstPackRegistry } from '../src/ast-pack-registry.mjs';
import { createAstDerivationKey, astSemanticOverlayKey, astSyntaxCacheKey } from '../src/ast-derivation-key.mjs';
import { compileAstLanguageCatalog, detectAstLanguage } from '../src/ast-language-catalog.mjs';
import { astCommand } from '../src/ast-intelligence.mjs';
import { discoverProjectBindings } from '../src/ast-project-binding.mjs';
import { extractPolyglotSyntax } from '../src/ast-packs/polyglot-syntax-core.mjs';
import { astSymbolPlanner } from '../src/gateway/planners/ast-intelligence.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { createAstDerivation, persistAstDerivation } from '../src/ast-evidence.mjs';
import { replayAstEvidence } from '../src/ast-replay.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function repository(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pad-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'PAD Test']);
  git(root, ['config', 'user.email', 'pad@example.com']);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'polyglot fixture']);
  return root;
}

async function isolatedMachine(fn) {
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-pad-machine-'));
  const beforePreference = process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
  const beforePacks = process.env.SINGULARITY_FLOW_AST_PACK_ROOT;
  const beforeAdapters = process.env.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS;
  process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = path.join(machine, 'preference.json');
  process.env.SINGULARITY_FLOW_AST_PACK_ROOT = path.join(machine, 'packs');
  try { return await fn(machine); } finally {
    if (beforePreference == null) delete process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
    else process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = beforePreference;
    if (beforePacks == null) delete process.env.SINGULARITY_FLOW_AST_PACK_ROOT;
    else process.env.SINGULARITY_FLOW_AST_PACK_ROOT = beforePacks;
    if (beforeAdapters == null) delete process.env.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS;
    else process.env.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS = beforeAdapters;
  }
}

const FIXTURES = {
  java: `package com.acme;
import java.util.List;
@Deprecated public record Payment(String id) implements Payable {}
public class PaymentService extends BaseService implements Payable {
  @Override public <T> boolean authorize(T payment) { return true; }
}
`,
  python: `from typing import Protocol as TypingProtocol
import asyncio
@service
class PaymentService(BaseService):
    @transactional
    async def authorize(self, payment: "Payment") -> bool:
        return True
`,
  kotlin: `package com.acme
import kotlinx.coroutines.flow.Flow
@JvmInline value class PaymentId(val value: String)
data class Payment(val id: PaymentId) : Payable
class PaymentService {
  @Transactional suspend fun Payment.authorize(): Boolean = true
}
`,
  swift: `import Foundation
@MainActor public actor PaymentService: Payable {
  public func authorize(_ payment: Payment) async throws -> Authorization { fatalError() }
}
public protocol Payable: Sendable {}
`
};

test('the bundled pack emits useful rich syntax for Java, Python, Kotlin, and Swift', () => {
  for (const [language, source] of Object.entries(FIXTURES)) {
    const result = extractPolyglotSyntax(Buffer.from(source), language);
    assert.ok(result.facts.some((fact) => fact.kind === 'symbol'), language);
    assert.ok(result.facts.filter((fact) => fact.kind === 'symbol').every((fact) =>
      fact.id && fact.qualifiedName && fact.signature && fact.span?.startLine > 0 && fact.assurance === 'syntax'), language);
    assert.ok(result.facts.some((fact) => fact.kind === 'import'), `${language} import`);
    assert.ok(result.facts.some((fact) => fact.kind === 'relationship'), `${language} relationship`);
    assert.doesNotMatch(JSON.stringify(result), /sourceBody|"body"|"content"|"text"/);
  }
  assert.ok(extractPolyglotSyntax(Buffer.from(FIXTURES.java), 'java').facts.some((fact) => fact.annotations?.includes('Override')));
  assert.ok(extractPolyglotSyntax(Buffer.from(FIXTURES.python), 'python').facts.some((fact) => fact.annotations?.includes('transactional')));
  assert.ok(extractPolyglotSyntax(Buffer.from(FIXTURES.kotlin), 'kotlin').facts.some((fact) => fact.declarationKind === 'extension-function'));
  assert.ok(extractPolyglotSyntax(Buffer.from(FIXTURES.swift), 'swift').facts.some((fact) => fact.declarationKind === 'actor'));
});

test('commented and string-contained declarations never become syntax facts', () => {
  const fixtures = {
    java: '/*\npublic class Ghost {}\n*/\npublic class Real {}\nString text = "class AlsoGhost {}";\n',
    python: '\"\"\"\nclass Ghost:\n    pass\n\"\"\"\nclass Real:\n    pass\n',
    kotlin: '/* class Ghost {} */\nclass Real\n',
    swift: '/* actor Ghost {} */\nactor Real {}\n'
  };
  for (const [language, source] of Object.entries(fixtures)) {
    const names = extractPolyglotSyntax(Buffer.from(source), language).facts
      .filter((fact) => fact.kind === 'symbol').map((fact) => fact.name);
    assert.ok(names.includes('Real'), language);
    assert.ok(!names.includes('Ghost') && !names.includes('AlsoGhost'), language);
  }
});

test('syntax fixtures retain Unicode declarations, partial facts, bounded diagnostics, and large-file determinism', () => {
  const fixtures = {
    java: 'public class PaiementÉgaré {\n',
    python: 'class PaiementÉgaré:\n    pass\ndef cassé(\n',
    kotlin: 'class PaiementÉgaré {\n',
    swift: 'actor PaiementÉgaré {\n'
  };
  for (const [language, source] of Object.entries(fixtures)) {
    const result = extractPolyglotSyntax(Buffer.from(source), language);
    assert.ok(result.facts.some((fact) => fact.kind === 'symbol' && fact.name === 'PaiementÉgaré'), language);
    assert.ok(result.diagnostics.length > 0, `${language} bounded syntax diagnostic`);
    assert.ok(result.diagnostics.every((item) => /^AST_SYNTAX_[A-Z_]+$/.test(item.code)));
  }
  const large = `${'// generated fixture line\n'.repeat(20_000)}public class LargeGenerated {}\n`;
  const first = extractPolyglotSyntax(Buffer.from(large), 'java');
  const second = extractPolyglotSyntax(Buffer.from(large), 'java');
  assert.deepEqual(second, first);
  assert.ok(first.facts.some((fact) => fact.name === 'LargeGenerated'));
  assert.doesNotMatch(JSON.stringify(first), /generated fixture line/);
});

test('the language catalog is data-driven and the bundled manifest carries grammar provenance', async () => isolatedMachine(async () => {
  const adapters = await bundledAstAdapters();
  const catalog = compileAstLanguageCatalog(adapters);
  assert.equal(detectAstLanguage('app/src/main/kotlin/Payment.kt', catalog).language, 'kotlin');
  assert.equal(detectAstLanguage('Sources/Payment.swift', catalog).language, 'swift');
  assert.match(catalog.sha256, /^[a-f0-9]{64}$/);
  const pack = adapters[0];
  assert.equal(pack.stage, 'syntax');
  assert.equal(pack.conformance.status, 'passed');
  assert.deepEqual(pack.languages, ['java', 'kotlin', 'python', 'swift']);
  assert.equal(pack.implementation.grammars.length, 4);
  assert.ok(pack.implementation.grammars.every((grammar) => /^[a-f0-9]{64}$/.test(grammar.artifactSha256)));
}));

test('one malformed adapter file result is rejected without erasing already validated files', async () => isolatedMachine(async () => {
  const [manifest] = await bundledAstAdapters();
  const request = astAdapterRequest({
    operation: 'skeleton', stage: 'syntax', scope: { kind: 'paths' },
    files: [
      { path: 'One.java', sha256: 'a'.repeat(64), language: 'java' },
      { path: 'Two.java', sha256: 'b'.repeat(64), language: 'java' }
    ],
    budget: { maxFiles: 2, maxBytes: 1000 }, implementation: manifest.implementation
  });
  const response = validateAstAdapterResponse({
    protocolVersion: 2, adapterId: manifest.id, packVersion: manifest.packVersion,
    extractorVersion: manifest.extractorVersion, stage: 'syntax', assurance: 'syntax',
    derivationIdentity: request.derivationIdentity,
    artifactSha256: manifest.implementation.artifactSha256,
    manifestSha256: manifest.implementation.manifestSha256,
    files: [
      { path: 'One.java', sha256: 'a'.repeat(64), facts: [{
        kind: 'symbol', id: 'java:One', name: 'One', qualifiedName: 'One', declarationKind: 'class',
        signature: 'class One', span: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 }
      }] },
      { path: 'Two.java', sha256: 'b'.repeat(64), facts: [{
        kind: 'symbol', name: 'Leak', line: 1, sourceBody: 'secret'
      }] }
    ]
  }, manifest, request);
  assert.equal(response.files.length, 1);
  assert.deepEqual(response.rejectedFiles, [{ path: 'Two.java', code: 'AST_ADAPTER_FILE_RESULT_INVALID' }]);
  assert.doesNotMatch(JSON.stringify(response), /secret/);
}));

test('protocol-v1 adapters remain readable at legacy syntax fidelity and cannot claim semantic assurance', async () => isolatedMachine(async () => {
  const [bundled] = await bundledAstAdapters();
  const legacySource = {
    protocolVersion: 1,
    id: 'legacy-semantic-claim',
    languages: ['java'],
    assurance: 'semantic',
    argv: bundled.argv,
    extractorVersion: '0.9.0',
    capabilities: ['skeleton'],
    implementation: {
      ...structuredClone(bundled.implementation),
      manifestSha256: '0'.repeat(64)
    }
  };
  legacySource.implementation.manifestSha256 = astAdapterManifestSha256(legacySource);
  const manifest = validateAstAdapterManifest(legacySource);
  assert.equal(manifest.protocolVersion, 1);
  assert.equal(manifest.legacyProtocol, 1);
  assert.equal(manifest.legacyClaimedAssurance, 'semantic');
  assert.equal(manifest.assurance, 'syntax');
  assert.equal(manifest.stage, 'syntax');

  const request = astAdapterRequest({
    protocolVersion: 1,
    operation: 'skeleton',
    files: [{ path: 'Legacy.java', sha256: 'a'.repeat(64), language: 'java' }],
    scope: { kind: 'paths' }, budget: { maxFiles: 1, maxBytes: 1000 },
    implementation: manifest.implementation
  });
  assert.equal(request.protocolVersion, 1);
  assert.equal(Object.hasOwn(request, 'project'), false);
  const response = validateAstAdapterResponse({
    protocolVersion: 1,
    adapterId: manifest.id,
    extractorVersion: manifest.extractorVersion,
    assurance: 'syntax',
    derivationIdentity: request.derivationIdentity,
    artifactSha256: manifest.implementation.artifactSha256,
    manifestSha256: manifest.implementation.manifestSha256,
    files: [{
      path: 'Legacy.java', sha256: 'a'.repeat(64),
      facts: [{ kind: 'symbol', name: 'Legacy', declarationKind: 'class', line: 1 }]
    }]
  }, manifest, request);
  assert.equal(response.legacyProtocol, 1);
  assert.equal(response.assurance, 'syntax');
  assert.equal(response.files[0].facts[0].assurance, 'syntax');
}));

test('syntax and semantic derivation keys bind parser, project, dependency, toolchain, and profile identity', () => {
  const syntax = createAstDerivationKey({
    stage: 'syntax', language: 'java', adapterId: 'sflow-polyglot-syntax', packVersion: '1.0.0',
    extractorVersion: '1.0.0', parserEngine: 'sflow-structural-parser', parserVersion: '1.0.0',
    grammarId: 'sflow-java-structural', grammarVersion: '1.0.0'
  });
  const semantic = (profile) => createAstDerivationKey({
    stage: 'semantic', language: 'java', adapterId: 'sflow-java-jdt', packVersion: '1.0.0', extractorVersion: '1.0.0',
    parserEngine: 'jdt', parserVersion: '4.0.0', toolchain: { kind: 'jdk', version: '21', identitySha256: 'a'.repeat(64) },
    projectModelSha256: 'b'.repeat(64), dependencyGraphSha256: 'c'.repeat(64), configurationSha256: 'd'.repeat(64), profile
  });
  const syntaxKey = astSyntaxCacheKey('e'.repeat(64), syntax);
  assert.notEqual(astSemanticOverlayKey(syntaxKey, semantic('debug')), astSemanticOverlayKey(syntaxKey, semantic('release')));
});

test('existing-only project discovery reads metadata without invoking a build tool', async () => {
  const root = await repository({
    'settings.gradle.kts': 'rootProject.name = "sample"\ninclude(":app")\n',
    'app/build.gradle.kts': 'plugins { kotlin("jvm") version "2.0" }\n',
    'app/src/main/AndroidManifest.xml': '<manifest package="com.acme"/>\n',
    'gradle/libs.versions.toml': '[versions]\nkotlin = "2.0"\n',
    'pyproject.toml': '[project]\nname = "sample"\n',
    'Package.swift': '// swift-tools-version: 6.0\n'
  });
  const result = await discoverProjectBindings(root);
  assert.equal(result.mode, 'existing-only');
  const android = result.bindings.find((binding) => binding.projectKind === 'gradle-android');
  assert.ok(android);
  assert.deepEqual(android.modules, ['app']);
  assert.deepEqual(android.sourceSets, ['main']);
  assert.ok(result.bindings.some((binding) => binding.projectKind === 'python'));
  assert.ok(result.bindings.some((binding) => binding.projectKind === 'swiftpm'));
  assert.ok(result.bindings.every((binding) => binding.complete === false && binding.toolchain === null));
});

test('existing-only discovery identifies standalone Java without running a compiler', async () => {
  const root = await repository({ 'src/main/java/Standalone.java': 'public class Standalone {}\n' });
  const result = await discoverProjectBindings(root, { paths: ['src'] });
  const binding = result.bindings.find((entry) => entry.projectKind === 'java-standalone');
  assert.ok(binding);
  assert.equal(binding.complete, false);
  assert.equal(binding.toolchain, null);
  assert.deepEqual(binding.buildFiles, []);
});

test('semantic warm-up is previewed, exact-confirmed, hash-bound, and invalidated by project changes', async () => isolatedMachine(async () => {
  const root = await repository({
    'pom.xml': '<project><modelVersion>4.0.0</modelVersion><artifactId>sample</artifactId></project>\n',
    'src/main/java/Sample.java': 'public class Sample {}\n'
  });
  const tool = path.join(root, 'fake-java');
  const modelTool = path.join(root, 'fake-maven');
  await writeFile(tool, '#!/bin/sh\nprintf "jdk fixture 21\\n"\n');
  await writeFile(modelTool, '#!/bin/sh\nprintf "effective project fixture\\n"\n');
  await chmod(tool, 0o755);
  await chmod(modelTool, 0o755);
  const options = {
    semantic: true,
    provider: 'sflow-java-jdt',
    profile: 'default',
    project: 'maven:.',
    toolchain: tool,
    'project-tool': modelTool
  };
  const preview = await astCommand(root, ['warm'], { ...options, 'dry-run': true });
  assert.equal(preview.ready, true);
  assert.equal(preview.effects.repositoryWrites, false);
  assert.equal(preview.effects.network, 'blocked-by-offline-command');
  assert.match(preview.confirmation, /^WARM AST SEMANTICS sflow-java-jdt /);
  await assert.rejects(() => astCommand(root, ['warm'], { ...options, confirm: 'WARM AST SEMANTICS' }), /requires --confirm/);
  const warmed = await astCommand(root, ['warm'], { ...options, confirm: preview.confirmation });
  assert.equal(warmed.warmed, true);
  assert.equal(warmed.binding.complete, true);
  assert.equal(warmed.binding.semanticProvider, 'sflow-java-jdt');
  assert.equal((await discoverProjectBindings(root)).bindings.find((item) => item.projectKind === 'maven').complete, true);

  await writeFile(path.join(root, 'pom.xml'), '<project><artifactId>changed</artifactId></project>\n');
  const invalidated = (await discoverProjectBindings(root)).bindings.find((item) => item.projectKind === 'maven');
  assert.equal(invalidated.complete, false);
  assert.deepEqual(invalidated.unavailable, ['explicit-toolchain-binding', 'module-profile-binding']);
}));

test('a reviewed semantic pack overlays syntax by syntaxId and degrades without erasing syntax', async () => isolatedMachine(async (machine) => {
  const source = '@Deprecated public class Child implements Contract {}\n';
  const root = await repository({ 'pom.xml': '<project><artifactId>semantic</artifactId></project>\n', 'src/Child.java': source });
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.worldModel.sourceRoots = ['src'];
  definition.ast.languages ??= {};
  definition.ast.languages.java = {
    mode: 'auto', minimumAssurance: 'semantic', syntaxProvider: 'sflow-polyglot-syntax',
    semanticProvider: 'sflow-java-jdt', semanticProfile: 'default'
  };
  await writeFile(definitionPath, YAML.stringify(definition));
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'semantic policy']);

  const tool = path.join(machine, 'fake-java');
  const projectTool = path.join(machine, 'fake-maven');
  await writeFile(tool, '#!/bin/sh\nprintf "jdk fixture 21\\n"\n');
  await writeFile(projectTool, '#!/bin/sh\nprintf "effective semantic fixture\\n"\n');
  await chmod(tool, 0o755); await chmod(projectTool, 0o755);
  const warmOptions = {
    semantic: true, provider: 'sflow-java-jdt', profile: 'default', project: 'maven:.',
    toolchain: tool, 'project-tool': projectTool
  };
  const warmPreview = await astCommand(root, ['warm'], { ...warmOptions, 'dry-run': true });
  await astCommand(root, ['warm'], { ...warmOptions, confirm: warmPreview.confirmation });

  const syntaxId = extractPolyglotSyntax(Buffer.from(source), 'java').facts.find((fact) => fact.kind === 'symbol').id;
  const adapter = path.join(machine, 'semantic-adapter.mjs');
  await writeFile(adapter, `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    const syntaxId = ${JSON.stringify(syntaxId)};
    const semanticId = 'jdt:fixture.Child';
    process.stdout.write(JSON.stringify({
      protocolVersion: 2, adapterId: 'sflow-java-jdt', packVersion: '1.0.0',
      extractorVersion: '1.0.0', stage: 'semantic', assurance: 'semantic',
      derivationIdentity: request.derivationIdentity,
      artifactSha256: request.implementation.artifactSha256,
      manifestSha256: request.implementation.manifestSha256,
      files: request.files.map((file) => ({ path: file.path, sha256: file.sha256, facts: [
        { kind: 'symbol', id: semanticId, syntaxId, name: 'Child', qualifiedName: 'fixture.Child',
          declarationKind: 'class', signature: 'public class Child implements Contract', visibility: 'public',
          span: { startLine: 1, startColumn: 27, endLine: 1, endColumn: 32 } },
        { kind: 'relationship', type: 'conforms-to', sourceId: semanticId, target: 'fixture.Contract' }
      ] }))
    }));
  `);
  const adapterSha = digest(await readFile(adapter));
  const manifest = {
    protocolVersion: 2, id: 'sflow-java-jdt', packVersion: '1.0.0', extractorVersion: '1.0.0',
    stage: 'semantic', assurance: 'semantic', argv: [process.execPath, adapter], capabilities: ['skeleton', 'query'],
    languages: { java: {
      extensions: ['.java'], parserEngine: 'eclipse-jdt', parserVersion: 'fixture-1',
      grammarId: null, grammarVersion: null, maximumAssurance: 'semantic', priority: 200,
      projectKinds: ['maven'], toolchainRanges: ['fixture-21'], platforms: ['any']
    } },
    licenses: [{ id: 'fixture-only', spdx: 'MIT', sourceSha256: 'a'.repeat(64) }],
    conformance: { fixtureVersion: '1', status: 'passed', languages: ['java'] },
    implementation: {
      artifactSha256: adapterSha, manifestSha256: '0'.repeat(64),
      runtime: { id: 'node', version: process.versions.node, platform: 'any' }, grammars: [],
      dependencies: { lockSha256: null, bundleSha256: 'b'.repeat(64) }, files: [{ path: adapter, sha256: adapterSha }]
    }
  };
  manifest.implementation.manifestSha256 = astAdapterManifestSha256(manifest);
  const manifestPath = path.join(machine, 'semantic-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.env.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS = manifestPath;

  const semantic = await astCommand(root, ['build'], { paths: 'src', 'max-facts': 1000 });
  assert.equal(semantic.assurance, 'semantic', JSON.stringify({ diagnostics: semantic.diagnostics, degradation: semantic.degradation, provenance: semantic.provenance }, null, 2));
  const relationship = semantic.facts.find((fact) => fact.kind === 'relationship' && fact.type === 'conforms-to' && fact.assurance === 'semantic');
  assert.match(relationship.derivationSha256, /^[a-f0-9]{64}$/);
  assert.ok(semantic.facts.some((fact) => fact.kind === 'symbol' && fact.syntaxId === syntaxId && fact.assurance === 'semantic'));
  assert.ok((await readdir(path.join(root, '.git', 'singularity-flow', 'ast', 'v2', 'semantic'))).length > 0);

  const gate = await astCommand(root, ['gate'], { paths: 'src', 'evidence-class': 'gate', 'max-facts': 1000 });
  const derivation = await createAstDerivation(
    root,
    { ast: definition.ast, workItemRoot: 'singularity/work-items' },
    { workItem: { id: 'SEMANTIC-1' } }, { id: 'intake' }, gate,
    { generation: 1, evidenceClass: 'gate', operation: 'gate' }
  );
  await persistAstDerivation(root, derivation);
  const reproduced = await replayAstEvidence(root, { receipt: derivation.relative });
  assert.equal(reproduced.result, 'identical', JSON.stringify(reproduced, null, 2));

  delete process.env.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS;
  const syntaxOnly = await astCommand(root, ['context'], { paths: 'src', 'max-facts': 1000 });
  assert.equal(syntaxOnly.assurance, 'syntax');
  assert.ok(syntaxOnly.facts.some((fact) => fact.kind === 'symbol' && fact.name === 'Child' && fact.assurance === 'syntax'));
}));

test('integrated polyglot reads are syntax-assured, bounded, cached only for committed blobs, and gateway-addressable', async () => isolatedMachine(async () => {
  const root = await repository({
    'src/Payment.java': FIXTURES.java,
    'src/payment.py': FIXTURES.python,
    'src/Payment.kt': FIXTURES.kotlin,
    'src/Payment.swift': FIXTURES.swift
  });
  const built = await astCommand(root, ['build'], { paths: 'src', 'max-facts': 1000 });
  assert.equal(built.status, 'complete');
  assert.equal(built.assurance, 'syntax');
  assert.ok(built.facts.filter((fact) => fact.kind === 'symbol').every((fact) => fact.extractor.derivation?.derivationSha256));
  const syntaxDirectory = path.join(root, '.git', 'singularity-flow', 'ast', 'v2', 'syntax');
  const before = (await readdir(syntaxDirectory)).length;
  await writeFile(path.join(root, 'src', 'Payment.kt'), `${FIXTURES.kotlin}\nfun dirtyOnly() = true\n`);
  const dirty = await astCommand(root, ['build'], { paths: 'src/Payment.kt', 'max-facts': 1000 });
  assert.ok(dirty.facts.some((fact) => fact.name === 'dirtyOnly'));
  assert.equal((await readdir(syntaxDirectory)).length, before, 'dirty worktree facts never enter the shared syntax CAS');

  const planned = await astSymbolPlanner({ root, subject: null, arguments: { name: 'PaymentService', path: 'src' } });
  assert.equal(planned.outcome.status, 'succeeded');
  assert.ok(planned.data.ast.facts.some((fact) => fact.name === 'PaymentService'));
}));

test('pack inventory is available without a repository-specific installation', async () => isolatedMachine(async () => {
  const root = await repository({ 'README.md': '# fixture\n' });
  const result = await astCommand(root, ['pack', 'list'], {});
  assert.ok(result.packs.some((pack) => pack.id === 'sflow-polyglot-syntax' && pack.source === 'bundled'));
}));

test('local pack installation is previewed, content-bound, hash-checked, and removable', async () => isolatedMachine(async () => {
  const root = await repository({ 'README.md': '# fixture\n' });
  const [bundled] = await bundledAstAdapters();
  const source = await mkdtemp(path.join(os.tmpdir(), 'sflow-pad-pack-'));
  const copied = [];
  for (const artifact of bundled.implementation.files) {
    const target = path.join(source, path.basename(artifact.path));
    await cp(artifact.path, target);
    copied.push({ path: target, sha256: artifact.sha256 });
  }
  const adapterPath = copied.find((entry) => entry.path.endsWith('polyglot-syntax-adapter.mjs')).path;
  const manifest = {
    protocolVersion: 2,
    id: 'local-polyglot-syntax', packVersion: bundled.packVersion,
    extractorVersion: bundled.extractorVersion, stage: 'syntax', assurance: 'syntax',
    argv: [process.execPath, adapterPath], capabilities: bundled.capabilities,
    languages: bundled.languageDefinitions, licenses: bundled.licenses, conformance: bundled.conformance,
    implementation: {
      ...structuredClone(bundled.implementation),
      files: copied,
      manifestSha256: '0'.repeat(64)
    }
  };
  manifest.implementation.manifestSha256 = astAdapterManifestSha256(manifest);
  const sourceManifest = path.join(source, 'manifest.json');
  await writeFile(sourceManifest, `${JSON.stringify(manifest, null, 2)}\n`);

  const preview = await astCommand(root, ['pack', 'install', sourceManifest], { 'dry-run': true });
  assert.match(preview.confirmation, /^INSTALL AST PACK local-polyglot-syntax@/);
  await assert.rejects(() => astCommand(root, ['pack', 'install', sourceManifest], { confirm: 'INSTALL AST PACK' }), /requires --confirm/);
  const installed = await astCommand(root, ['pack', 'install', sourceManifest], { confirm: preview.confirmation });
  assert.equal(installed.installed, true);
  const healthy = await astCommand(root, ['pack', 'doctor', 'local-polyglot-syntax'], {});
  assert.equal(healthy.healthy, true);

  const registry = await readAstPackRegistry();
  const entry = registry.entries.find((item) => item.id === 'local-polyglot-syntax');
  const installedManifest = JSON.parse(await readFile(path.join(registry.root, entry.manifestPath), 'utf8'));
  const installedAdapter = installedManifest.implementation.files.find((item) => item.path.endsWith('polyglot-syntax-adapter.mjs')).path;
  await writeFile(installedAdapter, '// tampered\n');
  const damaged = await astCommand(root, ['pack', 'doctor', 'local-polyglot-syntax'], {});
  assert.equal(damaged.healthy, false);
  assert.ok(damaged.diagnostics.some((item) => item.code === 'AST_ADAPTER_ARTIFACT_MISMATCH'));

  const removePreview = await astCommand(root, ['pack', 'remove', 'local-polyglot-syntax'], { 'dry-run': true });
  const removed = await astCommand(root, ['pack', 'remove', 'local-polyglot-syntax'], { confirm: removePreview.confirmation });
  assert.equal(removed.removed, true);
  assert.equal((await readAstPackRegistry()).entries.length, 0);
}));

test('a verified offline pack archive installs without a network lookup', async () => isolatedMachine(async () => {
  const root = await repository({ 'README.md': '# offline archive fixture\n' });
  const [bundled] = await bundledAstAdapters();
  const source = await mkdtemp(path.join(os.tmpdir(), 'sflow-pad-archive-source-'));
  const files = [];
  for (const artifact of bundled.implementation.files) {
    const name = path.basename(artifact.path); await cp(artifact.path, path.join(source, name));
    files.push({ path: name, sha256: artifact.sha256 });
  }
  const manifest = {
    protocolVersion: 2, id: 'offline-polyglot-syntax', packVersion: bundled.packVersion,
    extractorVersion: bundled.extractorVersion, stage: 'syntax', assurance: 'syntax',
    argv: [process.execPath, 'polyglot-syntax-adapter.mjs'], capabilities: bundled.capabilities,
    languages: bundled.languageDefinitions, licenses: bundled.licenses, conformance: bundled.conformance,
    implementation: { ...structuredClone(bundled.implementation), files, manifestSha256: '' }
  };
  manifest.implementation.manifestSha256 = astAdapterManifestSha256(manifest);
  await writeFile(path.join(source, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const archive = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-pad-archive-')), 'pack.tgz');
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  const preview = await astCommand(root, ['pack', 'install', archive], { 'dry-run': true });
  assert.equal(preview.source, archive);
  assert.ok(preview.files.some((entry) => entry.endsWith('manifest.json')));
  const installed = await astCommand(root, ['pack', 'install', archive], { confirm: preview.confirmation });
  assert.equal(installed.installed, true);
  assert.equal((await astCommand(root, ['pack', 'doctor', 'offline-polyglot-syntax'], {})).healthy, true);
}));
