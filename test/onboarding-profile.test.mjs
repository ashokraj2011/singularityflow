import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  normalizeOnboardingProfile,
  readOnboardingProfile,
  saveOnboardingProfile,
  validateOnboardingWorkspace
} from '../apps/desktop/electron/onboarding-profile.mjs';

test('onboarding profile validates the minimum ready state while keeping repositories optional', () => {
  const draft = normalizeOnboardingProfile({
    name: 'Ashok Raj',
    role: 'architect',
    step: 3,
    workspacePath: '/tmp/singularity-workspaces',
    repositories: [],
    jiraChoice: 'not-used'
  });
  assert.equal(draft.completed, false);
  assert.equal(draft.step, 3);
  assert.deepEqual(draft.repositories, []);
  const completed = normalizeOnboardingProfile(draft, { complete: true });
  assert.equal(completed.completed, true);
  assert.equal(completed.step, 4);
  assert.equal(completed.jiraChoice, 'not-used');
});

test('onboarding completion requires name, role, workspace, and a Jira decision', () => {
  const base = {
    name: 'Delivery User',
    role: 'developer',
    workspacePath: '/tmp/workspaces',
    repositories: []
  };
  assert.throws(() => normalizeOnboardingProfile({ ...base, name: '' }, { complete: true }), /name/);
  assert.throws(() => normalizeOnboardingProfile({ ...base, role: '' }, { complete: true }), /role/);
  assert.throws(() => normalizeOnboardingProfile({ ...base, workspacePath: '' }, { complete: true }), /workspace/);
  assert.throws(() => normalizeOnboardingProfile(base, { complete: true }), /Connect Jira or confirm/);
  assert.equal(
    normalizeOnboardingProfile({ ...base, jiraChoice: 'connected' }, { complete: true, jiraConnected: true }).jiraChoice,
    'connected'
  );
  assert.throws(
    () => normalizeOnboardingProfile({ ...base, jiraChoice: 'connected' }, { complete: true, jiraConnected: false }),
    /Reconnect Jira or explicitly confirm/
  );
  assert.throws(
    () => normalizeOnboardingProfile({ ...base, jiraChoice: 'disconnected' }, { complete: true }),
    /Reconnect Jira or explicitly confirm/
  );
});

test('onboarding profile persists locally, deduplicates repositories, and never contains credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-'));
  const file = path.join(root, 'settings', 'onboarding.json');
  const saved = await saveOnboardingProfile(file, {
    name: 'Product User',
    role: 'product-owner',
    step: 4,
    workspacePath: path.join(root, 'workspaces'),
    repositories: [
      { path: path.join(root, 'mobile'), name: 'Mobile' },
      { path: path.join(root, 'mobile'), name: 'Mobile application' }
    ],
    jiraChoice: 'connected',
    token: 'must-not-be-stored'
  }, { complete: true, jiraConnected: true });
  assert.equal(saved.repositories.length, 1);
  assert.equal(saved.repositories[0].name, 'Mobile application');
  const content = await readFile(file, 'utf8');
  assert.doesNotMatch(content, /must-not-be-stored|token/i);
  const loaded = await readOnboardingProfile(file, { jiraConnected: true });
  assert.equal(loaded.completed, true);
  assert.equal(loaded.name, 'Product User');
  await writeFile(file, '{malformed');
  const recovered = await readOnboardingProfile(file);
  assert.equal(recovered.completed, false);
  assert.equal(recovered.recovery.reason, 'invalid-json');
});

test('an obsolete valid profile recovers to the wizard instead of blocking startup forever', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-obsolete-'));
  const file = path.join(root, 'onboarding.json');
  await writeFile(file, JSON.stringify({
    completed: true,
    name: 'Legacy User',
    role: 'removed-role',
    workspacePath: '/tmp/workspaces',
    jiraChoice: 'not-used'
  }));
  const recovered = await readOnboardingProfile(file);
  assert.equal(recovered.completed, false);
  assert.equal(recovered.role, null);
  assert.equal(recovered.recovery.reason, 'invalid-profile');
  assert.match(recovered.recovery.message, /removed-role/);
});

test('a removed Jira credential does not force a completed user through onboarding again', () => {
  const profile = normalizeOnboardingProfile({
    completed: true,
    name: 'Architect',
    role: 'architect',
    workspacePath: '/tmp/workspaces',
    jiraChoice: 'connected'
  }, { complete: true, jiraConnected: false });
  assert.equal(profile.completed, true);
  assert.equal(profile.jiraChoice, 'disconnected');
});

test('onboarding workspace validation canonicalizes directory aliases and rejects files and filesystem roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-workspace-'));
  const workspace = path.join(root, 'workspace-home');
  const alias = path.join(root, 'workspace-alias');
  await mkdir(workspace);
  await symlink(workspace, alias, 'dir');
  assert.equal(await validateOnboardingWorkspace(alias), await realpath(workspace));

  const file = path.join(root, 'not-a-directory');
  await writeFile(file, 'no');
  await assert.rejects(() => validateOnboardingWorkspace(file), /must be a directory/);
  await assert.rejects(() => validateOnboardingWorkspace(path.parse(root).root), /specific local workspace/);
});

test('onboarding rejects repository overflow instead of silently dropping selections', () => {
  assert.throws(
    () => normalizeOnboardingProfile({
      repositories: Array.from({ length: 21 }, (_, index) => `/tmp/repository-${index}`)
    }),
    /at most 20/
  );
});
