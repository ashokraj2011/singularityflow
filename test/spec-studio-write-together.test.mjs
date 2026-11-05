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
    from = page.next; column = page.nextColumn ?? 0; assert.ok(++count < 10);
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
