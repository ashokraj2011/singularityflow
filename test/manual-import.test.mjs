import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importManualArtifact, inspectInPlaceArtifact } from '../src/manual-authorship.mjs';
import { authoredArtifactFingerprint } from '../src/publication-preflight.mjs';

test('manual import copies stable bytes, removes managed metadata, and validates the contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-manual-import-'));
  const source = path.join(root, 'source.md');
  const target = path.join(root, 'target.md');
  await writeFile(source, '<!-- singularity-flow:metadata\nold\n-->\n# Decision\n\nThe reviewed decision is complete.\n');
  const result = await importManualArtifact({
    sourcePath: source,
    targetPath: target,
    contract: { minimumBytes: 20, allowedExtensions: ['.md'], allowedMediaTypes: ['text/markdown'], validation: { requiredHeadings: ['Decision'] } }
  });
  assert.equal(await readFile(target, 'utf8'), '# Decision\n\nThe reviewed decision is complete.\n');
  assert.equal(result.kind, 'import');
  assert.equal(result.mediaType, 'text/markdown');
});

test('manual import refuses symbolic links', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-manual-symlink-'));
  const source = path.join(root, 'source.md');
  const link = path.join(root, 'source-link.md');
  await writeFile(source, '# Evidence\n');
  await symlink(source, link);
  await assert.rejects(() => importManualArtifact({ sourcePath: link, targetPath: path.join(root, 'target.md'), contract: {} }), /symbolic link/);
});

test('the early manual preflight applies the same unchanged-template baseline as publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-manual-baseline-'));
  const target = path.join(root, 'target.md');
  const text = '# Review\n\n## Outcome\n\nThe configured scaffold contains no explicit placeholder.\n';
  await writeFile(target, text);
  await assert.rejects(
    () => inspectInPlaceArtifact(
      target,
      { generation: 1, minimumBytes: 20 },
      { baseline: { generation: 1, fingerprint: authoredArtifactFingerprint(text) } }
    ),
    (error) => error.code === 'ARTIFACT_AUTHORING_INCOMPLETE' && /still matches its prepared template/.test(error.message)
  );
});
