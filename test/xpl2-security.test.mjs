/** XPL2 security: forged messages, source escape, and inert rendering of hostile content. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acceptExplorerRequest, EXPLORER_SCRIPT, EXPLORER_STYLE, resolveExplorerUnit
} from '../apps/vscode/src/views/change-explorer.ts';
import { containedWorkingPath, readExactSource } from '../apps/vscode/src/views/change-explorer-source.ts';
import { contentSecurityPolicy, page } from '../apps/vscode/src/views/webview.ts';
import {
  cliJson, comprehensionSlice, createChangeRepository, isolatedHome
} from './helpers/xpl2-fixture.mjs';
import { renderExplorer, shown } from './helpers/xpl2-html.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RLO = String.fromCharCode(0x202e);
const ESC = String.fromCharCode(27);
const lines = (count, render) => `${Array.from({ length: count }, (_, index) => render(index + 1)).join('\n')}\n`;

function sourceRunner(repository, home) {
  return async (args) => {
    const result = cliJson(repository, home, args);
    if (result.status !== 0) {
      throw Object.assign(new Error(result.json?.error?.message ?? result.stderr), { code: result.json?.error?.code ?? null });
    }
    return result.json;
  };
}

test('XPL2-AC-053 Forged messages and source escape are refused', async (t) => {
  const one = await createChangeRepository(t, {
    baseline: { 'a.ts': lines(10, (line) => `export const a${line} = ${line};`) },
    change: { 'a.ts': lines(10, (line) => line === 4 ? 'export const a4 = 40;' : `export const a${line} = ${line};`) }
  });
  const two = await createChangeRepository(t, {
    baseline: { 'a.ts': lines(10, (line) => `export const b${line} = ${line};`) },
    change: { 'a.ts': lines(10, (line) => line === 4 ? 'export const b4 = 40;' : `export const b${line} = ${line};`) }
  });
  const first = (await comprehensionSlice(one.root)).explanationView;
  const second = (await comprehensionSlice(two.root)).explanationView;
  const unit = first.inventory.units[0];
  // A handle from another workspace's view, or an older set, never resolves here.
  assert.equal(resolveExplorerUnit(first, second.explanationSetSha256, second.inventory.units[0].explanationUnitSha256), null);
  assert.equal(resolveExplorerUnit(first, first.explanationSetSha256, second.inventory.units[0].explanationUnitSha256), null);
  assert.equal(resolveExplorerUnit(first, second.explanationSetSha256, unit.explanationUnitSha256), null);
  assert.equal(resolveExplorerUnit(first, first.explanationSetSha256, unit.explanationUnitSha256), unit);
  // Expired: once the panel is hidden its pin and render session are gone, so nothing resolves.
  assert.equal(resolveExplorerUnit(null, first.explanationSetSha256, unit.explanationUnitSha256), null);
  assert.equal(acceptExplorerRequest(null, 0, { session: 'old-render', request: 1 }), null);
  const host = await readFile(path.join(root, 'apps/vscode/src/views/comprehension-center.ts'), 'utf8');
  const release = host.slice(host.indexOf('private releaseLease(): void {'), host.indexOf('private async refresh(): Promise<void> {'));
  assert.match(release, /this\.pinned = null;/u);
  assert.match(host, /private explorerInput[\s\S]*?if \(!this\.pinned\) this\.updatePinned/u, 'a re-shown page pins what it renders');
  assert.match(host, /if \(path\.resolve\(this\.client\.repository\) !== path\.resolve\(slice\.context\.repository\)\)/u,
    'a diff is refused when the selected repository changed');
  // Arbitrary schemes: explorer modules build only their private read-only scheme, never parse one.
  for (const file of ['change-explorer.ts', 'change-explorer-diff.ts', 'change-explorer-source.ts']) {
    const source = await readFile(path.join(root, 'apps/vscode/src/views', file), 'utf8');
    assert.doesNotMatch(source, /Uri\.parse\(|openExternal|env\.open/u, `${file} parses or opens no URI`);
  }

  // Path traversal and forged references are refused by the source owner, with nothing served.
  const home = await isolatedHome(t);
  const slice = await comprehensionSlice(one.root);
  const reference = slice.sourceReferences[0];
  for (const forged of [
    reference.ref.replace(/:(before|after):[a-f0-9]+$/u, ':after:../../../../etc/passwd'),
    reference.ref.replace(/[a-f0-9]$/u, (c) => c === '0' ? '1' : '0'),
    'sfref:comprehension:source:../../outside:after:00',
    'file:///etc/passwd'
  ]) {
    const result = cliJson(one.root, home, ['comprehension', 'source', forged, '--base', slice.context.base, '--json']);
    assert.notEqual(result.status, 0, `${forged} must be refused`);
    assert.doesNotMatch(result.stdout, /root:|"content":/u);
  }

  // Symlink escape: the captured after side of a link is its recorded target text, never the bytes
  // it points at; and "Open working file" refuses a link that resolves outside the repository.
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const secret = path.join(outside, 'secret.txt');
  await writeFile(secret, 'PRIVATE-OUTSIDE-CONTENT\n');
  const linked = await createChangeRepository(t, {
    baseline: { 'docs/readme.md': '# fixture\n', 'docs/local.md': 'local\n' },
    prepare: (directory) => symlink('local.md', path.join(directory, 'docs/escape')),
    apply: async (directory) => {
      await rm(path.join(directory, 'docs/escape'));
      await symlink(secret, path.join(directory, 'docs/escape'));
    }
  });
  const linkSlice = await comprehensionSlice(linked.root);
  const file = linkSlice.explanationView.inventory.files.find((entry) => entry.path === 'docs/escape');
  const after = linkSlice.sourceReferences.find((entry) => entry.ref === file.sources.after);
  const exact = await readExactSource(sourceRunner(linked.root, home), { base: linkSlice.context.base, workId: null, phase: null }, after);
  assert.equal(exact.text, secret, 'the captured bytes are the link target path');
  assert.doesNotMatch(exact.text, /PRIVATE-OUTSIDE-CONTENT/u);
  const escaped = await containedWorkingPath(linked.root, 'docs/escape');
  assert.equal(escaped.target, null);
  assert.match(escaped.refusal, /link that resolves outside the governed repository/u);
  assert.equal((await containedWorkingPath(linked.root, 'docs/readme.md')).target, path.join(path.resolve(linked.root), 'docs/readme.md'));
  for (const traversal of ['../outside.md', '/etc/passwd', 'docs/../../x', '']) {
    assert.equal((await containedWorkingPath(linked.root, traversal)).target, null, JSON.stringify(traversal));
  }
});

test('XPL2-AC-054 Inert source and strict assets: hostile names and diffs cannot execute or fetch', async (t) => {
  const hostileName = `<img src=x onerror=alert(1)> "q'${RLO}txt.js`;
  const hostileLine = `</td></tr></table><script>alert(1)</script><svg onload=alert(2)>[x](javascript:alert(3)) ${ESC}[31m${RLO}`;
  // A hostile file name, and hostile diff content under ordinary names that reaches the text preview.
  const named = await createChangeRepository(t, {
    baseline: { [hostileName]: 'export const safe = 1;\n' }, change: { [hostileName]: 'export const safe = 2;\n' }
  });
  const content = await createChangeRepository(t, {
    baseline: { 'notes.md': '# Notes\n\nplain\n', 'src/a.ts': 'export const a = 1;\n' },
    change: { 'notes.md': `# Notes\n\n${hostileLine}\n`, 'src/a.ts': `export const a = 2; // ${hostileLine}\n` }
  });
  const token = 'a'.repeat(32);
  const csp = contentSecurityPolicy({ cspSource: 'vscode-webview-resource:' }, token);
  const tag = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>"']+(?:="[^"]*")?)*)\s*\/?>/gu;
  const rendered = {};
  for (const [name, repository] of Object.entries({ named: named.root, content: content.root })) {
    const slice = await comprehensionSlice(repository);
    const view = slice.explanationView;
    const body = renderExplorer(view, { patch: slice.diff.patch, patchFiles: slice.diff.files, token });
    const html = page('Comprehension Center', body, csp, token, EXPLORER_SCRIPT);
    rendered[name] = { view, body };
    // Nothing from the repository becomes markup: no script, handler, link, source or extra SVG.
    // Every attribute value is double-quoted with quotes escaped, so tags tokenize exactly; once
    // well-formed tags are removed no '<' remains, so no repository text became markup.
    const markup = html.replace(/(<style[^>]*>)[\s\S]*?(<\/style>)/gu, '$1$2').replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/gu, '$1$2');
    const names = [...markup.matchAll(tag)].flatMap((match) => [...match[2].matchAll(/\s+([^\s=>"']+)(?:="[^"]*")?/gyu)]
      .map((attribute) => attribute[1].toLowerCase()));
    assert.ok(names.length > 100, name);
    assert.deepEqual(names.filter((entry) => entry.startsWith('on')), [], `${name}: no event-handler attribute`);
    assert.deepEqual(names.filter((entry) => ['href', 'src', 'srcset', 'action', 'formaction', 'xlink:href', 'style'].includes(entry)), [],
      `${name}: no link, source or inline style attribute`);
    const residue = markup.replace(tag, '').replace(/<\/[a-zA-Z][a-zA-Z0-9-]*>/gu, '').replace(/^<!DOCTYPE html>/u, '');
    assert.ok(!residue.includes('<'), `${name}: a stray < would mean repository text became markup`);
    assert.equal([...body.matchAll(/<script/giu)].length, 0, name);
    assert.ok([...html.matchAll(/<script([^>]*)>/giu)].every((match) => match[1] === ` nonce="${token}"`), `${name}: every script carries the nonce`);
    const layers = [...body.matchAll(/<svg class="(xpl-edges|xpl-edge-labels)" aria-hidden="true" focusable="false"><\/svg>/gu)].map((match) => match[1]);
    assert.deepEqual(layers, ['xpl-edges', 'xpl-edge-labels'], `${name}: the only SVG elements are the two empty drawing layers`);
    assert.equal([...body.matchAll(/<svg/gu)].length, 2, name);
    // Bidirectional overrides and terminal escapes are shown as inert markers, never passed through.
    assert.ok(!html.includes(RLO) && !html.includes(ESC), name);
    assert.match(body, /\[U\+202E\]/u, name);
  }
  assert.ok(rendered.named.view.inventory.files.some((entry) => entry.path === hostileName), 'the hostile name is captured exactly');
  assert.ok(rendered.named.body.includes(shown(hostileName)));
  // A name the diff projection cannot represent leaves the change counted and says why, instead of
  // calling a text file non-text.
  assert.ok(rendered.named.view.statements.some((entry) => /was not projected into text hunks for this snapshot/u.test(entry.text)));
  assert.ok(rendered.content.body.includes('&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(rendered.content.body, /\[U\+001B\]/u);
  assert.match(rendered.content.body, /<table class="xpl-diff">/u, 'the hostile content reached the text preview');

  // Strict assets: default-src none, nonce-only scripts and styles, and nothing fetched.
  assert.match(csp, /default-src 'none'/u);
  assert.match(csp, new RegExp(`script-src 'nonce-${token}'(;|$)`, 'u'));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/u);
  // The SVG namespace identifier is the only URI-shaped string, and it is never fetched.
  assert.doesNotMatch(`${EXPLORER_STYLE}${EXPLORER_SCRIPT}`.replaceAll("'http://www.w3.org/2000/svg'", "''"), /https?:|url\(|@import/u);
  assert.doesNotMatch(EXPLORER_SCRIPT,
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|import\(|setTimeout\(\s*['"`]/u);
  assert.match(EXPLORER_SCRIPT, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'path'\)/u);
  assert.match(EXPLORER_SCRIPT, /label\.textContent = edge\.label;/u);
  assert.match(EXPLORER_SCRIPT, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'rect'\)/u);
});

test('XPL2-AC-058 Audience is not authorization: another audience changes order only', async (t) => {
  const { createXpl2Fixture } = await import('./helpers/xpl2-fixture.mjs');
  const { explainXpl2Subject } = await import('../src/comprehension/xpl2/subjects.mjs');
  const fixture = await createXpl2Fixture(t);
  // An inaccessible specification stays inaccessible for every audience; no audience inherits it.
  const restricted = {
    ...fixture.input,
    clauseSources: { status: 'available', reason: null, artifacts: [{ path: 'secret/spec.md', phase: 'specification', status: 'inaccessible', reason: 'source-inaccessible', digest: null, clauses: [] }] }
  };
  const views = ['reviewer', 'auditor', 'developer'].map((audience) => explainXpl2Subject(restricted, { subject: 'change', audience }));
  const semantic = (view) => {
    const { presentation, ...rest } = view;
    return JSON.stringify({ ...rest, audiences: presentation.audiences, walkthrough: presentation.walkthrough });
  };
  assert.equal(new Set(views.map(semantic)).size, 1, 'everything except the chosen audience label is identical');
  assert.deepEqual(views.map((view) => view.presentation.audience), ['reviewer', 'auditor', 'developer']);
  for (const view of views) {
    assert.doesNotMatch(JSON.stringify(view), /secret\/spec\.md/u);
    assert.equal(view.observations.find((entry) => entry.id === 'OBS-SPEC-01').reason, 'source-inaccessible');
  }
  // Views are computed per request from the capture; there is no cross-request cache to inherit.
  const source = await readFile(path.join(root, 'src/comprehension/xpl2/subjects.mjs'), 'utf8');
  assert.doesNotMatch(source, /new Map\(\)\s*;?\s*\/\/\s*cache|globalThis\.|process\.env/u);
});
