/**
 * `init` seeds every repository with the packaged workflow catalog, demo, benchmark and POC
 * workflows included. The Start form lists those only in a demo repository: one that asked for
 * them, or already runs work on one. Elsewhere they are one click away, never offered first.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { EMPTY_INTAKE_FORM, INTAKE_SCRIPT, intakeHtml } from '../apps/vscode/src/views/intake-form.ts';
import { SAMPLE_STORY_WORKFLOWS } from '../apps/vscode/src/views/catalog-search.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = (id, label = id) => ({ id, label, description: '', phases: ['intake'] });
const form = (overrides = {}) => ({
  ...EMPTY_INTAKE_FORM, shape: 'story', id: 'new-story', title: 'New Story',
  storyWorkflows: [workflow('feature', 'Feature'), workflow('poc-lite', 'POC Lite'), workflow('benchmarking-a', 'Benchmark A')],
  availableStoryWorkflows: [{ ...workflow('demo-web-e2e-testing', 'Demo Web E2E Testing'), installed: false }],
  ...overrides
});
const listed = (html) => [...html.matchAll(/data-work-type="([^"]+)"/g)].map((match) => match[1]);
const packaged = (html) => [...html.matchAll(/data-available-workflow="([^"]+)"/g)].map((match) => match[1]);

test('the hidden set is exactly the demo, benchmark and POC workflows the packaged template seeds', async () => {
  const template = YAML.parse(await readFile(path.join(root, 'templates', 'workflow.yml'), 'utf8'));
  const seeded = Object.entries(template.workTypes);
  for (const id of SAMPLE_STORY_WORKFLOWS) assert.ok(template.workTypes[id], `${id} is still seeded by init`);
  const named = seeded.filter(([, entry]) => /^(?:Demo\b|Benchmark\b|POC\b)/.test(entry.label)).map(([id]) => id);
  assert.deepEqual(named.sort(), [...SAMPLE_STORY_WORKFLOWS].sort(),
    'a new demo, benchmark or POC workflow in the template is added to the hidden set');
  assert.ok(seeded.length > SAMPLE_STORY_WORKFLOWS.size, 'everyday workflows are still offered');
});

test('a repository that has not asked lists only everyday workflows, and says how many are hidden', () => {
  const html = intakeHtml(form());
  assert.deepEqual(listed(html), ['feature']);
  assert.deepEqual(packaged(html), [], 'a packaged demo workflow is not advertised either');
  assert.match(html, /3 demo, benchmark and POC workflows are hidden\. They are for demo repositories, not everyday work\./);
  assert.match(html, /<button type="button" class="secondary" data-workflow-samples="show">Show them<\/button>/);
  assert.match(html, /Other workflows \(1\)/);
  // A team's own workflow is never hidden for its name.
  assert.deepEqual(listed(intakeHtml(form({ storyWorkflows: [workflow('demo-checkout'), workflow('poc-payments')] }))),
    ['demo-checkout', 'poc-payments']);
});

test('a demo repository lists them: asked for here, already used here, or the one chosen or starred', () => {
  const shown = intakeHtml(form({ showSampleWorkflows: true }));
  assert.deepEqual(listed(shown), ['feature', 'poc-lite', 'benchmarking-a']);
  assert.deepEqual(packaged(shown), ['demo-web-e2e-testing']);
  assert.match(shown, /data-workflow-samples="hide">Hide them</);
  assert.doesNotMatch(shown, /are hidden/);

  const used = intakeHtml(form({ inFlight: [{ shape: 'story', id: 'S-1', title: 'Demo', status: 'in progress', workType: 'poc-lite' }] }));
  assert.deepEqual(listed(used), ['feature', 'poc-lite', 'benchmarking-a'], 'work already started on one makes this a demo repository');

  assert.deepEqual(listed(intakeHtml(form({ workType: 'benchmarking-a' }))), ['feature', 'benchmarking-a'],
    'the chosen workflow never disappears from under its radio button');
  assert.deepEqual(listed(intakeHtml(form({ favouriteWorkflows: ['poc-lite'] }))), ['feature', 'poc-lite']);
  assert.match(intakeHtml(form({ workType: 'benchmarking-a' })), /2 demo, benchmark and POC workflows are hidden/);
});

test('Show them and Hide them ask the host, which remembers the choice per repository', async () => {
  assert.match(INTAKE_SCRIPT, /closest\('\[data-workflow-samples\]'\)/);
  assert.match(INTAKE_SCRIPT, /postMessage\(\{ type: 'sampleWorkflows', value: samples\.dataset\.workflowSamples \}\)/);
  const panel = await readFile(path.join(root, 'apps/vscode/src/views/intake-panel.ts'), 'utf8');
  assert.match(panel, /showSampleWorkflows: preferences\.get\(SAMPLE_WORKFLOWS_KEY \+ ':' \+ target\.repository\) === true/);
  assert.match(panel, /sampleWorkflows: async \(message\) => \{[\s\S]*?if \(value !== 'show' && value !== 'hide'\) return;/);
});
