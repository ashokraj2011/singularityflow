import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { phaseArtifactCatalog, viewPhaseArtifact } from '../src/phase-artifact-browser.mjs';
import { artifactPreviewMarkdown, phaseArtifactsBody } from '../apps/vscode/src/views/phase-artifacts-page.ts';

const config = { workItemRoot: 'singularity/work-items' };
const item = 'singularity/work-items/STORY-1';
function workflow() {
  return { workItem: { id: 'STORY-1' }, currentPhase: 'custom-code', phaseOrder: ['custom-intent', 'custom-code', 'sign-off'], phases: {
    'custom-intent': { id: 'custom-intent', label: 'Team intent', status: 'approved', generation: 1,
      requiredArtifact: { path: 'artifacts/intent.md', kind: 'specification' }, artifacts: [] },
    'custom-code': { id: 'custom-code', label: 'Team coding', status: 'in_progress', generation: 2,
      requiredArtifact: { path: 'artifacts/code.md' }, artifacts: [{ path: `${item}/artifacts/code.md` }, { path: `${item}/artifacts/checks.json`, kind: 'evidence' }] },
    'sign-off': { id: 'sign-off', label: 'Sign off', status: 'not_started', generation: 0, artifacts: [] }
  } };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-artifact-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, item, 'artifacts'), { recursive: true });
  return root;
}

test('artifact catalog follows custom phase order, deduplicates primary documents, and never reads file bodies', () => {
  const catalog = phaseArtifactCatalog(config, workflow());
  assert.deepEqual(catalog.phases.map(phase => phase.id), ['custom-intent', 'custom-code', 'sign-off']);
  assert.equal(catalog.phases[0].approved, true);
  assert.equal(catalog.phases[1].approved, false);
  assert.equal(catalog.phases[1].artifacts.length, 2);
  assert.equal(catalog.phases[2].artifacts.length, 0);
  assert.deepEqual(catalog, phaseArtifactCatalog(config, workflow()), 'IDs remain stable across list/refresh');
  assert.doesNotMatch(JSON.stringify(catalog), /content|sha256/);
});

test('draft viewing reads current working bytes without rewriting files or enforcing a stale publication hash', async t => {
  const root = await fixture(t);
  const value = workflow();
  const entry = phaseArtifactCatalog(config, value).phases[1].artifacts[0];
  await writeFile(path.join(root, entry.path), '# Updated draft\n');
  const preview = await viewPhaseArtifact(root, config, value, entry.id, 'draft');
  assert.equal(preview.content, '# Updated draft\n');
  assert.equal(preview.version, 'draft');
  assert.equal(preview.commit, null);
  assert.equal(preview.sha256, createHash('sha256').update(preview.content).digest('hex'));
  assert.equal(await readFile(path.join(root, entry.path), 'utf8'), preview.content);
});

test('unknown, traversal and non-approved version requests do not open alternate files', async t => {
  const root = await fixture(t);
  const value = workflow();
  const entry = phaseArtifactCatalog(config, value).phases[1].artifacts[0];
  await assert.rejects(viewPhaseArtifact(root, config, value, '../../README.md'), { code: 'PHASE_ARTIFACT_UNKNOWN' });
  await assert.rejects(viewPhaseArtifact(root, config, value, entry.id, 'latest'), { code: 'PHASE_ARTIFACT_VERSION_INVALID' });
  await assert.rejects(viewPhaseArtifact(root, config, value, entry.id, 'approved'), { code: 'PHASE_ARTIFACT_NOT_APPROVED' });
  value.phases['custom-code'].artifacts.push({ path: '../outside.md' });
  const unsafe = phaseArtifactCatalog(config, value).phases[1].artifacts.at(-1);
  await assert.rejects(viewPhaseArtifact(root, config, value, unsafe.id), { code: 'PHASE_ARTIFACT_PATH_UNSAFE' });
});

test('symlink drafts and oversized artifacts are refused before a preview is returned', async t => {
  const root = await fixture(t);
  const value = workflow();
  const entry = phaseArtifactCatalog(config, value).phases[1].artifacts[0];
  await writeFile(path.join(root, 'outside.md'), 'Not a governed document');
  await symlink(path.join(root, 'outside.md'), path.join(root, entry.path));
  await assert.rejects(viewPhaseArtifact(root, config, value, entry.id), /regular governed file/);
  await rm(path.join(root, entry.path));
  await writeFile(path.join(root, entry.path), 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(viewPhaseArtifact(root, config, value, entry.id), /preview limit/);
});

test('browser separates Draft and Approved and escapes repository-authored labels and paths', () => {
  const catalog = phaseArtifactCatalog(config, workflow());
  catalog.phases[0].label = '<script>bad</script>';
  const approved = phaseArtifactsBody(catalog, 'custom-intent', 'approved');
  assert.match(approved, /&lt;script&gt;bad/);
  assert.doesNotMatch(approved, /<script>/);
  assert.match(approved, /data-version="approved" aria-pressed="true"/);
  assert.match(approved, /read-only|Read-only/);
  assert.match(approved, /View Markdown/);
  assert.doesNotMatch(approved, /data-artifact=.*checks/);
  assert.match(phaseArtifactsBody(catalog, 'custom-code', 'approved'), /No currently approved artifacts/);
  assert.match(phaseArtifactsBody(catalog, 'sign-off', 'draft'), /No artifacts are registered/);
});

test('Markdown preview preserves Markdown bodies, safely fences non-Markdown, and labels binary limits honestly', () => {
  const preview = { workId: 'STORY-1', phase: 'custom-intent', generation: 1, version: 'approved',
    commit: 'a'.repeat(40), sha256: 'b'.repeat(64), binary: false, content: '# Specification\n\n**Intent**',
    record: { label: 'Specification', path: 'spec.md', kind: 'specification' } };
  const markdown = artifactPreviewMarkdown(preview);
  assert.match(markdown, /Approved · read-only published version/);
  assert.match(markdown, /Publication commit:/);
  assert.ok(markdown.endsWith(preview.content));
  const json = artifactPreviewMarkdown({ ...preview, record: { ...preview.record, path: 'checks.json' }, content: '```\n<script>bad</script>' });
  assert.match(json, /````\n```\n<script>bad<\/script>\n````/);
  assert.match(artifactPreviewMarkdown({ ...preview, binary: true, content: null }), /no Markdown text preview/);
  assert.doesNotThrow(() => artifactPreviewMarkdown({ ...preview, record: { ...preview.record, path: 'checks.json' },
    content: '`x'.repeat(150_000) }), 'many code delimiters do not overflow the extension-host argument stack');
});
