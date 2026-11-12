import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { initApmPolicy, marketplaceAllowPattern, policyText } from '../src/apm-policy.mjs';

// APM A5 (2026-10-30): the organisation's apm-policy.yml, in its .github repository, allowing the
// packages of its marketplaces. APM's own `apm policy status --check -o json` decides whether the
// file is a policy; the stand-in below answers as apm 0.35.0 did for a good file and a bad one.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
const FAKE_APM = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('Agent Package Manager (APM) CLI version 0.35.0'); process.exit(0); }
if (args[0] === 'policy' && args[1] === 'status') {
  const text = fs.readFileSync(args[args.indexOf('--policy-source') + 1], 'utf8');
  const good = /^enforcement: (block|warn)$/mu.test(text) && /^  allow:\\n {4}- /mu.test(text);
  console.log(JSON.stringify(good
    ? { outcome: 'found', error: null, enforcement: 'block', warnings: [], rule_summary: ['1 dependency allow patterns'] }
    : { outcome: 'malformed', error: 'Invalid policy file: Policy validation failed: dependencies.allow must be a YAML list of package patterns', warnings: [] }));
  process.exit(good ? 0 : 1);
}
process.exit(2);
`;

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env });
}
const git = (root, ...args) => {
  const result = run('git', args, root);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
};

async function organisation(t, { remote = 'https://git.example.test/acme/.github.git' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-apm-policy-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'dot-github');
  const tools = path.join(base, 'bin');
  await mkdir(tools);
  await writeFile(path.join(tools, 'apm'), FAKE_APM);
  await chmod(path.join(tools, 'apm'), 0o755);
  run('git', ['init', '-q', '-b', 'main', root], base);
  for (const [key, value] of [['user.name', 'Packager'], ['user.email', 'packager@example.com']]) git(root, 'config', key, value);
  if (remote) git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'README.md'), '# acme\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const env = { ...process.env, NODE_ENV: 'test', PATH: `${tools}${path.delimiter}${process.env.PATH}` };
  const capture = (cwd, args) => {
    const result = run(path.join(tools, 'apm'), args, cwd, env);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { root, capture, flow: (args) => run(process.execPath, [bin, ...args], root, env) };
}

test('policy init writes the organisation\'s policy allowing its marketplace, checked by APM, committed for review', async (t) => {
  const { root, capture } = await organisation(t);
  const preview = await initApmPolicy(root, { marketplaces: ['acme/team-catalog'], capture, cliVersion: () => '0.35.0', dryRun: true });
  assert.equal(preview.committed, false);
  assert.equal(git(root, 'status', '--porcelain'), '', 'a preview writes nothing');

  const result = await initApmPolicy(root, { marketplaces: ['git.example.test/acme/team-catalog'], allow: ['acme-labs/**'], capture, cliVersion: () => '0.35.0' });
  assert.equal(result.branch, 'apm/policy-init');
  assert.equal(result.discovered, true, '.github is where APM looks');
  assert.deepEqual(result.notes, []);
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['apm-policy.yml']);
  const text = await readFile(path.join(root, 'apm-policy.yml'), 'utf8');
  assert.equal(text, policyText({ name: 'acme agent packages', allow: ['acme/team-catalog/**', 'acme-labs/**'], enforcement: 'block' }));
  assert.deepEqual(YAML.parse(text), {
    name: 'acme agent packages', version: '1.0.0', enforcement: 'block', dependencies: { allow: ['acme/team-catalog/**', 'acme-labs/**'] }
  });
  assert.equal(git(root, 'for-each-ref', '--format=%(refname)', 'refs/remotes'), '', 'nothing is pushed');
  await assert.rejects(initApmPolicy(root, { marketplaces: ['acme/team-catalog'], capture, cliVersion: () => '0.35.0' }), { code: 'APM_POLICY_EXISTS' });
});

test('policy init refuses an empty or malformed allow list, says where APM looks, and leaves nothing when APM refuses the file', async (t) => {
  const { root, capture } = await organisation(t, { remote: 'https://git.example.test/acme/governance.git' });
  const options = { capture, cliVersion: () => '0.35.0' };
  await assert.rejects(initApmPolicy(root, options), (error) => error.code === 'APM_POLICY_INVALID' && /An empty allow list refuses every package/u.test(error.message));
  await assert.rejects(initApmPolicy(root, { ...options, allow: ['everything'] }), { code: 'APM_POLICY_INVALID' });
  await assert.rejects(initApmPolicy(root, { ...options, marketplaces: ['team-catalog'] }), { code: 'APM_POLICY_INVALID' });
  await assert.rejects(initApmPolicy(root, { ...options, marketplaces: ['acme/team-catalog'], enforcement: 'off' }), { code: 'APM_POLICY_INVALID' });
  const preview = await initApmPolicy(root, { ...options, marketplaces: ['acme/team-catalog'], dryRun: true });
  assert.equal(preview.discovered, false);
  assert.match(preview.notes[0], /only in its \.github-private, \.github, \.apm, _apm repository; git\.example\.test\/acme\/governance is not one of them/u);

  // APM, not SFlow, decides whether the file is a policy.
  const refusing = (cwd, args) => ({ status: 1, stdout: JSON.stringify({ outcome: 'malformed', error: 'Policy validation failed: something new' }), stderr: '' });
  await assert.rejects(initApmPolicy(root, { ...options, marketplaces: ['acme/team-catalog'], capture: refusing }),
    (error) => error.code === 'APM_POLICY_INVALID' && /APM does not accept the policy: Policy validation failed: something new\. Nothing was written\./u.test(error.message));
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'branch', '--show-current'), 'main');

  assert.equal(marketplaceAllowPattern('acme/team-catalog'), 'acme/team-catalog/**');
  assert.equal(marketplaceAllowPattern('git.example.test/acme/team-catalog.git'), 'acme/team-catalog/**', 'APM matches without the host');
});

test('policy init from the shell prints the policy and its next steps, and is the person\'s own step', { skip: process.platform === 'win32' && 'the stand-in APM CLI is a POSIX script' }, async (t) => {
  const { flow } = await organisation(t);
  const preview = flow(['apm', 'policy', 'init', '--marketplace', 'acme/team-catalog', '--dry-run']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Would write apm-policy\.yml: acme agent packages, allowing acme\/team-catalog\/\*\*, enforcement block\.\n# The organisation's APM policy/u);
  const written = flow(['apm', 'policy', 'init', '--marketplace', 'acme/team-catalog', '--name', 'Acme approved agents']);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /Committed on apm\/policy-init \(new, from main\); apm 0\.35\.0 accepts it\.\nNothing was pushed\./u);
  const second = flow(['apm', 'policy', 'init', '--marketplace', 'acme/other', '--dry-run', '--json']);
  assert.notEqual(second.status, 0, 'a second policy is refused even as a preview');
  assert.match(second.stdout + second.stderr, /APM_POLICY_EXISTS/u);

  const { argvAllowed } = await import('../src/copilot-mutation-guard.mjs');
  assert.equal(argvAllowed(['apm', 'policy', 'init', '--marketplace', 'acme/team-catalog'], 'write', {}), false);
  assert.equal(argvAllowed(['apm', 'policy', 'init', '--marketplace', 'acme/team-catalog', '--dry-run'], 'read', {}), true);
});
