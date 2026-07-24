import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_SECTION_LIBRARY,
  addArtifactSection,
  moveArtifactSection,
  parseArtifactTemplate,
  removeArtifactSection,
  serializeArtifactTemplate,
  updateArtifactSection
} from '../apps/desktop/src/artifact-builder.mjs';

test('artifact builder parses governed Markdown into an editable preamble and ordered sections', () => {
  const source = [
    '---',
    'owner: "{{generator.identity}}"',
    '---',
    '',
    '# {{work.id}} — {{phase.label}}',
    '',
    '## Executive summary',
    '',
    'Explain the outcome.',
    '',
    '## Approved inputs',
    '',
    '{{inputs}}',
    '',
    '## Organization-specific section',
    '',
    '| Field | Value |',
    '| --- | --- |',
    '| Team | Mobile |',
    ''
  ].join('\n');
  const parsed = parseArtifactTemplate(source);
  assert.match(parsed.preamble, /owner: "\{\{generator\.identity\}\}"/);
  assert.match(parsed.preamble, /# \{\{work\.id\}\} — \{\{phase\.label\}\}/);
  assert.deepEqual(parsed.sections.map((section) => section.type), ['summary', 'inputs', 'custom']);
  assert.equal(parsed.sections[2].title, 'Organization-specific section');
  assert.match(parsed.sections[2].body, /\| Team \| Mobile \|/);
  assert.equal(serializeArtifactTemplate(parsed), source);
});

test('artifact builder keeps level-two headings inside fenced examples in their parent section', () => {
  const source = '# Example\n\n## Guidance\n\n```markdown\n## This is an example, not a section\n```\n\nContinue here.\n';
  const parsed = parseArtifactTemplate(source);
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].title, 'Guidance');
  assert.match(parsed.sections[0].body, /## This is an example, not a section/);
  assert.equal(serializeArtifactTemplate(parsed), source);
});

test('artifact builder adds, edits, reorders, and removes reusable sections as standard Markdown', () => {
  let document = parseArtifactTemplate('# {{work.id}} — {{phase.label}}\n');
  document = addArtifactSection(document, 'requirements');
  document = addArtifactSection(document, 'risks');
  document = addArtifactSection(document, 'approvals', 1);
  assert.deepEqual(document.sections.map((section) => section.type), ['requirements', 'approvals', 'risks']);

  document = updateArtifactSection(document, document.sections[1].id, {
    title: 'Product approval',
    body: '| Reviewer | Decision |\n| --- | --- |\n| Product owner | Pending |'
  });
  document = moveArtifactSection(document, document.sections[2].id, 0);
  assert.deepEqual(document.sections.map((section) => section.type), ['risks', 'requirements', 'approvals']);

  document = removeArtifactSection(document, document.sections[1].id);
  const markdown = serializeArtifactTemplate(document);
  assert.match(markdown, /^# \{\{work\.id\}\} — \{\{phase\.label\}\}/);
  assert.match(markdown, /## Risks and controls/);
  assert.doesNotMatch(markdown, /## Requirements and acceptance criteria/);
  assert.match(markdown, /## Product approval/);
});

test('artifact section library provides business, traceability, solution, and assurance building blocks', () => {
  const groups = new Set(ARTIFACT_SECTION_LIBRARY.map((section) => section.group));
  assert.deepEqual([...groups], ['Business content', 'Traceability', 'Solution', 'Assurance', 'Flexible']);
  assert.ok(ARTIFACT_SECTION_LIBRARY.some((section) => section.body.includes('{{inputs}}')));
  assert.throws(
    () => addArtifactSection({ preamble: '', sections: [] }, 'not-a-section'),
    /Unknown artifact section type/
  );
});
