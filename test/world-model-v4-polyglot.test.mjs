import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import {
  extractPolyglotImports, extractPolyglotSymbols, maskPolyglotNonCode
} from '../src/world-model/extract/adapters/polyglot-lexical.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { verifyBuiltInExtractorConformance } from '../src/world-model/registry/extractor-conformance.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('reviewed polyglot grammars ignore comment, string, and docstring decoys', () => {
  const java = [
    'import demo.Real;',
    '// import demo.Decoy;',
    'public class Service {',
    '  String decoy = "class Hidden {}";',
    '  public void calculate() {}',
    '}'
  ].join('\n');
  const python = [
    'from collections import defaultdict',
    '"""',
    'class Hidden:',
    '  pass',
    '"""',
    'class Calculator:',
    '  def compute(self): pass'
  ].join('\n');
  assert.deepEqual(extractPolyglotImports(java, 'java').map((entry) => entry.target), ['demo.Real']);
  assert.deepEqual(extractPolyglotSymbols(java, 'java').map((entry) => entry.name), ['Service', 'calculate']);
  assert.deepEqual(extractPolyglotImports(python, 'python').map((entry) => entry.target), ['collections']);
  assert.deepEqual(extractPolyglotSymbols(python, 'python').map((entry) => entry.name), ['Calculator', 'compute']);
  assert.equal(maskPolyglotNonCode(python, 'python').split('\n').length, python.split('\n').length);
  const conformance = verifyBuiltInExtractorConformance();
  for (const registered of [
    'call-reference-edge', 'change-region', 'clause-code-binding', 'configuration-object',
    'human-confirmed-knowledge-import', 'import-dependency', 'interface-contract',
    'language-detection', 'ownership-maintainer-record', 'repository-files',
    'required-fact-coverage', 'rule-definition', 'runtime-observation-import',
    'signature-and-export', 'symbol-skeleton', 'test-identity'
  ]) assert.ok(conformance.includes(registered), `missing conformance suite ${registered}`);
});

test('Java, Kotlin, Python, and Go produce evidence-bound structural facts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-polyglot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'polyglot@example.invalid');
  git(root, 'config', 'user.name', 'Polyglot Tests');
  await mkdir(path.join(root, 'src', 'demo'), { recursive: true });
  await writeFile(path.join(root, 'src', 'demo', 'Service.java'), [
    'package demo;',
    'import demo.Dependency;',
    'public class Service { public void execute() {} }',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'demo', 'Dependency.java'), 'package demo; public interface Dependency {}\n');
  await writeFile(path.join(root, 'src', 'worker.py'), 'from helpers import work\nclass Worker:\n    def run(self): return work()\n');
  await writeFile(path.join(root, 'src', 'helpers.py'), 'def work(): return 1\n');
  await writeFile(path.join(root, 'src', 'Main.kt'), 'import demo.Dependency\nclass Main\nfun start() = Main()\n');
  await writeFile(path.join(root, 'src', 'main.go'), 'package main\nimport "fmt"\ntype Service struct{}\nfunc Run() { fmt.Println("ok") }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'polyglot fixture');

  const registration = runDeterministicRegistration({
    root,
    scopeManifest: createScopeManifest({
      capabilityId: 'polyglot', allowedPaths: ['src/**'],
      allowedSubjects: ['dependency-edge', 'file', 'symbol']
    })
  });
  const available = registration.factLedger.facts.filter((fact) => fact.status === 'available');
  for (const expected of [
    'src/demo/Service.java#Service', 'src/demo/Dependency.java#Dependency',
    'src/worker.py#Worker', 'src/worker.py#run', 'src/helpers.py#work',
    'src/Main.kt#Main', 'src/Main.kt#start', 'src/main.go#Service', 'src/main.go#Run'
  ]) assert.ok(available.some((fact) => fact.subject.id === expected), `missing ${expected}`);
  assert.ok(available.some((fact) => fact.factType === 'dependency-edge'
    && fact.subject.id === 'src/demo/Service.java->src/demo/Dependency.java'));
  assert.ok(available.some((fact) => fact.factType === 'dependency-edge'
    && fact.subject.id === 'src/worker.py->src/helpers.py'));
  assert.ok(available.every((fact) => fact.evidenceIds.length > 0));
  assert.doesNotMatch(JSON.stringify(registration), /fmt\.Println|return work|return 1/);
});
