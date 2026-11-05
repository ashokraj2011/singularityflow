import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { environment } from './helpers/run-and-test-fixture.mjs';
import { readDraft, saveDraft, snapshotDigest } from '../src/spec-library/draft-store.mjs';
import { newDraft, originCoverage, publicationContinuation } from '../src/spec-library/draft-model.mjs';
import { applyFocusedEdits } from '../src/spec-library/proposals.mjs';
import { resolveSlices } from '../src/spec-library/slice.mjs';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const specId = 'SPEC-WRITE-001';
const run = (cwd, command, argv, env) => {
  const result = spawnSync(command, argv, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
};
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-write-together-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const env = environment(path.join(base, 'context'));
  const git = (cwd, ...args) => { const result = run(cwd, 'git', args, env); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'writer');
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', root);
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Initial'); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
  const cli = (cwd, ...args) => {
    const result = run(cwd, process.execPath, [bin, '--no-model', ...args, '--json'], { ...env, SINGULARITY_FLOW_AGENT_OUTPUT: 'full' });
    assert.ok(result.stdout.trim(), result.stderr);
    return { status: result.status, value: JSON.parse(result.stdout) };
  };
  const sf = (...args) => { const result = cli(root, 'spec', 'author', ...args); assert.equal(result.status, 0, JSON.stringify(result.value)); return result.value; };
  const fail = (...args) => { const result = cli(root, 'spec', 'author', ...args); assert.notEqual(result.status, 0); return result.value.error; };
  const create = () => sf('new', specId, '--title', 'A small idea', '--kind', 'business', '--operation-id', 'create');
  return { base, env, root, remote, git, cli, sf, fail, create };
}

const wording = id => `# Order outcomes

## Outcome
People can place an order and see its reference.

## Actors
- Customer places an order.

## User scenarios
1. A customer submits one valid order and sees its reference.

## Scope
In scope: order creation. Out of scope: payment.

## Requirements
WHEN a customer submits a valid order, the service SHALL return a unique order reference. [${id}:REQ-001]

## Acceptance
A submitted valid order returns one non-empty reference. [${id}:AC-001]

## Decisions and open questions
No open decisions.
`;
async function ready(repo, id, text, kind = id === specId ? 'business' : 'technical') {
  const file = path.join(repo.base, id + '.md'); await writeFile(file, text);
  const status = repo.sf('status', id, '--quick');
  repo.sf('edit', id, '--file', file, '--kind', kind, '--expected-seq', String(status.sequence));
  repo.sf('settle', id, ...['completeness','ambiguity','consistency','verifiability','boundary-conditions','non-functional'].flatMap(article => ['--article', article + '=satisfied']));
  assert.equal(repo.sf('check', id).report.reviewReady, true);
  return repo.sf('publish', id, '--reviewed');
}

test('an idea can be saved with an automatic ID offline; kind is confirmed only before review', async t => {
  const repo = await fixture(t);
  repo.git(repo.root, 'remote', 'set-url', 'origin', path.join(repo.base, 'offline.git'));
  const first = repo.sf('new', '--intent', 'Help customers order', '--operation-id', 'offline-create');
  const again = repo.sf('new', '--intent', 'Help customers order', '--operation-id', 'offline-create');
  assert.equal(first.specId, again.specId);
  assert.equal(again.replayed, true);
  const quick = repo.sf('status', first.specId, '--quick');
  assert.equal(quick.qualityChecked, false);
  assert.equal(quick.kind, null);
  assert.equal(repo.sf('check', first.specId).report.blocking.some(f => f.code === 'spec.kind-unconfirmed'), true);
  const library = repo.sf('list', '--local');
  assert.equal(library.state.status, 'not-fetched', 'an unfetched remote must not be described as an empty shared library');
  assert.equal(library.drafts.some(draft => draft.specId === first.specId), true);
  assert.equal(repo.git(repo.root, 'status', '--porcelain'), '', 'saving never writes application files');
});

test('shared checkpoints are unreviewed, idempotent and conflict-aware on two laptops', async t => {
  const repo = await fixture(t); repo.create();
  const first = repo.sf('sync', specId);
  assert.equal(first.reviewed, false);
  assert.equal(repo.sf('sync', specId).unchanged, true);
  const reader = path.join(repo.base, 'reader'); repo.git(repo.base, 'clone', '-q', repo.remote, reader);
  const shared = repo.cli(reader, 'spec', 'author', 'shared', specId, '--refresh').value.drafts[0];
  assert.equal(shared.checkpointSha256, first.checkpointSha256);
  const resumed = repo.cli(reader, 'spec', 'author', 'resume', specId, '--checkpoint', first.checkpointSha256, '--expected-seq', '0', '--operation-id', 'resume');
  assert.equal(resumed.status, 0, JSON.stringify(resumed.value));
  assert.equal((await readDraft(reader, specId)).head.draft.kind, 'business');
  const mine = path.join(repo.base, 'mine.md'); await writeFile(mine, 'My preserved draft');
  repo.sf('edit', specId, '--file', mine, '--expected-seq', '1'); repo.sf('sync', specId);
  const theirs = path.join(repo.base, 'theirs.md'); await writeFile(theirs, 'Another writer');
  assert.equal(repo.cli(reader, 'spec', 'author', 'edit', specId, '--file', theirs, '--expected-seq', '1').status, 0);
  const conflict = repo.cli(reader, 'spec', 'author', 'sync', specId);
  assert.equal(conflict.value.error.code, 'SPEC_SHARED_DRAFT_CONFLICT');
  assert.equal((await readDraft(reader, specId)).head.draft.spec, 'Another writer');
  const current = repo.cli(reader, 'spec', 'author', 'shared', specId, '--refresh').value.drafts[0];
  const stale = repo.cli(reader, 'spec', 'author', 'resume', specId, '--checkpoint', current.checkpointSha256, '--expected-seq', '1');
  assert.equal(stale.value.error.code, 'SPEC_DRAFT_STALE');
  assert.equal(repo.cli(reader, 'spec', 'author', 'resume', specId, '--checkpoint', current.checkpointSha256, '--expected-seq', '2').status, 0);
  assert.ok((await readDraft(reader, specId)).snapshots.some(s => s.draft.spec === 'Another writer'));
});

test('automatic sharing is throttled per library and manual Sync now remains available', async t => {
  const repo = await fixture(t); repo.create();
  assert.equal(repo.sf('sync', specId, '--automatic').status, 'synced');
  const deferred = repo.sf('sync', specId, '--automatic');
  assert.equal(deferred.status, 'deferred'); assert.ok(deferred.retryAfterMs > 0);
  assert.equal(repo.sf('sync', specId).status, 'synced');
});

test('local documents and images stay off Git; takeover asks for the exact original', async t => {
  const repo = await fixture(t); repo.create();
  const original = path.join(repo.base, 'notes.txt'); const secret = 'Private supporting text, not a shared original.';
  await writeFile(original, secret);
  const added = repo.sf('source', specId, '--file', original); const descriptor = added.sources[0];
  const read = repo.sf('sources', specId, '--source', descriptor.id).sources[0];
  assert.equal(read.text, secret); assert.ok(path.isAbsolute(read.path));
  repo.sf('sync', specId);
  const checkpointFiles = repo.git(repo.root, 'ls-tree', '-r', '--name-only', 'refs/remotes/origin/state');
  assert.doesNotMatch(checkpointFiles, /notes\.txt/u);
  const checkpointPath = checkpointFiles.split('\n').find(p => /[a-f0-9]{64}\.json$/u.test(p));
  const checkpoint = repo.git(repo.root, 'show', 'refs/remotes/origin/state:' + checkpointPath);
  assert.doesNotMatch(checkpoint, new RegExp(secret, 'u'));
  assert.ok(!checkpoint.includes(repo.base), 'no absolute source path is synchronized');
  const reader = path.join(repo.base, 'takeover'); repo.git(repo.base, 'clone', '-q', repo.remote, reader);
  const shared = repo.cli(reader, 'spec', 'author', 'shared', specId, '--refresh').value.drafts[0];
  assert.equal(repo.cli(reader, 'spec', 'author', 'resume', specId, '--checkpoint', shared.checkpointSha256, '--expected-seq', '0').status, 0);
  const missing = repo.cli(reader, 'spec', 'author', 'sources', specId, '--source', descriptor.id).value.sources[0];
  assert.equal(missing.status, 'upload-required');
  const other = path.join(repo.base, 'different.txt'); await writeFile(other, 'Different bytes');
  assert.equal(repo.cli(reader, 'spec', 'author', 'source', specId, '--restore', descriptor.id, '--file', other).value.error.code, 'SPEC_SOURCE_REPLACEMENT_REQUIRED');
  assert.equal(repo.cli(reader, 'spec', 'author', 'source', specId, '--restore', descriptor.id, '--file', original).status, 0);
  assert.equal(repo.cli(reader, 'spec', 'author', 'sources', specId, '--source', descriptor.id).value.sources[0].text, secret);
  const fork = repo.sf('fork', specId, '--operation-id', 'copy');
  assert.equal(repo.sf('sources', fork.specId, '--source', descriptor.id).sources[0].text, secret);
  const image = path.join(repo.base, 'screen.png'); await writeFile(image, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  const picture = repo.sf('source', specId, '--file', image).sources.find(s => s.name === 'screen.png');
  assert.equal(repo.sf('sources', specId, '--source', picture.id).sources[0].status, 'image-ready');
});

test('earlier wording restores with a current sequence and retains later history', async t => {
  const repo = await fixture(t); repo.create();
  const old = repo.sf('status', specId, '--quick').spec;
  const file = path.join(repo.base, 'later.md'); await writeFile(file, 'Later words');
  repo.sf('edit', specId, '--file', file, '--expected-seq', '1');
  assert.equal(repo.fail('restore-version', specId, '--sequence', '1').code, 'SPEC_DRAFT_STALE');
  repo.sf('restore-version', specId, '--sequence', '1', '--expected-seq', '2');
  assert.equal(repo.sf('status', specId, '--quick').spec, old);
  assert.equal(repo.sf('history', specId, '--sequence', '2').draft.spec, 'Later words');
});

test('focused suggestions preserve unrelated manual writing and refuse changed or ambiguous targets', () => {
  const spec = '# Draft\n\nOriginal statement.\n';
  assert.equal(applyFocusedEdits(spec + '\nManual addition.\n', [{ before: 'Original statement.', after: 'Clearer statement.' }]), '# Draft\n\nClearer statement.\n\nManual addition.\n');
  assert.throws(() => applyFocusedEdits(spec, [{ before: 'Missing', after: 'Something' }]), { code: 'SPEC_PROPOSAL_STALE' });
  assert.throws(() => applyFocusedEdits('same same', [{ before: 'same', after: 'new' }]), { code: 'SPEC_PROPOSAL_STALE' });
});

test('a v1 draft keeps its original digest and is not rewritten when opened', async t => {
  const repo = await fixture(t);
  const saved = await saveDraft(repo.root, specId, { operationId: 'legacy', operation: 'new', create: true, change: () => newDraft({ title: 'Original', spec: wording(specId) }) });
  const file = path.join(repo.root, '.git', 'singularity-flow', 'spec-drafts', specId, '000001.json');
  const legacy = { ...saved.snapshot, schemaVersion: 1 }; delete legacy.draft.kind; legacy.snapshotSha256 = snapshotDigest(legacy);
  const bytes = JSON.stringify(legacy) + '\n'; await writeFile(file, bytes);
  assert.equal((await readDraft(repo.root, specId)).head.snapshotSha256, legacy.snapshotSha256);
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('technical derivation pins reviewed business requirements; Story handoff retains constraints and decisions', async t => {
  const repo = await fixture(t); repo.create(); await ready(repo, specId, wording(specId));
  const business = repo.sf('show', specId + '@1');
  const child = repo.sf('derive', specId + '@1', '--operation-id', 'technical');
  const status = repo.sf('status', child.specId, '--quick');
  assert.equal(status.kind, 'technical'); assert.equal(status.origins[0].manifestSha256, business.manifestSha256);
  assert.equal(repo.sf('check', child.specId).report.blocking.some(f => f.code === 'spec.origin-coverage'), true);
  const coverage = '\n## Business coverage\n\n| Source requirement | Technical requirement or disposition | Reason |\n| --- | --- | --- |\n'
    + '| ' + specId + ':REQ-001 | ' + child.specId + ':REQ-001 | Implements the order outcome. |\n'
    + '| ' + specId + ':AC-001 | ' + child.specId + ':AC-001 | Verifies the reference. |\n';
  await ready(repo, child.specId, wording(child.specId) + coverage);
  const slices = await resolveSlices(repo.root, {}, [child.specId + '@1'], { env: repo.env });
  assert.equal(slices[0].inheritedSpecifications[0].revision, specId + '@1');
  assert.equal(slices[0].inheritedSpecifications[0].standing, 'inherited-constraint');
  assert.equal(slices[0].inheritedSpecifications[0].clauses.length, 2);
  assert.equal(repo.sf('show', specId + '@1').spec, business.spec, 'derivation never rewrites business requirements');
  const reference = repo.sf('source', child.specId, '--specification', specId + '@1').sources.find(source => source.type === 'specification');
  assert.equal(repo.sf('sources', child.specId, '--source', reference.id).sources[0].text, business.spec);
  const single = await resolveSlices(repo.root, {}, [child.specId + '@1=REQ-001'], { env: repo.env });
  assert.ok(single[0].inheritedSpecifications[0].clauses.some(clause => clause.anchor.endsWith(':AC-001]')), 'parent acceptance accompanies a selected requirement');
  await ready(repo, specId, wording(specId).replace('unique order reference', 'unique order reference and status'));
  await assert.rejects(resolveSlices(repo.root, {}, [child.specId + '@1', specId + '@2'], { env: repo.env }), { code: 'SPEC_ORIGIN_VERSION_CONFLICT' });
});

test('unmapped, unknown and duplicate business coverage cannot appear ready', () => {
  const draft = { origins: [{ revision: 'SPEC-BIZ@1', manifestSha256: 'sha256:' + 'a'.repeat(64), clauses: [{ id: 'SPEC-BIZ:REQ-001' }] }],
    spec: '## Business coverage\n| SPEC-BIZ:REQ-001 | SPEC-TECH:REQ-999 | A guess. |' };
  assert.ok(originCoverage(draft, ['SPEC-TECH:REQ-001']).findings.length);
  draft.spec = '## Business coverage\n| SPEC-BIZ:REQ-001 | deferred | Product owner will decide rollout. |';
  assert.equal(originCoverage(draft, []).findings.length, 0);
  draft.spec += '\n| SPEC-BIZ:REQ-001 | excluded | Duplicate. |';
  assert.ok(originCoverage(draft, []).findings.length);
});

test('backup restore recovers a specification attachment without requiring a Story', async t => {
  const repo = await fixture(t); repo.create();
  const original = path.join(repo.base, 'local-notes.txt'); await writeFile(original, 'Local draft source');
  const source = repo.sf('source', specId, '--file', original).sources[0];
  const backup = path.join(repo.base, 'backup');
  const created = repo.cli(repo.root, 'backup', 'create', '--out', backup);
  assert.equal(created.status, 0, JSON.stringify(created.value)); assert.equal(created.value.documents, 1);
  await rm(path.join(repo.root, '.git', 'singularity-flow-documents'), { recursive: true });
  const restored = repo.cli(repo.root, 'backup', 'restore', backup);
  assert.equal(restored.status, 0, JSON.stringify(restored.value));
  assert.equal(restored.value.counts.documents.restored, 1, JSON.stringify(restored.value.documents));
  assert.equal(repo.sf('sources', specId, '--source', source.id).sources[0].text, 'Local draft source');
});

test('every phase receives local specification files through the existing document reader and restore route', async t => {
  const repo = await fixture(t); repo.create();
  const file = path.join(repo.base, 'requirements.txt'); await writeFile(file, 'The attached requirement text.');
  const descriptor = repo.sf('source', specId, '--file', file).sources[0];
  const { documentCatalog, viewDocument } = await import('../src/documents-read.mjs');
  const { documentOfferedToPhase } = await import('../src/document-identity.mjs');
  const phaseOrder = ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'custom-check'];
  const workflow = { workItem: { id: 'FROM-SPEC' }, phaseOrder,
    phases: Object.fromEntries(phaseOrder.map(id => [id, { id, status: 'in_progress', artifacts: [] }])) };
  const config = { workItemRoot: 'singularity/work-items' }; const directory = path.join(repo.root, config.workItemRoot, workflow.workItem.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'source.json'), JSON.stringify({ specification: [{ revision: specId + '@1', sources: [descriptor] }] }));
  for (const phaseId of workflow.phaseOrder) {
    const catalog = await documentCatalog(repo.root, config, workflow, { phaseId });
    const attached = catalog.find(item => item.specificationSource);
    assert.equal(attached.availability, 'available');
    assert.equal(documentOfferedToPhase(attached, phaseId), true);
    const viewed = await viewDocument(repo.root, config, workflow, attached.id);
    assert.equal(viewed.content, 'The attached requirement text.');
    assert.ok(path.isAbsolute(viewed.absolutePath));
  }
  await rm(path.join(repo.root, '.git', 'singularity-flow-documents'), { recursive: true });
  const attached = (await documentCatalog(repo.root, config, workflow)).find(item => item.specificationSource);
  await assert.rejects(viewDocument(repo.root, config, workflow, attached.id), { code: 'DOCUMENT_LOCAL_UNAVAILABLE' });
  const { restoreLocalDocument } = await import('../src/documents.mjs');
  const restored = await restoreLocalDocument(repo.root, config, workflow, { documentId: attached.id, file });
  assert.equal(restored.effects.pushed, false);
  assert.equal((await viewDocument(repo.root, config, workflow, attached.id)).content, 'The attached requirement text.');
});


test('one technical draft can pin two business specifications without inventing decisions', async t => {
  const repo = await fixture(t); repo.create(); await ready(repo, specId, wording(specId));
  const second = 'SPEC-BUSINESS-002';
  repo.sf('new', second, '--title', 'Delivery outcomes', '--kind', 'business');
  await ready(repo, second, wording(second), 'business');
  const technical = repo.sf('derive', specId + '@1', '--parent', second + '@1', '--parent', specId + '@1', '--operation-id', 'many-parents');
  const draft = repo.sf('status', technical.specId, '--quick');
  assert.deepEqual(draft.origins.map(origin => origin.revision), [specId + '@1', second + '@1']);
  assert.equal(draft.kind, 'technical');
  assert.equal(draft.gaps.length, 0);
  assert.equal(repo.fail('derive', specId + '@1', '--parent', specId + '@2').code, 'SPEC_LIBRARY_NOT_FOUND');
});

test('a lost checkpoint acknowledgement reconciles the same publication after restart', async t => {
  const repo = await fixture(t); repo.create();
  const crashed = run(repo.root, process.execPath, [bin, 'spec', 'author', 'sync', specId, '--json'], { ...repo.env, SINGULARITY_FLOW_TEST_CRASH_AT: 'spec-draft-synced' });
  if (process.platform === 'win32') assert.equal(crashed.status, 1); else assert.equal(crashed.signal, 'SIGKILL');
  const seen = repo.sf('shared', specId, '--refresh'); const commit = seen.commit;
  assert.equal(seen.drafts.length, 1);
  const resumed = repo.sf('sync', specId);
  assert.equal(resumed.checkpointSha256, seen.drafts[0].checkpointSha256);
  assert.equal(repo.sf('shared', specId, '--refresh').commit, commit, 'no second checkpoint commit was made');
  assert.equal(repo.sf('status', specId, '--quick').sequence, 1, 'sync bookkeeping never advances document history');
});

test('isolated bases on the same laptop receive verified source copies without changing descriptors', async t => {
  const repo = await fixture(t); repo.create(); const file = path.join(repo.base, 'source.txt'); await writeFile(file, 'A local source.');
  const descriptor = repo.sf('source', specId, '--file', file).sources[0];
  const isolated = path.join(repo.base, 'isolated'); repo.git(repo.base, 'clone', '-q', repo.remote, isolated);
  const { copySpecSources, readSpecSource } = await import('../src/spec-library/sources.mjs');
  assert.equal((await readSpecSource(isolated, specId, descriptor)).status, 'upload-required');
  await copySpecSources(repo.root, specId, specId, [descriptor], { targetRoot: isolated });
  const copied = await readSpecSource(isolated, specId, descriptor);
  assert.equal(copied.text, 'A local source.'); assert.equal(copied.source.sha256, descriptor.sha256);
  // A changed stored copy is kept privately when the exact original is reattached.
  await writeFile(copied.path, 'Changed source!');
  const changed = await readSpecSource(isolated, specId, descriptor); assert.equal(changed.status, 'upload-required');
});

test('a reviewed source can be restored on another laptop without creating a local draft or a new version', async t => {
  const repo = await fixture(t); repo.create();
  const file = path.join(repo.base, 'original.txt'); await writeFile(file, 'Original source bytes.');
  const descriptor = repo.sf('source', specId, '--file', file).sources[0];
  await ready(repo, specId, wording(specId));
  const reader = path.join(repo.base, 'read-only-laptop'); repo.git(repo.base, 'clone', '-q', repo.remote, reader);
  const before = repo.git(reader, 'rev-parse', 'refs/remotes/origin/state');
  assert.equal(repo.cli(reader, 'spec', 'author', 'sources', specId + '@1', '--source', descriptor.id).value.sources[0].status, 'upload-required');
  const restore = repo.cli(reader, 'spec', 'author', 'source', specId + '@1', '--restore', descriptor.id, '--file', file);
  assert.equal(restore.status, 0, JSON.stringify(restore.value)); assert.equal(restore.value.localOnly, true);
  assert.equal(await readDraft(reader, specId), null);
  assert.equal(repo.git(reader, 'rev-parse', 'refs/remotes/origin/state'), before);
  assert.equal(repo.cli(reader, 'spec', 'author', 'sources', specId + '@1', '--source', descriptor.id).value.sources[0].text, 'Original source bytes.');
});

test('incomplete clause syntax remains saveable and readable without claiming readiness', async t => {
  const repo = await fixture(t); repo.create();
  const file = path.join(repo.base, 'incomplete.md');
  const text = wording(specId) + '\nA duplicate unfinished clause. [' + specId + ':REQ-001]\n';
  await writeFile(file, text); repo.sf('edit', specId, '--file', file, '--expected-seq', '1');
  const quick = repo.sf('status', specId, '--quick');
  assert.equal(quick.spec, text); assert.equal(quick.qualityChecked, false); assert.equal(quick.reviewReady, false);
  assert.equal(repo.sf('check', specId).report.reviewReady, false);
});

test('the CLI source reader completes a long Unicode line using exact character continuation', async t => {
  const repo = await fixture(t); repo.create(); const file = path.join(repo.base, 'long.txt'); const text = '🙂'.repeat(30000);
  await writeFile(file, text); const source = repo.sf('source', specId, '--file', file).sources[0];
  let result = '', from = 1, column = 0, count = 0;
  do {
    const page = repo.sf('sources', specId, '--source', source.id, '--from', String(from), '--column', String(column)).sources[0];
    result += page.text;
    if (page.next == null) break;
    assert.ok(page.next > from || page.nextColumn > column);
    from = page.next; column = page.nextColumn ?? 0; assert.ok(++count < 40);
  } while (true);
  assert.equal(result, text);
});

test('publication acknowledgement preserves a newer draft without claiming it was already reviewed', async t => {
  const repo = await fixture(t); repo.create();
  const published = await ready(repo, specId, wording(specId));
  const reviewed = repo.sf('show', specId + '@1');
  const history = await readDraft(repo.root, specId);
  const original = history.snapshots.find(snapshot => snapshot.snapshotSha256 === reviewed.manifest.draft.snapshotSha256);
  const file = path.join(repo.base, 'later.md'); const later = wording(specId) + '\nAnother detail written during publication.\n';
  await writeFile(file, later);
  repo.sf('edit', specId, '--file', file, '--expected-seq', String(history.sequence));
  // Reproduce the acknowledgement arriving after the other writer saved.
  await saveDraft(repo.root, specId, { operationId: 'late-publication-ack', operation: 'published',
    change: current => publicationContinuation(current, original.draft, { revision: 1, manifestSha256: published.manifestSha256, reviewState: 'reviewed' }) });
  const next = repo.sf('publish', specId, '--reviewed');
  assert.equal(next.revision, 2, 'new writing needs a new reviewed revision instead of an unchanged replay');
  assert.equal(repo.sf('show', specId + '@2').spec, later);
  assert.equal(repo.sf('show', specId + '@1').spec, wording(specId), 'the original review remains immutable');
});

// ---- Sharing checks (review findings 1, 2) ------------------------------------------------------

/** Assembled here so no credential-shaped literal sits in the repository. */
const FAKE_TOKEN = 'ghp_' + 'Z9y8'.repeat(9);
const REAL = 'Zx9fK2mQ7vLp4Tn8';
const stateFiles = repo => {
  const listed = run(repo.root, 'git', ['ls-remote', '--heads', repo.remote, 'state'], repo.env).stdout.trim();
  return listed ? listed.split(/\s/u)[0] : null;
};
async function editProse(repo, id, text, name = 'prose.md') {
  const file = path.join(repo.base, name); await writeFile(file, text);
  return repo.sf('edit', id, '--file', file, '--expected-seq', String(repo.sf('status', id, '--quick').sequence));
}

test('a draft holding a secret is never shared or published; the writing stays saved and sharing resumes once it is gone', async t => {
  const repo = await fixture(t); repo.create();
  const shared = repo.sf('sync', specId); const before = stateFiles(repo);
  const text = wording(specId) + '\nDeploy with ' + FAKE_TOKEN + ' for now.\n';
  await editProse(repo, specId, text);
  for (const argv of [['sync', specId], ['sync', specId, '--automatic', '--min-interval-ms', '1000']]) {
    const refused = repo.cli(repo.root, 'spec', 'author', ...argv);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.value.error.code, 'SPEC_SHARED_DRAFT_SECRET');
    assert.match(refused.value.error.message, /GitHub token at line \d+ of the text/u);
    assert.match(refused.value.error.message, /sflow-allow-secret, then a colon/u, 'the waiver reads as written: a host scrubber once replaced it');
    assert.doesNotMatch(refused.value.error.message, /REDACTED/u);
    assert.match(refused.value.error.message, /saved on this laptop/u);
    assert.ok(!JSON.stringify(refused.value).includes(FAKE_TOKEN), 'a refusal never repeats the value');
  }
  assert.equal(stateFiles(repo), before, 'nothing left this laptop');
  assert.equal(repo.sf('status', specId, '--quick', '--for-person').spec, text, 'the writing is still saved');
  const publication = repo.cli(repo.root, 'spec', 'author', 'publish', specId, '--draft');
  assert.equal(publication.value.error.code, 'SPEC_PUBLISH_SECRET');
  assert.equal(stateFiles(repo), before, 'a revision is immutable too, so it is refused the same way');
  // A person can still write: removing the value shares again, and the refused text never reached a checkpoint.
  await editProse(repo, specId, wording(specId));
  const resumed = repo.sf('sync', specId);
  assert.notEqual(resumed.checkpointSha256, shared.checkpointSha256);
  repo.git(repo.root, 'fetch', '-q', 'origin', '+refs/heads/state:refs/remotes/origin/state');
  const objects = repo.git(repo.root, 'log', '-p', 'refs/remotes/origin/state');
  assert.ok(!objects.includes(FAKE_TOKEN), 'the state branch history never held it');
  // The scanner's own waiver works here: on the line, with a reason.
  await editProse(repo, specId, wording(specId) + '\nExample only: ' + FAKE_TOKEN + ' sflow-allow-secret: a documented sample\n');
  assert.equal(repo.sf('sync', specId).status, 'synced');
});

test('a link carrying a credential stays out of shared records, in a new source, an old one and the wording', async t => {
  const repo = await fixture(t); repo.create();
  for (const link of [`https://files.acme.io/doc?sig=${REAL}`, `https://files.acme.io/doc?X-Amz-Signature=${REAL}`, `https://files.acme.io/doc#access_token=${REAL}`,
    `https://files.acme.io/doc?client_secret=${REAL}`, `https://files.acme.io/doc?a=1&sig=${REAL}`]) {
    assert.equal(repo.fail('source', specId, '--url', link).code, 'SPEC_SOURCE_URL_CREDENTIALS', link);
  }
  assert.equal(repo.sf('source', specId, '--url', 'https://files.acme.io/doc?node-id=12#L4').sources[0].type, 'url', 'an ordinary query stays usable');
  assert.equal(repo.sf('source', specId, '--url', 'https://api.example.com/doc?token=abc123&auth=true').sources[1].type, 'url', 'and so does documentation');
  // Saved before this refusal existed.
  await saveDraft(repo.root, specId, { operationId: 'old-link', operation: 'source', change: draft => ({ ...draft,
    sources: [...draft.sources, { id: 'SRC-0000000000000001', type: 'url', name: 'files.acme.io', url: `https://files.acme.io/old?token=${REAL}`, purpose: '', standing: 'not-read' }] }) });
  const refused = repo.fail('sync', specId);
  assert.equal(refused.code, 'SPEC_SHARED_DRAFT_SECRET');
  assert.match(refused.message, /'token' parameter at source 3/u);
  assert.match(refused.message, /spec author source SPEC-WRITE-001 --remove/u, 'it says how to clear it');
  assert.equal(stateFiles(repo), null);
  assert.equal(repo.sf('sources', specId, '--source', 'SRC-0000000000000001').sources[0].status, 'refused', 'nor is it handed to a model');
  repo.sf('source', specId, '--remove', 'SRC-0000000000000001');
  // In the prose too; a placeholder is how documentation writes one, and is left alone.
  await editProse(repo, specId, wording(specId) + `\nRead https://files.acme.io/doc?sig=${REAL} first.\n`);
  assert.equal(repo.fail('sync', specId).code, 'SPEC_SHARED_DRAFT_SECRET');
  await editProse(repo, specId, wording(specId) + '\nCall https://api.acme.io/v1?token=<TOKEN> with your own.\n');
  assert.equal(repo.sf('sync', specId).status, 'synced');
});

test('a value is judged by its shape, in every form a link can take it', async () => {
  const { assertFilesShareable, linkCredentials, screenText } = await import('../src/spec-library/share-check.mjs');
  const refused = link => screenText(`See ${link} for it.`).length > 0;
  // What a reviewer found passing.
  for (const link of [
    `https://x.io/d?token=...&sig=${REAL}`, `https://x.io/d?auth=&sig=${REAL}`, `https://x.io/d?sig=xxx&sig=${REAL}`, `https://x.io/d?a=1&amp;sig=${REAL}`, `https://x.io/d?a=1;sig=${REAL}`,
    `https://x.io/a_(b)/doc?sig=${REAL}`, `https://x.io/a[]=1?sig=${REAL}`, `[the doc](https://x.io/a_(b)/doc?sig=${REAL})`,
    `https://x.io/d?client_secret=${REAL}`, `https://x.io/d?auth_token=${REAL}`, `https://x.io/d?private_token=${REAL}`, `https://x.io/d?x-api-key=${REAL}`, `https://x.io/d?key=${REAL}`, `https://x.io/d?jwt=${REAL}`,
    `https://x.io/d?accessToken=${REAL}`, `wss://x.io/socket?token=${REAL}`, `postgres://db.x.io/app?password=${REAL}`, `https://${REAL}@git.x.io/repo.git`,
    `https://hooks.slack.com/services/T00000000/B00000000/${REAL}${REAL}`
  ]) assert.ok(refused(link), link);
  // Ordinary specifications.
  for (const link of [
    'https://x.io/d?auth=true', 'https://x.io/d?auth=google', 'https://api.example.com/v1/items?token=abc123', `https://api.example.com/v1/items?token=${REAL}`, `https://svc.test/d?sig=${REAL}`,
    'https://x.io/d?token=abc123', 'https://x.io/d?token=<TOKEN>', 'https://x.io/d?key=PROJ-1', 'https://x.io/d?key=value', 'https://x.io/d?keyboard=dvorak', `https://x.io/d?page_token=${REAL}`,
    'https://x.io/d?node-id=12:34', 'https://git@git.x.io/team/repo.git', 'https://git.x.io/team/repo/commit/0123456789abcdef0123456789abcdef01234567', 'https://x.io/d?signature=required'
  ]) assert.ok(!refused(link), link);
  assert.deepEqual(linkCredentials('not a link'), []);
  // The scanner still finds what it always found, in a file exactly as it ships, and its waiver still works.
  const checkpoint = draft => ({ 'abc.json': JSON.stringify({ draft }) });
  const token = FAKE_TOKEN;
  assert.throws(() => assertFilesShareable(specId, checkpoint({ spec: `One\nTwo ${token}\n` })), error => error.code === 'SPEC_SHARED_DRAFT_SECRET' && !error.message.includes(token));
  assert.doesNotThrow(() => assertFilesShareable(specId, checkpoint({ spec: `One ${token} sflow-allow-secret: a sample\n` })));
  assert.doesNotThrow(() => assertFilesShareable(specId, checkpoint({ spec: 'Plain.', origins: [{ clauses: [{ text: `Pinned ${token}` }] }] })), 'a parent already on the state branch is not judged again');
});

test('a sharing check that breaks shares nothing and says so', async () => {
  const { assertFilesShareable } = await import('../src/spec-library/share-check.mjs');
  assert.throws(() => assertFilesShareable(specId, { 'checkpoint.json': '{ torn' }), error => error.code === 'SPEC_SHARE_CHECK_FAILED' && /saved on this laptop/u.test(error.message));
});

test('only what ships is judged, and a refusal always has a way through', async t => {
  const repo = await fixture(t); repo.create(); await editProse(repo, specId, wording(specId));
  const proposal = path.join(repo.base, 'proposal.json');
  await writeFile(proposal, JSON.stringify({ proposals: [{ kind: 'edit', summary: 'Use ' + FAKE_TOKEN, spec: wording(specId) + '\nDeploy with ' + FAKE_TOKEN + '\n' }] }));
  repo.sf('propose', specId, '--file', proposal);
  const pendingRefusal = repo.fail('sync', specId);
  assert.match(pendingRefusal.message, /Copilot suggestion 1/u); assert.match(pendingRefusal.message, /Reject that suggestion/u);
  // The way through works: a rejected suggestion's text does not ship, and a reviewed revision never carried suggestions.
  repo.sf('reject', specId, 'P-001', '--reason', 'No thanks.');
  assert.equal(repo.sf('sync', specId).status, 'synced');
  repo.git(repo.root, 'fetch', '-q', 'origin', '+refs/heads/state:refs/remotes/origin/state');
  assert.ok(!repo.git(repo.root, 'log', '-p', 'refs/remotes/origin/state').includes(FAKE_TOKEN), 'the rejected text stayed here');
  repo.sf('settle', specId, '--all-articles', 'satisfied');
  assert.equal(repo.sf('publish', specId, '--reviewed').revision, 1, 'publish is not refused for what it does not ship');
  // History nobody can edit still ships, so it is refused, and the refusal says where to go.
  repo.sf('new', 'SPEC-GAP-001', '--title', 'A question', '--kind', 'business', '--local');
  repo.sf('gap', 'SPEC-GAP-001', '--kind', 'open-question', '--question', 'Which token, ' + FAKE_TOKEN + '?');
  const history = repo.fail('sync', 'SPEC-GAP-001');
  assert.match(history.message, /the recorded decisions/u); assert.match(history.message, /spec author new --from <FILE>/u);
  assert.equal(history.details.findings[0].path.includes('gaps'), true);
});

test('a split’s free text is checked before it is signed or pushed', async t => {
  const repo = await fixture(t); repo.create(); await ready(repo, specId, twoRequirements(specId));
  const plan = path.join(repo.base, 'plan.json');
  await writeFile(plan, JSON.stringify({ children: [], stories: [{ key: 'S1', title: 'Part one', description: 'Deploy with ' + FAKE_TOKEN, workId: 'PART-1', clauses: [specId + ':REQ-001', specId + ':REQ-002', specId + ':AC-001', specId + ':AC-002'], dependsOn: [] }], notDelivered: [] }));
  const split = (...argv) => repo.cli(repo.root, 'spec', 'split', specId + '@1', ...argv);
  assert.equal(split('--propose', '--file', plan).status, 0);
  const before = stateFiles(repo);
  const refused = split('--publish');
  assert.notEqual(refused.status, 0);
  assert.equal(refused.value.error.code, 'SPEC_SPLIT_SECRET');
  assert.match(refused.value.error.message, /the split plan/u); assert.match(refused.value.error.message, /Change the plan/u);
  assert.ok(!JSON.stringify(refused.value).includes(FAKE_TOKEN));
  assert.equal(stateFiles(repo), before, 'nothing was pushed');
});

test('every specification publisher goes through the check', async () => {
  for (const file of ['shared-drafts', 'library', 'split']) {
    const source = await readFile(fileURLToPath(new URL(`../src/spec-library/${file}.mjs`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source.replace(/^.*\*.*publishToStateBranch.*$/gmu, ''), /publishToStateBranch\(/u, file);
    assert.match(source, /publishCheckedFiles\(/u, file);
  }
  // Usage records are identifiers and digests, written when a Story is approved or closed; a checked failure there would undo neither.
  const usage = await readFile(fileURLToPath(new URL('../src/spec-library/usage.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(usage, /title|description|reason/u, 'a usage record stays free of free text');
});

test('no answer to a model carries a secret-shaped value, on any route; the person’s own view stays whole', async t => {
  const repo = await fixture(t); repo.create();
  const file = path.join(repo.base, 'with-secret.md');
  const text = wording(specId) + `\nDeploy with ${FAKE_TOKEN} from https://files.acme.io/d?sig=${REAL} now.\n`;
  await writeFile(file, text); repo.sf('edit', specId, '--file', file, '--expected-seq', '1');
  await saveDraft(repo.root, specId, { operationId: 'old-link-2', operation: 'source', change: draft => ({ ...draft,
    sources: [{ id: 'SRC-0000000000000001', type: 'url', name: 'files.acme.io', url: `https://files.acme.io/old?token=${REAL}`, purpose: '', standing: 'not-read' }] }) });
  const safe = value => { const printed = JSON.stringify(value); assert.ok(!printed.includes(FAKE_TOKEN), printed.slice(0, 200)); assert.ok(!printed.includes(REAL), printed.slice(0, 200)); };
  const status = repo.sf('status', specId);
  safe(status); assert.match(status.spec, /Deploy with \[withheld: looks like a secret\] from/u); assert.ok(status.withheld >= 3);
  safe(repo.sf('status', specId, '--quick'));
  safe(repo.sf('sources', specId));
  safe(repo.sf('history', specId, '--sequence', '2'));
  safe(repo.sf('list', '--local'));
  // The native tool asks the same CLI, with no way to ask for more.
  const tool = await import('../apps/vscode/src/views/spec-studio-tool.ts');
  const runner = { run: argv => { const result = repo.cli(repo.root, ...argv.filter(item => item !== '--json')); assert.equal(result.status, 0); return result.value; } };
  for (const request of [{ action: 'state', spec: specId }, { action: 'prose', spec: specId }, { action: 'details', spec: specId, part: 'sources' }]) safe(await tool.answerSpecStudioTool(request, runner));
  // Asking for the person's view is refused to an agent in every turn, and gives the person everything.
  const { argvAllowed } = await import('../src/copilot-mutation-guard.mjs');
  assert.equal(argvAllowed(['spec', 'author', 'status', specId, '--for-person', '--json'], 'read', {}), false);
  assert.equal(argvAllowed(['spec', 'author', 'status', specId, '--json'], 'read', {}), true);
  const person = repo.sf('status', specId, '--for-person');
  assert.equal(person.spec, text); assert.equal(person.withheld, undefined);
  // What a person selected is judged before it would go to chat.
  const asked = path.join(repo.base, 'asked.txt'); await writeFile(asked, 'Improve this: ' + FAKE_TOKEN);
  const screened = repo.sf('screen', '--file', asked); assert.equal(screened.findings.length, 1); safe(screened);
  await writeFile(asked, 'Make this clearer.'); assert.equal(repo.sf('screen', '--file', asked).findings.length, 0);
});

test('.env is refused by name for sources and document upload alike, and says what to do', async t => {
  const repo = await fixture(t); repo.create();
  await mkdir(path.join(repo.root, 'config'), { recursive: true });
  for (const name of ['.env', 'config/.env.local', '.env.production', '.env.example', '.env.sample', '.env.template', 'config/notes.env']) await writeFile(path.join(repo.root, name), 'LOG_LEVEL=debug\n');
  for (const refused of ['.env', 'config/.env.local', '.env.production']) {
    const failure = repo.fail('source', specId, '--path', refused);
    assert.equal(failure.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED', refused); assert.match(failure.message, /name it as a template such as \.env\.example/u); assert.match(failure.message, /singularity-flow env files/u);
    assert.equal(repo.fail('source', specId, '--file', path.join(repo.root, refused)).code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED', refused);
  }
  for (const allowed of ['.env.example', '.env.sample', '.env.template', 'config/notes.env']) assert.equal(repo.cli(repo.root, 'spec', 'author', 'source', specId, '--path', allowed).status, 0, allowed);
  // The one helper document upload goes through.
  const documents = await import('../src/documents.mjs');
  await assert.rejects(documents.assertStartDocumentNotEnvironmentLocal(repo.root, null, path.join(repo.root, '.env')), { code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED' });
  await documents.assertStartDocumentNotEnvironmentLocal(repo.root, null, path.join(repo.root, '.env.example'));
  // A repository can add to the names and cannot remove from them.
  await mkdir(path.join(repo.root, 'singularity'), { recursive: true });
  await writeFile(path.join(repo.root, 'singularity', 'environments.yml'), 'schemaVersion: 1\nenvironments:\n  qa:\n    requires:\n      - name: API_TOKEN\n        kind: secret\n    localFiles:\n      - secrets.txt\nchecks: {}\nneverCommit: []\n');
  assert.equal(repo.fail('source', specId, '--path', '.env').code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED', 'declared rules do not switch the name off');
  await rm(path.join(repo.root, 'singularity', 'environments.yml'));
  // Unquoted values in an env-style file are secrets; a placeholder or an ordinary setting is not.
  const example = path.join(repo.root, '.env.example');
  await writeFile(example, 'API_KEY=abc123xyz987LMN\n');
  assert.equal(repo.fail('source', specId, '--file', example).code, 'SECRET_DETECTED');
  for (const line of ['PASSWORD=hunter2', 'CALLBACK=https://x.io/done?token=Zq7vK2mPx9LtR4wNf8Bc', 'SIGNING_SALT=Zq7vK2mPx9LtR4wNf8Bc1234', 'ENCRYPTION_KEY=Zq7vK2mPx9']) {
    await writeFile(example, line + '\n');
    assert.equal(repo.fail('source', specId, '--file', example).code, 'SECRET_DETECTED', line);
  }
  for (const line of ['API_KEY=your-key-here', 'API_KEY=', 'API_KEY=<KEY>', 'API_KEY=${API_KEY}', 'LOG_LEVEL=debug', '# API_KEY=abc123xyz987LMN', 'API_KEY=abc123xyz987LMN # sflow-allow-secret: a sample',
    // What an example file ordinarily holds: an address, a path, a name that only contains a credential's letters.
    'DB_URL=postgres://localhost/app', 'AUTH_URL=https://login.x.io/authorize', 'AUTHOR=someone', 'KEYBOARD=us', 'TOKEN_TTL=3600', 'KEY_PATH=/etc/ssl/app.pem', 'AUTH_MODE=oauth', 'AUTH_ENABLED=yes', 'BUCKET=my-company-prod-assets-us-east-1', 'CONFIG_DIR=/var/lib/application/config/current']) {
    await writeFile(example, line + '\n');
    assert.equal(repo.cli(repo.root, 'spec', 'author', 'source', specId, '--file', example).status, 0, line);
  }
});

test('a selected folder says which files not to read, a large file is checked, and what cannot be checked says so', async t => {
  const repo = await fixture(t); repo.create();
  const config = path.join(repo.root, 'config'); await mkdir(config, { recursive: true });
  await writeFile(path.join(config, 'plain.txt'), 'Plain.\n'); await writeFile(path.join(config, '.env.local'), 'A=1\n');
  await writeFile(path.join(config, 'leaky.txt'), 'token: ' + FAKE_TOKEN + '\n'); await writeFile(path.join(config, 'image.bin'), Buffer.from([0, 1, 2, 0]));
  const big = path.join(repo.root, 'big.txt'), bigLeak = path.join(repo.root, 'big-leak.txt'), huge = path.join(repo.root, 'huge.txt'), binary = path.join(repo.root, 'blob.dat');
  await writeFile(big, 'x '.repeat(200 * 1024)); await writeFile(bigLeak, 'x '.repeat(200 * 1024) + '\n' + FAKE_TOKEN + '\n');
  await writeFile(huge, Buffer.alloc(21 * 1024 * 1024, 'y')); await writeFile(binary, Buffer.from([0, 255, 0, 254]));
  const added = repo.sf('source', specId, '--path', 'config').sources.find(source => source.path === 'config');
  const folder = repo.sf('sources', specId, '--source', added.id).sources[0];
  assert.equal(folder.status, 'selected-folder');
  assert.deepEqual([...folder.excluded].sort(), ['config/.env.local', 'config/leaky.txt']);
  assert.match(folder.instruction, /Do not read the files under excluded/u);
  // Too large or not text is no reason to refuse the source: the read path supports both, and says it could not vouch for them.
  const read = name => repo.sf('sources', specId, '--source', repo.sf('source', specId, '--path', name).sources.find(source => source.path === name).id).sources[0];
  assert.equal(read('big.txt').status, 'native-read-required');
  const large = read('huge.txt'); assert.equal(large.status, 'native-read-required'); assert.match(large.unchecked, /too large/u);
  const notText = read('blob.dat'); assert.equal(notText.status, 'native-read-required'); assert.match(notText.unchecked, /not text/u);
  assert.equal(repo.fail('source', specId, '--path', 'big-leak.txt').code, 'SECRET_DETECTED');
  // A file past the inline limit changed after it was chosen: checked at read, with words about reading.
  await writeFile(big, 'x '.repeat(200 * 1024) + '\n' + FAKE_TOKEN + '\n');
  const id = (await readDraft(repo.root, specId)).head.draft.sources.find(source => source.path === 'big.txt').id;
  const changed = repo.sf('sources', specId, '--source', id).sources[0];
  assert.equal(changed.status, 'refused'); assert.equal(changed.path, undefined);
  assert.match(changed.message, /This source is not read out/u); assert.doesNotMatch(changed.message, /Document upload/u);
});

test('file and code sources take the refusals every document input takes, on add, restore and read', async t => {
  const repo = await fixture(t); repo.create();
  await mkdir(path.join(repo.root, 'singularity'), { recursive: true });
  await writeFile(path.join(repo.root, 'singularity', 'environments.yml'), 'schemaVersion: 1\nenvironments:\n  qa:\n    requires:\n      - name: API_TOKEN\n        kind: secret\n    localFiles:\n      - .env\n      - config/.env.local\nchecks: {}\nneverCommit:\n  - "**/*.pem"\n');
  await mkdir(path.join(repo.root, 'config'), { recursive: true });
  await writeFile(path.join(repo.root, '.env'), 'SAFE_NAME=value\n');
  await writeFile(path.join(repo.root, 'config', '.env.local'), 'SAFE_NAME=value\n');
  await writeFile(path.join(repo.root, 'config', 'plain.txt'), 'Plain text.\n');
  await writeFile(path.join(repo.root, 'config', 'leaky.txt'), 'token: ' + FAKE_TOKEN + '\n');
  const refused = (argv, code) => { const failure = repo.fail('source', specId, ...argv); assert.equal(failure.code, code, JSON.stringify(failure)); assert.ok(!JSON.stringify(failure).includes('SAFE_NAME=value')); };
  refused(['--file', path.join(repo.root, '.env')], 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
  refused(['--path', 'config/.env.local'], 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
  refused(['--file', path.join(repo.root, 'config', 'leaky.txt')], 'SECRET_DETECTED');
  refused(['--path', 'config/leaky.txt'], 'SECRET_DETECTED');
  const outside = path.join(repo.base, 'notes.pem'); await writeFile(outside, 'not a key\n');
  refused(['--file', outside], 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
  assert.equal(repo.sf('status', specId, '--quick').sequence, 1, 'a refused source saves nothing');
  // The same checks hold for a clean file and a clean area, which still work.
  assert.equal(repo.sf('source', specId, '--file', path.join(repo.root, 'config', 'plain.txt')).sources.length, 1);
  assert.equal(repo.sf('source', specId, '--path', 'config/plain.txt').sources.length, 2);
  // Restoring goes through them too, though the bytes match the recorded original.
  const { createHash } = await import('node:crypto');
  const leaky = await readFile(path.join(repo.root, 'config', 'leaky.txt'));
  const digest = createHash('sha256').update(leaky).digest('hex');
  await saveDraft(repo.root, specId, { operationId: 'old-sources', operation: 'source', change: draft => ({ ...draft, sources: [...draft.sources,
    { id: 'SRC-' + digest.slice(0, 16), type: 'file', name: 'leaky.txt', sourceName: 'leaky.txt', mediaType: 'text/plain', size: leaky.length, sha256: digest, storage: { kind: 'local', key: digest + '/leaky.txt' }, purpose: '', standing: 'not-read' },
    { id: 'SRC-0000000000000002', type: 'code', name: 'config/.env.local', path: 'config/.env.local', purpose: '', standing: 'not-read' },
    { id: 'SRC-0000000000000003', type: 'code', name: 'config/leaky.txt', path: 'config/leaky.txt', purpose: '', standing: 'not-read' }] }) });
  refused(['--restore', 'SRC-' + digest.slice(0, 16), '--file', path.join(repo.root, 'config', 'leaky.txt')], 'SECRET_DETECTED');
  // A source from before these refusals is refused where its text would reach a model; the draft stays usable.
  for (const id of ['SRC-0000000000000002', 'SRC-0000000000000003']) {
    const read = repo.sf('sources', specId, '--source', id).sources[0];
    assert.equal(read.status, 'refused'); assert.equal(read.text, undefined); assert.equal(read.path, undefined);
    assert.match(read.nextAction, /--remove/u);
  }
  assert.equal(repo.sf('sources', specId, '--source', 'SRC-' + createHash('sha256').update('Plain text.\n').digest('hex').slice(0, 16)).sources[0].text, 'Plain text.\n');
  // A phase's read through the document catalog takes them too.
  const { storeLocalDocument } = await import('../src/document-storage.mjs');
  await storeLocalDocument(repo.root, specId, { bytes: leaky, sha256: digest, filename: 'leaky.txt' });
  const { documentCatalog, viewDocument } = await import('../src/documents-read.mjs');
  const workflow = { workItem: { id: 'FROM-SECRET' }, phaseOrder: ['specification'], phases: { specification: { id: 'specification', status: 'in_progress', artifacts: [] } } };
  const config = { workItemRoot: 'singularity/work-items' }; const directory = path.join(repo.root, config.workItemRoot, workflow.workItem.id);
  await mkdir(directory, { recursive: true });
  const descriptor = (await readDraft(repo.root, specId)).head.draft.sources.find(source => source.sha256 === digest);
  await writeFile(path.join(directory, 'source.json'), JSON.stringify({ specification: [{ revision: specId + '@1', sources: [descriptor] }] }));
  const pinned = (await documentCatalog(repo.root, config, workflow)).find(item => item.specificationSource);
  await assert.rejects(viewDocument(repo.root, config, workflow, pinned.id), { code: 'SECRET_DETECTED' });
});

// ---- A shared library with one bad entry (finding 5) --------------------------------------------

/** Put a raw record on the state branch, as another build or a damaged push would. */
async function pushStateFile(repo, file, text) {
  const scratch = await mkdtemp(path.join(repo.base, 'state-'));
  repo.git(repo.base, 'clone', '-q', '--branch', 'state', repo.remote, scratch);
  await mkdir(path.dirname(path.join(scratch, file)), { recursive: true });
  await writeFile(path.join(scratch, file), text);
  repo.git(scratch, 'add', '.'); repo.git(scratch, '-c', 'user.name=Other', '-c', 'user.email=other@example.invalid', 'commit', '-qm', 'A record'); repo.git(scratch, 'push', '-q', 'origin', 'state');
}

test('one unreadable shared checkpoint or draft is reported as that entry; the rest of the library still lists', async t => {
  const repo = await fixture(t); repo.create(); repo.sf('sync', specId);
  const drafts = 'singularity/specification-drafts';
  await pushStateFile(repo, drafts + '/SPEC-NEWER-001/head.json', JSON.stringify({ schemaVersion: 99, specId: 'SPEC-NEWER-001', checkpointSha256: 'sha256:' + 'a'.repeat(64) }));
  await pushStateFile(repo, drafts + '/SPEC-TORN-001/head.json', '{ not json');
  await pushStateFile(repo, drafts + '/SPEC-GONE-001/head.json', JSON.stringify({ schemaVersion: 1, specId: 'SPEC-GONE-001', checkpointSha256: 'sha256:' + 'b'.repeat(64) }));
  // A local draft from a newer build, and an ordinary one beside it.
  repo.sf('new', 'SPEC-LOCAL-002', '--title', 'Still listed', '--local');
  const future = path.join(repo.root, '.git', 'singularity-flow', 'spec-drafts', 'SPEC-FUTURE-001'); await mkdir(future, { recursive: true });
  await writeFile(path.join(future, '000001.json'), JSON.stringify({ schemaVersion: 99, specId: 'SPEC-FUTURE-001', sequence: 1 }));
  const listed = repo.sf('list');
  assert.deepEqual(listed.shared.map(item => item.specId), [specId]);
  assert.ok(listed.drafts.some(draft => draft.specId === 'SPEC-LOCAL-002') && listed.drafts.some(draft => draft.specId === specId));
  const unreadable = Object.fromEntries(listed.unreadable.map(entry => [entry.specId, entry]));
  assert.equal(unreadable['SPEC-NEWER-001'].code, 'SCHEMA_VERSION_FUTURE');
  assert.equal(unreadable['SPEC-GONE-001'].code, 'SPEC_SHARED_DRAFT_INVALID');
  assert.ok(unreadable['SPEC-TORN-001']); assert.equal(unreadable['SPEC-FUTURE-001'].record, 'local draft');
  // Every other reader of the shared list.
  const shared = repo.sf('shared', '--refresh');
  assert.deepEqual(shared.drafts.map(item => item.specId), [specId]); assert.equal(shared.unreadable.length, 3);
  assert.equal(repo.sf('shared', specId).unreadable.length, 0, 'asking for a readable draft is not held up by others');
  const one = repo.sf('shared', 'SPEC-NEWER-001');
  assert.equal(one.drafts.length, 0); assert.equal(one.unreadable[0].specId, 'SPEC-NEWER-001');
  assert.equal(repo.sf('sync', specId).status, 'synced', 'sharing another draft still works');
});

test('a newer shared record for this draft stops only its sharing, keeps the writing and names the problem', async t => {
  const repo = await fixture(t); repo.create(); repo.sf('sync', specId);
  await pushStateFile(repo, 'singularity/specification-drafts/' + specId + '/head.json', JSON.stringify({ schemaVersion: 99, specId, checkpointSha256: 'sha256:' + 'a'.repeat(64) }));
  await editProse(repo, specId, wording(specId));
  const refused = repo.fail('sync', specId);
  assert.equal(refused.code, 'SCHEMA_VERSION_FUTURE');
  assert.match(refused.message, /saved on this laptop/u);
  assert.equal(repo.sf('status', specId, '--quick').spec, wording(specId));
});

// ---- Staleness that is not a conflict (findings 3, 4) -------------------------------------------

test('a wording save survives snapshots that changed nothing it replaces; a real wording change is still refused', async t => {
  const repo = await fixture(t); repo.create();
  const proposal = path.join(repo.base, 'proposal.json');
  await writeFile(proposal, JSON.stringify({ proposals: [{ kind: 'finding', article: 'completeness', message: 'Say who places the order.', clauses: [] }] }));
  const basis = repo.sf('status', specId, '--quick').sequence;
  // Other things move the head: Copilot's proposal through the CLI, a source, a person's fact.
  repo.sf('propose', specId, '--file', proposal);
  repo.sf('research', specId, '--fact', 'Orders are placed by customers.', '--source', 'Product owner');
  const file = path.join(repo.base, 'typed.md'); await writeFile(file, 'What the person typed meanwhile.');
  const saved = repo.sf('edit', specId, '--file', file, '--expected-seq', String(basis));
  assert.equal(saved.sequence, basis + 3);
  const status = repo.sf('status', specId, '--quick');
  assert.equal(status.spec, 'What the person typed meanwhile.');
  assert.equal(status.findings.length, 1, 'what moved the head is kept'); assert.equal(status.researchItems.length, 1);
  // The same save replayed, and earlier wording restored from behind the head, also hold.
  repo.sf('research', specId, '--fact', 'Another fact.', '--source', 'Product owner');
  assert.equal(repo.sf('restore-version', specId, '--sequence', '1', '--expected-seq', String(saved.sequence), '--operation-id', 'restore').sequence, saved.sequence + 2);
  // Wording, a title or a kind that really changed is a conflict.
  const head = repo.sf('status', specId, '--quick').sequence;
  await writeFile(file, 'Another window wrote this.'); repo.sf('edit', specId, '--file', file, '--expected-seq', String(head));
  await writeFile(file, 'This window wrote this.');
  assert.equal(repo.fail('edit', specId, '--file', file, '--expected-seq', String(head)).code, 'SPEC_DRAFT_STALE');
  const again = repo.sf('status', specId, '--quick').sequence;
  repo.sf('edit', specId, '--title', 'A new title', '--expected-seq', String(again));
  assert.equal(repo.fail('edit', specId, '--file', file, '--expected-seq', String(again)).code, 'SPEC_DRAFT_STALE');
  assert.equal(repo.fail('edit', specId, '--file', file, '--expected-seq', '999').code, 'SPEC_DRAFT_STALE');
});

// ---- Kind confirmation (finding 8) --------------------------------------------------------------

test('a draft without a kind is told how to confirm it, and an old script has a way through', async t => {
  const repo = await fixture(t);
  repo.sf('new', specId, '--title', 'An old script', '--local');
  const status = repo.sf('status', specId, '--quick');
  await editProse(repo, specId, wording(specId));
  repo.sf('settle', specId, '--all-articles', 'satisfied');
  const refused = repo.fail('publish', specId, '--reviewed');
  assert.equal(refused.code, 'SPEC_LIBRARY_REVIEW_INCOMPLETE');
  assert.doesNotMatch(refused.message, /: [DAH] /u, 'no internal part letter in the sentence');
  assert.doesNotMatch(refused.message, /\.\./u);
  assert.match(refused.message, /Choose Business needs or Technical details before making this version ready/u);
  const sequence = repo.sf('status', specId).sequence; assert.ok(sequence > status.sequence);
  assert.match(refused.message, new RegExp(`spec author edit ${specId} --kind <business\\|technical> --expected-seq ${sequence}`, 'u'));
  assert.match(refused.details.nextAction, /--kind <business\|technical>/u);
  assert.match(repo.sf('status', specId).next, /--kind <business\|technical>/u);
  // That command works as written, with no file: a kind is not a wording change.
  assert.equal(repo.sf('edit', specId, '--kind', 'business', '--expected-seq', String(sequence)).sequence, sequence + 1);
  assert.equal(repo.sf('status', specId, '--quick').spec, wording(specId), 'the prose is untouched');
  assert.equal(repo.sf('publish', specId, '--reviewed').revision, 1);
  assert.equal(repo.fail('edit', specId, '--expected-seq', String(sequence + 2)).code, 'SPEC_EDIT_INCOMPLETE');
  // A draft saved before kinds existed keeps its existing rules (SPEC-SPA section 12.1).
  const legacy = 'SPEC-LEGACY-001';
  await saveDraft(repo.root, legacy, { operationId: 'legacy', operation: 'new', create: true, change: () => { const { kind: _none, ...old } = newDraft({ title: 'Before kinds', spec: wording(legacy) }); return old; } });
  repo.sf('settle', legacy, '--all-articles', 'satisfied');
  assert.equal(repo.sf('publish', legacy, '--reviewed').revision, 1);
});

// ---- Reconciling a lost acknowledgement with newer writing (finding 10) --------------------------

test('a push whose acknowledgement was lost, with typing since, is reconciled as this laptop’s own and not a conflict', async t => {
  const repo = await fixture(t); repo.create();
  const crashed = run(repo.root, process.execPath, [bin, 'spec', 'author', 'sync', specId, '--json'], { ...repo.env, SINGULARITY_FLOW_TEST_CRASH_AT: 'spec-draft-synced' });
  if (process.platform === 'win32') assert.equal(crashed.status, 1); else assert.equal(crashed.signal, 'SIGKILL');
  const landed = repo.sf('shared', specId, '--refresh').drafts[0];
  await editProse(repo, specId, 'Kept typing after the crash.');
  const synced = repo.sf('sync', specId);
  assert.equal(synced.status, 'synced');
  assert.notEqual(synced.checkpointSha256, landed.checkpointSha256);
  const head = repo.sf('shared', specId, '--refresh').drafts[0];
  assert.equal(head.draft.spec, 'Kept typing after the crash.');
  // A different writer's checkpoint is still a conflict.
  const reader = path.join(repo.base, 'other-laptop'); repo.git(repo.base, 'clone', '-q', repo.remote, reader);
  assert.equal(repo.cli(reader, 'spec', 'author', 'resume', specId, '--checkpoint', head.checkpointSha256, '--expected-seq', '0').status, 0);
  const theirs = path.join(repo.base, 'theirs.md'); await writeFile(theirs, 'Their words.');
  const status = repo.cli(reader, 'spec', 'author', 'status', specId, '--quick').value;
  assert.equal(repo.cli(reader, 'spec', 'author', 'edit', specId, '--file', theirs, '--expected-seq', String(status.sequence)).status, 0);
  assert.equal(repo.cli(reader, 'spec', 'author', 'sync', specId).status, 0);
  await editProse(repo, specId, 'My later words.');
  assert.equal(repo.fail('sync', specId).code, 'SPEC_SHARED_DRAFT_CONFLICT');
});

test('the same wording on both sides is not a conflict, whichever laptop saved it', async t => {
  const repo = await fixture(t); repo.create(); await editProse(repo, specId, 'Agreed words.'); repo.sf('sync', specId);
  // Another laptop reached the same draft by itself, with no shared basis.
  const reader = path.join(repo.base, 'other-laptop'); repo.git(repo.base, 'clone', '-q', repo.remote, reader);
  assert.equal(repo.cli(reader, 'spec', 'author', 'new', specId, '--title', 'A small idea', '--kind', 'business', '--operation-id', 'same', '--local').status, 0);
  const words = path.join(repo.base, 'same.md'); await writeFile(words, 'Agreed words.');
  assert.equal(repo.cli(reader, 'spec', 'author', 'edit', specId, '--file', words, '--expected-seq', '1').status, 0);
  const synced = repo.cli(reader, 'spec', 'author', 'sync', specId);
  assert.equal(synced.status, 0, JSON.stringify(synced.value)); assert.equal(synced.value.unchanged, true);
});

// ---- Parent closure and split children (findings 11, 15) ----------------------------------------

const twoRequirements = id => wording(id).replace(`[${id}:REQ-001]`, `[${id}:REQ-001]\n\nWHEN a customer asks, the service SHALL show the order status. [${id}:REQ-002]`)
  .replace(`A submitted valid order returns one non-empty reference. [${id}:AC-001]`, `A submitted valid order returns one reference and a status, as ${id}:REQ-001 and ${id}:REQ-002 state. [${id}:AC-001]\n\nA status request shows the current state, as ${id}:REQ-002 states. [${id}:AC-002]`);

test('an inherited clause brings what it depends on, without asking the Story to deliver the parent', async t => {
  const repo = await fixture(t); repo.create(); await ready(repo, specId, twoRequirements(specId));
  const child = repo.sf('derive', specId + '@1', '--operation-id', 'closure');
  const coverage = '\n## Business coverage\n\n| Source requirement | Technical requirement or disposition | Reason |\n| --- | --- | --- |\n'
    + '| ' + specId + ':REQ-001 | ' + child.specId + ':REQ-001 | Implements the reference. |\n'
    + '| ' + specId + ':REQ-002 | deferred | Status comes later. |\n'
    + '| ' + specId + ':AC-001 | ' + child.specId + ':AC-001 | Verifies it. |\n'
    + '| ' + specId + ':AC-002 | deferred | Status comes later. |\n';
  await ready(repo, child.specId, wording(child.specId) + coverage);
  const [slice] = await resolveSlices(repo.root, {}, [child.specId + '@1=REQ-001'], { env: repo.env });
  const inherited = slice.inheritedSpecifications[0];
  assert.equal(inherited.standing, 'inherited-constraint');
  assert.deepEqual(inherited.clauses.map(clause => clause.anchor).sort(), [`[${specId}:AC-001]`, `[${specId}:AC-002]`, `[${specId}:REQ-001]`, `[${specId}:REQ-002]`], 'a requirement brought in brings the acceptance that proves it');
  assert.equal(inherited.partialDependency, undefined, 'nothing was left out, so no reason is owed');
  assert.deepEqual(slice.clauses.map(clause => clause.anchor), [`[${child.specId}:REQ-001]`], 'only the technical clause is delivered');
});

test('a split child keeps the parent’s pinned business links, so its Story keeps the inherited constraints', async t => {
  const repo = await fixture(t); repo.create(); await ready(repo, specId, twoRequirements(specId));
  const technical = repo.sf('derive', specId + '@1', '--operation-id', 'to-split');
  const coverage = '\n## Business coverage\n\n| Source requirement | Technical requirement or disposition | Reason |\n| --- | --- | --- |\n'
    + '| ' + specId + ':REQ-001 | ' + technical.specId + ':REQ-001 | Implements the reference. |\n'
    + '| ' + specId + ':REQ-002 | ' + technical.specId + ':REQ-002 | Implements the status. |\n'
    + '| ' + specId + ':AC-001 | ' + technical.specId + ':AC-001 | Verifies them. |\n'
    + '| ' + specId + ':AC-002 | ' + technical.specId + ':AC-002 | Verifies the status. |\n';
  const id = technical.specId;
  await ready(repo, id, wording(id).replace(`[${id}:REQ-001]`, `[${id}:REQ-001]\n\nWHEN a customer asks, the service SHALL show the order status. [${id}:REQ-002]`)
    .replace(`[${id}:AC-001]`, `[${id}:AC-001]\n\nAsking for an order shows its status. [${id}:AC-002]`) + coverage);
  const plan = path.join(repo.base, 'plan.json');
  const childId = 'SPEC-CHILD-001';
  await writeFile(plan, JSON.stringify({ children: [{ specId: childId, title: 'Order reference', clauses: [id + ':REQ-001', id + ':AC-001'] }],
    stories: [], notDelivered: [{ clause: id + ':REQ-002', reason: 'A later part.' }, { clause: id + ':AC-002', reason: 'A later part.' }] }));
  const split = (...argv) => { const result = repo.cli(repo.root, 'spec', 'split', technical.specId + '@1', ...argv); assert.equal(result.status, 0, JSON.stringify(result.value)); return result.value; };
  split('--propose', '--file', plan); split('--publish');
  const status = repo.sf('status', childId, '--quick');
  assert.deepEqual(status.origins.map(origin => origin.revision), [specId + '@1']);
  assert.equal(status.origins[0].manifestSha256, repo.sf('show', specId + '@1').manifestSha256);
  assert.deepEqual(status.origins[0].clauses.map(clause => clause.id).sort(), [specId + ':AC-001', specId + ':REQ-001'], 'only what this child carries');
  assert.match(status.spec, new RegExp(`\\| ${specId}:REQ-001 \\| ${childId}:REQ-001 \\| Implements the reference\\. \\|`, 'u'));
  const filled = status.spec.replaceAll('TODO: what is true for the people this serves once it is delivered.', 'Orders get a reference.')
    .replaceAll('- TODO: who uses or is affected by this behaviour.', '- Customer places an order.').replaceAll('1. TODO: one concrete scenario, start to finish.', '1. A customer gets a reference.')
    .replaceAll('In scope: TODO. Out of scope: TODO.', 'In scope: the reference. Out of scope: status.')
    .replaceAll('TODO: state each decided or deferred gap of this specification here by its ID and its outcome.', 'No open decisions.');
  await editProse(repo, childId, filled); repo.sf('settle', childId, '--all-articles', 'satisfied');
  assert.deepEqual(repo.sf('check', childId).report.blocking, [], 'its coverage already accounts for what it carries');
  repo.sf('publish', childId, '--reviewed');
  const [slice] = await resolveSlices(repo.root, {}, [childId + '@1'], { env: repo.env });
  assert.equal(slice.inheritedSpecifications[0].revision, specId + '@1');
  assert.equal(slice.inheritedSpecifications[0].standing, 'inherited-constraint');
});

// ---- Retention and reads (finding 19) -----------------------------------------------------------

test('old autosaves are thinned behind a bound; what recovery needs is kept and previewed', async t => {
  const repo = await fixture(t); repo.create();
  const directory = path.join(repo.root, '.git', 'singularity-flow', 'spec-drafts', specId);
  const previous = process.env.SINGULARITY_FLOW_SPEC_HISTORY_RECENT;
  process.env.SINGULARITY_FLOW_SPEC_HISTORY_RECENT = '20';
  t.after(() => { if (previous === undefined) delete process.env.SINGULARITY_FLOW_SPEC_HISTORY_RECENT; else process.env.SINGULARITY_FLOW_SPEC_HISTORY_RECENT = previous; });
  const save = (operation, change) => saveDraft(repo.root, specId, { operationId: 'save-' + Math.random().toString(16).slice(2), operation, change });
  const { recordSharedBasis } = await import('../src/spec-library/shared-basis.mjs');
  const { retentionPlan } = await import('../src/spec-library/draft-store.mjs');
  // 2: a decision among the autosaves; 3: the sequence the shared basis names.
  await save('decide', draft => ({ ...draft, title: 'Decided' }));
  await save('edit', draft => ({ ...draft, spec: 'Shared words.' }));
  await recordSharedBasis(repo.root, specId, { checkpointSha256: 'sha256:' + 'c'.repeat(64), contentSha256: 'sha256:' + 'd'.repeat(64), localSequence: 3 });
  for (let index = 0; index < 100; index += 1) await save('edit', draft => ({ ...draft, spec: 'Autosave ' + index }));
  const kept = (await readdir(directory)).filter(name => /^\d{6}\.json$/u.test(name)).map(name => Number(name.slice(0, 6)));
  assert.ok(kept.length < 103, 'old autosaves are gone: ' + kept.length);
  assert.ok(kept.includes(1) && kept.includes(2) && kept.includes(3), 'the first version, the decision and the shared basis stay');
  assert.ok(kept.includes(103));
  const read = await readDraft(repo.root, specId);
  assert.equal(read.head.draft.spec, 'Autosave 99');
  assert.equal(read.damaged.length, 0);
  assert.equal(repo.sf('status', specId, '--quick').sequence, 103);
  const preview = repo.cli(repo.root, 'spec', 'author', 'history', specId, '--retention').value.retention;
  assert.ok(preview.retain.some(entry => entry.reason === 'current version' && entry.sequence === 103));
  assert.ok(preview.retain.some(entry => entry.reason === 'shared basis' && entry.sequence === 3));
  assert.ok(Array.isArray(preview.remove));
  // The rule itself: an hour keeps its last save, and nothing but a plain save is ever removed.
  const hour = (sequence, at, operation = 'edit') => ({ sequence, operation, savedAt: `2026-11-01T${at}:00.000Z` });
  const plan = retentionPlan([hour(1, '09:00', 'new'), hour(2, '09:10'), hour(3, '09:50'), hour(4, '10:05'), hour(5, '10:06', 'accept'), hour(6, '10:07'), hour(7, '10:08')], { recent: 1 });
  assert.deepEqual(plan.remove.map(entry => entry.sequence), [2, 4, 6]);
  assert.deepEqual(plan.retain.map(entry => [entry.sequence, entry.reason]), [[1, 'new'], [3, 'last save of its hour'], [5, 'accept'], [7, 'current version']]);
});

test('thinning keeps the version a lost push came from, leaves a usable index, and the preview says only what will happen', async t => {
  const repo = await fixture(t); repo.create();
  const previous = process.env.SINGULARITY_FLOW_SPEC_HISTORY_RECENT; process.env.SINGULARITY_FLOW_SPEC_HISTORY_RECENT = '20';
  t.after(() => { if (previous === undefined) delete process.env.SINGULARITY_FLOW_SPEC_HISTORY_RECENT; else process.env.SINGULARITY_FLOW_SPEC_HISTORY_RECENT = previous; });
  const save = (operation, change) => saveDraft(repo.root, specId, { operationId: 'save-' + Math.random().toString(16).slice(2), operation, change });
  const { draftRetentionPreview } = await import('../src/spec-library/draft-store.mjs');
  const { recordSharedBasis } = await import('../src/spec-library/shared-basis.mjs');
  await save('edit', draft => ({ ...draft, spec: 'The words a lost push carried.' }));
  // Below the bound the preview promises nothing, though the rule alone would pick some.
  for (let index = 0; index < 30; index += 1) await save('edit', draft => ({ ...draft, spec: 'Early ' + index }));
  assert.deepEqual((await draftRetentionPreview(repo.root, specId, await readDraft(repo.root, specId))).remove, [], 'nothing goes until the bound is passed');
  await recordSharedBasis(repo.root, specId, { pendingPush: { checkpointSha256: 'sha256:' + 'e'.repeat(64), localSequence: 2 } });
  for (let index = 0; index < 70; index += 1) await save('edit', draft => ({ ...draft, spec: 'Later ' + index }));
  const quick = await readDraft(repo.root, specId, { headOnly: true });
  assert.equal(quick.historyChecked, false, 'the index written after thinning is the one the next read uses');
  const full = await readDraft(repo.root, specId);
  assert.ok(full.snapshots.length < 102, 'thinned: ' + full.snapshots.length);
  assert.ok(full.snapshots.some(snapshot => snapshot.sequence === 2), 'the version a lost push may have shared stays');
  assert.ok((await draftRetentionPreview(repo.root, specId, full)).retain.some(entry => entry.sequence === 2 && entry.reason === 'shared basis'));
});

test('adopting a lost push acknowledges what it carried; a failed newer push does not look shared', async t => {
  const repo = await fixture(t); repo.create(); const remote = repo.git(repo.root, 'remote', 'get-url', 'origin');
  const crashed = run(repo.root, process.execPath, [bin, 'spec', 'author', 'sync', specId, '--json'], { ...repo.env, SINGULARITY_FLOW_TEST_CRASH_AT: 'spec-draft-synced' });
  if (process.platform === 'win32') assert.equal(crashed.status, 1); else assert.equal(crashed.signal, 'SIGKILL');
  await editProse(repo, specId, 'Newer writing.');
  const sequence = repo.sf('status', specId, '--quick').sequence;
  // The remote answers the read and then refuses the push, so the first part of sync reconciles and the second fails.
  const hook = path.join(repo.remote, 'hooks', 'pre-receive'); await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.notEqual(repo.cli(repo.root, 'spec', 'author', 'sync', specId).status, 0);
  const status = repo.sf('status', specId, '--quick');
  assert.equal(status.sharedDraft.localSequence, 1, 'only what the landed push carried is acknowledged');
  assert.notEqual(status.sharedDraft.localSequence, sequence);
  await rm(hook);
  assert.equal(repo.sf('sync', specId).status, 'synced', remote);
  assert.equal(repo.sf('status', specId, '--quick').sharedDraft.localSequence, sequence);
  assert.equal(repo.sf('shared', specId, '--refresh').drafts[0].draft.spec, 'Newer writing.');
});

test('checking and publishing read the current version, not every earlier one', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { chmod } = await import('node:fs/promises');
  const repo = await fixture(t); repo.create();
  await editProse(repo, specId, wording(specId)); repo.sf('settle', specId, '--all-articles', 'satisfied');
  const old = path.join(repo.root, '.git', 'singularity-flow', 'spec-drafts', specId, '000001.json');
  await chmod(old, 0o000);
  assert.equal(repo.sf('check', specId).report.reviewReady, true);
  assert.equal(repo.sf('publish', specId, '--reviewed').revision, 1);
});

// ---- Backup, derive, reader, size (findings 20, 21, 22, 23) -------------------------------------

test('backup restore brings back an original only a published revision still uses', async t => {
  const repo = await fixture(t); repo.create();
  const file = path.join(repo.base, 'pinned.txt'); await writeFile(file, 'Only the revision uses this now.');
  const source = repo.sf('source', specId, '--file', file).sources[0];
  await ready(repo, specId, wording(specId));
  repo.sf('source', specId, '--remove', source.id);
  const backup = path.join(repo.base, 'backup');
  assert.equal(repo.cli(repo.root, 'backup', 'create', '--out', backup).status, 0);
  await rm(path.join(repo.root, '.git', 'singularity-flow-documents'), { recursive: true });
  assert.equal(repo.sf('sources', specId + '@1', '--source', source.id).sources[0].status, 'upload-required');
  const restored = repo.cli(repo.root, 'backup', 'restore', backup);
  assert.equal(restored.status, 0, JSON.stringify(restored.value));
  assert.equal(restored.value.counts.documents.restored, 1, JSON.stringify(restored.value.documents));
  assert.equal(repo.sf('sources', specId + '@1', '--source', source.id).sources[0].text, 'Only the revision uses this now.');
});

test('retrying a derivation after the state branch moved returns the same draft', async t => {
  const repo = await fixture(t); repo.create(); await ready(repo, specId, wording(specId));
  const first = repo.sf('derive', specId + '@1', '--operation-id', 'derive-retry');
  repo.sf('sync', specId);
  const again = repo.sf('derive', specId + '@1', '--operation-id', 'derive-retry');
  assert.equal(again.specId, first.specId); assert.equal(again.replayed, true);
  assert.equal(repo.sf('status', first.specId, '--quick').sequence, 1);
});

test('a source page fits what a host shows inline and states its continuation before the text', async t => {
  const repo = await fixture(t); repo.create(); const file = path.join(repo.base, 'long.txt');
  await writeFile(file, Array.from({ length: 4000 }, (_, index) => `Line ${index} says "something" with\ttabs.`).join('\n'));
  const source = repo.sf('source', specId, '--file', file).sources[0];
  const printed = run(repo.root, process.execPath, [bin, '--no-model', 'spec', 'author', 'sources', specId, '--source', source.id, '--json'], { ...repo.env, SINGULARITY_FLOW_AGENT_OUTPUT: 'full' }).stdout;
  assert.ok(printed.length < 8192, 'host limit: ' + printed.length);
  assert.ok(printed.indexOf('"next"') > 0 && printed.indexOf('"next"') < 500, 'the continuation is in the first thing a host shows');
  assert.ok(printed.indexOf('"next"') < printed.indexOf('"text"'));
  let result = '', from = 1, column = 0;
  for (let pages = 0; pages < 40; pages += 1) {
    const page = repo.sf('sources', specId, '--source', source.id, '--from', String(from), '--column', String(column)).sources[0];
    result += (pages ? '\n' : '') + page.text;
    if (page.next == null) break;
    from = page.next; column = page.nextColumn ?? 0;
  }
  assert.equal(result, await readFile(file, 'utf8'));
  const larger = repo.sf('sources', specId, '--source', source.id, '--max-bytes', '48000').sources[0];
  assert.ok(larger.text.length > 30000, 'a surface with room asks for more');
  assert.equal(repo.fail('sources', specId, '--source', source.id, '--max-bytes', '10').code, 'SPEC_SOURCE_RANGE_INVALID');
});

test('a file over the draft limit gets the draft limit’s answer, on edit, fork and new', async t => {
  const repo = await fixture(t); repo.create(); const file = path.join(repo.base, 'huge.md'); await writeFile(file, 'x'.repeat(256 * 1024 + 1));
  const edit = repo.fail('edit', specId, '--file', file, '--expected-seq', '1');
  assert.equal(edit.code, 'SPEC_DRAFT_TOO_LARGE'); assert.match(edit.message, /Keep your text/u);
  const fork = repo.fail('fork', specId, '--file', file);
  assert.equal(fork.code, 'SPEC_DRAFT_TOO_LARGE'); assert.match(fork.message, /Copy a smaller section/u);
  assert.equal(repo.fail('new', 'SPEC-HUGE-001', '--title', 'Huge', '--from', file, '--local').code, 'SPEC_DRAFT_TOO_LARGE');
  await writeFile(file, 'x'.repeat(256 * 1024));
  assert.equal(repo.sf('edit', specId, '--file', file, '--expected-seq', '1').sequence, 2, 'exactly at the limit still saves');
  assert.equal(repo.fail('edit', specId, '--file', repo.base, '--expected-seq', '2').code, 'SPEC_SOURCE_FILE_INVALID');
});

test('every Story start route reads --spec, so a tracker Story keeps its selected specification', async t => {
  const repo = await fixture(t);
  for (const argv of [['story', 'start', 'ENG-142'], ['start', 'PAY-42', '--github', 'acme/payments#42'], ['start', 'LOCAL-1', '--title', 'T', '--description', 'D']]) {
    const refused = repo.cli(repo.root, ...argv, '--spec', 'SPEC-A@1=REQ-001=REQ-002');
    assert.equal(refused.value.error.code, 'SPEC_SLICE_REQUEST_INVALID', argv.join(' ') + ': ' + JSON.stringify(refused.value.error));
  }
});
