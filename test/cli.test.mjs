import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'bin', 'singularity-flow.mjs');

function run(...args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    encoding: 'utf8'
  });
}

test('top-level version flags print only the package version', () => {
  for (const argument of ['--version', '-v', 'version']) {
    const result = run(argument);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '0.9.0');
  }
});

test('bare help flags print a one-screen orientation', () => {
  // 365 usage lines is a reference, not an introduction. The complete synopsis moved behind --all.
  for (const argument of ['--help', '-h']) {
    const result = run(argument);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Singularity Flow 0\.9\.0/m);
    assert.ok(result.stdout.split('\n').length <= 40, `the overview is ${result.stdout.split('\n').length} lines`);
    assert.match(result.stdout, /singularity-flow quickstart/);
    assert.match(result.stdout, /singularity-flow start <WORK-ID>/);
    assert.match(result.stdout, /singularity-flow approve/);
    assert.match(result.stdout, /--help --all/);
  }
});

test('--help --all prints the complete usage reference', () => {
  for (const argument of [['--help', '--all'], ['-h', '--all']]) {
    const result = run(...argument);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Singularity Flow 0\.9\.0/m);
    assert.match(result.stdout, /singularity-flow start <WORK-ID>/);
    assert.match(result.stdout, /--work-type ID/);
    assert.match(result.stdout, /singularity-flow report \[WORK-ID\]/);
    assert.match(result.stdout, /singularity-flow submit \[PHASE\]/);
    assert.match(result.stdout, /singularity-flow approve \[PHASE\] \[--work-id WORK-ID\]/);
    assert.match(result.stdout, /singularity-flow nextsteps \[WORK-ID\]/);
    assert.match(result.stdout, /singularity-flow inputs \[PHASE\]/);
    assert.match(result.stdout, /singularity-flow agent \[WORK-ID\]/);
    assert.match(result.stdout, /singularity-flow inbox \[--offline\] \[--json\]/);
    assert.match(result.stdout, /singularity-flow phase show \[PHASE\] \[--json\]/);
    assert.match(result.stdout, /singularity-flow phase draft-check \[PHASE\] \[--json\]/);
    assert.match(result.stdout, /singularity-flow initiative phase draft-check \[PHASE\]/);
    assert.match(result.stdout, /singularity-flow epic jira apply --epic EPIC-KEY --plan SHA256 --confirm EPIC-KEY/);
    assert.match(result.stdout, /singularity-flow factory-reset \[--dry-run\]/);
    assert.match(result.stdout, /sflow reset-all \[--yes\]/);
    assert.match(result.stdout, /singularity-flow fresh-install \[--checkout DIRECTORY\]/);
    assert.match(result.stdout, /singularity-flow wm cleanup \[--force\]/);
  }
});

test('runtime Epic Jira guidance carries every exact guarded operand', async () => {
  const source = await readFile(path.join(root, 'src', 'cli.mjs'), 'utf8');
  assert.doesNotMatch(source, /Publish it with singularity-flow epic jira apply\.`/,
    'a preview must not recommend an apply command without its Epic, plan, and confirmation');
  assert.doesNotMatch(source, /Review it, then run singularity-flow epic create-stories --plan/,
    'published plans must use the reviewed epic jira apply surface');
  assert.doesNotMatch(source, /Run singularity-flow epic jira apply --plan <sha256>/,
    'a refusal must not omit the exact Epic and confirmation operands');
  assert.match(source,
    /singularity-flow epic jira apply --epic \$\{initiativeId\} --plan \$\{result\.plan\.sha256\} --confirm \$\{initiativeId\}/);
  assert.match(source,
    /singularity-flow epic jira apply --epic \$\{initiativeId\} --plan \$\{planSha256\} --confirm \$\{initiativeId\}/);
});

test('Epic completion checks authority before confirmation and publishes the decision as one unit of work', async () => {
  const source = await readFile(path.join(root, 'src', 'cli.mjs'), 'utf8');
  const start = source.indexOf("if (subcommand === 'complete')", source.indexOf('async function epicCommand'));
  const end = source.indexOf("if (subcommand === 'review-choice')", start);
  assert.ok(start >= 0 && end > start, 'Epic completion command block must remain discoverable');
  const block = source.slice(start, end);
  const authority = block.indexOf('epicCompletionAuthorizationStatus');
  const confirmation = block.indexOf('confirmInitiativeExact');
  assert.ok(authority >= 0 && authority < confirmation,
    'completion authority must be resolved before exact confirmation is requested');
  assert.match(block, /const preview = \{ \.\.\.readiness, authorization \}/,
    'dry-run must expose authorization readiness alongside delivery readiness');
  assert.match(block,
    /const syncPublication = await commitInitiativeChange[\s\S]*const completionState = await loadInitiativeAggregate[\s\S]*commitInitiativeChange\(root, completionState\.portfolio, completionState\.initiative/,
    'completion must reload the persisted Initiative revision after its synchronization publication');
  assert.match(block, /commitInitiativeChange[\s\S]*beforeStateWrite:[\s\S]*completeEpicDelivery/,
    'completion artifact and state writes must occur inside the publication unit of work');
  assert.match(block, /eventFromResult:[\s\S]*completionSha256/,
    'the finalized completion digest must be bound into the lifecycle event');
});

test('package exposes the one-shot sf-reset-all executable', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['sf-reset-all'], 'bin/sf-reset-all.mjs');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].bin['sf-reset-all'], 'bin/sf-reset-all.mjs');
  assert.match(await readFile(path.join(root, 'bin/sf-reset-all.mjs'), 'utf8'), /main\(\['reset-all'/);
});

test('package exposes the guarded sf-local-reset executable', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(packageJson.bin['sf-local-reset'], 'bin/sf-local-reset.mjs');
  assert.equal(lock.packages[''].bin['sf-local-reset'], 'bin/sf-local-reset.mjs');
  assert.match(await readFile(path.join(root, 'bin/sf-local-reset.mjs'), 'utf8'), /main\(\['local-reset'/);
});

test('package exposes the guarded sf-reinstall executable', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(packageJson.bin['sf-reinstall'], 'bin/sf-reinstall.mjs');
  assert.equal(lock.packages[''].bin['sf-reinstall'], 'bin/sf-reinstall.mjs');
  const executable = await stat(path.join(root, packageJson.bin['sf-reinstall']));
  assert.ok(executable.mode & 0o100);
  assert.match(await readFile(path.join(root, 'bin/sf-reinstall.mjs'), 'utf8'), /main\(\['reinstall'/);
});

test('package exposes the standalone sflow-inbox executable', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['sflow-inbox'], 'bin/sflow-inbox.mjs');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].bin['sflow-inbox'], 'bin/sflow-inbox.mjs');
  assert.match(await readFile(path.join(root, 'bin/sflow-inbox.mjs'), 'utf8'), /main\(\['inbox'/);
});

test('package exposes the sflow-next executable', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['sflow-next'], 'bin/sflow-next.mjs');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].bin['sflow-next'], 'bin/sflow-next.mjs');
  assert.match(await readFile(path.join(root, 'bin/sflow-next.mjs'), 'utf8'), /main\(\['next'/);
});

test('about identifies the brand and exposes the short command namespace', async () => {
  const result = run('about');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Singularity Flow 0\.9\.0/m);
  assert.match(result.stdout, /Singularity product\s+brand/);
  assert.match(result.stdout, /Copilot: \/sf-<action>/);
  assert.match(result.stdout, /Atomic Git commit\/push state transfer/);
  assert.match(result.stdout, /token and model usage/);
});

test('package exposes the standalone sflow-about executable', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['sflow-about'], 'bin/sflow-about.mjs');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].bin['sflow-about'], 'bin/sflow-about.mjs');
  assert.match(await readFile(path.join(root, 'bin/sflow-about.mjs'), 'utf8'), /main\(\['about'/);
});

test('package exposes the canonical sflow-agent executable', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['sflow-agent'], 'bin/sflow-agent.mjs');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].bin['sflow-agent'], 'bin/sflow-agent.mjs');
  assert.match(await readFile(path.join(root, 'bin/sflow-agent.mjs'), 'utf8'), /main\(\['agent'/);
});

test('help command loads the canonical manual and focused topics', () => {
  const manual = run('help');
  assert.equal(manual.status, 0, manual.stderr);
  assert.match(manual.stdout, /^# Singularity Flow Help/m);
  assert.match(manual.stdout, /## Troubleshooting/);
  const topic = run('help', 'git-state-transfer-and-recovery');
  assert.equal(topic.status, 0, topic.stderr);
  assert.match(topic.stdout, /## Git state transfer and recovery/);
  assert.doesNotMatch(topic.stdout, /## Jira intake/);
});
