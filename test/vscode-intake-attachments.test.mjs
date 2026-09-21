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
  MIN_STORY_ATTACHMENT_SLOTS, intakeCommand, intakeHtml, mergeStoryAttachments
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
  assert.match(html, /opening\s+governed Git commit and push/);
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
    sourcePath: `/source/document-${index + 1}.md`, displayName: `document-${index + 1}.md`
  }));
  const expected = storyAttachments.flatMap((entry) => ['--document', entry.sourcePath]);
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
    'attachmentPick', 'attachmentsPick', 'attachmentClear', 'enhanceDescription',
    'enhanceApply', 'enhanceDiscard'
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
