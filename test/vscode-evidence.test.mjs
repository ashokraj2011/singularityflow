import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  defaultEvidencePhases, evidenceCatalog, evidenceCommands, evidenceDetachCommand, evidenceDetachPreviewCommand, evidenceScopeCommand,
  evidenceStorageChoices, evidenceStorageLabel, evidenceUsesLabel, evidenceTargets, expandEpicEvidenceDirectory,
  suggestedEvidenceName, validateEvidenceName, validateEvidenceUrl
} = await import(path.join(packageRoot, 'apps/vscode/src/evidence.ts'));

test('evidence targets use the governed Story and Epic identities from the snapshot', () => {
  assert.deepEqual(evidenceTargets({
    workflow: { workItem: { id: 'MOB-123' } },
    initiative: { state: { initiative: { id: 'MOB-100' } } }
  }), [
    { kind: 'story', id: 'MOB-123', label: 'Story MOB-123' },
    { kind: 'epic', id: 'MOB-100', label: 'Epic MOB-100' }
  ]);
});

test('Story evidence keeps multi-file and Figma-folder uploads in one governed command', () => {
  const target = { kind: 'story', id: 'MOB-123', label: 'Story MOB-123' };
  assert.deepEqual(evidenceCommands(target, {
    kind: 'files', paths: ['/tmp/a.pdf', '/tmp/b.png'], names: ['Payment brief', 'Checkout screen']
  }), [
    ['documents', 'upload', '/tmp/a.pdf', '/tmp/b.png', '--name', 'Payment brief', '--name', 'Checkout screen', '--store', 'git']
  ]);
  assert.deepEqual(evidenceCommands(target, { kind: 'figma-export', paths: ['/tmp/figma'], names: ['Checkout export'], store: 'local' }), [
    ['documents', 'upload', '/tmp/figma', '--name', 'Checkout export', '--kind', 'figma-export', '--store', 'git']
  ], 'a folder is always committed to Git');
  assert.deepEqual(evidenceCommands(target, {
    kind: 'url', url: 'https://www.figma.com/design/abc', label: 'Checkout design'
  }), [['documents', 'upload', '--url', 'https://www.figma.com/design/abc', '--name', 'Checkout design']],
  'a Story link is named by the label the person gave it');
});

test('Story attachments pass where the bytes are kept and which phases use them', () => {
  const target = { kind: 'story', id: 'MOB-123', label: 'Story MOB-123' };
  assert.deepEqual(evidenceCommands(target, {
    kind: 'files', paths: ['/tmp/salary.xlsx'], names: ['Salary bands'], store: 'local', phases: ['specification', 'planning']
  }), [['documents', 'upload', '/tmp/salary.xlsx', '--name', 'Salary bands', '--store', 'local', '--phases', 'specification,planning']]);
  assert.deepEqual(evidenceCommands(target, { kind: 'files', paths: ['/tmp/a.md'], names: ['A'], store: 'git', phases: null }),
    [['documents', 'upload', '/tmp/a.md', '--name', 'A', '--store', 'git']],
    'storage is always stated, so a local default policy cannot keep a "Committed to Git" file on one machine');
  assert.deepEqual(evidenceStorageChoices(null), { allowed: ['git', 'local'], default: 'git' });
  assert.deepEqual(evidenceStorageChoices({ storage: { allowed: ['local', 'git'], default: 'local' } }), { allowed: ['git', 'local'], default: 'local' });
  assert.deepEqual(evidenceStorageChoices({ storage: { allowed: ['local'] } }), { allowed: ['local'], default: 'local' });
  assert.deepEqual(evidenceStorageChoices({ storage: { allowed: ['git'], default: 'local' } }), { allowed: ['git'], default: 'git' });
  assert.deepEqual(evidenceCommands(target, { kind: 'url', url: 'https://example.com/x', label: 'X', phases: ['design'] }),
    [['documents', 'upload', '--url', 'https://example.com/x', '--name', 'X', '--phases', 'design']]);
  const epic = { kind: 'epic', id: 'MOB-100', label: 'Epic MOB-100' };
  assert.deepEqual(evidenceCommands(epic, { kind: 'files', paths: ['/tmp/a.pdf'], names: ['A'], store: 'local', phases: ['design'] }),
    [['epic', 'sources', 'add', '--epic', 'MOB-100', '--provider', 'local', '--file', '/tmp/a.pdf']], 'Epic sources have no storage choice or phases');
  assert.deepEqual(defaultEvidencePhases(['intake', 'design', 'implementation'], 'design'), ['design', 'implementation']);
  assert.deepEqual(defaultEvidencePhases(['intake', 'design'], null), ['intake', 'design']);
});

test('the evidence catalog says where each Story file is kept and whether this checkout has it', () => {
  const snapshot = {
    workflow: { workItem: { id: 'MOB-123' } },
    documents: [
      { id: 'DOC-001', type: 'file', name: 'Brief', path: 'items/DOC-001/brief.md', storage: { kind: 'git' }, phases: ['design'] },
      { id: 'DOC-002', type: 'file', name: 'Salary bands', storage: { kind: 'local', key: 'x' }, availability: 'available' },
      { id: 'DOC-003', type: 'file', name: 'Elsewhere', storage: { kind: 'local', key: 'y' }, availability: 'unavailable' },
      { id: 'DOC-004', type: 'url', name: 'Figma', url: 'https://www.figma.com/design/abc' }
    ]
  };
  const byId = Object.fromEntries(evidenceCatalog(snapshot).map((item) => [item.id, item]));
  assert.deepEqual(Object.fromEntries(Object.entries(byId).map(([id, item]) => [id, [item.storage ?? null, item.availability ?? null]])), {
    'DOC-001': ['git', null], 'DOC-002': ['local', 'available'], 'DOC-003': ['local', 'unavailable'], 'DOC-004': [null, null]
  });
  assert.equal(evidenceStorageLabel(byId['DOC-001']), 'Committed to Git');
  assert.equal(evidenceStorageLabel(byId['DOC-002']), 'Kept on this machine only');
  assert.equal(evidenceStorageLabel(byId['DOC-003']), 'Kept on another machine · not available here');
  assert.equal(evidenceStorageLabel(byId['DOC-004']), null);
  assert.deepEqual(byId['DOC-001'].phases, ['design']);
  assert.deepEqual(evidenceScopeCommand(byId['DOC-001'], ['design', 'implementation'], 'Also used when coding', { dryRun: true }),
    ['documents', 'scope', 'DOC-001', '--phases', 'design,implementation', '--reason', 'Also used when coding', '--dry-run', '--json']);
  assert.deepEqual(evidenceScopeCommand(byId['DOC-001'], ['design'], 'Only design'),
    ['documents', 'scope', 'DOC-001', '--phases', 'design', '--reason', 'Only design', '--yes', '--json']);
});

test('Story document names are required, bounded, descriptive and unique in the Story', () => {
  assert.equal(validateEvidenceName('Payment brief'), null);
  assert.equal(validateEvidenceName('   '), 'A name is required.');
  assert.equal(validateEvidenceName('x'.repeat(121)), 'Use at most 120 characters.');
  assert.equal(validateEvidenceName('doc-012'), 'That looks like a document ID. Use a descriptive name.');
  assert.equal(validateEvidenceName(' payment   BRIEF', ['Payment brief']), 'Another document in this Story already has that name.');
  assert.equal(suggestedEvidenceName('/tmp/checkout_flow-v2.pdf'), 'checkout flow v2');
  assert.equal(suggestedEvidenceName('/tmp/figma-export'), 'figma export');
});

test('Epic evidence is pinned one deterministic file at a time and links retain their label', () => {
  const target = { kind: 'epic', id: 'MOB-100', label: 'Epic MOB-100' };
  assert.deepEqual(evidenceCommands(target, { kind: 'files', paths: ['/tmp/z.png', '/tmp/a.pdf'] }), [
    ['epic', 'sources', 'add', '--epic', 'MOB-100', '--provider', 'local', '--file', '/tmp/a.pdf'],
    ['epic', 'sources', 'add', '--epic', 'MOB-100', '--provider', 'local', '--file', '/tmp/z.png']
  ]);
  assert.deepEqual(evidenceCommands(target, {
    kind: 'url', url: 'https://www.figma.com/design/abc', label: 'Checkout design'
  }), [[
    'epic', 'sources', 'add', '--epic', 'MOB-100', '--url',
    'https://www.figma.com/design/abc', '--label', 'Checkout design'
  ]]);
});

test('evidence URLs require public-form HTTPS references and Figma links use a Figma host', () => {
  assert.equal(validateEvidenceUrl('https://docs.example.com/brief.pdf'), null);
  assert.equal(validateEvidenceUrl('http://docs.example.com/brief.pdf'), 'Use an HTTPS URL without embedded credentials.');
  assert.equal(validateEvidenceUrl('https://user:secret@example.com/brief.pdf'), 'Use an HTTPS URL without embedded credentials.');
  assert.equal(validateEvidenceUrl('https://www.figma.com/design/abc', true), null);
  assert.equal(validateEvidenceUrl('https://example.com/not-figma', true), 'Enter a Figma HTTPS link.');
});

test('Epic Figma exports expand deterministically without following symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-figma-evidence-'));
  await mkdir(path.join(root, 'screens'));
  await writeFile(path.join(root, 'tokens.json'), '{}');
  await writeFile(path.join(root, 'screens', 'checkout.png'), 'png');
  await symlink('/etc/hosts', path.join(root, 'outside-link'));
  assert.deepEqual(await expandEpicEvidenceDirectory(root), [
    path.join(root, 'screens', 'checkout.png'),
    path.join(root, 'tokens.json')
  ]);
});

test('VS Code separates active and detached evidence and builds shell-free detach commands', () => {
  const catalog = evidenceCatalog({
    workflow: { workItem: { id: 'MOB-123' } },
    documents: [{ id: 'DOC-001', type: 'file', label: 'Current design', status: 'active', packageId: 'PKG-001' }],
    detachedDocuments: [{
      id: 'DOC-002', type: 'file', label: 'Old design', status: 'detached',
      detachReason: 'Superseded', detachedBy: { name: 'Product Owner' }
    }],
    initiative: {
      state: { initiative: { id: 'MOB-100' } },
      sources: { sources: [{ sourceId: 'SRC-A', name: 'Current brief', status: 'pinned' }] },
      detachedSources: [{ sourceId: 'SRC-B', name: 'Old brief', status: 'detached', detachReason: 'Withdrawn' }]
    }
  });
  assert.deepEqual(catalog.map((item) => [item.id, item.status]), [
    ['SRC-A', 'active'], ['SRC-B', 'detached'], ['DOC-001', 'active'], ['DOC-002', 'detached']
  ]);
  assert.deepEqual(evidenceDetachCommand(catalog.find((item) => item.id === 'DOC-001'), 'package', 'New export'), [
    'documents', 'detach', 'DOC-001', '--scope', 'package', '--reason', 'New export', '--yes'
  ]);
  assert.deepEqual(evidenceDetachCommand(catalog.find((item) => item.id === 'SRC-A'), 'file', 'Withdrawn'), [
    'epic', 'sources', 'detach', 'SRC-A', '--epic', 'MOB-100', '--reason', 'Withdrawn', '--yes'
  ]);
  // A Story detach is previewed first so the dialog can name what it reopens; Epic sources have no preview.
  assert.deepEqual(evidenceDetachPreviewCommand(catalog.find((item) => item.id === 'DOC-001'), 'file'), [
    'documents', 'detach', 'DOC-001', '--scope', 'file', '--dry-run', '--json'
  ]);
  assert.equal(evidenceDetachPreviewCommand(catalog.find((item) => item.id === 'SRC-A'), 'file'), null);
  assert.equal(evidenceUsesLabel([{ phase: 'intake', generation: 1 }, { phase: 'design', generation: 2 }]),
    'intake generation 1, design generation 2');
  assert.equal(evidenceUsesLabel([]), null);
});

test('a tree row opens every active Story document, including links and documents kept on one machine', async () => {
  const { storyEvidenceNode } = await import(path.join(packageRoot, 'apps/vscode/src/views/tree-model.ts'));
  const committed = storyEvidenceNode('MOB-1', { id: 'DOC-001', name: 'Brief', type: 'file', path: 'singularity/work-items/MOB-1/inputs/DOC-001/brief.md', mimeType: 'text/markdown', storage: { kind: 'git' } });
  assert.equal(committed.path, 'singularity/work-items/MOB-1/inputs/DOC-001/brief.md');
  assert.equal(committed.runCommand, undefined);
  assert.equal(committed.label, 'Brief');
  assert.equal(committed.description, 'text/markdown');
  const local = storyEvidenceNode('MOB-1', { id: 'DOC-002', name: 'Private notes', type: 'file', mimeType: 'text/markdown', storage: { kind: 'local', key: 'abc' }, availability: 'available' });
  assert.equal(local.path, undefined);
  assert.equal(local.runCommand, 'singularityFlow.openArtifact');
  assert.equal(local.description, 'text/markdown · this machine only');
  assert.deepEqual(local.evidence, { ownerKind: 'story', ownerId: 'MOB-1', evidenceId: 'DOC-002', packageId: undefined, status: 'active' });
  const elsewhere = storyEvidenceNode('MOB-1', { id: 'DOC-003', name: 'Their notes', type: 'file', storage: { kind: 'local' }, availability: 'unavailable', mimeType: 'text/plain' });
  assert.equal(elsewhere.description, 'text/plain · on another machine');
  const link = storyEvidenceNode('MOB-1', { id: 'DOC-004', name: 'Design', type: 'url', url: 'https://example.com/design' });
  assert.equal(link.runCommand, 'singularityFlow.openArtifact');
  const detached = storyEvidenceNode('MOB-1', { id: 'DOC-005', name: 'Old', type: 'file', storage: { kind: 'local' } }, true);
  assert.equal(detached.runCommand, undefined);
  assert.equal(detached.description, 'detached');
});

test('a Story imports one of its Epic\'s sources through documents fetch, storage and phases stated', () => {
  const target = { kind: 'story', id: 'APP-1', label: 'Story APP-1' };
  assert.deepEqual(evidenceCommands(target, { kind: 'epic-source', sourceId: 'SRC-6C9812569F6A', name: 'Ledger brief', store: 'local', phases: ['intake', 'requirements'] }), [
    ['documents', 'fetch', '--provider', 'epic', '--ref', 'SRC-6C9812569F6A', '--name', 'Ledger brief', '--store', 'local', '--phases', 'intake,requirements']
  ]);
  assert.deepEqual(evidenceCommands(target, { kind: 'epic-source', sourceId: 'SRC-6C9812569F6A', name: 'Ledger brief', phases: null }), [
    ['documents', 'fetch', '--provider', 'epic', '--ref', 'SRC-6C9812569F6A', '--name', 'Ledger brief', '--store', 'git']
  ]);
});
