import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  evidenceCommands, evidenceTargets, expandEpicEvidenceDirectory, validateEvidenceUrl
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
  assert.deepEqual(evidenceCommands(target, { kind: 'files', paths: ['/tmp/a.pdf', '/tmp/b.png'] }), [
    ['documents', 'upload', '/tmp/a.pdf', '/tmp/b.png']
  ]);
  assert.deepEqual(evidenceCommands(target, { kind: 'figma-export', paths: ['/tmp/figma'] }), [
    ['documents', 'upload', '/tmp/figma', '--kind', 'figma-export']
  ]);
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
