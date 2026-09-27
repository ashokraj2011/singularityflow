import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SharedWorkflowDraftController } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-model.ts'));
const { sharedWorkflowDraftsHtml } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-page.ts'));
const { prepareWorkflowDraftChange } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-guide.ts'));
const repository = path.resolve('/explicit/workflow-change-repository');
const authority = '/approved/configuration-authority.git';
const draftId = 'WFD-CHANGES1';
const baseRevision = 'a'.repeat(40);
const definitionSha256 = `sha256:${'d'.repeat(64)}`;
const phaseOrder = ['intake', 'code', 'conformance'];
const rawChoice = { id: 'original-workflow', rawDefinitionSha256: definitionSha256, phaseOrder };
const initialPayload = { schema: 'sflow-workflow-request@2', id: 'explicit-linked-copy',
  label: 'Package review', rationale: 'Human rationale remains literal.', unknown: { retained: 'decision' } };
const envelope = (payload = initialPayload) => JSON.stringify({ payload, assets: [] }, null, 2);
const record = (revision = 1) => ({ draftId, displayName: 'Exact workflow package', revision,
  lifecycleEpoch: 1, revisionSha256: `sha256:${String(revision).repeat(64)}` });
const authorResult = (action, data) => ({ resultType: 'workflow-author', status: 'read',
  operation: { id: `workflow.author.${action}`, modelPolicy: 'never' },
  capability: { repository: authority }, data });

function preview(selected = record()) {
  const approvedSource = { repository: authority, baseRevision, observedCommit: baseRevision };
  return { kind: 'workflow-authoring-package-preview', source: { repository: authority, ...selected,
    lifecycle: 'live', head: baseRevision }, approvedSource, planSha256: `sha256:${'e'.repeat(64)}`,
    findings: [], readiness: { authoring: 'valid', host: 'discovery-unverified', execution: 'not-run', confirmation: 'absent' },
    catalogChoices: { kind: 'workflow-authoring-catalog-choices', permissionEffect: 'none',
      membership: 'not-verified', hostMapping: 'not-verified', approvedSource,
      groups: [{ kind: 'workflow', total: 1, nextCursor: null, unavailable: 0, choices: [{
        ref: { source: 'catalog', kind: 'workflow', id: rawChoice.id }, label: 'Captured original',
        rawDefinitionSha256: definitionSha256, phaseOrder: [...phaseOrder] }] },
      { kind: 'phase', total: 1, nextCursor: null, unavailable: 0, choices: [{
        ref: { source: 'catalog', kind: 'phase', id: 'approved-auxiliary' }, label: 'Existing approved stage' }] }] } };
}

function fixture({ payload = initialPayload, assets = [], changePreview, previewGate } = {}) {
  const calls = []; const inputWrites = []; const copied = [];
  const runner = async (args, callRoot) => {
    calls.push({ args: [...args], root: callRoot }); assert.equal(callRoot, repository);
    const action = args[2];
    let data;
    if (action === 'list') data = { head: baseRevision, drafts: [record()], nextCursor: null };
    else if (action === 'read') data = { head: baseRevision, record: record(), payload: structuredClone(payload), assets: structuredClone(assets), tombstone: null };
    else if (action === 'preview') {
      if (previewGate) await previewGate;
      const value = preview(); changePreview?.(value); data = { preview: value };
    } else throw new Error(`Unexpected mutation or unsupported action: ${action}`);
    return { result: authorResult(action, data), error: null };
  };
  const controller = new SharedWorkflowDraftController(repository, runner,
    async (text, invoke) => { inputWrites.push(text); return invoke('/private/not-used.json'); },
    { changed() {}, confirmDiscard: async () => true,
      copyReview: async (...args) => copied.push(args) });
  const open = async () => { await controller.initialize(); await controller.receive({ type: 'open', draftId }); };
  const capturePreview = async () => controller.receive({ type: 'preview', binding: controller.view.editor.binding });
  const answer = (intent = 'edit', extra = {}) => ({ type: 'catalog-answer', binding: controller.view.editor.binding,
    choiceKind: `workflow-${intent}`, choiceId: rawChoice.id, index: 0, ...extra });
  return { controller, calls, inputWrites, copied, open, capturePreview, answer };
}
function assertNoWrite(f) {
  assert.equal(f.calls.some(({ args }) => ['create', 'save', 'submit', 'delete'].includes(args[2])), false);
  assert.deepEqual(f.inputWrites, []); assert.deepEqual(f.copied, []);
}

test('workflow edit and linked fork use server-held exact raw parent, order and approved base only', async () => {
  for (const intent of ['edit', 'fork']) {
    const f = fixture(); await f.open(); await f.capturePreview();
    await f.controller.receive(f.answer(intent));
    assert.equal(f.controller.view.error, null);
    const { payload, assets } = JSON.parse(f.controller.view.editor.inputText);
    const target = intent === 'edit' ? rawChoice.id : initialPayload.id;
    assert.deepEqual(payload.changes, [{ kind: 'workflow', id: target, operation: intent,
      ...(intent === 'fork' ? { sourceId: rawChoice.id } : {}), expectedDefinitionSha256: definitionSha256 }]);
    assert.deepEqual(payload.definitions, { workflows: [{ id: target, phases: phaseOrder }] });
    assert.equal(payload.baseRevision, baseRevision); assert.equal(payload.intent, intent);
    assert.deepEqual(payload.target, { hosts: [], governs: 'story', authority: 'selected-repository' });
    assert.equal(payload.rationale, initialPayload.rationale); assert.deepEqual(payload.unknown, initialPayload.unknown);
    assert.deepEqual(assets, []); assert.equal(f.controller.view.dirty, true);
    assert.equal(f.controller.view.preview, null); assert.match(f.controller.view.notice, /candidate request only/);
    assertNoWrite(f); f.controller.dispose();
  }
});

test('browser cannot supply raw parent digest, phase order, base or destination authority', async () => {
  for (const extra of [{ rawDefinitionSha256: `sha256:${'f'.repeat(64)}` },
    { expectedDefinitionSha256: definitionSha256 }, { phaseOrder: ['intake', 'conformance'] },
    { approvedSource: { repository: '/other.git' } }, { authority: '/other.git' }, { baseRevision: 'b'.repeat(40) }]) {
    const f = fixture(); await f.open(); await f.capturePreview(); const before = f.controller.view.editor.inputText;
    await f.controller.receive(f.answer('edit', extra));
    assert.match(f.controller.view.error, /unsupported fields/);
    assert.equal(f.controller.view.editor.inputText, before); assert.equal(f.controller.view.dirty, false);
    assertNoWrite(f); f.controller.dispose();
  }
});

test('unknown or differently typed workflow choices cannot be guessed from browser payload', async () => {
  for (const extra of [{ choiceId: 'unlisted-workflow' }, { choiceKind: 'workflow-approve' },
    { choiceKind: 'phase', choiceId: rawChoice.id }, { index: '0' }]) {
    const f = fixture(); await f.open(); await f.capturePreview(); const before = f.controller.view.editor.inputText;
    await f.controller.receive(f.answer('fork', extra));
    assert.match(f.controller.view.error, /captured catalog choice set|typed catalog reference/);
    assert.equal(f.controller.view.editor.inputText, before); assert.equal(f.controller.view.dirty, false);
    assertNoWrite(f); f.controller.dispose();
  }
});

test('catalog choice needs a current saved Preview, not a prior clean buffer or unacknowledged edit', async () => {
  const missing = fixture(); await missing.open(); const initial = missing.controller.view.editor.inputText;
  await missing.controller.receive(missing.answer());
  assert.match(missing.controller.view.error, /Refresh exact saved-revision Preview/);
  assert.equal(missing.controller.view.editor.inputText, initial); assertNoWrite(missing); missing.controller.dispose();
  const f = fixture(); await f.open(); await f.capturePreview();
  const changed = envelope({ ...initialPayload, rationale: 'New unacknowledged rationale' });
  await f.controller.receive({ type: 'change', binding: f.controller.view.editor.binding,
    name: f.controller.view.editor.name, inputText: changed });
  await f.controller.receive(f.answer('fork'));
  assert.match(f.controller.view.error, /Refresh exact saved-revision Preview/);
  assert.equal(f.controller.view.editor.inputText, changed); assert.equal(f.controller.view.dirty, true);
  assertNoWrite(f); f.controller.dispose();
});

test('reloaded editor binding refuses an older document workflow choice without changing the new buffer', async () => {
  const f = fixture(); await f.open(); await f.capturePreview(); const oldAnswer = f.answer('fork');
  await f.controller.receive({ type: 'reload', binding: f.controller.view.editor.binding });
  assert.notEqual(f.controller.view.editor.binding, oldAnswer.binding);
  await f.capturePreview(); const before = f.controller.view.editor.inputText;
  await f.controller.receive(oldAnswer);
  assert.equal(f.controller.view.editor.inputText, before); assert.equal(f.controller.view.dirty, false);
  assertNoWrite(f); f.controller.dispose();
});

test('inconsistent captured catalog authority or unavailable raw parent refuses preparation', async () => {
  for (const changePreview of [
    (value) => { value.catalogChoices.approvedSource = { ...value.approvedSource, observedCommit: 'b'.repeat(40) }; },
    (value) => { delete value.catalogChoices.groups[0].choices[0].rawDefinitionSha256; },
    (value) => { value.catalogChoices.groups[0].choices[0].rawDefinitionSha256 = 'guessed'; },
    (value) => { value.catalogChoices.groups[0].choices[0].phaseOrder = ['intake', { id: 'code' }, 'conformance']; },
    (value) => { value.catalogChoices.groups[0].choices[0].ref.source = 'candidate'; }
  ]) {
    const f = fixture({ changePreview }); await f.open(); await f.capturePreview(); const before = f.controller.view.editor.inputText;
    await f.controller.receive(f.answer());
    assert.match(f.controller.view.error, /Refresh exact saved-revision Preview|captured raw workflow parent|exact captured approved workflow|captured catalog choice set/);
    assert.equal(f.controller.view.editor.inputText, before); assert.equal(f.controller.view.dirty, false);
    assertNoWrite(f); f.controller.dispose();
  }
});

test('edit/fork stage two refuses new shared components, while captured approved phase reuse stays linked', async () => {
  for (const intent of ['edit', 'fork']) {
    const prepared = JSON.parse(prepareWorkflowDraftChange(envelope(), intent, rawChoice, baseRevision));
    const f = fixture({ payload: prepared.payload }); await f.open();
    await f.controller.receive({ type: 'stage', binding: f.controller.view.editor.binding, stage: 2 });
    const html = sharedWorkflowDraftsHtml(f.controller.view);
    assert.match(html, /Workflow-only changes reuse approved stages/); assert.doesNotMatch(html, /data-draft-action="add-stage"/);
    const before = f.controller.view.editor.inputText;
    await f.controller.receive({ type: 'add-stage', binding: f.controller.view.editor.binding });
    assert.match(f.controller.view.error, /reuses approved stages/); assert.equal(f.controller.view.editor.inputText, before);
    await f.capturePreview();
    await f.controller.receive({ type: 'catalog-answer', binding: f.controller.view.editor.binding,
      choiceKind: 'phase', choiceId: 'approved-auxiliary', index: 0 });
    assert.equal(f.controller.view.error, null);
    const payload = JSON.parse(f.controller.view.editor.inputText).payload;
    assert.deepEqual(payload.definitions.workflows[0].phases, [...phaseOrder, 'approved-auxiliary']);
    assert.deepEqual(Object.keys(payload.definitions).sort(), ['phases', 'workflows']);
    assert.deepEqual(payload.definitions.phases, [], 'reuse may retain an empty collection but creates no shared phase');
    assert.deepEqual(payload.changes, prepared.payload.changes); assertNoWrite(f); f.controller.dispose();
  }
});

test('workflow-only preparation retains incompatible existing component/assets decisions by refusing the whole edit', async () => {
  for (const options of [{ payload: { ...initialPayload, definitions: { phases: [{ id: 'handwritten-phase', label: 'Keep' }] } } },
    { payload: { ...initialPayload, bindings: { manual: { source: 'catalog', kind: 'quality-command', id: 'keep-me' } } } },
    { payload: { ...initialPayload, executionProposals: [] } }, { payload: { ...initialPayload, changes: [] } },
    { assets: [{ path: 'manual.md', contentBase64: Buffer.from('literal handwritten content').toString('base64'), bytes: 27 }] }]) {
    const f = fixture(options); await f.open(); await f.capturePreview();
    const before = f.controller.view.editor.inputText; await f.controller.receive(f.answer());
    assert.match(f.controller.view.error, /retained, not deleted/);
    assert.equal(f.controller.view.editor.inputText, before); assert.equal(f.controller.view.dirty, false);
    assertNoWrite(f); f.controller.dispose();
  }
});

test('wrong saved revision or authority Preview never installs a usable workflow choice', async () => {
  for (const changePreview of [(value) => { value.source.draftId = 'WFD-OTHER001'; },
    (value) => { value.source.revision = 2; }, (value) => { value.source.lifecycleEpoch = 2; },
    (value) => { value.source.revisionSha256 = `sha256:${'2'.repeat(64)}`; },
    (value) => { value.source.repository = '/another-authority.git'; },
    (value) => { value.approvedSource.repository = '/another-authority.git'; }]) {
    const f = fixture({ changePreview }); await f.open(); const before = f.controller.view.editor.inputText;
    await f.capturePreview();
    assert.match(f.controller.view.error, /exact retained draft revision and approved repository authority/);
    assert.equal(f.controller.view.preview, null);
    await f.controller.receive(f.answer('fork'));
    assert.match(f.controller.view.error, /Refresh exact saved-revision Preview/);
    assert.equal(f.controller.view.editor.inputText, before); assertNoWrite(f); f.controller.dispose();
  }
});

test('newer edits during Preview fence its workflow catalog instead of replacing or binding the new text', async () => {
  let release; const previewGate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ previewGate }); await f.open(); const loading = f.capturePreview();
  for (let index = 0; index < 8 && !f.calls.some(({ args }) => args[2] === 'preview'); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const newer = envelope({ ...initialPayload, description: 'Keep the immediate new edit' });
  await f.controller.receive({ type: 'change', binding: f.controller.view.editor.binding,
    name: f.controller.view.editor.name, inputText: newer }); release(); await loading;
  assert.equal(f.controller.view.preview, null); assert.match(f.controller.view.error, /New captured edits/);
  await f.controller.receive(f.answer('fork'));
  assert.match(f.controller.view.error, /Refresh exact saved-revision Preview/);
  assert.equal(f.controller.view.editor.inputText, newer); assertNoWrite(f); f.controller.dispose();
});

test('workflow impact renders literal escaped identities and preserves honest unassessed consumer scopes', async () => {
  const hostile = '<script>window.untrusted = true</script> & "literal"';
  const f = fixture({ changePreview: (value) => {
    value.simulation = { status: 'incomplete', profile: 'story-structural-lifecycle/v1', workflows: [] };
    value.workflowChanges = { status: hostile, replacements: [{ operation: hostile, id: hostile,
      sourceId: hostile, policyRelevantFields: [hostile] }], impact: { sharedDefinitions: 'unchanged',
      retainedStories: 'unchanged-not-inventoried', otherRepositories: 'unknown-not-inventoried',
      sharedDependencies: [{ kind: hostile, id: hostile, directDependents: [{ kind: hostile, id: hostile }] }] } };
  } });
  await f.open(); await f.capturePreview(); const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /Workflow edit \/ linked-copy impact/);
  assert.match(html, /&lt;script&gt;window\.untrusted = true&lt;\/script&gt; &amp; &quot;literal&quot;/);
  assert.doesNotMatch(html, /<script>|window\.untrusted = true<\/script>/);
  assert.match(html, /Selected approved configuration only/);
  assert.match(html, /Existing Story pins: unchanged-not-inventoried/);
  assert.match(html, /Other repositories: unknown-not-inventoried/);
  assert.match(html, /No approval, activation or execution is granted/);
  assertNoWrite(f); f.controller.dispose();
});

test('bounded impact summary labels omitted rows while exact Preview JSON retains every graph identity', async () => {
  const dependencies = Array.from({ length: 70 }, (_, index) => ({ kind: 'phase', id: `dependency-${index}`,
    definitionSha256, directDependents: Array.from({ length: index === 0 ? 40 : 1 }, (_, consumer) =>
      ({ kind: 'workflow', id: `consumer-${index}-${consumer}` })) }));
  const f = fixture({ changePreview: (value) => {
    value.simulation = { status: 'complete', profile: 'story-structural-lifecycle/v1', workflows: [] };
    value.workflowChanges = { status: 'ready', replacements: [{ operation: 'edit', id: rawChoice.id,
      sourceId: rawChoice.id, policyRelevantFields: ['phases'] }], graph: { nodes: dependencies, edges: [] },
      impact: { sharedDefinitions: 'unchanged', retainedStories: 'unchanged-not-inventoried',
        otherRepositories: 'unknown-not-inventoried', sharedDependencies: dependencies } };
  } });
  await f.open(); await f.capturePreview(); const html = sharedWorkflowDraftsHtml(f.controller.view);
  const impact = html.match(/<section aria-labelledby="draft-change-impact">([\s\S]*?)<\/section>/u)?.[1];
  assert.ok(impact); assert.match(impact, /summary: first 64 of 70/);
  assert.match(impact, /first 32 of 40/); assert.match(impact, /<code>dependency-63<\/code>/);
  assert.doesNotMatch(impact, /dependency-64|consumer-0-32/);
  assert.match(impact, /exact Preview JSON retains the full bounded graph and identities/);
  const literal = html.match(/<summary>Exact saved-revision Preview JSON<\/summary><pre><code>([\s\S]*?)<\/code>/u)?.[1];
  assert.ok(literal, 'a bounded table must not claim a complete JSON attachment that is absent');
  const decoded = literal.replace(/&quot;/gu, '"').replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
  const retained = JSON.parse(decoded);
  assert.deepEqual(retained, f.controller.view.preview);
  assert.equal(retained.workflowChanges.graph.nodes.length, 70);
  assert.equal(retained.workflowChanges.impact.sharedDependencies[0].directDependents.length, 40);
  assert.equal(retained.workflowChanges.graph.nodes.at(-1).id, 'dependency-69');
  assertNoWrite(f); f.controller.dispose();
});
