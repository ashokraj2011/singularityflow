import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';
import { REPOSITORY_TEST_TARGET, testScopeFromYaml, testSetupTargets, testSetupTargetsFromYaml, updateTestScopeYaml, updateTestSetupYaml } from '../apps/vscode/src/views/test-setup-model.ts';
import { testSetupHtml } from '../apps/vscode/src/views/test-setup-page.ts';
import { CONFIGURATION_TABS } from '../apps/vscode/src/views/configuration-center-model.ts';
import { CONFIGURATION_CENTER_SCRIPT } from '../apps/vscode/src/views/configuration-center-page.ts';

const command = { id: 'unit', kind: 'test', modelPolicy: 'never', argv: ['node', '--test'],
  workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'node-tap', path: '.sflow/results/unit.tap' } };
const definition = {
  version: 2,
  phases: { implementation: { label: 'Code', approval: { authority: 'human' }, qualityCommands: ['npm run lint', command] } },
  workTypes: {
    first: { phases: ['implementation'], phaseOverrides: { implementation: { label: 'Custom code' } } },
    other: { phases: ['implementation'] }
  }
};

test('workflow-scoped edits preserve non-test commands, phase policy and other workflows', () => {
  const id = testSetupTargets(definition).find(target => target.workType === 'first').id;
  const changed = { ...command, argv: ['node', '--test', 'new.test.mjs'] };
  const result = YAML.parse(updateTestSetupYaml(YAML.stringify(definition), id, [changed]));
  assert.deepEqual(result.phases, definition.phases);
  assert.deepEqual(result.workTypes.other, definition.workTypes.other);
  assert.equal(result.workTypes.first.phaseOverrides.implementation.label, 'Custom code');
  assert.deepEqual(result.workTypes.first.phaseOverrides.implementation.qualityCommands, ['npm run lint', changed]);
});

test('shared edits affect only the selected phase test inventory', () => {
  const id = testSetupTargets(definition).find(target => target.workType === null && target.phaseId).id;
  const result = YAML.parse(updateTestSetupYaml(YAML.stringify(definition), id, [command]));
  assert.deepEqual(result, definition);
});

test('invalid candidate YAML leaves the Center usable without inventing editable targets', () => {
  for (const text of ['phases: [', 'null', 'phases: null', 'phases: { implementation: null }',
    'phases: { implementation: {} }\nworkTypes: { broken: { phases: invalid } }']) {
    assert.deepEqual(testSetupTargetsFromYaml(text), []);
  }
  assert.deepEqual(testSetupTargetsFromYaml(YAML.stringify(definition)), testSetupTargets(definition));
});

test('malformed, stale, escaping and duplicated command drafts are refused', () => {
  const text = YAML.stringify(definition); const id = testSetupTargets(definition)[0].id;
  for (const commands of [[], [command, command], [{ ...command, result: null }], [{ ...command, argv: 'node --test' }],
    [{ ...command, workingDirectory: '../outside' }], [{ ...command, modelPolicy: 'required' }]]) {
    assert.throws(() => updateTestSetupYaml(text, id, commands));
  }
  assert.throws(() => updateTestSetupYaml(text, '["missing","implementation"]', [command]));
});

test('test setup renders the repository by default, unverified suggestions and an active-Story handoff', () => {
  const view = { targets: testSetupTargets(definition), selected: null, inspection: null };
  const initial = testSetupHtml(view);
  // The repository is the default; a step is the other choice [RTC:REQ-005].
  assert.match(initial, /Where these tests apply<\/span><select data-test-target><option value="repository" selected>The repository: every step that runs tests, in every workflow<\/option><optgroup label="Only this step">/);
  assert.match(initial, /<form id="test-setup-form" data-target="repository">/);
  assert.match(initial, /<button type="submit">Save for review<\/button><button type="submit" data-test-activate="true"[^>]*>Save and activate<\/button>/);
  const html = testSetupHtml({ ...view, selected: view.targets[1].id,
    inspection: { repositoryPath: '/approved/repository', sourceRoots: ['.'], suggestions: [command], diagnostics: [], testsExecuted: false, baseline: 'not-observed' } });
  assert.match(html, /Add suggestion to draft/);
  assert.match(html, /Baseline: unverified; no tests ran/);
  assert.match(html, /Existing Stories retain their pinned configuration/);
  assert.match(html, /data-test-argv/);
  assert.match(html, /changed-and-affected/);
  assert.ok(CONFIGURATION_TABS.includes('tests'));
  assert.doesNotThrow(() => new Function(CONFIGURATION_CENTER_SCRIPT));
});

test('capability menu and command palette reach the governed test editor and repository-scoped inspection', async () => {
  const source = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../apps/vscode/src/views/capability-page.ts', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.match(page, /data-test-setup/);
  assert.match(source, /repositories\.includes\(active\.repositoryId\)/);
  assert.match(source, /'singularityFlow.configureTests': \(\) => openConfigurationCenter\('tests'\)/);
  assert.match(source, /'capability', 'test-setup'/);
  assert.match(source, /\/sf-test-setup Inspect the selected repository/);
  assert.ok(manifest.contributes.commands.some(entry => entry.command === 'singularityFlow.configureTests'));
});

function scriptHarness(argv = '["node","--test"]', { formId = 'test-setup-form', formValues = {} } = {}) {
  const handlers = { document: {}, window: {} }; const messages = []; const harness = {};
  const fields = Object.fromEntries(Object.entries({ id: 'unit', cwd: '.', argv, adapter: 'node-tap',
    report: '.sflow/results/unit.tap', roots: '.', timeout: '120000' }).map(([key, value]) => [`[data-test-${key}]`, { value }]));
  const row = { dataset: { original: JSON.stringify(command) }, querySelector: selector => fields[selector] };
  const added = [];
  const rows = { querySelectorAll: () => [row, ...added], append: child => added.push(child) };
  const template = { content: { firstElementChild: { cloneNode: () => {
    const own = Object.fromEntries(['id', 'cwd', 'argv', 'adapter', 'report', 'roots', 'timeout', 'level', 'environment'].map(key => [`[data-test-${key}]`, { value: '' }]));
    own['[data-test-env]'] = { textContent: '', hidden: true };
    return { dataset: { original: '{}' }, querySelector: selector => own[selector] };
  } } } };
  const submit = { disabled: false }; const inspect = { disabled: false };
  const results = { children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } };
  const runtime = { hidden: true }; const runtimeText = { textContent: '' };
  const elements = { 'test-command-rows': rows, 'test-inspection-results': results, 'test-command-template': template,
    'test-inspection-roots': { value: '.' }, 'configuration-runtime-message': runtime, 'configuration-runtime-text': runtimeText };
  const on = (surface, type, callback) => (handlers[surface][type] ??= []).push(callback);
  const form = { id: formId, dataset: { target: '[null,"implementation"]' },
    querySelectorAll: () => [submit], querySelector: () => submit };
  runInNewContext(CONFIGURATION_CENTER_SCRIPT, {
    window: { __sfVscode: { postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) },
      addEventListener: (type, callback) => on('window', type, callback) },
    document: {
      getElementById: id => elements[id] ?? null,
      querySelector: selector => selector === '[data-test-inspect]' ? inspect : null,
      querySelectorAll: selector => (selector === '[data-test-tick]' ? harness.ticks ?? [] : []),
      createElement: () => ({ children: [], dataset: {}, append(...children) { this.children.push(...children); } }),
      addEventListener: (type, callback) => on('document', type, callback)
    }, FormData: class { get(name) { return formValues[name] ?? null; } }
  });
  const emit = (surface, type, event) => handlers[surface][type]?.forEach(callback => callback(event));
  Object.assign(harness, { messages, fields, row, added, submit, inspect, results, runtimeText, emit,
    submitForm: (extra = {}) => emit('document', 'submit', { target: form, preventDefault() {}, ...extra }) });
  return harness;
}

test('the webview sends one save and allows correction after invalid arguments or a refused save', () => {
  const harness = scriptHarness('not JSON');
  harness.submitForm();
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.submit.disabled, false);
  assert.match(harness.runtimeText.textContent, /valid JSON array/);
  harness.fields['[data-test-argv]'].value = '["node","--test","new.test.mjs"]';
  harness.submitForm(); harness.submitForm();
  assert.equal(harness.messages.filter(message => message.type === 'save-test-setup').length, 1);
  assert.equal(harness.submit.disabled, true);
  harness.emit('window', 'message', { data: { type: 'configuration-save-error', errors: ['Refused'], conflict: false } });
  harness.submitForm();
  assert.equal(harness.messages.filter(message => message.type === 'save-test-setup').length, 2);
  assert.deepEqual(harness.messages[0].commands[0].argv, ['node', '--test', 'new.test.mjs']);
});

test('inspection refreshes only suggestions and never erases or saves the edited command', () => {
  const harness = scriptHarness('["node","--test","unsaved.test.mjs"]');
  harness.inspect.disabled = true;
  harness.emit('window', 'message', { data: { type: 'test-setup-inspected', inspection: {
    repositoryPath: '/approved/repository', suggestions: [command], diagnostics: []
  } } });
  assert.equal(harness.inspect.disabled, false);
  assert.equal(harness.fields['[data-test-argv]'].value, '["node","--test","unsaved.test.mjs"]');
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.results.children.length, 2);
  harness.emit('window', 'message', { data: { type: 'test-setup-inspection-error', error: 'Manifest unavailable' } });
  assert.equal(harness.fields['[data-test-argv]'].value, '["node","--test","unsaved.test.mjs"]');
  assert.equal(harness.runtimeText.textContent, 'Manifest unavailable');
});

const written = { ...command, id: 'e2e-written', argv: ['npx', 'playwright', 'test', '--reporter=json'], env: { BASE_URL: 'http://localhost:3000', CI: '1' },
  result: { adapter: 'playwright-json', path: '.sflow/results/e2e.json' } };
const candidates = [
  { id: 'e2e-written', status: 'complete', source: { kind: 'agents', file: 'AGENTS.md', line: 12 }, command: written,
    notes: ['API_TOKEN looks like a secret, so the value was not read: declare it as a secret in singularity/environments.yml.'], secrets: ['API_TOKEN'] },
  { id: 'make-test', status: 'incomplete', source: { kind: 'makefile', file: 'Makefile', line: 4 }, written: 'make test',
    reason: 'It runs a Makefile target; SFlow reads the commands of that target from the Makefile instead.' }
];

test('a command\'s env is shown on its row and kept when the page saves it', () => {
  const withEnv = { ...command, env: { FEATURE_FLAG: 'on' } };
  const targets = testSetupTargets({ ...definition, phases: { implementation: { ...definition.phases.implementation, qualityCommands: [withEnv] } } });
  const shared = (list) => list.find((target) => target.phaseId === 'implementation' && target.workType === null).id;
  const html = testSetupHtml({ targets, selected: shared(targets), inspection: null });
  assert.match(html, /<textarea data-test-env rows="2" [^>]*>FEATURE_FLAG=on<\/textarea>/);
  const harness = scriptHarness('["node","--test","edited.test.mjs"]');
  harness.row.dataset.original = JSON.stringify(withEnv);
  harness.submitForm();
  const [saved] = harness.messages.find(message => message.type === 'save-test-setup').commands;
  assert.deepEqual(saved.env, { FEATURE_FLAG: 'on' });
  assert.deepEqual(saved.argv, ['node', '--test', 'edited.test.mjs']);
  const yaml = updateTestSetupYaml(YAML.stringify(definition), shared(testSetupTargets(definition)), [saved]);
  assert.deepEqual(YAML.parse(yaml).phases.implementation.qualityCommands.at(-1).env, { FEATURE_FLAG: 'on' });
});

test('commands the team wrote down are offered with their file, line and env, and one SFlow cannot complete says why', () => {
  const view = { targets: testSetupTargets(definition), selected: testSetupTargets(definition)[1].id,
    inspection: { repositoryPath: '/approved/repository', sourceRoots: ['.'], suggestions: [command], instructionCandidates: candidates,
      diagnostics: [], testsExecuted: false, baseline: 'not-observed' } };
  const html = testSetupHtml(view);
  assert.match(html, /Written in AGENTS\.md:12 · Module: \. · playwright-json/);
  assert.match(html, /Sets BASE_URL=http:\/\/localhost:3000, CI=1\. Saving keeps these\./);
  assert.match(html, /API_TOKEN looks like a secret/);
  assert.match(html, /Makefile:4: <code>make test<\/code> It runs a Makefile target/);
  assert.match(html, /data-test-suggestion="written-0" data-command="[^"]*BASE_URL[^"]*">Add written command to draft/);
  assert.doesNotMatch(html, /data-test-suggestion="written-1"/);

  const harness = scriptHarness();
  harness.emit('window', 'message', { data: { type: 'test-setup-inspected', inspection: {
    repositoryPath: '/approved/repository', suggestions: [command], instructionCandidates: candidates, diagnostics: [] } } });
  const [, , card, refused] = harness.results.children;
  const button = card.children.find(child => child.dataset?.testSuggestion === 'written-0');
  assert.deepEqual(JSON.parse(button.dataset.command).env, written.env);
  assert.ok(card.children.some(child => child.textContent === 'Sets BASE_URL=http://localhost:3000, CI=1. Saving keeps these.'));
  assert.equal(refused.className, 'notice warning');
  assert.ok(refused.children.includes(' It runs a Makefile target; SFlow reads the commands of that target from the Makefile instead.'));

  harness.emit('document', 'click', { target: { closest: selector => selector === '[data-test-suggestion]' ? button : null } });
  const [row] = harness.added;
  assert.equal(row.querySelector('[data-test-env]').value, 'BASE_URL=http://localhost:3000\nCI=1', 'its variables are shown, one a line, to change per setup');
  harness.submitForm();
  const commands = harness.messages.find(message => message.type === 'save-test-setup').commands;
  assert.deepEqual(commands.map(entry => entry.env), [undefined, written.env]);
  assert.deepEqual(commands[1].argv, written.argv);
});

// The new-Story form sends a person here when the test-scope choice is missing: one switch for
// testRecovery.enabled, saved through the same configuration review as every other setting.
test('Test scope at Story start sets only testRecovery.enabled and keeps every risk review written', () => {
  const plain = YAML.stringify(definition);
  assert.deepEqual(testScopeFromYaml(plain), { enabled: false, reviews: false });
  const on = YAML.parse(updateTestScopeYaml(plain, true));
  assert.deepEqual(on.testRecovery, { enabled: true });
  assert.deepEqual(on.phases, definition.phases);
  const reviewed = YAML.stringify({ ...definition, testRecovery: { enabled: true, riskAuthorities: ['qa'], enabledRiskCategories: ['nonessential-document'] } });
  assert.deepEqual(testScopeFromYaml(reviewed), { enabled: true, reviews: true });
  assert.deepEqual(YAML.parse(updateTestScopeYaml(reviewed, false)).testRecovery,
    { enabled: false, riskAuthorities: ['qa'], enabledRiskCategories: ['nonessential-document'] });
  assert.throws(() => updateTestScopeYaml(plain, 'yes'), /Choose whether/);
  assert.throws(() => updateTestScopeYaml('phases: [', true), /Repair invalid workflow YAML/);
  assert.throws(() => updateTestScopeYaml(YAML.stringify({ ...definition, testRecovery: 'on' }), true), /must be an object/);
  assert.equal(testScopeFromYaml('phases: ['), null);
});

test('the Test setup tab shows the switch, and saving it sends one save-test-scope the Center handles', async () => {
  const html = testSetupHtml({ targets: [], selected: null, inspection: null, testScope: { enabled: false, reviews: false } });
  assert.match(html, /<form id="test-scope-form"[^>]*>[\s\S]*Test scope at Story start[\s\S]*<label class="check"><input type="checkbox" name="enabled">Let the person/);
  assert.match(testSetupHtml({ targets: [], selected: null, inspection: null, testScope: { enabled: true, reviews: true } }),
    /name="enabled" checked>[\s\S]*risk reviews this workflow sets/);
  assert.doesNotMatch(testSetupHtml({ targets: [], selected: null, inspection: null, testScope: null }), /test-scope-form/);
  const harness = scriptHarness(undefined, { formId: 'test-scope-form', formValues: { enabled: 'on' } });
  harness.submitForm();
  assert.deepEqual(harness.messages.filter(message => message.type === 'save-test-scope'), [{ type: 'save-test-scope', enabled: true }]);
  const center = await readFile(new URL('../apps/vscode/src/views/configuration-center.ts', import.meta.url), 'utf8');
  assert.equal((center.match(/'save-test-setup', 'save-test-scope', 'save-commit-policy'\]/g) ?? []).length, 2, 'a mutation, refused while a proposal is pending');
  assert.match(center, /message\.type === 'save-test-scope'[\s\S]{0,400}updateTestScopeYaml\(text, message\.enabled\)/);
  assert.match(center, /testScope: testScopeFromYaml\(this\.renderedTexts\.definitionText\)/);
});

// A Configuration Center save goes to review as a diff: it must be the setting changed, not the whole
// file re-rendered (flow lists padded and split, comments moved), which is what a save showed before.
test('a Configuration Center save changes only the lines of the setting it edits', async () => {
  const { updateApprovalSecurityProfileYaml } = await import('../apps/vscode/src/views/configuration-center-model.ts');
  const template = await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8');
  const changed = (before, after) => {
    const a = before.split('\n'); const b = after.split('\n');
    return { removed: a.filter((line) => !b.includes(line)), added: b.filter((line) => !a.includes(line)) };
  };
  const enabled = updateTestScopeYaml(template, true);
  assert.deepEqual(changed(template, enabled).removed, [], 'no line of the file is rewritten');
  assert.equal(enabled.split('\n').length, template.split('\n').length + 2, 'two lines are added');
  assert.match(enabled, /\ntestRecovery:\n {2}enabled: true\n/u);
  assert.equal(YAML.parse(updateTestScopeYaml(template, true)).testRecovery.enabled, true);
  const security = changed(template, updateApprovalSecurityProfileYaml(template, 'regulated'));
  assert.ok(security.removed.length <= 1 && security.added.length <= 2, JSON.stringify(security));
  assert.equal(YAML.parse(updateApprovalSecurityProfileYaml(template, 'regulated')).approvalSecurity.profile, 'regulated');
  const model = await readFile(new URL('../apps/vscode/src/views/configuration-center-model.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(model, /return String\(parsed\)/u, 'every Center writer goes through the preserving render');
});

// The repository's own tests [RTC:REQ-005, RTC:REQ-006, RTC:REQ-011]: chosen by default, several ticked at
// once, each with its level and target, and saved for review or saved and activated.
const unitTest = { ...command, id: 'shop-unit', level: 'unit' };
const e2eLocal = { ...command, id: 'e2e-local', level: 'e2e', argv: ['npx', 'playwright', 'test'], env: { PLAYWRIGHT_BASE_URL: 'http://localhost:3000' },
  result: { adapter: 'playwright-json', path: '.sflow/results/e2e-local.json' } };

test('the repository target writes tests: only, and an entry saved unchanged keeps its comment', () => {
  const text = `${YAML.stringify(definition)}tests:\n  # Read from AGENTS.md:3 by capability test-setup.\n  - ${YAML.stringify(unitTest).trim().replaceAll('\n', '\n    ')}\n`;
  const [repository] = testSetupTargets(YAML.parse(text));
  assert.deepEqual([repository.id, repository.phaseId, repository.commands.map((entry) => entry.id)], [REPOSITORY_TEST_TARGET, null, ['shop-unit']]);
  const relay = { ...e2eLocal, id: 'e2e-relay', environment: 'relay', env: undefined };
  delete relay.env;
  const saved = updateTestSetupYaml(text, REPOSITORY_TEST_TARGET, [unitTest, e2eLocal, relay]);
  const parsed = YAML.parse(saved);
  assert.deepEqual(parsed.tests.map((entry) => [entry.id, entry.level, entry.environment ?? null]), [['shop-unit', 'unit', null], ['e2e-local', 'e2e', null], ['e2e-relay', 'e2e', 'relay']]);
  assert.deepEqual(parsed.phases, definition.phases, 'no step changed');
  assert.deepEqual(parsed.workTypes, definition.workTypes);
  assert.match(saved, /# Read from AGENTS\.md:3 by capability test-setup\.\n {2}- id: shop-unit/u, 'the unchanged entry keeps where it was read from');
  assert.throws(() => updateTestSetupYaml(text, REPOSITORY_TEST_TARGET, [{ ...unitTest, level: 'smoke' }]), /level must be/u);
  assert.throws(() => updateTestSetupYaml(text, REPOSITORY_TEST_TARGET, [{ ...e2eLocal, env: { PLAYWRIGHT_BASE_URL: 'https://user:pw@relay.example.test' } }]),
    /holds a credential[\s\S]*environments\.yml/u);
});

test('suggestions are ticked several at once, each row sets its level and target, and Save and activate says so', () => {
  const inspection = { repositoryPath: '/approved/repository', sourceRoots: ['.'], diagnostics: [], testsExecuted: false, baseline: 'not-observed',
    suggestions: [unitTest, { ...e2eLocal, env: undefined, targetVariables: ['PLAYWRIGHT_BASE_URL'] }] };
  const html = testSetupHtml({ targets: testSetupTargets(definition), selected: null, inspection });
  assert.equal((html.match(/data-test-tick="\d"/g) ?? []).length, 2);
  assert.match(html, /data-test-add-ticked>Add ticked to draft/);
  assert.match(html, /Its config reads PLAYWRIGHT_BASE_URL\. Set it below/);
  assert.match(html, /<select data-test-level><option value="">None \(other\)<\/option><option value="unit">unit/);
  assert.match(html, /data-test-environment value=""/);

  const harness = scriptHarness();
  harness.emit('window', 'message', { data: { type: 'test-setup-inspected', inspection } });
  const ticks = harness.results.children.slice(1, 3).map((card) => card.children[0].children[0]);
  ticks.forEach((tick) => { tick.checked = true; });
  const ticked = harness.results.children[3].children[0];
  assert.equal(ticked.dataset.testAddTicked, 'true');
  // The page's own query finds the ticked boxes; the harness's document lists them.
  harness.ticks = ticks;
  harness.emit('document', 'click', { target: { closest: (selector) => (selector === '[data-test-add-ticked]' ? ticked : null) } });
  assert.equal(harness.added.length, 2, 'both ticked suggestions are added');
  assert.deepEqual(ticks.map((tick) => tick.checked), [false, false]);
  harness.added[1].querySelector('[data-test-env]').value = 'PLAYWRIGHT_BASE_URL=http://localhost:3000';
  harness.added[0].querySelector('[data-test-level]').value = 'unit';
  harness.submitForm({ submitter: { dataset: { testActivate: 'true' } } });
  const message = harness.messages.find((entry) => entry.type === 'save-test-setup');
  assert.equal(message.activate, true, 'Save and activate asks the host to activate the proposal it makes');
  assert.deepEqual(message.commands.slice(1).map((entry) => [entry.id, entry.level ?? null, entry.env ?? null, Object.hasOwn(entry, 'targetVariables')]),
    [['shop-unit', 'unit', null, false], ['e2e-local', 'e2e', { PLAYWRIGHT_BASE_URL: 'http://localhost:3000' }, false]]);
});

test('Save and activate runs the author-confirmed activation for the proposal it made, and a protected sflow/config names the merge', async () => {
  const center = await readFile(new URL('../apps/vscode/src/views/configuration-center.ts', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(center, /this\.save\(snapshot\.definitionPath \?\? 'singularity\/workflow\.yml', content, text, \{ activate: message\.activate === true \}\)/u);
  assert.match(extension, /if \(message\.activate && disposition\.kind === 'proposal'\) \{\s*const activation = await activateWorkflowProposalNow\(disposition\.branch\);/u,
    'the same activation as Build with Copilot\'s Finish, for the exact proposal just made');
  assert.match(extension, /It waits under Workflow Studio → Changes for someone who may approve configuration\./u);
});
