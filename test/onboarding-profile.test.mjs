import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  normalizeOnboardingProfile,
  prepareOnboardingProfile,
  readOnboardingProfile,
  saveOnboardingProfile,
  validateOnboardingWorkspace
} from '../apps/desktop/electron/onboarding-profile.mjs';

test('onboarding profile requires only a local name and role while keeping integrations optional', () => {
  const draft = normalizeOnboardingProfile({
    name: 'Ashok Raj',
    role: 'architect',
    repositories: []
  });
  assert.equal(draft.completed, false);
  assert.equal(draft.experienceMode, 'engineer');
  assert.equal(draft.step, 0);
  assert.deepEqual(draft.repositories, []);
  const completed = normalizeOnboardingProfile(draft, { complete: true });
  assert.equal(completed.completed, true);
  assert.equal(completed.step, 4);
  assert.equal(completed.workspacePath, null);
  assert.equal(completed.jiraChoice, 'later');
});

test('onboarding derives a role-aware experience and preserves an explicit mode switch', () => {
  assert.equal(normalizeOnboardingProfile({ role: 'product-owner' }).experienceMode, 'business');
  assert.equal(normalizeOnboardingProfile({ role: 'business-analyst' }).experienceMode, 'business');
  assert.equal(normalizeOnboardingProfile({ role: 'developer' }).experienceMode, 'engineer');
  assert.equal(normalizeOnboardingProfile({
    name: 'Hands-on Product Owner',
    role: 'product-owner',
    experienceMode: 'engineer'
  }, { complete: true }).experienceMode, 'engineer');
});

test('onboarding completion validates name and role without forcing advanced setup', () => {
  const base = {
    name: 'Delivery User',
    role: 'developer',
    repositories: []
  };
  assert.throws(() => normalizeOnboardingProfile({ ...base, name: '' }, { complete: true }), /name/);
  assert.throws(() => normalizeOnboardingProfile({ ...base, role: '' }, { complete: true }), /role/);
  const minimal = normalizeOnboardingProfile(base, { complete: true });
  assert.equal(minimal.workspacePath, null);
  assert.equal(minimal.jiraChoice, 'later');
  assert.equal(
    normalizeOnboardingProfile({ ...base, jiraChoice: 'connected' }, { complete: true, jiraConnected: true }).jiraChoice,
    'connected'
  );
  assert.equal(
    normalizeOnboardingProfile({ ...base, jiraChoice: 'connected' }, { complete: true, jiraConnected: false }).jiraChoice,
    'disconnected'
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

test('a future onboarding profile version recovers instead of being silently misread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-future-'));
  const file = path.join(root, 'onboarding.json');
  await writeFile(file, JSON.stringify({
    schemaVersion: 999,
    completed: true,
    name: 'Future User',
    role: 'developer',
    workspacePath: '/tmp/workspaces',
    jiraChoice: 'not-used'
  }));
  const recovered = await readOnboardingProfile(file);
  assert.equal(recovered.completed, false);
  assert.equal(recovered.recovery.reason, 'invalid-profile');
  assert.match(recovered.recovery.message, /version 999/);
});

test('a removed Jira credential does not force a completed user through onboarding again', () => {
  const profile = normalizeOnboardingProfile({
    completed: true,
    name: 'Architect',
    role: 'architect',
    workspacePath: '/tmp/workspaces',
    jiraChoice: 'connected'
  }, { complete: true, jiraConnected: false, allowDisconnectedCompletion: true });
  assert.equal(profile.completed, true);
  assert.equal(profile.jiraChoice, 'disconnected');
});

test('incomplete onboarding recovers a stale workspace and removes unavailable optional repositories visibly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-recovery-'));
  const availableRepository = path.join(root, 'available');
  const unavailableRepository = path.join(root, 'unavailable');
  const prepared = await prepareOnboardingProfile({
    name: 'Recovery User',
    role: 'developer',
    step: 4,
    workspacePath: path.join(root, 'missing-workspace'),
    repositories: [
      { path: availableRepository, name: 'Available' },
      { path: unavailableRepository, name: 'Unavailable' }
    ],
    jiraChoice: 'not-used'
  }, {
    validateWorkspace: async () => { throw new Error('workspace moved'); },
    validateRepository: async (repository) => {
      if (repository === unavailableRepository) throw new Error('repository moved');
      return `${repository}-canonical`;
    }
  });

  assert.equal(prepared.profile.workspacePath, null);
  assert.equal(prepared.profile.step, 2);
  assert.deepEqual(prepared.profile.repositories, [{
    path: `${availableRepository}-canonical`,
    name: 'Available'
  }]);
  assert.deepEqual(prepared.notices.map((notice) => notice.kind), ['workspace', 'repository']);
  assert.match(prepared.notices[0].message, /select it again/i);
  assert.match(prepared.notices[1].message, /Unavailable/);
});

test('completed onboarding validates an explicitly selected advanced workspace', async () => {
  await assert.rejects(
    () => prepareOnboardingProfile({
      name: 'Recovery User',
      role: 'developer',
      step: 4,
      workspacePath: '/missing-workspace',
      repositories: [],
      jiraChoice: 'not-used'
    }, {
      complete: true,
      validateWorkspace: async () => { throw new Error('workspace moved'); },
      validateRepository: async (repository) => repository
    }),
    /workspace moved/
  );
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

test('onboarding normalizes persisted completion timestamps instead of trusting renderer values', () => {
  const completed = normalizeOnboardingProfile({
    name: 'Timestamp User',
    role: 'developer',
    workspacePath: '/tmp/workspaces',
    jiraChoice: 'not-used',
    completedAt: '2026-07-24T10:30:00+05:30'
  }, { complete: true });
  assert.equal(completed.completedAt, '2026-07-24T05:00:00.000Z');

  const repaired = normalizeOnboardingProfile({
    name: 'Timestamp User',
    role: 'developer',
    workspacePath: '/tmp/workspaces',
    jiraChoice: 'not-used',
    completedAt: 'not-a-date'
  }, { complete: true });
  assert.match(repaired.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(repaired.completedAt, 'not-a-date');
});
