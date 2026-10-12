import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { CATALOG_SEARCH_SCRIPT, workflowFavourites } from '../apps/vscode/src/views/catalog-search.ts';
import { WORKFLOW_STUDIO_SCRIPT, workflowStudioBody } from '../apps/vscode/src/views/workflow-studio-page.ts';
import { INSTRUCTION_DESIGNER_SCRIPT, instructionDesignerHtml } from '../apps/vscode/src/views/instruction-designer-page.ts';
import { instructionCatalog, parseAgent } from '../apps/vscode/src/views/instruction-designer-model.ts';

// Exercise the real webview controls, including their event handlers, without a second search implementation.
function dom() {
  const document = { activeElement: null, getElementById: () => null };
  document.createElement = (tag) => ({
    tag, children: [], attributes: {}, style: {}, listeners: {}, hidden: false, value: '',
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key] ?? null; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    focus() { document.activeElement = this; }
  });
  document.createTextNode = (text) => ({ textContent: text, children: [] });
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
  return document;
}
const all = (node) => [node, ...(node.children || []).flatMap(all)];
const text = (node) => [node.textContent || '', ...(node.children || []).map(text)].join(' ').trim();
const byId = (node, id) => all(node).find((child) => child.attributes?.id === id);
const click = (node) => node.listeners.click({ target: node });
function type(node, value) { node.value = value; node.focus(); node.listeners.input({ target: node }); }
function fixture() {
  const phase = (id, agent = 'builtin') => ({ id, label: id, agent, output: 'document', views: [], inputs: [], approval: { mode: 'none' } });
  const workflow = (id, readOnly) => ({ id, label: id === 'seed' ? 'Seeded delivery' : 'Team café delivery', description: 'Test and repair', readOnly,
    phases: ['intake', 'test'], steps: [phase('intake'), phase('test')],
    reworkLoops: [{ from: 'test', to: 'intake', maxAttempts: 3 }],
    decisions: [{ id: 'quality', after: 'test', kind: 'ask', label: 'Screenshot passes?', routes: [{ id: 'yes', label: 'Pass', to: 'finish' }, { id: 'no', label: 'Repair', to: 'intake' }] }],
    skills: [{ id: 'workflow-skill', phases: ['test'], use: 'Only this workflow' }] });
  const model = { workflows: [workflow('seed', true), workflow('team', false)], phases: [phase('intake'), phase('test')],
    agents: [{ id: 'builtin', label: 'Built-in reviewer', description: 'Independent visual reviewer', scope: 'package', tools: ['read'], views: [], instructions: 'Review only. <script>never execute</script>', prompt: 'Review only. <script>never execute</script>\n## Attached skills\nSaved table',
      skills: [{ id: 'agent-skill', phases: [], use: 'Every phase' }, { id: 'other-phase-skill', phases: ['elsewhere'] }] },
      { id: 'custom', label: 'Team builder', description: 'Creates code', scope: 'repository', tools: [], views: [], instructions: 'Build café pages.', skills: [] }],
    groups: [], templates: [], artifactSets: [], epics: null,
    skills: [
      { id: 'agent-skill', label: 'Agent skill', description: 'Visual inspection', instructions: 'Inspect browser colours.', instructionRefs: ['visual-guide'] },
      { id: 'workflow-skill', label: 'Workflow skill', description: 'Test this workflow', instructions: 'Run only here.', instructionRefs: [] },
      { id: 'other-phase-skill', label: 'Other phase skill', description: 'Not in test', instructions: 'Do not show in this test phase.', instructionRefs: [] }
    ], instructions: [{ id: 'visual-guide', label: 'Visual guide', description: 'Screenshots', instructions: 'Preserve keyboard accessibility.' }],
    choices: { roles: [], tools: [{ id: 'read', label: 'Read files' }], outputs: [{ id: 'document', label: 'Document' }], views: [] },
    protection: { workflows: ['seed'], agents: ['builtin'], phases: [], skills: [], instructions: [] } };
  const document = dom(); const posted = [];
  const window = { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener() {} };
  new Function('window', 'document', WORKFLOW_STUDIO_SCRIPT)(window, document);
  const logic = window.__workflowStudio;
  Object.assign(logic.state(), { model, draft: logic.initialDraft(model), workflow: 'seed' });
  return { logic, model, document, posted, main: () => document.createElement('main') };
}

test('catalog search is case-insensitive, Unicode-normalized, literal and multi-term', () => {
  const api = runInNewContext(CATALOG_SEARCH_SCRIPT + ';({catalogMatches})');
  assert.equal(api.catalogMatches(' CAFÉ team ', ['Team café delivery']), true);
  assert.equal(api.catalogMatches('cafe\u0301', ['café']), true);
  assert.equal(api.catalogMatches('.*', ['ordinary name']), false);
  assert.equal(api.catalogMatches('<script>', ['<script> text']), true);
  assert.equal(api.catalogMatches('team absent', ['team']), false);
});

test('workflow favourites reject invalid preference data and deduplicate stable IDs', () => {
  assert.deepEqual(workflowFavourites(null), []);
  assert.deepEqual(workflowFavourites(['feature', 'feature', null, '../bad', '<script>', 'demo-test']), ['feature', 'demo-test']);
  assert.equal(workflowFavourites(Array.from({ length: 500 }, (_, i) => 'demo-' + i)).length, 200);
});

test('workflow catalog filters rules, preserves draft and query, and labels seeded versus editable workflows', () => {
  const f = fixture(); const main = f.main();
  f.logic.renderHome(main);
  const cards = all(main).filter((node) => node.attributes?.['data-workflow-card']);
  assert.equal(cards.length, 2);
  assert.match(cards[0].className, /workflow-seeded/);
  assert.match(text(cards[0]), /Seeded · read-only/);
  assert.match(cards[1].className, /workflow-editable/);
  assert.match(text(cards[1]), /Editable/);
  const search = byId(main, 'catalog-search-workflows');
  type(search, 'screenshot'); assert.ok(cards.every((node) => !node.hidden), 'routing rules are searchable');
  type(search, 'CAFE\u0301'); assert.equal(cards[0].hidden, true); assert.equal(cards[1].hidden, false);
  assert.equal(byId(main, 'catalog-search-workflows-count').textContent, '1 of 2 shown');
  const reopened = f.main(); f.logic.renderHome(reopened);
  assert.equal(byId(reopened, 'catalog-search-workflows').value, 'CAFE\u0301');
  click(all(main).find((node) => node.tag === 'button' && text(node) === 'Clear search'));
  assert.ok(cards.every((node) => !node.hidden));
  assert.deepEqual(f.posted, []);
  assert.deepEqual(f.logic.changeSetFrom(f.model, f.logic.state().draft).changes, []);
});

test('agents, skills and instructions filter body text locally and expose no-results/clear controls', () => {
  for (const [render, key, query, selector, expected] of [
    ['renderAgents', 'agents', 'CAFÉ', 'data-agent-card', 'custom'],
    ['renderSkills', 'skills', 'colours', 'aria-label', 'Skill Agent skill'],
    ['renderInstructions', 'instructions', 'keyboard', 'data-instruction-card', 'visual-guide']
  ]) {
    const f = fixture(); const main = f.main(); f.logic[render](main);
    const input = byId(main, 'catalog-search-' + key);
    type(input, query);
    const cards = all(main).filter((node) => node.tag === 'article' && node.attributes?.[selector]);
    assert.equal(cards.filter((node) => !node.hidden).length, 1, key);
    assert.equal(cards.find((node) => !node.hidden).attributes[selector], expected);
    type(input, 'no-such-item'); assert.ok(cards.every((node) => node.hidden));
    assert.equal(byId(main, 'catalog-search-' + key + '-count').textContent, '0 of ' + cards.length + ' shown');
    assert.equal(all(main).find((node) => text(node) === 'No matches. Try another search or clear it.').hidden, false);
    click(all(main).find((node) => node.tag === 'button' && text(node) === 'Clear search'));
    assert.ok(cards.every((node) => !node.hidden)); assert.equal(f.document.activeElement, input);
    assert.deepEqual(f.posted, []); assert.deepEqual(f.logic.changeSetFrom(f.model, f.logic.state().draft).changes, []);
  }
});

test('built-in prompts and referenced instructions are visible read-only on agent cards and both canvas types', () => {
  const f = fixture(); const cards = f.main(); f.logic.renderAgents(cards);
  const preview = f.logic.agentPromptPreview('builtin', 'test', 'seed');
  assert.match(text(cards), /View prompt & instructions — Built-in reviewer/);
  assert.match(text(preview), /Saved table/);
  assert.match(text(preview), /Preserve keyboard accessibility/);
  assert.match(text(preview), /Workflow skill: Workflow skill/);
  assert.doesNotMatch(text(preview), /Do not show in this test phase/);
  assert.ok(all(preview).some((node) => node.tag === 'pre' && node.textContent.includes('<script>')));
  assert.ok(!all(preview).some((node) => ['script', 'textarea', 'input'].includes(node.tag)));
  assert.match(text(f.logic.renderReadOnlyStep('seed', 'test')), /Saved table/);
  f.logic.state().workflow = 'team';
  assert.match(text(f.logic.renderInspector('team', 'test')), /Saved table/);
  const before = JSON.stringify(f.logic.state().draft);
  f.logic.agentPromptPreview('builtin'); assert.equal(JSON.stringify(f.logic.state().draft), before);
  f.logic.state().draft.agents.builtin.instructions = 'Edited draft prompt';
  assert.match(text(f.logic.agentPromptPreview('builtin')), /Edited draft prompt/);
  assert.doesNotMatch(text(f.logic.agentPromptPreview('builtin')), /Saved table/, 'no stale saved prompt after a draft edit');
});

test('canvas rules have an independent local search with decision and send-back routes', () => {
  const f = fixture(); f.logic.state().sections['ro-workflow-rules'] = true;
  const canvas = f.logic.renderReadOnlyStep('seed', 'test');
  const input = byId(canvas, 'catalog-search-rules-seed');
  assert.ok(input); type(input, 'screenshot');
  assert.equal(byId(canvas, 'catalog-search-rules-seed-count').textContent, '1 of 2 shown');
  assert.deepEqual(f.posted, []);
  assert.deepEqual(f.logic.changeSetFrom(f.model, f.logic.state().draft).changes, []);
  assert.match(workflowStudioBody('nonce'), /workflow-seeded.*vscode-charts-blue/s, 'theme-aware colour and a textual origin label');
});

test('initiative canvases show applicable agent prompts without leaking Story workflow skills', () => {
  const f = fixture(); const state = f.logic.state();
  const workflow = { id: 'initiative', label: 'Initiative', phases: ['test'] };
  const step = { id: 'test', label: 'Review', agents: ['builtin'], lanes: [], outputs: [], local: true,
    approval: { on: false, groups: [], minimum: 1 } };
  state.draft.epics = { workflows: { initiative: workflow }, steps: { test: step } };
  f.model.protection.epicPhases = ['test'];
  for (const card of [f.logic.renderEpicStep(workflow, step), (() => {
    const main = f.main(); f.logic.renderSeededWorkflow(main, workflow, 'initiative'); return main;
  })()]) {
    assert.match(text(card), /Saved table/);
    assert.match(text(card), /Preserve keyboard accessibility/);
    assert.doesNotMatch(text(card), /Workflow skill: Workflow skill/);
    assert.doesNotMatch(text(card), /Do not show in this test phase/);
  }
  step.local = false;
  assert.match(text(f.logic.renderEpicStep(workflow, step)), /Saved table/, 'protected shared steps still expose prompt text');
  workflow.localSteps = { test: { ...step, agents: ['custom'] } };
  const overridden = f.main(); f.logic.renderSeededWorkflow(overridden, workflow, 'initiative');
  assert.match(text(overridden), /Build café pages/);
  assert.doesNotMatch(text(overridden), /Saved table/, 'the viewer follows workflow-local agent bindings');
  assert.deepEqual(f.posted, []);
});

test('the Configuration agent designer also searches locally, restores queries and shows built-in definitions read-only', () => {
  const body = '---\nname: reviewer\ndescription: Reviews screenshots\n---\n\nInspect <script> safely.';
  const catalog = instructionCatalog({ definition: { phases: {} }, agents: [{ id: 'reviewer', path: 'package/reviewer.agent.md', content: body, editable: false }] });
  const html = instructionDesignerHtml(catalog, { tab: 'agents', selected: catalog.agents[0], agent: parseAgent(body, 'reviewer'), errors: [], notice: null, configurationBlockedReason: null });
  assert.match(html, /data-agent-body[^>]*readonly/);
  assert.match(html, /View complete built-in agent definition/);
  assert.match(html, /Inspect &lt;script&gt; safely/);
  assert.match(html, /data-search-action="search"/);
  const document = dom(); const controls = {};
  for (const key of ['search', 'search-count', 'search-empty', 'search-action="clear"', 'search-action="search"']) controls['[data-' + key + ']'] = document.createElement('input');
  controls['[data-catalog-tab]'] = { dataset: { catalogTab: 'agents' } };
  const rows = ['Reviewer screenshot', 'Team builder'].map((value) => ({ hidden: false, dataset: { filterText: value } }));
  document.querySelector = (selector) => controls[selector] || null;
  document.querySelectorAll = (selector) => selector === '[data-filter-text]' ? rows : [];
  document.addEventListener = () => {};
  let saved = { catalogSearch: { agents: 'SCREENSHOT', skills: 'preserved-query' } }; const posted = [];
  const window = { __sfVscode: { postMessage: (message) => posted.push(message), getState: () => saved, setState: (value) => { saved = value; } } };
  new Function('window', 'document', INSTRUCTION_DESIGNER_SCRIPT)(window, document);
  assert.equal(rows[0].hidden, false); assert.equal(rows[1].hidden, true);
  type(controls['[data-search]'], '.*'); assert.ok(rows.every((row) => row.hidden));
  assert.equal(controls['[data-search-empty]'].hidden, false);
  click(controls['[data-search-action="clear"]']); assert.ok(rows.every((row) => !row.hidden));
  assert.equal(saved.catalogSearch.skills, 'preserved-query'); assert.deepEqual(posted, []);
});

function constitutionFixture(articles = []) {
  const f = fixture();
  f.model.constitutions = [{ path: 'singularity/constitution.md', present: articles.length > 0, problems: [], articles,
    workflows: [{ id: 'seed', label: 'Seeded delivery', mode: 'warn', editable: false }, { id: 'team', label: 'Team delivery', mode: 'off', editable: true }],
    policyChoices: [{ workflow: 'seed', choices: [{ path: 'phases.test.approval.minimum', label: 'Test: minimum approvals', value: 1 }] }] }];
  f.logic.state().draft = f.logic.initialDraft(f.model);
  return f;
}

test('Constitution controls preserve seeded applicability and stage typed articles without a host call', () => {
  const f = constitutionFixture(); const main = f.main(); f.logic.renderConstitution(main);
  assert.equal(byId(main, 'constitution-mode-seed').disabled, true);
  assert.equal(Boolean(byId(main, 'constitution-mode-team').disabled), false);
  assert.match(text(main), /running Stories keep their original pins/);
  byId(main, 'constitution-mode-team').listeners.change({ target: { value: 'enforce' } });
  f.logic.openConstitutionForm('singularity/constitution.md');
  const form = f.logic.state().constitutionForm;
  form.article.title = 'Recoverable changes'; form.article.prose = 'Describe a rollback.';
  assert.equal(f.logic.saveConstitutionArticle(), true);
  const changes = f.logic.changeSetFrom(f.model, f.logic.state().draft).changes;
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[0], { op: 'constitution.set', path: 'singularity/constitution.md', articles: [{ id: 'ART-001', type: 'judged', status: 'active', title: 'Recoverable changes', prose: 'Describe a rollback.', level: 'must', evidenceRequired: true }] });
  assert.deepEqual(changes[1], { op: 'constitution.policy', id: 'team', mode: 'enforce' });
  assert.ok(f.posted.every(message => message.type === 'studio.draftSave'), 'editing may persist the local draft, never mutates configuration or calls a model');
});

test('approved Constitution fields are view-only and replacement stages withdrawal plus a collision-free new ID', () => {
  const article = { id: 'ART-001', type: 'judged', status: 'active', title: 'Accessibility', prose: 'Preserve keyboard input.', level: 'must', evidenceRequired: true, articleSha256: 'a'.repeat(64), valid: true };
  const f = constitutionFixture([article]); const main = f.main(); f.logic.renderConstitution(main);
  assert.equal(all(main).filter(node => ['input', 'textarea'].includes(node.tag)).length, 0);
  f.logic.openConstitutionForm('singularity/constitution.md', 'ART-001');
  assert.equal(f.logic.state().constitutionForm, undefined, 'approved source cannot be edited under its ID');
  f.logic.openConstitutionForm('singularity/constitution.md', 'ART-001', true);
  const form = f.logic.state().constitutionForm;
  assert.equal(form.article.id, 'ART-002');
  form.article.id = 'ART-001'; assert.equal(f.logic.saveConstitutionArticle(), false);
  assert.match(form.error, /already used/);
  form.article.id = 'ART-002'; form.article.prose = 'Preserve keyboard and screen reader input.';
  assert.equal(f.logic.saveConstitutionArticle(), true);
  const changes = f.logic.changeSetFrom(f.model, f.logic.state().draft).changes;
  assert.equal(changes[0].articles[0].status, 'withdrawn'); assert.equal(changes[0].articles[0].withdrawnBy, 'ART-002');
  assert.equal(changes[0].articles[0].prose, article.prose);
  assert.equal(changes[0].articles[1].prose, 'Preserve keyboard and screen reader input.');
  assert.ok(changes[0].articles.every(item => item.articleSha256 === undefined), 'seals are generated by the engine, not supplied by the webview');
});

test('machine Constitution articles offer supported policy selection and never an authored enforcement claim', () => {
  const f = constitutionFixture(); f.logic.openConstitutionForm('singularity/constitution.md');
  const value = f.logic.state().constitutionForm.article;
  value.type = 'enforced'; value.title = 'Independent sign-off';
  const main = f.main(); f.logic.renderConstitution(main);
  assert.ok(byId(main, 'constitution-policy')); assert.equal(byId(main, 'constitution-rule'), undefined);
  value.policy = 'untrusted.policy'; assert.equal(f.logic.saveConstitutionArticle(), false);
  value.policy = 'phases.test.approval.minimum'; assert.equal(f.logic.saveConstitutionArticle(), true);
  const article = f.logic.changeSetFrom(f.model, f.logic.state().draft).changes[0].articles[0];
  assert.equal(article.prose, ''); assert.equal(article.level, undefined); assert.equal(article.evidenceRequired, undefined);
});
