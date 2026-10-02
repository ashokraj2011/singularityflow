import assert from 'node:assert/strict';
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeDocumentObligations } from '../src/trp-document-policy.mjs';
import { inspectSupplementalDocument } from '../src/trp-document-runtime.mjs';

const contract = { id: 'rollout-note', phaseId: 'implementation', path: 'docs/rollout.md', requiredSections: ['Rollback'] };
const workflow = { phases: { implementation: { id: 'implementation', requiredArtifact: { path: 'artifacts/IMPLEMENTATION.md' } } }, resolution: {} };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-trp-document-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs')); return root;
}

test('supplemental document normalization is closed, bounded and excludes authority instructions', () => {
  assert.deepEqual(normalizeDocumentObligations([contract]), [contract]);
  for (const value of [[], [{ ...contract, authorized: true }], [{ ...contract, path: '../outside.md' }],
    [{ ...contract, path: '/tmp/outside.md' }], [{ ...contract, path: 'docs\\rollout.md' }],
    [{ ...contract, path: 'AGENTS.md' }], [{ ...contract, path: 'docs/SKILL.md' }],
    [{ ...contract, path: 'singularity/policy.md' }], [{ ...contract, path: '.github/instructions.md' }],
    [{ ...contract, path: 'docs/rollout.txt' }], [{ ...contract, requiredSections: ['Rollback', 'Rollback'] }],
    [{ ...contract, requiredSections: ['bad\nheading'] }], [contract, { ...contract, id: 'other', path: 'docs/ROLLOUT.md' }]]) {
    assert.throws(() => normalizeDocumentObligations(value), { code: 'TRP_DOCUMENT_POLICY_INVALID' });
  }
});

test('native document check distinguishes missing, empty, incomplete and genuinely satisfied sections without writes', async t => {
  const root = await fixture(t);
  const missing = await inspectSupplementalDocument(root, {}, workflow, contract);
  assert.equal(missing.exists, false); assert.equal(missing.valid, false); assert.equal(missing.sha256, null);
  await assert.rejects(access(path.join(root, contract.path)), { code: 'ENOENT' });
  await writeFile(path.join(root, contract.path), ' \n');
  const empty = await inspectSupplementalDocument(root, {}, workflow, contract);
  assert.equal(empty.valid, false); assert.ok(empty.findings.some(finding => finding.includes('empty')));
  await writeFile(path.join(root, contract.path), '# Rollout\n\nPlan the deployment.\n');
  const incomplete = await inspectSupplementalDocument(root, {}, workflow, contract);
  assert.deepEqual(incomplete.findings, ['Required section is absent: Rollback']);
  const bytes = '# Rollout\n\n## Rollback\n\nRestore the previous application revision.\n';
  await writeFile(path.join(root, contract.path), bytes);
  const passing = await inspectSupplementalDocument(root, {}, workflow, contract);
  assert.equal(passing.valid, true); assert.equal(passing.bytes, Buffer.byteLength(bytes));
  assert.match(passing.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(await readFile(path.join(root, contract.path), 'utf8'), bytes);
  assert.notEqual(passing.sha256, incomplete.sha256);
});

test('rendered heading obligations are not satisfied by code examples', async t => {
  const root = await fixture(t);
  for (const text of ['# Rollout\n\n```markdown\n## Rollback\n```\n', '# Rollout\n\n~~~\n## Rollback\n~~~\n']) {
    await writeFile(path.join(root, contract.path), text);
    const inspected = await inspectSupplementalDocument(root, {}, workflow, contract);
    assert.equal(inspected.valid, false); assert.ok(inspected.findings.includes('Required section is absent: Rollback'));
  }
});

test('essential and protected paths stay nonwaivable even when declared supplemental', async t => {
  const root = await fixture(t);
  for (const [config, item, relative] of [
    [{}, workflow, 'singularity/definition.md'],
    [{ governance: { protectedPaths: ['docs'] } }, workflow, contract.path],
    [{}, { ...workflow, resolution: { capability: { policy: { protectedPaths: ['docs'] } } } }, contract.path],
    [{}, { ...workflow, phases: { implementation: { requiredArtifact: { path: contract.path } } } }, contract.path],
    [{}, { ...workflow, phases: { implementation: { artifactSet: { members: [{ path: contract.path }] } } } }, contract.path],
    [{}, { ...workflow, phases: { implementation: { artifactSet: { artifacts: [{ path: contract.path }] } } } }, contract.path]
  ]) {
    await assert.rejects(inspectSupplementalDocument(root, config, item, { ...contract, path: relative }), error =>
      error.code === (relative.startsWith('singularity/') ? 'TRP_DOCUMENT_POLICY_INVALID' : 'TRP_DOCUMENT_NONWAIVABLE'));
  }
});

test('native document inspection refuses linked, oversized and malformed bytes', async t => {
  const root = await fixture(t); const target = path.join(root, contract.path);
  await writeFile(path.join(root, 'source.md'), '## Rollback\n');
  if (process.platform !== 'win32') {
    await symlink(path.join(root, 'source.md'), target);
    await assert.rejects(inspectSupplementalDocument(root, {}, workflow, contract)); await rm(target);
  }
  await link(path.join(root, 'source.md'), target);
  await assert.rejects(inspectSupplementalDocument(root, {}, workflow, contract), { code: 'TRP_DOCUMENT_EVIDENCE_INVALID' }); await rm(target);
  for (const bytes of [Buffer.from([0xff, 0xfe, 0xff]), Buffer.from('## Rollback\n\0'), Buffer.alloc(1024 * 1024 + 1, 65)]) {
    await writeFile(target, bytes);
    await assert.rejects(inspectSupplementalDocument(root, {}, workflow, contract), { code: 'TRP_DOCUMENT_EVIDENCE_INVALID' });
  }
});
