/**
 * Template guidance (src/template-guidance.mjs): one line per paragraph, marked so publication
 * removes it, and never counted as the document's content.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { inspectArtifactContent } from '../src/publication-preflight.mjs';
import { extractClauses } from '../src/specifications.mjs';
import { newStepTemplate } from '../src/step-outputs.mjs';
import { markTemplateGuidance, stripTemplateGuidance, templateGuidanceComments } from '../src/template-guidance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'templates', 'artifacts');

async function markdownFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await markdownFiles(target));
    else if (entry.name.endsWith('.md')) found.push(target);
  }
  return found.sort();
}

/** The templates an author (person or agent) writes from: every packaged step but a deterministic one. */
async function authoredStepTemplates() {
  const definition = validateDefinition(YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8')));
  const templates = new Set();
  for (const id of Object.keys(definition.workTypes)) {
    for (const phase of resolveWorkType(definition, id).phases) {
      if (phase.template && phase.generation?.producer !== 'deterministic') templates.add(phase.template);
    }
  }
  return [...templates].sort();
}

/**
 * The context matching of an apply_patch-style edit: each quoted line must equal a file line, in
 * order, ignoring surrounding whitespace. An agent quotes a paragraph as one line.
 */
function patchContextMatches(text, quoted) {
  const lines = text.split('\n').map((line) => line.trim());
  const wanted = quoted.map((line) => line.trim());
  return lines.some((_, start) => wanted.every((line, offset) => lines[start + offset] === line));
}

test('publication form: guidance leaves with its lines, everything the author wrote keeps its bytes', () => {
  const draft = [
    '# Spec', '',
    '<!-- sflow:guidance Keep every section. -->', '',
    '## Actors', '',
    '<!-- sflow:guidance Who uses this, and what authority does each hold? -->', '',
    'An operator with the payments role.', '',
    '<!-- sflow:guidance', 'Use this syntax:', '', '    [NEEDS CLARIFICATION: <one question>]', '-->', '',
    'Inline <!-- sflow:guidance not this --> stays.', '',
    '<!-- the author\'s own note stays -->', '',
    '```text', '<!-- sflow:guidance a documented example in code stays -->', '```', ''
  ].join('\n');
  const { text, removed } = stripTemplateGuidance(draft);
  assert.equal(removed, 4);
  assert.equal(text, [
    '# Spec', '',
    '## Actors', '',
    'An operator with the payments role.', '',
    'Inline stays.', '',
    '<!-- the author\'s own note stays -->', '',
    '```text', '<!-- sflow:guidance a documented example in code stays -->', '```', ''
  ].join('\n'));
  // A Windows checkout keeps its line endings; a document without guidance is returned as it is.
  assert.equal(stripTemplateGuidance(draft.replaceAll('\n', '\r\n')).text, text.replaceAll('\n', '\r\n'));
  assert.deepEqual(stripTemplateGuidance(text), { text, removed: 0 });
  // An unclosed comment is the author's to close (artifact.comment.unclosed), never silently eaten.
  const unclosed = '# Spec\n\n<!-- sflow:guidance never closed\n\nBody.\n';
  assert.deepEqual(stripTemplateGuidance(unclosed), { text: unclosed, removed: 0 });
  assert.equal(templateGuidanceComments('<!--sflow:guidance-->\n<!-- sflow:guidanceX -->').length, 1);
});

test('one line per paragraph: wrapped guidance is joined and marked, author slots and fields are not guidance', () => {
  const template = [
    '# Spec', '',
    'What this specification takes as true without proving. An assumption that turns out false',
    'is a change request, not a defect.', '',
    '<!-- Before drafting, split the request into obligations',
    'for the actual interfaces. -->', '',
    '<!-- [{{work.id}}:REQ-001] a commented-out clause is not guidance -->', '',
    'TODO: Explain how each clause will be proved, one row',
    'per clause.', '',
    '**Status.** Proposed / accepted /',
    'superseded.', '',
    '- <requirement>. [{{work.id}}:REQ-001]', '',
    'The capability solves TODO for TODO. [{{work.id}}:REQ-002]', '',
    'None.', ''
  ].join('\n');
  const { text, changes } = markTemplateGuidance(template);
  assert.equal(text, [
    '# Spec', '',
    '<!-- sflow:guidance What this specification takes as true without proving. An assumption that turns out false is a change request, not a defect. -->', '',
    '<!-- sflow:guidance Before drafting, split the request into obligations for the actual interfaces. -->', '',
    '<!-- [{{work.id}}:REQ-001] a commented-out clause is not guidance -->', '',
    'TODO: Explain how each clause will be proved, one row per clause.', '',
    '**Status.** Proposed / accepted / superseded.', '',
    '- <requirement>. [{{work.id}}:REQ-001]', '',
    'The capability solves TODO for TODO. [{{work.id}}:REQ-002]', '',
    'None.', ''
  ].join('\n'));
  assert.deepEqual(changes.map(({ line, endLine, kind }) => [line, endLine, kind]),
    [[3, 4, 'unmarked'], [6, 7, 'unmarked'], [11, 12, 'wrapped'], [14, 15, 'wrapped']]);
  assert.deepEqual(markTemplateGuidance(text).changes, [], 'marking twice changes nothing more');
  // A template no author writes (a deterministic step's) is only joined.
  assert.equal(markTemplateGuidance('# T\n\nA kernel-written line\nthat wraps.\n', { mark: false }).text, '# T\n\nA kernel-written line that wraps.\n');
});
