import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SingularityFlowClient, isCliReadSuperseded } from '../apps/vscode/src/cli/client.ts';
import { WorkspaceStore } from '../apps/vscode/src/state.ts';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-shared-reads-'));
  const cli = path.join(directory, 'fixture.mjs'), log = path.join(directory, 'calls.jsonl');
  await writeFile(log, '');
  await writeFile(cli, `import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
    await new Promise(resolve => setTimeout(resolve, 80));
    console.log(JSON.stringify({ scope: process.env.READ_SCOPE ?? 'initial', args: process.argv.slice(2) }));`);
  const clients = [];
  const make = (options = {}) => {
    const client = new SingularityFlowClient({ repository: directory,
      location: { executable: process.execPath, cli, source: 'setting' }, ...options });
    clients.push(client); return client;
  };
  t.after(async () => { clients.forEach(client => client.dispose()); await rm(directory, { recursive: true, force: true }); });
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { make, calls, directory };
}

test('identical reads coalesce across clients; leaving one subscriber cannot cancel another', async t => {
  const f = await fixture(t), first = f.make(), second = f.make();
  const a = new AbortController();
  const left = first.run(['status', '--json'], a.signal);
  const leftFailure = assert.rejects(left, /cancelled/);
  const right = second.run(['status', '--json']);
  a.abort();
  await leftFailure;
  assert.equal((await right).scope, 'initial');
  assert.equal((await f.calls()).length, 1);
  // Results are cloned separately; callers cannot mutate one another's view.
  const [one, two] = await Promise.all([first.run(['progress', '--json']), second.run(['progress', '--json'])]);
  one.args.push('local edit'); assert.notDeepEqual(one, two);
  assert.equal((await f.calls()).length, 2);
});

test('repository switch only detaches that client; environment and watcher changes force fresh reads', async t => {
  const f = await fixture(t), first = f.make(), second = f.make();
  const a = first.run(['status', '--json']);
  const failure = assert.rejects(a, isCliReadSuperseded);
  const b = second.run(['status', '--json']);
  first.useRepository(path.join(f.directory, 'different-repository'));
  await failure; await b;
  assert.equal((await f.calls()).length, 1);
  second.invalidateReads(); await second.run(['status', '--json']);
  assert.equal((await f.calls()).length, 2, 'watcher invalidation defeats the short TTL');
  let scope = 'one';
  const dynamic = f.make({ environment: () => ({ ...process.env, READ_SCOPE: scope }) });
  assert.equal((await dynamic.run(['status', '--json'])).scope, 'one');
  scope = 'two';
  assert.equal((await dynamic.run(['status', '--json'])).scope, 'two', 'credentials/permissions are part of scope');
  assert.equal((await f.calls()).length, 4);
});

test('author/reviewer reads are never shared or short-TTL replayed', async t => {
  const f = await fixture(t), first = f.make(), second = f.make();
  await Promise.all([first.run(['nextsteps', '--for-agent', '--json']), second.run(['nextsteps', '--for-agent', '--json'])]);
  assert.equal((await f.calls()).length, 2);
});

test('identical overlapping Store refreshes share the active read', async () => {
  let count = 0, finish;
  const store = new WorkspaceStore({ snapshot: async () => {
    count++; await new Promise(resolve => { finish = resolve; });
    return { workItems: [], initiatives: [], marker: 'live' };
  } });
  const first = store.refresh(), second = store.refresh(), third = store.refresh();
  assert.equal(count, 1); finish(); await Promise.all([first, second, third]);
  assert.equal(count, 1); assert.equal(store.current.snapshot.marker, 'live'); store.dispose();
});
