import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildManifest, loadTopics } from '../src/docs-topics.mjs';
import { resolveHelp } from '../src/help-service.mjs';

const topic = (body = 'Reviewed answer bytes.') => `---
id: sample-topic
title: Sample topic
aliases:
  - sample
questions:
  - What is the sample topic?
commands:
  - help
version: 1
---
${body}
`;

test('the resolver refuses a topic tree that moved after its manifest was stamped', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-catalog-'));
  const file = path.join(directory, 'sample-topic.md');
  await writeFile(file, topic());
  const manifest = buildManifest(await loadTopics(directory));
  await writeFile(file, topic('Changed after stamping.'));
  await assert.rejects(resolveHelp('sample', { topicsDirectory: directory, manifest }), (error) => {
    assert.equal(error.code, 'DOCS_MANIFEST_MISMATCH');
    return true;
  });
});

test('the resolver refuses missing and escaped manifest resources', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-catalog-'));
  await writeFile(path.join(directory, 'sample-topic.md'), topic());
  await assert.rejects(resolveHelp('sample', { topicsDirectory: directory, manifest: null }), (error) => {
    assert.equal(error.code, 'DOCS_MANIFEST_MISSING');
    return true;
  });
  const manifest = buildManifest(await loadTopics(directory));
  manifest.topics[0].file = '../sample-topic.md';
  await assert.rejects(resolveHelp('sample', { topicsDirectory: directory, manifest }), (error) => {
    assert.equal(error.code, 'DOCS_MANIFEST_MISMATCH');
    return true;
  });
});
