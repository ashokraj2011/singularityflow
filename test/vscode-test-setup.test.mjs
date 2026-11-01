import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';
import { testSetupTargets, testSetupTargetsFromYaml, updateTestSetupYaml } from '../apps/vscode/src/views/test-setup-model.ts';
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
  const id = testSetupTargets(definition).find(target => target.workType === null).id;
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

test('test setup renders explicit selection, unverified suggestions and an active-Story handoff', () => {
  const view = { targets: testSetupTargets(definition), selected: null, inspection: null };
  const initial = testSetupHtml(view);
  assert.match(initial, /Choose workflow and phase/);
  assert.doesNotMatch(initial, /id="test-setup-form"/);
  const html = testSetupHtml({ ...view, selected: view.targets[0].id,
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

function scriptHarness(argv = '["node","--test"]') {
  const handlers = { document: {}, window: {} }; const messages = [];
  const fields = Object.fromEntries(Object.entries({ id: 'unit', cwd: '.', argv, adapter: 'node-tap',
    report: '.sflow/results/unit.tap', roots: '.', timeout: '120000' }).map(([key, value]) => [`[data-test-${key}]`, { value }]));
  const row = { dataset: { original: JSON.stringify(command) }, querySelector: selector => fields[selector] };
  const added = [];
  const rows = { querySelectorAll: () => [row, ...added], append: child => added.push(child) };
  const template = { content: { firstElementChild: { cloneNode: () => {
    const own = Object.fromEntries(['id', 'cwd', 'argv', 'adapter', 'report', 'roots', 'timeout'].map(key => [`[data-test-${key}]`, { value: '' }]));
    own['[data-test-env]'] = { textContent: '', hidden: true };
    return { dataset: { original: '{}' }, querySelector: selector => own[selector] };
  } } } };
  const submit = { disabled: false }; const inspect = { disabled: false };
  const results = { children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } };
  const runtime = { hidden: true }; const runtimeText = { textContent: '' };
  const elements = { 'test-command-rows': rows, 'test-inspection-results': results, 'test-command-template': template,
    'test-inspection-roots': { value: '.' }, 'configuration-runtime-message': runtime, 'configuration-runtime-text': runtimeText };
  const on = (surface, type, callback) => (handlers[surface][type] ??= []).push(callback);
  const form = { id: 'test-setup-form', dataset: { target: '[null,"implementation"]' },
    querySelectorAll: () => [submit], querySelector: () => submit };
  runInNewContext(CONFIGURATION_CENTER_SCRIPT, {
    window: { __sfVscode: { postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) },
      addEventListener: (type, callback) => on('window', type, callback) },
    document: {
      getElementById: id => elements[id] ?? null,
      querySelector: selector => selector === '[data-test-inspect]' ? inspect : null,
      querySelectorAll: () => [],
      createElement: () => ({ children: [], dataset: {}, append(...children) { this.children.push(...children); } }),
      addEventListener: (type, callback) => on('document', type, callback)
    }, FormData: class { get() { return null; } }
  });
  const emit = (surface, type, event) => handlers[surface][type]?.forEach(callback => callback(event));
  return { messages, fields, row, added, submit, inspect, results, runtimeText, emit,
    submitForm: () => emit('document', 'submit', { target: form, preventDefault() {} }) };
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
  const html = testSetupHtml({ targets, selected: targets[0].id, inspection: null });
  assert.match(html, /data-test-env>Sets FEATURE_FLAG=on\. Saving keeps these\.</);
  assert.match(testSetupHtml({ targets: testSetupTargets(definition), selected: testSetupTargets(definition)[0].id, inspection: null }), /data-test-env hidden>/);
  const harness = scriptHarness('["node","--test","edited.test.mjs"]');
  harness.row.dataset.original = JSON.stringify(withEnv);
  harness.submitForm();
  const [saved] = harness.messages.find(message => message.type === 'save-test-setup').commands;
  assert.deepEqual(saved.env, { FEATURE_FLAG: 'on' });
  assert.deepEqual(saved.argv, ['node', '--test', 'edited.test.mjs']);
  const yaml = updateTestSetupYaml(YAML.stringify(definition), testSetupTargets(definition)[0].id, [saved]);
  assert.deepEqual(YAML.parse(yaml).phases.implementation.qualityCommands.at(-1).env, { FEATURE_FLAG: 'on' });
});

test('commands the team wrote down are offered with their file, line and env, and one SFlow cannot complete says why', () => {
  const view = { targets: testSetupTargets(definition), selected: testSetupTargets(definition)[0].id,
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
  assert.equal(row.querySelector('[data-test-env]').textContent, 'Sets BASE_URL=http://localhost:3000, CI=1. Saving keeps these.');
  assert.equal(row.querySelector('[data-test-env]').hidden, false);
  harness.submitForm();
  const commands = harness.messages.find(message => message.type === 'save-test-setup').commands;
  assert.deepEqual(commands.map(entry => entry.env), [undefined, written.env]);
  assert.deepEqual(commands[1].argv, written.argv);
});
