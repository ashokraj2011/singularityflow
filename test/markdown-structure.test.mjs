import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { parseMarkdownStructure } from '../src/markdown-structure.mjs';

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(absolute));
    else if (/\.(?:md|markdown)$/iu.test(entry.name)) files.push(absolute);
  }
  return files;
}

test('shared Markdown structure masks real comments but not comment text in code', () => {
  const source = [
    '# Artifact',
    '',
    '## Agent brief',
    '',
    '`<!-- inline example -->` remains authored text.',
    '',
    '```markdown',
    '<!-- fenced example -->',
    '## This is code, not a heading',
    '```',
    '',
    '<!-- closed authoring guidance -->',
    '## Requirements <!-- trailing comment -->',
    '',
    'Concrete requirement.',
    '<!-- unclosed guidance'
  ].join('\r\n');

  const parsed = parseMarkdownStructure(source);
  assert.equal(parsed.visibleText.length, source.length, 'comment masking changed source offsets');
  assert.deepEqual(
    [...parsed.visibleText].flatMap((character, index) => character === '\n' ? [index] : []),
    [...source].flatMap((character, index) => character === '\n' ? [index] : []),
    'comment masking changed line boundaries'
  );
  assert.deepEqual(parsed.headings.map((heading) => heading.normalized), [
    'artifact', 'agent brief', 'requirements'
  ]);
  assert.match(parsed.visibleText, /`<!-- inline example -->`/u);
  assert.match(parsed.visibleText, /<!-- fenced example -->/u);
  assert.doesNotMatch(parsed.visibleText, /closed authoring guidance/u);
  assert.deepEqual(parsed.unclosedComments.map(({ line }) => line), [16]);

  const edgeCases = parseMarkdownStructure([
    '` unmatched backtick <!-- this is still a real comment',
    'and closes here --> visible',
    'before <!-- first --> middle <!-- second --> after'
  ].join('\n'));
  assert.equal(edgeCases.comments.length, 3);
  assert.deepEqual(edgeCases.unclosedComments, []);
  assert.doesNotMatch(edgeCases.visibleText, /this is still a real comment|first|second/u);
  assert.match(edgeCases.visibleText, /` unmatched backtick|visible|before|middle|after/u);
});

test('every shipped Markdown artifact template has balanced structural comments', async () => {
  const templateRoot = path.resolve('templates/artifacts');
  const files = await markdownFiles(templateRoot);
  assert.ok(files.length >= 20, 'artifact template inventory unexpectedly shrank');

  const specDriven = new Set([
    'spec-driven/spec.md',
    'spec-driven/plan.md',
    'common/implementation.md',
    'spec-driven/convergence.md',
    'common/verification.md',
    'spec-driven/release.md'
  ]);
  const visitedSpecDriven = new Set();
  for (const file of files) {
    const relative = path.relative(templateRoot, file).split(path.sep).join('/');
    const parsed = parseMarkdownStructure(await readFile(file, 'utf8'));
    assert.deepEqual(parsed.unclosedComments, [], `${relative} contains an unclosed HTML comment`);
    if (specDriven.has(relative)) visitedSpecDriven.add(relative);
  }
  assert.deepEqual(visitedSpecDriven, specDriven, 'the six Spec-Driven phase templates were not all audited');
});
