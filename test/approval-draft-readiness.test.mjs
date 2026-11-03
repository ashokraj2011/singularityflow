import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { agentAct } from '../src/agent-output.mjs';
import { loadApprovalPacket } from '../src/commands/approval-packet.mjs';
import { CLI, specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

test('approval preparation returns the current author, review or submit route before any receipt or cleanup', async () => {
  for (const [classification, phaseStatus, command, skill] of [
    ['generation-required', 'in_progress', 'singularity-flow phase prepublish custom-code --for-agent --json', '/sf-code'],
    ['ready-to-attempt', 'in_progress', 'singularity-flow submit custom-code --work-id DRAFT-1', '/sf-submit'],
    ['source-review-required', 'in_progress', 'singularity-flow review-source context custom-code --json', '/sf-review-source custom-code']
  ]) {
    const readiness = { classification, phaseStatus, phaseId: 'custom-code', workId: 'DRAFT-1',
      nextCommand: command, nextSkill: skill };
    const calls = [];
    const result = await loadApprovalPacket({ workId: 'DRAFT-1', cwd: '/fixture', fetch: true }, {
      runStep: async argv => { calls.push(argv); return { ok: true, value: readiness }; }
    });
    assert.equal(calls.length, 1, 'an unsubmitted phase never enters receipt preparation or branch checkout');
    assert.equal(result.begun, false);
    assert.equal(result.preserveDraft, true);
    assert.equal(result.approvalPacket.review, null);
    assert.equal(result.nextAction.command, command);
    const act = agentAct(result);
    assert.equal(act.do.shell, command);
    assert.match(act.said, /Preserve the existing draft/);
    assert.doesNotMatch(JSON.stringify(result), /set-aside-worktree/);
  }
});

test('packet, selection and direct approval preserve an authored draft and return its prepublish route', async t => {
  const id = 'DRAFT-APPROVAL';
  const { root, item, run, git } = await startedSpecificationStory(t, id);
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(id, 1));
  await mkdir(path.join(root, 'src'), { recursive: true });
  const draft = 'export const pendingDraft = 1;\n';
  await writeFile(path.join(root, 'src/draft.mjs'), draft);
  const before = await readFile(path.join(item, 'workflow.json'));
  const head = git('rev-parse', 'HEAD');
  const index = git('write-tree');
  const receipts = path.join(root, '.git/singularity-flow/choices');
  const beforeReceipts = await readdir(receipts).catch(() => []);
  for (const args of [
    ['choices', 'begin', 'approve', id, '--fetch', '--review-packet'],
    ['choices', 'begin', 'approve', id, '--fetch'],
    ['approve', 'specification', '--work-id', id, '--fetch']
  ]) {
    const result = run(process.execPath, [CLI, '--no-model', ...args, '--json'], { allowFailure: true });
    const value = JSON.parse(result.stdout);
    if (args.includes('--review-packet')) {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(value.begun, false);
      assert.equal(value.reason, 'generation-required');
    } else {
      assert.equal(value.error?.code, 'PHASE_NOT_AWAITING_APPROVAL', result.stdout + result.stderr);
      assert.match(JSON.stringify(value), /phase prepublish specification/);
    }
    assert.doesNotMatch(JSON.stringify(value), /set-aside-worktree|LIFECYCLE_WORKTREE_REVIEW_REQUIRED/);
    assert.ok(before.equals(await readFile(path.join(item, 'workflow.json'))));
    assert.equal(await readFile(path.join(root, 'src/draft.mjs'), 'utf8'), draft);
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(git('write-tree'), index);
    assert.deepEqual(await readdir(receipts).catch(() => []), beforeReceipts);
  }
});
