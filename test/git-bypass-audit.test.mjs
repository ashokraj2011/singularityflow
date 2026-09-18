import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectExecutionSites, collectPackageScriptSites, compareWithBaseline, REGISTERED_OWNERS, summarizeSites
} from '../scripts/git-bypass-audit.mjs';

test('Git bypass gate sees direct and aliased child execution in extension code', () => {
  const sites = collectExecutionSites(`
    import { spawn as launch } from 'node:child_process';
    const executable = chooseGit();
    launch(executable, ['status']);
    run('git', ['status']);
  `, 'apps/vscode/src/new-feature.ts');
  assert.deepEqual(sites.map((site) => site.id.split(':')[0]).sort(), [
    'command-run', 'process-import', 'process-launch'
  ]);
});

test('Git bypass gate follows require, promisify, and wrapper aliases', () => {
  const sites = collectExecutionSites(`
    const cp = require('node:child_process');
    const launch = cp.spawn;
    const { execFile: execute } = require('child_process');
    const promised = promisify(execute);
    cp.exec('git status');
    launch('git', ['status']);
    promised('git', ['status']);
    wrapper('git', ['status']);
  `, 'src/indirect-new.mjs');
  const kinds = sites.flatMap((site) => Array(site.count).fill(site.id.split(':')[0]));
  assert.equal(kinds.filter((kind) => kind === 'process-import').length, 2);
  assert.equal(kinds.filter((kind) => kind === 'process-launch').length, 3);
  assert.equal(kinds.filter((kind) => kind === 'command-git-literal').length, 1);
});

test('Git bypass gate sees direct Git and indirect shell wrappers', () => {
  const sites = collectExecutionSites(`#!/usr/bin/env bash
git status --short
GIT_BIN="$(command -v git)"
"$GIT_BIN" status
bash ./nested-wrapper.sh
`, 'distribution/new-wrapper.sh');
  assert.equal(sites.reduce((count, site) => count + site.count, 0), 4);
});

test('Git bypass gate freezes npm script wrappers', () => {
  const oldSites = collectPackageScriptSites('{"scripts":{"check":"node scripts/check.mjs"}}');
  const newSites = collectPackageScriptSites('{"scripts":{"check":"git status"}}');
  const file = 'package.json';
  assert.match(compareWithBaseline({ [file]: newSites }, summarizeSites({ [file]: oldSites }))[0], /differ from reviewed baseline/u);
});

test('Git bypass gate rejects added and changed legacy sites, including same-count replacement', () => {
  const file = 'src/legacy-new.mjs';
  const original = { [file]: collectExecutionSites("run('git', ['status']);", file) };
  const baseline = summarizeSites(original);
  assert.deepEqual(compareWithBaseline(original, baseline), []);

  const added = { [file]: collectExecutionSites("run('git', ['status']);\nrun('git', ['log']);", file) };
  assert.match(compareWithBaseline(added, baseline)[0], /differ from reviewed baseline/u);

  const replaced = { [file]: collectExecutionSites("run('git', ['push']);", file) };
  assert.match(compareWithBaseline(replaced, baseline)[0], /differ from reviewed baseline/u);
  const moved = { [file]: collectExecutionSites("function changedBoundary() { run('git', ['status']); }", file) };
  assert.match(compareWithBaseline(moved, baseline)[0], /differ from reviewed baseline/u);
  assert.match(compareWithBaseline({}, baseline)[0], /observed \{\}/u);
  assert.match(compareWithBaseline(added, {})[0], /baseline \{\}/u);
});

test('registered process owners are separate from frozen legacy allowance', () => {
  const file = REGISTERED_OWNERS[0];
  const actual = { [file]: collectExecutionSites("run('git', ['status']);", file) };
  assert.deepEqual(compareWithBaseline(actual, {}), []);
});
