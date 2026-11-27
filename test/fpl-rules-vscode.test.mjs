// FPL M3 in VS Code (docs/SPEC-FPL-FOUR-PLACES-v1.md §3.4, REQ-019 to REQ-026, REQ-037, A11 to A15): the Rules tab and its
// one page, with the form, its preview and Propose through Workflow Studio's reviewed path, behind the places switch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import {
  formFieldOf, ruleChangeSet, ruleFormHtml, ruleInputFrom, rulesListFrom, rulesPageHtml, rulesPanelHtml, rulesPreviewFrom, rulesPreviewHtml
} from '../apps/vscode/src/views/rules-page.ts';
import { PLACE_TABS, placesTabsHtml } from '../apps/vscode/src/views/needs-you-page.ts';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rule = (id, extra = {}) => ({ id, section: 'paths', index: 0, when: 'a task touches src/auth/**', then: 'add a review', because: 'Sign-in is reviewed.',
  words: 'When a task touches src/auth/**: add a review.', fields: { kinds: ['all'], paths: ['src/auth/**'], steps: ['review'], personApproves: [], workflow: null },
  problems: [], ...extra });
const read = (extra = {}) => ({ schemaVersion: 1, resultType: 'sflow-rules',
  authority: { kind: 'verified-authority', ref: 'refs/heads/sflow/config', commit: 'c'.repeat(40), remoteFingerprint: 'fp', sourceCommit: null },
  base: { workflowSha256: 'b'.repeat(64) },
  builtIn: [{ id: 'built-in-tests', when: 'any code changes', then: 'add tests', because: 'Every code change gets a test step.', builtIn: true, words: 'When any code changes: add tests.' }],
  rules: [rule('sign-in-review'), rule('always[0]', { section: 'always', when: 'a task is a feature', then: 'add a review', fields: { kinds: ['feature'], paths: [], steps: ['review'], personApproves: ['code'], workflow: null },
    problems: [{ field: 'tasks.always[0].steps', message: 'always[0] steps names \'deploy\'.' }] })],
  waiting: [{ branch: 'sflow/config-change/workflow/billing', proposer: 'Builder', words: 'Waiting for review, proposed by Builder.', lines: ['Adds: When a task touches src/billing/**: add a review.'] }],
  idPrefix: { value: 'TASK', words: 'Tasks are named TASK-<n>.' }, compose: [{ kind: 'fix', words: 'A fix: Intake → Code → Tests' }],
  workflows: { words: 'For work a team must always do one way, use a workflow: Workflow Studio, under Advanced.' },
  guidance: { count: 3, words: 'Guidance the agents read: 3 lessons.' },
  inFlight: { count: 4, words: '4 tasks in flight keep the rules they started with; a change applies to tasks started after it is approved.' },
  problems: [], form: { kinds: [{ id: 'fix', words: 'a fix' }, { id: 'change', words: 'a change' }], steps: [{ id: 'review', words: 'a review' }, { id: 'test', words: 'tests' }],
    approves: [{ id: 'code', words: 'the code' }], workflows: [{ id: 'classic-delivery', label: 'Classic delivery' }],
    groups: [{ id: 'engineering-reviewers', label: 'Engineering reviewers' }, { id: 'security', label: 'Security' }] }, lines: [], ...extra });

test('REQ-019, REQ-026: the Rules tab lists built-in rules, the team\'s as When and Then, those waiting for review, the prefix and the links', () => {
  const list = rulesListFrom(read());
  const html = rulesPanelHtml(list);
  assert.match(html, /<h2 class="rules-group">Built in<\/h2>[^]*<span class="rules-word">When<\/span> any code changes[^]*<span class="rules-badge">Built in<\/span>/u);
  assert.match(html, /<button type="button" class="rules-row rules-open" data-rule="sign-in-review"><span class="rules-when"><span class="rules-word">When<\/span> a task touches src\/auth\/\*\*<\/span>\s*<span class="rules-then"><span class="rules-word">Then<\/span> add a review<\/span>\s*<span class="rules-because">Sign-in is reviewed\.<\/span>/u);
  assert.match(html, /One problem: open it to fix it/u);
  assert.match(html, /<h2 class="rules-group">Waiting for review<\/h2>[^]*Adds: When a task touches src\/billing\/\*\*: add a review\.[^]*Waiting for review, proposed by Builder\./u);
  assert.match(html, /Tasks are named TASK-&lt;n&gt;\./u);
  assert.match(html, /data-rules-act="lessons">Guidance the agents read: 3 lessons\./u, 'lessons are guidance, linked, not listed as rules');
  assert.match(html, /data-rules-act="studio">For work a team must always do one way/u);
  assert.match(html, /data-rules-act="add">Add a rule/u);
  // The tab strip: Work, Needs you, Rules, Advanced [REQ-001].
  assert.deepEqual(PLACE_TABS, ['work', 'needs-you', 'rules', 'advanced']);
  const tabs = placesTabsHtml('rules', null);
  assert.ok(tabs.indexOf('data-tab="needs-you"') < tabs.indexOf('data-tab="rules"') && tabs.indexOf('data-tab="rules"') < tabs.indexOf('data-tab="advanced"'));
  assert.match(tabs, /role="tab"[^>]*aria-selected="true"[^>]*data-tab="rules"/u);
  // Untrusted output: a rule with an ID the engine never makes is dropped.
  assert.equal(rulesListFrom(read({ rules: [rule('bad id <script>')] })).rules.length, 0);
  assert.equal(rulesListFrom({ resultType: 'other' }), null);
});

test('REQ-020, REQ-037: the form offers only what taskRules accepts, labels every field, links problems to them; the page has no step IDs', () => {
  const list = rulesListFrom(read());
  const form = ruleFormHtml(list);
  assert.match(form, /<legend>When<\/legend>[^]*any code changes[^]*a task is of these kinds[^]*a task touches these files/u);
  assert.match(form, /<legend>Then<\/legend>[^]*add a step[^]*a person approves a step[^]*follow a workflow \(one kind of task only\)/u);
  assert.match(form, /<label for="rule-why">Why \(required: it is what a refused "skip the tests" says\)<\/label>\s*<input id="rule-why" type="text" required value="" aria-describedby="rules-problems">/u);
  for (const id of ['rule-paths', 'rule-step', 'rule-approves', 'rule-workflow']) assert.match(form, new RegExp(`<label[^>]*for="${id}"`, 'u'), `${id} has a label`);
  assert.match(form, /<option value="classic-delivery">Classic delivery<\/option>/u, 'only this repository\'s workflows');
  // What the page sends is bounded to the form's choices: an unknown kind, step or workflow is dropped.
  assert.deepEqual(ruleInputFrom({ when: 'paths', kinds: ['fix', 'nowhere'], paths: 'src/billing/**\n', then: 'step', step: 'deploy', because: '  Billing  is reviewed. ' }, list),
    { kinds: ['fix'], paths: ['src/billing/**'], steps: [], personApproves: [], workflow: null, by: null, because: 'Billing is reviewed.' });
  assert.deepEqual(ruleInputFrom({ when: 'kinds', kinds: ['change'], then: 'workflow', workflow: 'classic-delivery', because: 'Changes ship the classic way.' }, list),
    { kinds: ['change'], paths: [], steps: [], personApproves: [], workflow: 'classic-delivery', by: null, because: 'Changes ship the classic way.' });
  assert.deepEqual(ruleInputFrom({ when: 'any', then: 'step', step: 'review', because: 'x' }, list).kinds, ['all']);
  assert.deepEqual(ruleInputFrom({ when: 'kinds', kinds: [], then: 'step', step: 'review', because: 'x' }, list).kinds, [],
    '"these kinds" with none ticked is said by the preview, never taken for any code changes');
  // One change set for the reviewed path, on the configuration the page read.
  assert.deepEqual(JSON.parse(ruleChangeSet(list, { op: 'add', rule: { kinds: ['fix'], paths: [], steps: ['review'], personApproves: [], workflow: null, because: 'b' } })),
    { schema: 'sflow-studio-change-set@1', base: { workflowSha256: 'b'.repeat(64) }, changes: [{ op: 'tasks.rule.add', rule: { kinds: ['fix'], paths: [], steps: ['review'], personApproves: [], workflow: null, because: 'b' } }] });
  assert.equal(JSON.parse(ruleChangeSet(list, { op: 'remove', id: 'sign-in-review' })).changes[0].op, 'tasks.rule.remove');
  // Problems are linked to their fields.
  assert.deepEqual(['tasks.paths[1].because', 'tasks.always[0].steps', 'tasks.paths[0].kinds', 'tasks.paths[0].paths', 'tasks.use.change.workflow', 'tasks.idPrefix',
    'tasks.paths[1].by'].map(formFieldOf), ['why', 'then', 'kinds', 'paths', 'workflow', 'form', 'by']);
  // §11 question 3: "a person approves a step" asks Who approves, from the repository's groups, beside a link to People.
  assert.match(form, /<label class="rules-inline" for="rule-by">Who approves<\/label><select id="rule-by" aria-describedby="rules-problems"><option value="" selected>The step(?:'|&#39;)s own approvers<\/option><option value="engineering-reviewers">The step(?:'|&#39;)s own approvers, and Engineering reviewers too<\/option><option value="security">The step(?:'|&#39;)s own approvers, and Security too<\/option><\/select>\s*<button type="button" class="link rules-inline" data-act="people">People and approval groups<\/button>/u);
  assert.equal(ruleInputFrom({ when: 'paths', paths: 'src/payments/**', then: 'approves', approves: 'code', by: 'security', because: 'Payments need Security.' }, list).by, 'security');
  assert.equal(ruleInputFrom({ when: 'paths', paths: 'src/payments/**', then: 'approves', approves: 'code', by: 'auditors', because: 'x' }, list).by, null, 'only the repository\'s groups');
  assert.equal(ruleInputFrom({ when: 'any', then: 'step', step: 'review', by: 'security', because: 'x' }, list).by, null, 'only with a person approving a step');
  const byRow = rulesListFrom(read({ rules: [rule('payments', { fields: { kinds: ['all'], paths: ['src/payments/**'], steps: [], personApproves: ['code'], workflow: null, by: 'security' } })] })).rules[0];
  assert.equal(byRow.fields.by, 'security');
  assert.match(ruleFormHtml(list, byRow), /<option value="security" selected>/u, 'changing a rule shows its group');
  assert.equal(rulesListFrom(read({ rules: [rule('x', { fields: { kinds: ['all'], paths: [], steps: [], personApproves: ['code'], workflow: null, by: 'Bad Group' } })] })).rules[0].fields.by, null);
  // The page: the list with Change and Remove, the form and its polite preview, how tasks are composed, and the links.
  const page = rulesPageHtml(list, { editing: list.rules[0] });
  assert.match(page, /<h1 id="rules-title" tabindex="-1">The team(?:'|&#39;)s rules<\/h1>/u);
  assert.match(page, /4 tasks in flight keep the rules they started with/u, 'REQ-025: the page says how many');
  assert.match(page, /data-change="sign-in-review">Change<\/button> <button type="button" class="secondary" data-remove="sign-in-review">Remove<\/button>/u);
  assert.match(page, /data-act="people">Who approves<\/button>/u, 'a rule\'s approver links People');
  assert.match(page, /<h2 id="form-title">Change the rule<\/h2>/u);
  assert.match(page, /<textarea id="rule-paths" rows="2" aria-describedby="rules-problems">src\/auth\/\*\*<\/textarea>/u);
  assert.match(page, /<div id="rules-preview" aria-live="polite">/u);
  assert.match(page, /data-act="people">People and approval groups<\/button>[^]*data-act="constitution">The Constitution<\/button>/u);
  assert.match(page, /data-act="prefix">Change<\/button>/u);
  assert.doesNotMatch(page.replace(/data-[a-z]+="[^"]*"/gu, '').replace(/(?:id|for|aria-[a-z]+|name|value)="[^"]*"/gu, ''), /[0-9a-f]{40}|sha256|\bphase\b|\bgeneration\b|\bwork item\b/iu);
});

test('REQ-021: the preview shows each kind that changes, or every problem with its field', () => {
  const ok = rulesPreviewFrom({ resultType: 'sflow-rules-preview', valid: true, problems: [], warnings: [{ field: 'tasks.always[0].steps', message: 'always[0] steps names deploy.' }],
    summary: ['Rule x added.'], others: 'No other kind changes.',
    lines: [{ kind: 'fix', touching: 'src/billing/x.ts', words: 'A fix touching src/billing/x.ts: Intake → Code → Tests → Conformance review (added).', added: ['Conformance review'], removed: [] }] });
  const html = rulesPreviewHtml(ok);
  assert.match(html, /<li>A fix touching src\/billing\/x\.ts: Intake → Code → Tests → Conformance review \(added\)\.<\/li>[^]*No other kind changes\./u);
  assert.match(html, /Already there, and not changed by this:/u);
  const refused = rulesPreviewHtml(rulesPreviewFrom({ resultType: 'sflow-rules-preview', valid: false, problems: [{ field: 'tasks.paths[0].because', message: 'paths[0] needs a because.' }],
    warnings: [], summary: [], lines: [] }));
  assert.match(refused, /<ul id="rules-problems"><li data-field="why">paths\[0\] needs a because\. <span class="muted">\(tasks\.paths\[0\]\.because\)<\/span><\/li><\/ul>/u);
});

// ---------------------------------------------------------------------- the place and the page, against a `vscode` stub

const STUB = '__sflowRulesPlaceVscode';
let loaded = null;
function loadRules() {
  loaded ??= (async () => {
    const api = { ViewColumn: { Active: 1, Beside: 2 }, panels: [], said: [], answers: {},
      commands: { executeCommand: async (id, ...args) => { api.said.push(['command', id, ...args]); } },
      window: {
        createWebviewPanel: (viewType, title) => {
          const panel = { viewType, title, html: '', listeners: [], posted: [], webview: { html: '', cspSource: 'stub', onDidReceiveMessage: (listener) => panel.listeners.push(listener),
            asWebviewUri: (uri) => uri, postMessage: async (message) => { panel.posted.push(message); return true; } }, reveal() {}, onDidDispose() {},
          send: (message) => Promise.all(panel.listeners.map((listener) => listener(message))) };
          api.panels.push(panel);
          return panel;
        },
        showInputBox: async (options) => { api.said.push(['input', options.title]); return api.answers.input; },
        showWarningMessage: async (message, ...rest) => { api.said.push(['warning', message, rest[0]?.detail ?? null]); return api.answers.warning; },
        showInformationMessage: async (message) => { api.said.push(['information', message]); return undefined; }
      }
    };
    globalThis[STUB] = api;
    const shim = 'data:text/javascript,' + encodeURIComponent(`const api = globalThis.${STUB};
      export const ViewColumn = api.ViewColumn, commands = api.commands, window = api.window;
      export const Uri = { file: (fsPath) => ({ fsPath }), joinPath: (...parts) => ({ fsPath: parts.map((part) => part.fsPath ?? part).join('/') }) };
      export const workspace = { getConfiguration: () => ({ get: () => undefined }) };
      export const env = {}; export const ProgressLocation = {}; export class EventEmitter { event() {} fire() {} dispose() {} }`);
    register('data:text/javascript,' + encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'vscode') return { url: ${JSON.stringify(shim)}, shortCircuit: true };
        return nextResolve(specifier, context);
      }`));
    const out = await mkdtemp(path.join(os.tmpdir(), 'sflow-rules-place-'));
    process.once('exit', () => rmSync(out, { recursive: true, force: true }));
    await build({ entryPoints: [path.join(REPOSITORY, 'apps/vscode/src/views/rules.ts')], bundle: true, platform: 'node', format: 'esm', external: ['vscode'],
      outdir: out, outExtension: { '.js': '.mjs' }, logLevel: 'silent' });
    return { api, module: await import(pathToFileURL(path.join(out, 'rules.mjs')).href) };
  })();
  return loaded;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let index = 0; index < 12; index += 1) await tick(); };

function fakeHost() {
  const calls = [];
  const preview = { resultType: 'sflow-rules-preview', valid: true, problems: [], warnings: [], summary: [], others: 'No other kind changes.',
    lines: [{ kind: 'fix', touching: 'src/billing/x.ts', words: 'A fix touching src/billing/x.ts: Intake → Code → Tests → Conformance review (added).', added: ['Conformance review'], removed: [] }] };
  const client = {
    run: async (argv) => { calls.push(['run', ...argv]); return argv[0] === 'rules' ? read() : {}; },
    runWithInput: async (argv, input) => {
      calls.push(['input', ...argv, JSON.parse(input)]);
      if (argv[0] === 'rules') return preview;
      return { reviewRequired: true, branch: 'sflow/config-change/workflow/billing-review', written: [] };
    }
  };
  const host = { calls, refusals: [], refreshed: 0, client,
    command: async (id, ...args) => { calls.push(['command', id, ...args]); },
    refresh: async () => { host.refreshed += 1; },
    showRefusal: (error, headline) => host.refusals.push([headline, error.message]) };
  return host;
}

test('A12 in VS Code: the page previews the form\'s rule, and Propose sends one change set through the reviewed path after a yes', async () => {
  const { api, module } = await loadRules();
  const host = fakeHost();
  const place = new module.RulesPlace(host, () => {});
  await place.read({});
  assert.deepEqual(host.calls.map((call) => call.slice(0, 3)), [['run', 'rules', '--json']]);
  assert.match(place.panel(), /data-rule="sign-in-review"/u);
  // A row opens the one page on that rule; opening changes nothing [REQ-003].
  const before = api.panels.length;
  assert.equal(place.receive({ action: 'rules-open', rule: 'sign-in-review' }), true);
  await settle();
  const panel = api.panels.at(-1);
  assert.equal(api.panels.length, before + 1);
  assert.match(panel.webview.html, /Change the rule/u);
  assert.equal(host.calls.length, 1, 'opening the page runs nothing');
  place.receive({ action: 'rules-act', act: 'add' });
  await settle();
  assert.equal(api.panels.length, before + 1, 'one reused page');
  assert.match(panel.webview.html, /<h2 id="form-title">Add a rule<\/h2>/u);

  // The preview: `rules preview` with one change set, its answer posted to the polite region.
  const form = { when: 'paths', kinds: ['fix', 'change'], paths: 'src/billing/**', then: 'step', step: 'review', because: 'Billing changes are reviewed.' };
  await panel.send({ type: 'preview', rule: form, editing: null });
  await settle();
  const asked = host.calls.find((call) => call[0] === 'input' && call[1] === 'rules');
  assert.deepEqual(asked.slice(1, 6), ['rules', 'preview', '--change-set', '-', '--json']);
  assert.deepEqual(asked[6].changes, [{ op: 'tasks.rule.add', rule: { kinds: ['fix', 'change'], paths: ['src/billing/**'], steps: ['review'], personApproves: [], workflow: null,
    by: null, because: 'Billing changes are reviewed.' } }]);
  assert.match(panel.posted.at(-1).html, /Conformance review \(added\)/u);

  // Propose: nothing without the person's yes; with it, one Studio change set through `workflow studio apply --propose`.
  api.answers.warning = undefined;
  await panel.send({ type: 'propose', rule: form, editing: null });
  await settle();
  assert.equal(host.calls.filter((call) => call[1] === 'workflow').length, 0, 'no yes, nothing proposed');
  assert.match(api.said.find((entry) => entry[0] === 'warning')[2], /one review proposal on the approved configuration[^]*4 tasks in flight keep the rules they started with/u);
  api.answers.warning = 'Propose this rule';
  await panel.send({ type: 'propose', rule: form, editing: null });
  await settle();
  const proposed = host.calls.find((call) => call[0] === 'input' && call[1] === 'workflow');
  assert.deepEqual(proposed.slice(1, 7), ['workflow', 'studio', 'apply', '--change-set', '-', '--propose']);
  assert.ok(proposed.includes('--expected-authority-commit') && proposed.includes('--json'));
  assert.equal(proposed.at(-1).changes[0].op, 'tasks.rule.add');
  assert.deepEqual(proposed.at(-1).base, { workflowSha256: 'b'.repeat(64) });
  assert.equal(host.refreshed, 1, 'Needs you reads again, so the Review item shows');
  assert.match(panel.webview.html, /Proposed for review as sflow\/config-change\/workflow\/billing-review\. It is a Review item in the Needs you of each person who may approve it/u);

  // Without Why, nothing is sent and the field is named.
  const sent = host.calls.length;
  await panel.send({ type: 'propose', rule: { ...form, because: ' ' }, editing: null });
  await settle();
  assert.equal(host.calls.length, sent);
  assert.deepEqual(panel.posted.at(-1).fields, ['why']);

  // Remove: its preview first, then the same reviewed path with tasks.rule.remove, after its own yes.
  api.answers.warning = 'Propose removing it';
  await panel.send({ type: 'remove', id: 'sign-in-review' });
  await settle();
  assert.equal(host.calls.filter((call) => call[1] === 'workflow').at(-1).at(-1).changes[0].op, 'tasks.rule.remove');
  // The links: Workflow Studio, People, the Constitution, Lessons.
  for (const [act, command] of [['studio', 'singularityFlow.openWorkflowStudio'], ['people', 'singularityFlow.configurePeople'],
    ['constitution', 'singularityFlow.openConstitution'], ['lessons', 'singularityFlow.lessons']]) {
    await panel.send({ type: 'act', act });
    await settle();
    assert.deepEqual(host.calls.at(-1), ['command', command]);
  }
});

test('Rules is off by default, lazy, third in the places, and wired with today\'s reviewed path', async () => {
  const extension = await readFile(path.join(REPOSITORY, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /const rules = new \(lazyPanels\(\)\.RulesPlace\)\(\{/u, 'loaded from the lazy panels, only while the places are on');
  assert.match(extension, /place\.setPart\('rules', rules\);/u);
  const lazy = await readFile(path.join(REPOSITORY, 'apps/vscode/src/lazy-panels-runtime.ts'), 'utf8');
  assert.match(lazy, /export \{ RulesPlace, RulesPagePanel \} from '\.\/views\/rules\.ts';/u);
  const client = await readFile(path.join(REPOSITORY, 'apps/vscode/src/cli/client.ts'), 'utf8');
  assert.match(client, /'inbox', 'needs-you', 'rules', 'home'/u, 'rules and rules preview read');
  const rules = await readFile(path.join(REPOSITORY, 'apps/vscode/src/views/rules.ts'), 'utf8');
  assert.match(rules, /studioPublishArgs\(list\.authority as StudioAuthority\)/u, 'the same args Workflow Studio publishes with');
  assert.doesNotMatch(rules, /writeFile|workflow\.yml'\)/u, 'the page writes nothing itself');
});
