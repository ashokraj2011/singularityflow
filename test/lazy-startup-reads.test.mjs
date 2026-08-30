import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('startup workspace and capability reads preserve the legacy CLI contract', async () => {
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
    assert.equal(actual.stdout, expected.stdout, `${args.join(' ')} stdout changed`);
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
  assert.ok(workspaceClosure.size <= 25,
    `workspace startup reads load ${workspaceClosure.size} static modules; ceiling is 25`);
  assert.ok(capabilityClosure.size <= 10,
    `capability leads loads ${capabilityClosure.size} static modules; ceiling is 10`);
  for (const file of [...workspaceClosure, ...capabilityClosure]) {
    assert.doesNotMatch(path.basename(file), /^(?:cli|jira|initiative|visual|model-runner|model-provider)\.mjs$/,
      `startup read graph reaches unrelated heavyweight domain ${file}`);
  }
});
