import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalPolicyCapacity,
  approvalRequirementsMet,
  assertApprovalPolicyAttainable,
  matchApprovalAuthority,
  normalizeApprovalAuthorities,
  normalizeApprovalPolicy,
  normalizeApprovalSecurity,
  remainingRequiredAuthorities,
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
  assert.equal(defaults.allowSelfApproval, true);
  assert.equal(normalizeApprovalPolicy(
    { authorities: ['architecture-reviewers'] }, authorities, 'design',
    { profile: 'team', allowSelfApproval: false }
  ).allowSelfApproval, false);
  assert.equal(normalizeApprovalPolicy(
    { authorities: ['architecture-reviewers'] }, authorities, 'design', { profile: 'poc' }
  ).allowSelfApproval, true);
  const configured = normalizeApprovalPolicy({
    authorities: ['architecture-reviewers'],
    changeRequests: { commentRequired: false, reopenCompleted: false }
  }, authorities, 'design');
  assert.deepEqual(configured.changeRequests, { commentRequired: false, reopenCompleted: false });
  assert.throws(() => normalizeApprovalPolicy({
    authorities: ['architecture-reviewers'], changeRequests: { reopenCompleted: 'yes' }
  }, authorities, 'design'), /reopenCompleted must be boolean/);
});

test('approval security defaults to self approval and automatic enrollment with explicit controls', () => {
  assert.deepEqual(normalizeApprovalSecurity({ profile: 'team' }), {
    profile: 'team',
    allowAnyGitIdentity: false,
    allowSelfApproval: true,
    autoEnrollNewIdentities: true,
    requireNamedMembers: false
  });
  assert.equal(normalizeApprovalSecurity({
    profile: 'team', allowSelfApproval: false, autoEnrollNewIdentities: false
  }).allowSelfApproval, false);
  assert.equal(normalizeApprovalSecurity({ profile: 'regulated' }).autoEnrollNewIdentities, false);
  assert.throws(() => normalizeApprovalSecurity({ autoEnrollNewIdentities: 'yes' }), /must be boolean/);
});

test('regulated approval authority configuration rejects empty restricted groups and duplicate identities', () => {
  assert.throws(
    () => normalizeApprovalAuthorities(
      { restricted: { label: 'Restricted', members: [] } }, { profile: 'regulated' }
    ),
    /must list named members/
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

test('textual false cannot grant unrestricted reviewer access or evade regulated membership', () => {
  const registry = { restricted: { allowAnyGitIdentity: 'false', members: [] } };
  const policy = { authorities: ['restricted'], requiredAuthorities: ['restricted'], minimum: 2 };
  for (const evaluate of [
    () => normalizeApprovalAuthorities(registry, { profile: 'regulated' }),
    () => approvalPolicyCapacity(registry, policy),
    () => matchApprovalAuthority(registry, policy, { email: 'outsider@example.test' })
  ]) assert.throws(evaluate, /allowAnyGitIdentity must be boolean/);
});

test('only own authority declarations resolve, including a valid constructor-named group', () => {
  const policy = { authorities: ['constructor'], requiredAuthorities: ['constructor'], minimum: 1 };
  assert.throws(() => normalizeApprovalPolicy(policy, authorities, 'design'), /unknown authority 'constructor'/);
  assert.equal(matchApprovalAuthority(authorities, policy, { email: 'outsider@example.test' }).authorized, false);
  assert.equal(approvalPolicyCapacity(authorities, policy).attainable, false);
  const own = { constructor: { members: [{ email: 'reviewer@example.test' }] } };
  const normalized = normalizeApprovalPolicy(policy, own, 'design');
  assert.equal(approvalPolicyCapacity(own, normalized).attainable, true);
  assert.equal(matchApprovalAuthority(own, normalized, { email: 'reviewer@example.test' }).authorized, true);
});

test('required authority groups are allocated and covered independently', () => {
  const policy = normalizeApprovalPolicy({
    authorities: ['architecture-reviewers', 'git-contributors'],
    requiredAuthorities: ['architecture-reviewers', 'git-contributors'],
    minimum: 2
  }, authorities, 'publication');
  const first = requireApprovalAuthority(authorities, policy, { email: 'asha@example.com' }, {
    preferredAuthorities: remainingRequiredAuthorities(policy, [])
  });
  assert.equal(first.authorityGroup, 'architecture-reviewers');
  const decisions = [{ decision: 'approved', actor: { email: 'asha@example.com' }, authorityGroup: first.authorityGroup }];
  assert.equal(approvalRequirementsMet(policy, decisions), false);
  assert.deepEqual(remainingRequiredAuthorities(policy, decisions), ['git-contributors']);
  const second = requireApprovalAuthority(authorities, policy, { email: 'second@example.com' }, {
    preferredAuthorities: remainingRequiredAuthorities(policy, decisions)
  });
  assert.equal(second.authorityGroup, 'git-contributors');
  decisions.push({ decision: 'approved', actor: { email: 'second@example.com' }, authorityGroup: second.authorityGroup });
  assert.equal(approvalRequirementsMet(policy, decisions), true);
  assert.throws(() => normalizeApprovalPolicy({
    authorities: ['architecture-reviewers', 'git-contributors'],
    requiredAuthorities: ['architecture-reviewers', 'git-contributors'],
    minimum: 1
  }, authorities, 'publication'), /minimum must be at least 2/);
});

test('an approval threshold cannot be pinned when too few distinct reviewers can ever satisfy it', () => {
  const registry = {
    'architecture-reviewers': {
      label: 'Architecture reviewers', allowAnyGitIdentity: false,
      members: [{ name: 'Asha', email: 'asha@example.com' }]
    }
  };
  const policy = {
    mode: 'required', authorities: ['architecture-reviewers'], requiredAuthorities: [], minimum: 2
  };
  assert.deepEqual(approvalPolicyCapacity(registry, policy), {
    attainable: false, unbounded: false, eligibleIdentities: 1, minimum: 2, missingAuthorities: []
  });
  assert.throws(
    () => assertApprovalPolicyAttainable(registry, policy, 'design'),
    (error) => error?.code === 'APPROVAL_POLICY_UNATTAINABLE' && /only 1 are pinned/.test(error.message)
  );
  assert.equal(approvalPolicyCapacity({
    'architecture-reviewers': { allowAnyGitIdentity: true, members: [] }
  }, policy).attainable, true);
});

test('a policy approval still requires fallback reviewer capacity', () => {
  const authorities = {
    'quality-reviewers': { label: 'Quality', members: [] }
  };
  const capacity = approvalPolicyCapacity(authorities, {
    mode: 'policy', authorities: ['quality-reviewers'], requiredAuthorities: [], minimum: 1
  });
  assert.equal(capacity.attainable, false);
  assert.equal(capacity.eligibleIdentities, 0);
});

test('required groups need distinct reviewer assignments, not merely a large eligible union', () => {
  const registry = {
    first: { members: [{ email: 'alice@example.test' }] },
    second: { members: [{ email: 'ALICE@example.test' }] },
    optional: { members: [{ email: 'bob@example.test' }] }
  };
  const policy = {
    mode: 'required', authorities: ['first', 'second', 'optional'],
    requiredAuthorities: ['first', 'second'], minimum: 2
  };
  assert.deepEqual(approvalPolicyCapacity(registry, policy), {
    attainable: false, unbounded: false, eligibleIdentities: 2, minimum: 2,
    missingAuthorities: ['second']
  });
  assert.throws(() => assertApprovalPolicyAttainable(registry, policy, 'review'),
    (error) => error.code === 'APPROVAL_POLICY_UNATTAINABLE'
      && /distinct eligible reviewers/.test(error.message));
  assert.equal(approvalRequirementsMet(policy, [
    { decision: 'approved', actor: { email: 'alice@example.test' }, authorityGroup: 'first' },
    { decision: 'approved', actor: { email: 'bob@example.test' }, authorityGroup: 'optional' }
  ]), false);

  // An unrestricted *optional* group cannot supply reviewers for restricted required groups.
  registry.optional.allowAnyGitIdentity = true;
  assert.equal(approvalPolicyCapacity(registry, policy).attainable, false);
});

test('required reviewer matching reassigns earlier choices and detects deficient subsets', () => {
  const registry = {
    first: { members: [{ email: 'alice@example.test' }, { email: 'bob@example.test' }] },
    second: { members: [{ email: 'alice@example.test' }] },
    third: { members: [{ email: 'alice@example.test' }, { email: 'bob@example.test' }] },
    optional: { members: [{ email: 'charlie@example.test' }] }
  };
  const policy = {
    mode: 'required', authorities: Object.keys(registry),
    requiredAuthorities: ['first', 'second'], minimum: 3
  };
  assert.equal(approvalPolicyCapacity(registry, policy).attainable, true,
    'Alice must be reserved for second while Bob covers first and Charlie fills the threshold');
  const capacity = approvalPolicyCapacity(registry, { ...policy,
    requiredAuthorities: ['third', 'second', 'first'] });
  assert.equal(capacity.eligibleIdentities, 3);
  assert.equal(capacity.attainable, false, 'three required groups have only two eligible identities');
  assert.deepEqual(capacity.missingAuthorities, ['third']);
});

test('unrestricted required groups have structural capacity without fabricating human approvals', () => {
  const registry = {
    first: { members: [{ githubLogin: 'alice' }] },
    second: { members: [{ githubLogin: 'ALICE' }], allowAnyGitIdentity: true },
    third: { members: [], allowAnyGitIdentity: true }
  };
  const policy = { mode: 'policy', authorities: Object.keys(registry),
    requiredAuthorities: Object.keys(registry), minimum: 100 };
  assert.deepEqual(approvalPolicyCapacity(registry, policy), {
    attainable: true, unbounded: true, eligibleIdentities: 1, minimum: 100, missingAuthorities: []
  });
  assert.equal(approvalRequirementsMet(policy, []), false);
});

test('reviewer matching is iterative and independent of authority declaration order', () => {
  const registry = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [
    `group-${index}`, { members: [{ email: `person-${index}@example.test` },
      ...(index ? [{ email: `person-${index - 1}@example.test` }] : [])] }
  ]));
  const ids = Object.keys(registry);
  const policy = { mode: 'required', authorities: ids, requiredAuthorities: ids, minimum: ids.length };
  assert.equal(approvalPolicyCapacity(registry, policy).attainable, true);
  assert.deepEqual(approvalPolicyCapacity(registry, { ...policy,
    authorities: [...ids].reverse(), requiredAuthorities: [...ids].reverse() }),
  approvalPolicyCapacity(registry, policy));
});
