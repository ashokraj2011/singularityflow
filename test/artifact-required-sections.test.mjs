import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SPECIFICATION_REQUIRED_SECTIONS, addMissingSections, packagedSectionSource, packagedTemplateRefs,
  requiredArtifactSections, templateSectionGaps
} from '../src/artifact-required-sections.mjs';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { refreshPackagedConfiguration } from '../src/workspace-configuration-refresh.mjs';

const packaged = (ref) => readFile(new URL(`../templates/artifacts/${ref}`, import.meta.url), 'utf8');
const withoutSection = (text, heading) => {
  const start = text.indexOf(`## ${heading}`);
  return text.slice(0, start) + text.slice(text.indexOf('\n## ', start + 1) + 1);
};

async function initialized(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-required-sections-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'main');
  await initializeDefinition(root);
  git('add', '-A');
  git('-c', 'user.name=Sections Tester', '-c', 'user.email=sections@example.invalid', 'commit', '-qm', 'init');
  return root;
}

test('a phase is checked for its required headings, an enforced specification\'s sections, and required scenario coverage', () => {
  assert.deepEqual(requiredArtifactSections({ artifact: { validation: { requiredHeadings: ['Scope', '## Risks', 'scope'] } } }), ['Scope', 'Risks']);
  assert.deepEqual(requiredArtifactSections({ specificationQuality: { mode: 'off', scenarioCoverage: 'required' } }), ['Scenario coverage']);
  assert.deepEqual(requiredArtifactSections({ specificationQuality: { mode: 'enforce' } }), [...SPECIFICATION_REQUIRED_SECTIONS]);
  assert.deepEqual(requiredArtifactSections({ specificationQuality: { mode: 'warn', scenarioCoverage: 'required' } }),
    [...SPECIFICATION_REQUIRED_SECTIONS, 'Scenario coverage']);
  assert.deepEqual(requiredArtifactSections({}), []);
});

test('a missing section is copied from the packaged template, in its packaged place, with nothing else changed', async () => {
  const loop = await packaged('spec-code-test-loop/specification.md');
  const restored = addMissingSections(withoutSection(loop, 'Scenario coverage'), ['Scenario coverage'], { ownRef: 'spec-code-test-loop/specification.md' });
  assert.equal(restored.text, loop, 'byte for byte where the packaged template places it');
  assert.deepEqual(restored.added, [{ heading: 'Scenario coverage', source: 'templates/artifacts/spec-code-test-loop/specification.md' }]);
  const driven = await packaged('spec-driven/spec.md');
  const older = withoutSection(driven, 'Scenario coverage');
  const back = addMissingSections(older, ['Scenario coverage'], { ownRef: 'spec-driven/spec.md' }).text;
  const at = back.indexOf('## Scenario coverage');
  assert.equal(back.slice(0, at) + back.slice(back.indexOf('\n## ', at + 1) + 1), older, 'only the section is added');
  assert.equal(back, driven, 'its own packaged template supplies the section, so it lands where that template puts it');
  assert.equal(addMissingSections(loop, ['Scenario coverage', 'Actors']).text, loop, 'a document that has the sections is unchanged');
  const crlf = addMissingSections(withoutSection(loop, 'Scenario coverage').replaceAll('\n', '\r\n'), ['Scenario coverage'], { ownRef: 'spec-code-test-loop/specification.md' });
  assert.equal(crlf.text, loop.replaceAll('\n', '\r\n'), 'line endings are kept');
  const rendered = addMissingSections('# SPEC-9\n\n## Requirements\n\n- x\n', ['Scenario coverage'], { tokens: { '{{work.id}}': 'SPEC-9' } }).text;
  assert.match(rendered, /^\| `SPEC-9:REQ-001` \| S1 \| TODO \|$/mu, 'tokens are rendered into a copied section');
  assert.ok(rendered.indexOf('## Scenario coverage') > rendered.indexOf('## Requirements'));
  const generic = addMissingSections('# Report\n\n## Summary\n\nDone.\n', ['Team sign-off notes']).text;
  assert.match(generic, /## Team sign-off notes\n\nTODO\n/u, 'with no packaged source, a heading and a TODO the placeholder check refuses');
});

test('every section a packaged step is checked for has a packaged source, and every packaged template has its own', async (t) => {
  // The guard behind the fix: a new required section cannot ship without something to prepare.
  const root = await initialized(t);
  const definition = await loadDefinition(root);
  const refs = new Set(packagedTemplateRefs());
  let checked = 0;
  for (const workTypeId of Object.keys(definition.workTypes)) {
    for (const phase of resolveWorkType(definition, workTypeId).phases) {
      for (const heading of requiredArtifactSections(phase)) {
        checked += 1;
        assert.ok(packagedSectionSource(heading, phase.template), `${workTypeId}/${phase.id}: '${heading}' has no packaged source`);
        if (refs.has(phase.template)) {
          const own = await packaged(phase.template);
          assert.equal(addMissingSections(own, [heading], { ownRef: phase.template }).added.length, 0,
            `${workTypeId}/${phase.id}: packaged template ${phase.template} lacks '${heading}'`);
        }
      }
    }
  }
  assert.ok(checked > 10, `checked ${checked} required sections`);
  assert.deepEqual(await templateSectionGaps(root, definition), [], 'a fresh repository has no gaps');
});

test('an upgrade adds the missing sections to an edited template and keeps its wording; doctor names the gap first', async (t) => {
  const root = await initialized(t);
  const template = path.join(root, 'singularity', 'templates', 'spec-code-test-loop', 'specification.md');
  const current = await readFile(template, 'utf8');
  const edited = withoutSection(current, 'Scenario coverage').replace('## Actors', '## Actors\n\nOur team names every actor by role.');
  await writeFile(template, edited);
  const gaps = await templateSectionGaps(root, await loadDefinition(root));
  assert.deepEqual(gaps.map((gap) => [gap.path, gap.missing]), [['singularity/templates/spec-code-test-loop/specification.md', ['Scenario coverage']]]);

  const preview = await refreshPackagedConfiguration(root, { dryRun: true, restorePackagedSeeds: true });
  assert.deepEqual(preview.sectionMerges, [{ path: 'singularity/templates/spec-code-test-loop/specification.md', sections: ['Scenario coverage'] }]);
  assert.ok(preview.files.includes('singularity/templates/spec-code-test-loop/specification.md'));
  assert.ok(preview.conflicts.some((entry) => entry.path === 'singularity/templates/spec-code-test-loop/specification.md'
    && entry.resolution === 'preserved-local'), 'the edited template stays repository-owned');
  assert.equal(await readFile(template, 'utf8'), edited, 'a preview writes nothing');

  await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  const upgraded = await readFile(template, 'utf8');
  assert.match(upgraded, /Our team names every actor by role\./u, 'the edit is kept');
  assert.match(upgraded, /^## Scenario coverage$/mu);
  assert.ok(upgraded.indexOf('## Scenario coverage') < upgraded.indexOf('## Verification intent'));
  assert.deepEqual(await templateSectionGaps(root, await loadDefinition(root)), []);
  const again = await refreshPackagedConfiguration(root, { dryRun: true, restorePackagedSeeds: true });
  assert.equal(again.sectionMerges, undefined, 'nothing more to add');
});
