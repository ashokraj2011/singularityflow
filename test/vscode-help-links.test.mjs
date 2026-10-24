import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { loadTopics } from '../src/docs-topics.mjs';
import { loadHelpDocument } from '../src/help.mjs';
import { resolveHelpLink } from '../src/help-service.mjs';
import { HELP_CENTER_SCRIPT, helpCenterHtml, renderHelpMarkdown } from '../apps/vscode/src/views/help-page.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

test('every relative link in every served topic resolves from its exact source, including all ten regressions', async () => {
  const topics = await loadTopics();
  const visited = [];
  for (const topic of topics) {
    const source = { file: `docs/topics/${topic.file}`, content: topic.body };
    for (const [, target] of topic.body.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/gu)) {
      if (/^[a-z][a-z0-9+.-]*:|^#/iu.test(target)) continue;
      const result = await resolveHelpLink(root, source.file, target, [source]);
      const expected = await realpath(path.resolve(root, 'docs/topics', target));
      assert.deepEqual(result, { kind: 'file', file: expected }, `${topic.id}: ${target}`);
      visited.push(`${topic.id}:${target}`);
    }
  }
  for (const expected of [
    'ad-hoc-work:../../README-AD-HOC-WORK.md',
    'capability-management:test-recovery.md', 'capability-management:configuration.md',
    'capability-management:../CAPABILITY-MAP-GIT-ROBUSTNESS-PLAN.md',
    'code-explanation:../CODE-EXPLANATION.md', 'configuration:../CONFIGURATION-STATE-SERVICE.md',
    'help-and-docs:../CPT-CHAT-PARTICIPANT.md', 'sgos-governed-execution:../SGOS-USAGE-GUIDE.md',
    'workflow-authoring:../WORKFLOW-REWORK-LOOPS.md', 'world-model:../KNOWLEDGE-MODEL.md'
  ]) assert.ok(visited.includes(expected), `the current catalog must exercise ${expected}`);
});

test('legacy manual sections keep their HELP.md base and all their relative links work', async () => {
  const manual = await loadHelpDocument();
  const sources = manual.topics.map((topic) => ({ file: 'HELP.md', content: topic.content }));
  let checked = 0;
  for (const topic of manual.topics) {
    for (const [, target] of topic.content.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/gu)) {
      if (/^[a-z][a-z0-9+.-]*:|^#/iu.test(target)) continue;
      const result = await resolveHelpLink(root, 'HELP.md', target, sources);
      assert.deepEqual(result, { kind: 'file', file: await realpath(path.resolve(root, target)) });
      checked += 1;
    }
  }
  assert.ok(checked >= 10, 'the test must cover real manual links, not an empty catalog');
});

test('rendered topics and natural-language answers retain independent source files', () => {
  const html = helpCenterHtml({ schemaVersion: 1, title: 'Help', content: '', topics: [
    { id: 'manual', title: 'Manual', content: '[Overview](docs/EXECUTION-CONTEXT.md)' },
    { id: 'served', title: 'Served', sourceFile: 'docs/topics/capability-management.md', content: '[Tests](test-recovery.md)' }
  ] }, 'served', {
    status: 'resolved', question: 'Configuration?', intent: 'concept', matchedBy: 'id',
    topic: { id: 'configuration', title: 'Configuration', file: 'configuration.md' },
    content: '[State](../CONFIGURATION-STATE-SERVICE.md)', citation: 'Reviewed topic',
    candidates: [], related: [], handoff: null
  });
  for (const [target, source] of [
    ['docs/EXECUTION-CONTEXT.md', 'HELP.md'], ['test-recovery.md', 'docs/topics/capability-management.md'],
    ['../CONFIGURATION-STATE-SERVICE.md', 'docs/topics/configuration.md']
  ]) assert.ok(html.includes(`data-link="${target}" data-help-source="${source}"`));
  const text = renderHelpMarkdown('## [Heading](a.md)\n\n[Paragraph](b.md)\n\n- [List](c.md)\n\n> [Quote](d.md)\n\n| Header |\n| --- |\n| [Table](e.md) |', 'docs/topics/origin.md');
  assert.equal(text.match(/data-help-source="docs\/topics\/origin.md"/gu)?.length, 5);
});

test('click, Enter and Space send the source belonging to the clicked link', () => {
  const listeners = {}, sent = [];
  const link = { dataset: { link: 'test-recovery.md', helpSource: 'docs/topics/capability-management.md' },
    addEventListener: (name, callback) => { listeners[name] = callback; } };
  runInNewContext(HELP_CENTER_SCRIPT, {
    window: { __sfVscode: { postMessage: (message) => sent.push(JSON.parse(JSON.stringify(message))) } },
    document: { querySelector: () => null, querySelectorAll: (selector) => selector === '[data-link]' ? [link] : [],
      addEventListener() {} }
  });
  listeners.click(); listeners.keydown({ key: 'Enter' }); listeners.keydown({ key: ' ' });
  listeners.keydown({ key: 'Escape' });
  assert.equal(sent.length, 3);
  for (const message of sent) assert.deepEqual(message, {
    type: 'open-link', source: 'docs/topics/capability-management.md', target: 'test-recovery.md'
  });
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-links-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageRoot = path.join(directory, 'package with spaces');
  await mkdir(path.join(packageRoot, 'docs/topics'), { recursive: true });
  await writeFile(path.join(packageRoot, 'docs/topics/source.md'), 'Source');
  await writeFile(path.join(packageRoot, 'docs/linked document.md'), 'Linked');
  return { directory, packageRoot };
}

test('encoded spaces and fragments resolve without confusing package-relative and topic-relative links', async (t) => {
  const { packageRoot } = await fixture(t);
  const file = 'docs/topics/source.md', target = '../linked%20document.md#details';
  assert.deepEqual(await resolveHelpLink(packageRoot, file, target, [{ file, content: `[Document](${target})` }]),
    { kind: 'file', file: await realpath(path.join(packageRoot, 'docs/linked document.md')) });
});

test('unissued targets, stale sources and source-less messages cannot select package files', async (t) => {
  const { packageRoot } = await fixture(t);
  const file = 'docs/topics/source.md', target = '../linked%20document.md';
  const sources = [{ file, content: `[Document](${target})` }];
  for (const [source, link] of [[null, target], ['', target], ['HELP.md', target], [file, '../unissued.md']]) {
    await assert.rejects(resolveHelpLink(packageRoot, source, link, sources), /no longer in the displayed documentation/);
  }
});

test('absolute paths, other protocols, Windows paths and encoded traversal stay refused', async (t) => {
  const { packageRoot } = await fixture(t);
  const file = 'docs/topics/source.md';
  for (const target of ['../../../outside.md', '%2e%2e/%2e%2e/%2e%2e/outside.md', '/tmp/file.md',
    'C:/private/file.md', 'C:\\private\\file.md', '//server/share/file.md', 'file:///tmp/file.md',
    'command:singularityFlow.startWork', 'javascript:alert', '%00.md', '%zz.md']) {
    await assert.rejects(resolveHelpLink(packageRoot, file, target, [{ file, content: `[Unsafe](${target})` }]),
      /outside|not a supported|invalid encoded/);
  }
});

test('missing files and directory targets report unavailable instead of being opened', async (t) => {
  const { packageRoot } = await fixture(t);
  const file = 'docs/topics/source.md';
  for (const target of ['missing.md', '..']) {
    await assert.rejects(resolveHelpLink(packageRoot, file, target, [{ file, content: `[Missing](${target})` }]),
      /linked Help document is unavailable/);
  }
});

test('a symlink or Windows junction cannot lead out of the package, through source or destination', async (t) => {
  const { directory, packageRoot } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.md'), 'Not a package document');
  await symlink(outside, path.join(packageRoot, 'docs/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const [file, target] of [
    ['docs/topics/source.md', '../escape/private.md'],
    ['docs/escape/private.md', '../linked%20document.md']
  ]) await assert.rejects(resolveHelpLink(packageRoot, file, target, [{ file, content: `[Outside](${target})` }]), /outside/);
});

test('only issued credential-free HTTPS links are external navigation', async () => {
  const file = 'HELP.md', target = 'https://example.test/guide?a=1&b=2#details';
  assert.deepEqual(await resolveHelpLink(root, file, target, [{ file, content: `[Guide](${target})` }]),
    { kind: 'external', url: target });
  const secret = 'https://name:password@example.test/guide';
  await assert.rejects(resolveHelpLink(root, file, secret, [{ file, content: `[Unsafe](${secret})` }]), /cannot contain credentials/);
});
