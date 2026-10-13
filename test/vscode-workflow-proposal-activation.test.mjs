import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activateReviewedWorkflowProposal } from '../apps/vscode/src/views/configuration-save.ts';

const reviewed = { branch: 'sflow/config-change/workflow/fixture', proposalCommit: 'a'.repeat(40), merged: false };

test('workflow review obtains separate consent before exactly one activation call', async () => {
  const events = [];
  const result = await activateReviewedWorkflowProposal(reviewed, {
    acknowledge: async () => { events.push('consent'); return true; },
    activate: async args => { events.push(args); return { activated: true }; }
  });
  assert.equal(result.activated, true);
  assert.deepEqual(events, ['consent', ['workflow', 'activate', reviewed.branch, '--confirm',
    reviewed.proposalCommit, '--acknowledge-unprotected', '--json']]);
});

test('declining consent starts no expensive activation or mutation', async () => {
  assert.equal(await activateReviewedWorkflowProposal(reviewed, {
    acknowledge: async () => false,
    activate: async () => { assert.fail('No activation is allowed without consent'); }
  }), null);
});

test('an already merged proposal skips unnecessary direct-push acknowledgement', async () => {
  await activateReviewedWorkflowProposal({ ...reviewed, merged: true }, {
    acknowledge: async () => { assert.fail('No direct-push consent needed'); },
    activate: async args => assert.deepEqual(args, ['workflow', 'activate', reviewed.branch,
      '--confirm', reviewed.proposalCommit, '--json'])
  });
});

for (const refusal of ['WORKFLOW_PROPOSAL_CONFIRMATION_MISMATCH', 'WORKFLOW_CONFIGURATION_UNPROTECTED', 'REMOTE_PUSH_REJECTED']) {
  test(`a ${refusal} refusal never causes an automatic second activation`, async () => {
    let attempts = 0;
    await assert.rejects(() => activateReviewedWorkflowProposal(reviewed, {
      acknowledge: async () => true,
      activate: async () => { attempts++; throw new Error(refusal); }
    }), new RegExp(refusal));
    assert.equal(attempts, 1);
  });
}

test('the shipped extension uses the consent-first boundary after exact diff confirmation', async () => {
  const source = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('const reviewAndActivateWorkflowProposal ='), source.indexOf('const proposeWorkflowChange ='));
  assert.match(handler, /if \(confirmed !== merge\) return null/u);
  assert.match(handler, /activateReviewedWorkflowProposal/u);
  assert.doesNotMatch(handler, /activation = await client\.run/u);
});
