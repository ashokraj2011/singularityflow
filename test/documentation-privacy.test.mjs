import assert from 'node:assert/strict';
import test from 'node:test';
import {
  documentationPrivacyProblems, isDocumentationPath
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
  const name = ['Ash', 'ok'].join('');
  for (const text of [name, `${name} Raj`,
    `https://${['github', 'com'].join('.')}/${name.toLowerCase()}raj2011/project/actions/runs/123`,
    `benchmarks/evidence/darwin-${name.toLowerCase()}-local.json`]) {
    assert.match(documentationPrivacyProblems('docs/qualification.md', text).join('\n'),
      /docs\/qualification\.md:1: personal name or account reference/);
  }
  assert.match(documentationPrivacyProblems(`docs/${name}-notes.md`, 'Neutral text').join('\n'),
    /personal name in documentation filename/);
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
