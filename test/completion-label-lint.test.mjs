import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMPLETION_LABELS, lifecycleWords } from '../src/evidence/labels.mjs';
import { MESSAGES } from '../src/narration/messages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A Story whose steps are all decided is closed, not complete: "Complete" is only ever the label of
// a final evaluation [D17]. These phrases would call it complete from its lifecycle alone.
const BANNED = Object.freeze([
  /\b(?:story|workflow|work item)\s+(?:is\s+|was\s+)?(?:now\s+)?complete\b/i,
  /\bcompleted\s+(?:story|work item)\b/i,
  /\bstory\s+completed\b/i,
  /✓\s*(?:story|workflow)\s+complete/i
]);
// The labels module is where completion is named.
const ALLOWED = new Set(['src/evidence/labels.mjs']);

async function sources(relative, extension) {
  const found = [];
  for (const entry of await readdir(path.join(ROOT, relative), { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await sources(child, extension));
    else if (entry.name.endsWith(extension)) found.push(child);
  }
  return found;
}

/** The lines people read: comments say what the code means to itself and are left out. */
function readableLines(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line, index) => ({ line: line.replace(/^\s*\/\/.*$/, ''), number: index + 1 }));
}

test('no product text calls a Story complete from its lifecycle alone', async () => {
  const files = [...await sources('src', '.mjs'), ...await sources('apps/vscode/src', '.ts')];
  assert.ok(files.length > 100, 'the lint reads the product sources');
  const offences = [];
  for (const file of files) {
    if (ALLOWED.has(file)) continue;
    for (const { line, number } of readableLines(await readFile(path.join(ROOT, file), 'utf8'))) {
      const match = BANNED.find((pattern) => pattern.test(line));
      if (match) offences.push(`${file}:${number}: ${line.trim().slice(0, 160)}`);
    }
  }
  assert.deepEqual(offences, [], 'say closed, every step decided, or name the evidence label instead');
});

test('the lifecycle has words for a closed Story, and only the labels name completion', () => {
  assert.equal(lifecycleWords({ status: 'closed', currentPhase: null }), 'Every step decided');
  assert.notEqual(lifecycleWords({ status: 'complete', currentPhase: null }), 'Every step decided',
    'the old state name is not read as a closed Story');
  assert.deepEqual(Object.values(COMPLETION_LABELS).filter((label) => /^Complete/.test(label)),
    ['Complete', 'Complete with accepted exceptions']);
  const approve = MESSAGES['approve.succeeded'].headline;
  assert.match(approve({ phase: 'release', next: null, finalCheck: 'passed', completionLabel: COMPLETION_LABELS.completeWithExceptions }),
    /: Complete with accepted exceptions\.$/);
  for (const [id, message] of Object.entries(MESSAGES)) {
    const text = message.headline({ phase: 'release', next: null, documents: 1, decision: 'stop', route: 'finish', kind: 'end', target: null });
    for (const pattern of BANNED) assert.doesNotMatch(String(text ?? ''), pattern, id);
  }
});
