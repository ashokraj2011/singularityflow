import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDefinition, resolveWorkType, validateAgentBriefHeadingContracts,
  validateCapturedAgentBriefHeadingContracts, validateArtifactTemplateText, renderArtifactTemplate,
  validateWorldModelPromptReferences } from '../src/config.mjs';
import { normalizeTemplateCatalog, resolveTemplate } from '../src/template-catalog.mjs';

function definition() {
  const phase = (id) => ({ label: id, artifact: { path: `artifacts/${id}.md` }, inputs: [], defaultTemplate: 'template:shared', approval: { mode: 'none' }, generation: { task: 'analyze' } });
  const value = { version: 2, templatesRoot: 'singularity/templates', templates: { shared: 'common/shared.md' },
    phases: { intake: phase('intake'), review: phase('review') }, workTypes: { main: { label: 'Main', phases: ['intake', 'review'] } },
    approvalSecurity: { profile: 'team' }, harnessImports: { mode: 'record' }, worldModel: { views: ['arch.contracts@4'] } };
  value.phases.review.inputs = [{ phase: 'intake', projection: 'approved-summary', preserve: ['Findings'] }];
  return validateDefinition(value);
}

test('historical raw string, normalized row and raw object template references resolve to the same path', () => {
  const raw = { templates: { alias: 'common/shared.md' } };
  assert.equal(resolveTemplate(raw, 'template:alias').path, 'common/shared.md');
  assert.deepEqual(resolveTemplate(raw, 'template:alias'), resolveTemplate({ templates: normalizeTemplateCatalog(raw.templates) }, 'template:alias'));
  assert.equal(resolveTemplate({ templates: { alias: { path: 'common/shared.md' } } }, 'template:alias').path, 'common/shared.md');
  assert.throws(() => resolveTemplate({ templates: {} }, 'template:constructor'), { code: 'TEMPLATE_UNKNOWN' });
  assert.equal(resolveTemplate({ templates: { constructor: 'common/shared.md' } }, 'template:constructor').path, 'common/shared.md');
  assert.equal(resolveWorkType(definition(), 'main').phases[0].template, 'common/shared.md');
});

test('pure captured preserved-heading checks share exact error semantics with the existing file owner', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wca-text-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const relative = 'singularity/templates/common/shared.md'; await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  const config = definition();
  for (const [content, code] of [['# Note\n## Findings\nExact source.\n', null], ['# Missing\n', 'AGENT_BRIEF_PRESERVE_HEADING_MISSING'],
    ['# Note\n## Findings\n## Findings\n', 'AGENT_BRIEF_PRESERVE_HEADING_AMBIGUOUS'], ['# Note\n<!-- unclosed\n## Findings\n', 'TEMPLATE_COMMENT_UNCLOSED']]) {
    await writeFile(path.join(root, relative), content);
    if (!code) { await validateAgentBriefHeadingContracts(root, config); validateCapturedAgentBriefHeadingContracts(config, new Map([[relative, content]])); }
    else {
      await assert.rejects(validateAgentBriefHeadingContracts(root, config), { code });
      assert.throws(() => validateCapturedAgentBriefHeadingContracts(config, new Map([[relative, content]])), { code });
    }
  }
  assert.throws(() => validateCapturedAgentBriefHeadingContracts(config, new Map()), { code: 'WCA_CONTENT_UNRESOLVED' });
});

test('pure token admission preserves renderer compatibility and refuses unsupported tokens', async () => {
  const config = definition(); const phase = resolveWorkType(config, 'main').phases[0];
  for (const sourceText of ['# {{work.id}} {{work.title}} {{phase.id}} {{phase.label}} {{work.type}} {{inputs}}\n', '# Legacy {{WORK_ID}}\n']) {
    assert.equal(validateArtifactTemplateText(sourceText, { id: 'WORK-1' }).includes('{{WORK_ID}}'), false);
    const sha256 = createHash('sha256').update(sourceText).digest('hex');
    const actual = await renderArtifactTemplate('/unused-private-fixture', config, phase, { id: 'WORK-1', title: 'Exact', workType: 'main', inputs: 'Approved',
      templateSnapshot: { sha256 }, retainedTemplate: { logicalId: 'template:intake', sha256, bytes: Buffer.byteLength(sourceText), text: sourceText } });
    assert.equal(actual.includes('{{'), false);
  }
  const bad = '# {{native.command}}\n'; assert.throws(() => validateArtifactTemplateText(bad), /unsupported token/);
  const sha256 = createHash('sha256').update(bad).digest('hex');
  await assert.rejects(renderArtifactTemplate('/unused-private-fixture', config, phase, { templateSnapshot: { sha256 },
    retainedTemplate: { logicalId: 'template:intake', sha256, bytes: Buffer.byteLength(bad), text: bad } }), /unsupported token/);
});

test('captured prompt references obey the same declared view owner without creating permission', () => {
  const config = definition(); const references = new Map([['arch.contracts', ['exact-template.md']]]);
  assert.equal(validateWorldModelPromptReferences(config, references), references);
  assert.throws(() => validateWorldModelPromptReferences(config, new Map([['unapproved', ['exact-template.md']]])), /not declared/);
});
