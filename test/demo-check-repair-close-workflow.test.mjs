import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { authoringRoute, phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { parseAgentDependencies, renderAgentSkills } from '../src/agents.mjs';
import { applicabilityStatus } from '../src/evidence/applicability.mjs';
import { decisionOutcome, pendingDecisionRecord, resolveDecisionChoice } from '../src/workflow-decisions.mjs';
import { installWorkflow, simulateWorkflow, workflowCatalog } from '../src/workflow-catalog.mjs';
import { applyWorkflowImport, exportWorkflowBundle, planWorkflowImport } from '../src/workflow-transfer.mjs';
import { librarySkillPath, loadSkillLibrary, SKILL_ATTACHMENTS_PATH } from '../src/skill-library.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'demo-check-repair-close';
const PHASES = ['demo-intake', 'demo-check', 'demo-repair', 'demo-close'];
const AGENTS = ['demo-intake-analyst', 'demo-code-checker', 'demo-code-repairer', 'demo-story-closer'];
const SKILLS = ['demo-acceptance-intake', 'demo-code-acceptance-check', 'demo-scoped-code-repair', 'demo-evidence-bound-close'];
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-demo-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  return root;
}
function aggregate(resolution, phaseId, values, rounds = 0) {
  const decision = resolution.decisions.find((entry) => entry.after === phaseId);
  return { resolution, phaseOrder: PHASES, phases: Object.fromEntries(resolution.phases.map((phase) =>
    [phase.id, { ...phase, generation: 1, status: phase.id === phaseId ? 'awaiting_approval' : 'approved',
      ...(phase.id === phaseId ? { decisionInputs: { decision: decision.id, values } } : {}) }])),
    decisionRounds: { [decision.id]: { count: rounds } } };
}

test('four-phase demo has a real closing endpoint, required human checkpoints and no dropped responsibilities', async (t) => {
  const root = await temporary(t);
  const definition = await loadDefinition(root);
  const resolved = resolveWorkType(definition, ID);
  assert.deepEqual(resolved.phases.map((phase) => phase.id), PHASES);
  assert.deepEqual(resolved.phases.map((phase) => phase.defaultAgent), AGENTS);
  assert.deepEqual(resolved.phases.map((phase) => authoringRoute(phase).effectiveAuthoringSkill),
    ['/sf-document-intake', '/sf-scenario-check', '/sf-code', '/sf-phase']);
  assert.deepEqual(resolved.phases.map(phaseRequiresCodeDelivery), [false, false, true, false]);
  assert.ok(resolved.phases.every((phase) => phase.approval.mode === 'required'));
  assert.deepEqual(resolved.obligationGraph.findings, []);
  assert.equal(resolved.obligationGraph.endpoints.length, 1);
  assert.equal(resolved.obligationGraph.endpoints[0].from, PHASES[3]);
  assert.equal(resolved.phases[3].inputs.find((input) => input.phase === PHASES[2]).optional, true);
  assert.equal(resolved.plannedClaims.owners[PHASES[2]], PHASES[0]);
  assert.deepEqual(resolved.documents.allowedPhases, [PHASES[0]]);
  assert.deepEqual(definition.mcpServers['demo-playwright'].agents, [AGENTS[1]]);
  assert.deepEqual(definition.mcpServers['demo-playwright'].phases, [PHASES[1]]);
  assert.equal(definition.mcpServers['demo-playwright'].hostReference, 'playwright');
  assert.ok(!definition.mcpServers.playwright.agents.includes(AGENTS[1]));
  const checkSkill = await readFile(path.join(ROOT, 'plugin/skills/sflow-scenario-check/SKILL.md'), 'utf8');
  assert.match(checkSkill, /mcp smoke <SERVER-ID>/);
  assert.match(checkSkill, /mcp record <SERVER-ID>/);
  assert.doesNotMatch(checkSkill, /mcp smoke playwright|mcp record playwright/);
  for (const phase of resolved.phases) {
    const text = await readFile(path.join(root, definition.templatesRoot, phase.template), 'utf8');
    for (const heading of phase.artifact.validation.requiredHeadings) assert.ok(text.includes(`## ${heading}\n`), heading);
  }
  assert.equal((await workflowCatalog(root)).find((entry) => entry.id === ID).status, 'current');
  const simulation = (await simulateWorkflow(root, ID))[0];
  assert.deepEqual(simulation.phases.map((phase) => phase.id), PHASES);
  assert.notEqual(simulation.lifecycle.status, 'invalid');
  assert.deepEqual(resolveWorkType(definition, 'demo-web-e2e-testing').phases.map((phase) => phase.id),
    ['demo-web-intake', 'demo-web-check', 'demo-web-repair', 'demo-web-retest']);
});

test('pass closes through documents, repairs always recheck, missing access never passes and limits cannot forge success', async () => {
  const resolved = resolveWorkType(validateDefinition(YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'))), ID);
  for (const [phase, values, kind, target] of [
    [PHASES[1], { verdict: 'pass' }, 'forward', PHASES[3]],
    [PHASES[1], { verdict: 'repair' }, 'next', PHASES[2]],
    [PHASES[1], { verdict: 'blocked' }, 'loop', PHASES[1]],
    [PHASES[2], { next: 'recheck' }, 'loop', PHASES[1]],
    [PHASES[2], { next: 'revise-intake' }, 'loop', PHASES[0]]
  ]) {
    const workflow = aggregate(resolved, phase, values);
    const outcome = decisionOutcome(workflow, workflow.phases[phase]);
    assert.deepEqual([outcome.kind, outcome.target], [kind, target]);
    assert.notEqual(outcome.kind, 'end', 'closing documents can never be skipped');
  }
  const blocked = aggregate(resolved, PHASES[1], { verdict: 'blocked' }, 3);
  const pause = decisionOutcome(blocked, blocked.phases[PHASES[1]]);
  assert.equal(pause.kind, 'pause'); assert.equal(pause.reason, 'limit');
  const pending = pendingDecisionRecord(blocked, blocked.phases[PHASES[1]], pause, { at: '2026-10-08T00:00:00Z' });
  assert.ok(!pending.options.some((entry) => entry.to === PHASES[3]));
  assert.throws(() => resolveDecisionChoice(blocked, { ...pending,
    options: [...pending.options, { id: 'demo-pass-to-close', label: 'Forged pass', to: PHASES[3] }], values: { verdict: 'pass' }
  }, { option: 'demo-pass-to-close' }), (error) => error.code === 'DECISION_CONDITION_REQUIRED');
  const repair = aggregate(resolved, PHASES[2], { next: 'recheck' }, 3);
  assert.equal(decisionOutcome(repair, repair.phases[PHASES[2]]).reason, 'limit');
  const pass = aggregate(resolved, PHASES[1], { verdict: 'pass' });
  pass.decisionLog = [decisionOutcome(pass, pass.phases[PHASES[1]])];
  assert.equal(applicabilityStatus(pass)[0].satisfied, false);
  pass.applicability = [{ responsibility: 'implement', authorityGroup: 'quality-reviewers',
    reason: 'The fresh approved check proves this exact code needs no additional repair.' }];
  assert.equal(applicabilityStatus(pass)[0].satisfied, true);
});

test('skills are physically linked in agents, rendered once, and scoped to their agent phases', async (t) => {
  const root = await temporary(t);
  const resolved = resolveWorkType(await loadDefinition(root), ID);
  const library = await loadSkillLibrary(root);
  const registry = await readFile(path.join(root, SKILL_ATTACHMENTS_PATH), 'utf8');
  for (const [index, id] of AGENTS.entries()) {
    const source = `.github/agents/${id}.agent.md`;
    const agent = parseAgentDependencies(await readFile(path.join(root, source), 'utf8'), { source });
    assert.deepEqual(agent.librarySkills.map((entry) => entry.id), [SKILLS[index]]);
    assert.ok(!registry.includes(SKILLS[index]), 'the agent table is the single attachment authority');
    const rendered = await renderAgentSkills(root, { workItem: { id: 'DEMO-1', workType: ID } },
      resolved.phases[index], { agent: id });
    assert.deepEqual(rendered.skills.map((entry) => entry.id), [SKILLS[index]]);
    assert.ok(rendered.text.includes(library.skills.get(SKILLS[index]).instructions));
    assert.equal(rendered.text.split(`<!-- skill: ${SKILLS[index]} sha256=`).length, 2);
  }
  const outside = await renderAgentSkills(root, { workItem: { id: 'OTHER', workType: 'classic-delivery' } },
    { id: 'implementation' }, { agent: 'developer' });
  assert.deepEqual(outside.skills, []);
  const otherPhase = await renderAgentSkills(root, { workItem: { id: 'OTHER', workType: 'classic-delivery' } },
    { id: 'verification' }, { agent: AGENTS[1] });
  assert.deepEqual(otherPhase.skills, []);
  const reused = await renderAgentSkills(root, { workItem: { id: 'COPY', workType: 'team-demo-copy' } },
    resolved.phases[1], { agent: AGENTS[1] });
  assert.deepEqual(reused.skills.map((entry) => entry.id), [SKILLS[1]], 'agent skills follow reused agents');
});

test('active starter agent dependencies still refuse missing library bytes', async (t) => {
  const root = await temporary(t);
  await rm(path.join(root, librarySkillPath(SKILLS[1])));
  await assert.rejects(() => loadDefinition(root), (error) => error.code === 'SKILL_LIBRARY_MISSING'
    && error.details?.agentId === AGENTS[1] && error.details?.skillId === SKILLS[1]);
});

test('starter installation carries agent-owned skill files, dry-run writes nothing and customizations survive replacement', async (t) => {
  const root = await temporary(t);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  delete config.workTypes[ID];
  for (const id of PHASES) delete config.phases[id];
  delete config.mcpServers['demo-playwright'];
  await writeFile(configPath, YAML.stringify(config));
  for (const id of SKILLS) await rm(path.join(root, path.dirname(librarySkillPath(id))), { recursive: true });
  for (const id of AGENTS) await rm(path.join(root, `.github/agents/${id}.agent.md`));
  const registry = await readFile(path.join(root, SKILL_ATTACHMENTS_PATH), 'utf8');
  const preview = await installWorkflow(root, ID, { dryRun: true });
  for (const id of SKILLS) assert.ok(preview.files.includes(librarySkillPath(id)), id);
  assert.ok(!preview.files.includes(SKILL_ATTACHMENTS_PATH));
  assert.equal((await loadDefinition(root)).workTypes[ID], undefined);
  await installWorkflow(root, ID);
  const adopted = resolveWorkType(await loadDefinition(root), ID);
  assert.deepEqual(adopted.phases.map((phase) => phase.defaultAgent), AGENTS);
  const skillPath = path.join(root, librarySkillPath(SKILLS[1]));
  const agentPath = path.join(root, `.github/agents/${AGENTS[1]}.agent.md`);
  const skill = `${await readFile(skillPath, 'utf8')}\nUse the team's authorized fixture.\n`;
  const agent = `${await readFile(agentPath, 'utf8')}\nKeep the team's environment limits.\n`;
  await writeFile(skillPath, skill); await writeFile(agentPath, agent);
  await installWorkflow(root, ID, { replace: true });
  assert.equal(await readFile(skillPath, 'utf8'), skill);
  assert.equal(await readFile(agentPath, 'utf8'), agent);
  assert.equal(await readFile(path.join(root, SKILL_ATTACHMENTS_PATH), 'utf8'), registry);
});

test('export and renamed import retain agent-table skill identities and runnable bindings', async (t) => {
  const source = await temporary(t);
  const bundle = await exportWorkflowBundle(source, [ID]);
  assert.deepEqual(bundle.assets.filter((entry) => entry.kind === 'skill').map((entry) => entry.id).sort(), [...SKILLS].sort());
  for (const id of SKILLS) assert.equal(bundle.assets.find((entry) => entry.kind === 'skill' && entry.id === id).content,
    await readFile(path.join(source, librarySkillPath(id)), 'utf8'));
  const target = await temporary(t);
  const configPath = path.join(target, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  delete config.workTypes[ID];
  await writeFile(configPath, YAML.stringify(config));
  for (const id of AGENTS) await rm(path.join(target, `.github/agents/${id}.agent.md`));
  const resolutions = { [`workflow:${ID}`]: { action: 'rename', to: 'team-demo-loop' } };
  const plan = await planWorkflowImport(target, bundle, { resolutions });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256, resolutions: plan.resolutions });
  const resolved = resolveWorkType(await loadDefinition(target), 'team-demo-loop');
  assert.deepEqual(resolved.phases.map((phase) => phase.defaultAgent), AGENTS);
  const rendered = await renderAgentSkills(target, { workItem: { id: 'TEAM-1', workType: 'team-demo-loop' } },
    resolved.phases[1], { agent: AGENTS[1] });
  assert.deepEqual(rendered.skills.map((entry) => entry.id), [SKILLS[1]]);
});

test('real CLI Story pins agent skills and closes a fresh no-change pass only after human checkpoints and closing documents', async (t) => {
  const root = await temporary(t);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Demo Reviewer',
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/test-active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/test-workspaces.json'),
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: ID, agent: AGENTS[0] }) };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  run('git', ['init', '-b', 'main']); run('git', ['config', 'user.name', 'Demo Reviewer']);
  run('git', ['config', 'user.email', 'demo@example.test']);
  await writeFile(path.join(root, 'README.md'), '# Demo fixture\n');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  const source = 'export const title = "Approved screen";\n';
  await writeFile(path.join(root, 'src/screen.mjs'), source);
  await writeFile(path.join(root, 'test/screen.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { title } from '../src/screen.mjs';
test('DEMO-001 shows the approved title', () => assert.equal(title, 'Approved screen'));
`);
  run('git', ['add', '.']); run('git', ['commit', '-m', 'Initialize demo fixture']);
  const remote = `${root}.git`;
  t.after(() => rm(remote, { recursive: true, force: true }));
  run('git', ['init', '--bare', '-b', 'main', remote]);
  run('git', ['remote', 'add', 'origin', remote]); run('git', ['push', '-u', 'origin', 'main']);
  const cli = (...args) => run(process.execPath, [path.join(ROOT, 'bin/singularity-flow.mjs'), '--no-model', ...args]);
  cli('start', 'DEMO-LOOP-1', '--from-branch', 'main', '--work-type', ID,
    '--title', 'Check the provided screenshot', '--description', 'Check, repair and independently retest before closing.');
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/DEMO-LOOP-1/workflow.json'), 'utf8'));
  assert.deepEqual(workflow.phaseOrder, PHASES);
  const show = JSON.parse(cli('phase', 'show', PHASES[0], '--json'));
  assert.equal(show.policyVerified, true);
  assert.equal(show.effectiveAuthoringSkill, '/sf-document-intake');
  const manifest = JSON.parse(await readFile(path.join(root, workflow.workflowSnapshot.manifestPath), 'utf8'));
  for (const id of SKILLS) assert.ok(manifest.assets.some((entry) => entry.logicalId.endsWith(`:skill:${id}`)), id);
  const workRoot = path.join(root, 'singularity/work-items/DEMO-LOOP-1');
  const readState = async () => JSON.parse(await readFile(path.join(workRoot, 'workflow.json'), 'utf8'));
  cli('wm', 'compose', '--phase', PHASES[0]);
  const responsePath = path.resolve(root, run('git', ['rev-parse', '--git-path', 'singularity-flow/clarification-responses/demo-intake.json']).trim());
  await mkdir(path.dirname(responsePath), { recursive: true });
  await writeFile(responsePath, JSON.stringify({ responses: [{
    question: 'What observable behavior, tool and repair scope are agreed?',
    answer: 'DEMO-001 must show Approved screen. Use node --test test/screen.test.mjs locally. Repair src/screen.mjs only if the title assertion fails. No browser or production access is required; human approval remains required.'
  }] }));
  cli('clarification', 'record', PHASES[0], '--response-file', responsePath);
  cli('prepare', PHASES[0]);
  await writeFile(path.join(workRoot, 'artifacts/demo-intake/intake.md'), `# Demo title acceptance
## Approved sources
The Story description requests testing the documented screen title before any repair. A screenshot is not required for this exact text assertion.
## Scope and acceptance criteria
[DEMO-LOOP-1:AC-001] The screen title equals Approved screen. Repair is limited to src/screen.mjs; no dependency or policy change is authorized.
## Scenario matrix
DEMO-001 checks AC-001 through the named executable assertion DEMO-001 shows the approved title in test/screen.test.mjs.
## Test environment and commands
Run node --test test/screen.test.mjs locally. No browser, remote service or production data is needed. Intake does not execute tests.
## Planned implementation evidence
| Clause | Expected paths | Planned tests |
| --- | --- | --- |
| DEMO-LOOP-1:AC-001 | \`src/screen.mjs\` | \`test/screen.test.mjs\` |
## Routing and human checkpoints
Check existing behavior first; a demonstrated failure goes to Repair and independent recheck. A fresh pass goes to Close only after human approval and no-additional-implementation applicability. Missing tools stay blocked. Closing documents and final human approval end the Story.
`);
  cli('phase', 'publish', PHASES[0]); cli('submit', PHASES[0]); cli('approve', PHASES[0], '--yes');
  const scope = JSON.parse(cli('evidence', 'scope', '--json')).data.scope;
  for (const item of scope.items.filter((entry) => entry.disposition === 'unresolved')) {
    cli('decision', 'scope', '--item', item.id, '--as', 'included', '--clause', 'DEMO-LOOP-1:AC-001',
      '--reason', 'The approved exact screen-title criterion carries the requested acceptance behavior.');
  }
  env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify({ workType: ID, agent: AGENTS[1] });
  cli('prepare', PHASES[1]);
  const testOutput = run(process.execPath, ['--test', 'test/screen.test.mjs']);
  assert.match(testOutput, /# pass 1|pass 1/);
  const outputHash = createHash('sha256').update(testOutput).digest('hex');
  const testedCommit = run('git', ['rev-parse', 'HEAD']).trim();
  const displayedOutput = testOutput.replace(/^.*\btodo\s+0\s*$/gm, '');
  await writeFile(path.join(workRoot, 'artifacts/demo-check/check-results.md'), `# Current code acceptance check
## Pinned inputs and tested revision
Approved intake DEMO-LOOP-1, repository revision ${testedCommit}. Product source and test bytes are unchanged.
## Test execution and evidence
Executed node --test test/screen.test.mjs, exit 0; one assertion ran and passed. Complete output SHA-256 ${outputHash}.
\`\`\`text
${displayedOutput}
\`\`\`
## Source and visual comparison
The exported screen title equals the approved documented value. No visual assertion or browser access is required for this scenario.
## Scenario results
[DEMO-LOOP-1:AC-001] DEMO-001 shows the approved title: passed. Actual title Approved screen matches the expected exact title; no required case was skipped.
## Verdict and repair request
verdict=pass. All required assertions executed successfully against current bytes; no repair is proposed.
## Human checkpoint
Pending authorized review of this exact report and no-additional-implementation applicability. The agent does not approve or close the Story.
`);
  cli('phase', 'publish', PHASES[1]); cli('submit', PHASES[1], '--decision', 'verdict=pass');
  assert.equal((await readState()).currentPhase, PHASES[1], 'agent verdict and submission cannot route without human approval');
  cli('decision', 'applicability', '--responsibility', 'implement', '--reason', 'Fresh DEMO-001 evidence proves current code meets the approved title; no additional implementation is needed to close.');
  cli('approve', PHASES[1], '--yes');
  assert.equal((await readState()).currentPhase, PHASES[3]);
  assert.equal((await readState()).phases[PHASES[2]].status, 'skipped');
  assert.notEqual((await readState()).status, 'closed', 'a passed check never skips closing documents');
  env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify({ workType: ID, agent: AGENTS[3] });
  cli('prepare', PHASES[3]);
  await writeFile(path.join(workRoot, 'artifacts/demo-close/closing-report.md'), `# Demo closing report
## Agent brief
The current code already satisfies the approved exact screen-title behavior, verified by a fresh local test and human-reviewed Check. No repair was necessary.
## Approved scope and final revision
Approved DEMO-LOOP-1 intake and final tested product revision ${testedCommit}. No product-source drift occurred after checking.
## Final check and evidence
[DEMO-LOOP-1:AC-001] DEMO-001 shows the approved title passed. The latest approved Check retains the executed test and complete output SHA-256 ${outputHash}.
## Repair history and no-change accounting
Repair was skipped after the passing check. The human implementation-applicability decision records why no additional implementation is needed; no repair history was discarded.
## Residual risks and operational handoff
No known residual defect within the bounded screen-title assertion. Run node --test test/screen.test.mjs to reproduce. No browser, production access, dependency update or source edit is part of closing.
## Human closing decision
Awaiting authorized review of this published closing report. The agent cannot claim the final approval; that separate human checkpoint completes the Story.
`);
  cli('phase', 'publish', PHASES[3]); cli('submit', PHASES[3]);
  assert.notEqual((await readState()).status, 'closed', 'closing submission alone cannot end the Story');
  cli('approve', PHASES[3], '--yes');
  assert.equal((await readState()).status, 'closed');
  assert.equal((await readState()).completion.kind, 'complete');
  assert.equal(await readFile(path.join(root, 'src/screen.mjs'), 'utf8'), source);
});
