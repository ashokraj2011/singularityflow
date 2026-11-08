import assert from 'node:assert/strict';
import test from 'node:test';
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
