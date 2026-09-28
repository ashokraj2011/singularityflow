/** XPL2 routing, compatibility and read-only effects through the real CLI. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveOperation } from '../src/command-registry.mjs';
import { skillForCommandLine } from '../src/command-skills.mjs';
import { normalizeXpl2Query } from '../src/comprehension/xpl2/subjects.mjs';
import { XPL2_SUBJECTS } from '../src/comprehension/xpl2/vocabulary.mjs';
import { git } from './helpers/xpl2-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'singularity-flow.mjs');

async function repository(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-cli-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-home-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'config', 'user.name', 'XPL2 CLI');
  git(directory, 'config', 'user.email', 'xpl2-cli@example.test');
  await writeFile(path.join(directory, 'app.js'), `${Array.from({ length: 30 }, (_, index) => `const v${index + 1} = ${index + 1};`).join('\n')}\n`);
  await writeFile(path.join(directory, 'données façon.js'), 'export const a = 1;\n');
  git(directory, 'add', '.');
  git(directory, 'commit', '-qm', 'baseline');
  const lines = (await readFile(path.join(directory, 'app.js'), 'utf8')).split('\n');
  lines.splice(9, 1);
  lines[19] = 'const v21 = 2100;';
  await writeFile(path.join(directory, 'app.js'), lines.join('\n'));
  await writeFile(path.join(directory, 'données façon.js'), 'export const a = 2;\n');
  return { directory, home };
}

function cli({ directory, home }, ...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: directory, encoding: 'utf8',
    env: {
      ...process.env, HOME: home, USERPROFILE: home, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_NO_MODEL: '1', GIT_TERMINAL_PROMPT: '0'
    }
  });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('XPL2-AC-017 the explicit selector reaches all six subjects and refuses unknown ones', async (t) => {
  assert.deepEqual([...XPL2_SUBJECTS], ['change', 'clause', 'test', 'line', 'gap', 'generation']);
  const fixture = await repository(t);
  const selectors = {
    change: [], clause: ['--id', 'APP:AC-001'], test: ['--id', 'unit'], line: ['--path', 'app.js', '--line', '20'],
    gap: [], generation: ['--phase', 'implementation', '--gen', '1']
  };
  for (const [subject, extra] of Object.entries(selectors)) {
    const result = json(cli(fixture, 'explain', '--subject', subject, ...extra, '--json'));
    assert.equal(result.operation.id, 'explain.subject');
    assert.equal(result.data.explanation.subject.kind, subject);
    assert.equal(result.data.explanation.authority, 'none');
  }
  const unknown = cli(fixture, 'explain', '--subject', 'proof', '--json');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stdout + unknown.stderr, /Unknown explanation subject 'proof'/u);
  assert.doesNotMatch(unknown.stdout, /docs\.served/u, 'an unknown subject never falls back to documentation');
});

test('XPL2-AC-018 path, line and side are separate portable fields', async (t) => {
  for (const rejected of ['/etc/passwd', 'C:\\Windows\\win.ini', 'C:/x.js', '../escape.js', 'src/../../x']) {
    assert.throws(() => normalizeXpl2Query({ subject: 'line', path: rejected, line: 1 }), /repository-relative/u, rejected);
  }
  for (const accepted of ['src/a:b.ts', 'src/my file.ts', 'données façon.js']) {
    assert.equal(normalizeXpl2Query({ subject: 'line', path: accepted, line: 3 }).path, accepted);
  }
  assert.throws(() => normalizeXpl2Query({ subject: 'line', path: 'a.js', line: 0 }), /positive line/u);
  assert.throws(() => normalizeXpl2Query({ subject: 'line', path: 'a.js', line: 2, side: 'middle' }), /before or after/u);
  const fixture = await repository(t);
  const deleted = json(cli(fixture, 'explain', '--subject', 'line', '--path', 'app.js', '--line', '10', '--side', 'before', '--json'));
  assert.equal(deleted.data.explanation.subject.status, 'available');
  assert.match(deleted.data.explanation.derived[0].text, /Before-side line 10 of app\.js is inside H-\d{3}/u);
  // XPL2-AC-011: the line is located, but who or what produced it is named unavailable, not inferred.
  const provenance = deleted.data.explanation.derived.find((entry) => entry.template === 'xpl2.provenance-unavailable@1');
  assert.ok(provenance, 'line origin is reported as unavailable');
  assert.doesNotMatch(JSON.stringify(deleted.data.explanation.derived), /generated by|written by|authored by/iu);
  const unicode = json(cli(fixture, 'explain', '--subject', 'line', '--path', 'données façon.js', '--line', '1', '--json'));
  assert.match(unicode.data.explanation.derived[0].text, /données façon\.js is inside|données façon\.js/u);
  const outside = json(cli(fixture, 'explain', '--subject', 'line', '--path', 'app.js', '--line', '2', '--json'));
  assert.equal(outside.data.explanation.subject.reason, 'outside-change-set');
});

test('XPL2-AC-016 existing explain routes, schemas and skills are unchanged', async (t) => {
  const fixture = await repository(t);
  const code = json(cli(fixture, 'explain', 'code', '--json'));
  assert.equal(code.operation.id, 'explain.code');
  assert.equal(code.data.explanation.kind, 'comprehension-code-explanation');
  assert.equal(code.data.explanation.schemaVersion, 1);
  const docs = json(cli(fixture, 'explain', 'approvals', '--json'));
  assert.equal(docs.operation.id, 'explain');
  assert.equal(resolveOperation({ requestedCommand: 'explain', positionals: ['explain', 'code'], options: { narrate: true } }).id, 'explain.code.narrate');
  assert.equal(skillForCommandLine('singularity-flow explain code --json'), 'sf-explain-code');
  assert.equal(skillForCommandLine('singularity-flow explain approvals'), 'sf-docs');
  assert.equal(skillForCommandLine('singularity-flow explain --subject gap --json'), 'sf-explain');
  const combined = cli(fixture, 'explain', 'code', '--subject', 'change', '--json');
  assert.notEqual(combined.status, 0, 'a topic and a subject are never combined silently');
  const narrated = cli(fixture, 'explain', '--subject', 'change', '--narrate', '--json');
  assert.notEqual(narrated.status, 0);
  assert.match(narrated.stdout + narrated.stderr, /explain code --narrate/u);
});

test('XPL2-AC-045 reading every subject changes no repository, ref, index or Story state', async (t) => {
  const fixture = await repository(t);
  const before = {
    status: git(fixture.directory, 'status', '--porcelain=v2', '--ignored'),
    refs: git(fixture.directory, 'for-each-ref', '--format=%(refname) %(objectname)'),
    head: git(fixture.directory, 'rev-parse', 'HEAD'),
    index: git(fixture.directory, 'ls-files', '--stage')
  };
  for (const args of [['--subject', 'change'], ['--subject', 'gap'], ['--subject', 'line', '--path', 'app.js', '--line', '20'],
    ['--subject', 'change', '--for', 'auditor']]) {
    json(cli(fixture, 'explain', ...args, '--json'));
    cli(fixture, 'explain', ...args);
  }
  assert.deepEqual({
    status: git(fixture.directory, 'status', '--porcelain=v2', '--ignored'),
    refs: git(fixture.directory, 'for-each-ref', '--format=%(refname) %(objectname)'),
    head: git(fixture.directory, 'rev-parse', 'HEAD'),
    index: git(fixture.directory, 'ls-files', '--stage')
  }, before);
});

test('XPL2-AC-054 terminal output is inert for hostile file names', async (t) => {
  const fixture = await repository(t);
  await writeFile(path.join(fixture.directory, `${String.fromCharCode(27)}[31mred${String.fromCharCode(0x202e)}txt.js`), 'x\n');
  const result = cli(fixture, 'explain', '--subject', 'change');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(String.fromCharCode(27)), 'no raw escape sequence reaches the terminal');
  assert.ok(!result.stdout.includes(String.fromCharCode(0x202e)), 'no bidirectional override reaches the terminal');
});
