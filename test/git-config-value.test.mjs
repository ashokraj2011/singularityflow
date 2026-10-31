import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitConfigValue } from '../src/git-config-value.mjs';
import { configuredRemoteUrls } from '../src/repository-check-cache.mjs';

test('a remote URL read from the configuration file is the one Git reads, Windows paths and quotes included', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-config-value-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  // Git writes these as `C:\\Users\\...` and `"https://...#b;c"`; read raw, the pushes another
  // checkout made to the same remote did not match it on Windows.
  const urls = { origin: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x\\remote.git', spaced: 'D:\\work tree\\my repo.git',
    marked: 'https://example.invalid/a#b;c', plain: 'git@example.invalid:team/app.git' };
  for (const [name, url] of Object.entries(urls)) git('remote', 'add', name, url);
  for (const name of Object.keys(urls)) assert.equal(git('config', '--get', `remote.${name}.url`), urls[name]);
  assert.deepEqual(Object.fromEntries(configuredRemoteUrls(root).map((entry) => [entry.remote, entry.url])), urls);
});

test('a configuration value decodes as Git decodes it, and what Git refuses is no value', async (t) => {
  assert.equal(gitConfigValue(' C:\\\\Users\\\\x\\\\remote.git'), 'C:\\Users\\x\\remote.git');
  assert.equal(gitConfigValue(' "https://example.invalid/a#b;c"  '), 'https://example.invalid/a#b;c');
  assert.equal(gitConfigValue(' https://example.invalid/x.git ; a comment'), 'https://example.invalid/x.git');
  assert.equal(gitConfigValue(' say \\"hi\\"\\n'), 'say "hi"\n');
  for (const refused of [' bad\\q', ' continued\\', ' "unterminated']) assert.equal(gitConfigValue(refused), null, refused);
  // Whitespace inside a value is kept as written (a tab stays a tab), none is kept after an empty
  // quoted string, and a trailing backslash continues the value on the next line: each exactly as
  // `git config --get` reads it.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-config-value-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = { tab: ' a\t b # trailing', empty: ' "" lead', continued: ' one \\\n two' };
  const file = path.join(root, 'config');
  await writeFile(file, `[x]\n${Object.entries(values).map(([key, raw]) => `\t${key} =${raw}\n`).join('')}`);
  for (const [key, raw] of Object.entries(values)) {
    const expected = execFileSync('git', ['config', '-f', file, '--get', `x.${key}`], { encoding: 'utf8' }).replace(/\n$/u, '');
    const [first, ...rest] = raw.split('\n');
    assert.equal(gitConfigValue(first, () => rest.shift()), expected, key);
  }
  assert.equal(gitConfigValue(' a\t b # trailing'), 'a\t b');
});
