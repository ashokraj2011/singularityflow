/**
 * Workflow Studio and a marketplace that is a Git repository [owner, 2026-11-21: do the VS Code marketplace work].
 *
 * - Trust a marketplace offers a Git repository (an APM marketplace) as well as an index link. The host reads it with
 *   a dry run of `marketplace add --repo`; the page queues that exact pin, and the engine accepts the change set.
 *   A trusted one reads its newest commit the same way, as a reviewed change that moves the pin.
 * - Each agent of it has Make a workflow in place of a command line: the page shows the steps and what each is for,
 *   asks what a stage SFlow cannot classify is for with the engine's own choices, and, when ready, the host keeps the
 *   bundle with `workflow from-agent --propose` and starts Import… with it, so the person confirms the import as for
 *   any bundle. A workflow written to this repository opens on its canvas.
 *
 * The page runs as the webview runs it, with the engine's real answers (the simulated SDLC marketplace fixture).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { conversionReview } from '../src/conversion-review.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const FIXTURE = path.join(packageRoot, 'test', 'fixtures', 'sdlc-marketplace');
const { WORKFLOW_STUDIO_SCRIPT } = await import(pathToFileURL(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio-page.ts')).href);
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Studio Tester' };

function run(command, args, cwd, input = '') {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, input = '') => run(process.execPath, [bin, ...args], root, input);
const json = (root, args, input = '') => JSON.parse(flow(root, [...args, '--json'], input).stdout);

/** The page as the webview loads it, with a document just big enough to render a section, and what it posts. */
function studio(model) {
  const listeners = {};
  const posted = [];
  const element = (tag) => ({ tag, attributes: {}, children: [], style: {}, handlers: {}, textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; }, appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, handler) { this.handlers[type] = handler; } });
  const window = { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener(type, listener) { listeners[type] = listener; } };
  new Function('window', 'document', WORKFLOW_STUDIO_SCRIPT)(window, { getElementById: () => null, querySelector: () => null, createElement: element, createTextNode: (text) => ({ text }) });
  const send = (data) => listeners.message({ data });
  send({ type: 'studio.model', model });
  return { page: window.__workflowStudio, posted, send };
}
const text = (node) => [node.textContent ?? node.text ?? '', ...(node.children ?? []).map(text)].join(' ').replace(/\s+/gu, ' ');
const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
const buttons = (node) => all(node).filter((entry) => entry.tag === 'button');
const buttonNamed = (node, name) => {
  const found = buttons(node).find((entry) => text(entry).trim() === name);
  assert.ok(found, `a ${name} button in: ${buttons(node).map((entry) => text(entry).trim()).join(' | ')}`);
  return found;
};
const click = (node) => node.handlers.click();
const last = (posted, type) => posted.filter((message) => message.type === type).at(-1);

async function gitRepository(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Studio Tester'], ['config', 'user.email', 'studio@example.com']]) run('git', args, root);
  return root;
}

/** What WorkflowStudioPanel.marketplaceRead posts for the engine's dry run (apps/vscode/src/views/workflow-studio.ts). */
function hostRead(root, { id, repository, ref = '', label = '' }) {
  const result = json(root, ['marketplace', 'add', id, '--repo', repository, ...(ref ? ['--ref', ref] : []), ...(label ? ['--label', label] : []), '--dry-run']);
  assert.equal(result.valid, true, JSON.stringify(result.problems));
  const read = result.marketplace;
  return { type: 'studio.marketplaceRead', id, label: read.label ?? null, repository: read.repository, ref: read.ref ?? null, commit: read.commit,
    repin: read.repin === true, agents: read.agents ?? 0, skills: read.skills ?? 0 };
}
const answerFlags = (answers) => Object.entries(answers).flatMap(([step, intent]) => ['--answer', `${step}=${intent}`]);

test('a Git repository marketplace is trusted from Workflow Studio at the commit read now, and its agent becomes a workflow there', async () => {
  const market = await gitRepository('sflow-studio-mkt-');
  await cp(FIXTURE, market, { recursive: true });
  run('git', ['add', '-A'], market); run('git', ['commit', '-m', 'catalog'], market);
  const pinned = run('git', ['rev-parse', 'HEAD'], market).stdout.trim();
  const root = await gitRepository('sflow-studio-mkt-repo-');
  try {
    await writeFile(path.join(root, 'README.md'), '# Shop\n');
    flow(root, ['init']);
    // Version 4, so the imported workflow's steps carry what each is for.
    const workflowFile = path.join(root, 'singularity', 'workflow.yml');
    const document = YAML.parseDocument(await readFile(workflowFile, 'utf8'));
    document.set('version', 4);
    await writeFile(workflowFile, document.toString());
    run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);

    // Trust a marketplace opens on a Git repository; the page asks the host to read it and queues nothing yet.
    let { page, posted, send } = studio(json(root, ['workflow', 'studio']));
    let section = page.renderMarketplaces(page.library());
    click(buttonNamed(section, 'Trust a marketplace'));
    const form = page.library().newMarket;
    assert.equal(form.kind, 'repository');
    section = page.renderMarketplaces(page.library());
    assert.match(text(section), /A Git repository of agents and skills \(APM\)/u);
    assert.match(text(section), /An https or ssh URL, or the folder of a clone on this computer\./u);
    assert.doesNotMatch(text(section), /Index link/u, 'the index fields show only for an index');
    Object.assign(form, { id: 'acme', repository: market });
    click(buttonNamed(section, 'Add to changes'));
    assert.deepEqual(last(posted, 'studio.marketplaceRead'), { type: 'studio.marketplaceRead', id: 'acme', label: '', repository: market, ref: '' });
    assert.deepEqual(page.state().draft.imports, [], 'nothing is queued until the repository is read');
    assert.equal(text(page.renderMarketplaces(page.library())).includes('Reading…'), true);

    // The host's read: the dry run names the commit, and the page queues exactly that pin.
    send(hostRead(root, { id: 'acme', repository: market }));
    assert.equal(page.library().newMarket, null);
    assert.equal(page.library().busy, null);
    assert.equal(page.state().status, 'Marketplace sdlc-marketplace (2 agents, 7 skills) will be trusted once you publish.');
    const changeSet = page.changeSetFrom(page.state().model, page.state().draft);
    assert.deepEqual(changeSet.changes, [{ op: 'marketplace.add', id: 'acme', repository: market, commit: pinned, label: 'sdlc-marketplace' }]);
    assert.equal(page.describe(changeSet.changes[0], page.state().draft), 'Trust marketplace sdlc-marketplace');
    assert.match(text(page.renderMarketplaces(page.library())), new RegExp(`${market.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} at ${pinned.slice(0, 12)} · trusted once you publish`, 'u'));
    // The engine accepts it, and publishing writes the pin.
    const checked = json(root, ['workflow', 'studio', 'apply', '--change-set', '-', '--dry-run'], JSON.stringify(changeSet));
    assert.equal(checked.valid, true, JSON.stringify(checked.problems));
    flow(root, ['workflow', 'studio', 'apply', '--change-set', '-'], JSON.stringify(changeSet));
    assert.deepEqual(YAML.parse(await readFile(workflowFile, 'utf8')).marketplaces.acme, { label: 'sdlc-marketplace', repository: market, commit: pinned });
    run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'trust the marketplace'], root);

    // Another ID for the same name is fine; the same ID for another repository is refused in the page, before any read.
    ({ page, posted, send } = studio(json(root, ['workflow', 'studio'])));
    page.readRepositoryMarketplace({ id: 'acme', repository: '/srv/elsewhere', ref: '', label: '' });
    assert.equal(page.state().status, 'This repository already trusts a marketplace called acme. Give this one another ID.');
    assert.equal(last(posted, 'studio.marketplaceRead'), undefined);

    // The marketplace moves on: Read its newest commit queues the moved pin as a reviewed change.
    await writeFile(path.join(market, 'NOTES.md'), 'A newer catalog.\n');
    run('git', ['add', '-A'], market); run('git', ['commit', '-m', 'notes'], market);
    const newest = run('git', ['rev-parse', 'HEAD'], market).stdout.trim();
    section = page.renderMarketplaces(page.library());
    click(buttonNamed(section, 'Read its newest commit'));
    assert.deepEqual(last(posted, 'studio.marketplaceRead'), { type: 'studio.marketplaceRead', id: 'acme', label: 'sdlc-marketplace', repository: market, ref: '' });
    send(hostRead(root, { id: 'acme', repository: market, label: 'sdlc-marketplace' }));
    assert.equal(page.state().status, 'Marketplace sdlc-marketplace will be read at its newest commit (2 agents, 7 skills) once you publish.');
    const moved = page.changeSetFrom(page.state().model, page.state().draft);
    assert.deepEqual(moved.changes, [{ op: 'marketplace.add', id: 'acme', repository: market, commit: newest, label: 'sdlc-marketplace', repin: true }]);
    const movedPlan = json(root, ['workflow', 'studio', 'apply', '--change-set', '-', '--dry-run'], JSON.stringify(moved));
    assert.equal(movedPlan.valid, true, JSON.stringify(movedPlan.problems));
    assert.ok(movedPlan.summary.some((line) => line.startsWith(`Marketplace sdlc-marketplace is now read at ${newest.slice(0, 12)}`)), movedPlan.summary.join('\n'));

    // Browse: each agent has Make a workflow, never a command line to copy.
    ({ page, posted, send } = studio(json(root, ['workflow', 'studio'])));
    const trusted = page.state().model.marketplaces.find((entry) => entry.id === 'acme');
    Object.assign(page.library(), { market: trusted, entries: json(root, ['marketplace', 'browse', 'acme']) });
    section = page.renderMarketplaces(page.library());
    assert.doesNotMatch(text(section), /As a workflow:|singularity-flow workflow from-agent/u);
    click(buttonNamed(section, 'Make a workflow'));
    const asked = last(posted, 'studio.agentWorkflowPreview');
    assert.deepEqual(asked, { type: 'studio.agentWorkflowPreview', target: 'acme/product-agent', answers: {} });

    // The product agent has stages SFlow asks about: each is a question with the engine's choices, answered by a click.
    const answers = {};
    for (let round = 0; round < 5; round += 1) {
      const result = json(root, ['workflow', 'from-agent', 'acme/product-agent', ...answerFlags(answers)]);
      send({ type: 'studio.agentWorkflowPreviewed', target: 'acme/product-agent', result });
      if (result.ready) break;
      const card = page.renderMarketplaces(page.library());
      const open = result.open[0];
      assert.match(text(card), new RegExp(open.question.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      for (const step of result.steps) assert.match(text(card), new RegExp(step.label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      assert.ok(!buttons(card).some((entry) => text(entry).trim() === 'Make this workflow'), 'nothing is made while a stage is open');
      const choice = open.choices.find((entry) => entry.intent === (open.step.endsWith('hand-off') ? 'report' : 'review')) ?? open.choices[0];
      click(buttonNamed(card, choice.label));
      answers[open.step] = choice.intent;
      assert.deepEqual(last(posted, 'studio.agentWorkflowPreview'), { type: 'studio.agentWorkflowPreview', target: 'acme/product-agent', answers: { ...answers } });
    }
    const ready = page.library().agentWorkflow.result;
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.walk.stops, []);
    let card = page.renderMarketplaces(page.library());
    assert.match(text(card), /SFlow approves it when clean|a person approves it/u, 'each step says who approves it');
    // The conversion review (MCR §4): where it came from, every stage and what it became, what SFlow changed, the checks,
    // and the marketplace's own findings with their fixes.
    for (const heading of ['Where it came from', 'Agent stage → SFlow step', 'What SFlow changed', 'Checks', 'Feedback for the marketplace']) {
      assert.ok(text(card).includes(heading), heading);
    }
    assert.match(text(card), /Lifecycle: approved/u);
    assert.doesNotMatch(text(card), /SFlow read stage 1/u, 'a stage that uses no skill is no task the marketplace can add');
    for (const stage of ready.review.stages) assert.ok(text(card).includes(`${stage.number}. ${stage.title}`), `stage ${stage.number} is shown`);
    assert.match(text(card), /Every stage of agent\.md \(\d+\) is accounted for\./u);
    assert.match(text(card), /SFlow could not tell what stage 6 \(Traceability Check\) is for; the person chose review\./u);
    assert.match(text(card), /Fix: Give the skills stage 6 uses a pdlc-task/u);
    // Feedback for the marketplace (MCR §6): the page names the action only; the host acts on the engine's own document.
    assert.match(text(card), /Open an issue fills in a new issue in your browser; you submit it\. SFlow never posts it\./u);
    click(buttonNamed(card, 'Save as Markdown'));
    assert.deepEqual(last(posted, 'studio.agentFeedbackSave'), { type: 'studio.agentFeedbackSave', target: 'acme/product-agent', answers });
    click(buttonNamed(card, 'Copy'));
    assert.deepEqual(last(posted, 'studio.agentFeedbackCopy'), { type: 'studio.agentFeedbackCopy', target: 'acme/product-agent' });
    click(buttonNamed(card, 'Open an issue'));
    assert.deepEqual(last(posted, 'studio.agentFeedbackIssue'), { type: 'studio.agentFeedbackIssue', target: 'acme/product-agent' });
    send({ type: 'studio.agentFeedbackDone', status: 'Opened a new issue with the feedback filled in; you submit it.' });
    card = page.renderMarketplaces(page.library());
    assert.match(text(card), /Opened a new issue with the feedback filled in; you submit it\./u);
    assert.match(text(card), /Next you review its import; nothing changes until you confirm it there\./u);
    assert.ok(buttons(card).some((entry) => text(entry).trim() === 'Answer again'));
    click(buttonNamed(card, 'Make this workflow'));
    assert.deepEqual(last(posted, 'studio.agentWorkflowMake'), { type: 'studio.agentWorkflowMake', target: 'acme/product-agent', answers });
    assert.equal(page.library().busy, 'agent-workflow-make');

    // The host keeps the bundle in SFlow's private folder and starts Import… with it.
    const kept = json(root, ['workflow', 'from-agent', 'acme/product-agent', ...answerFlags(answers), '--propose']);
    assert.ok(path.isAbsolute(kept.bundlePath) && existsSync(kept.bundlePath) && !kept.bundlePath.startsWith(root));
    assert.equal(kept.importPlan.status, 'ready');
    send({ type: 'studio.agentWorkflowMade', workflowId: kept.workflow.id });
    assert.equal(page.library().agentWorkflow, null);
    send({ type: 'studio.importRequested', name: path.basename(kept.bundlePath) });
    assert.deepEqual(last(posted, 'studio.importWorkflows'), { type: 'studio.importWorkflows', pending: 0 });
    assert.equal(page.state().busy, 'import');

    // The person confirms the import (the transfer panel); written here, the workflow opens on its canvas.
    const plan = json(root, ['workflow', 'import', kept.bundlePath, '--dry-run']);
    flow(root, ['workflow', 'import', kept.bundlePath, '--confirm', plan.planSha256]);
    send({ type: 'studio.model', model: json(root, ['workflow', 'studio']), reset: true });
    send({ type: 'studio.importDone', outcome: 'written', branch: null });
    assert.equal(page.state().view, 'board');
    assert.equal(page.state().workflow, kept.workflow.id);
    assert.equal(page.state().status, 'The workflow was written to this repository; review the diff and commit it.');

    // An update (MCR §8): the marketplace changes a skill the workflow uses; Check for updates names it, and Review update
    // opens the same review in update mode, whose Make is Update this workflow.
    run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'import the product workflow'], root);
    const skillFile = path.join(market, 'skills/requirements-writer/SKILL.md');
    await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\nNumber every assumption.\n`);
    for (const args of [['add', '-A'], ['commit', '-m', 'requirements writer: number assumptions']]) run('git', args, market);
    ({ page, posted, send } = studio(json(root, ['workflow', 'studio'])));
    send({ type: 'studio.importsChecked', result: json(root, ['imports', 'check']) });
    const imported = page.renderImported(page.library());
    assert.match(text(imported), /workflow:product/u);
    // No commit for a person to read: the engine's words, not its terminal detail (real VS Code, 2026-11-24).
    assert.match(text(imported), /changed at its source \(skill requirements-writer changed\)/u);
    assert.doesNotMatch(text(imported), /[a-f0-9]{12}/u);
    click(buttonNamed(imported, 'Review update'));
    assert.deepEqual(last(posted, 'studio.agentWorkflowPreview'), { type: 'studio.agentWorkflowPreview', target: 'acme/product-agent', answers: {}, update: true });
    send({ type: 'studio.agentWorkflowPreviewed', target: 'acme/product-agent', result: json(root, ['workflow', 'from-agent', 'acme/product-agent', '--update']) });
    let updateCard = page.renderMarketplaces(page.library());
    assert.match(text(updateCard), /What changed in the marketplace/u);
    // An update reads the newest commit, which this repository does not trust yet; its short change is shown open.
    assert.match(text(updateCard), /product-agent 1\.0\.0-pdlc, marketplace acme, at its newest commit/u);
    assert.doesNotMatch(text(updateCard), /at the commit this repository trusts/u);
    assert.match(text(updateCard), /Since this workflow was imported \(version 1\.0\.0-pdlc\): skill requirements-writer changed\./u);
    assert.doesNotMatch(text(updateCard).slice(text(updateCard).indexOf('Conversion review:')), /[a-f0-9]{12}/u, 'the review shows no commit or digest for a person to read');
    assert.match(text(updateCard), /\+ Number every assumption\./u);
    click(buttonNamed(updateCard, 'Update this workflow'));
    assert.deepEqual(last(posted, 'studio.agentWorkflowMake'), { type: 'studio.agentWorkflowMake', target: 'acme/product-agent', answers: {}, update: true });

    // A walk that stops shows each stop and makes nothing; Answer again starts over.
    ({ page, posted, send } = studio(json(root, ['workflow', 'studio'])));
    page.previewAgentWorkflow('acme/qa-test-automation-agent', 'qa-test-automation-agent', { 'qa-test-automation-intake': 'intake' });
    const stopped = { ...json(root, ['workflow', 'from-agent', 'acme/qa-test-automation-agent']) };
    stopped.walk = { ...stopped.walk, stops: [{ class: 'stop', title: 'A step no one can approve', detail: 'Its approver group is empty.', fix: { text: 'Choose another answer for the review stage.' } }] };
    stopped.review = conversionReview(stopped);
    send({ type: 'studio.agentWorkflowPreviewed', target: 'acme/qa-test-automation-agent', result: stopped });
    card = page.renderMarketplaces(page.library());
    assert.match(text(card), /A Story of it would stop: A step no one can approve\./u);
    assert.match(text(card), /A step no one can approve\. Its approver group is empty\. Fix: Choose another answer for the review stage\./u);
    assert.match(text(card), /A check did not pass, so the workflow is not made\./u);
    assert.ok(!buttons(card).some((entry) => text(entry).trim() === 'Make this workflow'));
    click(buttonNamed(card, 'Answer again'));
    assert.deepEqual(last(posted, 'studio.agentWorkflowPreview'), { type: 'studio.agentWorkflowPreview', target: 'acme/qa-test-automation-agent', answers: {} });
    // A failed read closes the card it opened and says why.
    send({ type: 'studio.importFailed', message: 'Marketplace acme has no agent called qa-test-automation-agent.' });
    assert.equal(page.library().agentWorkflow, null);
    assert.equal(page.library().error, 'Marketplace acme has no agent called qa-test-automation-agent.');
  } finally {
    await rm(market, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('the host reads a repository marketplace and makes an agent workflow only through engine commands, with checked arguments', async () => {
  const host = await readFile(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio.ts'), 'utf8');
  assert.match(host, /\['marketplace', 'add', id, '--repo', repositoryText, \.\.\.\(refText \? \['--ref', refText\] : \[\]\), \.\.\.\(labelText \? \['--label', labelText\] : \[\]\), '--dry-run', '--json'\]/u);
  assert.match(host, /\['workflow', 'from-agent', target, \.\.\.agentStageAnswers\(answers\), \.\.\.\(update \? \['--update'\] : \[\]\), '--json'\]/u);
  assert.match(host, /\['workflow', 'from-agent', target, \.\.\.agentStageAnswers\(answers\), \.\.\.\(update \? \['--update'\] : \[\]\), '--propose', '--json'\][\s\S]{0,400}this\.requestImport\(result\.bundlePath\)/u);
  // Nothing the page sends becomes an option: an ID, a repository that does not start with '-', a Git ref, STEP=INTENT.
  assert.match(host, /repositoryText\.startsWith\('-'\)/u);
  assert.match(host, /const MARKETPLACE_REF = \/\^\[A-Za-z0-9_\]/u);
  assert.match(host, /const MARKETPLACE_AGENT = /u);
  assert.match(host, /AGENT_STAGE_ANSWER\.step\.test\(step\)[\s\S]{0,120}AGENT_STAGE_ANSWER\.intent\.test\(intent\)/u);
  assert.doesNotMatch(host, /writeFile|fs\.promises/u);
  // Feedback (MCR §6): saved by the engine, copied and opened from the engine's own answer, an https page only, never posted.
  assert.match(host, /\['workflow', 'from-agent', target, \.\.\.agentStageAnswers\(answers\), '--feedback', chosen\.fsPath, '--json'\]/u);
  assert.match(host, /this\.agentPreview = \{ target, answers, result \}/u);
  assert.match(host, /if \(!feedback \|\| !\/\^https:\\\/\\\/\[\^\\s@\]\+\$\/u\.test\(url\)\)/u);
  assert.match(host, /vscode\.env\.openExternal\(url as unknown as vscode\.Uri\)/u);
  // An update (MCR §8): --update only when the page says exactly true, on the same checked arguments.
  assert.match(host, /\(message as \{ update\?: unknown \}\)\.update === true/u);
  assert.doesNotMatch(host, /studio\.agentFeedbackIssue[^\n]*stringField\(message, 'url'\)/u, 'the page never hands the host an address');
  // The import's outcome goes back to Workflow Studio at once: real VS Code, 2026-11-24, the import review and Studio
  // stayed busy until someone found the "saved as an uncommitted local draft" note and clicked one of its buttons.
  const extension = await readFile(path.join(packageRoot, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /void showCompactInformationMessage\(\s*'Workflow configuration was saved as an uncommitted local draft\./u);
  assert.match(extension, /void showCompactInformationMessage\(\s*`Workflow proposal \$\{personBranch\(branch\)\} was pushed/u);
  assert.doesNotMatch(extension, /= await showCompactInformationMessage\(\s*(?:'Workflow configuration was saved|`Workflow proposal \$\{personBranch\(proposal\.branch\)\} was pushed)/u);
});
