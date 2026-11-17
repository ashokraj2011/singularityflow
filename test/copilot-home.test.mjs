/**
 * One Copilot home for SFlow and every Copilot it starts [11-17 daily run]. The model provider launched Copilot with an
 * environment allow-list that dropped COPILOT_HOME, so a Copilot started by Auto mode or a --model run kept its sessions,
 * logs, settings and plugins in ~/.copilot while SFlow, and the person's own Copilot, used COPILOT_HOME. The MCP readers
 * and the fresh-install reset read ~/.copilot whatever COPILOT_HOME said. src/copilot-home.mjs now holds the rule.
 *
 * Nothing here reads or writes the real ~/.copilot: every home and COPILOT_HOME is a folder this file created.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COPILOT_HOME_ENVIRONMENT, copilotHome } from '../src/copilot-home.mjs';
import { copilotSessionStateDirectory } from '../src/copilot-session-usage.mjs';
import { copilotSkillsDirectory } from '../src/direct-skills.mjs';
import { mcpHostInventory } from '../src/mcp.mjs';
import { mcpHostSources } from '../src/mcp-client.mjs';
import { inspectMcpHostEntries } from '../src/mcp-readiness.mjs';
import { stageModelPrompt } from '../src/model-prompt-transport.mjs';
import { invokeCopilotCli } from '../src/model-providers/copilot-cli.mjs';
import { verifyPluginInstallation } from '../src/plugin.mjs';
import { pluginInstalled, repositoryHookStatus } from '../src/repository-hooks.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const posix = process.platform !== 'win32' && !/\s/u.test(process.execPath);

async function ownFolder(t, name) {
  const folder = await mkdtemp(path.join(os.tmpdir(), `sflow-copilot-home-${name}-`));
  t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return folder;
}

/** Sets process.env for one test and puts back exactly what was there. */
function withEnvironment(t, values) {
  const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

/** A `copilot` program first on PATH that writes each launch's arguments and COPILOT_HOME to a record file. */
async function fakeCopilot(folder) {
  const bin = path.join(folder, 'bin');
  const record = path.join(folder, 'launches.jsonl');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'copilot'), [
    `#!${process.execPath}`,
    "const { appendFileSync } = require('node:fs');",
    `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), has: 'COPILOT_HOME' in process.env, home: process.env.COPILOT_HOME ?? null }) + '\\n');`,
    "if (process.argv.includes('--acp')) process.exit(3);",
    "process.stdout.write('fake copilot answer');",
    ''
  ].join('\n'));
  await chmod(path.join(bin, 'copilot'), 0o755);
  const launches = async () => (await readFile(record, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { bin, launches };
}

async function invokeFake(root, transport) {
  const staged = await stageModelPrompt({ text: 'which home?' }, { tempRoot: root });
  try {
    return await invokeCopilotCli({
      provider: 'copilot-cli', providerConfig: {}, cwd: root,
      prompt: { file: staged.file, sha256: staged.sha256, bytes: staged.bytes, encoding: staged.encoding, staged: true },
      promptTransport: transport, tools: { mode: 'none', names: [] },
      limits: { timeoutMs: 10_000, outputBytes: 4096 }
    });
  } finally { await staged.cleanup(); }
}

test('Copilot\'s home is COPILOT_HOME when set, else the home directory\'s .copilot', () => {
  const home = path.join(path.sep, 'people', 'a');
  assert.equal(copilotHome({ env: { COPILOT_HOME: ` ${path.join(path.sep, 'tools', 'copilot')} ` }, homeDirectory: home }),
    path.resolve(path.sep, 'tools', 'copilot'));
  assert.equal(copilotHome({ env: {}, homeDirectory: home }), path.join(home, '.copilot'));
  assert.equal(copilotHome({ env: { COPILOT_HOME: '  ' }, homeDirectory: home }), path.join(home, '.copilot'));
  assert.deepEqual(COPILOT_HOME_ENVIRONMENT, ['COPILOT_HOME']);
});

test('a Copilot the model provider starts gets COPILOT_HOME when it is set, and no COPILOT_HOME when it is not', { skip: !posix }, async (t) => {
  const folder = await ownFolder(t, 'launch');
  const root = path.join(folder, 'repo');
  const ownHome = path.join(folder, 'copilot-home');
  await mkdir(root, { recursive: true });
  const fake = await fakeCopilot(folder);
  withEnvironment(t, { PATH: `${fake.bin}${path.delimiter}${process.env.PATH}`, COPILOT_HOME: ownHome });

  // A --model run (attachment) and Auto mode (ACP) both start the configured `copilot` from PATH.
  const answered = await invokeFake(root, 'attachment');
  assert.equal(answered.output, 'fake copilot answer');
  await assert.rejects(invokeFake(root, 'acp-stdio'));
  let launches = await fake.launches();
  const attachment = launches.find((launch) => launch.argv.includes('--attachment'));
  const acp = launches.find((launch) => launch.argv.includes('--acp'));
  assert.ok(attachment && acp, JSON.stringify(launches));
  for (const launch of [attachment, acp]) assert.equal(launch.home, ownHome, `${launch.argv[0]}: ${JSON.stringify(launch)}`);

  // The plugin install and its checks start Copilot with the whole environment they are given.
  assert.throws(() => verifyPluginInstallation({ exists: () => true, env: { ...process.env } }));
  launches = await fake.launches();
  assert.equal(launches.find((launch) => launch.argv.join(' ') === 'plugin list --json')?.home, ownHome);

  delete process.env.COPILOT_HOME;
  const before = launches.length;
  await invokeFake(root, 'attachment');
  await assert.rejects(invokeFake(root, 'acp-stdio'));
  const unset = (await fake.launches()).slice(before).filter((launch) => !launch.argv.includes('--help'));
  assert.equal(unset.length, 2, JSON.stringify(unset));
  assert.ok(unset.every((launch) => launch.has === false), 'no COPILOT_HOME is made up for a person who has none');
});

test('Copilot\'s sessions are read from COPILOT_HOME: telemetry sessions follows it', async (t) => {
  const folder = await ownFolder(t, 'sessions');
  const root = path.join(folder, 'repo');
  const ownHome = path.join(folder, 'copilot-home');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'start');
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'schemaVersion: 1\n');
  const at = '2026-11-01T09:00:00.000Z';
  const line = (type, data) => JSON.stringify({ type, data, id: `${type}-1`, timestamp: at, parentId: null });
  await mkdir(path.join(ownHome, 'session-state', 'one'), { recursive: true });
  await writeFile(path.join(ownHome, 'session-state', 'one', 'events.jsonl'), `${[
    line('session.start', { sessionId: 'one', version: 1, producer: 'copilot-agent', copilotVersion: '1.0.112', startTime: at,
      selectedModel: 'model-alpha-1.5', context: { cwd: root, gitRoot: root, branch: 'main', hostType: 'github', repository: 'acme/payments' } }),
    line('session.usage_record', { usage: { model: 'model-alpha-1.5', responseModel: 'model-alpha-1.5-2026', inputTokens: 10, outputTokens: 4,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 1, initiator: 'user', interactionType: 'conversation-agent', isByok: false,
      isAuto: false, aiCreditsStatus: 'complete', copilotUsage: { totalNanoAiu: 1, tokenDetails: [] },
      accounting: { sourceSessionId: 'one', sequence: 1, usageId: 'one-usage-1' } } })
  ].join('\n')}\n`);

  assert.equal(copilotSessionStateDirectory({ COPILOT_HOME: ownHome }), path.join(ownHome, 'session-state'));
  // The suite runner's own session folder would win over COPILOT_HOME, so this run has none.
  const env = { ...process.env, COPILOT_HOME: ownHome };
  delete env.SINGULARITY_FLOW_COPILOT_SESSION_STATE;
  const result = spawnSync(process.execPath, [cli, 'telemetry', 'sessions', 'sync', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const synced = JSON.parse(result.stdout);
  assert.equal(synced.directory, path.join(ownHome, 'session-state'), result.stdout);
  assert.equal(synced.sync.added, 1, result.stdout);
});

test('MCP settings, plugins, skills and folder trust are read from COPILOT_HOME', async (t) => {
  const folder = await ownFolder(t, 'readers');
  const root = path.join(folder, 'repo');
  const home = path.join(folder, 'home');
  const ownHome = path.join(folder, 'copilot-home');
  for (const directory of [root, path.join(home, '.copilot'), ownHome]) await mkdir(directory, { recursive: true });
  // A decoy in the home directory's .copilot: reading it would mean COPILOT_HOME was ignored.
  await writeFile(path.join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { decoy: { command: 'decoy' } } }));
  await writeFile(path.join(ownHome, 'mcp-config.json'), JSON.stringify({ mcpServers: { corporate: { command: 'corporate' } } }));
  await writeFile(path.join(ownHome, 'config.json'), JSON.stringify({ trustedFolders: [root] }));
  const plugin = path.join(ownHome, 'installed-plugins', '_direct', 'singularity-flow');
  await mkdir(plugin, { recursive: true });
  await writeFile(path.join(plugin, 'plugin.json'), '{\n  "name": "singularity-flow"\n}\n');
  await writeFile(path.join(plugin, 'hook-launcher.sh'), '#!/bin/sh\n');
  withEnvironment(t, { COPILOT_HOME: ownHome });

  const user = (rows) => rows.filter((row) => row.surface === 'copilot-user');
  assert.deepEqual(user(await mcpHostInventory(root, { home })).map((row) => [row.name, row.path]), [['corporate', path.join(ownHome, 'mcp-config.json')]]);
  assert.deepEqual(user(await inspectMcpHostEntries(root, { home })).map((row) => row.name), ['corporate']);
  assert.equal(user(mcpHostSources(root, home))[0].file, path.join(ownHome, 'mcp-config.json'));
  assert.equal(copilotSkillsDirectory({ env: { COPILOT_HOME: ownHome }, homeDirectory: home }), path.join(ownHome, 'skills'));
  const env = { ...process.env, COPILOT_HOME: ownHome };
  assert.equal(await pluginInstalled(env), true);
  assert.equal(await pluginInstalled({ ...env, COPILOT_HOME: path.join(folder, 'empty') }), false, 'found only where COPILOT_HOME says');
  assert.equal((await repositoryHookStatus(root, { env })).trusted, true);
});

/**
 * Every place src/ starts Copilot CLI, and how the Copilot it starts finds its home. A new launch fails here until it is
 * added: `inherits` passes the parent's whole environment, COPILOT_HOME included; `listed` passes only listed variables
 * and must list COPILOT_HOME_ENVIRONMENT from src/copilot-home.mjs.
 */
const COPILOT_LAUNCHES = Object.freeze({
  'src/model-providers/copilot-cli.mjs': 'listed',
  'src/model-provider-capability.mjs': 'inherits',
  'src/host-session-launcher.mjs': 'inherits',
  'src/cli.mjs': 'inherits',
  'src/plugin.mjs': 'inherits',
  'src/reinstall.mjs': 'inherits',
  'src/product-uninstall.mjs': 'inherits'
});
// `run('copilot', [...])`, `executeOrThrow(invoke, 'copilot', [...])`, `resolvePlatformProcess('copilot', args`, a launch
// description's `command: 'copilot'` and a provider's default executable.
const LAUNCH = /\b\w+\(\s*(?:\w+\s*,\s*)?['"]copilot(?:\.cmd)?['"]\s*,\s*(?:\[|args\b)|\bcommand:\s*['"]copilot['"]|\bexecutable\s*(?:=|\?\?)\s*['"]copilot['"]/u;
// Copilot's home worked out anywhere but src/copilot-home.mjs: a `.copilot` folder name, or COPILOT_HOME read.
const HOME = /['"`]\.copilot(?=['"`/\\])|\.\s*COPILOT_HOME\b|\[\s*['"]COPILOT_HOME['"]\s*\]/u;

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(path.join(packageRoot, directory), { withFileTypes: true }).catch(() => [])) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !['node_modules', 'dist', 'out'].includes(entry.name)) found.push(...await sourceFiles(relative));
    else if (entry.isFile() && /\.(?:mjs|cjs|js|ts)$/u.test(entry.name)) found.push(relative);
  }
  return found;
}

test('every Copilot launch and every reader of Copilot\'s home go through src/copilot-home.mjs', async () => {
  const files = [...await sourceFiles('src'), ...await sourceFiles('apps/vscode/src')];
  assert.ok(files.includes('src/copilot-home.mjs') && files.includes('apps/vscode/src/views/copilot-extensions.ts'));
  const launching = [];
  const deriving = [];
  for (const file of files) {
    const text = await readFile(path.join(packageRoot, file), 'utf8');
    if (text.split('\n').some((line) => LAUNCH.test(line))) launching.push(file);
    if (file !== 'src/copilot-home.mjs' && text.split('\n').some((line) => !/^\s*(?:\/\/|\/?\*)/u.test(line) && HOME.test(line))) deriving.push(file);
  }
  assert.deepEqual(deriving, [], 'take Copilot\'s home from copilotHome() in src/copilot-home.mjs');
  assert.deepEqual(launching.sort(), Object.keys(COPILOT_LAUNCHES).sort(),
    'a new Copilot launch: add it to COPILOT_LAUNCHES and keep COPILOT_HOME in what it passes');
  for (const [file, how] of Object.entries(COPILOT_LAUNCHES)) {
    if (how !== 'listed') continue;
    const text = await readFile(path.join(packageRoot, file), 'utf8');
    assert.match(text, /import \{ COPILOT_HOME_ENVIRONMENT \} from '\.\.?\/(?:\.\.\/)?copilot-home\.mjs';/u, file);
    assert.match(text, /\.\.\.COPILOT_HOME_ENVIRONMENT\b/u, `${file} must keep COPILOT_HOME_ENVIRONMENT in its list`);
  }
});
