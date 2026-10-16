import assert from 'node:assert/strict';
import test from 'node:test';

import { commandFunction } from './helpers/command-source.mjs';

test('convergence advancement pins its selected Story through submission', async () => {
  const advance = await commandFunction('storyAdvanceCommand');
  // Advancement resolves the selected Story through its accepted execution closure (bba7bf81),
  // then reloads that same Story under its lock.
  assert.match(advance,
    /const \{ config, workflow: selected \} = await loadAcceptedStoryExecution\(root, optionString\(options, 'work-id'\)\)/,
    'advancement did not resolve the caller-selected Story');
  assert.match(advance, /loadStoryAggregate\(root, config, selected\.workItem\.id\)/,
    'advancement did not pin its locked reload to the selected Story');
  assert.doesNotMatch(advance, /loadStoryAggregate\(root, config\)/,
    'advancement can reload whichever Story is globally active');
  assert.match(advance, /'work-id': workflow\.workItem\.id/,
    'advancement delegated without the explicitly selected Work ID');
  assert.match(advance, /submitConfirmedConvergenceCommand/,
    'advancement did not use the combined confirmation-and-submission boundary');

  const submit = await commandFunction('runSubmitCommand');
  assert.match(submit, /const requestedWorkId = optionString\(options, 'work-id'\)/);
  assert.match(submit, /const accepted = await loadAcceptedStoryExecution\(root, requestedWorkId\)/,
    'submission did not resolve the caller-selected Story through its accepted execution closure');
  assert.match(submit, /const config = accepted\.definition/,
    'submission discarded the selected Story definition after accepted execution resolution');
  assert.match(submit, /let workflow = accepted\.workflow/,
    'submission discarded the selected Story workflow after accepted execution resolution');
  assert.doesNotMatch(submit, /loadStoryAggregate\(root, config, requestedWorkId\)/,
    'submission can bypass the accepted execution closure for the caller-selected Story');
  assert.match(submit, /const resolvedWorkId = workflow\.workItem\.id/);
  // Submission reads no telemetry and commits no reconciliation, so it has no mid-command reload.
  assert.doesNotMatch(submit, /reconcilePhaseTelemetry/, 'submission is part of the work and reads no Copilot telemetry');
  assert.doesNotMatch(submit, /loadStoryAggregate\(root, config\)/,
    'submission can still reload whichever Story is globally active');

  const generic = await commandFunction('submitCommand');
  assert.match(generic, /runSubmitCommand\(positionals, options\)/);
  assert.doesNotMatch(generic, /convergenceConfirmation/,
    'generic submit can still opt into the convergence confirmation path');
  const confirmed = await commandFunction('submitConfirmedConvergenceCommand');
  assert.match(confirmed, /runSubmitCommand\(positionals, options, \{ convergenceConfirmation: confirmation \}\)/,
    'the combined command did not keep confirmation as a private positional argument');
});

test('convergence draft transactions bind the selected Story publication branch', async () => {
  const draft = await commandFunction('withConvergenceDraft');
  assert.match(draft, /branch: workflowPublicationBranch\(root, selected\)/);
  assert.doesNotMatch(draft, /branch: branch\(root\)/,
    'the transaction is still bound to the incidental checked-out branch');
});
