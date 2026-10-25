import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bundledAstAdapters, inspectAstAdapterArtifacts } from '../src/ast-adapter-contract.mjs';
import { VSIX_CLI_PAYLOAD } from '../src/vsix-source-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');
const index = JSON.parse(await read('docs/history/index.json'));

test('completed records have one retained destination and the old copies are removed', async () => {
  assert.equal(index.schemaVersion, 1);
  assert.equal(new Set(index.entries.map(entry => entry.formerPath)).size, 25);
  assert.equal(new Set(index.entries.map(entry => entry.target)).size, 3);
  for (const entry of index.entries) {
    await assert.rejects(access(path.join(root, entry.formerPath)), { code: 'ENOENT' });
    const content = await read(entry.target);
    assert.ok(content.includes(`## ${entry.title}\n`), entry.formerPath);
    assert.ok(content.includes(`](#${entry.anchor})`), `${entry.target} table of contents`);
    assert.match(content, /original feature scope, measurements, validation and limitations/);
  }
});

test('consolidated history has no broken relative document links', async () => {
  for (const file of [...new Set(index.entries.map(entry => entry.target)), 'docs/history/README.md']) {
    const content = await read(file);
    for (const match of content.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/gu)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/iu.test(target)) continue;
      const destination = path.resolve(root, path.dirname(file), target.split('#')[0]);
      assert.ok(destination.startsWith(`${root}${path.sep}`), `${file}: ${target}`);
      await assert.doesNotReject(access(destination), `${file}: ${target}`);
    }
  }
});

test('current documentation separates completed records from active plans', async () => {
  assert.match(await read('docs/README.md'), /history\/README\.md/u);
  assert.match(await read('docs/DOCUMENTATION-MAP.md'), /history\/README\.md/u);
  await access(path.join(root, 'docs/PENDING-WORK-ROADMAP.md'));
  await access(path.join(root, 'docs/SGOS-PENDING-WORK.md'));
  await access(path.join(root, 'docs/SKP-IMPLEMENTATION-STATUS.md'));
});

test('product packaging does not depend on removed license or release files', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const vscode = JSON.parse(await read('apps/vscode/package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(pkg.license, 'UNLICENSED');
  assert.equal(vscode.license, 'UNLICENSED');
  assert.equal(lock.packages[''].license, pkg.license);
  assert.equal(lock.packages['apps/vscode'].license, vscode.license);
  assert.ok(pkg.files.includes('docs/'));
  for (const entry of pkg.files) assert.ok(!entry.startsWith('RELEASE-') && entry !== 'LICENSE', entry);
  assert.ok(!VSIX_CLI_PAYLOAD.includes('LICENSE'));
  for (const file of ['LICENSE', 'apps/vscode/LICENSE']) {
    await assert.rejects(access(path.join(root, file)), { code: 'ENOENT' });
  }
});

test('bundled native analyzers verify without a product license file', async () => {
  const packs = await bundledAstAdapters();
  for (const id of ['sflow-polyglot-syntax', 'sflow-java']) {
    const pack = packs.find(item => item.id === id);
    assert.ok(pack, id);
    assert.deepEqual(pack.licenses, []);
    assert.ok(pack.implementation.files.every(item => path.basename(item.path) !== 'LICENSE'));
    assert.deepEqual(await inspectAstAdapterArtifacts(pack), { healthy: true, diagnostics: [] });
  }
  for (const id of ['sflow-typescript', 'sflow-python-pyright']) {
    const pack = packs.find(item => item.id === id);
    if (pack) assert.ok(pack.licenses.length > 0, `${id} retains upstream notices and provenance`);
  }
});

test('repository input placeholders display the generic token safely in HTML', async () => {
  const form = await read('apps/vscode/src/views/map-capability-form.ts');
  assert.equal([...form.matchAll(/placeholder="&lt;git_url&gt;\.git"/gu)].length, 5);
  assert.ok(!(await read('src/help-pages.mjs')).includes(['git', 'example', 'corp'].join('.')));
  assert.match(await read('templates/portfolio.yml'), /<git_url>\.git/u);
});
