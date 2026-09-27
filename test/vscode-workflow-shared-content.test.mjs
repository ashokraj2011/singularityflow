import assert from 'node:assert/strict';
import test from 'node:test';
import { editWorkflowDraftGuide, selectWorkflowDraftCatalog, reorderWorkflowDraftStage,
  workflowDraftSharedObjectKind } from '../apps/vscode/src/views/workflow-drafts-guide.ts';
import { sharedWorkflowDraftsHtml } from '../apps/vscode/src/views/workflow-drafts-page.ts';

const sha = `sha256:${'a'.repeat(64)}`;
function envelope(kind = 'agent') {
  return { payload: { schema: 'sflow-workflow-request@2', intent: 'edit', id: 'edit-role',
    changes: [{ profile: kind === 'agent' ? 'wca-shared-agent-text-impact/v1' : 'wca-shared-template-content-impact/v1',
      kind, id: kind === 'agent' ? 'writer' : 'template:note', operation: 'edit', expectedTextSha256: sha }],
    definitions: kind === 'agent' ? { agents: [{ id: 'writer', text: '---\r\nname: writer\r\n---\r\nOriginal prose\r\n' }] }
      : { templates: [{ id: 'template:note', content: '# Notes\nOriginal\n' }] },
    untouched: { literal: 'retain' } }, assets: [] };
}
function view(input, stage = 3, preview = null) {
  return { repository: '/exact/repository', authority: '/exact/authority.git', drafts: [], listHead: null,
    editor: { inputText: JSON.stringify(input), record: { draftId: 'WFD-test', revision: 1, lifecycleEpoch: 1,
      revisionSha256: sha }, authority: '/exact/authority.git', name: 'Edit', binding: 'exact', head: 'head', readOnlyReason: null },
    busy: false, dirty: false, error: null, notice: null, show: null, preview, operationId: null, stage,
    autosave: false, durability: 'shared', recovery: { status: 'none', candidateAvailable: false, restoreAllowed: false } };
}

test('shared Agent Markdown guide changes only requested literal text, preserving exact parent and unrelated data', () => {
  const input = envelope(); const original = JSON.stringify(input);
  const edited = JSON.parse(editWorkflowDraftGuide(original, 'shared-agent-text', '---\r\nname: writer\r\n---\r\nBetter prose\r\n'));
  assert.equal(edited.payload.definitions.agents[0].text, '---\r\nname: writer\r\n---\r\nBetter prose\r\n');
  assert.deepEqual(edited.payload.changes, input.payload.changes);
  assert.deepEqual(edited.payload.untouched, input.payload.untouched);
  assert.deepEqual(edited.assets, input.assets);
  assert.equal(edited.payload.definitions.agents[0].prompt, undefined);
  for (const field of ['agent-prompt', 'agent-tools', 'agent-description', 'phase-inputs', 'label']) {
    assert.throws(() => editWorkflowDraftGuide(original, field, 'changed'), /exact-parent shared-object/u);
  }
  assert.throws(() => selectWorkflowDraftCatalog(original, 'agent', 'another', 0), /cannot add or replace catalog bindings/u);
  assert.throws(() => reorderWorkflowDraftStage(original, 0, 1), /cannot reorder/u);
  const ordinary = { payload: { definitions: { agents: [{ id: 'writer', prompt: 'candidate' }] } }, assets: [] };
  assert.throws(() => editWorkflowDraftGuide(JSON.stringify(ordinary), 'shared-agent-text', 'source'), /exact existing-agent/u);
});

test('browser-normalized CRLF answers preserve captured metadata/resource-table bytes; mixed sources require advanced JSON', () => {
  const input = envelope();
  const source = '---\r\nname: writer\r\n---\r\nProse\r\n| Resource | Source |\r\n|---|---|\r\n| retained | fixed |\r\n';
  input.payload.definitions.agents[0].text = source;
  const browserValue = source.replace(/\r\n/gu, '\n').replace('Prose', 'Updated prose');
  const edited = JSON.parse(editWorkflowDraftGuide(JSON.stringify(input), 'shared-agent-text', browserValue));
  assert.equal(edited.payload.definitions.agents[0].text, source.replace('Prose', 'Updated prose'));
  assert.deepEqual(edited.payload.changes, input.payload.changes);
  input.payload.definitions.agents[0].text = source.replace('Prose\r\n', 'Prose\n');
  const original = JSON.stringify(input);
  assert.throws(() => editWorkflowDraftGuide(original, 'shared-agent-text', browserValue), /Mixed or bare-CR/u);
  const html = sharedWorkflowDraftsHtml(view(input));
  assert.match(html, /escaped advanced JSON/u);
  assert.doesNotMatch(html, /data-guide-field="shared-agent-text"/u);
});

test('shared template guide preserves path identities and metadata while unsupported/mixed profiles cannot silently become candidates', () => {
  const input = envelope('template');
  const edited = JSON.parse(editWorkflowDraftGuide(JSON.stringify(input), 'template-content', '# Notes\nBetter\n'));
  assert.equal(edited.payload.definitions.templates[0].content, '# Notes\nBetter\n');
  assert.deepEqual(edited.payload.changes, input.payload.changes);
  assert.deepEqual(edited.payload.untouched, input.payload.untouched);
  input.payload.changes.push(envelope().payload.changes[0]);
  assert.equal(workflowDraftSharedObjectKind(input.payload), 'unsupported');
  assert.throws(() => editWorkflowDraftGuide(JSON.stringify(input), 'template-content', 'replace'), /exact-parent shared-object/u);
  const html = sharedWorkflowDraftsHtml(view(input));
  assert.match(html, /Unsupported or mixed shared-object profile retained/u);
  assert.doesNotMatch(html, /data-guide-field="(?:agent-tools|shared-agent-text|template-content)"/u);
});

test('shared guide exposes only supported literal content and existing copy-only review actions', () => {
  const html = sharedWorkflowDraftsHtml(view(envelope()));
  assert.match(html, /data-guide-field="shared-agent-text"/u);
  assert.match(html, /Preserve exact frontmatter and remote resource declarations/u);
  assert.doesNotMatch(html, /data-guide-field="(?:agent-prompt|agent-tools|agent-description)"/u);
  const submitting = view(envelope(), 6);
  const submitHtml = sharedWorkflowDraftsHtml(submitting);
  assert.match(submitHtml, /data-draft-action="submit-review"/u);
  assert.match(submitHtml, /data-draft-action="copilot-submit-review"/u);
  assert.doesNotMatch(submitHtml, /data-draft-action="(?:activate|approve|terminal-submit|copilot-submit)"/u);
  submitting.recovery.candidateAvailable = true;
  assert.match(sharedWorkflowDraftsHtml(submitting), /data-draft-action="submit-review" disabled/u);
});

test('shared impact table discloses consumers, masked overrides and incomplete inventory without granting execution', () => {
  const preview = { sharedObjectChanges: { profile: 'wca-shared-phase-impact/v1', status: 'ready-for-review',
    replacements: [{ kind: 'phase', id: '<note>', expectedDefinitionSha256: sha, changedFields: ['label'] }],
    impact: { retainedStories: 'unchanged-not-inventoried', otherRepositories: 'unknown-not-inventoried',
      consumers: [{ kind: 'agent', id: '<writer>', relation: 'transitive' }],
      affectedWorkflows: [{ id: 'team-note', status: 'effective-phase-unchanged', effectivePhases: [{ id: 'note',
        status: 'unchanged-effective-phase', overrideFields: ['label'], templateOverride: true }] }],
      excluded: ['retained-story-inventory', 'host-qualification'] } } };
  const html = sharedWorkflowDraftsHtml(view(envelope(), 5, preview));
  assert.match(html, /Shared object change impact · ready-for-review/u);
  assert.match(html, /&lt;note&gt;/u); assert.match(html, /&lt;writer&gt;/u);
  assert.match(html, /unchanged-effective-phase/u); assert.match(html, /template override: yes/u);
  assert.match(html, /Existing Story pins: unchanged-not-inventoried/u);
  assert.match(html, /Other repositories: unknown-not-inventoried/u);
  assert.match(html, /Eligibility is not execution/u);
  assert.doesNotMatch(html, /<note>|<writer>/u);
});

test('bounded shared impact summaries retain the complete exact report and disclose omitted rows', () => {
  const consumers = Array.from({ length: 65 }, (_, index) => ({ kind: 'agent', id: `consumer-${index}`, relation: 'direct' }));
  const preview = { sharedObjectChanges: { profile: 'wca-shared-agent-text-impact/v1', status: 'ready-for-review',
    replacements: [], impact: { consumers, affectedWorkflows: [], excluded: [] } } };
  const html = sharedWorkflowDraftsHtml(view(envelope(), 5, preview));
  assert.match(html, /Consumers: first 64 of 65/u);
  assert.equal((html.match(/<code>consumer-/gu) ?? []).length, 64);
  // lifecycleSimulationHtml returns early for legacy reports; exact raw JSON must still be visible.
  assert.match(html, /consumer-64/u);
});
