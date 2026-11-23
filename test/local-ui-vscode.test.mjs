import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { startService } from '../src/local-ui/server.mjs';
import { control } from '../src/local-ui/client.mjs';
import { serviceDirectory, cliPath } from '../src/local-ui/private-state.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
async function launcher(api) {
  const output = await build({ entryPoints: [path.join(root, 'apps/vscode/src/browser-workspace.ts')], platform: 'node',
    format: 'cjs', bundle: true, write: false, external: ['vscode'], logLevel: 'silent' });
  const entry = path.join(root, 'apps/vscode/dist/test-browser-launcher.cjs');
  const compiled = new Module(entry);
  const require = createRequire(entry);
  compiled.require = name => name === 'vscode' ? api : require(name);
  compiled._compile(output.outputFiles[0].text, entry);
  return compiled.exports.openBrowserWorkspace;
}
function host({ remote = null } = {}) {
  const opened = [], commands = [];
  return { opened, commands, api: {
    env: { remoteName: remote, uiKind: 1, openExternal: async uri => { opened.push(uri); return true; } },
    UIKind: { Web: 2, Desktop: 1 }, Uri: { parse: value => value },
    extensions: { getExtension: () => ({ id: 'GitHub.copilot-chat' }) },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    commands: { executeCommand: async (...args) => { commands.push(args); } }
  } };
}
test('VS Code launches the independent browser once, without a folder switch; Copilot is only prefilled', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-browser-host-'));
  const original = { ...process.env }, env = isolatedTestEnvironment(base);
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  Object.assign(process.env, env);
  const disposables = [];
  let service;
  t.after(async () => {
    for (const disposable of disposables) disposable.dispose();
    await service?.close();
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, original);
    await rm(base, { recursive: true, force: true });
  });
  const connectionDirectory = path.join(base, 'native-connection-override');
  assert.notEqual(connectionDirectory, serviceDirectory());
  service = await startService({ directory: connectionDirectory });
  const clientId = randomUUID(), selected = await realpath(base);
  let grant = { ...await control(service.descriptor, 'bootstrap', { root: selected, clientId }),
    discoveryFile: path.join(connectionDirectory, 'instance.json'), bridgeModule: path.join(root, 'src/local-ui/bridge-client.mjs') };
  const client = { repository: selected, location: { cli: cliPath }, run: async args => { assert.deepEqual(args, ['ui', 'open', '--no-open', '--json']); return grant; } };
  const mocked = host(), logs = [], open = await launcher(mocked.api);
  await open(client, { subscriptions: disposables }, { appendLine: line => logs.push(line) });
  assert.deepEqual(mocked.opened, [grant.url]);
  assert.deepEqual(mocked.commands, [], 'opening the browser does not switch a folder or call a model');
  const ticket = new URLSearchParams(new URL(grant.url).hash.slice(1)).get('ticket');
  const response = await fetch(`${service.descriptor.origin}/api/session`, { method: 'POST', headers: { Origin: service.descriptor.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  const session = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal(session.capabilities.copilot, true);
  grant = { ...await control(service.descriptor, 'bootstrap', { root: selected, clientId: randomUUID() }),
    discoveryFile: path.join(connectionDirectory, 'instance.json'), bridgeModule: path.join(root, 'src/local-ui/bridge-client.mjs') };
  await open(client, { subscriptions: disposables }, { appendLine: line => logs.push(line) });
  assert.equal(mocked.opened.length, 2, 'each native launch opens once');
  const originalSession = await fetch(`${service.descriptor.origin}/api/session`, { headers: { Cookie: cookie, 'X-SFlow-Tab': session.tabId } });
  assert.equal((await originalSession.json()).capabilities.copilot, true, 'opening another tab retains the first window bridge');
  const send = async input => {
    const result = await fetch(`${service.descriptor.origin}/api/handoffs`, { method: 'POST', headers: { Origin: service.descriptor.origin,
      'Content-Type': 'application/json', Cookie: cookie, 'X-SFlow-Tab': session.tabId, 'X-SFlow-CSRF': session.csrf },
      body: JSON.stringify({ contextId: session.context.id, ...input }) });
    return result.json();
  };
  const deliver = async input => {
    const accepted = await send(input);
    for (let i = 0; i < 80; i++) {
      const result = await fetch(`${service.descriptor.origin}/api/handoffs/${accepted.id}`, { headers: { Cookie: cookie, 'X-SFlow-Tab': session.tabId } });
      const outcome = await result.json();
      if (outcome.state === 'delivered') return outcome;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('The browser handoff was not delivered');
  };
  const outcome = await deliver({ type: 'spec.assist', specId: 'SPEC-TEST' });
  assert.equal(outcome.state, 'delivered'); assert.equal(outcome.modelExecution, 'not-observed');
  assert.equal(mocked.commands[0][0], 'workbench.action.chat.open');
  assert.equal(mocked.commands[0][1].isPartialQuery, true, 'the person chooses Send');
  assert.match(mocked.commands[0][1].query, /^\/sf-spec-author SPEC-TEST /u);
  await deliver({ type: 'native.menu', menu: 'code' });
  assert.deepEqual(mocked.commands[1], ['singularityFlow.openCodeExplainer']);
  assert.equal(logs.length, 0);
  // A reply naming another engine, and a bridge inside it, is never loaded into the editor: only this window's own engine is.
  const foreign = path.join(base, 'foreign-engine');
  await mkdir(path.join(foreign, 'src', 'local-ui'), { recursive: true });
  await writeFile(path.join(foreign, 'src', 'local-ui', 'bridge-client.mjs'), 'globalThis.__foreignBridgeLoaded = true;\nexport async function connectEditorBridge() { return { dispose() {} }; }\n');
  const foreignGrant = { ...await control(service.descriptor, 'bootstrap', { root: selected, clientId: randomUUID() }),
    discoveryFile: path.join(connectionDirectory, 'instance.json'), bridgeModule: path.join(foreign, 'src', 'local-ui', 'bridge-client.mjs') };
  foreignGrant.build = { ...foreignGrant.build, engineRoot: foreign };
  grant = foreignGrant;
  await open(client, { subscriptions: disposables }, { appendLine: line => logs.push(line) });
  assert.equal(globalThis.__foreignBridgeLoaded, undefined, 'no module from another engine runs in the editor');
  assert.match(logs.at(-1), /another SFlow engine/u);
});
test('unqualified remote hosts and non-loopback launch replies cannot open a browser', async () => {
  const remote = host({ remote: 'ssh-remote' }), openRemote = await launcher(remote.api);
  let calls = 0;
  await assert.rejects(openRemote({ run: async () => { calls++; } }, { subscriptions: [] }, { appendLine() {} }), /local desktop extension host/u);
  assert.equal(calls, 0); assert.deepEqual(remote.opened, []);
  const local = host(), openLocal = await launcher(local.api);
  await assert.rejects(openLocal({ repository: '/somewhere', location: { cli: cliPath }, run: async () => ({ url: 'https://foreign.invalid/#ticket=x' }) }, { subscriptions: [] }, { appendLine() {} }), /valid local browser/u);
  assert.deepEqual(local.opened, []);
});
