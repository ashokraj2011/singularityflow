import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { assertStartDocumentNotEnvironmentLocal } from '../src/documents.mjs';
import { loadEnvironmentDeclarationSync, matchEnvironmentLocalPath } from '../src/environment-declaration.mjs';
import { worldModelSourceSnapshot } from '../src/grounding.mjs';
import {
  admitGovernedPublication, assertNoSecrets, commit, environmentFilesRegistryPolicySync, withEnvironmentFilesRegistry
} from '../src/git.mjs';
import { readKnowledgeSource } from '../src/knowledge/source.mjs';
import { git, repository, writeFiles } from './helpers/environment-files-fixture.mjs';

const PERSONAL = 'notes/personal.env';

async function withPersonalFile(t) {
  const repo = await repository(t);
  assert.equal(repo.json(['env', 'files', 'add', 'dev', PERSONAL, '--personal']).status, 0);
  assert.equal(repo.json(['env', 'files', 'create', 'dev', PERSONAL]).status, 0);
  assert.equal(repo.json(['env', 'files', 'create', 'dev', 'apps/web/.env.dev']).status, 0);
  return repo;
}

test('commit and publication gates refuse a forced add of a placed file and of a personal file', async (t) => {
  const repo = await withPersonalFile(t);
  git(repo.root, ['add', '-f', 'apps/web/.env.dev', PERSONAL]);
  assert.throws(() => assertNoSecrets(repo.root), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
    assert.match(error.message, /apps\/web\/\.env\.dev matches environments\.dev\.localFiles rule 'apps\/web\/\.env\.dev'/u);
    assert.match(error.message, /notes\/personal\.env matches this machine's env files registry \(dev\) rule 'notes\/personal\.env'/u);
    assert.deepEqual(error.details.paths.sort(), ['apps/web/.env.dev', PERSONAL].sort());
    return true;
  });
  git(repo.root, ['reset', '-q']);
  git(repo.root, ['add', '-f', PERSONAL]);
  // A scoped commit takes force-added paths the clone ignores; the gate must see them too.
  assert.throws(() => commit(repo.root, 'must refuse the personal file', ['notes']), { code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED' });
  git(repo.root, ['reset', '-q']);
  // Even with the local exclusion lost, publication refuses the path by the registry alone.
  await writeFile(path.join(repo.root, '.git', 'info', 'exclude'), '');
  assert.throws(() => admitGovernedPublication(repo.root, ['notes']), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
    assert.match(error.message, /Publication was refused/u);
    return true;
  });
  git(repo.root, ['reset', '-q']);
  assert.equal(git(repo.root, ['log', '--oneline']).stdout.trim().split('\n').length, 1, 'nothing was committed');
});

test('the registry policy is paths only, exact, case-folded like localFiles, and fails closed when unreadable', async (t) => {
  const repo = await withPersonalFile(t);
  const policy = environmentFilesRegistryPolicySync(repo.root);
  assert.deepEqual(policy.environmentFiles, { dev: ['apps/web/.env.dev', PERSONAL] });
  assert.equal(matchEnvironmentLocalPath(policy, 'NOTES/Personal.ENV')?.kind, 'environment-file');
  assert.equal(matchEnvironmentLocalPath(policy, 'notes/personal.env.bak'), null);
  const merged = withEnvironmentFilesRegistry(repo.root, loadEnvironmentDeclarationSync(repo.root));
  assert.equal(matchEnvironmentLocalPath(merged, PERSONAL).environmentId, 'dev');
  assert.equal(matchEnvironmentLocalPath(merged, 'config/x.local.yml').kind, 'local-file', 'the declaration still matches');
  const registry = path.join(repo.root, '.git', 'singularity-flow', 'environment-files', 'v1', 'registry.json');
  await writeFile(registry, '{"kind":"environment-files-registry","entries":[{"environment":"dev","path":"../escape"}]}');
  assert.throws(() => assertNoSecrets(repo.root), { code: 'ENVIRONMENT_POLICY_UNAVAILABLE' });
  const listed = repo.json(['env', 'files']);
  assert.equal(listed.value.error.code, 'ENVIRONMENT_FILES_REGISTRY_INVALID');
});

test('document admission refuses a personal environment file by its repository path', async (t) => {
  const repo = await withPersonalFile(t);
  await writeFiles(repo.root, { 'notes/other.md': '# plain\n' });
  const policy = withEnvironmentFilesRegistry(repo.root, loadEnvironmentDeclarationSync(repo.root));
  await assert.rejects(assertStartDocumentNotEnvironmentLocal(repo.root, policy, path.join(repo.root, PERSONAL)), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
    assert.match(error.message, /this machine's env files registry \(dev\)/u);
    return true;
  });
  await assertStartDocumentNotEnvironmentLocal(repo.root, policy, path.join(repo.root, 'notes/other.md'));
});

test('World Model, grounding and knowledge reads skip a personal file even when raw Git tracked it', async (t) => {
  const repo = await withPersonalFile(t);
  await mkdir(path.join(repo.root, 'src'), { recursive: true });
  await writeFile(path.join(repo.root, 'src', 'app.mjs'), 'export const app = 1;\n');
  // Raw Git bypasses every SFlow gate; readers must still exclude the path.
  await writeFile(path.join(repo.root, 'notes', 'tracked.env'), 'LEGACY=1\n');
  git(repo.root, ['add', '-f', 'src/app.mjs', 'notes/tracked.env']);
  git(repo.root, ['commit', '-q', '-m', 'historically tracked']);
  assert.equal(repo.json(['env', 'files', 'add', 'dev', 'notes/other.env', '--personal']).status, 0);
  const registry = path.join(repo.root, '.git', 'singularity-flow', 'environment-files', 'v1', 'registry.json');
  const { readFile } = await import('node:fs/promises');
  const record = JSON.parse(await readFile(registry, 'utf8'));
  // Simulate a registry entry for the historically tracked path (the add command refuses tracked paths).
  record.entries.push({ ...record.entries.find((entry) => entry.path === 'notes/other.env'), path: 'notes/tracked.env' });
  await writeFile(registry, JSON.stringify(record));
  const snapshot = await worldModelSourceSnapshot(repo.root, {});
  const files = snapshot.files.map((entry) => entry.path);
  assert.ok(files.includes('src/app.mjs'));
  assert.equal(files.includes('notes/tracked.env'), false);
  const listed = await readKnowledgeSource(repo.root, { listOnly: true });
  assert.equal(listed.paths.includes('notes/tracked.env'), false);
});

test('env audit lists a placed personal file as an ignored local file and a forced add as tracked', async (t) => {
  const repo = await withPersonalFile(t);
  const audit = repo.json(['env', 'audit']);
  assert.ok(audit.value.localFiles.some((entry) => entry.path === PERSONAL && entry.kind === 'environment-file'), JSON.stringify(audit.value.localFiles));
  git(repo.root, ['add', '-f', PERSONAL]);
  const tracked = repo.json(['env', 'audit']);
  assert.ok(tracked.value.findings.some((entry) => entry.path === PERSONAL && entry.code === 'environment.local-file-tracked'));
  git(repo.root, ['reset', '-q']);
});
