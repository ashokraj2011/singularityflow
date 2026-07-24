import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  normalizeOnboardingProfile,
  readOnboardingProfile,
  saveOnboardingProfile
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
  assert.equal((await readOnboardingProfile(file)).completed, false);
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
