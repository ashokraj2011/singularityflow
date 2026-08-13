/**
 * Templates as named things, independent of the phases that use them.
 *
 * A template used to exist only as a path written inside a phase record, which meant it had no
 * identity: two phases sharing one template shared a string, renaming meant editing every phase
 * that mentioned it, and a template could carry no label or kind of its own.
 *
 * The property that matters most here is not the new capability but the old one surviving. Every
 * existing repository names templates by path, and a catalog that forced them to be rewritten would
 * be a tax rather than a feature — so the path form is tested as carefully as the reference form.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import {
  isTemplateReference, normalizeTemplateCatalog, parseTemplateReference, resolveTemplate,
  templatePath, templateReferences
} from '../src/template-catalog.mjs';

async function shipped() {
  return YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
}

test('a template is declared once and referenced by name', async () => {
  const definition = await shipped();
  definition.templates = {
    'intake-standard': { path: 'common/intake.md', label: 'Standard intake', kind: 'intake' }
  };
  // Both places a template can be named: the phase's default, and a work type's override.
  definition.phases.requirements.defaultTemplate = 'template:intake-standard';
  delete definition.workTypes.feature.templateOverrides?.requirements;
  definition.workTypes.feature.templateOverrides = {
    ...(definition.workTypes.feature.templateOverrides ?? {}), intake: 'template:intake-standard'
  };
  validateDefinition(definition);

  // What every downstream reader receives is a path, so none of them has to know which form was
  // written — that is the whole point of resolving in one place.
  const phases = resolveWorkType(definition, 'feature').phases;
  for (const id of ['intake', 'requirements']) {
    assert.equal(phases.find((phase) => phase.id === id)?.template, 'common/intake.md',
      `${id} did not resolve its catalog reference to a path`);
  }
});

test('the path form keeps working, unchanged and unwarned', async () => {
  /**
   * The shipped configuration names every template by path and declares no catalog at all. If that
   * stopped validating, the catalog would be a breaking change disguised as an addition.
   */
  const definition = await shipped();
  assert.equal(definition.templates, undefined, 'the shipped configuration now declares a catalog; this test no longer proves anything');
  validateDefinition(definition);
  const intake = resolveWorkType(definition, 'feature').phases.find((phase) => phase.id === 'intake');
  assert.match(String(intake.template), /\.md$/, 'a path-named template stopped resolving to a path');

  // And resolution reports which form it saw, so a surface can tell a named template from a path.
  assert.deepEqual(resolveTemplate({}, 'common/intake.md'), {
    source: 'path', id: null, path: 'common/intake.md', label: 'common/intake.md', kind: null
  });
  assert.equal(templatePath({}, 'common/intake.md'), 'common/intake.md');
  assert.equal(resolveTemplate({}, null), null);
});

test('an agent template stays the agent module’s business', () => {
  // Resolving it needs the network and a locked digest, which a configuration read must not
  // trigger. It is recognised and handed back, not resolved.
  const resolved = resolveTemplate({}, 'agent:architect/design');
  assert.equal(resolved.source, 'agent');
  assert.equal(resolved.path, null, 'an agent template was resolved to a path without its digest');
  assert.equal(resolved.reference, 'agent:architect/design');
});

test('a reference to a template nobody declared fails, and says what is declared', () => {
  const definition = { templates: { 'a-template': { path: 'x.md', label: 'a-template', kind: null, description: null } } };
  assert.throws(() => resolveTemplate(definition, 'template:missing', { label: "Phase 'x' defaultTemplate" }), (error) => {
    assert.equal(error.code, 'TEMPLATE_UNKNOWN');
    assert.match(error.message, /Phase 'x' defaultTemplate references template 'missing'/);
    assert.match(error.message, /Declared: a-template/, 'the refusal does not say what is available');
    return true;
  });
  // An empty catalog says so rather than printing an empty list.
  assert.throws(() => resolveTemplate({}, 'template:missing'), /No templates are declared/);
});

test('the catalog refuses shapes it cannot honour', () => {
  assert.equal(isTemplateReference('template:a-b'), true);
  assert.equal(isTemplateReference('common/intake.md'), false);
  assert.equal(parseTemplateReference('template:intake-standard'), 'intake-standard');
  assert.throws(() => parseTemplateReference('template:Not_Kebab'), /lower-case kebab-case/);

  assert.deepEqual(normalizeTemplateCatalog(null), {});
  // The string form is the short way to say the same thing.
  assert.equal(normalizeTemplateCatalog({ a: 'x.md' }).a.path, 'x.md');
  assert.equal(normalizeTemplateCatalog({ a: 'x.md' }).a.label, 'a', 'a template with no label is labelled by its id');

  assert.throws(() => normalizeTemplateCatalog({ 'Bad Id': 'x.md' }), /lower-case kebab-case/);
  assert.throws(() => normalizeTemplateCatalog({ a: { path: '../escape.md' } }), /without '\.\.'/);
  assert.throws(() => normalizeTemplateCatalog({ a: { path: 'x.md', colour: 'red' } }), /unknown field 'colour'/);
  assert.throws(() => normalizeTemplateCatalog({ a: {} }), /path must be a repository-relative path/);
});

test('deleting a template still in use is refused however it was named', () => {
  /**
   * The guard compared paths, which was complete while a path was the only form. With the catalog,
   * a phase naming `template:intake-standard` would have matched nothing — and the designer would
   * have deleted a template that four phases were still rendering from.
   */
  const definition = {
    templates: { 'intake-standard': { path: 'common/intake.md' } },
    phases: { intake: { defaultTemplate: 'template:intake-standard' }, other: { defaultTemplate: 'common/other.md' } },
    workTypes: { feature: { templateOverrides: { design: 'template:intake-standard', spec: 'common/other.md' } } }
  };
  assert.deepEqual(templateReferences(definition, 'common/intake.md'), ['phase intake', 'workflow feature/design']);
  assert.deepEqual(templateReferences(definition, 'common/other.md'), ['phase other', 'workflow feature/spec']);
  assert.deepEqual(templateReferences(definition, 'common/unused.md'), []);
});

test('the editor asks the one resolver rather than comparing strings itself', async () => {
  // Asserted structurally: a second implementation of "what references this template" is how the
  // designer and the kernel end up disagreeing about whether a file is safe to delete.
  const editor = (await readFile(new URL('../src/editor.mjs', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(editor, /templateReferences\(definition, template\)/);
  assert.ok(!editor.includes('phase.defaultTemplate === template'),
    'the editor still compares template paths itself');
});
