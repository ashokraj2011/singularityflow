/** Focused Story-intake UI coverage for description space and local supporting documents. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const {
  EMPTY_INTAKE_FORM, INTAKE_SCRIPT, MAX_STORY_ATTACHMENT_SLOTS,
  MIN_STORY_ATTACHMENT_SLOTS, intakeCommand, intakeHtml, mergeStoryAttachments,
  storyAttachmentNameProblems, suggestedStoryDocumentName
} = await import(source('intake-form.ts'));

const story = (overrides = {}) => ({
  ...EMPTY_INTAKE_FORM,
  shape: 'story',
  tracker: 'none',
  id: 'documented-story',
  title: 'Use supporting documents',
  description: 'Ground the Story in its source material.',
  ...overrides
});

test('Story intake gives the description room and always exposes four document slots', () => {
  const html = intakeHtml(story());
  assert.match(html, /data-field="description" rows="8" cols="64" class="story-description"/);
  assert.equal((html.match(/data-attachment-slot="\d+"/g) ?? []).length,
    MIN_STORY_ATTACHMENT_SLOTS);
  assert.equal(MIN_STORY_ATTACHMENT_SLOTS, 4);
  assert.equal(MAX_STORY_ATTACHMENT_SLOTS, 4);
  assert.equal((html.match(/data-attachment-pick="\d+"/g) ?? []).length,
    MIN_STORY_ATTACHMENT_SLOTS);
  assert.match(html, /Choose documents…/);
  assert.match(html, /opening governed Git\s+commit; files kept in Git are copied into that commit and pushed/);
  assert.match(html, /files kept on this machine\s+stay here/, 'machine-only documents are not promised to the commit');
  assert.match(html, /may use bounded text from selected\s+text documents/);

  const epic = intakeHtml({ ...story(), shape: 'epic' });
  assert.match(epic, /data-field="description" rows="3" cols="64"/);
  assert.doesNotMatch(epic, /Story supporting document slots/);
});

test('selected Story documents are escaped, replaceable, and clearable', () => {
  const html = intakeHtml(story({
    storyAttachments: [
      { sourcePath: '/private/secret-folder/design.md', displayName: '<design>.md' },
      null,
      null,
      null
    ]
  }));
  assert.match(html, /&lt;design&gt;\.md/);
  assert.doesNotMatch(html, /<design>\.md/);
  assert.doesNotMatch(html, /secret-folder/, 'the local source path stays out of webview markup');
  assert.match(html, /data-attachment-pick="0">Replace file/);
  assert.match(html, /data-attachment-clear="0">Clear/);
  assert.match(html, /data-attachment-name="0" value="&lt;design&gt;"/,
    'a document saved before names existed is offered its file name, escaped');
});

test('Story start documents carry one storage choice and one phase set', () => {
  const choices = {
    storyWorkflows: [{ id: 'spec-driven-standard', label: 'Spec', description: '', phases: ['specification', 'planning', 'implementation'] }],
    workType: 'spec-driven-standard', baseBranch: 'main', basePreflightPassed: true
  };
  const storyAttachments = [{ sourcePath: '/source/brief.md', displayName: 'brief.md', name: 'Brief' }, null, null, null];
  const plain = intakeCommand(story({ ...choices, storyAttachments }));
  assert.ok(!plain.includes('--document-store') && !plain.includes('--document-phases'), 'Git and every phase are the defaults');
  const narrowed = intakeCommand(story({ ...choices, storyAttachments, storyDocumentStore: 'local', storyDocumentPhases: ['specification', 'planning'] }));
  assert.deepEqual(narrowed.slice(narrowed.indexOf('--document')), [
    '--document', '/source/brief.md', '--document-name', 'Brief', '--document-store', 'local', '--document-phases', 'specification,planning'
  ]);
  const none = intakeCommand(story({ ...choices, storyAttachments: [null, null, null, null], storyDocumentStore: 'local', storyDocumentPhases: ['planning'] }));
  assert.ok(!none.includes('--document-store'), 'no document, no document options');
  // The storage and phase choices are visible before any file is chosen, so they can be found.
  const empty = intakeHtml(story({ ...choices, storyAttachments: [null, null, null, null] }));
  assert.match(empty, /Keep the documents you choose\s*<select data-attachment-store/);
  assert.match(empty, /data-attachment-phase="specification" checked>/);
  assert.match(empty, /No document selected\. Choose a file, then give it a name here\./);
  assert.doesNotMatch(empty, /Choose at least one phase/, 'with no document, the phase choice is not a problem yet');
  const html = intakeHtml(story({ ...choices, storyAttachments, storyDocumentPhases: ['planning'] }));
  assert.match(html, /<select data-attachment-store/);
  assert.match(html, /data-attachment-phase="specification">/);
  assert.match(html, /data-attachment-phase="planning" checked>/);
  assert.match(intakeHtml(story({ ...choices, storyAttachments, storyDocumentPhases: [] })), /Choose at least one phase that uses the supporting documents/);
  assert.match(INTAKE_SCRIPT, /type: 'attachmentStore', value: el\.value/);
  assert.match(INTAKE_SCRIPT, /type: 'attachmentPhases'/);
});

test('every selected Story document needs its own name before Story start is offered', () => {
  const choices = {
    storyWorkflows: [{ id: 'feature', label: 'Feature', description: '', phases: ['intake'] }],
    workType: 'feature', baseBranch: 'main', basePreflightPassed: true
  };
  const named = (names) => story({ ...choices, storyAttachments: names.map((name, index) => ({
    sourcePath: `/source/${index}.md`, displayName: `${index}.md`, name
  })) });
  assert.deepEqual(storyAttachmentNameProblems(named(['Payment brief', 'Checkout design']).storyAttachments), []);
  assert.match(storyAttachmentNameProblems(named(['Payment brief', '   ']).storyAttachments).join('\n'),
    /Give Document 2 \(1\.md\) a name/);
  assert.match(storyAttachmentNameProblems(named(['Payment brief', 'payment  BRIEF ']).storyAttachments).join('\n'),
    /Document 1 and Document 2 have the same name/);
  assert.match(storyAttachmentNameProblems(named(['DOC-004']).storyAttachments).join('\n'), /looks like a document ID/);
  assert.match(storyAttachmentNameProblems(named(['x'.repeat(121)]).storyAttachments).join('\n'), /longer than 120 characters/);
  assert.match(intakeHtml(named(['Payment brief', 'payment brief'])), /data-submit="start" disabled/);
  assert.doesNotMatch(intakeHtml(named(['Payment brief', 'Checkout design'])), /have the same name/);
  assert.equal(suggestedStoryDocumentName('/drafts/payment_retry-brief.md'), 'payment retry brief');
  assert.match(INTAKE_SCRIPT, /type: 'attachmentNameDraft',\s*index: Number\(event\.target\.dataset\.attachmentName\)/);
  assert.match(INTAKE_SCRIPT, /type: 'attachmentName',\s*index: Number\(el\.dataset\.attachmentName\)/);
});

test('attachment merging reports overflow and normalized duplicates without losing slots', () => {
  const picked = Array.from({ length: 5 }, (_, index) => ({
    sourcePath: `/docs/${index + 1}.md`, displayName: `${index + 1}.md`
  }));
  const full = mergeStoryAttachments([null, null, null, null], picked, null, 'linux');
  assert.deepEqual(full.attachments.map((entry) => entry?.displayName), [
    '1.md', '2.md', '3.md', '4.md'
  ]);
  assert.equal(full.overflow, 1);
  assert.equal(full.duplicates, 0);

  const windows = mergeStoryAttachments([
    { sourcePath: 'C:\\Docs\\Brief.markdown', displayName: 'Brief.markdown' },
    { sourcePath: 'C:\\Docs\\Second.md', displayName: 'Second.md' },
    null,
    null
  ], [
    { sourcePath: 'c:/docs/BRIEF.markdown', displayName: 'duplicate.markdown' },
    { sourcePath: 'C:\\Docs\\Third.md', displayName: 'Third.md' },
    { sourcePath: 'C:\\Docs\\Fourth.md', displayName: 'Fourth.md' },
    { sourcePath: 'C:\\Docs\\Fifth.md', displayName: 'Fifth.md' }
  ], null, 'win32');
  assert.equal(windows.duplicates, 1);
  assert.equal(windows.overflow, 1);
  assert.deepEqual(windows.attachments.map((entry) => entry?.displayName), [
    'Brief.markdown', 'Second.md', 'Third.md', 'Fourth.md'
  ]);

  const replacement = mergeStoryAttachments(windows.attachments, [{
    sourcePath: 'c:/docs/second.md', displayName: 'same-as-slot-two.md'
  }], 0, 'win32');
  assert.equal(replacement.duplicates, 1);
  assert.equal(replacement.attachments[0]?.displayName, 'Brief.markdown');
  assert.equal(mergeStoryAttachments([
    { sourcePath: '/docs/Brief.md', displayName: 'Brief.md' }, null, null, null
  ], [{ sourcePath: '/docs/brief.md', displayName: 'brief.md' }], null, 'linux').duplicates, 0);
});

test('the attachment webview contract reports intent and never supplies a filesystem path', () => {
  assert.match(INTAKE_SCRIPT,
    /postMessage\(\{ type: 'attachmentPick', index: Number\(pickAttachment\.dataset\.attachmentPick\) \}\)/);
  assert.match(INTAKE_SCRIPT, /postMessage\(\{ type: 'attachmentsPick' \}\)/);
  assert.match(INTAKE_SCRIPT,
    /postMessage\(\{ type: 'attachmentClear', index: Number\(clearAttachment\.dataset\.attachmentClear\) \}\)/);
  assert.match(INTAKE_SCRIPT, /postMessage\(\{ type: 'enhanceDescription' \}\)/);
  assert.match(INTAKE_SCRIPT, /postMessage\(\{ type: 'enhanceApply' \}\)/);
  assert.match(INTAKE_SCRIPT, /postMessage\(\{ type: 'enhanceDiscard' \}\)/);
  assert.doesNotMatch(INTAKE_SCRIPT, /sourcePath|fsPath/);
});

test('all Story start variants carry the four selected documents in slot order', () => {
  const storyAttachments = Array.from({ length: 4 }, (_, index) => ({
    sourcePath: `/source/document-${index + 1}.md`, displayName: `document-${index + 1}.md`,
    name: `  Source   document ${index + 1} `
  }));
  const expected = storyAttachments.flatMap((entry, index) => [
    '--document', entry.sourcePath, '--document-name', `Source document ${index + 1}`
  ]);
  const choices = {
    storyWorkflows: [{ id: 'feature', label: 'Feature', description: '', phases: ['intake'] }],
    workType: 'feature', baseBranch: 'main', basePreflightPassed: true
  };
  const manual = intakeCommand(story({ ...choices, storyAttachments }));
  const jira = intakeCommand(story({
    ...choices, storyAttachments, tracker: 'jira', jiraConfigured: true, key: 'ENG-42'
  }));
  const github = intakeCommand(story({
    ...choices, storyAttachments, tracker: 'github', key: 'owner/repository#42'
  }));
  for (const args of [manual, jira, github]) {
    assert.deepEqual(args.slice(-expected.length), expected);
  }
});

test('manual Story enhancement is review-only and exposes progress and errors', () => {
  const ready = intakeHtml(story());
  assert.match(ready, /data-enhance-description>\s*Enhance with Copilot/);
  assert.match(ready, /Your draft stays unchanged until you apply it/);
  assert.doesNotMatch(intakeHtml(story({ tracker: 'jira' })), /data-enhance-description/);
  assert.match(intakeHtml(story({ description: '' })), /data-enhance-description disabled/);

  const enhancing = intakeHtml(story({ enhancing: true }));
  assert.match(enhancing, /data-enhance-description disabled aria-busy="true"/);
  assert.match(enhancing, /role="status" aria-live="polite"/);
  assert.match(enhancing, /data-submit="start" disabled/);
  assert.match(intakeHtml(story({ enhanceError: 'No proposal was returned.' })),
    /role="alert">No proposal was returned/);
  const proposal = intakeHtml(story({ enhanceProposal: 'A clearer proposed Story.' }));
  assert.match(proposal, /data-enhancement-proposal/);
  assert.match(proposal, /A clearer proposed Story/);
  assert.match(proposal, /data-enhance-apply>Apply proposal/);
  assert.match(proposal, /data-enhance-discard>Discard/);
  assert.match(proposal, /Ground the Story in its source material/,
    'the authored draft remains present beside the proposal');
});

test('the intake host owns file selection and bounds the attachment list', async () => {
  const panel = await readFile(source('intake-panel.ts'), 'utf8');
  for (const message of [
    'attachmentPick', 'attachmentsPick', 'attachmentClear', 'attachmentName', 'attachmentNameDraft',
    'attachmentStore', 'attachmentPhases', 'enhanceDescription', 'enhanceApply', 'enhanceDiscard'
  ]) {
    assert.match(panel, new RegExp(`${message}:`));
  }
  assert.match(panel, /showOpenDialog\(\{/);
  assert.match(panel, /canSelectMany: replaceIndex === null/);
  assert.match(panel, /sourcePath: uri\.fsPath/);
  assert.match(panel, /integerField\(message, 'index'\)/);
  assert.doesNotMatch(panel, /stringField\(message, ['"](?:sourcePath|path)['"]\)/);
  assert.match(panel, /runWithInput<[^]*\(\['story', 'enhance-description', '--draft-stdin', '--json'\], JSON\.stringify\(\{/);
  assert.match(panel, /\}\), controller\.signal\)/);
  assert.match(panel, /attachments: this\.form\.storyAttachments\.flatMap/);
  assert.match(panel, /result\.status === 'proposed'/);
  assert.match(panel, /enhanceProposal: proposed/);
  assert.doesNotMatch(panel, /description: proposed/);
  assert.match(panel, /private enhancementController: AbortController \| null = null/);
  assert.match(panel, /private invalidateEnhancement\(\): void/);
  assert.match(panel, /active\.abort\(\)/);
  assert.match(panel, /showWarningMessage\(messages\.join\(' '\)\)/);
  assert.doesNotMatch(panel, /The Story changed while Copilot was responding/);

  const full = intakeHtml(story({
    storyAttachments: Array.from({ length: MAX_STORY_ATTACHMENT_SLOTS }, (_, index) => ({
      sourcePath: `/source/${index}.md`, displayName: `${index}.md`
    }))
  }));
  assert.match(full, /data-attachments-pick disabled/);
  assert.doesNotMatch(full, /data-attachment-add/);
});
