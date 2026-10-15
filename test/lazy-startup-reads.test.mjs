import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const legacy = path.join(packageRoot, 'src', 'commands', 'legacy.mjs');

function invoke(args, env, { legacyRoute = false } = {}) {
  const command = legacyRoute
    ? ['--input-type=module', '-e',
        `const command = await import(${JSON.stringify(legacy)});`
        + `await command.run(${JSON.stringify(args)});`]
    : [bin, ...args];
  return spawnSync(process.execPath, command, {
    cwd: path.dirname(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY),
    env: { ...env, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' },
    encoding: 'utf8'
  });
}

test('startup reads preserve legacy fields and text with explicit local workspace manifest hints', async () => {
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-lazy-startup-'));
  const registry = path.join(machine, 'workspaces.json');
  const active = path.join(machine, 'active-workspace.json');
  const leads = path.join(machine, 'leads.json');
  const workspacePath = path.join(machine, 'saved-workspace');
  await writeFile(registry, `${JSON.stringify([{
    id: 'payments', name: 'Payments', path: workspacePath,
    anchorKey: 'PAY', anchorType: 'Project', openedAt: '2026-01-01T00:00:00.000Z'
  }], null, 2)}\n`);
  await writeFile(leads, `${JSON.stringify({
    schemaVersion: 1,
    leads: [{ url: 'https://example.invalid/platform.git', usedAt: '2026-01-02T00:00:00.000Z' }]
  }, null, 2)}\n`);
  const env = {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: active,
    SINGULARITY_FLOW_LEAD_REGISTRY: leads
  };

  for (const args of [
    ['workspace', 'list'],
    ['workspace', 'list', '--json'],
    ['workspace', 'current'],
    ['workspace', 'current', '--json'],
    ['workspace', 'prompt'],
    ['capability', 'leads'],
    ['capability', 'leads', '--json']
  ]) {
    const actual = invoke(args, env);
    const expected = invoke(args, env, { legacyRoute: true });
    assert.equal(actual.status, expected.status, `${args.join(' ')} exit status changed`);
    if (args.join(' ') === 'workspace list --json') {
      // The lazy roster adds local manifest hints without changing any legacy registry field.
      // This fixture has no manifest; unavailable is explicit rather than an inferred mismatch.
      const actualItems = JSON.parse(actual.stdout);
      const legacyItems = actualItems.map((item) => {
        const { manifestStatus, capabilityAuthorityUrl, leadRepositoryUrl, ...legacyFields } = item;
        assert.deepEqual({ manifestStatus, capabilityAuthorityUrl, leadRepositoryUrl }, {
          manifestStatus: 'unavailable', capabilityAuthorityUrl: null, leadRepositoryUrl: null
        });
        return legacyFields;
      });
      assert.deepEqual(legacyItems, JSON.parse(expected.stdout),
        'workspace list --json changed legacy fields beyond the three manifest hints');
    } else {
      assert.equal(actual.stdout, expected.stdout, `${args.join(' ')} stdout changed`);
    }
    assert.equal(actual.stderr, expected.stderr, `${args.join(' ')} stderr changed`);
  }
});

async function staticClosure(relativeEntry) {
  const visited = new Set();
  async function walk(file) {
    const absolute = path.resolve(packageRoot, file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = await readFile(absolute, 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      const candidate = path.resolve(path.dirname(absolute), match[1]);
      await walk(path.extname(candidate) ? candidate : `${candidate}.mjs`);
    }
  }
  await walk(relativeEntry);
  return visited;
}

test('performance-v2 source entry manifest enforces module ceilings and unrelated-domain exclusions', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'benchmarks/performance-v2/import-budgets.json'), 'utf8'));
  for (const { entry, maximumModules, forbidden = manifest.forbidden } of manifest.source) {
    const names = [...await staticClosure(entry)].map(file => path.relative(packageRoot, file).split(path.sep).join('/'));
    assert.ok(names.length <= maximumModules, `${entry}: ${names.length} modules exceeds ${maximumModules}`);
    for (const name of forbidden) assert.ok(!names.includes(name), `${entry} reaches ${name}`);
  }
  assert.equal((await import('../src/command-registry.mjs')).commandDefinition('logs').modulePath, './commands/logs.mjs');
});

test('generator validation shares exact IDs with rendering without importing its Jira/source graph', async () => {
  const { INITIATIVE_GENERATOR_IDS, isInitiativeGenerator } = await import('../src/initiative-phase-roles.mjs');
  const { INITIATIVE_GENERATORS } = await import('../src/initiative-generators.mjs');
  assert.deepEqual([...INITIATIVE_GENERATOR_IDS].sort(), Object.keys(INITIATIVE_GENERATORS).sort());
  for (const id of INITIATIVE_GENERATOR_IDS) assert.equal(isInitiativeGenerator(id), true);
  for (const id of ['unknown', 'constructor', '__proto__']) assert.equal(isInitiativeGenerator(id), false);
  const names = [...await staticClosure('src/initiative-config.mjs')].map(file => path.relative(packageRoot, file).split(path.sep).join('/'));
  for (const forbidden of ['src/initiative-generators.mjs', 'src/epic-sources.mjs', 'src/jira.mjs']) assert.ok(!names.includes(forbidden), forbidden);
});

test('startup read entrypoints do not statically reach the legacy monolith', async () => {
  const registry = await import('../src/command-registry.mjs');
  assert.equal(registry.commandDefinition('workspace').modulePath, './commands/workspace.mjs');
  assert.equal(registry.commandDefinition('capability').modulePath, './commands/capability.mjs');

  const workspace = await readFile(path.join(packageRoot, 'src/commands/workspace.mjs'), 'utf8');
  const capability = await readFile(path.join(packageRoot, 'src/commands/capability.mjs'), 'utf8');
  assert.doesNotMatch(workspace, /^import .*legacy\.mjs/m,
    'workspace startup reads eagerly import the legacy command graph');
  assert.doesNotMatch(capability, /^import .*legacy\.mjs/m,
    'capability leads eagerly imports the legacy command graph');
  assert.match(capability, /from '\.\.\/lead-repositories\.mjs'/,
    'capability leads no longer uses its small registry boundary');
  assert.doesNotMatch(capability, /from '\.\.\/organisation\.mjs'/,
    'capability leads imports the complete organisation service');

  const workspaceClosure = await staticClosure('src/commands/workspace.mjs');
  const capabilityClosure = await staticClosure('src/commands/capability.mjs');
  // The enterprise Git isolation path is already part of the committed read graph, and so is the
  // governed commit's secret scan, which reads DOCX and XLSX text through source-text.mjs (a leaf
  // module with only a builtin import). Every Git spawn also selects the host Git through
  // git-host-selection.mjs (38e44423), another builtin-only leaf, and answers repeated local questions
  // through git-fact-cache.mjs, a third. Keep the ceiling at that verified baseline so new eager
  // startup imports still fail this test.
  assert.ok(workspaceClosure.size <= 27,
    `workspace startup reads load ${workspaceClosure.size} static modules; ceiling is 27`);
  assert.ok(capabilityClosure.size <= 12,
    `capability leads loads ${capabilityClosure.size} static modules; ceiling is 12`);
  for (const file of [...workspaceClosure, ...capabilityClosure]) {
    assert.doesNotMatch(path.basename(file), /^(?:cli|jira|initiative|visual|model-runner|model-provider)\.mjs$/,
      `startup read graph reaches unrelated heavyweight domain ${file}`);
  }
});

test('the Copilot edit guard, run on every tool call, stays clear of the configuration and sequence graphs', async () => {
  // Each guarded tool call starts a process that loads this graph. One constant imported from
  // config.mjs and one predicate from sequence.mjs used to pull in 234 modules (about 230 ms a call).
  const closure = await staticClosure('src/copilot-mutation-guard.mjs');
  const names = [...closure].map((file) => path.relative(packageRoot, file).replaceAll(path.sep, '/'));
  for (const heavy of ['src/config.mjs', 'src/sequence.mjs', 'src/cli.mjs']) {
    assert.ok(!names.includes(heavy), `the edit guard statically reaches ${heavy}`);
  }
  assert.ok(closure.size <= 60, `the edit guard loads ${closure.size} static modules; ceiling is 60`);
});

test('commands that load the legacy CLI leave the SQLite build and the ACP SDK to first use', () => {
  // Every command routed through cli.mjs loads its whole static graph. Static imports of the 1.3 MB
  // asm.js SQLite build and of the ACP SDK cost about 45 ms a command; both load where they are used.
  // A loader hook records what Node actually loads, so imports written inside strings do not count.
  const hook = 'let port; export function initialize(data) { port = data.port; }'
    + ' export async function load(url, context, next) { port.postMessage(url); return next(url, context); }';
  const script = [
    "import { register } from 'node:module';",
    "const { port1, port2 } = new MessageChannel(); const loaded = [];",
    "port1.on('message', (url) => loaded.push(url));",
    `register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), { data: { port: port2 }, transferList: [port2] });`,
    `await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, 'src/cli.mjs')).href)});`,
    "await new Promise((resolve) => setTimeout(resolve, 100)); port1.close();",
    "console.log(JSON.stringify({ count: loaded.length, heavy: loaded.filter((url) => /node_modules\\/(?:sql\\.js|@agentclientprotocol)\\//u.test(url)) }));"
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.ok(report.count > 100, 'the hook saw the CLI graph load');
  assert.deepEqual(report.heavy, []);
});
