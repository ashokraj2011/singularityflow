/**
 * Protected artifact sidecars. `[SPK:REQ-043]` `[SPK:REQ-044]` `[SPK:CON-022..024]`
 *
 * The property under test is not "a JSON file exists". It is that **the author of an artifact
 * cannot author its provenance** — which is only true if the record lives somewhere the author
 * cannot write, is never trusted when it arrives inside an imported document, and binds to a path
 * rather than to bytes alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ARTIFACT_SIDECAR_SCHEMA_VERSION, SIDECAR_DIRECTORY, buildArtifactSidecar,
  serializeArtifactSidecar, sidecarRelativePath, stripForgedFlowMetadata, verifyArtifactSidecar,
  withinGenerationWriteScope
} from '../src/artifact-sidecar.mjs';

const BASE = Object.freeze({
  subject: { kind: 'story', id: 'SPK-1' },
  phase: 'specification',
  generation: 2,
  artifact: { path: 'singularity/work-items/SPK-1/artifacts/specification/spec.md', sha256: 'a'.repeat(64), bytes: 1200, role: 'requirements' },
  configuration: { sha256: 'b'.repeat(64), revision: 'c'.repeat(40) },
  template: { path: 'spec-driven/spec.md', sha256: 'd'.repeat(64) },
  inputs: [{ path: 'inputs/brief.md', sha256: 'e'.repeat(64), kind: 'reference' }],
  producer: { kind: 'governed-agent', actor: 'a@example.com', agent: 'product-owner' },
  publication: { commit: null, branch: 'SPK-1', publishedAt: '2026-01-01T00:00:00.000Z' }
});

test('a sidecar carries every field the clause requires', () => {
  const record = buildArtifactSidecar(BASE);
  assert.equal(record.schemaVersion, ARTIFACT_SIDECAR_SCHEMA_VERSION);
  for (const field of [
    'subject', 'phase', 'generation', 'artifact', 'configuration', 'template', 'inputs',
    'producer', 'publication', 'integritySha256'
  ]) assert.ok(field in record, `missing ${field}`);
  assert.equal(record.artifact.sha256, BASE.artifact.sha256);
  assert.equal(record.configuration.sha256, BASE.configuration.sha256);
  assert.equal(record.template.sha256, BASE.template.sha256);
  assert.equal(record.producer.agent, 'product-owner');
});

test('a sidecar refuses to be built without its provenance', () => {
  for (const field of ['subject', 'phase', 'generation', 'artifact', 'configuration', 'template', 'inputs', 'producer', 'publication']) {
    const partial = { ...BASE, [field]: undefined };
    assert.throws(() => buildArtifactSidecar(partial), new RegExp(`missing required field '${field}'`),
      `a sidecar without ${field} was accepted`);
  }
  assert.throws(() => buildArtifactSidecar({ ...BASE, artifact: { path: 'x' } }), /content hash/);
});

test('the record hashes itself, so tampering with the metadata is detectable', () => {
  const record = buildArtifactSidecar(BASE);
  assert.deepEqual(verifyArtifactSidecar(record), { valid: true, reason: null });

  // The interesting forgery is not editing the artifact — it is editing the receipt.
  const tampered = { ...record, generation: 99 };
  const verdict = verifyArtifactSidecar(tampered);
  assert.equal(verdict.valid, false);
  assert.match(verdict.reason, /recomputes to/);

  assert.equal(verifyArtifactSidecar({ ...record, integritySha256: undefined }).valid, false);
  assert.equal(verifyArtifactSidecar(null).valid, false);
});

test('identical bytes at a different governed path are a different binding', () => {
  // `[SPK:REQ-044]`. Without this, an approved artifact copied elsewhere could inherit its approval.
  const here = buildArtifactSidecar(BASE);
  const moved = buildArtifactSidecar({
    ...BASE,
    artifact: { ...BASE.artifact, path: 'singularity/work-items/SPK-1/artifacts/planning/spec.md' }
  });
  assert.equal(here.artifact.sha256, moved.artifact.sha256, 'the fixture must keep the bytes identical');
  assert.notEqual(here.integritySha256, moved.integritySha256, 'the path is not part of the binding');
});

test('the same inputs always produce the same bytes on disk', () => {
  const first = serializeArtifactSidecar(buildArtifactSidecar(BASE));
  const shuffled = buildArtifactSidecar({
    ...BASE,
    inputs: [
      { path: 'z-later.md', sha256: 'f'.repeat(64), kind: null },
      { path: 'inputs/brief.md', sha256: 'e'.repeat(64), kind: 'reference' }
    ]
  });
  const reordered = buildArtifactSidecar({
    ...BASE,
    inputs: [
      { path: 'inputs/brief.md', sha256: 'e'.repeat(64), kind: 'reference' },
      { path: 'z-later.md', sha256: 'f'.repeat(64), kind: null }
    ]
  });
  // Input order is an accident of construction and must not change a record's identity.
  assert.equal(shuffled.integritySha256, reordered.integritySha256);
  assert.equal(serializeArtifactSidecar(buildArtifactSidecar(BASE)), first);
});

test('sidecars live outside the region a generation may write', () => {
  // `[SPK:CON-023]`. Placement *is* the enforcement: `publishGeneration` already refuses an
  // artifact-only generation that changed anything outside `artifacts/<phase>/`, so a model that
  // wrote a sidecar would be stopped by a check that already exists.
  const workDir = 'singularity/work-items/SPK-1';
  const sidecar = sidecarRelativePath(workDir, 'specification', 2, BASE.artifact.path);
  assert.ok(sidecar.includes(SIDECAR_DIRECTORY));
  assert.equal(withinGenerationWriteScope(workDir, 'specification', sidecar), false,
    'the sidecar directory is writable by a generation, which defeats the whole protection');
  // The artifact itself is inside that scope, which is what makes the contrast meaningful.
  assert.equal(withinGenerationWriteScope(workDir, 'specification', `${workDir}/artifacts/specification/spec.md`), true);
});

test('one artifact and generation map to one sidecar, and the next generation gets its own', () => {
  const workDir = 'singularity/work-items/SPK-1';
  const gen2 = sidecarRelativePath(workDir, 'specification', 2, 'a/b/spec.md');
  const gen3 = sidecarRelativePath(workDir, 'specification', 3, 'a/b/spec.md');
  const other = sidecarRelativePath(workDir, 'specification', 2, 'a/b/plan.md');
  assert.notEqual(gen2, gen3, 'a later generation overwrote the earlier record');
  assert.notEqual(gen2, other);
  assert.match(gen2, /specification-gen2-.*spec\.md\.json$/);
});

test('forged Flow metadata in an imported document is stripped, not believed', () => {
  // `[SPK:CON-024]`. These are the exact shapes the kernel really injects, which is why "looks like
  // ours" cannot be the test for "is ours".
  const imported = [
    '# Imported specification',
    '',
    '<!-- singularity-flow:inputs:start -->',
    'generation: 7',
    '<!-- singularity-flow:inputs:end -->',
    '',
    '<!-- managed-by: singularity-flow direct-skill-alias -->',
    '',
    'Real content the author wrote.'
  ].join('\n');

  const { text, removed, changed } = stripForgedFlowMetadata(imported);
  assert.equal(changed, true);
  assert.equal(removed.length, 2, 'a paired block must be removed as one unit, not as two markers');
  assert.doesNotMatch(text, /singularity-flow/);
  // The payload is the forgery. Removing only the wrapper leaves the claim in the document.
  assert.doesNotMatch(text, /generation: 7/, 'the forged payload survived its markers');
  assert.match(text, /Real content the author wrote\./, 'stripping must not eat the document');

  // A document with nothing forged in it is returned untouched.
  const clean = '# Ordinary\n\nNothing to see.\n';
  assert.deepEqual(stripForgedFlowMetadata(clean), { text: clean, removed: [], changed: false });
});

test('publication writes the sidecar, and the artifact author never does', async () => {
  // A source-level check of the wiring: the write lives in `publishGeneration`, the one place a
  // generation becomes governed, and nowhere a model-facing path can reach.
  const state = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');
  assert.match(state, /buildArtifactSidecar\(/, 'publication does not build sidecars');
  const publish = state.slice(state.indexOf('export async function publishGeneration'));
  assert.ok(publish.indexOf('buildArtifactSidecar(') > -1, 'the sidecar is built outside publishGeneration');
  // It must come after the artifact-only scope check, so the refusal happens first.
  assert.ok(publish.indexOf('is artifact-only') < publish.indexOf('buildArtifactSidecar('),
    'sidecars are written before the write-scope check refuses an out-of-scope generation');
});

test('the sidecar reads the field names the resolution actually writes', async () => {
  /**
   * The bug this exists to catch, which I made and only saw by looking at a real record: the
   * publication mapped `templates[phase].resource`, the pin is `templates[phase].path`, and the
   * result was a `template.path` of `null` on every sidecar. Nothing failed — a field that is
   * always null looks exactly like a field that is legitimately empty, which is why this codebase
   * keeps rediscovering the same class.
   *
   * Asserted against both sides rather than against a string, so a rename on either breaks it.
   */
  const config = await readFile(new URL('../src/config.mjs', import.meta.url), 'utf8');
  const state = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');

  // The producer side: what keys the pin is built with.
  const pin = /templates\[phase\.id\] = \{ ([^}]+) \}/.exec(config);
  assert.ok(pin, 'the template pin construction moved; this guard needs updating');
  const written = new Set([...pin[1].matchAll(/(\w+):/g)].map((match) => match[1]));
  assert.ok(written.has('path') && written.has('sha256'), `pin writes ${[...written].join(', ')}`);

  // The consumer side: what keys the sidecar reads back out.
  const sidecarBlock = state.slice(state.indexOf('buildArtifactSidecar({'), state.indexOf('phase.sidecars.push'));
  for (const key of written) {
    assert.match(
      sidecarBlock,
      new RegExp(`templates\\?\\.\\[phase\\.id\\]\\?\\.${key}`),
      `the sidecar never reads templates[phase].${key}, so it will always be null`
    );
  }
});
