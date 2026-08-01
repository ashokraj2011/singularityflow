import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { validatePortfolio } from '../src/initiative-config.mjs';
import { approvalChainProgress, chainStatusDescription, isAuthorized } from '../src/initiative-evidence.mjs';

const shipped = YAML.parse(await readFile(new URL('../templates/portfolio.yml', import.meta.url), 'utf8'));

const CHAIN = [
  { authority: 'executive-approvers', label: 'Executive Decisioning', minimum: 1 },
  { authority: 'product-approvers', label: 'Product Governance', minimum: 1 },
  { authority: 'risk-reviewers', label: 'LRC Review', minimum: 1 }
];
const policy = { mode: 'bundle', authorities: CHAIN.map((step) => step.authority), minimum: 3, allowSelfApproval: true, chain: CHAIN };

const resolution = {
  approvalAuthorities: {
    'executive-approvers': { members: [{ email: 'exec@example.com' }] },
    // Deliberately also an executive: one human on two bodies must not satisfy two steps.
    'product-approvers': { members: [{ email: 'exec@example.com' }, { email: 'product@example.com' }] },
    'risk-reviewers': { members: [{ email: 'risk@example.com' }] }
  }
};

function decision(email, chainStep) {
  return { record: { decision: 'approved', actor: { email }, subject: { chainStep } } };
}

test('a chain requires one signature per body, in order', () => {
  let progress = approvalChainProgress(policy, []);
  assert.equal(progress.satisfied, false);
  assert.equal(progress.open.authority, 'executive-approvers');
  assert.match(chainStatusDescription(progress), /waiting on Executive Decisioning \(0\/1\)/);

  progress = approvalChainProgress(policy, [decision('exec@example.com', 0)]);
  assert.equal(progress.steps[0].satisfied, true);
  assert.equal(progress.open.authority, 'product-approvers', 'the next body opens only after the first is satisfied');

  progress = approvalChainProgress(policy, [
    decision('exec@example.com', 0), decision('product@example.com', 1), decision('risk@example.com', 2)
  ]);
  assert.equal(progress.satisfied, true);
  assert.equal(progress.open, null);
  assert.equal(chainStatusDescription(progress), 'all review steps satisfied');
});

test('the flat form could be satisfied by one body; the chain cannot', () => {
  // This is the defect the chain exists to fix. Under the flat policy three people from a single
  // group reach `minimum: 3`. Under the chain the same three signatures leave two steps untouched.
  const oneBody = [decision('exec@example.com', 0), decision('a@example.com', 0), decision('b@example.com', 0)];
  const flatCount = new Set(oneBody.map(({ record }) => record.actor.email)).size;
  assert.equal(flatCount >= 3, true, 'flat policy: three humans from one group meet the headcount');

  const progress = approvalChainProgress(policy, oneBody);
  assert.equal(progress.satisfied, false, 'chain: three signatures on one step do not advance the chain');
  assert.equal(progress.open.authority, 'product-approvers');
});

test('only the body whose step is open may sign', () => {
  const exec = { email: 'exec@example.com' };
  const risk = { email: 'risk@example.com' };
  // Nothing signed yet: the executive step is open.
  assert.equal(isAuthorized(resolution, policy, exec, []), true);
  assert.equal(isAuthorized(resolution, policy, risk, []), false, 'a later body cannot sign out of order');

  const afterExec = [decision('exec@example.com', 0)];
  assert.equal(isAuthorized(resolution, policy, risk, afterExec), false, 'still blocked: product governance has not signed');
  assert.equal(isAuthorized(resolution, policy, { email: 'product@example.com' }, afterExec), true);

  // A reviewer who sits on two bodies is authorized only for the open step, and their recorded
  // decision is bound to that step, so it cannot also count for a later one.
  const afterProduct = [...afterExec, decision('product@example.com', 1)];
  assert.equal(isAuthorized(resolution, policy, exec, afterProduct), false,
    'the executive is not on the LRC, so cannot satisfy the open LRC step');
  assert.equal(isAuthorized(resolution, policy, risk, afterProduct), true);

  // Once complete, no further signatures are accepted.
  const complete = [...afterProduct, decision('risk@example.com', 2)];
  assert.equal(isAuthorized(resolution, policy, exec, complete), false);
});

test('callers without decision history fall back to the union of the chain bodies', () => {
  // Rejection and evidence waivers ask only "is this person any of these bodies?".
  assert.equal(isAuthorized(resolution, policy, { email: 'risk@example.com' }), true);
  assert.equal(isAuthorized(resolution, policy, { email: 'stranger@example.com' }), false);
});

test('chain policies are validated and coexist with the flat form', () => {
  const withChain = (approval) => {
    const value = structuredClone(shipped);
    value.initiativePhases['discover-define'].bundleApproval = approval;
    return value;
  };

  const ok = validatePortfolio(withChain({
    mode: 'bundle',
    chain: [{ authority: 'product-approvers' }, { authority: 'risk-reviewers', minimum: 2 }]
  }));
  const policyOut = ok.initiativePhases['discover-define'].bundleApproval;
  assert.deepEqual(policyOut.chain.map((step) => step.authority), ['product-approvers', 'risk-reviewers']);
  assert.equal(policyOut.chain[0].minimum, 1, 'step minimum defaults to one signature');
  assert.deepEqual(policyOut.authorities, ['product-approvers', 'risk-reviewers'],
    'authorities stays populated as the union so existing consumers keep working');
  assert.equal(policyOut.minimum, 3, 'minimum is the sum of the step minimums');

  assert.throws(() => validatePortfolio(withChain({
    mode: 'bundle', authorities: ['product-approvers'], chain: [{ authority: 'risk-reviewers' }]
  })), /either authorities or chain, not both/);

  // Normalization must be idempotent. The normalized policy carries both `chain` and the derived
  // `authorities` union, and the desktop round-trips config through YAML, so validating an
  // already-normalized policy has to succeed rather than trip the contradiction guard.
  const normalized = validatePortfolio(structuredClone(shipped));
  const reparsed = validatePortfolio(YAML.parse(YAML.stringify(normalized)));
  const pack = reparsed.initiativeProfiles['enterprise-delivery'].packs
    .find((candidate) => candidate.id === 'opportunity-investment-brief');
  assert.deepEqual(pack.approval.chain.map((step) => step.authority), ['product-approvers', 'executive-approvers']);
  assert.deepEqual(pack.approval.authorities, ['product-approvers', 'executive-approvers']);

  assert.throws(() => validatePortfolio(withChain({ mode: 'bundle', chain: [] })),
    /must contain at least one review step/);

  assert.throws(() => validatePortfolio(withChain({
    mode: 'bundle', chain: [{ authority: 'product-approvers' }, { authority: 'product-approvers' }]
  })), /chain authorities/);

  assert.throws(() => validatePortfolio(withChain({ mode: 'none', chain: [{ authority: 'product-approvers' }] })),
    /cannot be combined with mode none/);

  // An unknown body is still caught by the profile's authority-existence check.
  assert.throws(() => validatePortfolio(withChain({ mode: 'bundle', chain: [{ authority: 'nobody' }] })),
    /unknown approval authority 'nobody'/);

  // The flat form is untouched.
  const flat = validatePortfolio(structuredClone(shipped));
  assert.equal(flat.initiativePhases['discover-define'].bundleApproval.chain, null);
});
