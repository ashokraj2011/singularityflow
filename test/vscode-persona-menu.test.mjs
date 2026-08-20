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
    assert.equal(persona.menuIds[0], 'setup-wizard',
      `${persona.id} starts first-use Favorites with Guided start`);
    assert.ok(persona.menuIds.includes('capability-map'),
      `${persona.id} keeps Map a capability in first-use Favorites`);
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
    ['setup-wizard', 'my-work', 'work-start', 'journal', 'diagnostics', 'logs-open', 'capability-map']);
  assert.deepEqual(resolveProfilePersona('architect').menuIds,
    ['setup-wizard', 'my-work', 'impact-form', 'flow-impact', 'configuration-center', 'ast-intelligence', 'capability-map']);
  assert.deepEqual(resolveProfilePersona('qa').menuIds,
    ['setup-wizard', 'my-work', 'fault-repairs', 'inbox-open', 'visual-assurance', 'approvals-open', 'capability-map']);
  assert.deepEqual(resolveProfilePersona('admin').menuIds,
    ['setup-wizard', 'workspace-manage', 'local-reset', 'configuration-center', 'ast-intelligence', 'capability-map', 'diagnostics']);
  assert.deepEqual(resolveProfilePersona('product-owner').menuIds,
    ['setup-wizard', 'my-work', 'goals', 'work-start', 'inbox-open', 'approvals-open', 'capability-map']);
});

test('the public VS Code setting and command palette expose every menu persona', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'apps/vscode/package.json'), 'utf8'));
  const configured = manifest.contributes.configuration.properties['singularityFlow.role'].enum;
  assert.deepEqual(configured, ['', ...PROFILE_PERSONA_IDS]);
  assert.ok(manifest.contributes.commands.some((entry) =>
    entry.command === 'singularityFlow.choosePersona' && entry.title.includes('Choose Menu Persona')));
  assert.ok(manifest.contributes.commands.some((entry) =>
    entry.command === 'singularityFlow.startWizard' && entry.title.includes('Capability, Workspace, Work')),
  'the complete first-use journey is available from the Command Palette');
});
