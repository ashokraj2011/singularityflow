import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { gitDir } from '../src/git.mjs';
import { logFilePath } from '../src/logging.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false, input = undefined, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Revision Attachment Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    ...extraEnv
  };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function flow(root, args, options = {}) {
  return run(process.execPath, [bin, ...args], root, options);
}

function git(root, args) {
  return run('git', args, root).stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-attachments-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Revision Attachment Tester'], root);
  run('git', ['config', 'user.email', 'revision-attachments@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Revision attachments\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  // The active phase is intake, so ordinary Story document upload is deliberately closed.
  config.documents.allowedPhases = ['requirements'];
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities ?? {})) authority.allowAnyGitIdentity = true;
  for (const phase of Object.values(config.phases ?? {})) {
    if (phase.approval && phase.approval !== 'none') phase.approval.allowSelfApproval = true;
  }
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'README.md', 'singularity', '.github/agents'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  flow(root, ['start', 'REV-UPLOAD-1', '--from-branch', 'main', '--title', 'Revision feedback attachment']);
  return root;
}

function attachmentSet(result) {
  return result.receipt ?? result.attachmentSet ?? result;
}

test('revision attachment intake is separate from Story documents and never starts a revision', async () => {
  const root = await repository();
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-source-'));
  const source = path.join(sourceDir, 'design review.md');
  const bytes = '# Edge cases\n\nHandle an empty cart without charging the customer.\n';
  const digest = createHash('sha256').update(bytes).digest('hex');
  const feedback = 'Use the attached edge case while correcting the candidate.';
  await writeFile(source, bytes);

  const workflowPath = path.join(root, 'singularity/work-items/REV-UPLOAD-1/workflow.json');
  const documentsPath = path.join(root, 'singularity/work-items/REV-UPLOAD-1/documents.json');
  const workflowBefore = await readFile(workflowPath, 'utf8');
  const documentsBefore = await readFile(documentsPath, 'utf8').catch(() => null);
  const headBefore = git(root, ['rev-parse', 'HEAD']);
  const statusBefore = git(root, ['status', '--porcelain']);

  const capabilitiesResult = JSON.parse(flow(root, [
    'revision', 'attachments', 'capabilities', '--json'
  ]).stdout);
  assert.equal(capabilitiesResult.resultType, 'command-result');
  assert.equal(capabilitiesResult.effects.filesChanged, false);
  const capabilities = capabilitiesResult.data;
  assert.equal(capabilities.localFile.available, true);
  assert.equal(capabilities.copilotHostAttachment.verifiableBytesAvailable, false);
  assert.equal(capabilities.copilotHostAttachment.code, 'REV_CHAT_ATTACHMENT_UNAVAILABLE');
  assert.match(capabilities.fallback, /revision attachments preview --file/);

  const storyUpload = flow(root, ['documents', 'upload', source], { allowFailure: true });
  assert.notEqual(storyUpload.status, 0);
  assert.match(storyUpload.stderr, /only during: requirements/);

  const previewResult = JSON.parse(flow(root, [
    'revision', 'attachments', 'preview', '--file', source, '--feedback', feedback, '--json'
  ]).stdout);
  assert.equal(previewResult.resultType, 'command-result');
  assert.equal(previewResult.effects.stateChanged, true, 'preview stages a private plan');
  assert.equal(previewResult.effects.filesChanged, true, 'preview writes only its private plan');
  assert.equal(previewResult.effects.publicationCreated, false);
  const proposed = previewResult.data;
  const planId = proposed.planId ?? proposed.plan?.planSha256;
  assert.match(planId, /^sha256:[a-f0-9]{64}$/);
  const previewAttachment = proposed.preview?.attachments?.[0] ?? proposed.attachments?.[0];
  assert.equal(previewAttachment.displayName, path.basename(source));
  assert.equal(previewAttachment.bytes, Buffer.byteLength(bytes));
  assert.match(previewAttachment.originalSha256, new RegExp(`${digest}$`));
  assert.equal(await readFile(workflowPath, 'utf8'), workflowBefore);
  assert.equal(await readFile(documentsPath, 'utf8').catch(() => null), documentsBefore);
  assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(root, ['status', '--porcelain']), statusBefore, 'preview must be read-only');

  const registerResult = JSON.parse(flow(root, [
    'revision', 'attachments', 'register', '--file', source, '--feedback', feedback,
    '--confirm', planId, '--json'
  ]).stdout);
  assert.equal(registerResult.resultType, 'command-result');
  assert.equal(registerResult.effects.stateChanged, true);
  assert.equal(registerResult.effects.publicationCreated, false);
  const registered = attachmentSet(registerResult.data);
  assert.match(registered.attachmentSetSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(JSON.stringify(registered), new RegExp(digest));
  const replay = JSON.parse(flow(root, [
    'revision', 'attachments', 'register', '--file', source, '--feedback', feedback,
    '--confirm', planId, '--json'
  ]).stdout);
  assert.equal(replay.outcome.status, 'noop', 'an exact retry must not claim another mutation');
  assert.equal(replay.effects.stateChanged, false);
  assert.equal(replay.effects.filesChanged, false);
  assert.equal(replay.data.attachmentSetSha256, registered.attachmentSetSha256);
  const listResult = JSON.parse(flow(root, ['revision', 'attachments', 'list', '--json']).stdout);
  assert.equal(listResult.resultType, 'command-result');
  assert.equal(listResult.effects.stateChanged, false);
  assert.match(JSON.stringify(listResult.data.receipts), new RegExp(registered.attachmentSetSha256));
  assert.equal(listResult.data.receipts.length, 1);

  assert.equal(await readFile(workflowPath, 'utf8'), workflowBefore,
    'feedback evidence must not advance or revise the Story lifecycle');
  assert.equal(await readFile(documentsPath, 'utf8').catch(() => null), documentsBefore,
    'feedback evidence must not become an authoritative Story document');
  assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore,
    'attachment registration must not publish a Story revision');
});

test('changed local bytes invalidate an attachment preview before registration', async () => {
  const root = await repository();
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-stale-source-'));
  const source = path.join(sourceDir, 'edge-case.txt');
  const feedback = 'Use the attached edge case.';
  await writeFile(source, 'Original edge case.\n');
  const proposed = JSON.parse(flow(root, [
    'revision', 'attachments', 'preview', '--file', source, '--feedback', feedback, '--json'
  ]).stdout).data;
  const planId = proposed.planId ?? proposed.plan?.planSha256;
  assert.match(planId, /^sha256:[a-f0-9]{64}$/);
  const headBefore = git(root, ['rev-parse', 'HEAD']);
  const workflowPath = path.join(root, 'singularity/work-items/REV-UPLOAD-1/workflow.json');
  const workflowBefore = await readFile(workflowPath, 'utf8');

  await writeFile(source, 'Changed edge case.\n');
  const stale = flow(root, [
    'revision', 'attachments', 'register', '--file', source, '--feedback', feedback,
    '--confirm', planId, '--json'
  ], { allowFailure: true });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /REV_ATTACHMENT_SET_STALE|stale|changed|mismatch/i);
  const listed = JSON.parse(flow(root, ['revision', 'attachments', 'list', '--json']).stdout).data.receipts;
  assert.doesNotMatch(JSON.stringify(listed), /revision-feedback-attachment-set/);
  assert.equal(await readFile(workflowPath, 'utf8'), workflowBefore);
  assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
});

test('bounded feedback stdin stays out of argv and durable command logs', async () => {
  const root = await repository();
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-stdin-source-'));
  const source = path.join(sourceDir, 'review.md');
  await writeFile(source, '# Review\nOne edge case.\n');
  const feedbackText = 'Check the stdin-only condition REV-STDIN-NOT-IN-ARGV-7419.';
  const logEnv = { SINGULARITY_FLOW_LOG_LEVEL: 'all' };
  const previewArgv = [
    'revision', 'attachments', 'preview', '--file', source, '--feedback-stdin', '--json'
  ];
  assert.doesNotMatch(previewArgv.join(' '), /REV-STDIN-NOT-IN-ARGV-7419/);
  const previewRun = flow(root, previewArgv, {
    input: feedbackText, extraEnv: logEnv
  });
  assert.doesNotMatch(previewRun.stdout + previewRun.stderr, /REV-STDIN-NOT-IN-ARGV-7419/);
  const preview = JSON.parse(previewRun.stdout);
  assert.equal(preview.resultType, 'command-result');
  assert.match(preview.data.planId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(preview.data.plan.feedbackSha256,
    `sha256:${createHash('sha256').update(feedbackText).digest('hex')}`);
  const registerArgv = [
    'revision', 'attachments', 'register', '--file', source,
    '--feedback-stdin', '--confirm', preview.data.planId, '--json'
  ];
  assert.doesNotMatch(registerArgv.join(' '), /REV-STDIN-NOT-IN-ARGV-7419/);
  const registerRun = flow(root, registerArgv, {
    input: feedbackText, extraEnv: logEnv
  });
  assert.doesNotMatch(registerRun.stdout + registerRun.stderr, /REV-STDIN-NOT-IN-ARGV-7419/);
  const registered = JSON.parse(registerRun.stdout);
  assert.match(registered.data.attachmentSetSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(registered.data.feedbackSha256, preview.data.plan.feedbackSha256);
  const conflicting = flow(root, [
    'revision', 'attachments', 'preview', '--file', source,
    '--feedback-stdin', '--feedback', 'different', '--json'
  ], { input: feedbackText, allowFailure: true });
  assert.notEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /REV_ATTACHMENT_FEEDBACK_CONFLICT/);
  const empty = flow(root, previewArgv, { input: '', allowFailure: true });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /REV_ATTACHMENT_FEEDBACK/);
  const oversized = flow(root, previewArgv, { input: 'x'.repeat(8193), allowFailure: true });
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /REV_FEEDBACK_TOO_LARGE/);
  const logText = await readFile(logFilePath(gitDir(root)), 'utf8');
  assert.doesNotMatch(logText, /REV-STDIN-NOT-IN-ARGV-7419/);
});

test('explicit multi-file and line selection excludes unselected bytes from the registered set', async () => {
  const root = await repository();
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-selection-'));
  const ignored = path.join(sourceDir, 'not-selected.md');
  const selected = path.join(sourceDir, 'selected.md');
  await writeFile(ignored, '# Not selected\nThis content must not enter a revision packet.\n');
  await writeFile(selected, '# Selected\nRelevant line.\nIrrelevant line.\n');
  const operands = [
    '--file', ignored, '--file', selected, '--select', '2', '--line-range', '2:2-2'
  ];
  const feedbackText = 'Use only the selected line.';
  const preview = JSON.parse(flow(root, [
    'revision', 'attachments', 'preview', ...operands, '--feedback-stdin', '--json'
  ], { input: feedbackText }).stdout).data;
  assert.equal(preview.preview.attachments.length, 2);
  assert.equal(preview.preview.attachments[0].selected, false);
  assert.equal(preview.preview.attachments[1].selected, true);
  assert.deepEqual(preview.preview.attachments[1].selectedRanges, [{ startLine: 2, endLine: 2 }]);
  const registered = JSON.parse(flow(root, [
    'revision', 'attachments', 'register', ...operands, '--feedback-stdin',
    '--confirm', preview.planId, '--json'
  ], { input: feedbackText }).stdout).data;
  assert.equal(registered.attachments.length, 1);
  assert.equal(registered.attachments[0].displayName, 'selected.md');
  assert.equal(registered.attachments[0].lineCount, 4);
  assert.deepEqual(registered.attachments[0].selectedRanges, [{ startLine: 2, endLine: 2 }]);
  const changedSelection = flow(root, [
    'revision', 'attachments', 'register', '--file', ignored, '--file', selected,
    '--select', '1', '--feedback-stdin', '--confirm', preview.planId, '--json'
  ], { input: feedbackText, allowFailure: true });
  assert.notEqual(changedSelection.status, 0);
  assert.match(changedSelection.stderr, /REV_ATTACHMENT_SET_STALE|selection|changed|stale/i);
  const duplicate = flow(root, [
    'revision', 'attachments', 'preview', '--file', selected,
    '--select', '1', '--select', '1', '--feedback-stdin', '--json'
  ], { input: feedbackText, allowFailure: true });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /REV_ATTACHMENT_SELECTION/);
});

test('CLI refuses a symlink whose selected name resolves to different bytes', async () => {
  const root = await repository();
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-symlink-'));
  const target = path.join(sourceDir, 'real.md');
  const alias = path.join(sourceDir, 'review.md');
  await writeFile(target, '# Private target\nDo not silently follow the alias.\n');
  await symlink(target, alias);
  const refused = flow(root, [
    'revision', 'attachments', 'preview', '--file', alias,
    '--feedback', 'Review this file.', '--json'
  ], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /REV_ATTACHMENT_UNAUTHORIZED/);
  const listed = JSON.parse(flow(root, ['revision', 'attachments', 'list', '--json']).stdout);
  assert.equal(listed.data.receipts.length, 0);
});

test('CLI removal is confirmed, append-only, and makes the set unavailable to routing', async () => {
  const root = await repository();
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-remove-'));
  const source = path.join(sourceDir, 'review.md');
  const feedback = 'Exclude the attached document from future revision routing.';
  await writeFile(source, '# Feedback\nCheck the boundary.\n');
  const preview = JSON.parse(flow(root, [
    'revision', 'attachments', 'preview', '--file', source,
    '--feedback', feedback, '--json'
  ]).stdout).data;
  const receipt = JSON.parse(flow(root, [
    'revision', 'attachments', 'register', '--file', source,
    '--feedback', feedback, '--confirm', preview.planId, '--json'
  ]).stdout).data;
  const statusBefore = JSON.parse(flow(root, [
    'revision', 'attachments', 'status', '--json'
  ]).stdout).data.sets;
  assert.deepEqual(statusBefore.map((item) => item.status), ['active']);
  const removal = JSON.parse(flow(root, [
    'revision', 'attachments', 'remove-preview',
    '--attachment-set', receipt.attachmentSetSha256, '--json'
  ]).stdout).data.plan;
  const wrong = flow(root, [
    'revision', 'attachments', 'remove', '--confirm', 'sha256:' + '0'.repeat(64), '--json'
  ], { allowFailure: true });
  assert.notEqual(wrong.status, 0);
  const removed = JSON.parse(flow(root, [
    'revision', 'attachments', 'remove', '--confirm', removal.planSha256, '--json'
  ]).stdout);
  assert.equal(removed.outcome.status, 'succeeded');
  assert.equal(removed.data.revocation.attachmentSetSha256, receipt.attachmentSetSha256);
  const replay = JSON.parse(flow(root, [
    'revision', 'attachments', 'remove', '--confirm', removal.planSha256, '--json'
  ]).stdout);
  assert.equal(replay.outcome.status, 'noop');
  const statusAfter = JSON.parse(flow(root, [
    'revision', 'attachments', 'status', '--json'
  ]).stdout).data.sets;
  assert.deepEqual(statusAfter.map((item) => item.status), ['revoked']);
  const preserved = JSON.parse(flow(root, [
    'revision', 'attachments', 'list', '--json'
  ]).stdout).data.receipts;
  assert.equal(preserved[0].attachmentSetSha256, receipt.attachmentSetSha256);
  const repeatedRegister = flow(root, [
    'revision', 'attachments', 'register', '--file', source,
    '--feedback', feedback, '--confirm', preview.planId, '--json'
  ], { allowFailure: true });
  assert.notEqual(repeatedRegister.status, 0);
  assert.match(repeatedRegister.stderr, /REV_ATTACHMENT_SET_REVOKED/);
  const repeatedPreview = flow(root, [
    'revision', 'attachments', 'remove-preview',
    '--attachment-set', receipt.attachmentSetSha256, '--json'
  ], { allowFailure: true });
  assert.notEqual(repeatedPreview.status, 0);
  assert.match(repeatedPreview.stderr, /REV_ATTACHMENT_SET_REVOKED/);
});
