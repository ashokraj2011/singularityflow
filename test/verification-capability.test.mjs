import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { capabilityLines, repositoryTestCapability } from '../src/verification/capability.mjs';
import { assertPlannedTestsRunnable, sealStoryTestPolicy } from '../src/verification/test-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const SHIM = path.join(ROOT, 'test', 'fixtures', 'verification', 'jest-shim.mjs');

async function files(root, entries) {
  for (const [relative, content] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
}

test('the capability profile names every module with its runner, how finely it reads tests, and what it can reach', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await files(root, {
    'package.json': JSON.stringify({ private: true, scripts: { test: 'jest' } }),
    'crates/ledger/Cargo.toml': '[package]\nname = "ledger"\nversion = "0.1.0"\n',
    'packages/ui/package.json': JSON.stringify({ private: true }),
    'services/mixed/pom.xml': '<project/>\n',
    'services/mixed/package.json': JSON.stringify({ private: true, scripts: { test: 'vitest' } }),
    'node_modules/ignored/package.json': JSON.stringify({ private: true })
  });
  const capability = await repositoryTestCapability(root, { env: { PATH: '' } });
  const byRoot = Object.fromEntries(capability.modules.map((entry) => [entry.root, entry]));
  assert.deepEqual(Object.keys(byRoot), ['.', 'crates/ledger', 'packages/ui', 'services/mixed'], 'tool output directories are never modules');
  assert.equal(byRoot['.'].profile, 'jest-static-v2');
  assert.equal(byRoot['.'].granularity, 'test-case');
  assert.equal(byRoot['.'].ceiling, 'exact-local-observed');
  assert.equal(byRoot['.'].status, 'launcher-missing', 'npm is not on this empty PATH');
  assert.equal(byRoot['crates/ledger'].status, 'unsupported');
  assert.equal(byRoot['crates/ledger'].code, 'RUST_TEST_ADAPTER_REQUIRED');
  assert.equal(byRoot['packages/ui'].status, 'unsupported');
  assert.equal(byRoot['services/mixed'].code, 'TEST_MODULE_AMBIGUOUS');
  const lines = capabilityLines(capability);
  assert.ok(lines.some((line) => /^crates\/ledger \(rust\): unsupported — Rust module 'crates\/ledger' requires an explicit argv-form test command/.test(line)), lines.join('\n'));
  // A configured command wins over inference for the modules it covers.
  const configured = await repositoryTestCapability(root, { env: { PATH: '' }, configuredCommands: [{
    id: 'ledger-tests', kind: 'test', argv: ['./ledger-test'], workingDirectory: 'crates/ledger', affectedRoots: ['crates/ledger'], modelPolicy: 'never',
    result: { adapter: 'junit-xml', path: 'crates/ledger/report.xml', minimumDiscovered: 1 }
  }] });
  const ledger = configured.modules.find((entry) => entry.root === 'crates/ledger');
  assert.equal(ledger.source, 'configured');
  assert.equal(ledger.commandId, 'ledger-tests');
  assert.equal(ledger.ceiling, 'module-observed', 'a JUnit report from an unknown launcher only counts tests');
});

test('resolving base failures outside the Story needs the base observed, and refuses while it fails (D12, D13)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await files(root, { 'package.json': JSON.stringify({ private: true, scripts: { test: 'jest' } }) });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const baseCommit = 'a'.repeat(40);
  await assert.rejects(() => sealStoryTestPolicy(root, { workId: 'POL-1', baseCommit, baselineFailures: 'resolve-outside' }), (error) => error.code === 'TEST_BASELINE_UNKNOWN'
    && /precheck --run --scope dependency-test/.test(error.message));
  await assert.rejects(() => sealStoryTestPolicy(root, { workId: 'POL-1', baselineFailures: 'accept-pre-existing' }), (error) => error.code === 'TEST_POLICY_INVALID');
  const sealed = await sealStoryTestPolicy(root, { workId: 'POL-1', env: { PATH: '' } });
  assert.equal(sealed.record.baselineFailures, 'repair-in-story');
  assert.equal(sealed.record.executionScope, 'affected');
  assert.equal(sealed.record.witnessDefault, 'automated-test');
  assert.match(sealed.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(sealed.record.capability.modules.map((entry) => entry.root), ['.']);
});

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Capability Tester' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function governedRepository(t, entries, { configure = () => {}, precheck = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-story-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Capability Tester'], root);
  run('git', ['config', 'user.email', 'capability@example.test'], root);
  await files(root, entries);
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configure(config);
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize capability fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  if (precheck) {
    const plan = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
    run(process.execPath, [CLI, '--no-model', 'precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', plan.planId, '--json'], root, { allowFailure: true });
  }
  return { root, cli };
}

const JEST_REPOSITORY = (testBody) => ({
  'package.json': JSON.stringify({ type: 'module', private: true, scripts: { test: 'node tools/jest-shim.mjs --runner jest' } }),
  '.gitignore': '.sflow/\n',
  'src/value.js': 'export const value = 1;\n',
  'test/value.test.js': `import { value } from '../src/value.js';\ntest('baseline value', () => { ${testBody} });\n`
});

test('an undetected runner is disclosed at intake and planning without blocking document publication', async (t) => {
  const workId = 'CAP-1';
  const { root, cli } = await governedRepository(t, {
    ...JEST_REPOSITORY('expect(value).toBe(1);'),
    'tools/jest-shim.mjs': await readFile(SHIM, 'utf8'),
    'crates/ledger/Cargo.toml': '[package]\nname = "ledger"\nversion = "0.1.0"\n',
    'crates/ledger/src/lib.rs': 'pub fn total() -> u32 { 1 }\n'
  });
  const started = cli('start', workId, '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Ledger total', '--description', 'Total the ledger.');
  assert.match(started.stdout, /Test capability \(sealed with the Story/);
  assert.match(started.stdout, /crates\/ledger \(rust\): unsupported — Rust module 'crates\/ledger' requires an explicit argv-form test command/);
  assert.match(started.stdout, /\. \(node\): .*reads each test case; criteria tested here can reach exact-local-observed/);
  const item = path.join(root, 'singularity/work-items', workId);
  const sealed = JSON.parse(await readFile(path.join(item, 'context/test-policy.json'), 'utf8'));
  assert.equal(sealed.baselineFailures, 'repair-in-story');
  const shown = JSON.parse(cli('story', 'test-policy', 'show', workId, '--json').stdout);
  assert.equal(shown.sealed.record.capability.modules.find((entry) => entry.root === 'crates/ledger').status, 'unsupported');

  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${workId} — intake`, '', '## Request and outcome', '', 'Total the ledger for every caller.', '',
    '## Scope and constraints', '', 'Change only the ledger crate and its tests.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${workId}:AC-001] | The ledger total is 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${workId}:AC-001\` | \`crates/ledger/src/lib.rs\` | \`crates/ledger/tests/total.rs\` |`, '',
    '## Initial evidence', '', 'The baseline crate at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is the total 2?', '--answer', 'Yes.');
  const published = cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  assert.match(published.stdout + published.stderr, /Test configuration pending/);
  assert.match(published.stdout + published.stderr, /Rust module 'crates\/ledger' requires an explicit argv-form test command/);
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.intake.generation, 1, 'the authored document is published, not blocked by detection');
});

test('planning can proceed with a missing runner but publication still requires one', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pending-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await files(root, { 'Cargo.toml': '[package]\nname = "pending"\nversion = "0.1.0"\n',
    'src/lib.rs': 'pub fn value() -> u32 { 1 }\n' });
  const phase = { id: 'custom-code', generationPolicy: { task: 'code' }, qualityCommands: [] };
  const warnings = [];
  const result = await assertPlannedTestsRunnable(root, { phases: { 'custom-code': phase } }, {
    subject: 'Plan', codeSteps: ['custom-code'],
    claims: { 'PENDING:AC-001': { tests: ['tests/value.rs'] } },
    warn: message => warnings.push(message)
  });
  assert.equal(result.status, 'configuration-pending');
  assert.match(warnings[0], /configure the required test command before code publication/);
  const { resolveDeliveryQualityCommands } = await import('../src/delivery-evidence.mjs');
  await assert.rejects(resolveDeliveryQualityCommands(root, {
    ...phase, deliveryEvidence: { sourcePaths: ['src/lib.rs'], testPaths: ['tests/value.rs'] }
  }), { code: 'RUST_TEST_ADAPTER_REQUIRED' });
  const configured = { ...phase, qualityCommands: [{ id: 'rust-tests', kind: 'test',
    argv: ['rust-tests'], workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'junit-xml', path: '.sflow/results/rust.xml', minimumDiscovered: 1 } }] };
  const repaired = await assertPlannedTestsRunnable(root, { phases: { 'custom-code': configured } }, {
    codeSteps: ['custom-code'], claims: { 'PENDING:AC-001': { tests: ['tests/value.rs'] } }, warn: () => {}
  });
  assert.equal(repaired.status, 'ready', 'a command supplied later resolves the missing configuration');
  await assert.rejects(assertPlannedTestsRunnable(root, { phases: { 'custom-code': configured } }, {
    subject: 'Plan', codeSteps: ['custom-code'], claims: { 'PENDING:AC-001': {} },
    contracts: new Map([['PENDING:AC-001', { slots: [{ method: 'test', role: 'primary',
      witness: { path: 'tests/value.rs' }, requiredAssurance: 'exact-local-observed' }] }]]), warn: () => {}
  }), { code: 'TEST_CAPABILITY_UNSUPPORTED' }, 'missing configuration does not waive the stated proof contract');
});

test('D13 through a real Story: resolving base failures outside the Story refuses creation and names them', async (t) => {
  const workId = 'CAP-2';
  const { root, cli } = await governedRepository(t, {
    ...JEST_REPOSITORY('expect(value).toBe(2);'),
    'tools/jest-shim.mjs': await readFile(SHIM, 'utf8')
  }, { configure: (config) => { config.repositoryReadiness = { ...(config.repositoryReadiness ?? {}), requiredBeforeStory: false }; } });
  const refused = run(process.execPath, [CLI, '--no-model', 'start', workId, '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Value', '--description', 'Change the value.', '--baseline-failures', 'resolve-outside'], root, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /resolves the base's failing tests outside itself, and the base still fails:\n- baseline value/);
  assert.match(refused.stdout + refused.stderr, /No Story was created/);
  assert.equal(run('git', ['branch', '--list', workId], root).stdout.trim(), '', 'no Story branch was created');
  cli('start', workId, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Value', '--description', 'Change the value.');
  const sealed = JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'context/test-policy.json'), 'utf8'));
  assert.equal(sealed.baselineFailures, 'repair-in-story', 'repairing in the Story is the default');
});
