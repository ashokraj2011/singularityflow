/** Copilot never reads, searches or edits an environment file [SPEC-ENVIRONMENT-FILES, Protection]. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  environmentFilesToolGuard, environmentFileProtection, workspaceEnvironmentFilesBase
} from '../src/copilot-environment-files-guard.mjs';
import { workspaceFilesBase } from '../src/environment-files.mjs';
import { setHookCli } from '../src/copilot-mode.mjs';
import { renderPlatformCommand } from '../src/safe-command-guidance.mjs';
import { git, repository, writeFiles } from './helpers/environment-files-fixture.mjs';

const SPRING = 'services/api/src/main/resources/application-dev.yml';
const call = (cwd, toolName, toolArgs) => ({ cwd, toolName, toolArgs });
const denied = (result) => result?.permissionDecision === 'deny' && /^ENVIRONMENT_FILE_PRIVATE/u.test(result.permissionDecisionReason);

test('file tools, searches, patches and shell commands that name an environment file are refused in any turn', async (t) => {
  const repo = await repository(t, { files: { 'services/api/src/main/resources/application-dev.example.yml': 'password: CHANGE_ME\n', 'src/App.jsx': 'x\n' } });
  assert.equal(repo.json(['env', 'files', 'create', 'dev', SPRING, '--from-template']).status, 0);
  const location = repo.json(['env', 'files', 'path', 'dev', SPRING]).value.location;
  const guard = (toolName, toolArgs, cwd = repo.root) => environmentFilesToolGuard(call(cwd, toolName, toolArgs), { env: repo.env });

  for (const [toolName, toolArgs] of [
    ['read', { path: SPRING }],
    ['view', { path: path.join(repo.root, SPRING) }],
    ['edit', { path: SPRING, old_str: 'a', new_str: 'b' }],
    ['create', { path: 'apps/web/.env.dev', file_text: 'TOKEN=x' }],
    ['read', { path: location }],
    ['view', { path: `file://${location}` }],
    ['read', { path: 'config/app.local.yml' }],
    ['apply_patch', { input: `*** Begin Patch\n*** Update File: ${SPRING}\n@@\n-a\n+b\n*** End Patch` }],
    ['grep', { pattern: 'password', path: 'services/api/src/main/resources/application-dev.yml' }],
    ['bash', { command: `cat ${SPRING}` }],
    ['bash', { command: `grep -r password ${path.dirname(location)}` }],
    ['bash', { command: 'singularity-flow env files link dev .env --to /tmp/secret.env' }],
    ['bash', { command: 'singularity-flow env files root uat /tmp/uat' }],
    ['bash', { command: `singularity-flow env files create dev ${SPRING}` }],
    ['bash', { command: 'singularity-flow env files path dev .env && cat .env' }]
  ]) {
    assert.ok(denied(await guard(toolName, toolArgs)), `${toolName} ${JSON.stringify(toolArgs)}`);
  }
  // From a subdirectory too: the repository is found by walking up.
  assert.ok(denied(await guard('read', { path: 'application-dev.yml' }, path.join(repo.root, 'services/api/src/main/resources'))));
  // A path can spell the repository another way (a Windows 8.3 short name, here a link; a junction
  // needs no privilege on Windows), including a file that does not exist yet.
  const alias = path.join(path.dirname(repo.root), `${path.basename(repo.root)}-alias`);
  await symlink(repo.root, alias, 'junction');
  t.after(() => rm(alias, { force: true }));
  assert.ok(denied(await guard('view', { path: path.join(alias, SPRING) })));
  assert.ok(denied(await guard('create', { path: path.join(alias, 'apps/web/.env.dev'), file_text: 'TOKEN=x' })));

  for (const [toolName, toolArgs] of [
    ['read', { path: 'src/App.jsx' }],
    ['read', { path: 'services/api/src/main/resources/application-dev.example.yml' }],
    ['edit', { path: 'src/App.jsx', old_str: 'x', new_str: 'y' }],
    ['grep', { pattern: 'App', path: 'src' }],
    ['bash', { command: 'npm test' }],
    ['bash', { command: 'singularity-flow env files --json' }],
    ['bash', { command: 'singularity-flow env files dev --json' }],
    ['bash', { command: `singularity-flow env files path dev ${SPRING} --json` }],
    ['bash', { command: 'singularity-flow env files suggest --json' }],
    ['bash', { command: `singularity-flow env files create uat ${SPRING.replace('dev', 'uat')} --from-template --json` }],
    ['bash', { command: 'singularity-flow env files place dev' }]
  ]) {
    assert.equal(await guard(toolName, toolArgs), null, `${toolName} ${JSON.stringify(toolArgs)}`);
  }
});

test('the launcher\'s verified Node and CLI entry, which the turn names off PATH, are the CLI here too', async (t) => {
  const repo = await repository(t, { files: { 'services/api/src/main/resources/application-dev.example.yml': 'password: CHANGE_ME\n' } });
  assert.equal(repo.json(['env', 'files', 'create', 'dev', SPRING, '--from-template']).status, 0);
  const guard = (toolName, command) => environmentFilesToolGuard(call(repo.root, toolName, { command }), { env: repo.env });
  const node = path.resolve('/opt/Node runtime/bin/node');
  const entry = path.resolve('/opt/npm prefix/lib/node_modules/singularity-flow/bin/singularity-flow.mjs');
  setHookCli({ node, cli: entry, onPath: false });
  t.after(() => setHookCli(null));
  const verified = renderPlatformCommand([node, entry], 'linux');
  for (const rest of [' env files link dev .env --to /tmp/secret.env', ' env files root uat /tmp/uat', ' env files --json', ` env files path dev ${SPRING} --json`]) {
    assert.deepEqual(await guard('bash', `${verified}${rest}`), await guard('bash', `singularity-flow${rest}`), rest);
    assert.deepEqual(await guard('powershell', `${renderPlatformCommand([node, entry], 'win32')}${rest}`),
      await guard('powershell', `& singularity-flow${rest}`), rest);
  }
  assert.ok(denied(await guard('bash', `${verified} env files link dev .env --to /tmp/secret.env`)));
});

test('personal files, linked files and workspace folders are protected too, and a fresh repository pays nothing', async (t) => {
  const repo = await repository(t);
  const own = path.join(repo.base, 'my-secrets', 'api-dev.yml');
  await mkdir(path.dirname(own), { recursive: true });
  await writeFile(own, 'token: s3cr3t-value\n');
  assert.equal(repo.json(['env', 'files', 'add', 'dev', 'tools/dev.local.json', '--personal']).status, 0);
  assert.equal(repo.json(['env', 'files', 'link', 'dev', SPRING, '--to', own]).status, 0);
  const folder = path.join(repo.base, 'uat-folder');
  await mkdir(folder, { recursive: true });
  // The folder settings env files root writes for an active workspace (machine-local, beside the registry).
  await mkdir(workspaceFilesBase(repo.env), { recursive: true });
  await writeFile(path.join(workspaceFilesBase(repo.env), 'roots.json'),
    JSON.stringify({ schemaVersion: 1, kind: 'environment-files-roots', workspaces: { team: { uat: folder } } }));
  const guard = (toolName, toolArgs) => environmentFilesToolGuard(call(repo.root, toolName, toolArgs), { env: repo.env });
  assert.ok(denied(await guard('read', { path: 'tools/dev.local.json' })), 'a personal file');
  assert.ok(denied(await guard('read', { path: own })), 'a linked real file outside the repository');
  assert.ok(denied(await guard('bash', { command: `cat ${own}` })));
  assert.ok(denied(await guard('read', { path: path.join(folder, 'repo', SPRING) })), 'a workspace folder');
  assert.ok(denied(await guard('glob', { pattern: '*.yml', path: folder })));

  // The guard reads the same workspace-level location the engine writes.
  assert.equal(workspaceEnvironmentFilesBase(repo.env), workspaceFilesBase(repo.env));

  // No declaration, no registry, no workspace state: nothing to protect and nothing loaded.
  const bare = await realpath(await mkdtemp(path.join(tmpdir(), 'sflow-envf-bare-')));
  t.after(() => rm(bare, { recursive: true, force: true }));
  git(bare, ['init', '-q', '-b', 'main', path.join(bare, 'repo')]);
  await writeFiles(path.join(bare, 'repo'), { 'README.md': 'x\n' });
  const env = { ...repo.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(bare, 'state', 'workspaces.json') };
  assert.equal(await environmentFileProtection(path.join(bare, 'repo'), { env }), null);
  assert.equal(await environmentFilesToolGuard(call(path.join(bare, 'repo'), 'read', { path: '.env' }), { env }), null);
});

test('a linked worktree is protected through the shared registry', async (t) => {
  const repo = await repository(t);
  assert.equal(repo.json(['env', 'files', 'create', 'dev', 'apps/web/.env.dev']).status, 0);
  const worktree = path.join(repo.base, 'story-wt');
  git(repo.root, ['worktree', 'add', '-q', '-b', 'story', worktree, 'HEAD']);
  const result = await environmentFilesToolGuard(call(worktree, 'read', { path: 'apps/web/.env.dev' }), { env: repo.env });
  assert.ok(denied(result));
});

test('the explicit-turn boundary refuses before any turn mode is consulted; native chat is untouched', async (t) => {
  const { recordRepositoryBoundaryTurn, repositoryToolGuard } = await import('../src/copilot-repository-boundary.mjs');
  const repo = await repository(t);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(repo.base, 'machine', 'mode.json');
  t.after(() => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
  });
  const read = { cwd: repo.root, sessionId: 'envf-turn', toolName: 'read', toolArgs: { path: '.env' } };
  assert.deepEqual(await repositoryToolGuard({ ...read, sessionId: 'native-chat' }), {}, 'no explicit turn: not guarded here');
  await recordRepositoryBoundaryTurn({ cwd: repo.root, sessionId: 'envf-turn', prompt: '/sf-phase' }, { captureMutation: async () => {} });
  const refused = await repositoryToolGuard(read);
  assert.equal(refused.permissionDecision, 'deny');
  assert.match(refused.permissionDecisionReason, /^ENVIRONMENT_FILE_PRIVATE: \.env /u);
});
