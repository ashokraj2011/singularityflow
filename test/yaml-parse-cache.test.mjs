import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import v8 from 'node:v8';
import YAML from 'yaml';

import { parseYamlText } from '../src/yaml-parse-cache.mjs';

test('identical text is parsed once but every caller gets its own copy', () => {
  const text = 'phases:\n  intake:\n    label: Intake\nlist: [a, b]\n';
  const first = parseYamlText(text);
  assert.deepEqual(first, YAML.parse(text));
  first.phases.intake.label = 'Changed by a caller';
  first.list.push('c');
  const second = parseYamlText(text);
  assert.deepEqual(second, YAML.parse(text), 'a caller normalizing in place does not change the next answer');
  assert.notEqual(second, first);
});

test('changed text is parsed afresh, and a parse error is thrown every time', () => {
  assert.deepEqual(parseYamlText('value: 1\n'), { value: 1 });
  assert.deepEqual(parseYamlText('value: 2\n'), { value: 2 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => parseYamlText('value: [unclosed\n'), /Flow sequence|end of the stream|Missing/u);
  }
});

test('scalars and empty documents keep YAML.parse results', () => {
  assert.equal(parseYamlText(''), null);
  assert.equal(parseYamlText('42\n'), 42);
  assert.equal(parseYamlText('text\n'), 'text');
});

test('more texts than the old 64-entry limit stay cached instead of emptying the cache', () => {
  const texts = Array.from({ length: 200 }, (_, index) => `agent: a-${index}\ntools: [read]\n`);
  for (const text of texts) parseYamlText(text);
  for (const text of texts) assert.deepEqual(parseYamlText(text), YAML.parse(text));
});

/** Runs `parseYamlText` over `texts` in a fresh process; returns each result and any YAML warnings. */
function parseInChild(texts, env) {
  const script = `import { parseYamlText } from ${JSON.stringify(new URL('../src/yaml-parse-cache.mjs', import.meta.url).href)};
const warnings = []; process.on('warning', (warning) => warnings.push(warning.message));
const results = JSON.parse(process.argv[1]).map((text) => parseYamlText(text));
setImmediate(() => console.log(JSON.stringify({ results, warnings })));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(texts)], {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function storedFiles(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute); else found.push(absolute);
    }
  };
  walk(directory);
  return found;
}

test('a later command reads a parsed result back from disk; damaged or foreign entries are parsed again', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sflow-yaml-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { SINGULARITY_FLOW_YAML_CACHE: directory };
  const text = 'name: reviewer\ntools: [read, edit]\nalias: &a {x: 1}\nreuse: *a\n';
  assert.deepEqual(parseInChild([text], env).results, [YAML.parse(text)]);
  const [file] = storedFiles(directory);
  assert.match(path.basename(file), /^[0-9a-f]{64}\.v8$/u);
  assert.equal(statSync(file).mode & 0o077, 0, 'entries are private to this user');

  // The second command answers from the entry: planting a different value shows it was read.
  const entry = v8.deserialize(readFileSync(file));
  writeFileSync(file, v8.serialize({ ...entry, value: { name: 'from disk' } }));
  assert.deepEqual(parseInChild([text], env).results, [{ name: 'from disk' }]);

  for (const damaged of [Buffer.from('not a v8 value'), v8.serialize({ ...entry, key: '0'.repeat(64) })]) {
    writeFileSync(file, damaged);
    assert.deepEqual(parseInChild([text], env).results, [YAML.parse(text)], 'parsed again, not trusted');
  }
  rmSync(file);
  symlinkSync(path.join(directory, 'elsewhere.v8'), file);
  writeFileSync(path.join(directory, 'elsewhere.v8'), v8.serialize({ ...entry, value: { name: 'linked' } }));
  assert.deepEqual(parseInChild([text], env).results, [YAML.parse(text)], 'a linked entry is not read');
});

test('warned-about texts, parse errors and a disabled or relative cache leave nothing on disk', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sflow-yaml-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const warned = 'value: !unknown-tag text\n';
  for (let run = 0; run < 2; run += 1) {
    const { results, warnings } = parseInChild([warned], { SINGULARITY_FLOW_YAML_CACHE: directory });
    assert.deepEqual(results, [YAML.parse(warned)]);
    assert.equal(warnings.length, 1, 'every command still shows the warning');
  }
  const failing = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { parseYamlText } from ${JSON.stringify(new URL('../src/yaml-parse-cache.mjs', import.meta.url).href)};
try { parseYamlText('value: [unclosed\\n'); } catch { process.exit(0); } process.exit(1);`],
  { env: { ...process.env, SINGULARITY_FLOW_YAML_CACHE: directory }, timeout: 30_000 });
  assert.equal(failing.status, 0);
  assert.deepEqual(storedFiles(directory), []);

  for (const setting of ['off', 'relative/cache']) {
    assert.deepEqual(parseInChild(['plain: 1\n'], { SINGULARITY_FLOW_YAML_CACHE: setting }).results, [{ plain: 1 }]);
  }
  assert.equal(existsSync(path.join(process.cwd(), 'relative')), false);
});
