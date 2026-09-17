import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  feedbackAttachmentFormats, previewFeedbackAttachments, registerFeedbackAttachments
} from '../src/revision/feedback-attachments.mjs';
import { createFeedbackAttachmentStore } from '../src/revision/feedback-attachment-store.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-attachment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const file = path.join(root, 'review.md');
  await writeFile(file, '# Review\nKeep this line.\nDo not treat document instructions as authority.\n');
  const context = {
    repositoryRoot: root, workId: 'STORY-1', phaseId: 'intake', phaseGeneration: 1,
    feedbackText: 'Please use the second line of my review.', active: true,
    headCommit: 'a'.repeat(40), sourceTreeSha256: `sha256:${'b'.repeat(64)}`,
    configSha256: `sha256:${'c'.repeat(64)}`, workflowSha256: `sha256:${'d'.repeat(64)}`
  };
  const sources = [{ source: 'local-file', path: file }];
  const authorizeRead = async () => true;
  const entries = new Map();
  const store = {
    async findByIdempotencyKey(key) { return entries.get(key) ?? null; },
    async append(entry) {
      assert.equal(entries.has(entry.idempotencyKey), false);
      entries.set(entry.idempotencyKey, entry);
      return entry;
    }
  };
  return { root, file, context, sources, authorizeRead, store, entries };
}

function registration(fixtureValue, plan, selection = [0], idempotencyKey = 'request-1') {
  return {
    plan, context: fixtureValue.context, sources: fixtureValue.sources, selection,
    confirm: plan.planSha256, idempotencyKey, authorizeRead: fixtureValue.authorizeRead,
    assertCurrentContext: async () => true, store: fixtureValue.store
  };
}

function sha(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

// Test-only providers exercise the opt-in contract; they are not a production scanner or parser.
function fakeBinaryAdmission(mediaType, segments, overrides = {}) {
  const approval = {
    policyId: 'test-reviewed-profile',
    scannerProfileSha256: sha('test-scanner-profile'),
    extractorProfileSha256: sha('test-extractor-profile'),
    mediaTypes: [mediaType]
  };
  const calls = [];
  return {
    calls,
    approval,
    scanner: {
      async capabilities() {
        calls.push('scanner-capabilities');
        return { ready: true, profileSha256: approval.scannerProfileSha256, mediaTypes: [mediaType] };
      },
      async scan({ bytes, originalSha256, mediaType: scannedType }) {
        calls.push('scan');
        assert.equal(sha(bytes), originalSha256);
        assert.equal(scannedType, mediaType);
        return {
          verdict: 'clean', originalSha256, profileSha256: approval.scannerProfileSha256,
          signatureSetSha256: sha('test-signatures'), ...overrides.scan
        };
      }
    },
    extractor: {
      async capabilities() {
        calls.push('extractor-capabilities');
        return { ready: true, profileSha256: approval.extractorProfileSha256, mediaTypes: [mediaType],
          ...overrides.extractorCapabilities };
      },
      async extract({ bytes, originalSha256, mediaType: extractedType }) {
        calls.push('extract');
        assert.equal(sha(bytes), originalSha256);
        assert.equal(extractedType, mediaType);
        return { originalSha256, profileSha256: approval.extractorProfileSha256,
          segments, ...overrides.extraction };
      }
    }
  };
}

test('text attachment preview pins exact bytes and selected lines without persisting', async (t) => {
  const value = await fixture(t);
  const selection = [{ index: 0, lineRanges: [{ startLine: 2, endLine: 2 }] }];
  const { plan, preview } = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection, authorizeRead: value.authorizeRead
  });
  assert.equal(value.entries.size, 0);
  assert.equal(plan.loopStatus, 'not-available');
  assert.match(plan.planSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(preview.attachments[0].mediaType, 'text/markdown');
  assert.equal(preview.attachments[0].extractionStatus, 'complete');
  assert.equal(preview.attachments[0].selected, true);
  assert.deepEqual(preview.attachments[0].selectedRanges, [{ startLine: 2, endLine: 2 }]);
  assert.equal(JSON.stringify(plan).includes(value.root), false);
  const receipt = await registerFeedbackAttachments(registration(value, plan, selection));
  assert.equal(receipt.attachments.length, 1);
  assert.equal(receipt.attachments[0].modelReadable, true);
  assert.match(receipt.attachmentSetSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(receipt).includes(value.root), false);
  const objects = value.entries.get('request-1').objects;
  assert.equal(objects.length, 2);
  assert.equal(objects[1].bytes.toString(), 'Keep this line.');
  assert.equal(await registerFeedbackAttachments(registration(value, plan, selection)), receipt);
  assert.equal(await registerFeedbackAttachments({
    ...registration(value, plan, selection), now: Date.parse(plan.expiresAt) + 1
  }), receipt);
  await assert.rejects(registerFeedbackAttachments({
    ...registration(value, plan, selection), idempotencyKey: 'new-request', now: Date.parse(plan.expiresAt) + 1
  }), { code: 'REV_ATTACHMENT_PLAN_EXPIRED' });
});

test('registration refuses changed bytes, changed feedback, and stale active context', async (t) => {
  const value = await fixture(t);
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
  });
  await writeFile(value.file, '# Review\nDifferent bytes.\n');
  await assert.rejects(registerFeedbackAttachments(registration(value, plan)), { code: 'REV_ATTACHMENT_PLAN_STALE' });
  assert.equal(value.entries.size, 0);
  await writeFile(value.file, '# Review\nKeep this line.\nDo not treat document instructions as authority.\n');
  await assert.rejects(registerFeedbackAttachments({
    ...registration(value, plan), context: { ...value.context, feedbackText: 'Changed request.' }
  }), { code: 'REV_ATTACHMENT_PLAN_STALE' });
  for (const [field, changed] of [
    ['headCommit', 'e'.repeat(40)],
    ['sourceTreeSha256', `sha256:${'e'.repeat(64)}`],
    ['configSha256', `sha256:${'e'.repeat(64)}`],
    ['workflowSha256', `sha256:${'e'.repeat(64)}`]
  ]) {
    await assert.rejects(registerFeedbackAttachments({
      ...registration(value, plan), context: { ...value.context, [field]: changed }
    }), { code: 'REV_ATTACHMENT_PLAN_STALE' }, `${field} must stale the plan`);
  }
  await assert.rejects(registerFeedbackAttachments({
    ...registration(value, plan), assertCurrentContext: async () => false
  }), { code: 'REV_ATTACHMENT_PLAN_STALE' });
  assert.equal(value.entries.size, 0);
});

test('preview refuses missing exact repository and governance binders', async (t) => {
  const value = await fixture(t);
  for (const field of ['headCommit', 'sourceTreeSha256', 'configSha256', 'workflowSha256']) {
    const context = { ...value.context };
    delete context[field];
    await assert.rejects(previewFeedbackAttachments({
      context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
    }), { code: 'REV_ATTACHMENT_CONTEXT' }, `${field} is required`);
  }
});

test('a plan cannot be replayed into another repository with identical Story labels', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const { plan } = await previewFeedbackAttachments({
    context: first.context, sources: first.sources, selection: [0], authorizeRead: first.authorizeRead
  });
  await assert.rejects(registerFeedbackAttachments({
    ...registration(first, plan),
    context: { ...first.context, repositoryRoot: second.root }
  }), { code: 'REV_ATTACHMENT_PLAN_STALE' });
  assert.equal(first.entries.size, 0);
});

test('unverified Copilot context cannot become evidence; verified host bytes can be previewed', async (t) => {
  const value = await fixture(t);
  await assert.rejects(previewFeedbackAttachments({
    context: value.context, sources: [{ source: 'copilot-host-attachment', displayName: 'review.md', summary: 'looks good' }],
    selection: [0]
  }), { code: 'REV_CHAT_ATTACHMENT_UNAVAILABLE' });
  const { plan } = await previewFeedbackAttachments({
    context: value.context,
    sources: [{ source: 'copilot-host-attachment', displayName: 'review.md', sourceHandle: 'opaque-host-handle', bytes: Buffer.from('# Review\n') }],
    selection: [0]
  });
  assert.equal(plan.attachments[0].source, 'copilot-host-attachment');
  assert.match(plan.attachments[0].sourceHandleSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(plan).includes('opaque-host-handle'), false);
});

test('PDF and image uploads refuse before evidence storage without an approved scanner/extractor', async (t) => {
  const value = await fixture(t);
  const pdf = path.join(value.root, 'notes.pdf');
  await writeFile(pdf, '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
  await assert.rejects(previewFeedbackAttachments({
    context: value.context, sources: [{ source: 'local-file', path: pdf }],
    selection: [0], authorizeRead: value.authorizeRead
  }), { code: 'REV_ATTACHMENT_TYPE_UNAVAILABLE' });
  const png = path.join(value.root, 'image.png');
  await writeFile(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await assert.rejects(previewFeedbackAttachments({
    context: value.context, sources: [{ source: 'local-file', path: png }],
    selection: [0], authorizeRead: value.authorizeRead
  }), { code: 'REV_ATTACHMENT_TYPE_UNAVAILABLE' });
  assert.equal(value.entries.size, 0);
});

test('the advertised text-format registry includes strictly parsed CSV and TSV', async (t) => {
  const value = await fixture(t);
  assert.deepEqual(feedbackAttachmentFormats, ['.txt', '.md', '.json', '.csv', '.tsv']);
  const csv = path.join(value.root, 'notes.csv');
  await writeFile(csv, 'name,note\nalpha,"first\nsecond"\nbeta,third\n');
  const sources = [{ source: 'local-file', path: csv, mediaType: 'text/csv' }];
  const selection = [{ index: 0, lineRanges: [{ startLine: 2, endLine: 3 }] }];
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources, selection, authorizeRead: value.authorizeRead
  });
  assert.equal(plan.attachments[0].rowCount, 3);
  assert.equal(plan.attachments[0].maximumColumns, 2);
  assert.deepEqual(plan.attachments[0].selectedRowRanges, [{ startRow: 2, endRow: 2 }]);
  const receipt = await registerFeedbackAttachments({
    ...registration(value, plan, selection), sources
  });
  assert.equal(receipt.attachments[0].parser, 'utf8-delimited-records@1');
  assert.equal(value.entries.get('request-1').objects[1].bytes.toString(), 'alpha,"first\nsecond"');
  await assert.rejects(previewFeedbackAttachments({
    context: value.context, sources,
    selection: [{ index: 0, lineRanges: [{ startLine: 3, endLine: 3 }] }],
    authorizeRead: value.authorizeRead
  }), { code: 'REV_ATTACHMENT_SELECTION' });
  const tsv = path.join(value.root, 'notes.tsv');
  await writeFile(tsv, 'name\tnote\nalpha\t"first\nsecond"\n');
  const tsvPreview = await previewFeedbackAttachments({
    context: value.context, sources: [{ source: 'local-file', path: tsv }],
    selection: [0], authorizeRead: value.authorizeRead
  });
  assert.equal(tsvPreview.plan.attachments[0].mediaType, 'text/tab-separated-values');
  assert.equal(tsvPreview.plan.attachments[0].rowCount, 2);
  assert.deepEqual(tsvPreview.plan.attachments[0].selectedRowRanges, [{ startRow: 1, endRow: 2 }]);
});

test('delimited intake validates unselected rows and rejects text-disguised binary', async (t) => {
  const value = await fixture(t);
  const csv = path.join(value.root, 'broken.csv');
  await writeFile(csv, 'good,row\ninvalid,"unterminated\n');
  await assert.rejects(previewFeedbackAttachments({
    context: value.context, sources: [{ source: 'local-file', path: csv }],
    selection: [{ index: 0, lineRanges: [{ startLine: 1, endLine: 1 }] }],
    authorizeRead: value.authorizeRead
  }), { code: 'REV_ATTACHMENT_MIME' });
  await writeFile(csv, 'good,row\ninvalid,unquoted"value\n');
  await assert.rejects(previewFeedbackAttachments({
    context: value.context, sources: [{ source: 'local-file', path: csv }],
    selection: [0], authorizeRead: value.authorizeRead
  }), { code: 'REV_ATTACHMENT_MIME' });
  await writeFile(value.file, '%PDF-1.7\nnot text evidence');
  await assert.rejects(previewFeedbackAttachments({
    context: value.context, sources: value.sources,
    selection: [0], authorizeRead: value.authorizeRead
  }), { code: 'REV_ATTACHMENT_MIME' });
  const json = path.join(value.root, 'encoded.json');
  const escapedCredential = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ123456'
    .split('').map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  await writeFile(json, `{"value":"${escapedCredential}"}`);
  await assert.rejects(previewFeedbackAttachments({
    context: value.context, sources: [{ source: 'local-file', path: json }],
    selection: [0], authorizeRead: value.authorizeRead
  }), { code: 'REV_ATTACHMENT_SECRET' });
  assert.equal(value.entries.size, 0);
});

test('optional binary admission binds provider-reported scan, extracted provenance, and selected bytes', async (t) => {
  const value = await fixture(t);
  const formats = [
    { name: 'review.pdf', mediaType: 'application/pdf', bytes: Buffer.from('%PDF-1.7\nfixture'),
      segments: [{ kind: 'page', index: 1, text: 'Page one\nNote' }, { kind: 'page', index: 3, text: 'Page three' }],
      expectedKind: 'page' },
    { name: 'review.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]),
      segments: [{ kind: 'section', index: 1, text: 'First section' }, { kind: 'section', index: 2, text: 'Second section' }],
      expectedKind: 'section' },
    { name: 'review.png', mediaType: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
      segments: [{ kind: 'region', index: 1, text: 'OCR text' }], expectedKind: 'region' }
  ];
  for (const [index, format] of formats.entries()) {
    const file = path.join(value.root, format.name);
    await writeFile(file, format.bytes);
    const sources = [{ source: 'local-file', path: file, mediaType: format.mediaType }];
    const binaryAdmission = fakeBinaryAdmission(format.mediaType, format.segments);
    const { plan } = await previewFeedbackAttachments({
      context: value.context, sources, selection: [0], authorizeRead: value.authorizeRead,
      binaryAdmission
    });
    assert.equal(plan.attachments[0].scanStatus, 'configured-provider-reported-clean');
    assert.equal(plan.attachments[0].sourceUnits[0].kind, format.expectedKind);
    assert.equal(plan.attachments[0].selectedProvenance[0].kind, format.expectedKind);
    if (format.expectedKind === 'page') {
      assert.deepEqual(plan.attachments[0].sourceUnits.map((unit) => unit.index), [1, 3]);
    }
    assert.match(plan.attachments[0].binaryAdmissionPolicySha256, /^sha256:[a-f0-9]{64}$/);
    const receipt = await registerFeedbackAttachments({
      ...registration(value, plan, [0], `binary-${index}`), sources, binaryAdmission
    });
    assert.equal(receipt.attachments[0].mediaType, format.mediaType);
    assert.equal(value.entries.get(`binary-${index}`).objects.length, 2);
    assert.deepEqual(binaryAdmission.calls, [
      'scanner-capabilities', 'extractor-capabilities', 'scan', 'extract',
      'scanner-capabilities', 'extractor-capabilities', 'scan', 'extract'
    ]);
  }
});

test('binary admission fails closed on policy, scanner, extractor, and secret failures', async (t) => {
  const value = await fixture(t);
  const file = path.join(value.root, 'review.pdf');
  await writeFile(file, '%PDF-1.7\nfixture');
  const sources = [{ source: 'local-file', path: file }];
  const args = { context: value.context, sources, selection: [0], authorizeRead: value.authorizeRead };
  const cleanSegments = [{ kind: 'page', index: 1, text: 'Safe page' }];
  const wrongPolicy = fakeBinaryAdmission('application/pdf', cleanSegments);
  wrongPolicy.approval.mediaTypes = ['image/png'];
  await assert.rejects(previewFeedbackAttachments({ ...args, binaryAdmission: wrongPolicy }),
    { code: 'REV_ATTACHMENT_BINARY_POLICY' });
  assert.equal(wrongPolicy.calls.includes('scan'), false);
  const wrongCapability = fakeBinaryAdmission('application/pdf', cleanSegments,
    { extractorCapabilities: { profileSha256: sha('different-extractor') } });
  await assert.rejects(previewFeedbackAttachments({ ...args, binaryAdmission: wrongCapability }),
    { code: 'REV_ATTACHMENT_BINARY_POLICY' });
  assert.equal(wrongCapability.calls.includes('scan'), false);
  const infected = fakeBinaryAdmission('application/pdf', cleanSegments, { scan: { verdict: 'infected' } });
  await assert.rejects(previewFeedbackAttachments({ ...args, binaryAdmission: infected }),
    { code: 'REV_ATTACHMENT_SCAN_REJECTED' });
  assert.equal(infected.calls.includes('extract'), false);
  const mismatchedScan = fakeBinaryAdmission('application/pdf', cleanSegments,
    { scan: { originalSha256: sha('different-bytes') } });
  await assert.rejects(previewFeedbackAttachments({ ...args, binaryAdmission: mismatchedScan }),
    { code: 'REV_ATTACHMENT_SCAN_UNAVAILABLE' });
  assert.equal(mismatchedScan.calls.includes('extract'), false);
  const wrongUnit = fakeBinaryAdmission('application/pdf', [{ kind: 'section', index: 1, text: 'Wrong unit' }]);
  await assert.rejects(previewFeedbackAttachments({ ...args, binaryAdmission: wrongUnit }),
    { code: 'REV_ATTACHMENT_EXTRACT_UNAVAILABLE' });
  const unsortedPages = fakeBinaryAdmission('application/pdf', [
    { kind: 'page', index: 3, text: 'Third page' },
    { kind: 'page', index: 2, text: 'Second page' }
  ]);
  await assert.rejects(previewFeedbackAttachments({ ...args, binaryAdmission: unsortedPages }),
    { code: 'REV_ATTACHMENT_EXTRACT_UNAVAILABLE' });
  const secret = fakeBinaryAdmission('application/pdf',
    [{ kind: 'page', index: 1, text: 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ123456' }]);
  await assert.rejects(previewFeedbackAttachments({ ...args, binaryAdmission: secret }),
    { code: 'REV_ATTACHMENT_SECRET' });
  const oversized = fakeBinaryAdmission('application/pdf',
    [{ kind: 'page', index: 1, text: 'x'.repeat(2 * 1024 * 1024 + 1) }]);
  await assert.rejects(previewFeedbackAttachments({ ...args, binaryAdmission: oversized }),
    { code: 'REV_ATTACHMENT_RENDITION_SIZE' });
  assert.equal(value.entries.size, 0);
});

test('binary plan stales if the scanner signature set changes before registration', async (t) => {
  const value = await fixture(t);
  const file = path.join(value.root, 'review.pdf');
  await writeFile(file, '%PDF-1.7\nfixture');
  const sources = [{ source: 'local-file', path: file }];
  const binaryAdmission = fakeBinaryAdmission('application/pdf',
    [{ kind: 'page', index: 1, text: 'Safe page' }]);
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources, selection: [0], authorizeRead: value.authorizeRead,
    binaryAdmission
  });
  const firstScan = binaryAdmission.scanner.scan;
  binaryAdmission.scanner.scan = async (args) => ({
    ...await firstScan(args), signatureSetSha256: sha('updated-signatures')
  });
  await assert.rejects(registerFeedbackAttachments({
    ...registration(value, plan), sources, binaryAdmission
  }), { code: 'REV_ATTACHMENT_PLAN_STALE' });
  assert.equal(value.entries.size, 0);
});

test('read authorization, secret screening, and unselected exclusion fail closed', async (t) => {
  const value = await fixture(t);
  await assert.rejects(previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: async () => false
  }), { code: 'REV_ATTACHMENT_UNAUTHORIZED' });
  await writeFile(value.file, 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ123456\n');
  await assert.rejects(previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
  }), { code: 'REV_ATTACHMENT_SECRET' });
  await writeFile(value.file, '# Review\nSafe text.\n');
  const other = path.join(value.root, 'unselected.txt');
  await writeFile(other, 'Do not include these bytes.\n');
  const { plan } = await previewFeedbackAttachments({
    context: value.context,
    sources: [...value.sources, { source: 'local-file', path: other }],
    selection: [0], authorizeRead: value.authorizeRead
  });
  const receipt = await registerFeedbackAttachments({
    ...registration(value, plan), sources: [...value.sources, { source: 'local-file', path: other }]
  });
  assert.equal(receipt.attachments.length, 1);
  assert.equal(value.entries.get('request-1').objects.length, 2);
  assert.equal(JSON.stringify(receipt).includes('unselected.txt'), false);
  assert.equal(value.entries.get('request-1').objects.some((item) => item.bytes.toString().includes('Do not include')), false);
  const unselected = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [], authorizeRead: value.authorizeRead
  });
  await assert.rejects(registerFeedbackAttachments(registration(value, unselected.plan, [], 'request-2')), {
    code: 'REV_ATTACHMENT_SELECTION'
  });
});

test('confirmation and idempotency keys cannot be reused for a different selection', async (t) => {
  const value = await fixture(t);
  const first = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
  });
  await assert.rejects(registerFeedbackAttachments({
    ...registration(value, first.plan), confirm: 'sha256:'.concat('0'.repeat(64))
  }), { code: 'REV_ATTACHMENT_CONFIRMATION' });
  await registerFeedbackAttachments(registration(value, first.plan));
  const second = await previewFeedbackAttachments({
    context: value.context, sources: value.sources,
    selection: [{ index: 0, lineRanges: [{ startLine: 1, endLine: 1 }] }], authorizeRead: value.authorizeRead
  });
  await assert.rejects(registerFeedbackAttachments(registration(value, second.plan, [{ index: 0, lineRanges: [{ startLine: 1, endLine: 1 }] }])), {
    code: 'REV_ATTACHMENT_IDEMPOTENCY_CONFLICT'
  });
});

test('local symlink target is authorized by its resolved path and target replacement stales the plan', async (t) => {
  const value = await fixture(t);
  const second = path.join(value.root, 'other.md');
  const link = path.join(value.root, 'attached.md');
  await writeFile(second, '# Different\n');
  await symlink(value.file, link);
  const sources = [{ source: 'local-file', path: link }];
  const seen = [];
  const authorized = await realpath(value.file);
  const authorizeRead = async ({ resolvedPath }) => { seen.push(resolvedPath); return resolvedPath === authorized; };
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources, selection: [0], authorizeRead
  });
  assert.deepEqual(seen, [authorized]);
  await unlink(link);
  await symlink(second, link);
  await assert.rejects(registerFeedbackAttachments({
    ...registration(value, plan), sources, authorizeRead
  }), { code: 'REV_ATTACHMENT_UNAUTHORIZED' });
  assert.equal(value.entries.size, 0);
});

test('private local store atomically retains a selected set and deduplicated addressed bytes', async (t) => {
  const value = await fixture(t);
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: value.root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const localRoot = path.join(value.root, '.git', 'singularity-flow', 'revision-feedback-attachments');
  const store = createFeedbackAttachmentStore(value.root, {
    workId: value.context.workId, phaseId: value.context.phaseId,
    phaseGeneration: value.context.phaseGeneration,
    assertCurrentContext: async (expected) => expected.phaseGeneration === value.context.phaseGeneration
  });
  assert.deepEqual(await store.list(), []);
  await assert.rejects(access(localRoot), { code: 'ENOENT' });
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
  });
  await store.savePlan(plan);
  assert.deepEqual(await store.readPlan(plan.planSha256), plan);
  const receipt = await registerFeedbackAttachments({
    ...registration(value, plan), store
  });
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(await store.read(receipt.attachmentSetSha256), receipt);
  const original = await store.readObject(receipt.attachments[0].originalSha256);
  assert.equal(original.toString(), await readFile(value.file, 'utf8'));
  const repeated = await registerFeedbackAttachments({ ...registration(value, plan), store });
  assert.deepEqual(repeated, receipt);
  assert.equal((await store.list()).length, 1);
  const scoped = path.join(localRoot, 'STORY-1', 'intake', '0001');
  if (process.platform !== 'win32') {
    assert.equal((await stat(scoped)).mode & 0o077, 0);
    assert.equal((await stat(path.join(scoped, 'plans', `${plan.planSha256.slice(7)}.json`))).mode & 0o077, 0);
    assert.equal((await stat(path.join(scoped, 'objects', `${receipt.attachments[0].originalSha256.slice(7)}.bin`))).mode & 0o077, 0);
  }
});

test('store rechecks the active Story phase inside its write lock before any selected bytes persist', async (t) => {
  const value = await fixture(t);
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: value.root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  let current = true;
  const store = createFeedbackAttachmentStore(value.root, {
    workId: value.context.workId, phaseId: value.context.phaseId,
    phaseGeneration: value.context.phaseGeneration,
    assertCurrentContext: async () => current
  });
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
  });
  await store.savePlan(plan);
  current = false;
  await assert.rejects(registerFeedbackAttachments({
    ...registration(value, plan), store
  }), { code: 'REV_ATTACHMENT_PLAN_STALE' });
  assert.deepEqual(await store.list(), []);
  const scoped = path.join(value.root, '.git', 'singularity-flow', 'revision-feedback-attachments',
    'STORY-1', 'intake', '0001', 'objects');
  await assert.rejects(access(scoped), { code: 'ENOENT' });
});

test('a receipt is not proof when any selected original or rendition is missing or corrupt', async (t) => {
  const value = await fixture(t);
  const store = createFeedbackAttachmentStore(value.root, {
    workId: value.context.workId, phaseId: value.context.phaseId,
    phaseGeneration: value.context.phaseGeneration, assertCurrentContext: async () => true
  });
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
  });
  await store.savePlan(plan);
  const receipt = await registerFeedbackAttachments({ ...registration(value, plan), store });
  const objects = path.join(value.root, '.git', 'singularity-flow', 'revision-feedback-attachments',
    'STORY-1', 'intake', '0001', 'objects');
  const original = path.join(objects, `${receipt.attachments[0].originalSha256.slice(7)}.bin`);
  const rendition = path.join(objects, `${receipt.attachments[0].renditionSha256.slice(7)}.bin`);
  await unlink(original);
  await assert.rejects(store.list(), { code: 'REV_ATTACHMENT_STORE_CORRUPT' });
  await assert.rejects(store.read(receipt.attachmentSetSha256), { code: 'REV_ATTACHMENT_STORE_CORRUPT' });
  await assert.rejects(registerFeedbackAttachments({ ...registration(value, plan), store }), {
    code: 'REV_ATTACHMENT_STORE_CORRUPT'
  });
  await writeFile(original, await readFile(value.file), { mode: 0o600 });
  await writeFile(rendition, 'wrong selected bytes', { mode: 0o600 });
  await assert.rejects(store.list(), { code: 'REV_ATTACHMENT_STORE_CORRUPT' });
});

test('an incomplete unreferenced object from an interrupted write is removed before receipt publication', async (t) => {
  const value = await fixture(t);
  const store = createFeedbackAttachmentStore(value.root, {
    workId: value.context.workId, phaseId: value.context.phaseId,
    phaseGeneration: value.context.phaseGeneration, assertCurrentContext: async () => true
  });
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
  });
  await store.savePlan(plan);
  const objects = path.join(value.root, '.git', 'singularity-flow', 'revision-feedback-attachments',
    'STORY-1', 'intake', '0001', 'objects');
  await mkdir(objects, { mode: 0o700 });
  const corrupt = path.join(objects, `${plan.attachments[0].originalSha256.slice(7)}.bin`);
  await writeFile(corrupt, 'incomplete crash residue', { mode: 0o600 });
  const receipt = await registerFeedbackAttachments({ ...registration(value, plan), store });
  assert.deepEqual(await store.list(), [receipt]);
  assert.equal((await store.readObject(receipt.attachments[0].originalSha256)).toString(),
    await readFile(value.file, 'utf8'));
});

test('the next append removes an unreferenced crash orphan without deleting referenced bytes', async (t) => {
  const value = await fixture(t);
  const store = createFeedbackAttachmentStore(value.root, {
    workId: value.context.workId, phaseId: value.context.phaseId,
    phaseGeneration: value.context.phaseGeneration, assertCurrentContext: async () => true
  });
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
  });
  await store.savePlan(plan);
  const objects = path.join(value.root, '.git', 'singularity-flow', 'revision-feedback-attachments',
    'STORY-1', 'intake', '0001', 'objects');
  await mkdir(objects, { mode: 0o700 });
  const orphan = path.join(objects, `${'0'.repeat(64)}.bin`);
  const abandonedTemp = path.join(objects, `${'1'.repeat(64)}.bin.tmp-42-00000000-0000-4000-8000-000000000000`);
  await writeFile(orphan, 'abandoned', { mode: 0o600 });
  await writeFile(abandonedTemp, 'partial temporary object', { mode: 0o600 });
  const receipt = await registerFeedbackAttachments({ ...registration(value, plan), store });
  await assert.rejects(access(orphan), { code: 'ENOENT' });
  await assert.rejects(access(abandonedTemp), { code: 'ENOENT' });
  assert.equal((await store.readObject(receipt.attachments[0].originalSha256)).toString(),
    await readFile(value.file, 'utf8'));
});

test('staged plans are bounded and expired unreferenced plans are pruned at capacity', async (t) => {
  const value = await fixture(t);
  const store = createFeedbackAttachmentStore(value.root, {
    workId: value.context.workId, phaseId: value.context.phaseId,
    phaseGeneration: value.context.phaseGeneration, assertCurrentContext: async () => true
  });
  const base = Date.now();
  const staged = async (now) => {
    const { plan } = await previewFeedbackAttachments({
      context: value.context, sources: [], selection: [], authorizeRead: value.authorizeRead, now
    });
    await store.savePlan(plan);
    return plan;
  };
  const expired = await staged(base - 60 * 60 * 1000);
  for (let index = 1; index < 200; index += 1) await staged(base + index);
  await staged(base + 200);
  const expiredFile = path.join(value.root, '.git', 'singularity-flow', 'revision-feedback-attachments',
    'STORY-1', 'intake', '0001', 'plans', `${expired.planSha256.slice(7)}.json`);
  await assert.rejects(access(expiredFile), { code: 'ENOENT' });
  await assert.rejects(staged(base + 201), { code: 'REV_ATTACHMENT_STORE_QUOTA' });
});

test('ordinary preview access prunes expired private plans before the quota is reached', async (t) => {
  const value = await fixture(t);
  const store = createFeedbackAttachmentStore(value.root, {
    workId: value.context.workId, phaseId: value.context.phaseId,
    phaseGeneration: value.context.phaseGeneration, assertCurrentContext: async () => true
  });
  const stage = async (now) => {
    const { plan } = await previewFeedbackAttachments({
      context: value.context, sources: [], selection: [], authorizeRead: value.authorizeRead, now
    });
    await store.savePlan(plan);
    return plan;
  };
  const expired = await stage(Date.now() - 60 * 60 * 1000);
  const current = await stage(Date.now());
  const plans = path.join(value.root, '.git', 'singularity-flow', 'revision-feedback-attachments',
    'STORY-1', 'intake', '0001', 'plans');
  await assert.rejects(access(path.join(plans, `${expired.planSha256.slice(7)}.json`)), { code: 'ENOENT' });
  assert.deepEqual(await store.readPlan(current.planSha256), current,
    'an unexpired preview remains available after ordinary cleanup');
});

test('registered originals and receipts survive handoff to a linked Git worktree', async (t) => {
  const value = await fixture(t);
  const git = (args, cwd = value.root) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'REV Attachment Test']);
  git(['config', 'user.email', 'rev@example.com']);
  git(['add', 'review.md']);
  git(['commit', '-m', 'baseline']);
  value.context.headCommit = git(['rev-parse', 'HEAD']);
  const linked = path.join(path.dirname(value.root), `${path.basename(value.root)}-linked`);
  t.after(() => rm(linked, { recursive: true, force: true }));
  git(['worktree', 'add', '-b', 'attachment-handoff', linked, 'HEAD']);
  const options = {
    workId: value.context.workId, phaseId: value.context.phaseId,
    phaseGeneration: value.context.phaseGeneration, assertCurrentContext: async () => true
  };
  const first = createFeedbackAttachmentStore(value.root, options);
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
  });
  await first.savePlan(plan);
  const second = createFeedbackAttachmentStore(linked, options);
  assert.deepEqual(await second.readPlan(plan.planSha256), plan);
  const receipt = await registerFeedbackAttachments({
    ...registration(value, plan),
    context: { ...value.context, repositoryRoot: linked },
    store: second
  });
  assert.deepEqual(await first.read(receipt.attachmentSetSha256), receipt);
  assert.deepEqual(await second.read(receipt.attachmentSetSha256), receipt);
  assert.equal((await second.readObject(receipt.attachments[0].originalSha256)).toString(),
    await readFile(value.file, 'utf8'));
});

test('Windows store path applies and verifies current-user ACLs rather than POSIX mode bits', async (t) => {
  const value = await fixture(t);
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: value.root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const calls = [];
  let denyVerify = false;
  const windowsAcl = async (target, options) => {
    calls.push({ target, ...options });
    if (denyVerify && options.apply === false && target.endsWith('.json')) {
      throw new Error('ACL verification refused');
    }
    return { protected: true, principal: 'current-user', access: 'full-control' };
  };
  const store = createFeedbackAttachmentStore(value.root, {
    workId: value.context.workId, phaseId: value.context.phaseId,
    phaseGeneration: value.context.phaseGeneration,
    assertCurrentContext: async () => true,
    platform: 'win32', windowsAcl
  });
  const { plan } = await previewFeedbackAttachments({
    context: value.context, sources: value.sources, selection: [0], authorizeRead: value.authorizeRead
  });
  await store.savePlan(plan);
  assert.ok(calls.some((call) => call.directory === true && call.apply === true));
  assert.ok(calls.some((call) => call.directory === false && call.apply === true));
  assert.ok(calls.some((call) => call.directory === false && call.apply === false));
  denyVerify = true;
  await assert.rejects(store.readPlan(plan.planSha256), /ACL verification refused/);
});
