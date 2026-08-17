import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  PROFILE_PERSONAS, PROFILE_PERSONA_IDS, isProfilePersonaId, resolveProfilePersona
} = await import(path.join(root, 'apps/vscode/src/views/profile-personas.ts'));

const SECTIONS = ['favorites', 'inbox', 'workspaces', 'lifecycle', 'configuration', 'help', 'logs'];

test('menu personas are complete, stable, and navigation-only', () => {
  assert.equal(PROFILE_PERSONAS.length, PROFILE_PERSONA_IDS.length);
  assert.equal(new Set(PROFILE_PERSONAS.map((persona) => persona.id)).size, PROFILE_PERSONAS.length);
  assert.ok(PROFILE_PERSONAS.some((persona) => persona.id === 'developer'));
  assert.ok(PROFILE_PERSONAS.some((persona) => persona.id === 'architect'));
  assert.ok(PROFILE_PERSONAS.some((persona) => persona.id === 'qa'));
  assert.ok(PROFILE_PERSONAS.some((persona) => persona.id === 'admin'));

  for (const persona of PROFILE_PERSONAS) {
    assert.ok(persona.label);
    assert.ok(persona.description);
    assert.ok(persona.menuIds.length >= 3);
    assert.deepEqual([...new Set(persona.sectionOrder)].sort(), [...SECTIONS].sort(),
      `${persona.id} keeps every Navigator section`);
  }

  assert.equal(isProfilePersonaId('qa'), true);
  assert.equal(isProfilePersonaId('release-wizard'), false);
  assert.equal(resolveProfilePersona('architect').label, 'Architect');
  assert.equal(resolveProfilePersona('not-configured').id, 'other');
});

test('each principal persona receives relevant first-use menu suggestions', () => {
  assert.deepEqual(resolveProfilePersona('developer').menuIds,
    ['my-work', 'work-start', 'impact-form', 'logs-open']);
  assert.deepEqual(resolveProfilePersona('architect').menuIds,
    ['my-work', 'impact-form', 'flow-impact', 'configuration-center']);
  assert.deepEqual(resolveProfilePersona('qa').menuIds,
    ['my-work', 'inbox-open', 'visual-assurance', 'approvals-open']);
  assert.deepEqual(resolveProfilePersona('admin').menuIds,
    ['workspace-manage', 'configuration-center', 'capability-map', 'logs-open']);
  assert.deepEqual(resolveProfilePersona('product-owner').menuIds,
    ['my-work', 'work-start', 'inbox-open', 'approvals-open']);
});

test('the public VS Code setting and command palette expose every menu persona', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'apps/vscode/package.json'), 'utf8'));
  const configured = manifest.contributes.configuration.properties['singularityFlow.role'].enum;
  assert.deepEqual(configured, ['', ...PROFILE_PERSONA_IDS]);
  assert.ok(manifest.contributes.commands.some((entry) =>
    entry.command === 'singularityFlow.choosePersona' && entry.title.includes('Choose Menu Persona')));
});
