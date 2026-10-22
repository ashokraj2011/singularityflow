import { pathToFileURL } from 'node:url';
import { repositoryOwnedWorkflows, requirementsTemplatePlansCode } from './helpers/repository-owned-workflows.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const studioPage = await import(pathToFileURL(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio-page.ts')).href);
const { WORKFLOW_STUDIO_SCRIPT, STUDIO_FOCUS_VIEWS } = studioPage;
const tool = await import(pathToFileURL(path.join(packageRoot, 'apps/vscode/src/views/workflow-builder-tool.ts')).href);

const TEAM = {
  '.github/agents/release-captain.agent.md': ['---', 'name: release-captain', 'description: Runs a payments release.', '---', '', '1. Intake the change.',
    '2. Build it and run `npm test`.', '3. PCI review: it must be signed off by security.', '4. Release.', ''].join('\n'),
  'docs/runbook.md': ['# Runbook', '```sh', "curl -X POST https://jira.example.com/rest/api/2/issue/$KEY/transitions -d '{}'", '```', ''].join('\n')
};

async function harness(files = TEAM) {
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
  await requirementsTemplatePlansCode(root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  const team = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-view-team-'));
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

test('what is not used yet is settled with one change: links and documents kept as links, the rest left out with one reason', async () => {
  const { buildStudioModel } = await import('../src/workflow-studio.mjs');
  const { root, team, json } = await harness();
  const { page, posted, send, draw } = studio(await buildStudioModel(root));
  page.openBuilds();
  const started = json(root, ['workflow', 'build', 'start', '--folder', team, '--json']);
  send({ type: 'studio.build', build: started.build.id, view: started, checking: false, modelAvailable: false });
  send({ type: 'studio.buildChecked', build: started.build.id, result: json(root, ['workflow', 'build', 'check', '--build', started.build.id, '--json']) });
  page.buildState().tab = 'found';
  assert.match(textOf(byKey(draw(), 'build-settle')), /Once the workflow has its steps, what it does not use can be settled here in one go\./u);
  assert.equal(byKey(draw(), 'build-settle-open'), null, 'nothing is left out before a step could use it');
  const view = json(root, ['workflow', 'build', 'propose', '--build', started.build.id, '--proposal', '-', '--by', 'you', '--accept', '--json'], JSON.stringify(FIRST));
  send({ type: 'studio.build', build: view.build.id, view, checking: false });
  send({ type: 'studio.buildChecked', build: view.build.id, result: json(root, ['workflow', 'build', 'check', '--build', view.build.id, '--json']) });
  const open = view.build.items.filter((item) => item.status === 'open' && item.kind !== 'withheld');
  const kept = open.filter((item) => ['link', 'document', 'api-call', 'tool', 'script'].includes(item.kind));
  assert.ok(kept.length && kept.length < open.length, JSON.stringify(open.map((item) => item.kind)));
  let main = draw();
  assert.match(textOf(byKey(main, 'build-settle')), new RegExp(`^${open.length} things found are not used or left out yet\\.`, 'u'));
  byKey(main, 'build-settle-open').listeners.click();
  main = draw();
  const others = open.length - kept.length;
  assert.match(textOf(byKey(main, 'build-settle')), new RegExp(`${kept.length} links and documents are kept as links for people to open; ${others} others? (?:is|are) left out with the reason you give \\(\\d+ [a-z -]+(?:, \\d+ [a-z -]+)*\\)\\.`, 'u'));
  const before = posted.length;
  byKey(main, 'build-settle-confirm').listeners.click();
  assert.equal(posted.length, before, 'leaving things out needs a reason');
  page.buildState().settling = 'The release captain does these by hand.';
  byKey(draw(), 'build-settle-confirm').listeners.click();
  const settle = posted.at(-1);
  assert.equal(settle.type, 'studio.build.mine');
  const proposal = JSON.parse(settle.proposal);
  assert.equal(proposal.title, `Settle ${open.length} found things`);
  assert.deepEqual(proposal.moves, [...kept.map((item) => ({ move: 'item.keepAsLink', item: item.id })),
    ...open.filter((item) => !kept.includes(item)).map((item) => ({ move: 'item.leaveOut', item: item.id, reason: 'The release captain does these by hand.' }))]);
  const mine = json(root, ['workflow', 'build', 'propose', '--build', view.build.id, '--proposal', '-', '--by', 'you', '--accept', '--json'], settle.proposal);
  assert.deepEqual(mine.build.items.filter((item) => item.status === 'open'), []);
  const checked = json(root, ['workflow', 'build', 'check', '--build', view.build.id, '--json']);
  assert.equal(checked.findings.find((entry) => entry.code === 'BUILD_ITEMS_OPEN'), undefined);
  send({ type: 'studio.build', build: view.build.id, view: mine, checking: false });
  assert.equal(byKey(draw(), 'build-settle'), null, 'nothing is left to settle');
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
  // Where rejected work goes back to is said in the step's own words.
  const requirements = page.state().draft.phases.requirements.label;
  const architects = page.state().draft.groups['architecture-reviewers'].label;
  assert.equal(said({ move: 'step.change', id: 'design', signOff: { groups: ['architecture-reviewers'], minimum: 1, sendBackTo: ['requirements', 'design'] } }),
    `Change ${design}: sign-off (if rejected, back to ${requirements} or ${design})`);
  assert.equal(said({ move: 'step.add', id: 'pay-review', label: 'Review', after: 'design', agent: 'architect', signOff: { groups: ['architecture-reviewers'], sendBackTo: ['design'] } }),
    `Add the step Review after ${design}, drafted by Architect, signed off by ${architects}; if rejected, back to ${design}`);
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
    [{ action: 'guide', build: 'wb_0123456789abcdef', from: 2 }, /does not take from/],
    [{ action: 'items', build: 'wb_0123456789abcdef', from: 0 }, /item number \(items\), 1 or more/],
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
    run: async (args) => json(root, args), runWithInput: async (args, input) => json(root, args, input), model: () => model, recorded: (value, status) => recorded.push([value, status])
  };
  const ask = (input) => tool.answerBuilderTool(tool.builderToolInput({ build: view.build.id, ...input }), runner);
  const state = await ask({ action: 'state' });
  assert.deepEqual(Object.keys(state).sort(), ['build', 'counts', 'explanation', 'findings', 'guide', 'items', 'proposals', 'questions', 'ready', 'recent', 'untrusted', 'workflow']);
  assert.ok(state.items.some((item) => item.kind === 'process' && item.evidence[0].path === '.github/agents/release-captain.agent.md'));
  // The moves guide is read once per chat, not with every state (a live run's state was 21 KB).
  assert.match(state.guide, /\{ action: 'guide' \} once per chat, before your first proposal/);
  const { guide } = await ask({ action: 'guide' });
  assert.ok(guide.moves['step.add'] && guide.proposal.evidence && guide.rules.length, 'the whole guide, as the build commands give it');
  assert.equal((await ask({ action: 'source', path: 'docs/runbook.md', from: 3 })).lines[0].startsWith('curl -X POST'), true);
  const catalog = await ask({ action: 'catalog', kind: 'agent', query: 'architect' });
  assert.ok(catalog.catalog.agents.entries.some((entry) => entry.id === 'architect'));
  assert.ok(catalog.catalog.agents.entries.every((entry) => /architect/i.test(`${entry.id} ${entry.label} ${entry.description}`)));
  assert.deepEqual(Object.keys(catalog.catalog), ['agents'], 'one kind, when asked for one');
  // A code step needs one of these before it; Copilot could not tell which steps they were.
  const steps = (await ask({ action: 'catalog', kind: 'step' })).catalog.phases.entries;
  assert.equal(steps.find((entry) => entry.id === 'requirements')?.definesRequirements, true);
  assert.equal(steps.find((entry) => entry.id === 'intake')?.definesRequirements, undefined);
  assert.equal((await ask({ action: 'asset', kind: 'agent', id: 'architect' })).asset.id, 'architect');
  await assert.rejects(ask({ action: 'asset', kind: 'agent', id: 'nobody' }), /has no agent 'nobody'/);
  const answer = await ask({ action: 'propose', proposal: FIRST });
  assert.deepEqual(answer.recorded, { proposal: { id: 'p-1', title: 'Four steps from release-captain' }, questions: [{ id: 'q-1', question: 'Who signs off the PCI review?' }] });
  assert.equal(recorded.length, 1, 'Workflow Studio redraws the build');
  assert.equal(recorded[0][1], 'Copilot proposed "Four steps from release-captain" and asked a question. Accept or decline it, and answer, here.');
  // A waiting proposal keeps its moves in state; a refused one says where each move's fields are.
  const waiting = (await ask({ action: 'state' })).proposals[0];
  assert.deepEqual([waiting.status, waiting.moves], ['pending', FIRST.moves]);
  await assert.rejects(ask({ action: 'propose', proposal: { title: 'Fly', why: 'x', moves: [{ move: 'step.fly', id: 'fly' }] } }), /must name one of: step\.add[\s\S]*Each move's fields and the rules: \{ action: 'guide' \}\.$/);
  assert.equal(recorded.length, 1, 'a refused proposal records nothing');
  const questions = await ask({ action: 'ask', questions: [{ question: 'Is release notes a step?', choices: ['yes', 'no'], blocking: false }] });
  assert.deepEqual(questions.recorded, { questions: [{ id: 'q-2', question: 'Is release notes a step?' }] });
  // Live run 2026-10-18: questions alone were announced as "Copilot recorded a proposal."
  assert.equal(recorded[1][1], 'Copilot asked a question. Answer here.');
  assert.equal(tool.builderRecordedStatus({ proposal: { title: 'PCI gate' }, questions: [] }), 'Copilot proposed "PCI gate". Accept or decline it here.');
  assert.equal(tool.builderRecordedStatus({ questions: [{}, {}] }), 'Copilot asked 2 questions. Answer here.');
  // Each request says what it does while it runs, from its own input; a malformed one still gets a line.
  for (const [input, line] of [
    [{ action: 'state', build: view.build.id }, /^Reading the workflow build/u],
    [{ action: 'guide', build: view.build.id }, /^Reading the moves guide/u],
    [{ action: 'items', build: view.build.id, from: 12 }, /^Reading what was found in the material, from item 12\.$/u],
    [{ action: 'source', build: view.build.id, path: 'docs/runbook.md', from: 3 }, /^Reading docs\/runbook\.md from line 3, as the build captured it\.$/u],
    [{ action: 'catalog', build: view.build.id, kind: 'step', query: 'release' }, /^Searching what the repository has: steps matching "release"\.$/u],
    [{ action: 'asset', build: view.build.id, kind: 'agent', id: 'architect' }, /^Reading the repository's agent architect\.$/u],
    [{ action: 'propose', build: view.build.id, proposal: { title: 'PCI gate' } }, /^Recording the proposal "PCI gate" for you to accept or decline in Workflow Studio\.$/u],
    [{ action: 'ask', build: view.build.id, questions: [{}, {}] }, /^Asking you 2 questions in Workflow Studio\.$/u],
    [null, /^Reading the workflow build, or recording a proposal/u]
  ]) assert.match(tool.builderInvocationMessage(input), line, JSON.stringify(input));
  assert.equal(json(root, ['workflow', 'build', 'status', '--build', view.build.id, '--json']).build.proposals[0].status, 'pending', 'nothing the tool does accepts');

  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'apps/vscode/package.json'), 'utf8'));
  const declared = manifest.contributes.languageModelTools.find((entry) => entry.name === tool.WORKFLOW_BUILDER_TOOL);
  assert.equal(declared.toolReferenceName, 'sflowWorkflowBuilder');
  assert.equal(declared.when, 'singularityFlow.workflowBuildOpen');
  assert.deepEqual(declared.inputSchema.properties.action.enum, ['state', 'guide', 'items', 'source', 'catalog', 'asset', 'propose', 'ask']);
  assert.match(declared.modelDescription, /guide returns the moves guide .*: read it once per chat before your first proposal; items lists found items/);
  const skill = await readFile(path.join(packageRoot, 'plugin/skills/sflow-build-workflow/SKILL.md'), 'utf8');
  assert.match(skill, /`guide` \(once per chat, before your first proposal\), `items` \(when `state` has `moreItems`\)/);
});

// A build like the one in the live Copilot Chat run (2026-10-18): a team folder with two agents, a
// skill and a runbook; one accepted seven-step proposal and three questions.
const LIVE_TEAM = {
  '.github/agents/release-captain.agent.md': ['---', 'name: release-captain', 'description: Runs a payments release from intake to production.', "tools: ['runCommands', 'editFiles']", '---', '',
    '# Release captain', '', 'You own a payments release end to end.', '',
    '1. Intake the change and write down what it is for.', '2. Agree the requirements with the product owner.',
    '3. Design it with the architect, then implement it and run `npm test` and `npm run lint`.', '4. PCI review: use /pci-check; it must be signed off by security.', '5. Release once QA and security agree.', ''].join('\n'),
  '.github/agents/architect.agent.md': ['---', 'name: architect', 'description: Designs payment changes and their card-data flow.', '---', '',
    'Review every design for card-data flow and PCI scope.', 'Write the design down before implementation starts.', ''].join('\n'),
  'skills/pci-check/SKILL.md': ['---', 'name: pci-check', 'description: Checks a change against the PCI rules.', '---', '',
    'Check that card data never reaches logs and that every new endpoint is behind authentication.', 'The PCI review must be signed off by security before release.', ''].join('\n'),
  'docs/runbook.md': ['# Payments runbook', '', '## Build and test', '', '```sh', 'npm ci', 'npm test', 'npm run lint', '```', '', '## Ticket', '',
    'Move the ticket when the release is out:', '', '```sh', "curl -X POST https://jira.example.com/rest/api/2/issue/$KEY/transitions -d '{\"transition\":{\"id\":\"31\"}}'", '```', ''].join('\n')
};
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

test('state of a build like the live run is read inline, with everything Copilot proposes from', async () => {
  const { root, team, json } = await harness(LIVE_TEAM);
  const view = json(root, ['workflow', 'build', 'start', '--folder', team, '--name', 'Payments release', '--json']);
  const build = view.build.id;
  const propose = (payload) => json(root, ['workflow', 'build', 'propose', '--build', build, '--proposal', '-', '--by', 'copilot', '--json'], JSON.stringify(payload));
  propose({ questions: [
    { question: 'Which approval group signs off the PCI review?', choices: ['A new Payments security approvers group', 'quality-reviewers', 'architecture-reviewers'], blocking: true },
    { question: 'Should the Jira transition in the runbook run after release, or stay a link people follow?', choices: ['Keep it as a link', 'Run it after release once a target is registered'], blocking: false }
  ] });
  json(root, ['workflow', 'build', 'answer', '--build', build, '--question', 'q-1', '--choice', 'A new Payments security approvers group', '--json']);
  const found = view.build.items;
  const captain = found.find((item) => item.kind === 'agent' && item.name === 'release-captain');
  propose({
    title: 'Payments release from release-captain, with a PCI review signed off by security',
    why: 'release-captain numbers intake, requirements, design, implementation, a PCI review signed off by security, and release. The repository has steps for all but the PCI review, which QA drafts with the pci-check skill.',
    moves: [
      { move: 'group.add', id: 'payments-security-approvers', label: 'Payments security approvers' },
      ...['intake', 'requirements', 'design', 'implementation-spec', 'implementation'].map((id, index, steps) => ({ move: 'step.add', id, after: steps[index - 1] ?? null })),
      { move: 'step.add', id: 'pay-pci-review', label: 'PCI review', after: 'implementation', agent: 'qa', output: 'document', reads: ['implementation'],
        signOff: { groups: ['payments-security-approvers'], minimum: 1 }, purpose: 'Checks the change against the PCI rules; security signs it off before release.' },
      { move: 'skill.add', id: 'pci-check', description: 'Checks a change against the PCI rules.', procedure: 'Check that card data never reaches logs and that every new endpoint is behind authentication.' },
      { move: 'skill.attach', skill: 'pci-check', agent: 'qa', steps: ['pay-pci-review'] },
      { move: 'step.add', id: 'release', after: 'pay-pci-review' },
      ...found.map((item) => item === captain ? { move: 'item.leaveOut', item: item.id, reason: 'The steps come from its numbered list; the repository agents draft them, so release-captain is not added as an agent.' }
        : item.kind === 'api-call' ? { move: 'item.keepAsLink', item: item.id }
        : { move: 'item.classify', item: item.id, as: item.kind === 'process' ? 'prompt' : item.kind })
    ],
    evidence: [{ path: '.github/agents/release-captain.agent.md', startLine: 11, endLine: 15 }, { path: 'skills/pci-check/SKILL.md', startLine: 6, endLine: 7 },
      { path: 'docs/runbook.md', startLine: 3, endLine: 9 }, { path: 'docs/runbook.md', startLine: 11, endLine: 17 }, { path: '.github/agents/architect.agent.md', startLine: 6, endLine: 7 }],
    items: found.map((item) => item.id)
  });
  json(root, ['workflow', 'build', 'decide', '--build', build, '--proposal', 'p-1', '--accept', '--json']);
  propose({ questions: [{ question: 'Release can send a Story back to specification, planning, convergence and verification, which this workflow does not have. Where should a rejected release go?',
    choices: ['Implementation', 'PCI review', 'Requirements'], blocking: true }] });

  const read = [];
  const runner = { run: async (args) => { const result = json(root, args); read.push(result); return result; }, runWithInput: async () => assert.fail('nothing is recorded'), model: () => null, recorded: () => {} };
  const ask = (input) => tool.answerBuilderTool(tool.builderToolInput({ build, ...input }), runner);
  const state = await ask({ action: 'state' });
  const [status, check] = read;
  // Before it was cut down, state was 20,413 bytes here (guide 4,306, items 3,852, explanation 3,680,
  // findings 3,372, proposals 2,177). Copilot Chat writes a text part longer than 8,192 characters
  // (chat.agent.largeToolResultsToDisk.thresholdBytes) to content.json, and Copilot read that back in pieces.
  assert.ok(bytes({ ...status.build, ...check }) > 3 * tool.BUILDER_ANSWER_BYTES, 'the build holds far more than state says');
  assert.ok(bytes(state) <= tool.BUILDER_ANSWER_BYTES, `state is ${bytes(state)} bytes`);
  assert.equal(state.moreItems, undefined, 'every found item is in state');
  assert.doesNotMatch(JSON.stringify(state), /sha256|createdAt|"at":/, 'no hashes or times');

  // Found items: the accepted proposal used or settled each one, so none is open. A used one keeps the lines
  // source reads; a settled one says how it was settled.
  assert.equal(state.items.length, found.length);
  assert.deepEqual(state.items.filter((item) => item.status === 'open'), [], 'a classified item the proposal lists is used');
  const used = state.items.filter((item) => item.status === 'confirmed');
  assert.equal(used.length, found.length - 2);
  for (const item of used) assert.deepEqual(item.evidence, found.find((entry) => entry.id === item.id).evidence.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })));
  assert.deepEqual(state.items.find((item) => item.id === captain.id), { id: captain.id, kind: 'agent', name: 'release-captain', status: 'left-out',
    reason: 'The steps come from its numbered list; the repository agents draft them, so release-captain is not added as an agent.' });
  // A decided proposal is its title and status: its moves are the workflow now.
  assert.deepEqual(state.proposals, [{ id: 'p-1', by: 'copilot', title: 'Payments release from release-captain, with a PCI review signed off by security', status: 'accepted' }]);
  assert.deepEqual(state.questions.map((question) => [question.id, question.answer ?? question.choices.length, question.blocking]),
    [['q-1', 'A new Payments security approvers group', undefined], ['q-2', 2, false], ['q-3', 3, true]]);
  // Copilot asked last: what happened before is in the proposals and questions above.
  assert.deepEqual(state.recent, []);

  // The workflow: seven steps in order, what each does, its sign-off and where a rejection goes.
  assert.deepEqual(state.explanation.steps.map((step) => step.id), ['intake', 'requirements', 'design', 'implementation-spec', 'implementation', 'pay-pci-review', 'release']);
  assert.deepEqual(state.explanation.steps[5], { id: 'pay-pci-review', label: 'PCI review', agent: 'qa', what: 'Writes a document.', why: 'Checks the change against the PCI rules; security signs it off before release.',
    skills: ['pci-check'], reads: ['implementation'], signOff: 'Signed off by one person from Payments security approvers.', then: ['If it is rejected: it is redone.'] });
  assert.match(state.explanation.steps[6].then.join(' '), /back to Specification, Planning, Implementation, Convergence or Verification/);
  assert.deepEqual(state.workflow, { workflow: { id: 'payments-release', label: 'Payments release' }, newSteps: ['pay-pci-review'], newSkills: ['pci-check'], newGroups: ['payments-security-approvers'] });
  // Findings that differ only in detail are one, with each detail.
  const rejection = state.findings.find((finding) => finding.code === 'WORKFLOW_REJECTION_TARGET');
  assert.deepEqual([rejection.subject, rejection.details.length], [{ step: 'release' }, 4]);
  assert.deepEqual(rejection.fixMove, { move: 'step.change', id: 'release', signOff: { groups: ['quality-reviewers'], minimum: 1, sendBackTo: ['implementation', 'release'] } }, 'the one move that fixes it, to propose as it is');
  assert.equal(state.findings.filter((finding) => finding.code === 'WORKFLOW_REJECTION_TARGET').length, 1);
  assert.equal(state.findings.find((finding) => finding.code === 'BUILD_ITEMS_OPEN'), undefined, 'nothing found is left to propose about');
  assert.deepEqual(state.counts, { problem: 4, warning: 0, note: 1 });
  assert.equal(state.ready, false);

  // The guide and the items are each one inline answer too.
  const guide = await ask({ action: 'guide' });
  assert.deepEqual(guide, { guide: status.guide });
  assert.ok(bytes(guide) <= tool.BUILDER_ANSWER_BYTES, `guide is ${bytes(guide)} bytes`);
  const items = await ask({ action: 'items' });
  assert.deepEqual([items.from, items.of, items.items, items.next], [1, found.length, state.items, undefined]);
});

test('recent is what a person or SFlow did since Copilot last proposed or asked, without times', () => {
  const at = '2026-10-18T02:27:26.036Z';
  const conversation = [
    { at, by: 'sflow', kind: 'found', text: 'Read 4 files.' }, { at, by: 'you', kind: 'answer', text: 'Who signs off? security', question: 'q-1' },
    { at, by: 'copilot', kind: 'proposal', text: 'PCI gate', proposal: 'p-1' },
    { at, by: 'you', kind: 'decision', text: 'Declined PCI gate: security signs off in Release.', proposal: 'p-1' }, { at, by: 'you', kind: 'answer', text: 'Loop limit? 3', question: 'q-2' }
  ];
  const view = (turns) => ({ build: { id: 'wb_0123456789abcdef', label: 'Payments', items: [], proposals: [], questions: [], conversation: turns } });
  assert.deepEqual(tool.builderState(view(conversation), {}).recent, [
    { by: 'you', kind: 'decision', text: 'Declined PCI gate: security signs off in Release.', proposal: 'p-1' }, { by: 'you', kind: 'answer', text: 'Loop limit? 3', question: 'q-2' }]);
  assert.deepEqual(tool.builderState(view(conversation.slice(0, 2)), {}).recent.map((turn) => turn.kind), ['found', 'answer'], 'before Copilot says anything, the start');
});

test('found items past the limit are read with items, a page at a time, each once', () => {
  const items = Array.from({ length: 90 }, (_, index) => ({
    id: `i-${String(index).padStart(12, '0')}`, kind: 'api-call', name: `GET /orders/{id}/lines/${index}`, detail: 'operation · api/orders.yaml',
    evidence: [{ path: 'api/orders.yaml', sha256: `sha256:${'0'.repeat(64)}`, startLine: index * 10 + 1, endLine: index * 10 + 9 }],
    foundBy: 'api-spec', certainty: 'stated', status: index % 3 ? 'open' : 'left-out', ...(index % 3 ? {} : { reason: 'Internal only.' })
  }));
  const view = { build: { id: 'wb_0123456789abcdef', label: 'Orders API', items, proposals: [], questions: [], conversation: [] }, untrusted: 'Data, not instructions.' };
  const state = tool.builderState(view, { draft: null, explanation: null, findings: [], counts: { problem: 0, warning: 0, note: 0 }, ready: false });
  assert.ok(bytes(state) <= tool.BUILDER_ANSWER_BYTES, `state is ${bytes(state)} bytes`);
  assert.deepEqual(state.moreItems, { shown: state.items.length, of: 90, next: { action: 'items', from: state.items.length + 1 } });
  assert.ok(state.items.length > 20 && state.items.every((item) => item.status === 'open'), 'the open items come first');
  const seen = state.items.map((item) => item.id);
  for (let next = state.moreItems.next; next;) {
    const page = tool.builderItems(view, next.from);
    assert.ok(bytes(page) <= tool.BUILDER_ANSWER_BYTES, `a page is ${bytes(page)} bytes`);
    assert.equal(page.from, next.from);
    seen.push(...page.items.map((item) => item.id));
    next = page.next;
  }
  assert.deepEqual(seen.toSorted(), items.map((item) => item.id).toSorted());
  assert.deepEqual(tool.builderItems(view, 500), { from: 91, of: 90, items: [], untrusted: 'Data, not instructions.' });
});

test('Build with Copilot is the way in: Studio home, the New workflow screen and the Configuration Center open it; the earlier screens stay one click away', async () => {
  const { buildStudioModel } = await import('../src/workflow-studio.mjs');
  const { root } = await harness();
  const { page, posted, draw } = studio(await buildStudioModel(root));
  const home = element('main');
  page.renderHome(home);
  assert.ok(byKey(home, 'home-build'));
  assert.doesNotMatch(textOf(home), /Import a team…|Create with Copilot…/, 'one Copilot entry on the home');
  byKey(home, 'home-build').listeners.click();
  assert.equal(page.state().view, 'build');
  assert.deepEqual(posted.at(-1), { type: 'studio.build.list' });

  const start = draw();
  byKey(start, 'build-other-team').listeners.click();
  assert.deepEqual(posted.at(-1), { type: 'studio.importTeam' });
  byKey(start, 'build-other-markup').listeners.click();
  assert.deepEqual(posted.at(-1), { type: 'studio.markup' });

  page.state().view = 'new'; page.state().wizard = { label: '', from: null };
  const wizard = element('main');
  page.renderWizard(wizard);
  byKey(wizard, 'wizard-build-open').listeners.click();
  assert.deepEqual([page.state().view, page.state().wizard], ['build', null]);

  const center = await readFile(path.join(packageRoot, 'apps/vscode/src/views/configuration-center-page.ts'), 'utf8');
  assert.match(center, /\{ label: 'Build a workflow with Copilot', glyph: 'workflow', action: 'build-workflow' \}/);
  assert.doesNotMatch(center, /action: 'import-team'/);
  const extension = await readFile(path.join(packageRoot, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /message\.action === 'build-workflow'\) await vscode\.commands\.executeCommand\('singularityFlow\.openWorkflowStudio', \{ view: 'build' \}\)/);
});
