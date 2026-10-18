import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  configuredPersonalTerms, documentationPrivacyProblems, generatedPrivacyFiles, isDocumentationPath, sourcePrivacyProblems
} from '../scripts/documentation-privacy.mjs';

test('privacy policy covers documentation, skills and generated catalogs on both hosts', () => {
  for (const file of ['README.md', 'docs/page.mdx', 'docs/page.rst', 'docs/page.txt',
    'docs/page.html', 'docs/page.adoc', 'docs/page.tex', 'docs/diagram.svg',
    'plugin/skills/example/SKILL.md', 'templates/agents/example.agent.md']) {
    assert.equal(isDocumentationPath(file), true, file);
    assert.equal(isDocumentationPath(file.replaceAll('/', '\\')), true, file);
  }
  assert.equal(isDocumentationPath('src/identity.mjs'), false);
  assert.equal(isDocumentationPath('package-lock.json'), false);
});

test('personal names, deep Git links and named evidence references are refused', () => {
  const name = 'Private-Owner';
  for (const text of [name, `${name} Contributor`,
    `https://git.example/${name.toLowerCase()}/project/actions/runs/123`,
    `benchmarks/evidence/darwin-${name.toLowerCase()}-local.json`]) {
    assert.match(documentationPrivacyProblems('docs/qualification.md', text, [name]).join('\n'),
      /docs\/qualification\.md:1: personal name or account reference/);
  }
  assert.match(documentationPrivacyProblems(`docs/${name}-notes.md`, 'Neutral text', [name]).join('\n'),
    /personal identity in filename/);
});

test('source privacy covers tests, code, generated bundles and source maps without a named denylist', () => {
  for (const file of ['test/example.test.mjs', 'src/example.ts', 'bundle/cli.mjs',
    'apps/vscode/dist/extension.cjs', 'apps/vscode/dist/extension.cjs.map', 'fixtures/state.json']) {
    assert.match(sourcePrivacyProblems(file, 'const owner = "private-owner";', ['private-owner']).join('\n'),
      /personal name or account reference/);
    assert.deepEqual(sourcePrivacyProblems(file, 'const owner = "fixture-user";', ['private-owner']), []);
  }
  assert.deepEqual(sourcePrivacyProblems('src/example.mjs', 'private-ownership', ['private-owner']), []);
});

test('configured identity hints are private inputs, not hardcoded names or example identities', () => {
  assert.deepEqual(configuredPersonalTerms({ name: 'Private Contributor', email: 'private-owner@corp.invalid',
    homeDirectory: 'C:\\Users\\private-account' }), ['private contributor', 'private', 'contributor', 'private-account']);
  assert.deepEqual(configuredPersonalTerms({ name: 'Fixture Developer', email: 'fixture@example.com',
    homeDirectory: '/home/runner' }), []);
  assert.deepEqual(configuredPersonalTerms({ name: 'GitHub Actions', email: 'bot@example.invalid' }), []);
  for (const homeDirectory of ['/root', '/home/runner', 'C:\\Users\\User', 'C:\\Users\\Administrator']) {
    assert.deepEqual(configuredPersonalTerms({ homeDirectory }), []);
  }
  assert.deepEqual(configuredPersonalTerms({ email: '12345+private-owner@corp.internal' }),
    ['12345+private-owner@corp.internal', 'private-owner']);
});

test('generated-file audit includes ignored bundles and maps without walking unrelated directories', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await generatedPrivacyFiles(root), []);
  const included = ['bundle/cli.mjs', 'apps/vscode/dist/extension.cjs.map'];
  for (const relative of [...included, 'node_modules/vendor/index.js', 'coverage/output.js']) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '"private-owner"');
  }
  const files = await generatedPrivacyFiles(root);
  assert.deepEqual(files.map(file => path.relative(root, file).split(path.sep).join('/')).sort(), included.toSorted());
  assert.equal(files.flatMap(file => sourcePrivacyProblems(path.relative(root, file), '"private-owner"', ['private-owner'])).length, 2);
  if (process.platform !== 'win32') {
    await symlink(path.join(root, 'node_modules'), path.join(root, 'bundle', 'linked-vendor'));
    assert.deepEqual(await generatedPrivacyFiles(root), files);
    await rm(path.join(root, 'bundle'), { recursive: true, force: true });
    await symlink(path.join(root, 'node_modules'), path.join(root, 'bundle'));
    assert.deepEqual(await generatedPrivacyFiles(root), files.filter(file => !file.endsWith('cli.mjs')));
  }
});

test('machine-specific paths are refused, including escaped Windows and HTML examples', () => {
  for (const text of ['/Users/private-user/repo', '/home/private-user/repo',
    'C:\\Users\\private-user\\repo', 'C:\\\\Users\\\\private-user\\\\repo',
    'C:/Users/private-user/repo', '<code>/Users/private-user/repo</code>']) {
    assert.match(documentationPrivacyProblems('docs/example.md', text).join('\n'),
      /machine-specific home path/, text);
  }
  for (const text of ['/Users/<USER>/repo', '/home/${USER}/repo',
    'C:\\Users\\<USER>\\repo', 'C:/Users/%USERNAME%/repo',
    '/Users/&lt;USER&gt;/repo', '/path/to/workspace',
    'git@git.example.corp:team/project.git', 'reviewer@example.com']) {
    assert.deepEqual(documentationPrivacyProblems('docs/example.md', text), [], text);
  }
});

test('privacy diagnostics report exact lines without echoing personal contents', () => {
  const results = documentationPrivacyProblems('docs/example.txt', 'Neutral\n/home/private-user/repo\n');
  assert.equal(results.length, 1);
  assert.match(results[0], /^docs\/example\.txt:2:/);
  assert.ok(!results[0].includes('private-user'));
});
