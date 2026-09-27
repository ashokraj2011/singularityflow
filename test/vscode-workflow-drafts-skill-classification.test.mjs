import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { WCA_SKP_LOCAL_PRODUCER_PROFILE } from '../src/wca-skp-finalization.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SharedWorkflowDraftController } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-model.ts'));
const { sharedWorkflowDraftsHtml, SHARED_WORKFLOW_DRAFTS_SCRIPT } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-page.ts'));
const { WORKFLOW_DRAFT_SKILL_PRODUCER_PROFILE, WORKFLOW_DRAFT_GUIDE_FIELDS, addWorkflowDraftStage,
  editWorkflowDraftGuide, selectWorkflowDraftCatalog, workflowDraftSkillProducerClassification } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-guide.ts'));
const repository = path.resolve('/explicit/skill-classification-repository');
const authority = '/approved/skill-classification.git';
const draftId = 'WFD-SKPGUIDE1';
const head = 'a'.repeat(40);
const declaration = () => ({ profile: 'local-reviewed-artifact-producer/v1', eligibility: 'candidate-producer' });
function payload() {
  return { schema: 'sflow-workflow-request@2', intent: 'create', id: 'team-report', label: 'Team report',
    unknown: { preserved: true },
    definitions: { workflows: [{ id: 'team-report', phases: ['intake', 'report-phase', 'conformance'] }],
      phases: [{ id: 'report-phase', kind: 'skill', label: 'Report', agent: 'report-writer', skill: { id: 'report-skill' },
        contract: { task: 'analyze', produces: [{ id: 'report', path: 'artifacts/report-phase/report.md' }], approval: { authorities: ['reviewers'], minimum: 1 } } }],
      skills: [{ id: 'report-skill', description: 'Exact skill purpose', instructions: 'Hand-written instructions\r\n', operationBindings: [], resources: [], advanced: { preserved: 'skill' } }],
      agents: [{ id: 'report-writer', description: 'Report writer', prompt: 'Exact prompt', toolBindings: [], skillRefs: [] }], templates: [] },
    rationale: 'Literal human explanation' };
}
const envelope = (value = payload()) => JSON.stringify({ payload: value, assets: [{ path: 'references/literal.txt', content: 'Exact preserved asset\r\n' }] }, null, 2);
const record = () => ({ draftId, displayName: 'SKP guided request', revision: 1, lifecycleEpoch: 1, revisionSha256: `sha256:${'b'.repeat(64)}` });
function fixture(value = payload()) {
  const calls = []; const inputs = []; const copies = [];
  const runner = async (args, selectedRoot) => {
    calls.push([...args]); assert.equal(selectedRoot, repository);
    const action = args[2];
    const data = action === 'list' ? { head, drafts: [record()], nextCursor: null }
      : action === 'read' ? { head, record: record(), payload: structuredClone(value), assets: [], tombstone: null }
        : null;
    assert.ok(data, `Unexpected owner mutation: ${action}`);
    return { result: { resultType: 'workflow-author', status: 'read', operation: { id: `workflow.author.${action}`, modelPolicy: 'never' }, capability: { repository: authority }, data }, error: null };
  };
  const controller = new SharedWorkflowDraftController(repository, runner,
    async (text, invoke) => { inputs.push(text); return invoke('/private/must-not-be-created.json'); },
    { changed() {}, confirmDiscard: async () => true, copyReview: async (...args) => copies.push(args) });
  const open = async () => { await controller.initialize(); await controller.receive({ type: 'open', draftId }); };
  const answer = (value = WORKFLOW_DRAFT_SKILL_PRODUCER_PROFILE, extra = {}) => ({ type: 'guide-answer', binding: controller.view.editor.binding,
    field: 'skill-producer-classification', value, index: 0, ...extra });
  return { controller, calls, inputs, copies, open, answer };
}
function assertNoWrite(f) {
  assert.deepEqual(f.calls.map((args) => args[2]), ['list', 'read']); assert.deepEqual(f.inputs, []); assert.deepEqual(f.copies, []);
}

test('classification is an explicit fixed request; empty means none and all unrelated advanced fields/assets survive', () => {
  assert.equal(WORKFLOW_DRAFT_SKILL_PRODUCER_PROFILE, 'local-reviewed-artifact-producer/v1');
  assert.equal(WORKFLOW_DRAFT_SKILL_PRODUCER_PROFILE, WCA_SKP_LOCAL_PRODUCER_PROFILE, 'the UI only requests the installed compiler profile');
  assert.ok(WORKFLOW_DRAFT_GUIDE_FIELDS.includes('skill-producer-classification'));
  const initial = envelope(); const before = JSON.parse(initial);
  assert.equal(workflowDraftSkillProducerClassification(before.payload.definitions.skills[0]), '');
  const classified = JSON.parse(editWorkflowDraftGuide(initial, 'skill-producer-classification', WORKFLOW_DRAFT_SKILL_PRODUCER_PROFILE, 0));
  const expected = structuredClone(before); expected.payload.definitions.skills[0].producerClassification = declaration();
  assert.deepEqual(classified, expected);
  assert.equal(workflowDraftSkillProducerClassification(classified.payload.definitions.skills[0]), WORKFLOW_DRAFT_SKILL_PRODUCER_PROFILE);
  const removed = JSON.parse(editWorkflowDraftGuide(JSON.stringify(classified), 'skill-producer-classification', '', 0));
  assert.deepEqual(removed, before);
  assert.deepEqual(JSON.parse(editWorkflowDraftGuide(initial, 'skill-producer-classification', '', 0)), before);
  for (const value of ['candidate-producer', 'true', 'approved', 'local-reviewed-source-producer/v1']) {
    assert.throws(() => editWorkflowDraftGuide(initial, 'skill-producer-classification', value, 0), /exact artifact-only terminal-review request.*never grants eligibility/);
  }
});

test('unknown advanced producer declarations cannot be silently replaced or cleared by a guide action', () => {
  for (const advanced of [null, true, 'candidate-producer', { profile: 'enterprise-producer/v2', eligibility: 'candidate-producer' },
    { ...declaration(), host: 'native' }, { ...declaration(), eligibility: 'approved-producer' }, ['candidate-producer']]) {
    const value = payload(); value.definitions.skills[0].producerClassification = advanced;
    const original = envelope(value); assert.equal(workflowDraftSkillProducerClassification(value.definitions.skills[0]), null);
    for (const selected of ['', WORKFLOW_DRAFT_SKILL_PRODUCER_PROFILE]) {
      assert.throws(() => editWorkflowDraftGuide(original, 'skill-producer-classification', selected, 0), /retained unchanged.*advanced JSON/);
      assert.equal(original, envelope(value));
    }
  }
});

test('adding a candidate stage never selects producer classification or creates an SKP contract implicitly', () => {
  const created = JSON.parse(addWorkflowDraftStage(' {"payload":{"id":"manual-package"},"assets":[]} ', 'manual-package'));
  const skill = created.payload.definitions.skills[0]; const phase = created.payload.definitions.phases[0];
  assert.equal(Object.hasOwn(skill, 'producerClassification'), false); assert.equal(Object.hasOwn(phase, 'kind'), false);
  assert.equal(Object.hasOwn(phase, 'contract'), false); assert.equal(workflowDraftSkillProducerClassification(skill), '');
});

test('SKP raw contracts remain advanced-only; ordinary guide and catalog fields cannot compete with them', () => {
  const original = envelope(); const before = JSON.parse(original);
  for (const field of ['phase-inputs', 'phase-review', 'phase-write-scope', 'phase-artifact-path', 'phase-artifact-kind', 'phase-artifact-minimum', 'phase-artifact-maximum']) {
    assert.throws(() => editWorkflowDraftGuide(original, field, 'artifact-only', 0), /advanced JSON.*No competing ordinary-phase field/);
  }
  for (const kind of ['template', 'execution-task', 'quality-command', 'approval-authority']) {
    assert.throws(() => selectWorkflowDraftCatalog(original, kind, 'captured-choice', 0), /advanced JSON.*No ordinary-phase catalog field/);
  }
  const renamed = JSON.parse(editWorkflowDraftGuide(original, 'phase-label', 'Human-selected label', 0));
  assert.deepEqual(renamed.payload.definitions.phases[0].contract, before.payload.definitions.phases[0].contract);
  const agent = JSON.parse(selectWorkflowDraftCatalog(original, 'agent', 'captured-agent', 0));
  assert.deepEqual(agent.payload.definitions.phases[0].agent, { ref: { source: 'catalog', kind: 'agent', id: 'captured-agent' } });
  assert.deepEqual(agent.payload.definitions.phases[0].contract, before.payload.definitions.phases[0].contract);
});

test('existing controller captures declaration as dirty scoped text, with no save/consent/proposal/execution', async () => {
  const f = fixture(); await f.open(); const base = f.controller.view.editor.inputText;
  const binding = f.controller.view.editor.binding; const retainedHead = f.controller.view.editor.head;
  await f.controller.receive(f.answer());
  assert.equal(f.controller.view.error, null); assert.equal(f.controller.view.dirty, true);
  assert.equal(f.controller.view.editor.binding, binding); assert.equal(f.controller.view.editor.head, retainedHead);
  const updated = JSON.parse(f.controller.view.editor.inputText);
  assert.deepEqual(updated.payload.definitions.skills[0].producerClassification, declaration());
  delete updated.payload.definitions.skills[0].producerClassification; assert.deepEqual(updated, JSON.parse(base));
  assertNoWrite(f); f.controller.dispose();
});

test('busy/read-only/stale-binding and forged authority/approval input retain the current declaration and scope', async () => {
  for (const mode of ['busy', 'readonly', 'stale', 'authority', 'receipt', 'boolean']) {
    const f = fixture(); await f.open(); const before = f.controller.view.editor.inputText;
    const message = f.answer();
    if (mode === 'busy') f.controller.view.busy = true;
    if (mode === 'readonly') f.controller.view.editor.readOnlyReason = 'Exact read-only retained revision';
    if (mode === 'stale') message.binding = 'old-editor-binding';
    if (mode === 'authority') message.authority = '/other/destination.git';
    if (mode === 'receipt') message.confirmed = true;
    if (mode === 'boolean') message.value = true;
    await f.controller.receive(message);
    assert.equal(f.controller.view.editor.inputText, before); assert.equal(f.controller.view.dirty, false);
    assert.equal(f.controller.view.editor.authority, authority); assert.equal(f.controller.view.editor.head, head);
    assertNoWrite(f); f.controller.dispose();
  }
  const value = payload(); value.definitions.skills[0].producerClassification = { profile: 'future-profile', eligibility: 'candidate-producer' };
  const f = fixture(value); await f.open(); const before = f.controller.view.editor.inputText;
  await f.controller.receive(f.answer()); assert.match(f.controller.view.error, /retained unchanged/);
  assert.equal(f.controller.view.editor.inputText, before); assertNoWrite(f); f.controller.dispose();
});

test('Team & skills displays explicit none/named choice, preserves unknown values, and escapes all untrusted labels', async () => {
  const f = fixture(); await f.open(); f.controller.view.stage = 3;
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  const select = html.match(/<select id="guide-skill-producer-classification-0"[^>]*>([\s\S]*?)<\/select>/u)?.[1]; assert.ok(select);
  assert.match(select, /<option value="" selected>None/); assert.doesNotMatch(select, /artifact-producer\/v1" selected/);
  assert.match(html, /data-guide-field="skill-producer-classification"/); assert.match(html, /This records a request.*grants no eligibility, tools, source effects or execution/);
  await f.controller.receive(f.answer());
  assert.match(sharedWorkflowDraftsHtml(f.controller.view), /artifact-producer\/v1" selected>Request artifact-only/);
  f.controller.view.stage = 2;
  const stages = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(stages, /raw input, output, task, access and review contracts use advanced JSON only/);
  assert.doesNotMatch(stages, /data-guide-field="phase-inputs"|data-guide-field="phase-artifact-/);
  f.controller.view.stage = 4;
  assert.doesNotMatch(sharedWorkflowDraftsHtml(f.controller.view), /data-guide-field="phase-review"|data-choice-kind="quality-command"/);
  f.controller.dispose();
  const value = payload(); value.definitions.skills[0].id = '</summary><img src=x onerror=bad()>'; value.definitions.skills[0].producerClassification = { profile: '<script>bad()</script>', eligibility: 'candidate-producer' };
  const unknown = fixture(value); await unknown.open(); unknown.controller.view.stage = 3;
  const retained = sharedWorkflowDraftsHtml(unknown.controller.view);
  assert.match(retained, /data-guide-unsupported="true" disabled/); assert.match(retained, /Advanced classification retained/);
  assert.doesNotMatch(retained, /<img src=|<script>bad|onerror=bad\(\)>/);
  assert.match(retained, /&lt;\/summary&gt;&lt;img/); assertNoWrite(unknown); unknown.controller.dispose();
});

test('actual browser script sends only bounded literal choice plus current DOM capture, and never enables unsupported or readonly controls', () => {
  const posted = []; const handlers = {}; const hostHandlers = {};
  const fields = { 'draft-binding': { value: 'exact-binding' }, 'draft-name': { value: 'Current name' },
    'draft-input': { value: envelope() }, 'draft-input-error': { textContent: '', hidden: true },
    'guide-skill-producer-classification-0': { value: WORKFLOW_DRAFT_SKILL_PRODUCER_PROFILE } };
  class Element { closest() { return this; } }
  class HTMLButtonElement extends Element {
    constructor(unsupported = false) { super(); this.disabled = false; this.dataset = { draftAction: 'guide-answer', guideField: 'skill-producer-classification',
      guideInput: 'guide-skill-producer-classification-0', guideIndex: '0', ...(unsupported ? { guideUnsupported: 'true' } : {}) }; }
  }
  const ordinary = new HTMLButtonElement(); const unsupported = new HTMLButtonElement(true);
  runInNewContext(SHARED_WORKFLOW_DRAFTS_SCRIPT, { window: { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener: (type, handler) => { hostHandlers[type] = handler; } },
    document: { getElementById: (id) => fields[id], addEventListener: (type, handler) => { handlers[type] = handler; }, querySelectorAll: () => [ordinary, unsupported] }, Element, HTMLButtonElement, TextEncoder });
  handlers.click({ target: ordinary });
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0])), { type: 'guide-answer', binding: 'exact-binding', name: 'Current name', inputText: fields['draft-input'].value,
    index: 0, field: 'skill-producer-classification', value: WORKFLOW_DRAFT_SKILL_PRODUCER_PROFILE });
  fields['guide-skill-producer-classification-0'].value = ''; handlers.click({ target: ordinary }); assert.equal(posted.at(-1).value, '');
  fields['guide-skill-producer-classification-0'].value = 'x'.repeat(128 * 1024 + 1); handlers.click({ target: ordinary }); assert.equal(posted.length, 2);
  assert.match(fields['draft-input-error'].textContent, /not been applied or sent/);
  hostHandlers.message({ data: { type: 'draft-status', binding: 'exact-binding', busy: false, readOnly: false } });
  assert.equal(ordinary.disabled, false); assert.equal(unsupported.disabled, true);
  hostHandlers.message({ data: { type: 'draft-status', binding: 'exact-binding', busy: false, readOnly: true } }); assert.equal(ordinary.disabled, true);
  hostHandlers.message({ data: { type: 'draft-status', binding: 'exact-binding', busy: true, readOnly: false } }); assert.equal(ordinary.disabled, true);
});

test('Submit guidance is copy-only exact terminal review of classification/contracts, never imported execution', async () => {
  const f = fixture(); await f.open(); f.controller.view.stage = 6;
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /buttons copy review routes only/); assert.match(html, /reviews explicit producer classification, exact package bytes and SKP contracts/);
  assert.match(html, /inactive review proposal, not approval or imported-skill execution/); assert.match(html, /Headless Copilot cannot mint consent/);
  assert.match(html, /data-draft-action="submit-review"/); assert.doesNotMatch(html, /data-draft-action="approve"|data-draft-action="execute"|data-draft-action="confirm-classification"/);
  assertNoWrite(f); f.controller.dispose();
});
