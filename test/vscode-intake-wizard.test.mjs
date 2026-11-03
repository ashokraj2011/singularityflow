import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { EMPTY_INTAKE_FORM, INTAKE_SCRIPT, intakeHtml, intakeRegions, intakeProblems, intakeCommand } from '../apps/vscode/src/views/intake-form.ts';
import { INTAKE_WIZARD_SCRIPT, INTAKE_WIZARD_STYLE } from '../apps/vscode/src/views/intake-wizard.ts';

const story = (overrides = {}) => ({ ...EMPTY_INTAKE_FORM, shape: 'story', tracker: 'none',
  id: 'STORY-42', title: 'Improve intake', description: 'Guide a person through Story creation.',
  catalogStatus: 'fresh', workType: 'custom', baseBranch: 'main', basePreflightPassed: true,
  storyWorkflows: [{ id: 'custom', label: 'Team workflow', phases: ['inspect', 'repair', 'close'], description: '' }],
  ...overrides });

function mount(priorState = {}) {
  let state = structuredClone(priorState); let enabled = true; let busy = false;
  const events = {}; const messages = []; const nav = {};
  const element = (dataset = {}) => ({ dataset, hidden: false, disabled: false, attributes: {}, value: '',
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
    getAttribute(key) { return this.attributes[key]; }, focus() { this.focused = true; }, scrollIntoView() {},
    closest(selector) { return selector === '[data-intake-wizard-nav]' ? nav : null; } });
  const fields = Object.fromEntries(['id', 'title', 'description', 'acceptanceCriteria'].map(name => [name, {
    ...element({ field: name }), value: name === 'acceptanceCriteria' ? '' : 'Valid value', validation: '',
    setCustomValidity(message) { this.validation = message; }, reportValidity() { return !this.validation; }
  }]));
  const panels = Object.fromEntries(['details', 'workflow', 'inputs', 'review'].map(id => [id, {
    ...element({ intakeWizardPanel: id }), querySelectorAll: () => id === 'details' ? [fields.id, fields.title, fields.description] : []
  }]));
  const buttons = Object.keys(panels).map(id => element({ intakeWizardGo: id }));
  const controls = Object.fromEntries(['back', 'next', 'final', 'position'].map(id => [id, element()]));
  const summaries = Object.keys(fields).map(name => element({ intakeReviewField: name }));
  const root = { getAttribute: () => String(busy) };
  const document = {
    querySelector(selector) {
      if (selector === '[data-intake-wizard-root]') return root;
      if (selector === '[data-intake-wizard-nav]') return enabled ? nav : null;
      const panel = /^\[data-intake-wizard-panel="(.+)"\]$/u.exec(selector)?.[1];
      if (panel) return panels[panel];
      const field = /^\[data-field="(.+)"\]$/u.exec(selector)?.[1];
      if (field) return fields[field];
      return controls[/^\[data-intake-wizard-(.+)\]$/u.exec(selector)?.[1]];
    },
    querySelectorAll(selector) {
      return selector === '[data-intake-wizard-panel]' ? Object.values(panels)
        : selector === '[data-intake-wizard-go]' ? buttons
          : selector === '[data-intake-review-field]' ? summaries : [];
    },
    addEventListener(name, callback) { events[name] = callback; }
  };
  const api = { getState: () => structuredClone(state), setState: value => { state = structuredClone(value); }, postMessage: message => messages.push(message) };
  const sandbox = { document, window: { __sfVscode: api } };
  runInNewContext(INTAKE_WIZARD_SCRIPT + ';globalThis.controller = intakeWizard;', sandbox);
  const click = (selector, dataset = {}) => events.click({ preventDefault() {}, target: {
    closest: candidate => candidate === selector ? { dataset } : null
  } });
  return { panels, buttons, controls, fields, summaries, messages, controller: sandbox.controller,
    next: () => click('[data-intake-wizard-next]'), back: () => click('[data-intake-wizard-back]'),
    go: id => click('[data-intake-wizard-go]', { intakeWizardGo: id }),
    setBusy(value) { busy = value; sandbox.controller.refresh(); },
    setEnabled(value) { enabled = value; sandbox.controller.refresh(); }, state: () => state };
}

test('Story intake renders four steps, one copy of each field, a final review and only one gated Start', () => {
  const form = story(); const html = intakeHtml(form); const regions = intakeRegions(form);
  assert.equal((html.match(/<button[^>]+data-intake-wizard-go=/gu) ?? []).length, 7, 'four navigation and three Edit links');
  assert.equal((html.match(/data-intake-wizard-panel=/gu) ?? []).length, 4);
  const ids = [...html.matchAll(/data-intake-region="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), Object.keys(regions).sort());
  assert.equal((html.match(/data-field="description"/gu) ?? []).length, 1);
  assert.equal((html.match(/data-submit="start"/gu) ?? []).length, 1);
  assert.match(html, /data-intake-wizard-final hidden/u);
  assert.match(regions.review, /inspect → repair → close/u);
  assert.match(regions.checks, /data-quality-gate-mode/u);
  assert.doesNotMatch(regions.base, /data-quality-gate-mode/u);
  assert.match(intakeRegions(story({ basePreflightPassed: false })).actions, /data-submit="start" disabled/u);
  assert.deepEqual(intakeProblems(form), []);
  assert.ok(intakeCommand(form).includes('STORY-42'), 'creation still uses the existing command builder');
});

test('a failed start never displays stale Ready status and retains the form and error for retry', () => {
  const form = story({ error: 'Cannot download missing approved configuration files. Sign in to Git and retry.' });
  const regions = intakeRegions(form);
  assert.match(regions.status, /Start needs attention/u);
  assert.match(regions.status, /Sign in to Git and retry/u);
  assert.doesNotMatch(regions.status, /<h2>[^<]*Ready|class="ok-text"/u);
  assert.doesNotMatch(regions.actions, /Ready to start/u);
  assert.match(regions.actions, /Start needs attention/u);
  assert.doesNotMatch(regions.actions, /data-submit="start" disabled/u, 'A resolved failure can retry the same populated form.');
  assert.match(regions.review, /STORY-42/u);
});

test('Back and Next are local, retain controls and data, and expose Start only on Review', () => {
  const view = mount(); const field = view.fields.description;
  assert.equal(view.controller.step, 'details'); assert.equal(view.controls.final.hidden, true);
  assert.equal(view.controller.canStart(), false);
  for (const step of ['workflow', 'inputs', 'review']) { view.next(); assert.equal(view.controller.step, step); }
  assert.equal(view.controls.next.hidden, true); assert.equal(view.controls.final.hidden, false);
  assert.equal(view.controller.canStart(), true);
  view.back(); assert.equal(view.controller.step, 'inputs');
  assert.equal(view.fields.description, field); assert.equal(field.value, 'Valid value');
  assert.deepEqual(view.messages, [], 'navigation never calls the host, CLI or Git');
});

test('Next validates required text locally while Review can still show all outstanding host checks', () => {
  const view = mount(); view.fields.title.value = '   '; view.next();
  assert.equal(view.controller.step, 'details'); assert.match(view.fields.title.validation, /Complete this field/u);
  view.fields.title.value = 'Ready'; view.next(); assert.equal(view.controller.step, 'workflow');
  view.go('review'); assert.equal(view.controls.final.hidden, false);
  // The host, not navigation, keeps its Start disabled until intakeProblems is empty.
  assert.match(intakeRegions(story({ basePreflightChecking: true })).actions, /data-submit="start" disabled/u);
});

test('the step survives background patches and reloads alongside unrelated editor state', () => {
  const view = mount({ anotherPanel: 'retain', intakeView: { wizardStep: 'inputs', workflowSearch: 'team' } });
  assert.equal(view.panels.inputs.hidden, false); view.controller.refresh();
  assert.equal(view.controller.step, 'inputs'); view.go('review');
  assert.equal(view.state().anotherPanel, 'retain'); assert.equal(view.state().intakeView.workflowSearch, 'team');
  assert.equal(mount(view.state()).controller.step, 'review');
  assert.equal(mount({ intakeView: { wizardStep: '<invalid>' } }).controller.step, 'details');
});

test('creating a Story locks navigation; switching work shapes leaves their original creation paths available', () => {
  const view = mount(); view.go('review'); view.setBusy(true); view.back(); view.go('details');
  assert.equal(view.controller.step, 'review'); assert.equal(view.controller.canStart(), false);
  assert.ok(view.buttons.every(button => button.disabled));
  view.setBusy(false); view.setEnabled(false);
  assert.ok(Object.values(view.panels).every(panel => !panel.hidden));
  assert.equal(view.controls.final.hidden, false); assert.equal(view.controls.next.hidden, true);
  view.setEnabled(true); assert.equal(view.controller.step, 'details');
  for (const shape of ['epic', 'initiative']) {
    const html = intakeHtml({ ...story(), shape });
    assert.doesNotMatch(html, /data-intake-wizard-nav/u);
    assert.doesNotMatch(html, /data-intake-wizard-final hidden/u);
  }
});

test('problem links reveal the right step and review text stays text, not executable HTML', () => {
  const view = mount(); view.fields.description.value = '<script>unsafe()</script>';
  view.controller.refresh();
  assert.equal(view.summaries.find(item => item.dataset.intakeReviewField === 'description').textContent, '<script>unsafe()</script>');
  view.controller.reveal({ closest: () => view.panels.inputs }); assert.equal(view.controller.step, 'inputs');
  const html = intakeHtml(story({ title: '<img src=x onerror=alert(1)>', storyAttachments: [{
    sourcePath: '/private/local/secret.md', displayName: 'brief.md', name: 'Brief', store: 'local', phases: ['inspect']
  }] }));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(intakeRegions(story({ storyAttachments: [{ sourcePath: '/private/local/secret.md', displayName: 'brief.md', name: 'Brief', store: 'local' }] })).review,
    /on this machine only/u);
  assert.doesNotMatch(html, /<img|\/private\/local\/secret/u);
  const stale = intakeRegions(story({ storyAttachments: [{ sourcePath: '/private/brief.md', displayName: 'brief.md', name: 'Brief', phases: ['retired-phase'] }] }));
  assert.match(stale.review, /No eligible phases — review required/u);
  assert.doesNotMatch(stale.review, /· retired-phase/u);
});

test('wizard is integrated with draft-preserving patches, restored focus, keyboard navigation and existing CSP', () => {
  assert.doesNotThrow(() => new Function(INTAKE_SCRIPT));
  assert.match(INTAKE_SCRIPT, /wizardStep: intakeWizard\.step/u);
  assert.match(INTAKE_SCRIPT, /intakeWizard\.reveal\(target\)/u);
  assert.match(INTAKE_SCRIPT, /intakeWizard\.reveal\(el\)/u);
  assert.match(INTAKE_SCRIPT, /intakeWizard\.refresh\(\)/u);
  assert.match(INTAKE_WIZARD_STYLE, /forced-colors: active/u);
  assert.match(INTAKE_WIZARD_STYLE, /:focus-visible/u);
});
