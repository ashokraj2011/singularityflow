/**
 * semgrep in the code step's loop [CQF:REQ-051]: its SARIF read by the SARIF reader, its findings on
 * changed lines sent back in the same turn like any other, and its ruleset's digest part of what a
 * run is reused by. A ruleset pinned as files in the repository is digested file by file; one taken
 * from the Semgrep registry can change between runs, so no run of it is reused.
 *
 * semgrep is not installed here: test/fixtures/findings/semgrep.sarif is recorded in the format
 * `semgrep --sarif` documents, and the program on PATH is a stand-in that is never run.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readSarif } from '../src/findings/readers/sarif.mjs';
import { repositoryPaths } from '../src/findings/readers/common.mjs';
import { findingToolIdentity } from '../src/findings/tool-identity.mjs';
import { recordFindingRun, unchangedFindingRun } from '../src/findings/runs.mjs';
import { publishCheckFindings } from '../src/findings/code-step.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/findings/${name}`, import.meta.url), 'utf8');

async function directory(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A `semgrep` on PATH that is never run: what the tool identity reads. */
async function semgrepOnPath(t) {
  const bin = await directory(t, 'sflow-semgrep-bin-');
  await writeFile(path.join(bin, 'semgrep'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(bin, 'semgrep'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  t.after(() => { process.env.PATH = before; });
}

const semgrep = (config = '.semgrep/') => ({ id: 'semgrep', kind: 'security', modelPolicy: 'never',
  argv: ['semgrep', 'scan', '--config', config, '--sarif', '--output', '.sflow/results/semgrep.sarif', '--metrics=off'],
  result: { adapter: 'sarif', path: '.sflow/results/semgrep.sarif' } });

test("semgrep's SARIF reads into the shared shape: its security rules are vulnerabilities, its paths repository paths", async () => {
  const report = readSarif(await fixture('semgrep.sarif'), { source: 'semgrep', paths: repositoryPaths({ bases: [{ absolute: '/work/app', relative: '.' }] }) });
  assert.deepEqual(report.tools.map((entry) => [entry.tool, entry.toolVersion]), [['Semgrep OSS', '1.95.0']]);
  assert.match(report.tools[0].rulesetSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(report.findings.map((finding) => [finding.rule, finding.kind, finding.severity, finding.file, finding.line]), [
    ['sflow-rules.sql-concatenation', 'vulnerability', 'high', 'src/db.mjs', 3], ['sflow-rules.no-eval', 'vulnerability', 'medium', 'lib/legacy.mjs', 2]]);
});

test('a pinned ruleset is digested file by file, and a registry ruleset is never reused [CQF:REQ-051]', async (t) => {
  await semgrepOnPath(t);
  const root = await directory(t, 'sflow-semgrep-identity-');
  await mkdir(path.join(root, '.semgrep/rules'), { recursive: true });
  await writeFile(path.join(root, '.semgrep/rules/sql.yml'), 'rules:\n  - id: sql-concatenation\n    severity: ERROR\n');
  const first = findingToolIdentity(root, root, semgrep());
  assert.equal(first.tool, 'semgrep');
  assert.match(first.toolVersion, /^file:[0-9a-f]{16}$/u);
  assert.equal(first.pinned, undefined, 'files in the repository are a pinned ruleset');
  await writeFile(path.join(root, '.semgrep/rules/eval.yml'), 'rules:\n  - id: no-eval\n    severity: WARNING\n');
  const added = findingToolIdentity(root, root, semgrep());
  assert.notEqual(added.rulesetSha256, first.rulesetSha256, 'a rule added to the folder changes the ruleset');
  await writeFile(path.join(root, '.semgrep/rules/eval.yml'), 'rules:\n  - id: no-eval\n    severity: ERROR\n');
  assert.notEqual(findingToolIdentity(root, root, semgrep()).rulesetSha256, added.rulesetSha256, 'so does a rule changed in it');
  assert.equal(findingToolIdentity(root, root, semgrep('.semgrep/rules/sql.yml')).pinned, undefined, 'one file is pinned too');
  for (const config of ['p/ci', 'auto', 'https://semgrep.example.test/rules.yml', 'r/javascript.lang.security']) {
    const identity = findingToolIdentity(root, root, semgrep(config));
    assert.deepEqual([identity.pinned, identity.unpinnedRulesets], [false, [config]], config);
  }
  assert.deepEqual(findingToolIdentity(root, root, { ...semgrep(), argv: ['semgrep', '--config=p/owasp-top-ten', '--sarif'] }).unpinnedRulesets, ['p/owasp-top-ten']);

  // A run of the registry ruleset on this exact code is recorded, and still does not stand.
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'base');
  const commit = git(root, 'rev-parse', 'HEAD');
  const workflow = { workItem: { id: 'SG-1' }, phaseOrder: ['implementation'] };
  const registry = findingToolIdentity(root, root, semgrep('p/ci'));
  const command = semgrep('p/ci');
  await recordFindingRun(root, { workId: 'SG-1', phaseId: 'implementation', generation: 1, purpose: 'preflight', command, candidate: { commit, treeSha256: 'tree-1' },
    identity: registry, status: 'read', findings: [] });
  assert.deepEqual(await unchangedFindingRun(root, workflow, command, { commit, treeSha256: 'tree-1', identity: registry }), { moved: null, unpinned: true });
  const pinned = findingToolIdentity(root, root, semgrep());
  await recordFindingRun(root, { workId: 'SG-1', phaseId: 'implementation', generation: 1, purpose: 'preflight', command: semgrep(), candidate: { commit, treeSha256: 'tree-1' },
    identity: pinned, status: 'read', findings: [] });
  assert.ok((await unchangedFindingRun(root, workflow, semgrep(), { commit, treeSha256: 'tree-1', identity: pinned })).run, 'a pinned ruleset on unchanged code stands');
});

/** The loop's kernel with each run replaced by writing its recorded report. */
function recordedKernel(reports) {
  const ran = [];
  return {
    ran, generation: 1, sourceTreeHash: async () => 'tree-1', testInputTreeHash: async () => null,
    qualityChecks: async (root, phase, config, workflow, commands) => Promise.all(commands.map(async (command) => {
      ran.push(command.id);
      await mkdir(path.join(root, '.sflow/results'), { recursive: true });
      await writeFile(path.join(root, command.result.path), reports[command.id]);
      const at = new Date().toISOString();
      return { id: command.id, status: 'failed', exitCode: 1, startedAt: at, completedAt: at };
    }))
  };
}

test('a semgrep finding on a changed line comes back in the same turn; unchanged code under the same rules reuses its run [CQF:REQ-051]', async (t) => {
  await semgrepOnPath(t);
  const root = await directory(t, 'sflow-semgrep-loop-');
  git(root, 'init', '-q', '-b', 'main');
  await mkdir(path.join(root, '.semgrep'));
  await mkdir(path.join(root, 'lib'));
  await writeFile(path.join(root, '.semgrep/rules.yml'), 'rules:\n  - id: sql-concatenation\n');
  await writeFile(path.join(root, 'lib/legacy.mjs'), 'export function run(code) {\n  eval(code);\n}\n');
  await writeFile(path.join(root, '.gitignore'), '.sflow/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/db.mjs'), "import { db } from './pool.mjs';\nexport function user(id) {\n  return db.query('SELECT * FROM users WHERE id = ' + id);\n}\n");
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'the Story');
  const phase = { id: 'implementation', qualityCommands: [semgrep()] };
  const workflow = { workItem: { id: 'SG-2' }, phaseOrder: ['implementation'], phases: { implementation: phase }, resolution: { approvalAuthorities: {} },
    workIntervals: { current: { sourceBaseCommit: base } } };
  const delivery = { changeSet: { entries: [{ newPath: 'src/db.mjs', status: 'added' }] } };
  const kernel = recordedKernel({ semgrep: await fixture('semgrep.sarif') });
  await assert.rejects(publishCheckFindings(root, {}, workflow, phase, delivery, kernel), (error) => {
    assert.equal(error.code, 'CODE_QUALITY_FINDINGS');
    const quality = error.details.qualityFindings;
    assert.deepEqual(quality.findings.map((finding) => [finding.tool, finding.rule, finding.file, finding.line, finding.severity]),
      [['Semgrep OSS', 'sflow-rules.sql-concatenation', 'src/db.mjs', 3, 'high']], "lib/legacy.mjs's eval is existing code");
    assert.equal(quality.attempt, 1);
    return true;
  });
  // The same code under the same rules: the run stands, so the scanner is not run again.
  await assert.rejects(publishCheckFindings(root, {}, workflow, phase, delivery, kernel), { code: 'CODE_QUALITY_FINDINGS' });
  assert.deepEqual(kernel.ran, ['semgrep'], 'the second check reused the first run');
  // A changed rule is another ruleset: semgrep runs again. At the third attempt under warn the publication goes ahead.
  await writeFile(path.join(root, '.semgrep/rules.yml'), 'rules:\n  - id: sql-concatenation\n    severity: ERROR\n');
  const third = await publishCheckFindings(root, {}, workflow, phase, delivery, kernel);
  assert.deepEqual(kernel.ran, ['semgrep', 'semgrep']);
  assert.deepEqual([third.outcome, third.attempt, third.counts.counted, third.commands[0].counts.existing], ['warned', 3, 1, 1]);
});
