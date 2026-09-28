/** Change Explorer interaction: closed host actions and pinned, verified source pages. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acceptExplorerRequest, EXPLORER_MESSAGES, EXPLORER_SCRIPT, resolveExplorerUnit
} from '../apps/vscode/src/views/change-explorer.ts';
import { readExactSource } from '../apps/vscode/src/views/change-explorer-source.ts';
import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import {
  cliJson, comprehensionSlice, createChangeRepository, createXpl2Fixture, isolatedHome
} from './helpers/xpl2-fixture.mjs';
import { renderExplorer } from './helpers/xpl2-html.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostSource = () => readFile(path.join(root, 'apps/vscode/src/views/comprehension-center.ts'), 'utf8');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('XPL2-AC-048 Click routes, not executes: every action is a closed host action', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const view = explainXpl2Subject(fixture.input, { subject: 'change' });
  const html = renderExplorer(view, { patch: fixture.diff.patch, patchFiles: fixture.diff.files });

  // The page names only closed actions; it carries no command URI, link or argv to execute.
  const messages = new Set([...html.matchAll(/data-message="([^"]+)"/gu)].map((match) => match[1]));
  for (const message of messages) {
    assert.ok([...EXPLORER_MESSAGES, 'refresh'].includes(message), `unexpected page action ${message}`);
  }
  assert.doesNotMatch(html, /command:|href=|singularity-flow\s+\w/u);
  assert.doesNotMatch(EXPLORER_SCRIPT, /command:|executeCommand|singularity-flow\s/u);

  // The script posts through one helper, gated on the three explicit action names.
  assert.equal([...EXPLORER_SCRIPT.matchAll(/vscode\.postMessage\(/gu)].length, 1);
  assert.match(EXPLORER_SCRIPT, /target\.dataset\.message === 'explorer-open-diff' \|\| target\.dataset\.message === 'explorer-open-file' \|\| target\.dataset\.message === 'explorer-copy'/u);
  assert.match(EXPLORER_SCRIPT, /post\('explorer-audience', \{ audience: audience\.value \}\)/u);

  // The host registers exactly the closed explorer actions and resolves each against the pinned view.
  const host = await hostSource();
  const registered = [...host.matchAll(/'(explorer-[a-z-]+)': \(message\)/gu)].map((match) => match[1]);
  assert.deepEqual(registered.sort(), [...EXPLORER_MESSAGES].sort());
  for (const name of EXPLORER_MESSAGES) {
    const handler = host.slice(host.indexOf(`'${name}': (message)`));
    assert.match(handler.slice(0, 400), /this\.acceptExplorer\(message\)/u, `${name} checks the render session and request`);
  }
  // A path, file or command in a message is never read: the file comes from the pinned unit.
  const openFile = host.slice(host.indexOf("'explorer-open-file'"), host.indexOf("'explorer-copy'"));
  assert.match(openFile, /resolveExplorerUnit\(this\.pinnedView\(\), message\.set, message\.unit\)/u);
  assert.match(openFile, /unit\.pathAfter \?\? unit\.pathBefore/u);
  assert.doesNotMatch(host, /message\.(path|file|command|uri|argv|args)\b/u);

  // Resolution accepts only this view's exact set digest and one of its unit digests.
  const unit = view.inventory.units[0];
  assert.equal(resolveExplorerUnit(view, view.explanationSetSha256, unit.explanationUnitSha256), unit);
  const forged = [
    [view.explanationSetSha256, 'src/export/service.ts'],
    [view.explanationSetSha256, 'command:workbench.action.terminal.new'],
    [view.explanationSetSha256, `sha256:${'0'.repeat(64)}`],
    [view.explanationSetSha256, [unit.explanationUnitSha256]],
    [view.explanationSetSha256, { digest: unit.explanationUnitSha256 }],
    [`sha256:${'1'.repeat(64)}`, unit.explanationUnitSha256],
    [undefined, unit.explanationUnitSha256],
    [view.explanationSetSha256, unit.regionSha256.replace(/.$/u, (c) => c === '0' ? '1' : '0')]
  ];
  for (const [set, digest] of forged) assert.equal(resolveExplorerUnit(view, set, digest), null, JSON.stringify([set, digest]));
  assert.equal(resolveExplorerUnit(null, view.explanationSetSha256, unit.explanationUnitSha256), null);

  // Only the render on screen may act, and each request number only once, in increasing order.
  assert.equal(acceptExplorerRequest('render-a', 0, { session: 'render-a', request: 1 }), 1);
  assert.equal(acceptExplorerRequest('render-a', 1, { session: 'render-a', request: 1 }), null, 'replay');
  assert.equal(acceptExplorerRequest('render-a', 4, { session: 'render-a', request: 3 }), null, 'older request');
  assert.equal(acceptExplorerRequest('render-b', 0, { session: 'render-a', request: 7 }), null, 'replaced page');
  assert.equal(acceptExplorerRequest(null, 0, { session: 'render-a', request: 1 }), null, 'explorer not on screen');
  for (const request of ['2', 2.5, -1, Number.MAX_SAFE_INTEGER + 2, null]) {
    assert.equal(acceptExplorerRequest('render-a', 0, { session: 'render-a', request }), null, String(request));
  }
});

function pagedRunner(content, reference, { pageBytes = 64 * 1024, tamper = null } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const offset = Number(args[args.indexOf('--offset') + 1]);
    const page = content.subarray(offset, offset + pageBytes);
    const next = offset + page.length;
    const expansion = {
      reference: reference.ref, referenceSha256: reference.referenceSha256, offset, bytes: page.length,
      encoding: 'base64', content: page.toString('base64'), contentSha256: sha256(content), totalBytes: content.length,
      complete: next >= content.length, nextOffset: next >= content.length ? null : next
    };
    return { data: { expansion: tamper ? tamper(expansion, calls.length) : expansion } };
  };
  return { run, calls };
}

test('XPL2-AC-022 Paged source remains pinned: pages from distinct snapshots are never stitched', async (t) => {
  const reference = { ref: 'sfref:comprehension:source:REG-FIXTURE:after:aa', referenceSha256: `sha256:${'a'.repeat(64)}` };
  const context = { base: 'HEAD', workId: 'ORD-418', phase: 'implementation' };
  // Multibyte characters straddle every page boundary; bytes are joined before decoding.
  const content = Buffer.from(Array.from({ length: 9000 }, (_, index) => `${index} données 😀 ${'é'.repeat(3)}`).join('\n'), 'utf8');
  const exact = pagedRunner(content, reference);
  const read = await readExactSource(exact.run, context, reference);
  assert.equal(read.text, content.toString('utf8'));
  assert.equal(read.contentSha256, sha256(content));
  assert.ok(exact.calls.length >= 3);
  assert.deepEqual(exact.calls[1], ['comprehension', 'source', reference.ref, '--base', 'HEAD', '--offset', String(64 * 1024),
    '--max-bytes', String(64 * 1024), '--json', '--work-id', 'ORD-418', '--phase', 'implementation']);

  const refusals = {
    'the whole-content digest changes between pages': (page, call) => call === 2 ? { ...page, contentSha256: sha256(Buffer.from('other')) } : page,
    'the total size changes between pages': (page, call) => call === 2 ? { ...page, totalBytes: page.totalBytes + 1 } : page,
    'a page names another reference': (page, call) => call === 2 ? { ...page, reference: 'sfref:comprehension:source:REG-OTHER:after:bb' } : page,
    'a page names another reference digest': (page, call) => call === 2 ? { ...page, referenceSha256: `sha256:${'b'.repeat(64)}` } : page,
    'a page starts at the wrong offset': (page, call) => call === 2 ? { ...page, offset: page.offset + 1 } : page,
    'a page is shorter than it claims': (page, call) => call === 2 ? { ...page, bytes: page.bytes + 1 } : page,
    'the pages are not contiguous': (page, call) => call === 1 ? { ...page, nextOffset: page.nextOffset + 7 } : page,
    'the joined bytes do not hash to the reported digest': (page) => ({ ...page, contentSha256: sha256(Buffer.concat([content, Buffer.from('x')])) })
  };
  for (const [name, tamper] of Object.entries(refusals)) {
    await assert.rejects(readExactSource(pagedRunner(content, reference, { tamper }).run, context, reference),
      /did not match|not contiguous|do not match/u, name);
  }
  const oversized = Buffer.alloc(1024 * 1024 + 1, 0x61);
  await assert.rejects(readExactSource(pagedRunner(oversized, reference).run, context, reference), /inline diff ceiling/u);

  // Through the real source owner: a working file that moves between page one and page two is
  // refused by the owner, and nothing assembled from the earlier page is returned.
  const big = (tag) => Array.from({ length: 3000 }, (_, index) => `line ${index} ${tag} données 😀 ${'x'.repeat(24)}`).join('\n');
  const { root: repository } = await createChangeRepository(t, { baseline: { 'big.txt': big('before') }, change: { 'big.txt': big('after') } });
  const home = await isolatedHome(t);
  const slice = await comprehensionSlice(repository);
  const file = slice.explanationView.inventory.files[0];
  const after = slice.sourceReferences.find((entry) => entry.ref === file.sources.after);
  const live = async (args) => {
    const result = cliJson(repository, home, args);
    if (result.status !== 0) throw Object.assign(new Error(result.json?.error?.message ?? result.stderr), { code: result.json?.error?.code });
    return result.json;
  };
  const sliceContext = { base: slice.context.base, workId: null, phase: null };
  const whole = await readExactSource(live, sliceContext, after);
  assert.equal(whole.text, big('after'));
  let pages = 0;
  const moving = async (args) => {
    const result = await live(args);
    pages += 1;
    if (pages === 1) await appendFile(path.join(repository, 'big.txt'), '\nmoved');
    return result;
  };
  await assert.rejects(readExactSource(moving, sliceContext, after), (error) => error.code === 'CMP_SOURCE_REFERENCE_STALE');
});
