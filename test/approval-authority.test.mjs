import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchApprovalAuthority,
  normalizeApprovalAuthorities,
  normalizeApprovalPolicy,
  requireApprovalAuthority
} from '../src/approval-authority.mjs';

const authorities = {
  'architecture-reviewers': {
    label: 'Architecture reviewers',
    members: [
      { name: 'Asha Architect', email: 'ASHA@EXAMPLE.COM' },
      { name: 'GitHub reviewer', githubLogin: 'Flow-Reviewer' }
    ]
  },
  'git-contributors': {
    label: 'Git contributors',
    allowAnyGitIdentity: true,
    members: []
  }
};

test('approval authority matches real identity independently of governed agent', () => {
  const policy = normalizeApprovalPolicy(
    { authorities: ['architecture-reviewers'], minimum: 1 },
    authorities,
    'design'
  );
  const authorized = matchApprovalAuthority(authorities, policy, {
    name: 'Different display name',
    email: 'asha@example.com'
  });
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.authorityGroup, 'architecture-reviewers');
  assert.equal(authorized.identityAssurance, 'configured-local');

  const denied = matchApprovalAuthority(authorities, policy, {
    name: 'Developer using architect lens',
    email: 'developer@example.com',
    agent: 'architect'
  });
  assert.equal(denied.authorized, false);
  assert.match(denied.reason, /not a member/);
  assert.throws(
    () => requireApprovalAuthority(authorities, policy, { email: 'developer@example.com' }),
    /not a member/
  );
});

test('approval authority supports authenticated GitHub login and explicit any-Git groups', () => {
  const architecture = normalizeApprovalPolicy(
    { authorities: ['architecture-reviewers'] },
    authorities,
    'design'
  );
  const github = matchApprovalAuthority(authorities, architecture, { login: 'flow-reviewer' });
  assert.equal(github.authorized, true);
  assert.equal(github.identityAssurance, 'github-authenticated');

  const contributors = normalizeApprovalPolicy(
    { authorities: ['git-contributors'] },
    authorities,
    'implementation'
  );
  const local = matchApprovalAuthority(authorities, contributors, { email: 'anyone@example.com' });
  assert.equal(local.authorized, true);
  assert.equal(local.authorityGroup, 'git-contributors');
});

test('approval policy normalizes configurable governed change-request controls', () => {
  const defaults = normalizeApprovalPolicy({ authorities: ['architecture-reviewers'] }, authorities, 'design');
  assert.deepEqual(defaults.changeRequests, { commentRequired: true, reopenCompleted: true });
  const configured = normalizeApprovalPolicy({
    authorities: ['architecture-reviewers'],
    changeRequests: { commentRequired: false, reopenCompleted: false }
  }, authorities, 'design');
  assert.deepEqual(configured.changeRequests, { commentRequired: false, reopenCompleted: false });
  assert.throws(() => normalizeApprovalPolicy({
    authorities: ['architecture-reviewers'], changeRequests: { reopenCompleted: 'yes' }
  }, authorities, 'design'), /reopenCompleted must be boolean/);
});

test('approval authority configuration rejects empty restricted groups and duplicate identities', () => {
  assert.throws(
    () => normalizeApprovalAuthorities({ restricted: { label: 'Restricted', members: [] } }),
    /must list members/
  );
  assert.throws(
    () => normalizeApprovalAuthorities({
      duplicate: {
        members: [
          { email: 'reviewer@example.com' },
          { email: 'REVIEWER@example.com' }
        ]
      }
    }),
    /more than once/
  );
});
