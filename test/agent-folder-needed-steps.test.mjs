/**
 * An agent folder imported as a workflow gets the steps SFlow needs [owner, 2026-11-22: "When an agent directory is
 * imported it should create the needed phases and inject sflow things"].
 *
 * - The rule (src/workflow-needs.mjs): code with nothing before it that writes the requirements gets Requirements
 *   first (without it a Story cannot start); a responsibility the workflow leaves out on purpose, or a workflow that
 *   changes no code, gets nothing. No verification step is added: the code step verifies its own change.
 * - An agent folder on this computer (src/agent-folder.mjs): agent.md and its skills, with or without apm.yml; a link
 *   is refused; nothing in the result names where the folder is.
 * - The import adds it (convertAgent), said to be SFlow's own with why, and the workflow compiles, validates and walks
 *   with it (compileAgentWorkflow); without it the same agent's workflow cannot start a Story. An agent that already
 *   has requirements gets nothing added.
 * - `workflow from-agent <FOLDER>` previews it, with no marketplace added.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readAgentFolder, isAgentFolder } from '../src/agent-folder.mjs';
import { compileAgentWorkflow } from '../src/agent-workflow-bundle.mjs';
import { agentInstructions, convertAgent, workflowDefinition } from '../src/agent-workflow.mjs';
import { neededSteps, withNeededSteps } from '../src/workflow-needs.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(packageRoot, 'test', 'fixtures', 'sdlc-marketplace');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Folder Tester' };
// What the person answers when SFlow asks what each stage is for.
const ANSWERS = { 'checkout-builder-build-the-change': 'code', 'checkout-builder-hand-off-notes': 'release' };
const ANSWER_ARGS = Object.entries(ANSWERS).flatMap(([step, intent]) => ['--answer', `${step}=${intent}`]);

const AGENT = `---
name: checkout-builder
description: Builds a checkout change and hands it over.
---
# Checkout builder agent

You build small checkout changes.

## 1. Build the change

Change the checkout code and its unit tests, using the \`checkout-coding\` skill.

## 2. Hand-off notes

Write the release notes for the change.
`;
const SKILL = `---
name: checkout-coding
description: How the checkout code is written and tested.
---
# Checkout coding

Keep each change small and give it a unit test.
`;

async function agentFolder({ manifest = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-folder-'));
  const folder = path.join(base, 'checkout-builder');
  await mkdir(path.join(folder, 'skills', 'checkout-coding'), { recursive: true });
  await writeFile(path.join(folder, 'agent.md'), AGENT);
  await writeFile(path.join(folder, 'skills', 'checkout-coding', 'SKILL.md'), SKILL);
  if (manifest) {
    await writeFile(path.join(folder, 'apm.yml'), 'name: checkout-builder\nversion: 1.2.0\ntype: agent\ndescription: Builds checkout changes.\npdlc-phases: [delivery]\n'
      + 'dependencies:\n  apm:\n    - ./skills/checkout-coding\n');
  }
  return { base, folder };
}

test('the rule: code with nothing before it that writes requirements needs Requirements first, and nothing else is added', () => {
  const steps = [{ id: 'build', intent: 'code', label: 'Build' }, { id: 'notes', intent: 'release', label: 'Notes' }];
  const needed = neededSteps(steps);
  assert.deepEqual(needed.map((entry) => [entry.responsibility, entry.intent, entry.label, entry.before ?? null, entry.after ?? null]),
    [['scope', 'requirements', 'Requirements', 'build', null]]);
  assert.match(needed[0].why, /^No step before Build writes the requirements it builds, so the code has nothing to cite and a Story cannot start\./u);
  assert.deepEqual(withNeededSteps(steps, needed, (entry) => ({ id: entry.name })).map((step) => step.id), ['requirements', 'build', 'notes']);
  assert.deepEqual(withNeededSteps(steps, [{ name: 'after-build', after: 'build' }], (entry) => ({ id: entry.name })).map((step) => step.id), ['build', 'after-build', 'notes']);
  // What the workflow leaves out on purpose is never added; a workflow that changes no code needs neither.
  assert.deepEqual(neededSteps(steps, { omits: [{ responsibility: 'scope' }] }), []);
  assert.deepEqual(neededSteps(steps, { omits: ['scope'] }), []);
  assert.deepEqual(neededSteps([{ id: 'write', intent: 'document' }, { id: 'report', intent: 'report' }]), []);
  // Intake, requirements or a plan before the code writes the requirements: nothing is needed, with or without a test step.
  assert.deepEqual(neededSteps([{ id: 'intake', intent: 'intake' }, { id: 'code', intent: 'code' }]), []);
  assert.deepEqual(neededSteps([{ id: 'plan', intent: 'plan' }, { id: 'code', intent: 'code' }, { id: 'verify', intent: 'test' }]), []);
});

test('an agent folder on this computer: agent.md and its skills, with or without apm.yml; a link is refused and no path is named', async () => {
  const plain = await agentFolder();
  const described = await agentFolder({ manifest: true });
  try {
    assert.equal(await isAgentFolder(plain.folder), true);
    assert.equal(await isAgentFolder(path.join(plain.folder, 'agent.md')), true, 'the agent.md itself names its folder');
    assert.equal(await isAgentFolder(path.join(plain.folder, 'skills')), false);
    assert.equal(await isAgentFolder('acme/qa-test-automation-agent', plain.base), false, 'MARKETPLACE/AGENT stays a marketplace agent');
    const read = await readAgentFolder(plain.folder);
    assert.equal(read.folder, 'checkout-builder');
    assert.deepEqual([read.agent.name, read.agent.kind, read.agent.skills, read.agent.document], ['checkout-builder', 'agent', ['checkout-coding'], 'checkout-builder/agent.md']);
    assert.deepEqual(read.skills.map((skill) => [skill.name, skill.description]), [['checkout-coding', 'How the checkout code is written and tested.']]);
    assert.ok(!JSON.stringify(read).includes(plain.base), 'nothing names where on this computer the folder is');
    const own = await readAgentFolder(described.folder);
    assert.deepEqual([own.agent.version, own.agent.pdlcPhases, own.agent.skills], ['1.2.0', ['delivery'], ['checkout-coding']]);
    // The marketplace layout: an agent folder whose apm.yml depends on ../../skills/x beside it.
    const qa = await readAgentFolder(path.join(FIXTURE, 'agents', 'qa-test-automation-agent'));
    assert.deepEqual(qa.agent.skills, ['web-xray-creation', 'android-xray-creation', 'web-e2e-test-generation', 'android-ui-test-creation', 'android-unit-test']);
    assert.deepEqual(qa.problems, []);
    // A link is never followed.
    await rm(path.join(plain.folder, 'agent.md'));
    await symlink(path.join(described.folder, 'agent.md'), path.join(plain.folder, 'agent.md'));
    await assert.rejects(readAgentFolder(plain.folder), /symbolic link/u);
  } finally {
    await rm(plain.base, { recursive: true, force: true });
    await rm(described.base, { recursive: true, force: true });
  }
});

test('the import adds Requirements as SFlow\'s own step, and the workflow compiles, validates and walks', async () => {
  const { base, folder } = await agentFolder();
  try {
    const read = await readAgentFolder(folder);
    // Until the person says what each stage is for, nothing is added: SFlow asks first.
    const asked = convertAgent({ marketplace: null, folder: read.folder, agent: read.agent, skills: read.skills });
    assert.deepEqual([asked.ready, asked.added], [false, []]);
    const conversion = convertAgent({ marketplace: null, folder: read.folder, agent: read.agent, skills: read.skills, answers: ANSWERS });
    assert.equal(conversion.ready, true, JSON.stringify(conversion.open));
    assert.deepEqual(conversion.steps.map((step) => [step.label, step.intent, Boolean(step.addedBySflow)]),
      [['Requirements', 'requirements', true], ['Build the change', 'code', false], ['Hand-off notes', 'release', false]]);
    assert.deepEqual(conversion.added.map((entry) => [entry.label, entry.before ?? null]), [['Requirements', 'checkout-builder-build-the-change']]);
    assert.ok(conversion.notes.some((note) => /^SFlow added Requirements before Build the change: /u.test(note)), conversion.notes.join('\n'));
    assert.equal(conversion.source.folder, 'checkout-builder');
    assert.match(conversion.workflow.description, /From folder checkout-builder: checkout-builder/u);
    // The added steps carry no skill of the agent, and their descriptions and the agent's instructions say they are SFlow's.
    const { phases, workType } = workflowDefinition(conversion);
    assert.deepEqual(workType.phases, ['checkout-builder-requirements', 'checkout-builder-build-the-change', 'checkout-builder-hand-off-notes']);
    assert.match(phases['checkout-builder-requirements'].description, /^Added by SFlow, not a stage of Checkout builder agent: No step before Build the change writes/u);
    assert.match(agentInstructions(conversion, AGENT), /SFlow also runs Requirements, which is not a stage below: there, follow that step's template only\./u);
    assert.deepEqual(conversion.steps.filter((step) => step.addedBySflow).flatMap((step) => step.skills), []);

    const compiled = await compileAgentWorkflow(conversion, { agentText: AGENT, skillTexts: new Map(read.skills.map((skill) => [skill.name, skill.text])) });
    assert.deepEqual(compiled.walk.stops, [], JSON.stringify(compiled.walk.stops));
    const derived = Object.fromEntries(compiled.resolved.map((step) => [step.step, step]));
    assert.equal(derived['checkout-builder-build-the-change'].changesSource, true);
    assert.equal(derived['checkout-builder-requirements'].approval, 'person', 'a person approves the requirements the code builds');
    assert.ok(compiled.bundle.bundleSha256);
    // Without it, the same agent's workflow cannot start a Story: that is why it is needed.
    const bare = { ...conversion, steps: conversion.steps.filter((step) => !step.addedBySflow), added: [] };
    await assert.rejects(compileAgentWorkflow(bare, { agentText: AGENT, skillTexts: new Map(read.skills.map((skill) => [skill.name, skill.text])) }),
      /writes the requirements it builds|cannot start a Story/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an agent that already writes requirements before its code gets nothing added', async () => {
  const read = await readAgentFolder(path.join(FIXTURE, 'agents', 'qa-test-automation-agent'));
  const conversion = convertAgent({ marketplace: null, folder: read.folder, agent: read.agent, skills: read.skills });
  assert.equal(conversion.ready, true);
  assert.deepEqual(conversion.added, []);
  assert.equal(conversion.steps.some((step) => step.addedBySflow), false);
});

test('workflow from-agent <FOLDER> previews the workflow with SFlow\'s added steps, with no marketplace added', async () => {
  const { base, folder } = await agentFolder();
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-folder-repo-'));
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  try {
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Folder Tester'], ['config', 'user.email', 'folder@example.com']]) run('git', args);
    await writeFile(path.join(root, 'README.md'), '# Shop\n');
    run(process.execPath, [bin, 'init']);
    run('git', ['add', '-A']); run('git', ['commit', '-m', 'initialize']);
    const preview = JSON.parse(run(process.execPath, [bin, 'workflow', 'from-agent', folder, ...ANSWER_ARGS, '--json']));
    assert.equal(preview.ready, true);
    assert.deepEqual(preview.added.map((entry) => entry.label), ['Requirements']);
    assert.deepEqual(preview.walk.stops, []);
    const text = run(process.execPath, [bin, 'workflow', 'from-agent', folder, ...ANSWER_ARGS]);
    assert.match(text, /^Checkout builder: a workflow from checkout-builder in folder checkout-builder\.$/mu);
    assert.match(text, /^ {2}1\. Requirements {2}requirements, added by SFlow: No step before Build the change writes the requirements it builds/mu);
    assert.match(text, /^Nothing was written\. Next:$/mu);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
