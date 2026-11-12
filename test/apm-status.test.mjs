import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { apmProjectStatus, bytesMatch, declaredDependency, deployedPath, primitiveOf } from '../src/apm-project.mjs';

// APM A1 (2026-10-29): SFlow reads the APM project the APM CLI left (apm.yml, apm.lock.yaml and the
// files it deployed into .github/) and says whether each deployed file is intact and committed.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
};

const FILES = Object.freeze({
  '.github/agents/reviewer.agent.md': '---\nname: reviewer\ndescription: Reviews pull requests\n---\nReview the change.\n',
  '.github/skills/code-review/SKILL.md': '---\nname: code-review\ndescription: Review code\n---\nSteps.\n',
  '.github/instructions/typescript.instructions.md': '---\napplyTo: "**/*.ts"\n---\nUse strict types.\n',
  '.github/agents/planner.agent.md': '---\nname: planner\n---\nPlan the work.\n',
  '.github/prompts/release-notes.prompt.md': 'Write release notes.\n'
});

async function project(t, { manifest, lock, files = FILES, commit = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-apm-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Packager'], ['user.email', 'packager@example.com']]) git(root, 'config', key, value);
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  if (manifest) await writeFile(path.join(root, 'apm.yml'), typeof manifest === 'string' ? manifest : YAML.stringify(manifest));
  if (lock) await writeFile(path.join(root, 'apm.lock.yaml'), typeof lock === 'string' ? lock : YAML.stringify(lock));
  if (commit) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'apm install'); }
  return root;
}

const hashes = (paths) => Object.fromEntries(paths.map((relative) => [relative, sha(FILES[relative])]));
const MANIFEST = Object.freeze({
  name: 'payments-agents', version: '1.0.0', targets: ['copilot'],
  dependencies: { apm: ['acme/review-pack', { name: 'planner', marketplace: 'acme-catalog', version: '^2.0.0' }] }
});
function lockFor({ review = ['.github/agents/reviewer.agent.md', '.github/skills/code-review/SKILL.md'], planner = ['.github/agents/planner.agent.md'] } = {}) {
  return {
    lockfile_version: '1', apm_version: '0.29.1',
    dependencies: [
      { repo_url: 'acme/review-pack', resolved_commit: 'a'.repeat(40), resolved_ref: 'main', name: 'review-pack', version: '1.4.0', depth: 1,
        package_type: 'apm_package', deployed_files: review, deployed_file_hashes: hashes(review) },
      { repo_url: 'acme/catalog-planner', resolved_commit: 'b'.repeat(40), name: 'planner', version: '2.1.0', depth: 1,
        discovered_via: 'acme-catalog', marketplace_plugin_name: 'planner', deployed_files: planner, deployed_file_hashes: hashes(planner) }
    ],
    local_deployed_files: ['.github/instructions/typescript.instructions.md'],
    local_deployed_file_hashes: { '.github/instructions/typescript.instructions.md': `sha256:${sha(FILES['.github/instructions/typescript.instructions.md'])}` }
  };
}

test('a committed APM project whose deployed files match the lock is intact, and names what each package deployed', async (t) => {
  const root = await project(t, { manifest: MANIFEST, lock: lockFor() });
  const status = await apmProjectStatus(root, { cliVersion: false });
  assert.equal(status.resultType, 'sflow-apm-status');
  assert.equal(status.state, 'intact', JSON.stringify(status.findings));
  assert.deepEqual(status.findings, []);
  assert.equal(status.manifest.name, 'payments-agents');
  assert.deepEqual(status.packages.map((entry) => entry.label), ['acme/review-pack', 'planner@acme-catalog']);
  assert.deepEqual(status.packages[0].primitives.map(({ kind, name }) => `${kind}:${name}`), ['agent:reviewer', 'skill:code-review']);
  assert.equal(status.packages[0].files.ok, 2);
  assert.deepEqual(status.local.primitives.map(({ kind, name }) => `${kind}:${name}`), ['instruction:typescript']);
  assert.deepEqual(status.unmanagedAgents, [], 'every agent here came from APM');
  assert.deepEqual(status.nextActions, []);
});

test('a deployed file edited by hand or deleted is drifted, and CRLF line endings alone are not a change', async (t) => {
  const root = await project(t, { manifest: MANIFEST, lock: lockFor() });
  await writeFile(path.join(root, '.github/skills/code-review/SKILL.md'), FILES['.github/skills/code-review/SKILL.md'].replaceAll('\n', '\r\n'));
  assert.equal((await apmProjectStatus(root, { cliVersion: false })).state, 'intact', 'a CRLF checkout matches the lock');

  await writeFile(path.join(root, '.github/agents/reviewer.agent.md'), `${FILES['.github/agents/reviewer.agent.md']}Approve everything.\n`);
  await rm(path.join(root, '.github/agents/planner.agent.md'));
  const status = await apmProjectStatus(root, { cliVersion: false });
  assert.equal(status.state, 'drifted');
  assert.deepEqual(status.findings.map((entry) => `${entry.code} ${entry.path}`).sort(), [
    'deployed-missing .github/agents/planner.agent.md', 'deployed-modified .github/agents/reviewer.agent.md'
  ]);
  assert.equal(status.findings.find((entry) => entry.code === 'deployed-modified').owner, 'acme/review-pack');
  assert.deepEqual(status.unmanagedAgents, [], 'a changed or deleted APM agent is still APM\'s, never the repository\'s own');
  assert.deepEqual(status.nextActions.map((entry) => entry.command), ['apm install']);
});

test('deployed files that are not committed say so, and name what to commit', async (t) => {
  const root = await project(t, { manifest: MANIFEST, lock: lockFor(), commit: false });
  git(root, 'add', '.github/skills');
  git(root, 'commit', '-q', '-m', 'only the skills');
  const status = await apmProjectStatus(root, { cliVersion: false });
  assert.equal(status.state, 'uncommitted');
  const finding = status.findings.find((entry) => entry.code === 'not-committed');
  assert.deepEqual(finding.paths.sort(), ['.github/agents/planner.agent.md', '.github/agents/reviewer.agent.md',
    '.github/instructions/typescript.instructions.md', 'apm.lock.yaml', 'apm.yml']);
  assert.deepEqual(status.nextActions.map((entry) => entry.command), ['git add .github/ apm.lock.yaml apm.yml']);
});

test('a declared package missing from the lock, a locked one no longer declared, and no lock at all', async (t) => {
  const declared = { ...MANIFEST, dependencies: { apm: ['acme/review-pack', 'acme/security-pack#v2', 'gitlab.example.org/team/pack'] } };
  const root = await project(t, { manifest: declared, lock: lockFor() });
  const status = await apmProjectStatus(root, { cliVersion: false });
  assert.equal(status.state, 'unlocked');
  assert.deepEqual(status.findings.filter((entry) => entry.code === 'declared-not-locked').map((entry) => entry.dependency), ['acme/security-pack#v2'],
    'another host is never guessed at');
  assert.deepEqual(status.findings.filter((entry) => entry.code === 'locked-not-declared'), [],
    'stale entries are named only when every declared form was understood');

  const confident = await project(t, { manifest: { ...MANIFEST, dependencies: { apm: ['acme/review-pack'] } }, lock: lockFor() });
  const stale = await apmProjectStatus(confident, { cliVersion: false });
  assert.deepEqual(stale.findings.map((entry) => `${entry.code} ${entry.dependency}`), ['locked-not-declared planner@acme-catalog']);
  assert.deepEqual(stale.nextActions.map((entry) => entry.command), ['apm prune']);

  const unlocked = await project(t, { manifest: MANIFEST });
  const none = await apmProjectStatus(unlocked, { cliVersion: false });
  assert.equal(none.state, 'unlocked');
  assert.equal(none.lock, null);
  assert.deepEqual(none.findings.map((entry) => entry.code), ['lock-missing']);
  assert.deepEqual(none.nextActions.map((entry) => entry.command), ['apm install']);
});

test('lock paths outside the repository, absolute paths and symbolic links are never read', async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-apm-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret.md'), 'outside the repository\n');
  const lock = lockFor();
  lock.dependencies[0].deployed_files.push('../secret.md', '/etc/hosts', 'C:/Windows/win.ini', '.github/agents/linked.agent.md');
  lock.dependencies[0].deployed_file_hashes['.github/agents/linked.agent.md'] = sha('outside the repository\n');
  const root = await project(t, { manifest: MANIFEST, lock, commit: false });
  await symlink(path.join(outside, 'secret.md'), path.join(root, '.github/agents/linked.agent.md'));
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'install');
  const status = await apmProjectStatus(root, { cliVersion: false });
  assert.equal(status.state, 'drifted');
  assert.equal(status.findings.filter((entry) => entry.code === 'lock-path-refused').length, 3);
  assert.deepEqual(status.findings.filter((entry) => entry.code === 'deployed-not-regular').map((entry) => entry.path), ['.github/agents/linked.agent.md']);
});

test('an unreadable apm.yml or lock is named with its line, and a repository with neither is absent', async (t) => {
  const broken = await project(t, { manifest: 'name: x\nversion: 1.0.0\ndependencies:\n  apm: [unclosed\n', lock: lockFor() });
  const status = await apmProjectStatus(broken, { cliVersion: false });
  assert.equal(status.state, 'unreadable');
  assert.match(status.findings[0].message, /^apm\.yml is not valid YAML \(line \d+\)/u);

  const incomplete = await project(t, { manifest: { dependencies: { apm: [] } } });
  assert.deepEqual((await apmProjectStatus(incomplete, { cliVersion: false })).findings.map((entry) => entry.message),
    ['apm.yml has no name; APM requires name and version.', 'apm.yml has no version; APM requires name and version.']);

  const empty = await project(t, { files: { 'README.md': '# none\n' } });
  const absent = await apmProjectStatus(empty, { cliVersion: false });
  assert.equal(absent.state, 'absent');
  assert.deepEqual(absent.nextActions.map((entry) => entry.command), ['apm init']);
});

test('agents in .github/agents that APM did not deploy are listed as the repository\'s own', async (t) => {
  const root = await project(t, { manifest: MANIFEST, lock: lockFor({ planner: [] }) });
  const status = await apmProjectStatus(root, { cliVersion: false });
  assert.deepEqual(status.unmanagedAgents, ['.github/agents/planner.agent.md']);
});

test('apm status prints in plain words, and refuses an unknown subcommand or option', async (t) => {
  const root = await project(t, { manifest: MANIFEST, lock: lockFor() });
  // No apm on PATH, whatever this machine has installed.
  const PATH = String(process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry && !existsSync(path.join(entry, 'apm'))).join(path.delimiter);
  const env = { ...process.env, NODE_ENV: 'test', PATH };
  const shown = spawnSync(process.execPath, [bin, 'apm', 'status'], { cwd: root, encoding: 'utf8', env });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /APM project payments-agents 1\.0\.0: 2 declared packages\./u);
  assert.match(shown.stdout, /acme\/review-pack: 2 files; agent reviewer; skill code-review\./u);
  assert.match(shown.stdout, /Every deployed APM file matches apm\.lock\.yaml and is committed\./u);
  assert.match(shown.stdout, /No APM CLI on this machine's PATH/u);
  const json = JSON.parse(spawnSync(process.execPath, [bin, 'apm', 'status', '--json'], { cwd: root, encoding: 'utf8', env }).stdout);
  assert.equal(json.state, 'intact');
  const unknown = spawnSync(process.execPath, [bin, 'apm', 'deploy'], { cwd: root, encoding: 'utf8', env });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr + unknown.stdout, /status/u);
  const option = spawnSync(process.execPath, [bin, 'apm', 'status', '--network'], { cwd: root, encoding: 'utf8', env });
  assert.notEqual(option.status, 0);
});

test('a lock exactly as apm 0.35.0 writes it: a skill folder listed without a slash or hash, skills in .agents, a local package', async (t) => {
  // Shape copied from `apm install ../review-pack` with apm 0.35.0 (2026-10-29); apm audit --ci agreed with every verdict.
  const files = {
    '.agents/skills/code-review/SKILL.md': '---\nname: code-review\ndescription: Review code for defects\n---\n# Code review\nSteps.\n',
    '.github/agents/reviewer.agent.md': '---\nname: reviewer\ndescription: Reviews pull requests\ntools: [read, search]\n---\nReview the change carefully.\n'
  };
  const deployed = ['.agents/skills/code-review', ...Object.keys(files)];
  const lock = {
    lockfile_version: '1', apm_version: '0.35.0',
    dependencies: [{
      repo_url: '_local/review-pack', name: 'review-pack', version: '1.0.0', package_type: 'apm_package',
      deployed_files: deployed,
      deployed_file_hashes: Object.fromEntries(Object.entries(files).map(([relative, text]) => [relative, `sha256:${sha(text)}`])),
      source: 'local', local_path: '../review-pack', content_hash: `sha256:${'e'.repeat(64)}`, declared_license: 'MIT'
    }],
    deployments: deployed.map((value) => ({ kind: 'project-relative', target: 'copilot', value, runtime: null, scope: 'project',
      owners: ['../review-pack'], active_owner: '../review-pack', content_hash: files[value] ? `sha256:${sha(files[value])}` : null }))
  };
  const manifest = { name: 'consumer', version: '1.0.0', targets: ['copilot'], dependencies: { apm: ['../review-pack'], mcp: [] }, includes: 'auto', scripts: {} };
  const root = await project(t, { manifest, lock, files });
  const status = await apmProjectStatus(root, { cliVersion: false });
  assert.equal(status.state, 'intact', JSON.stringify(status.findings));
  assert.equal(status.packages[0].label, 'review-pack (local)');
  assert.equal(status.packages[0].files.ok, 3, 'the skill folder counts as present');
  assert.deepEqual(status.packages[0].primitives.map(({ kind, name, target }) => `${kind}:${name}:${target}`),
    ['skill:code-review:.agents', 'agent:reviewer:.github']);

  await rm(path.join(root, '.agents/skills/code-review'), { recursive: true });
  assert.deepEqual((await apmProjectStatus(root, { cliVersion: false })).findings.map((entry) => `${entry.code} ${entry.path}`),
    ['deployed-missing .agents/skills/code-review', 'deployed-missing .agents/skills/code-review/SKILL.md']);
});

test('the readers: dependency forms, deployed paths, primitives and hashes', () => {
  assert.deepEqual(declaredDependency('acme/agents/review#v1'), { kind: 'github', label: 'acme/agents/review#v1', repository: 'acme/agents', virtualPath: 'review', ref: 'v1', confident: true });
  assert.equal(declaredDependency('planner@acme-catalog').kind, 'marketplace');
  assert.equal(declaredDependency('git@git.example.org:acme/agents.git').confident, false);
  assert.equal(declaredDependency('./packages/local').kind, 'local');
  assert.equal(declaredDependency({ git: `https://${['github', 'com'].join('.')}/Acme/Agents.git`, path: 'review' }).repository, 'acme/agents',
    'a GitHub clone URL is the same repository as its shorthand');
  assert.equal(deployedPath('../x'), null);
  assert.equal(deployedPath('a//b'), null);
  assert.equal(deployedPath('.github/skills/x/').directory, true);
  assert.deepEqual(primitiveOf('.cursor/agents/reviewer.md'), { kind: 'agent', name: 'reviewer', target: '.cursor' });
  assert.equal(primitiveOf('.github/skills/x/references/a.md'), null);
  assert.equal(bytesMatch(Buffer.from('a\r\nb\n'), sha('a\nb\n')), true);
  assert.equal(bytesMatch(Buffer.from('a\0\r\nb'), sha('a\0\nb')), false, 'binary files are compared as they are');
});
