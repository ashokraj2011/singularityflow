import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeWorldModelManifest,
  validateWorldModelDirectory,
  worldModelSelectionEntry
} from '../src/grounding.mjs';
import {
  mergeWorldModelSnapshot,
  writeV3Manifest
} from '../src/world-model-materialization.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

async function seedModel(directory, sourceTreeSha256, {
  label,
  views = {},
  materialization = null
} = {}) {
  await mkdir(path.join(directory, 'core'), { recursive: true });
  await mkdir(path.join(directory, 'views'), { recursive: true });
  await mkdir(path.join(directory, 'evidence'), { recursive: true });
  await writeFile(path.join(directory, 'core/summary.brief.md'), `# ${label} core brief\n`);
  await writeFile(path.join(directory, 'core/summary.md'), `# ${label} core full\n`);
  await writeFile(path.join(directory, 'core/model.json'), '{}\n');
  await writeFile(path.join(directory, 'path-index.json'), '{}\n');
  await writeFile(path.join(directory, 'evidence/evidence.jsonl'), '{"id":"E-1"}\n');
  const manifestViews = {};
  for (const [view, tiers] of Object.entries(views)) {
    manifestViews[view] = { tiers: {} };
    for (const tier of ['brief', 'full']) {
      const relative = `views/${view}${tier === 'brief' ? '.brief' : ''}.md`;
      if (tiers.includes(tier)) {
        await writeFile(path.join(directory, relative), `# ${label} ${view} ${tier}\n`);
        manifestViews[view].tiers[tier] = { status: 'ready', path: relative };
      } else {
        manifestViews[view].tiers[tier] = { status: 'missing', path: relative };
      }
    }
  }
  return writeV3Manifest(directory, {
    schema_version: '3.0',
    generated_at: '2026-08-10T00:00:00.000Z',
    generated_date: '10 August 2026',
    builder_version: 'test',
    builder_prompt_sha256: 'a'.repeat(64),
    analysis_depth: 'quick',
    repository_commit: COMMIT,
    repository_branch: 'main',
    working_tree_clean: true,
    source_tree_sha256: sourceTreeSha256,
    core: {
      tiers: {
        brief: { status: 'ready', path: 'core/summary.brief.md' },
        full: { status: 'ready', path: 'core/summary.md' }
      },
      model: { path: 'core/model.json' }
    },
    views: manifestViews,
    domains: [],
    task_guides: [],
    path_index: { path: 'path-index.json' },
    evidence: { path: 'evidence/evidence.jsonl' },
    materializations: []
  }, { materialization });
}

test('v3 validation requires the exact requested tier without silently falling back', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-tier-'));
  const source = `sha256:${'1'.repeat(64)}`;
  await seedModel(root, source, { label: 'exact', views: { business: ['brief'] } });
  await validateWorldModelDirectory(root, {
    requiredSelections: [
      { kind: 'core', tier: 'brief' },
      { kind: 'view', view: 'business', tier: 'brief' }
    ],
    requireEvidence: false,
    integrity: 'selected'
  });
  await assert.rejects(
    validateWorldModelDirectory(root, {
      requiredSelections: [{ kind: 'view', view: 'business', tier: 'full' }],
      requireEvidence: false,
      integrity: 'selected'
    }),
    /business\/full.*missing/
  );
});

test('legacy manifests remain readable while v3 keeps exact tier identity', () => {
  for (const schema of ['1.0', '2.0']) {
    const normalized = normalizeWorldModelManifest({
      schema_version: schema,
      core: { summary: 'core/summary.md', model: 'core/model.json' },
      views: { architecture: { path: 'views/architecture.md', generated: true } }
    });
    assert.equal(normalized.source_schema_version, schema);
    assert.equal(
      worldModelSelectionEntry(normalized, { kind: 'view', view: 'architecture', tier: 'brief' }, { allowLegacyFallback: true }).path,
      'views/architecture.md'
    );
  }
  const normalized = normalizeWorldModelManifest({
    schema_version: '3.0',
    core: { tiers: { brief: { status: 'missing' }, full: { status: 'ready', path: 'core/summary.md' } } },
    views: {}
  });
  assert.equal(worldModelSelectionEntry(normalized, { kind: 'core', tier: 'brief' }).status, 'missing');
});

test('same-source extension preserves every already-valid selected and unrelated artifact byte', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-merge-'));
  const existing = path.join(root, 'existing');
  const fragment = path.join(root, 'fragment');
  const target = path.join(root, 'target');
  const source = `sha256:${'2'.repeat(64)}`;
  await seedModel(existing, source, {
    label: 'original',
    views: { business: ['brief'] },
    materialization: { id: 'first', selections: ['core/brief', 'business/brief'] }
  });
  await seedModel(fragment, source, {
    label: 'extension',
    views: { architecture: ['full'] },
    materialization: { id: 'second', selections: ['core/brief', 'architecture/full'] }
  });
  const originalCore = await readFile(path.join(existing, 'core/summary.brief.md'), 'utf8');
  const originalBusiness = await readFile(path.join(existing, 'views/business.brief.md'), 'utf8');
  const manifest = await mergeWorldModelSnapshot({
    existingDirectory: existing,
    fragmentDirectory: fragment,
    targetDirectory: target,
    sourceTreeSha256: source,
    plan: { selections: [{ kind: 'core', tier: 'brief' }, { kind: 'view', view: 'architecture', tier: 'full' }] },
    materialization: null
  });
  assert.equal(await readFile(path.join(target, 'core/summary.brief.md'), 'utf8'), originalCore);
  assert.equal(await readFile(path.join(target, 'views/business.brief.md'), 'utf8'), originalBusiness);
  assert.match(await readFile(path.join(target, 'views/architecture.md'), 'utf8'), /extension architecture full/);
  assert.deepEqual(manifest.materializations.at(-1).reused, ['core/brief']);
});

test('a changed source snapshot never reuses artifacts from the older snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-stale-'));
  const existing = path.join(root, 'existing');
  const fragment = path.join(root, 'fragment');
  const target = path.join(root, 'target');
  await seedModel(existing, `sha256:${'3'.repeat(64)}`, { label: 'old', views: { business: ['brief'] } });
  await seedModel(fragment, `sha256:${'4'.repeat(64)}`, { label: 'new', views: { architecture: ['full'] } });
  const manifest = await mergeWorldModelSnapshot({
    existingDirectory: existing,
    fragmentDirectory: fragment,
    targetDirectory: target,
    sourceTreeSha256: `sha256:${'4'.repeat(64)}`,
    plan: { selections: [{ kind: 'core', tier: 'brief' }, { kind: 'view', view: 'architecture', tier: 'full' }] },
    materialization: null
  });
  assert.equal(manifest.views.business, undefined);
  assert.match(await readFile(path.join(target, 'core/summary.brief.md'), 'utf8'), /new core brief/);
});
