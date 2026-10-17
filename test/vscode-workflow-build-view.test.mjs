import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const studioPage = await import(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio-page.ts'));
const { WORKFLOW_STUDIO_SCRIPT, STUDIO_FOCUS_VIEWS } = studioPage;
const tool = await import(path.join(packageRoot, 'apps/vscode/src/views/workflow-builder-tool.ts'));

async function harness() {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-view-'));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Build Tester', SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(state, 'builds') };
  const run = (command, args, cwd, input = '') => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const json = (cwd, args, input = '') => JSON.parse(run(process.execPath, [bin, ...args], cwd, input).stdout);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-view-repo-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Build Tester'], root); run('git', ['config', 'user.email', 'build@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Build\n');
  run(process.execPath, [bin, 'init'], root);
  await repositoryOwnedWorkflows(root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  const team = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-view-team-'));
  const files = {
    '.github/agents/release-captain.agent.md': ['---', 'name: release-captain', 'description: Runs a payments release.', '---', '', '1. Intake the change.',
      '2. Build it and run `npm test`.', '3. PCI review: it must be signed off by security.', '4. Release.', ''].join('\n'),
    'docs/runbook.md': ['# Runbook', '```sh', "curl -X POST https://jira.example.com/rest/api/2/issue/$KEY/transitions -d '{}'", '```', ''].join('\n')
  };
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(team, relative)), { recursive: true });
    await writeFile(path.join(team, relative), text);
  }
  return { root, team, json, run };
}

const FIRST = {
  title: 'Four steps from release-captain',
  why: 'release-captain numbers intake, build, PCI review and release.',
  moves: [
    { move: 'group.add', id: 'payments-security', label: 'Payments security' },
    { move: 'step.add', id: 'intake', after: null },
    { move: 'step.add', id: 'requirements', after: 'intake' },
    { move: 'step.add', id: 'pay-build', label: 'Build', after: 'requirements', agent: 'developer', output: 'code', reads: ['requirements'],
      signOff: { groups: ['engineering-reviewers'], minimum: 1 }, purpose: 'Makes the change and runs the payment tests.' },
    { move: 'step.add', id: 'pay-pci-review', label: 'PCI review', after: 'pay-build', agent: 'architect', output: 'document', reads: ['pay-build'],
      signOff: { groups: ['payments-security'], minimum: 1 }, purpose: 'Nothing ships without a PCI check signed off by security.' }
  ],
  evidence: [{ path: '.github/agents/release-captain.agent.md', startLine: 6, endLine: 9 }],
  questions: [{ question: 'Who signs off the PCI review?', choices: ['payments-security', 'platform-leads'], blocking: true }]
};

// Just enough of a document to render the Build view and click its buttons.
function element(tag) {
  return { tag, attributes: {}, children: [], style: {}, listeners: {}, className: '', textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name] ?? null; },
    appendChild(child) { this.children.push(child); return child; }, addEventListener(type, listener) { this.listeners[type] = listener; }, focus() {} };
}
const nodes = (node) => [node, ...(node.children ?? []).flatMap(nodes)];
const byKey = (root, key) => nodes(root).find((node) => node.attributes?.['data-key'] === key) ?? null;
const textOf = (node) => (node.text ?? '') + (node.textContent ?? '') + (node.children ?? []).map(textOf).join('');

function studio(model) {
  const posted = [];
  const listeners = {};
  const window = { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener(type, listener) { listeners[type] = listener; } };
  const document = { getElementById: () => null, createElement: element, createElementNS: (namespace, tag) => element(tag), createTextNode: (text) => ({ text }) };
  new Function('window', 'document', WORKFLOW_STUDIO_SCRIPT)(window, document);
  const send = (data) => listeners.message({ data });
  send({ type: 'studio.model', model });
  const page = window.__workflowStudio;
  const draw = () => { const main = element('main'); page.renderBuild(main); return main; };
  return { page, posted, send, draw };
}

test('the Build view lists builds, opens one, and draws, explains and checks it; Copilot\'s proposal waits for a person', async () => {
  const { buildStudioModel } = await import('../src/workflow-studio.mjs');
  const { root, team, json } = await harness();
  const model = await buildStudioModel(root);
  const { page, posted, send, draw } = studio(model);
  assert.ok(STUDIO_FOCUS_VIEWS.includes('build'), 'other screens can open Studio at the Build view');

  page.openBuilds();
  assert.deepEqual(posted.at(-1), { type: 'studio.build.list' });
  let main = draw();
  assert.match(textOf(main), /Build a workflow with Copilot/);
  assert.match(textOf(main), /Looking for builds…/);
  send({ type: 'studio.builds', builds: [], modelAvailable: true });
  assert.match(textOf(draw()), /No builds for this repository yet/);
  // Each start posts what the host needs; choosing folders is the host's dialog.
  main = draw();
  assert.ok(byKey(main, 'build-name'), 'the chosen card asks for the name');
  byKey(main, 'build-start-material').listeners.click();
  assert.deepEqual(posted.at(-1), { type: 'studio.build.start', build: null, from: 'material', workflow: null, name: null });

  const view = json(root, ['workflow', 'build', 'start', '--folder', team, '--name', 'Payments release', '--json']);
  const process = view.build.items.find((item) => item.kind === 'process');
  const proposed = json(root, ['workflow', 'build', 'propose', '--build', view.build.id, '--proposal', '-', '--json'], JSON.stringify({ ...FIRST, items: [process.id] }));
  send({ type: 'studio.build', build: view.build.id, view: proposed, checking: true, modelAvailable: true });
  assert.equal(page.buildState().tab, 'found', 'a build you just started opens on what was found in it');
  page.buildState().tab = 'build';
  main = draw();
  assert.match(textOf(byKey(main, 'build-tab-found')), /What we found/);
  assert.match(textOf(main), /Drawing the workflow…/);
  const card = nodes(main).find((node) => node.attributes?.['data-proposal'] === 'p-1');
  assert.match(textOf(card), /Four steps from release-captain.*waiting for you/);
  assert.match(textOf(card), /Use the existing step Intake at the start/);
  assert.match(textOf(card), /Add the step PCI review after Build, drafted by Architect, writes a document, signed off by Payments security/);
  assert.match(textOf(card), /Add the approval group Payments security \(people are added later\)/);
  assert.match(textOf(nodes(main).find((node) => node.attributes?.['data-question'] === 'q-1')), /Copilot asks.*needed to finish.*Who signs off the PCI review\?/);

  // Preview draws the workflow as the proposal would leave it, without accepting it.
  byKey(main, 'build-preview-p-1').listeners.click();
  assert.deepEqual(posted.at(-1), { type: 'studio.build.preview', build: view.build.id, proposal: 'p-1' });
  const preview = json(root, ['workflow', 'build', 'check', '--build', view.build.id, '--include', 'p-1', '--json']);
  send({ type: 'studio.buildPreview', build: view.build.id, proposal: 'p-1', result: preview });
  main = draw();
  assert.match(textOf(byKey(main, 'build-previewing')), /Preview with Four steps from release-captain/);
  assert.match(textOf(byKey(main, 'build-step-pay-pci-review')), /PCI review.*would be added.*Architect · writes a document.*Signed off by Payments security/);
  assert.match(textOf(byKey(main, 'build-summary')), /^4 steps/);
  assert.equal(byKey(main, 'build-ready'), null, 'a preview is never offered for finishing');

  byKey(main, 'build-accept-p-1').listeners.click();
  assert.deepEqual(posted.at(-1), { type: 'studio.build.decide', build: view.build.id, proposal: 'p-1', accept: true });
  json(root, ['workflow', 'build', 'answer', '--build', view.build.id, '--question', 'q-1', '--choice', 'payments-security', '--json']);
  const accepted = json(root, ['workflow', 'build', 'decide', '--build', view.build.id, '--proposal', 'p-1', '--accept', '--json']);
  send({ type: 'studio.build', build: view.build.id, view: accepted, checking: true });
  send({ type: 'studio.buildChecked', build: view.build.id, result: json(root, ['workflow', 'build', 'check', '--build', view.build.id, '--json']) });
  main = draw();
  assert.equal(page.buildState().preview, null, 'accepting ends the preview');
  assert.match(textOf(byKey(main, 'build-step-pay-build')), /Build.*new.*Developer · changes code/);
  assert.match(textOf(byKey(main, 'build-ready')), /Ready to finish/);
  assert.match(textOf(main), /Answered: payments-security/);

  // Explaining one step offers your own changes to it.
  byKey(main, 'build-step-pay-pci-review').listeners.click();
  main = draw();
  assert.match(textOf(nodes(main).find((node) => node.attributes?.['data-step'] === 'pay-pci-review')), /Why: Nothing ships without a PCI check signed off by security\./);
  byKey(main, 'build-move-up').listeners.click();
  const moved = JSON.parse(posted.at(-1).proposal);
  assert.deepEqual([posted.at(-1).type, moved.moves], ['studio.build.mine', [{ move: 'step.move', id: 'pay-pci-review', after: 'requirements' }]]);
  assert.equal(byKey(main, 'build-move-down').disabled, true, 'the last step cannot move later');

  // A change Copilot records while you are elsewhere in Studio waits for you; it does not pull you back.
  send({ type: 'studio.buildCancelled' });
  page.state().view = 'agents';
  send({ type: 'studio.build', build: view.build.id, view: accepted, checking: false, status: 'The build changed: Copilot recorded something new.' });
  assert.equal(page.state().view, 'agents');
  page.state().view = 'build';
  byKey(draw(), 'build-move-up').listeners.click();

  // While a change runs the page waits; the host's answer frees it.
  assert.equal(byKey(draw(), 'build-accept-p-1'), null);
  assert.equal(page.buildState().busy, 'mine');
  send({ type: 'studio.buildCancelled' });

  // Finish: ready, and the button says what it does for this authority.
  page.buildState().tab = 'finish';
  main = draw();
  assert.match(textOf(byKey(main, 'build-finish-ready')), /^Ready:/);
  assert.match(textOf(main), /New steps.*Build, PCI review/, 'what finishing adds is named as people name it');
  assert.match(textOf(main), /New approval groups.*Payments security/);
  assert.ok(!byKey(main, 'build-finish-publish').disabled);
  assert.match(textOf(byKey(main, 'build-finish-publish')), /Write the files/);
  byKey(main, 'build-finish-file').listeners.click();
  assert.deepEqual(posted.at(-1), { type: 'studio.build.finish', build: view.build.id, how: 'file' });

  // Once its workflow is active the build is done: no more deciding here, and changing it is a new build.
  send({ type: 'studio.buildCancelled' });
  const done = json(root, ['workflow', 'build', 'check', '--build', view.build.id, '--json']);
  send({ type: 'studio.buildChecked', build: view.build.id, result: { ...done, ready: false, landed: { workflow: 'payments-release', label: 'Payments release', finishedAt: done.build.updatedAt } } });
  assert.match(textOf(byKey(draw(), 'build-landed')), /^Finished: Payments release is in the approved configuration\./);
  page.buildState().tab = 'build';
  main = draw();
  assert.equal(byKey(main, 'build-add-step'), null);
  assert.equal(byKey(main, 'build-ready'), null);
  byKey(main, 'build-from-landed').listeners.click();
  assert.deepEqual(posted.at(-1), { type: 'studio.build.start', build: view.build.id, from: 'workflow', workflow: 'payments-release', name: null });
});

test('without Copilot the build goes on by hand: add a step, leave out what was found, read the lines', async () => {
  const { buildStudioModel } = await import('../src/workflow-studio.mjs');
  const { root, team, json } = await harness();
  const { page, posted, send, draw } = studio(await buildStudioModel(root));
  page.openBuilds();
  const view = json(root, ['workflow', 'build', 'start', '--folder', team, '--json']);
  send({ type: 'studio.build', build: view.build.id, view, checking: true, modelAvailable: false });
  send({ type: 'studio.buildChecked', build: view.build.id, result: json(root, ['workflow', 'build', 'check', '--build', view.build.id, '--json']) });
  let main = draw();
  assert.equal(byKey(main, 'build-chat'), null);
  assert.match(textOf(byKey(main, 'build-model-off')), /Copilot is off in this window/);
  assert.match(textOf(byKey(main, 'build-no-steps')), /No steps yet/);
  assert.match(textOf(byKey(main, 'build-not-ready')), /It has no steps yet\./);

  byKey(main, 'build-add-step').listeners.click();
  Object.assign(page.buildState().addStep, { label: 'Release notes', agent: 'product-owner', purpose: 'Tells support what changed.' });
  main = draw();
  byKey(main, 'build-step-add').listeners.click();
  const added = posted.at(-1);
  assert.equal(added.type, 'studio.build.mine');
  assert.deepEqual(JSON.parse(added.proposal), { title: 'Add Release notes', why: 'Tells support what changed.', moves: [
    { move: 'step.add', id: 'release-notes', label: 'Release notes', after: null, agent: 'product-owner', output: 'document', signOff: 'none', purpose: 'Tells support what changed.' }] });
  // The engine accepts your own change as it records it.
  const mine = json(root, ['workflow', 'build', 'propose', '--build', view.build.id, '--proposal', '-', '--by', 'you', '--accept', '--json'], added.proposal);
  assert.equal(mine.build.proposals[0].status, 'accepted');

  page.buildState().tab = 'found';
  send({ type: 'studio.build', build: view.build.id, view: mine, checking: false });
  main = draw();
  assert.match(textOf(byKey(main, 'build-found-summary')), /Read 2 files/);
  const runbook = mine.build.items.find((item) => item.kind === 'document');
  assert.match(textOf(nodes(main).find((node) => node.attributes?.['data-item'] === runbook.id)), /^document docs\/runbook\.md/, 'each item is tagged with its kind, in the singular');
  byKey(main, `build-leave-open-${runbook.id}`).listeners.click();
  page.buildState().leaving[runbook.id] = 'Support keeps its own runbook.';
  main = draw();
  byKey(main, `build-leave-confirm-${runbook.id}`).listeners.click();
  assert.deepEqual(JSON.parse(posted.at(-1).proposal).moves, [{ move: 'item.leaveOut', item: runbook.id, reason: 'Support keeps its own runbook.' }]);
  // Evidence opens the lines as captured, beside the list.
  const evidence = nodes(main).find((node) => node.tag === 'button' && /docs\/runbook\.md/.test(textOf(node)));
  evidence.listeners.click();
  assert.deepEqual(posted.at(-1), { type: 'studio.build.source', build: view.build.id, path: 'docs/runbook.md', from: 1 });
  send({ type: 'studio.buildSource', build: view.build.id, path: 'docs/runbook.md', result: json(root, ['workflow', 'build', 'source', '--build', view.build.id, '--path', 'docs/runbook.md', '--json']) });
  assert.match(textOf(draw()), /1# Runbook/);
});

test('every move reads as a plain sentence', async () => {
  const { buildStudioModel } = await import('../src/workflow-studio.mjs');
  const { root } = await harness();
  const { page } = studio(await buildStudioModel(root));
  const said = (move) => page.moveText(move);
  // Steps are named as the repository names them.
  const design = page.state().draft.phases.design.label;
  assert.equal(said({ move: 'step.remove', id: 'design' }), `Remove ${design} from this workflow`);
  assert.equal(said({ move: 'step.move', id: 'design', after: null }), `Move ${design} to the start`);
  assert.equal(said({ move: 'step.change', id: 'design', purpose: 'x', signOff: 'none' }), `Change ${design}: what it is for, sign-off`);
  assert.equal(said({ move: 'step.add', id: 'pr-triage', label: 'Triage', from: 'intake', after: null }), 'Add the step Triage (a copy of Intake) at the start');
  assert.equal(said({ move: 'agent.add', id: 'pay-reviewer', label: 'Payments reviewer', description: 'x', from: 'architect' }), 'Add the agent Payments reviewer, starting from Architect');
  assert.equal(said({ move: 'skill.attach', skill: 'pci-check', agent: 'architect', steps: ['design'] }), `Attach the skill pci-check to Architect for ${design}`);
  assert.equal(said({ move: 'decision.add', after: 'design', kind: 'branch', label: 'Risky?' }), `Add a decision after ${design}: Risky?`);
  assert.equal(said({ move: 'action.add', step: 'design', on: 'approved', target: 'team-events' }), `Tell team-events when ${design} is approved`);
  assert.equal(said({ move: 'item.keepAsLink', item: 'i-unknown' }), 'Keep i-unknown as a link');
});

test('the chat tool reads and records for the open build only, and has nothing that accepts, answers or finishes', async () => {
  assert.deepEqual(studioPage.studioBuildArgs('check', 'wb_0123456789abcdef', ['--include', 'p-2']), ['workflow', 'build', 'check', '--build', 'wb_0123456789abcdef', '--include', 'p-2', '--json']);
  assert.equal(studioPage.buildChatQuery('wb_0123456789abcdef', true), '/sf-build-workflow --build wb_0123456789abcdef #sflowWorkflowBuilder ');
  assert.equal(studioPage.buildChatQuery('wb_0123456789abcdef', false), '/sf-build-workflow --build wb_0123456789abcdef ');
  assert.deepEqual(studioPage.buildsForRepository([{ id: 'a', repository: { root: '/r' } }, { id: 'b', repository: null }, { id: 'c', repository: { root: '/other' } }], (root) => root === '/r').map((build) => build.id), ['a', 'b']);
  for (const [input, refusal] of [
    [{ action: 'decide', build: 'wb_0123456789abcdef' }, /person in Workflow Studio/],
    [{ action: 'answer', build: 'wb_0123456789abcdef' }, /person in Workflow Studio/],
    [{ action: 'state', build: '../wb' }, /build ID/],
    [{ action: 'state', build: 'wb_0123456789abcdef', path: 'x' }, /does not take path/],
    [{ action: 'source', build: 'wb_0123456789abcdef' }, /captured file's path/],
    [{ action: 'asset', build: 'wb_0123456789abcdef', kind: 'secret', id: 'x' }, /kind is one of/],
    [{ action: 'ask', build: 'wb_0123456789abcdef', questions: [] }, /1 to 8 questions/]
  ]) assert.throws(() => tool.builderToolInput(input), refusal);

  const { buildStudioModel } = await import('../src/workflow-studio.mjs');
  const { root, team, json } = await harness();
  const model = await buildStudioModel(root);
  const view = json(root, ['workflow', 'build', 'start', '--folder', team, '--json']);
  const recorded = [];
  const runner = {
    run: async (args) => json(root, args), runWithInput: async (args, input) => json(root, args, input), model: () => model, recorded: (value) => recorded.push(value)
  };
  const ask = (input) => tool.answerBuilderTool(tool.builderToolInput({ build: view.build.id, ...input }), runner);
  const state = await ask({ action: 'state' });
  assert.deepEqual(Object.keys(state).sort(), ['build', 'counts', 'explanation', 'findings', 'guide', 'items', 'proposals', 'questions', 'ready', 'recent', 'untrusted', 'workflow']);
  assert.ok(state.items.some((item) => item.kind === 'process' && item.evidence[0].path === '.github/agents/release-captain.agent.md'));
  assert.equal((await ask({ action: 'source', path: 'docs/runbook.md', from: 3 })).lines[0].startsWith('curl -X POST'), true);
  const catalog = await ask({ action: 'catalog', kind: 'agent', query: 'architect' });
  assert.ok(catalog.catalog.agents.entries.some((entry) => entry.id === 'architect'));
  assert.ok(catalog.catalog.agents.entries.every((entry) => /architect/i.test(`${entry.id} ${entry.label} ${entry.description}`)));
  assert.deepEqual(Object.keys(catalog.catalog), ['agents'], 'one kind, when asked for one');
  assert.equal((await ask({ action: 'asset', kind: 'agent', id: 'architect' })).asset.id, 'architect');
  await assert.rejects(ask({ action: 'asset', kind: 'agent', id: 'nobody' }), /has no agent 'nobody'/);
  const answer = await ask({ action: 'propose', proposal: FIRST });
  assert.deepEqual(answer.recorded, { proposal: { id: 'p-1', title: 'Four steps from release-captain' }, questions: [{ id: 'q-1', question: 'Who signs off the PCI review?' }] });
  assert.equal(recorded.length, 1, 'Workflow Studio redraws the build');
  const questions = await ask({ action: 'ask', questions: [{ question: 'Is release notes a step?', choices: ['yes', 'no'], blocking: false }] });
  assert.deepEqual(questions.recorded, { questions: [{ id: 'q-2', question: 'Is release notes a step?' }] });
  assert.equal(json(root, ['workflow', 'build', 'status', '--build', view.build.id, '--json']).build.proposals[0].status, 'pending', 'nothing the tool does accepts');

  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'apps/vscode/package.json'), 'utf8'));
  const declared = manifest.contributes.languageModelTools.find((entry) => entry.name === tool.WORKFLOW_BUILDER_TOOL);
  assert.equal(declared.toolReferenceName, 'sflowWorkflowBuilder');
  assert.equal(declared.when, 'singularityFlow.workflowBuildOpen');
  assert.deepEqual(declared.inputSchema.properties.action.enum, ['state', 'source', 'catalog', 'asset', 'propose', 'ask']);
});
