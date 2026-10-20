import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertPackagedHelpCatalog } from '../scripts/packaged-vsix-engine-smoke.mjs';
import { parseHelpDocument } from '../src/help.mjs';

test('packaged Help smoke checks the entire current catalog rather than a historical topic label', async () => {
  const document = await readFile(new URL('../HELP.md', import.meta.url), 'utf8');
  assert.doesNotThrow(() => assertPackagedHelpCatalog(parseHelpDocument(document), document));
  const renamed = '# Product Help\n\n## Current capabilities\n\nSupported features.\n';
  assert.doesNotThrow(() => assertPackagedHelpCatalog(parseHelpDocument(renamed), renamed));
  assert.doesNotThrow(() => assertPackagedHelpCatalog(parseHelpDocument(renamed), renamed.replace(/\n/gu, '\r\n')));
});

test('a missing, stale, reordered or empty packaged Help topic cannot pass the smoke', () => {
  const document = '# Product Help\n\n## First\n\nOne.\n\n## Second\n\nTwo.\n';
  const candidate = () => parseHelpDocument(document);
  for (const mutate of [
    help => { help.title = 'Wrong title'; },
    help => { help.topics.pop(); },
    help => { help.topics.push({ id: 'extra', title: 'Extra', content: 'Unexpected.' }); },
    help => { help.topics.reverse(); },
    help => { help.topics[0].id = 'historical-topic'; },
    help => { help.topics[0].title = 'Wrong heading'; },
    help => { help.topics[0].content = '  '; }
  ]) {
    const help = candidate();
    mutate(help);
    assert.throws(() => assertPackagedHelpCatalog(help, document), /Help catalog does not match/u);
  }
  assert.throws(() => assertPackagedHelpCatalog(candidate(), ''), /Help catalog does not match/u);
});
