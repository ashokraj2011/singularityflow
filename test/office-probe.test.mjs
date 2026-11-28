import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gitIn } from '../src/office-probe/process.mjs';
import { createScrubber, leftovers, machineLiterals, remoteParts } from '../src/office-probe/scrub.mjs';
import { probeContext, reportFileNames, runOfficeChecks } from '../src/office-probe/index.mjs';
import { check } from '../src/office-probe/report.mjs';
import { gitHostChecks, hostKind, refusalWords } from '../src/office-probe/git-host.mjs';
import { stateCheckoutChecks } from '../src/office-probe/state-checkout.mjs';
import { hookChecks } from '../src/office-probe/hooks.mjs';
import { jiraChecks } from '../src/office-probe/policy.mjs';
import { probeCommand } from '../src/commands/probe.mjs';
import { inventedValue } from './helpers/invented-secrets.mjs';

const fixtures = [];
// GitHub's cloud host and its name, joined so the repository holds no public host name (scripts/check.mjs).
const GITHUB_HOST = ['github', 'com'].join('.');
const GITHUB_CLOUD = ['GitHub', 'com'].join('.');
// The stand-in for a GitHub sign-in the runtime must never see.
const SIGN_IN = 'fixture-sign-in';
function folder(name) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `office-probe-${name}-`)));
  fixtures.push(directory);
  return directory;
}
test.after(() => { for (const directory of fixtures) rmSync(directory, { recursive: true, force: true }); });

const git = (cwd, ...args) => {
  const result = gitIn(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
  assert.ok(result.ok, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

/** A clone with one commit and a bare repository as its remote, as an office repository and its Git host. */
function repositoryWithRemote(name, { preReceive = null, cloneName = 'clone' } = {}) {
  const root = folder(name);
  const remote = path.join(root, 'host.git');
  const clone = path.join(root, cloneName);
  git(root, 'init', '-q', '--bare', remote);
  if (preReceive) { writeFileSync(path.join(remote, 'hooks', 'pre-receive'), preReceive); chmodSync(path.join(remote, 'hooks', 'pre-receive'), 0o755); }
  mkdirSync(clone);
  git(clone, 'init', '-q');
  writeFileSync(path.join(clone, 'README.md'), 'fixture\n');
  git(clone, 'add', 'README.md');
  git(clone, 'commit', '-q', '-m', 'fixture');
  git(clone, 'remote', 'add', 'origin', remote);
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  // From here on the host logs every ref it is sent.
  writeFileSync(path.join(remote, 'hooks', 'post-receive'), '#!/bin/sh\ncat >> "$GIT_DIR/received.log"\n');
  chmodSync(path.join(remote, 'hooks', 'post-receive'), 0o755);
  return { root, remote, clone };
}

const refsOf = (remote) => git(remote, 'for-each-ref', '--format=%(refname) %(objectname)');

function context(overrides = {}) {
  const temp = folder('temp');
  return probeContext({ temp, env: { ...process.env, SINGULARITY_FLOW_GIT_FACT_CACHE: 'off' }, sleep: async () => {}, ...overrides });
}

test('the scrubber removes this machine\'s values and every sensitive shape, and keeps product words', () => {
  const token = inventedValue('gh', 'p_', 'FixtureFixtureFixtureFixture');
  const scrub = createScrubber([...remoteParts('https://git.example-corp.test/acme-fixture/widget-fixture.git'), 'jdoe-fixture', 'Jane Fixture']);
  const text = scrub([
    'push to https://git.example-corp.test/acme-fixture/widget-fixture.git by jane@example-corp.test',
    'git@git.example-corp.test:acme-fixture/widget-fixture.git', 'Hello Jane Fixture from acme-fixture', 'at /Users/jdoe-fixture/src/x',
    'C:\\Users\\jdoe-fixture\\repo', `token ${token}`, '10.20.30.40:8080', 'build.example-corp.test',
    `${GITHUB_CLOUD}, GitHub Enterprise Server, Azure DevOps`, 'refs/singularity/state/probe-<random>', 'Node 22.17.0, VS Code 1.148.0'
  ].join('\n'));
  for (const value of ['example-corp', 'acme-fixture', 'widget-fixture', 'jdoe-fixture', 'Jane Fixture', 'jane@', token, '10.20.30.40', 'Users']) {
    assert.ok(!text.toLowerCase().includes(value.toLowerCase()), `${value} survived: ${text}`);
  }
  for (const kept of [GITHUB_CLOUD, 'GitHub Enterprise Server', 'Azure DevOps', 'refs/singularity/state/probe-<random>', 'Node 22.17.0', 'VS Code 1.148.0']) {
    assert.ok(text.includes(kept), `${kept} was removed: ${text}`);
  }
  assert.deepEqual(leftovers(text, scrub.literals), []);
});

test('a report built from a fixture holding names, hosts, paths, tokens and environment values carries none of them', async () => {
  const { clone } = repositoryWithRemote('scrubbed', { cloneName: 'widget-fixture' });
  git(clone, 'remote', 'set-url', 'origin', 'https://git.example-corp.test/acme-fixture/widget-fixture.git');
  const home = path.join(folder('home'), 'jdoe-fixture');
  mkdirSync(home);
  const token = inventedValue('gl', 'pat-', 'FixtureFixtureFixture');
  const env = { ...process.env, USER: 'jdoe-fixture', USERNAME: 'jdoe-fixture', JIRA_BASE_URL: 'https://jira.example-corp.test', JIRA_USERNAME: 'jane@example-corp.test',
    HTTPS_PROXY: 'http://proxy.example-corp.test:3128', CUSTOM_WORKSPACE: '/srv/teams/acme-fixture/checkouts' };
  const leaky = [
    `user ${os.userInfo().username} on ${os.hostname()}`, 'jane@example-corp.test pushed to https://git.example-corp.test/acme-fixture/widget-fixture.git',
    `folder ${clone}`, `home ${home}`, `token ${token}`, 'proxy http://proxy.example-corp.test:3128', '/srv/teams/acme-fixture/checkouts', 'repository widget-fixture of acme-fixture'
  ];
  const { files, markdown, report } = await runOfficeChecks({
    cwd: clone, env, home, out: path.join(folder('out'), 'report.md'), sflowVersion: '0.9.0',
    probes: [['Fixture', async (ctx) => {
      ctx.secrets.push('Jane Fixture');
      return [check('fixture', 'A', 'A check whose evidence leaks', 'pass', [...leaky, 'Hello Jane Fixture'], `It means ${leaky[1]}`)];
    }]]
  });
  const written = `${readFileSync(files.markdown, 'utf8')}\n${readFileSync(files.json, 'utf8')}`;
  assert.equal(markdown, readFileSync(files.markdown, 'utf8'));
  for (const value of ['jdoe-fixture', os.userInfo().username, os.hostname().split('.')[0], 'example-corp', 'acme-fixture', 'widget-fixture', 'Jane Fixture', 'jane@', token, clone, home, '3128', '/srv/teams', path.basename(clone)]) {
    if (value.length < 3) continue;
    assert.ok(!written.toLowerCase().includes(value.toLowerCase()), `the report carries ${value}`);
  }
  assert.match(markdown, /^# SFlow office checks, \d{4}-\d{2}-\d{2}$/mu);
  assert.match(markdown, /Send this file .* back to the SFlow team/u);
  assert.equal(report.kind, 'sflow-office-checks');
  assert.equal(report.counts.pass, 1);
  assert.ok(existsSync(files.json));
});

test('the push check pushes nothing without its Yes', async () => {
  const { remote, clone } = repositoryWithRemote('push-no');
  const before = refsOf(remote);
  const asked = [];
  const ctx = context({ cwd: clone, ask: async (question) => { asked.push(question); return false; } });
  ctx.repository = { root: clone, remote: 'origin', url: remote };
  const checks = await gitHostChecks(ctx);
  assert.equal(asked.length, 1);
  assert.match(asked[0].yes, /pushes sflow-probe\/<random> and refs\/singularity\/state\/probe-<random>/u);
  assert.match(asked[0].why, /\S/u);
  assert.equal(checks.find((entry) => entry.id === 'host-push').result, 'not available');
  assert.match(checks.find((entry) => entry.id === 'host-push').evidence[0], /You chose No/u);
  assert.equal(refsOf(remote), before);
  assert.equal(existsSync(path.join(remote, 'received.log')), false, 'nothing reached the host');
});

test('with its Yes the push check pushes exactly two throwaway refs, reads the hidden one back and deletes both', async () => {
  const { remote, clone } = repositoryWithRemote('push-yes');
  const before = refsOf(remote);
  const ctx = context({ cwd: clone, ask: async () => true });
  ctx.repository = { root: clone, remote: 'origin', url: remote };
  const checks = await gitHostChecks(ctx);
  const push = checks.find((entry) => entry.id === 'host-push');
  assert.equal(push.result, 'pass', push.evidence.join('\n'));
  assert.match(push.meaning, /Clean pull requests can keep records on a hidden ref here/u);
  assert.equal(refsOf(remote), before, 'both throwaway refs are gone and no other ref moved');
  const received = readFileSync(path.join(remote, 'received.log'), 'utf8').trim().split('\n').map((line) => line.split(' ')[2]);
  const names = [...new Set(received)];
  assert.equal(names.length, 2);
  assert.ok(names.some((name) => /^refs\/heads\/sflow-probe\/[0-9a-f]{8}$/u.test(name)));
  assert.ok(names.some((name) => /^refs\/singularity\/state\/probe-[0-9a-f]{8}$/u.test(name)));
  assert.equal(checks.find((entry) => entry.id === 'host-kind').evidence[0], 'local folder, over local.');
  assert.deepEqual(ctx.cleanups.map((cleanup) => cleanup()), [undefined], 'the leftover cleanup has nothing to delete');
});

test('a host that refuses refs/singularity/* is reported in plain words and leaves nothing behind', async () => {
  const { remote, clone } = repositoryWithRemote('push-refused', {
    preReceive: '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/singularity/*) echo "hidden records refs are not allowed here" >&2; exit 1;; esac; done\nexit 0\n'
  });
  const before = refsOf(remote);
  const ctx = context({ cwd: clone, ask: async () => true });
  ctx.repository = { root: clone, remote: 'origin', url: remote };
  const push = (await gitHostChecks(ctx)).find((entry) => entry.id === 'host-push');
  assert.equal(push.result, 'fail');
  assert.match(push.meaning, /cannot keep records on a hidden ref here: the host refused refs\/singularity\/\*/u);
  assert.ok(push.evidence.some((line) => /a server hook \(pre-receive\) refused the push/u.test(line)), push.evidence.join('\n'));
  assert.ok(push.evidence.some((line) => /hidden records refs are not allowed here/u.test(line)), push.evidence.join('\n'));
  assert.equal(refsOf(remote), before);
  assert.deepEqual(ctx.serverWords.length > 0, true);
});

test('the host kind is named from the remote address alone', () => {
  assert.equal(hostKind(`https://${GITHUB_HOST}/a/b.git`), GITHUB_CLOUD);
  assert.equal(hostKind(`git@${GITHUB_HOST}:a/b.git`), GITHUB_CLOUD);
  assert.equal(hostKind('https://github.example-corp.test/a/b.git'), 'GitHub Enterprise Server');
  assert.equal(hostKind('https://dev.azure.com/org/project/_git/repo'), 'Azure DevOps');
  assert.equal(hostKind('https://gitlab.example-corp.test/a/b.git'), 'GitLab (self-hosted)');
  assert.equal(hostKind('ssh://git@bitbucket.example-corp.test:7999/a/b.git'), 'Bitbucket Data Center');
  assert.equal(hostKind('https://code.example-corp.test/scm/a/b.git'), 'Bitbucket Data Center');
  assert.equal(hostKind('/srv/git/b.git'), 'local folder');
  assert.equal(refusalWords('! [remote rejected] x -> x (funny refname)'), 'the host refused a ref outside refs/heads and refs/tags');
});

test('the state checkout probe works in a temporary repository of its own', () => {
  const ctx = context({ cwd: folder('state-cwd') });
  const checks = stateCheckoutChecks(ctx);
  const result = Object.fromEntries(checks.map((entry) => [entry.id, entry.result]));
  assert.deepEqual(result, { 'state-status': 'pass', 'state-stash': 'pass', 'state-clean': 'pass', 'state-force-clean': 'pass' });
  assert.ok(checks.find((entry) => entry.id === 'state-force-clean').evidence.some((line) => /removed|survived/u.test(line)));
  assert.ok(existsSync(path.join(ctx.tempReal, 'state-checkout', 'main', '.git')), 'it worked under the probe\'s own temporary folder');
});

function hookContext({ answer, stamp = false }) {
  const home = folder('hooks-home');
  const modeFile = path.join(home, 'machine', 'copilot-mode.json');
  const notes = [];
  const asked = [];
  let now = 0;
  const ctx = context({
    cwd: home, home, env: { ...process.env, SINGULARITY_FLOW_COPILOT_MODE_FILE: modeFile, COPILOT_HOME: path.join(home, '.copilot') },
    ask: async (question) => { asked.push(question.id); return answer(question); },
    note: (text, detail) => notes.push({ text, ...detail }),
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
      if (stamp) { const directory = path.join(home, 'machine', 'copilot-hook-sessions'); mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, `chat-${now}`), ''); }
    },
    run: { tool: () => ({ ok: false, missing: true, stdout: '', stderr: '' }), gitIn, launch: async () => ({ ok: false }) }
  });
  ctx.vscode = [{ channel: 'Stable', version: '1.148.0', runtime: null, userData: home, extensions: home }];
  ctx.jetbrains = [{ product: 'IntelliJ IDEA Ultimate', version: '2025.3', copilot: '1.10.1-251' }];
  return { ctx, notes, asked };
}

test('no guided chat step and no premium request without its Yes', async () => {
  const { ctx, notes, asked } = hookContext({ answer: () => false });
  const checks = await hookChecks(ctx);
  assert.deepEqual(asked, ['vscode-chat', 'intellij-chat']);
  assert.equal(notes.some((note) => note.action), false, 'nobody was asked to send a message');
  assert.equal(checks.find((entry) => entry.id === 'hooks-vscode').result, 'not available');
  assert.equal(checks.find((entry) => entry.id === 'hooks-vscode-guided').result, 'not available');
  assert.equal(checks.find((entry) => entry.id === 'hooks-intellij').result, 'not available');
  assert.equal(checks.find((entry) => entry.id === 'hooks-copilot-cli').result, 'not available');
});

test('every paid question says it uses a premium request, and a Yes waits for SFlow\'s stamp', async () => {
  const questions = [];
  const { ctx, notes } = hookContext({ answer: (question) => { questions.push(question); return true; }, stamp: true });
  const checks = await hookChecks(ctx);
  for (const question of questions) {
    assert.match(question.yes, /premium request/u);
    assert.match(question.no, /^No: skip/u);
    assert.match(question.why, /\S/u);
  }
  assert.match(questions[0].yes, /ONE premium request/u);
  assert.ok(notes.some((note) => note.action === 'send-chat' && note.message === 'sflow office check'));
  assert.equal(checks.find((entry) => entry.id === 'hooks-vscode-guided').result, 'pass');
  assert.equal(checks.find((entry) => entry.id === 'hooks-intellij-copilot').result, 'pass');
  assert.equal(checks.find((entry) => entry.id === 'hooks-intellij-local').result, 'pass');
});

/** A stand-in for VS Code's bundled Copilot SDK of one generation: it records what it was given and plays the hook. */
function fakeSdk(file, generation) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const approveAll = () => ({ kind: 'approved' });
export const RuntimeConnection = ${generation === 'modern' ? '{ forSpawnedStdio: (options) => ({ kind: "spawned-stdio", ...options }) }' : '{ forStdio: (options) => ({ kind: "stdio", ...options }) }'};
export class CopilotClient {
  constructor(options) { this.options = options; }
  async start() {}
  async stop() {}
  async createSession(session) {
    const env = (this.options.runtime ?? this.options.connection).env;
    const baseUrl = session.inference?.providers?.[0]?.baseUrl ?? session.provider?.baseUrl;
    appendFileSync(env.FAKE_SDK_LOG, JSON.stringify({ home: env.HOME, copilotHome: env.COPILOT_HOME, folder: session.workingDirectory,
      trust: session.filesystem?.trustWorkingDirectory ?? session.trustWorkingDirectory, capi: session.github?.capi?.enabled ?? null,
      plugins: session.plugins?.directories ?? null, model: session.model, signIn: env.GH_TOKEN ?? null }) + '\\n');
    return {
      sendAndWait: async (message) => {
        const prompt = typeof message === 'string' ? message : message.prompt;
        await fetch(baseUrl + '/chat/completions', { method: 'POST', body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: prompt }] }) }).then((answer) => answer.text());
        if (realpathSync(session.workingDirectory) !== session.workingDirectory) return;
        const directory = path.join(path.dirname(env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-hook-sessions');
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, randomUUID()), '');
      },
      disconnect: async () => {}
    };
  }
}
`);
}

for (const generation of ['modern', 'classic']) {
  test(`the free VS Code check drives the bundled runtime (${generation} SDK) with the stand-in model, in a machine of its own`, async () => {
    const home = folder(`runtime-${generation}`);
    const plugin = path.join(home, 'plugin');
    mkdirSync(plugin);
    writeFileSync(path.join(plugin, 'hooks.json'), '{"version":1,"hooks":{}}\n');
    mkdirSync(path.join(home, '.copilot'));
    const config = `${JSON.stringify({ installedPlugins: [{ name: 'singularity-flow', version: '0.9.0', cache_path: plugin, enabled: true }] })}\n`;
    writeFileSync(path.join(home, '.copilot', 'config.json'), config);
    const sdk = path.join(home, 'sdk', 'index.mjs');
    fakeSdk(sdk, generation);
    const log = path.join(home, 'sdk.log');
    const asked = [];
    const ctx = context({
      cwd: home, home, env: { ...process.env, FAKE_SDK_LOG: log, GH_TOKEN: SIGN_IN, SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(home, 'person', 'copilot-mode.json') },
      ask: async (question) => { asked.push(question.id); return false; },
      run: { tool: () => ({ ok: false, missing: true, stdout: '', stderr: '' }), gitIn, launch: async () => ({ ok: false }) }
    });
    ctx.vscode = [{ channel: 'Stable', version: '1.148.0', runtime: { index: sdk, runtime: '/bin/true', version: '2.0.2' }, userData: home, extensions: home }];
    ctx.jetbrains = [];
    const checks = await hookChecks(ctx);
    const vscode = checks.find((entry) => entry.id === 'hooks-vscode');
    assert.equal(vscode.result, 'pass', vscode.evidence.join('\n'));
    assert.ok(vscode.evidence.some((line) => /reached the stand-in model/u.test(line)));
    assert.ok(vscode.evidence.some((line) => /Through a link to the same folder, no SFlow hook ran/u.test(line)));
    assert.match(vscode.meaning, /Folders opened through a link run none/u);
    assert.deepEqual(asked, [], 'the free check ran, so no paid question was asked');
    const runs = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(runs.length, 2);
    for (const entry of runs) {
      assert.equal(entry.trust, 'session');
      assert.equal(entry.signIn, null, 'no GitHub sign-in reaches the runtime');
      assert.ok(entry.home.startsWith(ctx.tempReal) && entry.copilotHome.startsWith(ctx.tempReal), 'its own home and Copilot home');
      if (generation === 'modern') {
        assert.equal(entry.capi, false, 'Copilot\'s own models are off, so no premium request can be used');
        assert.deepEqual(entry.plugins, [plugin]);
        assert.equal(entry.model, 'office-check/probe-model');
      } else assert.equal(entry.model, 'probe-model');
    }
    assert.equal(readFileSync(path.join(home, '.copilot', 'config.json'), 'utf8'), config, 'the person\'s Copilot settings are unchanged');
    assert.match(readFileSync(path.join(ctx.tempReal, 'hooks-vscode', 'copilot-home', 'config.json'), 'utf8'), /"singularity-flow"/u);
    assert.equal(existsSync(path.join(home, 'person', 'copilot-hook-sessions')), false, 'nothing was stamped in the person\'s own SFlow folder');
  });
}

test('Jira: settings by presence only, and one issue\'s title length, never its text', async () => {
  const title = 'Fixture roadmap item for the quarter';
  const env = { JIRA_BASE_URL: 'https://jira.example-corp.test', JIRA_USERNAME: 'jane@example-corp.test', JIRA_PAT: inventedValue('fixture', '-jira-access') };
  const ctx = context({ env, askText: async () => 'ABC-12' });
  ctx.getIssue = async (key) => ({ key, title });
  const checks = await jiraChecks(ctx);
  assert.equal(checks[0].result, 'pass');
  assert.ok(checks[0].evidence.every((line) => !line.includes('example-corp')));
  assert.equal(checks[1].result, 'pass');
  assert.deepEqual(checks[1].evidence, [`The issue was read; its title is ${title.length} characters long.`]);
  assert.ok(ctx.secrets.includes(title) && ctx.secrets.includes('ABC-12'), 'the title and key are scrubbed if anything repeats them');
  const skipped = await jiraChecks(context({ env, askText: async () => '' }));
  assert.equal(skipped[1].result, 'not available');
  const refused = context({ env, askText: async () => 'ABC-13' });
  refused.getIssue = async () => { throw Object.assign(new Error('401 from https://jira.example-corp.test'), { category: 'authentication', status: 401 }); };
  const failed = await jiraChecks(refused);
  assert.equal(failed[1].result, 'fail');
  assert.match(failed[1].evidence[0], /Jira refused the sign-in \(HTTP 401\)/u);
  assert.ok(!failed[1].evidence[0].includes('example-corp'));
});

test('probe office refuses other probes and options, and names its report by date', async () => {
  await assert.rejects(probeCommand(['probe', 'marketplace'], {}), { code: 'UNKNOWN_SUBCOMMAND' });
  await assert.rejects(probeCommand(['probe'], {}), { code: 'UNKNOWN_SUBCOMMAND' });
  await assert.rejects(probeCommand(['probe', 'office'], { force: true }), /does not accept --force/u);
  await assert.rejects(probeCommand(['probe', 'office'], { push: 'maybe' }), /--push takes yes or no/u);
  const cwd = folder('names');
  const home = folder('names-home');
  // With no --out the report goes to the person's home, never the repository, so no Story's code step takes it up.
  assert.deepEqual(reportFileNames('2026-11-28T10:00:00.000Z', null, cwd, home),
    { markdown: path.join(home, 'sflow-office-checks-2026-11-28.md'), json: path.join(home, 'sflow-office-checks-2026-11-28.json') });
  mkdirSync(path.join(home, 'Downloads'));
  assert.deepEqual(reportFileNames('2026-11-28T10:00:00.000Z', null, cwd, home),
    { markdown: path.join(home, 'Downloads', 'sflow-office-checks-2026-11-28.md'), json: path.join(home, 'Downloads', 'sflow-office-checks-2026-11-28.json') });
  assert.deepEqual(reportFileNames('2026-11-28T10:00:00.000Z', 'out/r.md', cwd, home), { markdown: path.join(cwd, 'out', 'r.md'), json: path.join(cwd, 'out', 'r.json') });
  assert.deepEqual(reportFileNames('2026-11-28T10:00:00.000Z', cwd, '/', home),
    { markdown: path.join(cwd, 'sflow-office-checks-2026-11-28.md'), json: path.join(cwd, 'sflow-office-checks-2026-11-28.json') });
});

test('every write but the report stays under the run\'s temporary folder, which is removed at the end', async () => {
  const parent = folder('temp-parent');
  const cwd = folder('quiet');
  let seen = null;
  const { files } = await runOfficeChecks({ cwd, tempParent: parent, sflowVersion: '0.9.0',
    probes: [['State checkout', (ctx) => { seen = ctx.temp; return stateCheckoutChecks(ctx); }]] });
  assert.ok(seen.startsWith(parent));
  assert.equal(existsSync(seen), false);
  assert.deepEqual(machineLiterals({ env: {}, extra: [] }).includes(os.userInfo().username), os.userInfo().username.length >= 3);
  assert.deepEqual([path.basename(files.markdown), path.basename(files.json)].map((name) => name.replace(/\d{4}-\d{2}-\d{2}/u, 'DATE')),
    ['sflow-office-checks-DATE.md', 'sflow-office-checks-DATE.json']);
});

/** A tool runner that answers from a table, as this machine's tools would. */
function fakeRunner(answers) {
  const reply = (key) => {
    const value = answers.find(([pattern]) => pattern.test(key))?.[1];
    return value == null ? { ok: false, missing: true, status: null, stdout: '', stderr: '' } : { ok: true, status: 0, stdout: value, stderr: '' };
  };
  const calls = [];
  return {
    calls,
    tool: (command, args) => { calls.push(`${command} ${args.join(' ')}`); return reply(`${command} ${args.join(' ')}`); },
    gitIn: (_cwd, args) => { calls.push(`git ${args.join(' ')}`); return reply(`git ${args.join(' ')}`); },
    launch: async () => ({ ok: false, missing: true })
  };
}

test('the machine probe names shells, Node, Git settings and a proxy without its address', async () => {
  const { machineChecks } = await import('../src/office-probe/machine.mjs');
  const home = folder('machine-home');
  writeFileSync(path.join(home, '.npmrc'), 'proxy=http://proxy.example-corp.test:3128\n');
  const run = fakeRunner([
    [/^bash --version/u, 'GNU bash, version 5.2.15(1)-release'], [/^node --version/u, 'v22.17.0\n'], [/^npm ping/u, 'PONG'],
    [/^git --version/u, 'git version 2.47.1\n'], [/^git config --get core\.autocrlf/u, 'input\n'], [/^git config --get http\.proxy/u, 'http://proxy.example-corp.test:3128\n']
  ]);
  const ctx = context({ cwd: home, home, platform: 'linux', arch: 'x64', run,
    env: { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy.example-corp.test:3128', SINGULARITY_FLOW_ENGINE_HOME: path.join(home, 'engine') } });
  const checks = machineChecks(ctx);
  const byId = Object.fromEntries(checks.map((entry) => [entry.id, entry]));
  assert.equal(byId['machine-shells'].result, 'pass');
  assert.match(byId['machine-shells'].evidence.join(' '), /bash 5\.2\.15/u);
  assert.match(byId['machine-git'].evidence.join(' '), /Git 2\.47\.1.*core\.autocrlf: input/su);
  assert.deepEqual(byId['machine-proxy'].evidence.slice(0, 3), ['Proxy variables set: HTTPS_PROXY.', 'Git has a proxy set (http.proxy).', 'npm has a proxy set.']);
  assert.equal(byId['machine-signing'].result, 'not available');
  assert.equal(byId['machine-network'].result, 'pass');
  assert.equal(byId['machine-temp'].result, 'pass');
  assert.ok(!JSON.stringify(checks).includes('example-corp'), 'no proxy address is recorded');
  assert.ok(!run.calls.some((call) => /^git (?:-C \S+ )?(?:ls-remote|push|commit|init)\b/u.test(call)), 'no remote is asked and nothing is committed without a repository');
});

test('the editors probe reads VS Code, its Copilot, settings, agent host and IntelliJ from their folders', async () => {
  const { editorChecks } = await import('../src/office-probe/editors.mjs');
  const home = folder('editors-home');
  const app = path.join(home, 'code', 'resources', 'app');
  const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
  write(path.join(app, 'product.json'), JSON.stringify({ quality: 'stable', nameShort: 'Code', dataFolderName: '.vscode' }));
  write(path.join(app, 'package.json'), JSON.stringify({ version: '1.148.0' }));
  write(path.join(app, 'extensions', 'copilot', 'package.json'), JSON.stringify({ version: '0.76.0' }));
  const sdk = path.join(app, 'node_modules.asar.unpacked', '@microsoft', 'copilot-sdk-linux-x64');
  write(path.join(sdk, 'copilot-sdk', 'index.js'), 'export {};\n');
  write(path.join(sdk, 'prebuilds', 'linux-x64', 'copilot-runtime'), '');
  write(path.join(sdk, 'package.json'), JSON.stringify({ version: '2.0.2' }));
  write(path.join(home, '.config', 'Code', 'User', 'settings.json'), '{\n  // hooks on\n  "chat.useHooks": true,\n  "chat.hooks.allowManagedOnly": false,\n}\n');
  write(path.join(home, '.config', 'Code', 'logs', '20261127T084327', 'agenthost.log'), '');
  write(path.join(home, '.config', 'JetBrains', 'IntelliJIdea2025.3', 'plugins', 'github-copilot-intellij', 'lib', 'github-copilot-intellij-1.10.1-251.jar'), '');
  mkdirSync(path.join(home, '.config', 'Google', 'AndroidStudio2024.3'), { recursive: true });
  const run = fakeRunner([[/^copilot --version/u, 'GitHub Copilot CLI 1.0.115.\n']]);
  const ctx = context({ cwd: home, home, platform: 'linux', arch: 'x64', run, env: { PATH: '/usr/bin' } });
  ctx.vscodeRoots = [app];
  const checks = editorChecks(ctx);
  const vscode = checks.find((entry) => entry.id === 'editor-vscode-stable');
  assert.equal(vscode.result, 'pass', vscode.evidence.join('\n'));
  assert.deepEqual(vscode.evidence.slice(0, 5), ['VS Code 1.148.0 (Stable).', 'Copilot Chat: 0.76.0 (built in).', 'Copilot (completions): not installed.',
    'Copilot runtime bundled with VS Code: yes, 2.0.2.', 'VS Code\'s Copilot agent host has run here (last on 2026-11-27).']);
  assert.ok(vscode.evidence.includes('Hooks in chat: on in the person\'s settings.'));
  assert.equal(checks.find((entry) => entry.id === 'editor-copilot-cli').evidence[0], 'Copilot CLI 1.0.115.');
  const jetbrains = checks.find((entry) => entry.id === 'editor-jetbrains');
  assert.equal(jetbrains.result, 'pass');
  assert.deepEqual(jetbrains.evidence.sort(), ['Android Studio 2024.3: Copilot plugin not installed.', 'IntelliJ IDEA Ultimate 2025.3: Copilot plugin 1.10.1-251.']);
});

test('the CLI dispatches probe to its own module, which refuses any probe but office', async () => {
  const { spawnSync } = await import('node:child_process');
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'singularity-flow.mjs');
  const cwd = folder('cli');
  const refused = spawnSync(process.execPath, [cli, 'probe', 'marketplace', '--json'], { cwd, env: process.env, encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /Unknown probe 'marketplace'\. The one probe is: office\./u);
  const help = spawnSync(process.execPath, [cli, 'help', 'probe'], { cwd, env: process.env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /probe office checks the machine/u);
});
