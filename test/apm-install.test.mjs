import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { auditWorkflowText, installApmPackages, installBranchName, pinnedApmCli, updateApmPackages } from '../src/apm-install.mjs';

// APM A2 (2026-10-29): `apm install` framed as one commit a pull request reviews. The stand-in APM
// CLI below writes what apm 0.35.0 wrote for `apm install ../review-pack` (a skill folder listed
// without a hash, skills in .agents, sha256: hashes, apm_modules/ in .gitignore).
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
const FAKE_APM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('Agent Package Manager (APM) CLI version ' + (process.env.FAKE_APM_VERSION || '0.35.0')); process.exit(0); }
if (args[0] === 'audit') {
  // apm audit --ci -f json, as apm 0.35.0 prints it; a package outside the organisation's allow list fails.
  const denied = process.env.FAKE_APM_AUDIT_DENY;
  if (process.env.FAKE_APM_AUDIT_GARBLED) { console.error('[x] audit crashed'); process.exit(1); }
  if (!denied) console.error('[!] Could not determine org from git remote; enforcement skipped');
  console.log(JSON.stringify({ passed: !denied, checks: [{ name: 'lockfile-exists', passed: true, message: 'ok', details: [] },
    { name: 'dependency-allowlist', passed: !denied, message: denied ? '1 dependency(ies) not in allow list' : 'All dependencies match allow list',
      details: denied ? [denied + ': not in allowed sources'] : [] }] }));
  process.exit(denied ? 1 : 0);
}
// install deploys a package at 1.0.0; update moves the locked one to 1.1.0 (its agent rewritten, or
// gone with FAKE_APM_UPDATE_DROP), or changes nothing with FAKE_APM_UPDATE_NONE.
function deploy(name, version, { agent = 'Review the change.\\n', dropAgent = false } = {}) {
  const agentFile = '.github/agents/' + name + '.agent.md';
  const files = { ['.agents/skills/' + name + '-skill/SKILL.md']: '---\\nname: ' + name + '-skill\\n---\\nSteps.\\n' };
  if (!dropAgent) files[agentFile] = '---\\nname: ' + name + '\\ndescription: Reviews the change\\n---\\n' + agent;
  else fs.rmSync(agentFile, { force: true });
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
  const sha = (text) => 'sha256:' + crypto.createHash('sha256').update(process.env.FAKE_APM_DRIFT ? text + 'x' : text).digest('hex');
  const deployed = ['.agents/skills/' + name + '-skill', ...Object.keys(files)].sort();
  fs.writeFileSync('apm.lock.yaml', [
    "lockfile_version: '1'", 'apm_version: 0.35.0', 'dependencies:', '- repo_url: _local/' + name, '  name: ' + name, '  version: ' + version,
    '  deployed_files:', ...deployed.map((file) => '  - ' + file), '  deployed_file_hashes:',
    ...Object.entries(files).sort().map(([file, text]) => '    ' + file + ': ' + sha(text)), '  source: local', '  local_path: ../' + name, ''
  ].join('\\n'));
}
if (args[0] === 'update') {
  if (args.includes('--dry-run')) { console.log('[i] Dry run: apm ' + args.join(' ')); process.exit(0); }
  if (process.env.FAKE_APM_UPDATE_NONE) { console.log('[+] All dependencies are up to date.'); process.exit(0); }
  const name = /\\n {2}name: (\\S+)/u.exec(fs.readFileSync('apm.lock.yaml', 'utf8'))[1];
  deploy(name, '1.1.0', { agent: 'Review the change, test by test.\\n', dropAgent: Boolean(process.env.FAKE_APM_UPDATE_DROP) });
  console.log('[*] Updated 1 APM dependency.');
  process.exit(0);
}
if (args[0] !== 'install') process.exit(2);
if (process.env.FAKE_APM_FAIL) { console.error('[x] All packages failed validation. Nothing to install.'); process.exit(1); }
if (args.includes('--dry-run')) { console.log('[i] Dry run: apm ' + args.join(' ')); process.exit(0); }
const name = path.basename(args.filter((arg) => !arg.startsWith('--')).pop() || 'review-pack');
let manifest = fs.existsSync('apm.yml') ? fs.readFileSync('apm.yml', 'utf8') : 'name: consumer\\nversion: 1.0.0\\n';
if (!manifest.includes('../' + name)) manifest = manifest.replace(/apm: \\[\\]/u, 'apm:\\n    - ../' + name);
fs.writeFileSync('apm.yml', manifest);
deploy(name, '1.0.0');
const ignore = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
if (!ignore.includes('apm_modules/')) fs.writeFileSync('.gitignore', ignore + '\\n# APM dependencies\\napm_modules/\\n');
console.log('[*] Installed 1 APM dependency.');
`;

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env });
}
const git = (root, ...args) => {
  const result = run('git', args, root);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
};

async function repository(t, { manifest = 'name: consumer\nversion: 1.0.0\ntargets:\n  - copilot\ndependencies:\n  apm: []\n' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-apm-install-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const tools = path.join(base, 'bin');
  await mkdir(root);
  await mkdir(tools);
  await writeFile(path.join(tools, 'apm'), FAKE_APM);
  await chmod(path.join(tools, 'apm'), 0o755);
  git(root, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Packager'], ['user.email', 'packager@example.com']]) git(root, 'config', key, value);
  await writeFile(path.join(root, 'README.md'), '# consumer\n');
  if (manifest) await writeFile(path.join(root, 'apm.yml'), manifest);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const env = { ...process.env, NODE_ENV: 'test', PATH: `${tools}${path.delimiter}${process.env.PATH}` };
  const call = (cwd, args, extra = {}) => run(path.join(tools, 'apm'), args, cwd, { ...env, ...extra });
  const apm = (cwd, args, extra = {}) => call(cwd, args, extra).status;
  apm.capture = (cwd, args, extra = {}) => {
    const result = call(cwd, args, extra);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { base, root, env, apm, flow: (args, extra = {}) => run(process.execPath, [bin, ...args], root, { ...env, ...extra }) };
}

const injected = (apm, extra = {}) => ({
  apm: (cwd, args) => apm(cwd, args, extra), capture: (cwd, args) => apm.capture(cwd, args, extra), cliVersion: () => '0.35.0'
});

test('an install is committed on its own apm/ branch with exactly what APM changed, and records the pinned CLI', async (t) => {
  const { root, apm } = await repository(t);
  await writeFile(path.join(root, 'notes.txt'), 'unrelated work in progress\n');
  const result = await installApmPackages(root, { packages: ['../review-pack'], ...injected(apm) });
  assert.equal(result.committed, true);
  assert.equal(result.branch, 'apm/install-review-pack');
  assert.equal(result.createdBranch, true);
  assert.equal(result.pinRecorded, true);
  assert.equal(git(root, 'branch', '--show-current'), 'apm/install-review-pack');
  assert.equal(git(root, 'rev-parse', 'main'), git(root, 'rev-parse', 'HEAD~1'), 'main is untouched');
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [
    '.agents/skills/review-pack-skill/SKILL.md', '.github/agents/review-pack.agent.md', '.github/workflows/apm-audit.yml', '.gitignore', 'apm.lock.yaml', 'apm.yml'
  ]);
  assert.equal(result.workflowWritten, true, 'the first install adds the pull-request check');
  assert.equal(await readFile(path.join(root, '.github/workflows/apm-audit.yml'), 'utf8'), auditWorkflowText('0.35.0'));
  assert.match(auditWorkflowText('0.35.0'), /microsoft\/apm-action@[0-9a-f]{40} # v1\.10\.0[\s\S]*apm-version: '0\.35\.0'[\s\S]*run: apm audit --ci\n/u);
  assert.deepEqual([result.audit.passed, result.audit.policyNote], [true, 'Could not determine org from git remote; enforcement skipped']);
  assert.equal(git(root, 'status', '--porcelain'), '?? notes.txt', 'unrelated work stays out of the commit');
  assert.equal(await pinnedApmCli(root), '0.35.0');
  assert.match(await readFile(path.join(root, 'apm.yml'), 'utf8'), /- \.\.\/review-pack[\s\S]*x-sflow:\n {2}apm-cli: 0\.35\.0\n$/u, 'the pin is added, the rest kept');
  assert.match(git(root, 'log', '-1', '--format=%B'), /^Install APM package review-pack \(local\)\n\napm install \.\.\/review-pack \(apm 0\.35\.0\)/u);
  assert.deepEqual(result.installed[0].primitives.map(({ kind, name }) => `${kind}:${name}`), ['skill:review-pack-skill', 'agent:review-pack']);
  assert.equal(git(root, 'remote'), '', 'nothing is pushed');
});

test('a pinned CLI that is not this machine\'s, uncommitted APM files and a missing CLI refuse before APM runs', async (t) => {
  const { root, apm } = await repository(t, { manifest: 'name: consumer\nversion: 1.0.0\ndependencies:\n  apm: []\nx-sflow:\n  apm-cli: 0.34.2\n' });
  let calls = 0;
  const counted = { apm: (cwd, args) => { calls += 1; return apm(cwd, args); } };
  await assert.rejects(installApmPackages(root, { packages: ['../review-pack'], ...counted, cliVersion: () => '0.35.0' }),
    (error) => error.code === 'APM_CLI_VERSION_MISMATCH' && /runs apm 0\.34\.2[^]*has apm 0\.35\.0/u.test(error.message));
  await assert.rejects(installApmPackages(root, { packages: ['../review-pack'], ...counted, cliVersion: () => null }),
    (error) => error.code === 'APM_CLI_MISSING' && /brew install apm/u.test(error.message));
  await writeFile(path.join(root, 'apm.yml'), 'name: consumer\nversion: 1.0.0\ndependencies:\n  apm: []\n');
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/draft.agent.md'), 'draft\n');
  await assert.rejects(installApmPackages(root, { packages: ['../review-pack'], ...counted, cliVersion: () => '0.35.0' }),
    (error) => error.code === 'APM_INSTALL_DIRTY' && error.details.paths.includes('apm.yml') && error.details.paths.includes('.github/agents/draft.agent.md'));
  assert.equal(calls, 0, 'APM never ran');
});

test('a failed install or one whose files do not match its own lock commits nothing', async (t) => {
  const { root, apm } = await repository(t);
  await assert.rejects(installApmPackages(root, { packages: ['../missing'], ...injected(apm, { FAKE_APM_FAIL: '1' }) }),
    (error) => error.code === 'APM_INSTALL_FAILED');
  assert.equal(git(root, 'branch', '--show-current'), 'main');
  await assert.rejects(installApmPackages(root, { packages: ['../review-pack'], ...injected(apm, { FAKE_APM_DRIFT: '1' }) }),
    (error) => error.code === 'APM_INSTALL_NOT_INTACT' && error.details.state === 'drifted');
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1', 'nothing was committed');
  assert.equal(git(root, 'branch', '--show-current'), 'main');
  git(root, 'checkout', '-q', '--', '.');
  git(root, 'clean', '-q', '-fd');
  // A package the organisation's apm-policy.yml does not allow, or an audit that says nothing, stops the commit.
  await assert.rejects(installApmPackages(root, { packages: ['../review-pack'], ...injected(apm, { FAKE_APM_AUDIT_DENY: 'untrusted/review-pack' }) }),
    (error) => error.code === 'APM_INSTALL_AUDIT_FAILED'
      && /dependency-allowlist: 1 dependency\(ies\) not in allow list \(untrusted\/review-pack: not in allowed sources\)/u.test(error.message));
  git(root, 'checkout', '-q', '--', '.');
  git(root, 'clean', '-q', '-fd');
  await assert.rejects(installApmPackages(root, { packages: ['../review-pack'], ...injected(apm, { FAKE_APM_AUDIT_GARBLED: '1' }) }),
    (error) => error.code === 'APM_AUDIT_UNREADABLE' && /audit crashed/u.test(error.message));
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1', 'still nothing committed');
});

test('on an apm/ branch the install is committed there, and APM\'s --dry-run changes nothing anywhere', async (t) => {
  const { root, apm } = await repository(t);
  git(root, 'switch', '-q', '-c', 'apm/team-agents');
  const first = await installApmPackages(root, { packages: ['../review-pack'], ...injected(apm) });
  assert.deepEqual([first.branch, first.createdBranch], ['apm/team-agents', false]);
  await writeFile(path.join(root, 'apm.yml'), `${await readFile(path.join(root, 'apm.yml'), 'utf8')}# being edited\n`);
  const preview = await installApmPackages(root, { packages: ['../planner'], dryRun: true, ...injected(apm) });
  assert.deepEqual([preview.dryRun, preview.committed], [true, false]);
  assert.equal(git(root, 'status', '--porcelain'), 'M apm.yml', 'a preview runs even with uncommitted APM files');
  assert.equal(installBranchName(root, ['acme/review-pack#v2']), 'apm/install-review-pack');
  assert.equal(installBranchName(root, ['planner@acme-catalog']), 'apm/install-planner');
});

test('apm update commits each package\'s move to its latest allowed version, and says which step went back to its workflow\'s agent', async (t) => {
  const { root, apm } = await repository(t);
  await installApmPackages(root, { packages: ['../review-pack'], ...injected(apm) });
  git(root, 'switch', '-q', 'main');
  git(root, 'merge', '-q', '--ff-only', 'apm/install-review-pack');
  const preview = await updateApmPackages(root, { dryRun: true, ...injected(apm) });
  assert.deepEqual([preview.resultType, preview.committed], ['sflow-apm-update', false]);
  const none = await updateApmPackages(root, { ...injected(apm, { FAKE_APM_UPDATE_NONE: '1' }) });
  assert.equal(none.committed, false);

  const result = await updateApmPackages(root, { packages: ['review-pack'], ...injected(apm) });
  assert.deepEqual([result.branch, result.createdBranch], ['apm/update-review-pack', true]);
  assert.deepEqual(result.updated.map(({ label, from, version }) => [label, from.version, version]), [['review-pack (local)', '1.0.0', '1.1.0']]);
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.github/agents/review-pack.agent.md', 'apm.lock.yaml']);
  assert.match(git(root, 'log', '-1', '--format=%B'), /^Update APM package review-pack \(local\)\n\napm update --yes review-pack \(apm 0\.35\.0\)\n- review-pack \(local\): 1\.0\.0 -> 1\.1\.0/u);
  assert.equal(result.workflowWritten, false, 'the pull-request check came with the first install');

  // An update that removes an agent bound to a step: the step waits for it and keeps its workflow's agent.
  git(root, 'switch', '-q', 'main');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'apm:\n  agents:\n    review-pack:\n      defaultFor: [verification]\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'review-pack drafts verification');
  const dropped = await updateApmPackages(root, { ...injected(apm, { FAKE_APM_UPDATE_DROP: '1' }) });
  assert.deepEqual(dropped.waiting, [{ agent: 'review-pack', steps: ['verification'], waiting: 'APM did not deploy .github/agents/review-pack.agent.md' }]);
  assert.equal(dropped.branch, 'apm/update-review-pack-local', 'named after the package APM moved');
  assert.match(git(root, 'log', '-1', '--format=%B'), /- review-pack no longer drafts verification: APM did not deploy/u);
});

test('apm install from the CLI: plain words, the Story checkout refusal, and Copilot never runs it', { skip: process.platform === 'win32' && 'the stand-in APM CLI is a POSIX script' }, async (t) => {
  const { base, root, flow } = await repository(t);
  run('git', ['init', '-q', '--bare', path.join(base, 'remote.git')], base);
  git(root, 'remote', 'add', 'origin', path.join(base, 'remote.git'));
  git(root, 'push', '-q', '-u', 'origin', 'main');
  const installed = flow(['apm', 'install', '../review-pack']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Committed [0-9a-f]{12} on apm\/install-review-pack \(new, from main\): 6 files apm 0\.35\.0 changed\./u);
  assert.match(installed.stdout, /apm audit --ci passed\. APM: Could not determine org from git remote; enforcement skipped\n\.github\/workflows\/apm-audit\.yml runs the same audit on every pull request\./u);
  assert.match(installed.stdout, /review-pack \(local\): agent review-pack; skill review-pack-skill\./u);
  assert.match(installed.stdout, /apm\.yml now pins apm 0\.35\.0/u);
  assert.match(installed.stdout, /git push -u origin apm\/install-review-pack\n {2}gh pr create --fill/u);
  // --dev is a flag, so the package after it stays a package.
  const preview = flow(['apm', 'install', '--dev', '../extra-pack', '--dry-run']);
  assert.match(preview.stdout, /Dry run: apm install --dev --dry-run \.\.\/extra-pack\n/u);
  const json = JSON.parse(flow(['apm', 'status', '--json']).stdout);
  assert.equal(json.state, 'intact');
  assert.equal(json.cli.found, '0.35.0');

  // A Story's checkout takes its agents from the base branch; installing there is refused.
  git(root, 'switch', '-q', 'main');
  assert.equal(flow(['init']).status, 0);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'sflow init');
  git(root, 'push', '-q', 'origin', 'main');
  const started = flow(['start', 'APM-1', '--from-branch', 'main'], { SINGULARITY_FLOW_TEST_IDENTITY: 'Packager',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) });
  assert.equal(started.status, 0, started.stderr);
  const refused = flow(['apm', 'install', '../planner']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /This checkout is Story APM-1's/u);

  const { argvAllowed } = await import('../src/copilot-mutation-guard.mjs');
  for (const mode of ['read', 'write', 'session-only', 'confirm', 'approval-only']) {
    assert.equal(argvAllowed(['apm', 'install', '../planner'], mode, {}), false, `a ${mode} turn never installs`);
  }
  assert.equal(argvAllowed(['apm', 'install', '../planner', '--dry-run'], 'read', {}), true, 'APM\'s preview is a read');
});
