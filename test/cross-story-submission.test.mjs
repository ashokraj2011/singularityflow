import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

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
  assert.match(submit, /workId:optionString\(options,'work-id'\)/);
  assert.match(submit, /engine\.run\('phase.submit',input\)/, 'submission must use the registered operation');
  const native = await readFile(new URL('../src/engine-compatibility/git-submission.mjs', import.meta.url), 'utf8');
  assert.match(native, /loadAcceptedStoryExecution\(root, input.workId \?\? null\)/,
    'the registered operation did not load the caller-selected accepted Story');
  assert.match(native, /const config = accepted\.definition, workflow = accepted\.workflow/,
    'the operation discarded the selected definition or workflow');
  assert.doesNotMatch(submit, /loadStoryAggregate\(root, config, requestedWorkId\)/,
    'submission can bypass the accepted execution closure for the caller-selected Story');
  assert.match(native, /const resolvedWorkId = workflow\.workItem\.id/);
  assert.doesNotMatch(native, /loadStoryAggregate\(root, config\)/,
    'a native stage can still follow the incidental active Story');
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
