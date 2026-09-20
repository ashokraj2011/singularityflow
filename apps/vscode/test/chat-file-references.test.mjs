import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ChatAttachmentConfirmations, ChatAttachmentRemovals, chatAttachmentAction,
  chatAttachmentStatusSets, chatFilePreviewInput, matchesChatAttachmentReceipt,
  matchesChatRemovalPlan, matchesChatRemovalReceipt
} from '../src/chat-file-references.ts';
import { commandClass, SingularityFlowClient } from '../src/cli/client.ts';

const localPath = path.resolve('/tmp', 'revision-feedback.md');
const hostUri = (file, extra = {}) => ({ __hostUri: true, scheme: 'file', fsPath: file, ...extra });
const preview = (prompt, references) => chatFilePreviewInput(
  prompt, references, (value) => Boolean(value && typeof value === 'object' && value.__hostUri === true)
);

test('a host file Uri supplies one exact local path and strips its prompt token', () => {
  const result = preview('Fix #file by adding a boundary check', [
    { value: hostUri(localPath), range: [4, 9] }
  ]);
  assert.deepEqual(result, {
    kind: 'local-file', paths: [localPath], feedback: 'Fix   by adding a boundary check'
  });
});

test('an object merely shaped like a file Uri is not a host file reference', () => {
  const result = preview('Please review the failure.', [
    { value: { scheme: 'file', fsPath: localPath } }
  ]);
  assert.equal(result.code, 'REV_CHAT_ATTACHMENT_UNAVAILABLE');
});

test('a Location range and URI query never silently expand into whole-file evidence', () => {
  assert.equal(preview('Use #file', [
    { value: { uri: hostUri(localPath), range: { start: 0, end: 10 } } }
  ]).code, 'REV_CHAT_ATTACHMENT_UNAVAILABLE');
  assert.equal(preview('Use #file', [
    { value: hostUri(localPath, { query: 'revision=old' }) }
  ]).code, 'REV_CHAT_ATTACHMENT_UNAVAILABLE');
});

test('opaque Copilot attachments and path-looking strings never become file evidence', () => {
  for (const value of [
    localPath, { name: 'revision-feedback.md', summary: 'Model-read content' },
    { scheme: 'https', fsPath: localPath }, { scheme: 'file', fsPath: 'relative.md' }
  ]) {
    const result = preview('Please revise this.', [{ value }]);
    assert.equal(result.kind, 'unavailable');
    assert.equal(result.code, 'REV_CHAT_ATTACHMENT_UNAVAILABLE');
    assert.doesNotMatch(result.reason, /Model-read content|\/tmp\/revision-feedback/);
  }
});

test('missing, opaque, or excess references refuse instead of silently dropping evidence', () => {
  assert.equal(preview('Please revise this.', []).kind, 'unavailable');
  assert.equal(preview('Please revise this.', Array.from({ length: 6 }, (_, index) => ({
    value: hostUri(path.resolve('/tmp', `${index}.md`))
  }))).kind, 'unavailable');
  assert.equal(preview('Please revise this.', [
    { value: hostUri(localPath) }, { value: { name: 'opaque.pdf' } }
  ]).kind, 'unavailable');
});

test('two to five host file references select every whole file and strip nonoverlapping prompt tokens', () => {
  const second = path.resolve('/tmp', 'second.md');
  assert.deepEqual(preview('Fix #one and #two today', [
    { value: hostUri(localPath), range: [4, 8] },
    { value: hostUri(second), range: [13, 17] }
  ]), {
    kind: 'local-file', paths: [localPath, second], feedback: 'Fix   and   today'
  });
  assert.deepEqual(preview('Use these documents', [
    { value: hostUri(localPath) }, { value: hostUri(second) }
  ]), {
    kind: 'local-file', paths: [localPath, second], feedback: 'Use these documents'
  });
  assert.equal(preview('Fix #one', [
    { value: hostUri(localPath), range: [4, 8] },
    { value: hostUri(second), range: [5, 8] }
  ]).kind, 'unavailable');
  assert.equal(preview('Use duplicates', [
    { value: hostUri(localPath) }, { value: hostUri(localPath) }
  ]).kind, 'unavailable');
  assert.equal(preview('Use one location', [
    { value: hostUri(localPath) },
    { value: { uri: hostUri(second), range: { start: 0, end: 1 } } }
  ]).kind, 'unavailable');
});

test('invalid reference range and empty feedback refuse before any file read', () => {
  assert.equal(preview('Fix #file', [
    { value: hostUri(localPath), range: [20, 30] }
  ]).kind, 'unavailable');
  assert.deepEqual(preview('#file', [
    { value: hostUri(localPath), range: [0, 5] }
  ]).code, 'REV_ATTACHMENT_FEEDBACK');
});

test('preview plan staging and registration are never read-cacheable in the extension runner', () => {
  assert.equal(commandClass(['revision', 'attachments', 'capabilities', '--json']), 'read');
  assert.equal(commandClass(['revision', 'attachments', 'list', '--json']), 'read');
  assert.equal(commandClass(['revision', 'attachments', 'status', '--json']), 'read');
  assert.equal(commandClass(['revision', 'attachments', 'preview', '--json']), 'mutation');
  assert.equal(commandClass(['revision', 'attachments', 'register', '--json']), 'mutation');
  assert.equal(commandClass(['revision', 'attachments', 'remove-preview', '--json']), 'mutation');
  assert.equal(commandClass(['revision', 'attachments', 'remove', '--json']), 'mutation');
  assert.equal(commandClass(['revision', 'status', '--json']), 'read');
  assert.equal(commandClass(['revision', 'card', '--json']), 'read');
  assert.equal(commandClass(['revision', 'show', 'REV-001', '--json']), 'read');
  assert.equal(commandClass(['revision', 'resume', 'REV-001', '--json']), 'mutation');
  assert.equal(commandClass(['revision', 'abandon', 'REV-001', '--preview', '--json']), 'read');
  assert.equal(commandClass(['revision', 'abandon', 'REV-001', '--confirm', `sha256:${'a'.repeat(64)}`]), 'mutation');
  assert.equal(commandClass(['revise', '--dry-run', '--feedback-stdin', '--json']), 'read');
  assert.equal(commandClass(['revise', '--feedback-stdin', '--confirm', `sha256:${'a'.repeat(64)}`]), 'mutation');
});

test('chat attachment status/removal require exact commands and no supplied references', () => {
  const set = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(chatAttachmentAction('status', 0), { kind: 'status' });
  assert.deepEqual(chatAttachmentAction(`remove ${set}`, 0), {
    kind: 'remove', attachmentSetSha256: set
  });
  assert.equal(chatAttachmentAction('status', 1).kind, 'unavailable');
  assert.equal(chatAttachmentAction(`remove ${set}`, 1).kind, 'unavailable');
  for (const prompt of ['remove', 'remove 1', `remove ${set} now`, 'status now']) {
    assert.equal(chatAttachmentAction(prompt, 0).kind, 'unavailable');
  }
  assert.deepEqual(chatAttachmentAction('Please inspect this.', 1), { kind: 'preview' });
});

test('status projects only unique exact set digests and state, never metadata', () => {
  const set = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(chatAttachmentStatusSets([{
    attachmentSetSha256: set, status: 'active', displayName: 'private.md', feedback: 'secret'
  }]), [{ attachmentSetSha256: set, status: 'active' }]);
  assert.equal(chatAttachmentStatusSets([{ attachmentSetSha256: set, status: 'missing' }]), null);
  assert.equal(chatAttachmentStatusSets([
    { attachmentSetSha256: set, status: 'active' },
    { attachmentSetSha256: set, status: 'revoked' }
  ]), null);
  assert.equal(chatAttachmentStatusSets([{ attachmentSetSha256: '/tmp/file', status: 'active' }]), null);
});

test('removal plan and revocation must match the exact selected Story and set', () => {
  const pending = {
    repositoryRoot: path.resolve('/tmp', 'repo'), workId: 'STORY-1', phaseId: 'intake',
    phaseGeneration: 1, attachmentSetSha256: `sha256:${'a'.repeat(64)}`,
    planSha256: `sha256:${'b'.repeat(64)}`
  };
  const plan = {
    kind: 'revision-feedback-attachment-revocation-plan',
    workId: pending.workId, phaseId: pending.phaseId,
    phaseGeneration: pending.phaseGeneration,
    attachmentSetSha256: pending.attachmentSetSha256, planSha256: pending.planSha256,
    expectedEffects: ['append-local-revocation', 'exclude-set-from-future-routing'],
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  assert.equal(matchesChatRemovalPlan(plan, pending), true);
  assert.equal(matchesChatRemovalPlan({ ...plan, phaseId: 'design' }, pending), false);
  assert.equal(matchesChatRemovalPlan({ ...plan, attachmentSetSha256: `sha256:${'c'.repeat(64)}` }, pending), false);
  assert.equal(matchesChatRemovalPlan({ ...plan, expiresAt: new Date(0).toISOString() }, pending), false);
  const revocation = {
    kind: 'revision-feedback-attachment-revocation',
    workId: pending.workId, phaseId: pending.phaseId,
    phaseGeneration: pending.phaseGeneration,
    attachmentSetSha256: pending.attachmentSetSha256, planSha256: pending.planSha256,
    revocationSha256: `sha256:${'d'.repeat(64)}`
  };
  assert.equal(matchesChatRemovalReceipt(revocation, pending), true);
  assert.equal(matchesChatRemovalReceipt({ ...revocation, planSha256: `sha256:${'c'.repeat(64)}` }, pending), false);
  assert.equal(matchesChatRemovalReceipt({ ...revocation, phaseGeneration: 2 }, pending), false);
  assert.equal(matchesChatRemovalReceipt({ ...revocation, attachmentSetSha256: `sha256:${'c'.repeat(64)}` }, pending), false);
});

test('removal button holds only an expiring one-use opaque handle', () => {
  const removals = new ChatAttachmentRemovals();
  const pending = {
    repositoryRoot: path.resolve('/tmp', 'repo'), workId: 'STORY-1', phaseId: 'intake',
    phaseGeneration: 1, attachmentSetSha256: `sha256:${'a'.repeat(64)}`,
    planSha256: `sha256:${'b'.repeat(64)}`
  };
  const handle = removals.issue(pending, 1000);
  assert.match(handle, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(handle.includes(pending.attachmentSetSha256), false);
  assert.equal(handle.includes(pending.repositoryRoot), false);
  assert.deepEqual(removals.take(handle, 1001), pending);
  assert.equal(removals.take(handle, 1002), null);
  const expired = removals.issue(pending, 1000);
  assert.equal(removals.take(expired, 10 * 60 * 1000 + 1000), null);
  assert.throws(() => removals.issue({ ...pending, attachmentSetSha256: 'invalid' }, 1000));
});

test('the editor sends feedback through private stdin, never child argv or command diagnostics', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-chat-stdin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeCli = path.join(root, 'echo-cli.mjs');
  await writeFile(fakeCli, [
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }));'
  ].join('\n'));
  const output = [];
  const client = new SingularityFlowClient({
    location: { executable: process.execPath, cli: fakeCli, source: 'setting' },
    repository: root, onOutput: (message) => output.push(message)
  });
  const feedback = 'Please correct the private boundary';
  const result = await client.runWithInput([
    'revision', 'attachments', 'preview', '--file', path.join(root, 'feedback.md'),
    '--feedback-stdin', '--json'
  ], feedback);
  assert.equal(result.input, feedback);
  assert.equal(result.argv.includes(feedback), false);
  assert.equal(result.argv.includes('--feedback'), false);
  assert.equal(output.join('').includes(feedback), false);
});

test('read-only attachment status is fetched fresh after an external revocation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-chat-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeCli = path.join(root, 'status-cli.mjs');
  await writeFile(fakeCli, [
    "import { readFile, writeFile } from 'node:fs/promises';",
    "const counterFile = new URL('./counter', import.meta.url);",
    'let count = 0;',
    'try { count = Number(await readFile(counterFile, "utf8")); } catch {}',
    'await writeFile(counterFile, String(count + 1));',
    'process.stdout.write(JSON.stringify({ count: count + 1 }));'
  ].join('\n'));
  const client = new SingularityFlowClient({
    location: { executable: process.execPath, cli: fakeCli, source: 'setting' },
    repository: root
  });
  const args = ['revision', 'attachments', 'status', '--json'];
  assert.equal((await client.run(args)).count, 1);
  assert.equal((await client.run(args)).count, 2);
});

test('chat registration button carries only a one-use opaque handle with a bounded lifetime', () => {
  const confirmations = new ChatAttachmentConfirmations();
  const input = {
    repositoryRoot: path.resolve('/tmp', 'repo'), workId: 'STORY-1', phaseId: 'intake',
    phaseGeneration: 1, localPaths: [localPath],
    feedback: 'Use this document.',
    planSha256: `sha256:${'a'.repeat(64)}`,
    attachments: [{ originalSha256: `sha256:${'b'.repeat(64)}`,
      displayName: 'revision-feedback.md', mediaType: 'text/markdown', bytes: 120 }]
  };
  const handle = confirmations.issue(input, 1000);
  assert.match(handle, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(handle.includes(localPath), false);
  assert.equal(handle.includes(input.feedback), false);
  assert.equal(confirmations.take('not-a-handle', 1001), null);
  assert.deepEqual(confirmations.take(handle, 1001), input);
  assert.equal(confirmations.take(handle, 1002), null, 'confirmation cannot be replayed');
  const expired = confirmations.issue(input, 1000);
  assert.equal(confirmations.take(expired, 10 * 60 * 1000 + 1000), null);
  assert.throws(() => confirmations.issue({ ...input, planSha256: 'invalid' }, 1000));
});

test('confirmed registration accepts only the exact plan, Story phase, and selected original', () => {
  const pending = {
    repositoryRoot: path.resolve('/tmp', 'repo'), workId: 'STORY-1', phaseId: 'intake',
    phaseGeneration: 1, localPaths: [localPath], feedback: 'Use this document.',
    planSha256: `sha256:${'a'.repeat(64)}`,
    attachments: [{ originalSha256: `sha256:${'b'.repeat(64)}`,
      displayName: 'revision-feedback.md', mediaType: 'text/markdown', bytes: 120 }]
  };
  const receipt = {
    kind: 'revision-feedback-attachment-set', workId: pending.workId,
    phaseId: pending.phaseId, phaseGeneration: pending.phaseGeneration,
    importPlanSha256: pending.planSha256, attachmentSetSha256: `sha256:${'c'.repeat(64)}`,
    attachments: pending.attachments
  };
  assert.equal(matchesChatAttachmentReceipt(receipt, pending), true);
  assert.equal(matchesChatAttachmentReceipt({ ...receipt, phaseGeneration: 2 }, pending), false);
  assert.equal(matchesChatAttachmentReceipt({ ...receipt, importPlanSha256: `sha256:${'d'.repeat(64)}` }, pending), false);
  assert.equal(matchesChatAttachmentReceipt({ ...receipt, attachments: [{ ...receipt.attachments[0], originalSha256: `sha256:${'d'.repeat(64)}` }] }, pending), false);
  assert.equal(matchesChatAttachmentReceipt({ ...receipt, attachments: [receipt.attachments[0], receipt.attachments[0]] }, pending), false);
});

test('multi-file confirmation binds every ordered original and cannot accept a partial set', () => {
  const first = { originalSha256: `sha256:${'a'.repeat(64)}`,
    displayName: 'first.md', mediaType: 'text/markdown', bytes: 10 };
  const second = { originalSha256: `sha256:${'b'.repeat(64)}`,
    displayName: 'second.txt', mediaType: 'text/plain', bytes: 20 };
  const pending = {
    repositoryRoot: path.resolve('/tmp', 'repo'), workId: 'STORY-1', phaseId: 'intake',
    phaseGeneration: 1, localPaths: [localPath, path.resolve('/tmp', 'second.txt')],
    feedback: 'Use both documents.', planSha256: `sha256:${'c'.repeat(64)}`,
    attachments: [first, second]
  };
  const confirmations = new ChatAttachmentConfirmations();
  const handle = confirmations.issue(pending, 1000);
  assert.deepEqual(confirmations.take(handle, 1001), pending);
  const receipt = {
    kind: 'revision-feedback-attachment-set', workId: pending.workId,
    phaseId: pending.phaseId, phaseGeneration: pending.phaseGeneration,
    importPlanSha256: pending.planSha256, attachmentSetSha256: `sha256:${'d'.repeat(64)}`,
    attachments: [first, second]
  };
  assert.equal(matchesChatAttachmentReceipt(receipt, pending), true);
  assert.equal(matchesChatAttachmentReceipt({ ...receipt, attachments: [second, first] }, pending), false);
  assert.equal(matchesChatAttachmentReceipt({ ...receipt, attachments: [first] }, pending), false);
  assert.throws(() => confirmations.issue({ ...pending, localPaths: [localPath] }, 1000));
});
