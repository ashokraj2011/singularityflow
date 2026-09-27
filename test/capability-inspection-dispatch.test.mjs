import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition } from '../src/config.mjs';
import { run } from '../src/util.mjs';

const commandUrl = new URL('../src/commands/capability.mjs', import.meta.url).href;
const legacyUrl = new URL('../src/cli.mjs', import.meta.url).href;
const legacyShimUrl = new URL('../src/commands/legacy.mjs', import.meta.url).href;

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-inspection-dispatch-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'seed');
  const repository = path.join(base, 'mapped repository.git');
  const env = { ...process.env, NODE_ENV: 'test', NO_COLOR: '1',
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'private', 'leads.json'),
    SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(base, 'private', 'organisation'),
    SINGULARITY_FLOW_AUTHORITY_CACHE: path.join(base, 'private', 'authority'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'private', 'workspaces.json'),
    SINGULARITY_FLOW_TELEMETRY_REGISTRY: path.join(base, 'private', 'telemetry.json')
  };
  run('git', ['init', '-q', '-b', 'main', source], { cwd: base, env });
  run('git', ['config', 'user.name', 'Inspection Fixture'], { cwd: source, env });
  run('git', ['config', 'user.email', 'inspection@example.test'], { cwd: source, env });
  await writeFile(path.join(source, 'README.md'), 'Local inspection fixture\n');
  run('git', ['add', '-A'], { cwd: source, env });
  run('git', ['commit', '-qm', 'Application baseline'], { cwd: source, env });
  run('git', ['switch', '-qc', 'sflow/config'], { cwd: source, env });
  await initializeDefinition(source);
  await writeFile(path.join(source, 'singularity', 'portfolio.yml'), `version: 1
repositories:
  application:
    url: ${JSON.stringify(repository)}
`);
  await writeFile(path.join(source, 'singularity', 'capabilities.yml'), `version: 2
management:
  mode: sflow-cli
capabilities:
  payments:
    name: Payments
    kind: delivery
    repository: application
    sourceRoots: []
`);
  run('git', ['add', '-A'], { cwd: source, env });
  run('git', ['commit', '-qm', 'Approved self-map'], { cwd: source, env });
  run('git', ['clone', '-q', '--bare', '--no-hardlinks', source, repository], { cwd: base, env });
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repository, env });
  const loader = path.join(base, 'reject-legacy-loader.mjs');
  await writeFile(loader, `
    const denied = new Set(${JSON.stringify([legacyUrl, legacyShimUrl])});
    export async function resolve(specifier, context, nextResolve) {
      const resolved = await nextResolve(specifier, context);
      if (denied.has(resolved.url)) throw new Error('The direct inspection loaded the legacy CLI.');
      return resolved;
    }
  `);
  return { base, source, repository, env, loader };
}

function refs(f) {
  return run('git', ['for-each-ref', '--format=%(refname) %(objectname)'], {
    cwd: f.repository, env: f.env
  }).stdout;
}

function invoke(f, context, { legacy = false, loadOnly = false, missingOperand = false } = {}) {
  // Execute a separate process so imported module state, current directory, and private caches
  // cannot accidentally make the independent dispatcher's graph or result look correct.
  const code = `
    const logs = [], warnings = [];
    console.log = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => warnings.push(args.join(' '));
    const context = ${JSON.stringify(context)};
    const command = await import(${JSON.stringify(legacy ? legacyUrl : commandUrl)});
    let result = null;
    if (${legacy}) {
      const argv = [...context.positionals];
      for (const [key, value] of Object.entries(context.options)) {
        if (Array.isArray(value)) for (const entry of value) argv.push('--' + key, String(entry));
        else if (value === true) argv.push('--' + key);
        else if (value !== false && value != null) argv.push('--' + key, String(value));
      }
      await command.main(argv);
    } else {
      await command.load(context);
      if (${missingOperand}) {
        const assert = await import('node:assert/strict');
        await assert.default.rejects(() => command.run([], context), (error) =>
          error.code === 'MISSING_ARGUMENT' && /Missing Git repository URL/.test(error.message));
      } else if (!${loadOnly}) result = await command.run([], context);
    }
    process.stdout.write(JSON.stringify({ result, logs, warnings }));
  `;
  const child = spawnSync(process.execPath, [
    ...(!legacy ? ['--experimental-loader', f.loader] : []),
    '--input-type=module', '-e', code
  ], { cwd: f.base, env: { ...f.env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8',
    timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

const context = (repository, options = {}) => ({
  positionals: ['capability', 'inspect-repository', repository],
  options: { refresh: true, 'search-known': false, 'include-proposals': false, ...options }
});

test('direct inspection load excludes the legacy CLI and preserves the repository operand requirement', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(invoke(f, context(f.repository), { loadOnly: true }), {
    result: null, logs: [], warnings: []
  });
  assert.deepEqual(invoke(f, {
    positionals: ['capability', 'inspect-repository'], options: {}
  }, { missingOperand: true }), { result: null, logs: [], warnings: [] });
});

test('direct inspection JSON and human contracts match the legacy route without changing authoritative refs', async (t) => {
  const f = await fixture(t);
  const before = refs(f);
  const jsonContext = context(f.repository, { json: true });
  const direct = invoke(f, jsonContext);
  assert.equal(direct.result.status, 'already-mapped');
  assert.deepEqual(direct.result.matches[0].capabilities, ['payments']);
  assert.equal(direct.result.proposalCoverage, 'complete');
  assert.equal(direct.result.authorityScope, 'repository-candidate');
  assert.deepEqual(direct.warnings, []);
  assert.equal(direct.logs.length, 1);
  assert.deepEqual(JSON.parse(direct.logs[0]), direct.result);
  const legacy = invoke(f, jsonContext, { legacy: true });
  assert.deepEqual(JSON.parse(legacy.logs[0]), direct.result);
  assert.deepEqual(legacy.warnings, []);
  const human = invoke(f, context(f.repository));
  const legacyHuman = invoke(f, context(f.repository), { legacy: true });
  assert.deepEqual(human.logs, [
    `${f.repository}: already-mapped`, `  ${f.repository}: application (payments)`
  ]);
  assert.deepEqual(human.logs, legacyHuman.logs);
  assert.deepEqual(human.warnings, legacyHuman.warnings);
  assert.equal(refs(f), before, 'inspection must not publish a state link, proposal, or approved map');
});

test('direct inspection retains partial-coverage warning and safe diagnostic routes for an absent local lead', async (t) => {
  const f = await fixture(t);
  const before = refs(f);
  const request = context(f.repository, {
    lead: [f.repository, path.join(f.base, 'absent authority.git')], 'include-proposals': true
  });
  const direct = invoke(f, request);
  const legacy = invoke(f, request, { legacy: true });
  assert.equal(direct.result.status, 'already-mapped');
  assert.equal(direct.result.proposalCoverage, 'partial');
  assert.equal(direct.result.failures.length, 1);
  assert.match(direct.warnings.join('\n'), /pending proposal coverage: partial .*no new mapping is authorized/);
  assert.match(direct.logs.join('\n'), /Diagnose:\n\s+Shell: singularity-flow workspace doctor --network --repository/);
  assert.match(direct.logs.join('\n'), /Copilot: \/sf-workspace-bootstrap/);
  assert.deepEqual(direct.logs, legacy.logs);
  assert.deepEqual(direct.warnings, legacy.warnings);
  assert.equal(refs(f), before);
});
