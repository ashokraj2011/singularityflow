import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishedSpecificationStory } from './helpers/source-review-fixture.mjs';
import { loadConfig } from '../src/state.mjs';
import { loadStoryAggregate } from '../src/state-stores.mjs';
import { resolveWorkType } from '../src/config.mjs';
import { addDocuments, restoreLocalDocument } from '../src/documents.mjs';
import { gitDir } from '../src/git.mjs';
import { readLocalDocument } from '../src/document-storage.mjs';
import { withLocalDocumentEvidence, writePrivateDocumentExport } from '../src/document-runtime.mjs';
import { compose } from '../src/phase-prompt-composer.mjs';
import { pinnedStorySource } from '../src/story-epic-sources.mjs';
import { buildAutoPhaseContract, absoluteAutoReadScope, absoluteAutoWriteScope } from '../src/auto/auto-phase-contract.mjs';
import { localDocumentReadScope, materializeAutoDocumentReadScope } from '../src/auto/auto-document-scope.mjs';
import { buildAutoAgentTaskContract } from '../src/auto/auto-contract-records.mjs';
import { acpPermissionOutcome, copilotAllowedRootArguments } from '../src/model-providers/copilot-cli.mjs';

const marker = 'PRIVATE_LOCAL_EVIDENCE_935271';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const { root, phaseId, authorAgent } = await publishedSpecificationStory(t);
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-delivery-uploads-'));
  t.after(() => rm(uploads, { recursive: true, force: true }));
  const text = path.join(uploads, 'private requirements.md');
  const image = path.join(uploads, 'private screen.png');
  await writeFile(text, `# Local source\n${marker}\n`);
  await writeFile(image, png);
  const definition = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, definition, 'REVIEW-1');
  const records = await addDocuments(root, definition, workflow, {
    files: [text, image], names: ['Private requirements', 'Private screen']
  });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Retain attachment identities');
  return { root, uploads, phaseId, authorAgent, definition, workflow, records };
}

function contractOptions(f, phase = f.workflow.phases[f.phaseId]) {
  return {
    state: { flightId: `AFL-${'A'.repeat(26)}`, planSha256: `sha256:${'1'.repeat(64)}`,
      createdAt: '2026-10-21T00:00:00.000Z', story: { workId: 'REVIEW-1' }, counters: {} },
    plan: { planId: 'APL-DELIVERY', proposal: { predictedPaths: ['src/**'], acceptanceCriteria: ['AC-001'] },
      requirement: { text: 'Use the local attachments' }, bindings: {},
      execution: { ceilings: { maximumTouchedPaths: 4, maximumTouchedChanges: 4,
        maximumModelInvocations: 1, tokenBudget: { maximum: 10000, assurance: 'best-available' } } } },
    definition: f.definition, workflow: f.workflow, phase, task: 'implementation',
    composed: '# Evidence context', provider: { provider: 'copilot-cli' }
  };
}

test('fresh and reused compose exports deliver local text and exact image paths privately', async t => {
  const f = await fixture(t);
  const { root, phaseId, authorAgent } = f;
  const destination = path.join(gitDir(root), 'singularity-flow', 'document-context', 'exports', 'prompt.md');
  const options = { 'work-id': 'REVIEW-1', phase: phaseId, agent: authorAgent,
    out: destination, 'return-only': true };
  const first = await compose(root, options);
  const second = await compose(root, options);
  const image = await readLocalDocument(root, 'REVIEW-1', f.records[1]);
  for (const text of [first, second, await readFile(destination, 'utf8')]) {
    assert.match(text, new RegExp(marker));
    assert.ok(text.includes(JSON.stringify(image.absolutePath)));
    assert.match(text, /inspect the actual pixels/);
  }
  assert.equal(await readFile(destination, 'utf8'), second);
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Retain durable composition');
  assert.equal(spawnSync('git', ['grep', '-F', marker, 'HEAD'], { cwd: root }).status, 1);
  assert.equal(git(root, 'ls-files').includes('exports/prompt.md'), false);
  const snapshots = git(root, 'ls-files', 'singularity/work-items/REVIEW-1/context');
  for (const file of snapshots.split('\n').filter(Boolean)) {
    const bytes = await readFile(path.join(root, file), 'utf8');
    assert.ok(!bytes.includes(marker));
    assert.ok(!bytes.includes(image.absolutePath));
  }
});

test('fresh exports without local attachments keep portable durable bytes, not reply personalization', async t => {
  const { root, phaseId, authorAgent } = await publishedSpecificationStory(t);
  const previous = process.env.SINGULARITY_FLOW_REPLY_NAME;
  process.env.SINGULARITY_FLOW_REPLY_NAME = 'Export Reader';
  t.after(() => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_REPLY_NAME;
    else process.env.SINGULARITY_FLOW_REPLY_NAME = previous;
  });
  const out = path.join(root, 'metadata-only-prompt.md');
  const delivered = await compose(root, { 'work-id': 'REVIEW-1', phase: phaseId,
    agent: authorAgent, 'render-only': true, 'return-only': true, out });
  assert.match(delivered, /Preferred name \(literal data\): "Export"/);
  assert.doesNotMatch(await readFile(out, 'utf8'), /# Reply personalization/);
});

test('local-evidence exports refuse working-tree files and unsafe aliases without writing their content', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'prompt.md');
  await writeFile(target, 'keep existing export');
  await assert.rejects(writePrivateDocumentExport(f.root, target, marker),
    error => error.code === 'LOCAL_DOCUMENT_EXPORT_PATH_REQUIRED'
      && error.details.suggestedPath.startsWith(gitDir(f.root)));
  assert.equal(await readFile(target, 'utf8'), 'keep existing export');
  // Junctions work without Windows symlink privileges and exercise the same escape boundary.
  const privateDirectory = path.join(gitDir(f.root), 'singularity-flow');
  await mkdir(privateDirectory, { recursive: true });
  const alias = path.join(privateDirectory, 'escape');
  await symlink(f.uploads, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writePrivateDocumentExport(f.root, path.join(alias, 'leak.md'), marker));
  await assert.rejects(stat(path.join(f.uploads, 'leak.md')), { code: 'ENOENT' });
});

test('CRLF takeover replays pinned source bytes but never accepts substantive source edits', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'singularity/work-items/REVIEW-1/source.json');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
  assert.deepEqual(await pinnedStorySource(f.root, f.definition, f.workflow), JSON.parse(original));
  const prompt = await compose(f.root, { 'work-id': 'REVIEW-1', phase: f.phaseId,
    agent: f.authorAgent, 'render-only': true, 'return-only': true });
  assert.match(prompt, new RegExp(marker));
  const changed = JSON.parse(original);
  changed.title = 'An unapproved substantive source change';
  await writeFile(file, JSON.stringify(changed, null, 2));
  await assert.rejects(pinnedStorySource(f.root, f.definition, f.workflow), { code: 'WORK_SOURCE_HASH_MISMATCH' });
  await assert.rejects(compose(f.root, { 'work-id': 'REVIEW-1', phase: f.phaseId,
    agent: f.authorAgent, 'render-only': true, 'return-only': true }), { code: 'WORK_SOURCE_HASH_MISMATCH' });
});

test('Auto binds local evidence by ID/hash and grants only exact read-only files to ACP', async t => {
  const f = await fixture(t);
  const contract = await buildAutoPhaseContract(f.root, contractOptions(f));
  const refs = f.records.map(localDocumentReadScope);
  assert.ok(refs.every(ref => contract.taskContract.readScope.includes(ref)));
  const grants = await materializeAutoDocumentReadScope(f.root, f.definition, f.workflow, f.phaseId,
    contract.taskContract.readScope);
  const text = await readLocalDocument(f.root, 'REVIEW-1', f.records[0]);
  const image = await readLocalDocument(f.root, 'REVIEW-1', f.records[1]);
  assert.deepEqual(grants.readRoots.sort(), [text.absolutePath, image.absolutePath].sort());
  assert.ok(!JSON.stringify(contract).includes(f.root));
  assert.ok(!JSON.stringify(contract).includes(text.absolutePath));
  assert.ok(!JSON.stringify(contract).includes(marker));
  const readRoots = [...absoluteAutoReadScope(f.root, contract.taskContract.readScope), ...grants.readRoots];
  const request = { cwd: f.root, allowedRoots: [f.root, ...grants.allowedRoots],
    tools: { mode: 'allowlist', names: contract.allowedTools,
      scope: { protocol: 'path-v1', readRoots, writeRoots: absoluteAutoWriteScope(f.root, contract.taskContract.writeScope) } } };
  const decide = (file, kind = 'read') => acpPermissionOutcome(request, {
    toolCall: { name: kind === 'read' ? 'view' : 'edit', kind, rawInput: { path: file } },
    options: [{ optionId: 'allow', kind: 'allow_once' }]
  });
  assert.deepEqual(await decide(image.absolutePath), { outcome: 'selected', optionId: 'allow' });
  assert.deepEqual(await decide(text.absolutePath), { outcome: 'selected', optionId: 'allow' });
  assert.deepEqual(await decide(image.absolutePath, 'edit'), { outcome: 'cancelled' });
  const sibling = path.join(path.dirname(image.absolutePath), 'unoffered.md');
  await writeFile(sibling, 'must not be read');
  assert.deepEqual(await decide(sibling), { outcome: 'cancelled' });
  assert.deepEqual(await decide(path.join(gitDir(f.root), 'config')), { outcome: 'cancelled' });
  const args = copilotAllowedRootArguments(request);
  assert.ok(grants.allowedRoots.every(dir => args.includes(dir)));
  assert.ok(!args.includes(gitDir(f.root)), 'never grant the whole Git directory');
  const input = structuredClone(contract.taskContract);
  input.writeScope.push(refs[0]);
  assert.throws(() => buildAutoAgentTaskContract(input), /writable local-document/);
  assert.throws(() => absoluteAutoWriteScope(f.root, [refs[0]]), /never a write path/);
});

test('Auto refuses missing, changed, detached and forged attachments before provider access', async t => {
  const f = await fixture(t);
  const refs = f.records.map(localDocumentReadScope);
  await assert.rejects(materializeAutoDocumentReadScope(f.root, f.definition, f.workflow, f.phaseId,
    [...refs, `sfdoc:local/DOC-999/${'1'.repeat(64)}`]), { code: 'AUTO_DOCUMENT_SCOPE_CHANGED' });
  const original = await readLocalDocument(f.root, 'REVIEW-1', f.records[0]);
  await writeFile(original.absolutePath, 'changed local bytes');
  await assert.rejects(materializeAutoDocumentReadScope(f.root, f.definition, f.workflow, f.phaseId, refs),
    error => error.code === 'DOCUMENT_REUPLOAD_REQUIRED'
      && error.details.documentReadiness.missing[0].id === f.records[0].id);
  await rm(original.absolutePath);
  await assert.rejects(materializeAutoDocumentReadScope(f.root, f.definition, f.workflow, f.phaseId, refs),
    { code: 'DOCUMENT_REUPLOAD_REQUIRED' });
  const file = path.join(f.root, 'singularity/work-items/REVIEW-1/documents.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.documents[0].status = 'detached';
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(materializeAutoDocumentReadScope(f.root, f.definition, f.workflow, f.phaseId, refs),
    { code: 'AUTO_DOCUMENT_SCOPE_CHANGED' });
});

test('linked Story worktrees export privately and takeover resolves the same grants on the new laptop', async t => {
  const f = await fixture(t);
  const contract = await buildAutoPhaseContract(f.root, contractOptions(f));
  const scope = contract.taskContract.readScope;
  const linked = path.join(f.uploads, 'linked story');
  git(f.root, 'worktree', 'add', '--detach', linked, 'HEAD');
  const first = await materializeAutoDocumentReadScope(f.root, f.definition, f.workflow, f.phaseId, scope);
  const shared = await materializeAutoDocumentReadScope(linked, f.definition, f.workflow, f.phaseId, scope);
  assert.deepEqual(await Promise.all(shared.readRoots.map(file => realpath(file))),
    await Promise.all(first.readRoots.map(file => realpath(file))),
    'linked worktrees read originals from their common private store (including macOS path aliases)');
  const destination = path.join(gitDir(linked), 'singularity-flow', 'document-context', 'exports', 'linked.md');
  const prompt = await withLocalDocumentEvidence(linked, f.definition, f.workflow, f.phaseId, '# Linked phase');
  await writePrivateDocumentExport(linked, destination, prompt);
  assert.match(await readFile(destination, 'utf8'), new RegExp(marker));
  assert.equal(git(linked, 'status', '--porcelain'), '');

  const clone = path.join(f.uploads, 'another laptop');
  git(f.root, 'clone', '--quiet', '--no-local', f.root, clone);
  const before = git(clone, 'rev-parse', 'HEAD');
  await assert.rejects(materializeAutoDocumentReadScope(clone, f.definition, f.workflow, f.phaseId, scope),
    { code: 'DOCUMENT_REUPLOAD_REQUIRED' });
  for (const record of f.records) {
    await restoreLocalDocument(clone, f.definition, f.workflow, {
      documentId: record.id, file: path.join(f.uploads, record.sourceName)
    });
  }
  const restored = await materializeAutoDocumentReadScope(clone, f.definition, f.workflow, f.phaseId, scope);
  assert.equal(restored.readRoots.length, first.readRoots.length);
  const canonicalClone = await realpath(gitDir(clone));
  assert.ok((await Promise.all(restored.readRoots.map(file => realpath(file))))
    .every(file => file.startsWith(canonicalClone)));
  assert.ok(restored.readRoots.every(file => !first.readRoots.includes(file)));
  assert.equal(git(clone, 'rev-parse', 'HEAD'), before);
  assert.equal(git(clone, 'status', '--porcelain'), '');
});

test('shared local handoff covers every seeded workflow phase and custom phases without widening scope', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'singularity/work-items/REVIEW-1/documents.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  // Legacy unscoped originals are offered to every phase, including newly added custom ones.
  for (const record of manifest.documents) delete record.phases;
  await writeFile(file, JSON.stringify(manifest));
  let checked = 0;
  const phases = new Set();
  for (const workType of Object.keys(f.definition.workTypes)) {
    for (const phase of resolveWorkType(f.definition, workType).phases) phases.add(phase.id);
    checked += 1;
  }
  phases.add('custom-intake');
  phases.add('custom-repair');
  phases.add('custom-retest');
  for (const phaseId of phases) {
    const prompt = await withLocalDocumentEvidence(f.root, f.definition, f.workflow, phaseId, '# Phase');
    assert.match(prompt, new RegExp(marker), phaseId);
    const scope = f.records.map(localDocumentReadScope);
    assert.equal((await materializeAutoDocumentReadScope(f.root, f.definition, f.workflow, phaseId, scope)).readRoots.length, 2);
  }
  assert.ok(checked >= 10 && phases.size >= 10, `Only checked ${checked} workflows / ${phases.size} phases`);
  manifest.documents[0].phases = ['custom-repair'];
  manifest.documents[1].phases = ['custom-retest'];
  await writeFile(file, JSON.stringify(manifest));
  assert.ok(!(await withLocalDocumentEvidence(f.root, f.definition, f.workflow, 'custom-retest', '# Phase')).includes(marker));
  const retest = await materializeAutoDocumentReadScope(f.root, f.definition, f.workflow, 'custom-retest',
    [localDocumentReadScope(f.records[1])]);
  assert.equal(retest.readRoots.length, 1);
  await assert.rejects(materializeAutoDocumentReadScope(f.root, f.definition, f.workflow, 'custom-retest',
    f.records.map(localDocumentReadScope)), { code: 'AUTO_DOCUMENT_SCOPE_CHANGED' });
  console.log(`Qualified local delivery for ${checked} seeded workflows and ${phases.size} distinct seeded/custom phases.`);
});
