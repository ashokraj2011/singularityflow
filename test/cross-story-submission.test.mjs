import assert from 'node:assert/strict';
import test from 'node:test';

import { commandFunction } from './helpers/command-source.mjs';

test('convergence advancement pins its selected Story through submission', async () => {
  const advance = await commandFunction('storyAdvanceCommand');
  assert.match(advance, /loadStoryAggregate\(root, config, optionString\(options, 'work-id'\)\)/);
  assert.match(advance, /'work-id': workflow\.workItem\.id/,
    'advancement delegated without the explicitly selected Work ID');
  assert.match(advance, /submitConfirmedConvergenceCommand/,
    'advancement did not use the combined confirmation-and-submission boundary');

  const submit = await commandFunction('runSubmitCommand');
  assert.match(submit, /const requestedWorkId = optionString\(options, 'work-id'\)/);
  assert.match(submit, /loadStoryAggregate\(root, config, requestedWorkId\)/,
    'submission ignored the Work ID supplied by its caller');
  assert.match(submit, /const resolvedWorkId = workflow\.workItem\.id/);
  assert.match(submit, /loadStoryAggregate\(root, config, resolvedWorkId\)/,
    'submission did not pin its post-telemetry reload to the resolved Story');
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
