import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { validateDefinition } from '../src/config.mjs';
import {
  addWorldModelView,
  markdownWorldModelViews,
  removeWorldModelView,
  structuredWorldModelViewReferences,
  worldModelViewCatalog
} from '../src/world-model-views.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function definition() {
  return YAML.parse(await readFile(path.join(root, 'templates/workflow.yml'), 'utf8'));
}

test('world-model view registry catalogs structured prompt dependencies', async () => {
  const workflow = await definition();
  const references = structuredWorldModelViewReferences(workflow);
  assert.ok(references.get('architecture').includes("persona 'architect' prompt"));
  assert.ok(references.get('testing').includes("persona 'qa' prompt"));
  assert.deepEqual(worldModelViewCatalog(workflow), workflow.worldModel.views);
  assert.deepEqual(markdownWorldModelViews('Use views/security.md and `views/data-governance.md`; ignore https://example.test/view.md.'), ['data-governance', 'security']);
});

test('world-model view designer adds unused views and protects referenced views', async () => {
  const workflow = await definition();
  const added = addWorldModelView(workflow, 'data-governance');
  assert.ok(added.worldModel.views.includes('data-governance'));
  assert.ok(!workflow.worldModel.views.includes('data-governance'));
  assert.deepEqual(removeWorldModelView(added, 'data-governance').worldModel.views, workflow.worldModel.views);
  assert.throws(() => removeWorldModelView(workflow, 'architecture'), /still used by/);
  assert.throws(() => removeWorldModelView(added, 'data-governance', ["Markdown 'singularity/prompts/worldmodel-builder.md'"]), /Markdown/);
});

test('workflow validation rejects undeclared structured world-model views', async () => {
  const workflow = await definition();
  workflow.worldModel.views = workflow.worldModel.views.filter((view) => view !== 'architecture');
  assert.throws(() => validateDefinition(workflow), /architecture.*not declared/);
});
