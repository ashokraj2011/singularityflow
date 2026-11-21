/**
 * Every reader of a repository's workflow.yml takes the versions this build reads (2, 3 and 4), never version 2 alone.
 * Since step intents Stage 4 the shipped workflow.yml is version 4, and three readers took only version 2 (and already
 * misjudged version 3, written for compiled skill steps):
 * - Smart init's precheck failed its configuration-parse check;
 * - the explicit workspace prune forgot every workspace whose lead repository was on 3 or 4;
 * - repository onboarding called a version 3 or 4 configuration one from a newer SFlow (covered end to end by
 *   test/repository-onboarding.test.mjs, whose configurations are now version 4).
 * A version newer than this build reads is not obsolete: that repository needs a newer SFlow, never to be forgotten.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WORKFLOW_FILE_VERSIONS as CONFIG_VERSIONS } from '../src/config.mjs';
import { smartInitPrecheck } from '../src/initialization/precheck.mjs';
import {
  WORKFLOW_FILE_VERSIONS, workflowFileVersionNewer, workflowFileVersionObsolete, workflowFileVersionReadable
} from '../src/phase-roles.mjs';
import { run } from '../src/util.mjs';
import { discardUnsupportedWorkflowWorkspaces } from '../src/workspace-context.mjs';

test('one list of readable versions, and what is obsolete or newer', () => {
  assert.deepEqual(WORKFLOW_FILE_VERSIONS, [2, 3, 4]);
  assert.equal(CONFIG_VERSIONS, WORKFLOW_FILE_VERSIONS, 'configuration reads the same list');
  assert.deepEqual([1, 2, 3, 4, 5].map(workflowFileVersionReadable), [false, true, true, true, false]);
  assert.deepEqual([1, 2, 4, 5, 9].map(workflowFileVersionNewer), [false, false, false, true, true]);
  assert.deepEqual([undefined, null, '2', 0, 1, 2, 4, 5].map(workflowFileVersionObsolete), [true, true, true, true, true, false, false, false]);
});

test('Smart init\'s precheck parses every version this build reads', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-versions-precheck-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q'], { cwd: root });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  const parse = async (version) => {
    await writeFile(path.join(root, 'singularity', 'workflow.yml'), `version: ${version}\nworkTypes: {}\n`);
    return (await smartInitPrecheck(root)).checks.find((entry) => entry.id === 'configuration-parse').status;
  };
  for (const version of [2, 3, 4]) assert.equal(await parse(version), 'pass', `version ${version}`);
  for (const version of [1, 5]) assert.equal(await parse(version), 'fail', `version ${version}`);
});

test('an explicit workspace prune forgets only an obsolete workflow.yml, never one on 3, 4 or a newer version', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-versions-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  for (const [name, text] of [['v1', 'version: 1\n'], ['v2', 'version: 2\n'], ['v3', 'version: 3\n'], ['v4', 'version: 4\n'],
    ['v5', 'version: 5\n'], ['none', 'workTypes: {}\n']]) {
    const lead = path.join(root, name, 'repos', 'lead');
    await mkdir(path.join(lead, 'singularity'), { recursive: true });
    await writeFile(path.join(lead, 'singularity', 'workflow.yml'), text);
    entries.push({ id: name, name, path: path.join(root, name), leadRepositoryPath: lead, openedAt: '2026-11-21T00:00:00.000Z' });
  }
  const registry = path.join(root, 'registry.json');
  await writeFile(registry, `${JSON.stringify(entries)}\n`);
  const result = await discardUnsupportedWorkflowWorkspaces(registry);
  assert.deepEqual(result.removed.map((entry) => [entry.id, entry.version]).sort(), [['none', null], ['v1', 1]]);
  assert.match(result.removed.find((entry) => entry.id === 'none').reason, /does not declare its version/u);
  // `remaining` is read back from the registry file after the prune.
  assert.deepEqual(result.remaining.map((entry) => entry.id).sort(), ['v2', 'v3', 'v4', 'v5']);
});
