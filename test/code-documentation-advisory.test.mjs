import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectCodeDocumentation } from '../src/code-documentation-inspection.mjs';
import { phaseDraftCheck } from '../src/phase-draft-check.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function put(root, relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-code-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Docs Tester');
  git(root, 'config', 'user.email', 'docs@example.com');
  await put(root, 'src/ledger.js', `/** Existing and documented. */
export function documented() { return 1; }

export function legacy() { return 2; }
`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  const base = git(root, 'rev-parse', 'HEAD');
  const phase = {
    id: 'implementation', status: 'in_progress', generation: 0,
    generationPolicy: { task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    generationIntent: { status: 'open', id: 'intent-docs', baseline: { commit: base } }
  };
  const workflow = { workItem: { id: 'DOCS-1' }, currentPhase: 'implementation', phaseOrder: ['implementation'], phases: { implementation: phase },
    workIntervals: { current: { sourceBaseCommit: base } }, resolution: {} };
  const config = { workItemRoot: 'singularity/work-items' };
  return { root, base, phase, workflow, config };
}

test('an open code generation lists the undocumented public declarations it touched in product source only', async (t) => {
  const { root, phase, workflow, config } = await repository(t);
  await put(root, 'src/ledger.js', `/** Existing and documented. */
export function documented() { return 1; }

export function legacy() { return 2; }

export function added(entry) {
  return entry;
}

/** Added with a doc comment. */
export function addedDocumented() {}
`);
  await put(root, 'src/service.py', `def serve(port):
    return port


class Worker:
    """Handles one job."""
`);
  await put(root, 'tests/ledger.test.js', 'export function helper() {}\n');
  await put(root, 'vendor/lib.js', 'export function vendored() {}\n');
  await put(root, 'singularity/work-items/DOCS-1/notes.js', 'export function record() {}\n');
  await put(root, 'native/codec.cpp', 'int encode() { return 0; }\n');

  const { documentation, advisories } = await inspectCodeDocumentation(root, config, workflow, phase);
  assert.equal(documentation.status, 'missing');
  assert.equal(documentation.blocking, false);
  assert.deepEqual(advisories.map((entry) => `${entry.path}:${entry.line}:${entry.value}`), [
    'src/ledger.js:6:added', 'src/service.py:1:serve'
  ], 'an untouched legacy function, tests, vendored code and Story records are not reported');
  assert.equal(advisories.every((entry) => entry.blocking === false && entry.code === 'code.documentation.missing'), true);
  assert.equal(documentation.unsupportedFiles, 1);
  assert.equal(documentation.declarations, 4);
  assert.match(documentation.guidance, /Change comments only, never code/);

  await put(root, 'src/ledger.js', `/** Existing and documented. */
export function documented() { return 1; }

export function legacy() { return 2; }

/** Return the entry unchanged. */
export function added(entry) {
  return entry;
}

/** Added with a doc comment. */
export function addedDocumented() {}
`);
  await put(root, 'src/service.py', `def serve(port):
    """Serve on the given port."""
    return port


class Worker:
    """Handles one job."""
`);
  const documented = await inspectCodeDocumentation(root, config, workflow, phase);
  assert.equal(documented.documentation.status, 'complete');
  assert.deepEqual(documented.advisories, []);

  const closed = await inspectCodeDocumentation(root, config, workflow, { ...phase, generationIntent: { ...phase.generationIntent, status: 'consumed' } });
  assert.equal(closed.documentation.status, 'not-applicable');
  assert.equal(closed.documentation.reason, 'no-open-code-generation');
  assert.match(closed.documentation.guidance, /not inspected/);
  assert.match(closed.documentation.guidance, /does not mean existing code is documented or implementation is complete/);
});

test('documentation distinguishes a non-code phase from a code phase that has not begun', async (t) => {
  const { root, workflow, config, phase } = await repository(t);
  const beforeBegin = await inspectCodeDocumentation(root, config, workflow, { ...phase, generationIntent: null });
  assert.equal(beforeBegin.documentation.reason, 'no-open-code-generation');
  assert.equal(beforeBegin.documentation.inspectedFiles, 0);
  assert.match(beforeBegin.documentation.guidance, /prepublish/);
  const nonCode = await inspectCodeDocumentation(root, config, workflow, {
    ...phase, generationPolicy: { ...phase.generationPolicy, task: 'document' }
  });
  assert.equal(nonCode.documentation.reason, 'phase-does-not-deliver-code');
  assert.equal(nonCode.documentation.blocking, false);
});

test('documentation advisories never change draft-check readiness', async (t) => {
  const { root, phase, workflow, config } = await repository(t);
  phase.requiredArtifact = {
    path: 'artifacts/implementation/implementation-summary.md', kind: 'implementation-summary', minimumBytes: 20,
    validation: { requiredHeadings: ['Implementation'], forbiddenPlaceholders: [] }
  };
  await put(root, 'singularity/work-items/DOCS-1/artifacts/implementation/implementation-summary.md',
    '# Implementation\n\nThe ledger gains an added entry point, covered by tests.\n');
  await put(root, 'src/ledger.js', `/** Existing and documented. */
export function documented() { return 1; }

export function legacy() { return 2; }

export function added(entry) { return entry; }
`);
  const draft = await phaseDraftCheck(root, config, workflow, phase, {
    session: { workId: 'DOCS-1', phaseId: 'implementation', agent: 'developer' }
  });
  assert.deepEqual(draft.advisories.map((entry) => entry.value), ['added']);
  assert.equal(draft.documentation.status, 'missing');
  assert.equal(draft.findings.some((finding) => finding.code === 'code.documentation.missing'), false,
    'an advisory is never a finding');
  assert.equal(draft.status, 'ready');
  assert.notEqual(draft.commands.publish, null, 'publication is still offered');
});

test('advisories still run when the generation also committed Story records, and skip tests and migrations', async (t) => {
  const { root, phase, workflow, config } = await repository(t);
  // Story records committed during the generation are added files, which the change set lists
  // before the edited product file; Git lists them by path.
  await put(root, 'singularity/work-items/DOCS-1/context/implementation-gen1.json', '{"phase":"implementation"}\n');
  await put(root, 'pkg/ledger_test.go', 'package ledger\n\nfunc TestPost(t *testing.T) {}\n');
  await put(root, 'db/migrate/001_create_ledger.rb', 'class CreateLedger\n  def change\n  end\nend\n');
  await put(root, 'app/test_service.py', 'def test_serve():\n    pass\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'story records and tests');
  await put(root, 'src/ledger.js', `/** Existing and documented. */
export function documented() { return 1; }

export function legacy() { return 2; }

// @clause:DOCS-1:REQ-001
export function added(entry) {
  return entry;
}
`);
  const { documentation, advisories } = await inspectCodeDocumentation(root, config, workflow, phase);
  assert.equal(documentation.status, 'missing', `not unavailable: ${documentation.reason}`);
  assert.deepEqual(advisories.map((entry) => `${entry.path}:${entry.value}`), ['src/ledger.js:added'],
    'Go and Python tests and a migration are not product APIs');
});
