import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCurrency } from '../src/build-currency.mjs';
import { sessionAgentResult } from '../src/session-agent-entry.mjs';

// Two laptops ran builds older than the fixes for the refusals they hit (2026-10-27), and nothing said
// so. The session entry every skill turn reads now says when this machine's SFlow is behind main.
test('an SFlow older than its checkout\'s main says so, from a cached answer, and nothing else does', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-currency-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const checkout = path.join(home, 'singularityflow');
  await mkdir(checkout);
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Currency Tester'); git('config', 'user.email', 'currency@example.invalid');
  for (const message of ['build', 'fix one', 'fix two']) git('commit', '-q', '--allow-empty', '-m', message);
  const [head, , build] = git('rev-list', 'HEAD').split('\n');
  await mkdir(path.join(home, '.singularity-flow', 'installations'), { recursive: true });
  await writeFile(path.join(home, '.singularity-flow', 'installations', 'current.json'), JSON.stringify({ schemaVersion: 2, checkout }));

  const requests = [];
  // Stands in for the detached `git ls-remote origin HEAD`: its output lands in the file named.
  const refresh = (repository, rawFile) => { requests.push(repository); execFileSync('sh', ['-c', `printf '%s\\tHEAD\\n' ${head} > "${rawFile}"`]); };
  let now = Date.parse('2026-10-28T09:00:00Z');
  const directory = path.join(home, '.singularity-flow', 'installations');
  const ask = (overrides = {}) => buildCurrency({ directory, now, commit: build, env: {}, refresh, ...overrides });

  assert.equal(ask(), null, 'the first call only asks; it never waits for the answer');
  assert.deepEqual(requests, [checkout]);
  now += 1000;
  const behind = ask();
  assert.deepEqual({ ...behind, commands: undefined }, { behind: 2, main: head, build, checkout, commands: undefined });
  assert.deepEqual(behind.commands, [`git -C ${checkout} pull --ff-only`, `singularity-flow reinstall --checkout ${checkout} --dry-run`]);
  assert.equal(requests.length, 1, 'a fresh answer is reused without asking again');

  assert.equal(ask({ commit: head }), null, 'a build at main says nothing');
  git('checkout', '-q', '-b', 'ahead'); git('commit', '-q', '--allow-empty', '-m', 'ahead of main');
  now += 1000;
  assert.equal(ask({ commit: git('rev-parse', 'HEAD') }), null, 'a build ahead of main says nothing');
  assert.equal(ask({ env: { SINGULARITY_FLOW_NO_UPDATE_CHECK: '1' } }), null);
  assert.equal(buildCurrency({ directory: path.join(home, 'nobody'), commit: build, env: {}, refresh }), null, 'no install record, nothing said');
  assert.equal(buildCurrency({ directory, commit: null, env: {}, refresh }), null, 'an unstamped development build says nothing');
  assert.equal(buildCurrency({ env: { SINGULARITY_FLOW_INSTALLATIONS_DIR: path.join(home, 'elsewhere') }, commit: build, refresh }), null,
    'the installations folder follows its redirect');

  // A checkout that has not fetched since the build still knows the build sits on its own main.
  const stale = path.join(home, 'stale-clone');
  execFileSync('git', ['clone', '-q', checkout, stale]);
  execFileSync('git', ['-C', checkout, 'checkout', '-q', 'main']);
  execFileSync('git', ['-C', checkout, 'commit', '-q', '--allow-empty', '-m', 'fix three']);
  const newer = git('rev-parse', 'main');
  await writeFile(path.join(home, '.singularity-flow', 'installations', 'current.json'), JSON.stringify({ schemaVersion: 2, checkout: stale }));
  const staleRefresh = (repository, rawFile) => execFileSync('sh', ['-c', `printf '%s\tHEAD\n' ${newer} > "${rawFile}"`]);
  const staleHead = execFileSync('git', ['-C', stale, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  now += 60 * 60 * 1000;
  assert.equal(buildCurrency({ directory, now, commit: staleHead, env: {}, refresh: staleRefresh }), null);
  now += 1000;
  assert.equal(buildCurrency({ directory, now, commit: staleHead, env: {}, refresh: staleRefresh })?.behind, 'unknown', 'main moved since the last fetch');

  const session = sessionAgentResult({ repositoryPath: home, ready: true, workId: 'W-1' }, 'singularity/work-items', { update: behind });
  assert.deepEqual(session.update, behind);
  assert.match(session.agentInstruction, /SFlow here is older than main \(update\.behind\): after this turn, tell the person once and show update\.commands\.$/u);
  assert.doesNotMatch(sessionAgentResult({ repositoryPath: home, ready: true }, 'singularity/work-items').agentInstruction, /older than main/u);
});

// The update warning reached only Copilot's agent entry; status and doctor print this line (2026-10-29).
test('the out-of-date-build line names how far behind and the update commands', async () => {
  const { buildCurrencyLine } = await import('../src/build-currency.mjs');
  assert.equal(buildCurrencyLine(null), null);
  const commands = ['git -C /src/sflow pull --ff-only', 'singularity-flow reinstall --checkout /src/sflow --dry-run'];
  assert.equal(buildCurrencyLine({ behind: 3, checkout: '/src/sflow', commands }),
    'SFlow here is 3 commits behind main of /src/sflow; update with: git -C /src/sflow pull --ff-only, then singularity-flow reinstall --checkout /src/sflow --dry-run');
  assert.match(buildCurrencyLine({ behind: 'unknown', checkout: '/src/sflow', commands }), /^SFlow here is older than main of \/src\/sflow;/u);
  assert.match(buildCurrencyLine({ behind: 1, checkout: '/x', commands }), /1 commit behind/u);
});
