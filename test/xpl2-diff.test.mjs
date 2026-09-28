/** XPL2 exact diff: retained bytes, line/side selection across encodings, and opaque resources. */
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { hunkPreview } from '../apps/vscode/src/views/change-explorer.ts';
import { displayableSource, readExactSource } from '../apps/vscode/src/views/change-explorer-source.ts';
import {
  cliJson, comprehensionSlice, createChangeRepository, git, isolatedHome
} from './helpers/xpl2-fixture.mjs';
import { renderExplorer, shown } from './helpers/xpl2-html.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = (count, render, ending = '\n') => `${Array.from({ length: count }, (_, index) => render(index + 1)).join(ending)}${ending}`;

function sourceRunner(repository, home) {
  return async (args) => {
    const result = cliJson(repository, home, args);
    if (result.status !== 0) {
      throw Object.assign(new Error(result.json?.error?.message ?? result.stderr), { code: result.json?.error?.code ?? null });
    }
    return result.json;
  };
}

function sideReference(slice, file, side) {
  return slice.sourceReferences.find((entry) => entry.ref === file.sources[side]) ?? null;
}

test('XPL2-AC-025 Historical native diff keeps the captured bytes and never substitutes the live file', async (t) => {
  const baseline = lines(40, (line) => `export const total${line} = ${line};`);
  const captured = lines(40, (line) => line === 20 ? 'export const total20 = 2000;' : `export const total${line} = ${line};`);
  const { root: repository } = await createChangeRepository(t, { baseline: { 'src/totals.ts': baseline }, change: { 'src/totals.ts': captured } });
  const home = await isolatedHome(t);
  const slice = await comprehensionSlice(repository);
  const file = slice.explanationView.inventory.files[0];
  const context = { base: slice.context.base, workId: null, phase: null };
  const run = sourceRunner(repository, home);

  const before = await readExactSource(run, context, sideReference(slice, file, 'before'));
  const after = await readExactSource(run, context, sideReference(slice, file, 'after'));
  assert.equal(before.text, git(repository, 'show', 'HEAD:src/totals.ts') + '\n');
  assert.equal(after.text, captured);

  // The working file moves on. The captured pair already read stays exactly what was captured, and
  // a new read of the moved capture is refused instead of silently showing today's bytes.
  await writeFile(path.join(repository, 'src/totals.ts'), `${captured}export const late = true;\n`);
  assert.equal(after.text, captured);
  await assert.rejects(readExactSource(run, context, sideReference(slice, file, 'after')),
    (error) => error.code === 'CMP_SOURCE_REFERENCE_STALE');

  // The page offers the live file as a separate, labelled action.
  const html = renderExplorer(slice.explanationView, { patch: slice.diff.patch, patchFiles: slice.diff.files });
  assert.match(html, /<button type="button" data-message="explorer-open-diff">Open native diff<\/button>/u);
  assert.match(html, /<button type="button" class="secondary" data-message="explorer-open-file">Open working file<\/button>/u);
  assert.match(html, /<strong>Open working file<\/strong> opens today's file, which may have moved/u);

  // The diff documents are built only from verified captured bytes, under the private read-only scheme.
  const host = await readFile(path.join(root, 'apps/vscode/src/views/change-explorer-diff.ts'), 'utf8');
  assert.doesNotMatch(host, /Uri\.file\(|workspace\.fs|readFile/u);
  assert.match(host, /scheme: CHANGE_EXPLORER_DIFF_SCHEME/u);
  assert.match(host, /readExactSource\(run, request\.context, request\.after, request\.signal\)/u);
});

test('XPL2-AC-026 UTF offsets and deletion side select the right range; invalid conversion is visible', async (t) => {
  const crlf = (rows) => `${rows.join('\r\n')}\r\n`;
  const { root: repository } = await createChangeRepository(t, {
    baseline: {
      'win.ts': crlf(['function alpha() {', '  return 1;', '}', 'const données = "é";', 'const emoji = "😀x";', 'end']),
      'gone.txt': 'one\ntwo\nthree\n'
    },
    change: {
      'win.ts': crlf(['function alpha() {', '  return 2;', '}', 'const données = "è";', 'const emoji = "😀y";', 'end']),
      'gone.txt': 'one\nthree\n'
    }
  });
  const home = await isolatedHome(t);
  const slice = await comprehensionSlice(repository);
  const view = slice.explanationView;
  const unit = (file) => view.inventory.units.find((entry) => entry.path === file);

  // Deletion: the removed line exists only on the before side, and the after side keeps numbering.
  const deletion = hunkPreview(slice.diff.patch, slice.diff.files, unit('gone.txt'));
  assert.deepEqual(deletion.rows.map((row) => [row.before?.line ?? null, row.before?.kind ?? null, row.after?.line ?? null, row.after?.kind ?? null]),
    [[1, 'context', 1, 'context'], [2, 'removed', null, null], [3, 'context', 2, 'context']]);

  // CRLF, non-ASCII and surrogate pairs: lines stay whole, numbering is by line, the ending is reported.
  const windows = hunkPreview(slice.diff.patch, slice.diff.files, unit('win.ts'));
  assert.equal(windows.crlf, true);
  assert.ok(windows.rows.every((row) => !row.before?.text.includes('\r') && !row.after?.text.includes('\r')));
  const emoji = windows.rows.find((row) => row.after?.text.includes('😀y'));
  assert.equal(emoji.after.line, 5);
  assert.equal(emoji.before.text, 'const emoji = "😀x";');
  assert.equal(windows.rows.find((row) => row.after?.text.includes('données')).after.line, 4);
  const html = renderExplorer(view, { patch: slice.diff.patch, patchFiles: slice.diff.files });
  assert.match(html, /CRLF line endings/u);
  assert.ok(html.includes(shown('const emoji = "😀y";')));

  // The CLI selects the same lines and sides.
  const removed = cliJson(repository, home, ['explain', '--subject', 'line', '--path', 'gone.txt', '--line', '2', '--side', 'before', '--json']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.json.data.explanation.derived[0].text, new RegExp(`Before-side line 2 of gone\\.txt is inside ${unit('gone.txt').unitId}`, 'u'));
  const surrogate = cliJson(repository, home, ['explain', '--subject', 'line', '--path', 'win.ts', '--line', '5', '--json']);
  assert.equal(surrogate.status, 0, surrogate.stderr);
  assert.match(surrogate.json.data.explanation.derived[0].text, new RegExp(`inside ${unit('win.ts').unitId}`, 'u'));
  const outside = cliJson(repository, home, ['explain', '--subject', 'line', '--path', 'gone.txt', '--line', '9', '--side', 'before', '--json']);
  assert.equal(outside.json.data.explanation.subject.reason, 'outside-change-set');

  // Invalid conversion fails visibly: a hunk absent from the patch has no invented preview, and
  // bytes that are not UTF-8 are described, never decoded into replacement text.
  const missing = { ...unit('win.ts'), hunk: { ...unit('win.ts').hunk, header: '@@ -90,2 +90,2 @@' } };
  assert.equal(hunkPreview(slice.diff.patch, slice.diff.files, missing), null);
  const tampered = renderExplorer({ ...view, inventory: { ...view.inventory, units: view.inventory.units.map((entry) => entry.unitId === missing.unitId ? missing : entry) } },
    { patch: slice.diff.patch, patchFiles: slice.diff.files });
  assert.match(tampered, new RegExp(`does not include a text preview for ${missing.unitId}`, 'u'));
  const invalid = displayableSource(Buffer.from([0x63, 0x61, 0x66, 0xc3, 0x28, 0x0a]));
  assert.equal(invalid.binary, true);
  assert.match(invalid.text, /Binary content \(6 bytes\) is not shown as text/u);
});

test('XPL2-AC-027 Opaque resources stay visible as their actual kinds with no invented text', async (t) => {
  const lfs = (digit, size) => `version https://git-lfs.example.test/spec/v1\noid sha256:${digit.repeat(64)}\nsize ${size}\n`;
  const { root: repository } = await createChangeRepository(t, {
    baseline: {
      'run.sh': 'echo ready\n',
      'logo.bin': Buffer.from([0, 1, 2, 3, 255]),
      'target.txt': 'target\n',
      'model.pt': lfs('a', 12)
    },
    prepare: async (directory) => {
      await symlink('target.txt', path.join(directory, 'link'));
      const nested = path.join(directory, 'vendor', 'lib');
      await mkdir(nested, { recursive: true });
      git(nested, 'init', '-q', '-b', 'main');
      git(nested, 'config', 'user.name', 'XPL2 Fixture');
      git(nested, 'config', 'user.email', 'xpl2@example.test');
      await writeFile(path.join(nested, 'a.txt'), 'one\n');
      git(nested, 'add', '.');
      git(nested, 'commit', '-qm', 'one');
    },
    apply: async (directory) => {
      await chmod(path.join(directory, 'run.sh'), 0o755);
      await writeFile(path.join(directory, 'logo.bin'), Buffer.from([0, 1, 2, 4, 255]));
      await rm(path.join(directory, 'link'));
      await symlink('run.sh', path.join(directory, 'link'));
      await writeFile(path.join(directory, 'model.pt'), lfs('b', 13));
      const nested = path.join(directory, 'vendor', 'lib');
      await writeFile(path.join(nested, 'a.txt'), 'two\n');
      git(nested, 'commit', '-qam', 'two');
      await writeFile(path.join(directory, 'notes-new.txt'), 'untracked\n');
    }
  });
  assert.equal(git(repository, 'ls-files', '-s', 'vendor/lib').split(' ')[0], '160000', 'the fixture records a real gitlink');
  const slice = await comprehensionSlice(repository);
  const view = slice.explanationView;
  const file = (name) => view.inventory.files.find((entry) => entry.path === name);
  const about = (name) => view.statements.filter((entry) => entry.about === file(name).fileId || file(name).unitIds.some((id) => entry.about === `unit:${id}`));
  const units = (name) => view.inventory.units.filter((entry) => entry.fileId === file(name).fileId);

  assert.equal(view.inventory.counts.files, 6);
  assert.equal(view.inventory.counts.changeUnits, view.inventory.units.length);
  // Binary and untracked content: opaque units, counted, never rendered as text.
  assert.deepEqual(units('logo.bin').map((unit) => unit.unitKind), ['tracked-file-opaque']);
  assert.deepEqual(units('notes-new.txt').map((unit) => unit.unitKind), ['untracked-region-opaque']);
  // Mode-only: opaque content plus the recorded mode fact.
  assert.deepEqual(units('run.sh').map((unit) => unit.unitKind), ['tracked-file-opaque']);
  assert.ok(about('run.sh').some((entry) => entry.text === 'run.sh changed file mode from 100644 to 100755.'));
  // Symlink and gitlink: their one-line hunks are the recorded target or pointer, and say so.
  assert.ok(about('link').some((entry) => /link is a symbolic link on both sides; its diff text is the recorded link target, not file content\./u.test(entry.text)));
  assert.ok(about('vendor/lib').some((entry) => /vendor\/lib is a submodule pointer \(gitlink\) on both sides; its diff text is the recorded commit pointer/u.test(entry.text)));
  // An LFS pointer is an ordinary text file here; no large-file behaviour is invented for it.
  assert.deepEqual(units('model.pt').map((unit) => unit.unitKind), ['diff-hunk']);
  assert.ok(view.statements.every((entry) => !/\bLFS\b|large file/iu.test(entry.text)));

  const html = renderExplorer(view, { patch: slice.diff.patch, patchFiles: slice.diff.files });
  for (const label of ['symbolic link', 'submodule pointer', 'mode 100644 → 100755']) assert.ok(html.includes(shown(label)), label);
  for (const name of ['logo.bin', 'run.sh', 'notes-new.txt']) {
    const unit = units(name)[0];
    const section = html.slice(html.indexOf(`data-unit-pane="${unit.unitId}"`));
    const body = section.slice(0, section.indexOf('</section>'));
    assert.doesNotMatch(body, /<table class="xpl-diff">/u, `${name} has no text preview`);
    assert.match(body, name === 'notes-new.txt' ? /New untracked file bodies are excluded/u : /content is not represented as text/u);
  }

  // The exact binary bytes are described, not decoded, even through the native diff path.
  const home = await isolatedHome(t);
  const after = slice.sourceReferences.find((entry) => entry.ref === file('logo.bin').sources.after);
  const exact = await readExactSource(sourceRunner(repository, home), { base: slice.context.base, workId: null, phase: null }, after);
  assert.equal(exact.binary, true);
  assert.equal(exact.bytes, 5);
});
