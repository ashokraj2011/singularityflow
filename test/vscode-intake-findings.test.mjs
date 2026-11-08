import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { EMPTY_INTAKE_FORM, INTAKE_SCRIPT, intakeCommand, intakeHtml } from '../apps/vscode/src/views/intake-form.ts';

// CQF:REQ-065 in VS Code's new-Story form: the register's open items as tick boxes, none ticked.

const choices = [
  { id: 'SEC-11', feed: 'security', label: '<b>Injected</b> title', severity: 'high', dueAt: '2026-12-01', state: 'open', story: null, file: 'src/orders.js' },
  { id: 'TLM-21', feed: 'tlm', label: 'express 4.18.2 → 5.1.0', severity: null, dueAt: null, state: 'open', story: null },
  { id: 'SEC-12', feed: 'security', label: 'Weak hash', severity: 'medium', dueAt: null, state: 'in-story', story: 'ORD-1' }
];
const form = (overrides = {}) => ({
  ...EMPTY_INTAKE_FORM, shape: 'story', tracker: 'none', id: 'ORD-2', title: 'Harden orders', description: 'Fix them.',
  storyWorkflows: [{ id: 'chore', label: 'Chore', description: '', phases: ['intake'] }], workType: 'chore',
  baseRemote: 'origin', baseBranch: 'main', baseBranchChoices: [{ branch: 'main', present: 1, total: 1, everywhere: true, missingFrom: [] }],
  findingChoices: choices, ...overrides
});
const after = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;

test('the form shows each open item unticked, the taken one disabled with its Story, and the team\'s text escaped', () => {
  const html = intakeHtml(form());
  assert.match(html, /Security and TLM findings this Story addresses/u);
  assert.equal((html.match(/data-address-finding="[^"]+"(?![^>]*checked)/gu) ?? []).length, 3, 'nothing is ticked by default');
  assert.match(html, /data-address-finding="SEC-12" disabled[\s\S]*in Story ORD-1/u);
  assert.ok(!html.includes('<b>Injected</b>'), 'a label is data, never markup');
  assert.match(html, /&lt;b&gt;Injected&lt;\/b&gt; title/u);
  assert.equal(after(intakeCommand(form()), '--address'), null, 'Start sends no --address until something is ticked');
});

test('ticked items go to Start as one --address, on every route, and a taken or vanished item never does', () => {
  const ticked = form({ addressFindings: ['SEC-11', 'TLM-21', 'SEC-12', 'SEC-99'] });
  assert.equal(after(intakeCommand(ticked), '--address'), 'SEC-11,TLM-21');
  assert.equal(after(intakeCommand({ ...ticked, tracker: 'github', key: 'example-org/orders-api#7' }), '--address'), 'SEC-11,TLM-21');
  assert.equal(after(intakeCommand({ ...ticked, tracker: 'jira', key: 'ORD-2' }), '--address'), 'SEC-11,TLM-21');
  const html = intakeHtml(ticked);
  assert.match(html, /data-address-finding="SEC-11" checked/u);
  assert.match(INTAKE_SCRIPT, /type: 'addressFindings'/u, 'a tick posts the whole ticked set');
});

test('with no register the form says nothing; an unreadable one is said', () => {
  assert.ok(!intakeHtml(form({ findingChoices: [] })).includes('data-intake-findings'));
  assert.match(intakeHtml(form({ findingChoices: [], findingsNote: 'The findings register could not be read: damaged.' })), /could not be read: damaged/u);
});

test('a register with nothing open says so and offers the upload, which reads the register again once imported', async () => {
  const note = 'No open security findings or TLM items for this repository.';
  const empty = intakeHtml(form({ findingChoices: [], findingsNote: note, findingsUpload: true }));
  assert.match(empty, /data-intake-findings-note>No open security findings/);
  assert.match(empty, /<button type="button" class="secondary" data-findings-upload>Upload findings…<\/button>/);
  assert.doesNotMatch(intakeHtml(form({ findingChoices: [], findingsNote: 'The findings register could not be read: damaged.' })), /data-findings-upload/);
  assert.match(INTAKE_SCRIPT, /closest\('\[data-findings-upload\]'\)\) return vscode\.postMessage\(\{ type: 'findingsUpload' \}\)/);
  const panel = await readFile(new URL('../apps/vscode/src/views/intake-panel.ts', import.meta.url), 'utf8');
  assert.match(panel, /if \(!\(findings\.total \?\? 0\) && !\(findings\.items \?\? \[\]\)\.length\) \{\s*return \{ findingChoices: \[\], findingsUpload: true/);
  assert.match(panel, /executeCommand<unknown>\('singularityFlow\.uploadFindings'\);\s*if \(imported && !this\.disposed\) await this\.reloadCatalog\(\);/);
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /'singularityFlow\.uploadFindings': async \(\) => \{[\s\S]{0,900}?void showCompactInformationMessage[\s\S]{0,300}?return result;\s*\},/,
    'the command answers with the import, not after the toast');
});
