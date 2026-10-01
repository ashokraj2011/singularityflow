import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { loadDefinition } from '../src/config.mjs';
import { assertDocumentStoragePolicy, resolveDocumentStorage } from '../src/document-storage.mjs';
import { renderActiveStoryEvidence } from '../src/evidence-context.mjs';
import { loadStoryAggregate } from '../src/state-stores.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Storage Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(root, args, options = {}) { return run(process.execPath, [bin, ...args], root, options); }

async function repository(configure = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-document-storage-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Storage Tester'], root); run('git', ['config', 'user.email', 'storage@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Storage\n'); flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off'; config.documents.allowedPhases = ['intake'];
  // These fixtures exercise document storage, not the pre-Story test-readiness gate.
  config.repositoryReadiness.requiredBeforeStory = false;
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities ?? {})) authority.allowAnyGitIdentity = true;
  configure(config);
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'README.md', 'singularity', '.github/agents'], root); run('git', ['commit', '-m', 'initialize'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  return { root, remote };
}

const refusedWith = (code) => (error) => error?.code === code;

test('document storage is git by default, local on request, and refuses what is not built yet', () => {
  assert.equal(resolveDocumentStorage(null), 'git');
  assert.equal(resolveDocumentStorage('LOCAL'), 'local');
  assert.equal(resolveDocumentStorage(null, { storage: { default: 'local' } }), 'local');
  assert.throws(() => resolveDocumentStorage('onedrive'), (error) => error.code === 'DOCUMENT_STORAGE_UNSUPPORTED' && /not available yet/.test(error.message));
  assert.throws(() => resolveDocumentStorage('jira'), refusedWith('DOCUMENT_STORAGE_UNSUPPORTED'));
  assert.throws(() => resolveDocumentStorage('dropbox'), refusedWith('DOCUMENT_STORAGE_INVALID'));
  assert.throws(() => resolveDocumentStorage('local', { storage: { allowed: ['git'] } }), refusedWith('DOCUMENT_STORAGE_NOT_ALLOWED'));
  assertDocumentStoragePolicy({ allowed: ['git', 'local'], default: 'local' });
  assert.throws(() => assertDocumentStoragePolicy({ allowed: ['git'], default: 'local' }), refusedWith('DOCUMENT_STORAGE_POLICY_INVALID'));
  assert.throws(() => assertDocumentStoragePolicy({ allowed: ['s3'] }), refusedWith('DOCUMENT_STORAGE_POLICY_INVALID'));
  assert.throws(() => assertDocumentStoragePolicy('local'), refusedWith('DOCUMENT_STORAGE_POLICY_INVALID'));
});

test('a document kept on this machine commits its identity only, and another clone sees it as unavailable', async () => {
  const { root, remote } = await repository();
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-document-'));
  const notes = path.join(uploads, 'salary bands.md');
  const secretLine = 'Band C starts at 91 000.';
  await writeFile(notes, `# Salary bands\n${secretLine}\n`);
  flow(root, ['start', 'LOCAL-1', '--from-branch', 'main', '--title', 'Keep a document on one machine']);
  flow(root, ['documents', 'upload', notes, '--name', 'Salary bands', '--store', 'local']);

  const [record] = JSON.parse(flow(root, ['documents', 'list', '--json']).stdout).filter((item) => item.id.startsWith('DOC-'));
  assert.equal(record.name, 'Salary bands');
  assert.equal(record.storage.kind, 'local');
  assert.match(record.storage.key, /^[a-f0-9]{64}\/salary-bands\.md$/);
  assert.equal(record.path, undefined, 'a machine-local document names no repository path');
  assert.equal(record.availability, 'available');
  assert.match(flow(root, ['documents', 'list']).stdout, /LOCATION: kept on this machine only/);
  assert.match(flow(root, ['documents', 'view', 'Salary bands']).stdout, /Band C starts at 91 000/);

  // The bytes are in this clone's Git directory, beside (not inside) the runtime directory a
  // factory reset removes, owner-only, and in no commit or remote.
  const stored = path.join(root, '.git', 'singularity-flow-documents', 'LOCAL-1', ...record.storage.key.split('/'));
  assert.equal(await readFile(stored, 'utf8'), `# Salary bands\n${secretLine}\n`);
  assert.equal((await stat(stored)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(stored))).mode & 0o777, 0o700);
  assert.equal(run('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'singularity/work-items/LOCAL-1/inputs'], root).stdout.trim(), '');
  const blob = run('git', ['hash-object', notes], root).stdout.trim();
  assert.notEqual(run('git', ['cat-file', '-e', blob], remote, { allowFailure: true }).status, 0, 'the remote never receives the bytes');
  assert.doesNotMatch(run('git', ['log', '-p', '--all'], root).stdout, /Band C starts/, 'no commit carries the text');
  assert.match(flow(root, ['gate']).stdout, /document integrity: 1 supporting input/);

  // Prompts carry the identity and how to read it on this machine, never the bytes or a path.
  const definition = await loadDefinition(root);
  const workflow = await loadStoryAggregate(root, definition, 'LOCAL-1');
  const rendered = await renderActiveStoryEvidence(root, definition, workflow);
  assert.match(rendered.markdown, /## DOC-001 — Salary bands[\s\S]*Kept on one machine only[\s\S]*singularity-flow documents view DOC-001/);
  assert.doesNotMatch(rendered.markdown, /Band C starts|local-documents/);
  assert.deepEqual(rendered.files, []);
  assert.equal(rendered.entries[0].injectedBytes, 0);
  assert.equal(rendered.entries[0].path, null);

  // A second clone has the catalog but not the bytes.
  const second = await mkdtemp(path.join(os.tmpdir(), 'sflow-second-clone-'));
  run('git', ['clone', '--quiet', remote, second], os.tmpdir());
  run('git', ['config', 'user.name', 'Storage Tester'], second); run('git', ['config', 'user.email', 'storage@example.com'], second);
  run('git', ['checkout', '--quiet', 'LOCAL-1'], second);
  const elsewhere = JSON.parse(flow(second, ['documents', 'list', 'LOCAL-1', '--json']).stdout).find((item) => item.id === 'DOC-001');
  assert.equal(elsewhere.availability, 'unavailable');
  assert.match(flow(second, ['documents', 'list', 'LOCAL-1']).stdout, /kept on another machine \(not available here\)/);
  // Prompts are committed and reused, so the text for it is the same here as where it is held.
  const secondDefinition = await loadDefinition(second);
  const renderedElsewhere = await renderActiveStoryEvidence(second, secondDefinition,
    await loadStoryAggregate(second, secondDefinition, 'LOCAL-1'));
  assert.equal(renderedElsewhere.markdown, rendered.markdown);
  assert.deepEqual(renderedElsewhere.entries, rendered.entries);
  const refused = flow(second, ['documents', 'view', 'DOC-001', '--work-id', 'LOCAL-1'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /kept only on the machine where Storage Tester added it/);
  assert.match(refused.stderr, /--store git/);
  const gate = flow(second, ['gate', 'LOCAL-1'], { allowFailure: true });
  assert.match(`${gate.stdout}${gate.stderr}`, /DOC-001 is kept on another machine; its integrity cannot be checked here/);
  assert.doesNotMatch(`${gate.stdout}${gate.stderr}`, /document integrity failed/);

  // A changed copy on the machine that has it is refused, not used.
  await writeFile(stored, '# Salary bands\nBand C starts at 1.\n');
  const changed = flow(root, ['documents', 'view', 'DOC-001'], { allowFailure: true });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /no longer matches its committed SHA-256/);
  const changedGate = flow(root, ['gate'], { allowFailure: true });
  assert.match(`${changedGate.stdout}${changedGate.stderr}`, /document integrity failed: DOC-001 \(kept on this machine/);
});

test('a document kept on this machine is committed to Git under the same ID by the machine that holds it', async () => {
  const { root, remote } = await repository();
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-store-in-git-'));
  const notes = path.join(uploads, 'rates.md'); await writeFile(notes, '# Rates\nStandard rate is 4.5%.\n');
  flow(root, ['start', 'LOCAL-GIT-1', '--from-branch', 'main', '--title', 'Commit a local document']);
  flow(root, ['documents', 'upload', notes, '--name', 'Rates', '--store', 'local']);
  const [before] = JSON.parse(flow(root, ['documents', 'list', '--json']).stdout).filter((item) => item.id.startsWith('DOC-'));

  // Another clone does not hold the bytes, so it cannot commit them; the refusal says who can.
  const second = await mkdtemp(path.join(os.tmpdir(), 'sflow-store-second-'));
  run('git', ['clone', '--quiet', remote, second], os.tmpdir());
  run('git', ['config', 'user.name', 'Storage Tester'], second); run('git', ['config', 'user.email', 'storage@example.com'], second);
  run('git', ['checkout', '--quiet', 'LOCAL-GIT-1'], second);
  const elsewhere = flow(second, ['documents', 'store', 'DOC-001', '--store', 'git'], { allowFailure: true });
  assert.notEqual(elsewhere.status, 0);
  assert.match(elsewhere.stderr, /documents store DOC-001 --store git/);
  assert.match(flow(second, ['documents', 'view', 'DOC-001', '--work-id', 'LOCAL-GIT-1'], { allowFailure: true }).stderr,
    /ask them to commit it there with singularity-flow documents store DOC-001 --store git/);

  const refusedLocal = flow(root, ['documents', 'store', 'Rates', '--store', 'local'], { allowFailure: true });
  assert.match(refusedLocal.stderr, /cannot be moved to this machine/);
  const stored = JSON.parse(flow(root, ['documents', 'store', 'Rates', '--store', 'git', '--json']).stdout);
  assert.equal(stored.document.id, 'DOC-001');
  assert.equal(stored.document.sha256, before.sha256);
  assert.deepEqual(stored.document.storage, { kind: 'git' });
  assert.equal(stored.document.path, 'singularity/work-items/LOCAL-GIT-1/inputs/DOC-001/rates.md');
  assert.match(run('git', ['show', `HEAD:${stored.document.path}`], root).stdout, /Standard rate is 4\.5%/);
  assert.match(run('git', ['log', '-1', '--format=%s'], root).stdout, /\[LOCAL-GIT-1\]\[documents\]\[store\]/);
  assert.match(flow(root, ['gate']).stdout, /document integrity: 1 supporting input/);
  const again = flow(root, ['documents', 'store', 'DOC-001', '--store', 'git'], { allowFailure: true });
  assert.match(again.stderr, /already committed to Git/);

  run('git', ['pull', '--quiet', 'origin', 'LOCAL-GIT-1'], second);
  assert.match(flow(second, ['documents', 'view', 'DOC-001', '--work-id', 'LOCAL-GIT-1']).stdout, /Standard rate is 4\.5%/);
});

test('a document an earlier build kept inside the runtime directory moves out the first time it is read', async () => {
  const { root } = await repository();
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-legacy-local-document-'));
  const notes = path.join(uploads, 'notes.md'); await writeFile(notes, '# Notes\nOnly here.\n');
  flow(root, ['start', 'LOCAL-LEGACY-1', '--from-branch', 'main', '--title', 'Legacy local store']);
  flow(root, ['documents', 'upload', notes, '--name', 'Notes', '--store', 'local']);
  const store = path.join(root, '.git', 'singularity-flow-documents');
  const legacy = path.join(root, '.git', 'singularity-flow', 'local-documents');
  await mkdir(path.dirname(legacy), { recursive: true });
  await rename(store, legacy);
  assert.match(flow(root, ['documents', 'view', 'Notes']).stdout, /Only here\./);
  const [record] = JSON.parse(flow(root, ['documents', 'list', '--json']).stdout).filter((item) => item.id.startsWith('DOC-'));
  assert.equal(record.availability, 'available');
  assert.equal(await readFile(path.join(store, 'LOCAL-LEGACY-1', ...record.storage.key.split('/')), 'utf8'), '# Notes\nOnly here.\n');
  await assert.rejects(() => stat(legacy), (error) => error.code === 'ENOENT', 'the emptied legacy store is removed');
});

test('folders, links and a Git-only policy refuse machine-local storage; a local default applies', async () => {
  const { root } = await repository((config) => { config.documents.storage = { allowed: ['git'] }; });
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-refusals-'));
  const notes = path.join(uploads, 'notes.md'); await writeFile(notes, '# Notes\n');
  const folder = path.join(uploads, 'export'); await mkdir(folder); await writeFile(path.join(folder, 'screen.md'), '# Screen\n');
  flow(root, ['start', 'LOCAL-2', '--from-branch', 'main', '--title', 'Refuse local storage']);
  const policy = flow(root, ['documents', 'upload', notes, '--name', 'Notes', '--store', 'local'], { allowFailure: true });
  assert.notEqual(policy.status, 0);
  assert.match(policy.stderr, /does not allow 'local' storage/);
  const planned = flow(root, ['documents', 'upload', notes, '--name', 'Notes', '--store', 'onedrive'], { allowFailure: true });
  assert.match(planned.stderr, /Keeping Story documents in onedrive is not available yet/);

  const open = await repository((config) => { config.documents.storage = { allowed: ['git', 'local'], default: 'local' }; });
  flow(open.root, ['start', 'LOCAL-3', '--from-branch', 'main', '--title', 'Local by default']);
  const folderRefusal = flow(open.root, ['documents', 'upload', folder, '--name', 'Export'], { allowFailure: true });
  assert.notEqual(folderRefusal.status, 0);
  assert.match(folderRefusal.stderr, /Folders are committed to Git/);
  const linkRefusal = flow(open.root, ['documents', 'upload', '--url', 'https://example.com/brief', '--name', 'Brief', '--store', 'local'], { allowFailure: true });
  assert.match(linkRefusal.stderr, /A link has no bytes to keep on this machine/);
  flow(open.root, ['documents', 'upload', folder, '--name', 'Export', '--store', 'git']);
  flow(open.root, ['documents', 'upload', notes, '--name', 'Notes']);
  const records = JSON.parse(flow(open.root, ['documents', 'list', '--json']).stdout).filter((item) => item.id.startsWith('DOC-'));
  assert.deepEqual(records.map((item) => [item.name, item.storage.kind]), [['Export/screen.md', 'git'], ['Notes', 'local']],
    'the policy default applies when --store is not given');
});

test('Story start keeps its documents on this machine with --document-store local', async () => {
  const { root } = await repository();
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-start-'));
  const brief = path.join(uploads, 'brief.md'); await writeFile(brief, '# Brief\nConfidential pricing.\n');
  const folder = path.join(uploads, 'folder'); await mkdir(folder);
  const refused = flow(root, ['start', 'LOCAL-4', '--from-branch', 'main', '--title', 'Local start',
    '--document', folder, '--document-name', 'Folder', '--document-store', 'local'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /is a folder\. Folders are committed to Git/);
  assert.equal(run('git', ['branch', '--list', 'LOCAL-4'], root).stdout.trim(), '', 'refused before the Story exists');
  flow(root, ['start', 'LOCAL-4', '--from-branch', 'main', '--title', 'Local start',
    '--document', brief, '--document-name', 'Pricing brief', '--document-store', 'local']);
  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/work-items/LOCAL-4/documents.json'), 'utf8'));
  assert.equal(manifest.documents[0].storage.kind, 'local');
  assert.equal(manifest.documents[0].origin, 'story-start');
  assert.doesNotMatch(run('git', ['log', '-p', '--all'], root).stdout, /Confidential pricing/);
  assert.match(flow(root, ['documents', 'view', 'Pricing brief']).stdout, /Confidential pricing/);
});

test('a story file\'s documents follow a single --document-store and --document-phases unless they set their own', async () => {
  const { root } = await repository();
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-file-documents-'));
  await writeFile(path.join(uploads, 'brief.md'), '# Brief\nPrivate pricing.\n');
  await writeFile(path.join(uploads, 'glossary.md'), '# Glossary\nShared terms.\n');
  const storyFile = path.join(uploads, 'story.yml');
  await writeFile(storyFile, YAML.stringify({
    title: 'Story file documents',
    description: 'Documents listed in a story file follow the start options.',
    acceptanceCriteria: ['Each document is kept where it was asked to be'],
    documents: [
      { path: 'brief.md', name: 'Pricing brief' },
      { path: 'glossary.md', name: 'Glossary', store: 'git', phases: ['design'] }
    ]
  }));
  flow(root, ['start', 'FILE-1', '--from-branch', 'main', '--story-file', storyFile,
    '--document-store', 'local', '--document-phases', 'requirements,intake']);
  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/work-items/FILE-1/documents.json'), 'utf8'));
  const byName = Object.fromEntries(manifest.documents.map((record) => [record.name, record]));
  assert.equal(byName['Pricing brief'].storage.kind, 'local');
  assert.deepEqual(byName['Pricing brief'].phases, ['intake', 'requirements']);
  assert.equal(byName.Glossary.storage.kind, 'git', 'an entry\'s own store wins');
  assert.deepEqual(byName.Glossary.phases, ['design']);
  assert.doesNotMatch(run('git', ['log', '-p', '--all'], root).stdout, /Private pricing/);
});

test('Story start refuses a document at a path the environment declaration keeps local', async () => {
  const { root } = await repository();
  await writeFile(path.join(root, 'singularity', 'environments.yml'), `schemaVersion: 1
environments:
  qa:
    requires:
      - name: API_TOKEN
        kind: secret
    localFiles:
      - config/qa.settings
checks:
  browser-tests:
    environment: qa
`);
  run('git', ['add', 'singularity/environments.yml'], root);
  run('git', ['commit', '-m', 'declare QA environment files'], root);
  run('git', ['push'], root);
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config', 'qa.settings'), 'endpoint: https://qa.example.test\n');
  const refused = flow(root, ['start', 'ENV-START-1', '--from-branch', 'main', '--title', 'Environment file at start',
    '--document', path.join(root, 'config', 'qa.settings'), '--document-name', 'QA settings'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /'config\/qa\.settings' matches environments\.qa\.localFiles rule 'config\/qa\.settings'/);
  assert.equal(run('git', ['branch', '--list', 'ENV-START-1'], root).stdout.trim(), '', 'refused before the Story exists');
});

test('an isolated start reads relative document and story-file paths from the checkout it was launched in', async () => {
  const { root } = await repository();
  // Untracked files make the launch checkout dirty, so the start continues in its own worktree.
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'notes.md'), '# Notes\nGiven by a relative path.\n');
  await writeFile(path.join(root, 'docs', 'brief.md'), '# Brief\nListed by a relative story file.\n');
  await writeFile(path.join(root, 'docs', 'story.yml'), YAML.stringify({
    title: 'Relative story file', description: 'Started from a dirty checkout.', acceptanceCriteria: ['Paths resolve where they were typed'],
    documents: [{ path: 'brief.md', name: 'Brief' }]
  }));
  const explicit = flow(root, ['start', 'REL-1', '--from-branch', 'main', '--title', 'Relative document',
    '--document', 'docs/notes.md', '--document-name', 'Notes']);
  assert.match(explicit.stdout, /Isolated Story checkout: (.+)/);
  const worktree = explicit.stdout.match(/Isolated Story checkout: (.+)/)[1].trim();
  const [notes] = JSON.parse(await readFile(path.join(worktree, 'singularity/work-items/REL-1/documents.json'), 'utf8')).documents;
  assert.equal(notes.name, 'Notes');
  assert.match(await readFile(path.join(worktree, notes.path), 'utf8'), /Given by a relative path/);
  const fromFile = flow(root, ['start', 'REL-2', '--from-branch', 'main', '--story-file', 'docs/story.yml']);
  const fileWorktree = fromFile.stdout.match(/Isolated Story checkout: (.+)/)[1].trim();
  const [brief] = JSON.parse(await readFile(path.join(fileWorktree, 'singularity/work-items/REL-2/documents.json'), 'utf8')).documents;
  assert.equal(brief.name, 'Brief');
});

test('each Story-start document has its own phases and storage, and an image is kept like any file', async () => {
  const { root } = await repository();
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-per-document-start-'));
  const brief = path.join(uploads, 'brief.md'); await writeFile(brief, '# Brief\nRetry a failed payment once.\n');
  const mockup = path.join(uploads, 'checkout.png');
  await writeFile(mockup, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const notes = path.join(uploads, 'notes.md'); await writeFile(notes, '# Notes\nKept private.\n');
  const documents = ['--document', brief, '--document-name', 'Brief', '--document', mockup, '--document-name', 'Checkout mockup',
    '--document', notes, '--document-name', 'Private notes'];
  const refused = flow(root, ['start', 'EACH-1', '--from-branch', 'main', '--title', 'Per document', ...documents,
    '--document-phases', 'intake', '--document-phases', 'design'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--document-phases is given 2 times for 3 --document inputs\. Give it once for all of them, or once per --document, in the same order\./);
  assert.equal(run('git', ['branch', '--list', 'EACH-1'], root).stdout.trim(), '', 'refused before the Story exists');

  flow(root, ['start', 'EACH-1', '--from-branch', 'main', '--title', 'Per document', ...documents,
    '--document-phases', 'requirements,intake', '--document-phases', 'all', '--document-phases', 'design',
    '--document-store', 'git', '--document-store', 'git', '--document-store', 'local']);
  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/work-items/EACH-1/documents.json'), 'utf8'));
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/EACH-1/workflow.json'), 'utf8'));
  const byName = Object.fromEntries(manifest.documents.map((record) => [record.name, record]));
  assert.deepEqual(byName.Brief.phases, ['intake', 'requirements'], 'kept in workflow order');
  assert.deepEqual(byName['Checkout mockup'].phases, workflow.phaseOrder);
  assert.deepEqual(byName['Private notes'].phases, ['design']);
  assert.deepEqual(manifest.documents.map((record) => record.storage.kind), ['git', 'git', 'local']);
  assert.equal(byName['Checkout mockup'].mimeType, 'image/png');
  assert.match(run('git', ['ls-files', 'singularity/work-items/EACH-1/inputs'], root).stdout, /checkout\.png/,
    'the image is committed with the Story');
  assert.doesNotMatch(run('git', ['log', '-p', '--all'], root).stdout, /Kept private/);
});
