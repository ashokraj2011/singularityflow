/**
 * A converted marketplace agent (agent-workflow.mjs) as a portable workflow bundle: laid out in a fresh scratch
 * configuration, checked by the engine's own loaders and Stage 2's derivation, then compiled by the one bundle
 * compiler every workflow bundle goes through (workflow-transfer.mjs), as workflow markup does.
 *
 * The scratch holds a freshly initialized configuration at workflow.yml version 4, the workflow's steps (each with its
 * intent), the agent (its agent.md as instructions), its skills (each SKILL.md as a library skill) attached to the
 * steps that use them, and each step's template: the shipped template of its intent with the stage named in it. It is
 * never a Git repository and is removed afterwards. `workflow import` brings the bundle into a repository through its
 * own review; nothing here changes one.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { agentInstructions, workflowDefinition } from './agent-workflow.mjs';
import { SingularityFlowError } from './util.mjs';

// The shipped template each intent's steps start from, until Stage 3 brings each intent's own starter.
const INTENT_TEMPLATES = Object.freeze({
  intake: 'common/intake.md', requirements: 'feature/requirements.md', design: 'feature/design.md', plan: 'feature/implementation-spec.md',
  code: 'common/implementation.md', test: 'common/verification.md', review: 'common/conformance.md'
});
const AGENT_TOOLS = Object.freeze(['read', 'search', 'edit', 'execute', 'bash', 'ask_user']);

function fail(message, code = 'AGENT_WORKFLOW_COLLISION', details = undefined) {
  return new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

const guidance = (text) => String(text).replace(/-->/gu, '- ->').replace(/\s+/gu, ' ').trim();

/**
 * A step's template: its stage named first, then the shipped template of its intent (or a starter) without its title,
 * with the clause anchors a step that writes the requirement IDs needs and the planned-claims table a plan needs, as
 * the import's own check would add them (workflow-fix/templates.mjs).
 */
function stepTemplate(conversion, step, shipped, { templateAnchors, withClauseAnchors, withPlannedTable }) {
  const stages = [step.stage, ...step.folded.map((entry) => entry.number)].join(' and ');
  const from = conversion.source.marketplace ? `${conversion.source.marketplace}/${conversion.source.agent}` : conversion.source.agent;
  const lines = [
    `# {{work.id}} — ${step.label}`, '',
    `<!-- sflow:guidance ${guidance(step.addedBySflow
      ? `SFlow's own step, not a stage of ${conversion.agent.label} (${from}): ${step.why} Follow this template; the agent's stages are its other steps.`
      : `Stage ${stages} of ${conversion.agent.label} (${from}): follow its "${step.stage}. ${step.label}" section. ${step.summary}`)} -->`, ''
  ];
  const body = shipped ? shipped.replace(/\r\n?/gu, '\n').replace(/^# [^\n]*\n+/u, '').trim()
    : ['## What this step decides', '', '## Evidence', '', '## Open questions'].join('\n');
  let text = `${lines.join('\n')}${body}\n`;
  if (step.writesRequirementIds && !templateAnchors(text).length) text = withClauseAnchors(text).text;
  if (step.isPlan && !/^\|\s*clause\s*\|\s*expected paths\s*\|\s*planned tests\s*\|/imu.test(text)) text = withPlannedTable(text).text;
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** One attachment per skill: every step that uses it, and when, step by step where the steps differ. */
function attachments(conversion) {
  const bySkill = new Map();
  for (const step of conversion.steps) {
    for (const entry of step.skills) {
      const current = bySkill.get(entry.skill) ?? { id: entry.skill, agent: conversion.agent.id, phases: [], uses: [] };
      current.phases.push(step.id);
      current.uses.push({ step: step.label, use: entry.use });
      bySkill.set(entry.skill, current);
    }
  }
  return [...bySkill.values()].map(({ uses, ...entry }) => {
    const distinct = [...new Set(uses.map((item) => item.use))];
    const use = distinct.length === 1 ? distinct[0] : uses.map((item) => `${item.step}: ${item.use || 'always'}`).join('; ');
    return { ...entry, use: use.replace(/\|/gu, '/').slice(0, 300) };
  });
}

/**
 * Compile `conversion` (ready: no stage waiting for an answer) with the agent's agent.md `agentText` and each skill's
 * SKILL.md in `skillTexts` (name → text): `{ bundle, workflowYaml, resolved }`, where `workflowYaml` is the version 4
 * workflow.yml pieces as written and `resolved` what Stage 2 derives for each step.
 */
export async function compileAgentWorkflow(conversion, { agentText, skillTexts = new Map() } = {}) {
  const [{ initializeDefinition, loadDefinition, resolveWorkType, assertWorkTypeStartable }, { compileWorkflowBundle },
    { simulateWorkflowRoutes }, { librarySkillText, parseSkillAttachments, skillAttachmentsText, SKILL_ATTACHMENTS_PATH },
    { AGENTS_HOME, agentFileIn }, { newAgentFile }, { INTENTS_FILE_VERSION }] = await Promise.all([
    import('./config.mjs'), import('./workflow-transfer.mjs'), import('./workflow-route-simulation.mjs'), import('./skill-library.mjs'),
    import('./configuration-assets.mjs'), import('./agent-file.mjs'), import('./phase-roles.mjs')
  ]);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-workflow-'));
  try {
    await initializeDefinition(scratch);
    const file = path.join(scratch, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(file, 'utf8'));
    const templatesRoot = definition.templatesRoot ?? 'singularity/templates';
    const at = (relative) => path.join(scratch, ...relative.split('/'));
    const present = (relative) => lstat(at(relative)).then(() => true, (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)));
    const put = async (relative, content) => { await mkdir(path.dirname(at(relative)), { recursive: true }); await writeFile(at(relative), content, 'utf8'); };
    const workflowId = conversion.workflow.id;
    // What SFlow ships under the same name would be replaced on import; the converted workflow needs names of its own.
    const taken = [
      ...(definition.workTypes?.[workflowId] ? [`workflow ${workflowId}`] : []),
      ...conversion.steps.filter((step) => definition.phases?.[step.id]).map((step) => `step ${step.id}`),
      ...(await present(agentFileIn(conversion.agent.id, AGENTS_HOME)) ? [`agent ${conversion.agent.id}`] : []),
      ...(await Promise.all(conversion.skills.map(async (skill) => (await present(`singularity/skill-library/${skill.id}/SKILL.md`) ? `skill ${skill.id}` : null)))).filter(Boolean)
    ];
    if (taken.length) {
      throw fail(`SFlow already ships ${taken.join(', ')}, which the converted workflow would replace. The marketplace's names must differ from SFlow's own.`, 'AGENT_WORKFLOW_COLLISION', { taken });
    }
    const template = (step) => `${workflowId}/${step.id.startsWith(`${workflowId}-`) ? step.id.slice(workflowId.length + 1) : step.id}.md`;
    const { phases, workType } = workflowDefinition(conversion, { template });
    definition.version = Math.max(Number(definition.version) || 0, INTENTS_FILE_VERSION);
    for (const [id, phase] of Object.entries(phases)) definition.phases[id] = phase;
    definition.workTypes[workflowId] = workType;
    const fixes = await import('./workflow-fix/templates.mjs');
    for (const step of conversion.steps) {
      const shipped = INTENT_TEMPLATES[step.intent] ? await readFile(at(`${templatesRoot}/${INTENT_TEMPLATES[step.intent]}`), 'utf8').catch(() => null) : null;
      await put(`${templatesRoot}/${template(step)}`, stepTemplate(conversion, step, shipped, fixes));
    }
    const stepIds = conversion.steps.map((step) => step.id);
    await put(agentFileIn(conversion.agent.id, AGENTS_HOME), newAgentFile({
      id: conversion.agent.id, label: conversion.agent.label, description: conversion.agent.description, tools: [...AGENT_TOOLS],
      phases: stepIds, defaultFor: stepIds, instructions: agentInstructions(conversion, agentText)
    }));
    for (const skill of conversion.skills) {
      const text = skillTexts.get(skill.id);
      if (text == null) throw fail(`Skill ${skill.id}'s SKILL.md was not read, so the workflow cannot carry it.`, 'AGENT_WORKFLOW_SKILL_MISSING');
      const body = String(text).replace(/\r\n?/gu, '\n').replace(/^﻿?---\n[\s\S]*?\n---(?:\n|$)/u, '').trim();
      await put(`singularity/skill-library/${skill.id}/SKILL.md`, librarySkillText({ id: skill.id, description: skill.description, instructions: body }));
    }
    const baseline = parseSkillAttachments(await readFile(at(SKILL_ATTACHMENTS_PATH), 'utf8'));
    await put(SKILL_ATTACHMENTS_PATH, skillAttachmentsText([...baseline, ...attachments(conversion)]));
    const workflowYaml = YAML.stringify({ version: definition.version, phases, workTypes: { [workflowId]: workType } }, { lineWidth: 0 });
    await writeFile(file, YAML.stringify(definition, { lineWidth: 0 }), 'utf8');
    const validated = await loadDefinition(scratch);
    const resolved = resolveWorkType(validated, workflowId);
    assertWorkTypeStartable(resolved);
    const simulation = simulateWorkflowRoutes(resolved, { approvalAuthorities: validated.approvalAuthorities });
    if (simulation.status === 'failed') throw fail(`The converted workflow's routes do not reach the end: ${JSON.stringify(simulation.counts ?? {})}.`, 'AGENT_WORKFLOW_GRAPH_INVALID');
    // The walk every new workflow gets (step intents Stage 6): a loop or stop on a Story's way is named with its fix
    // before anything is written.
    const walk = await walkConverted(scratch, resolved, validated);
    const bundle = await compileWorkflowBundle(scratch, [workflowId]);
    const { approvesAutomatically } = await import('./approval-authority.mjs');
    return { bundle, workflowYaml, simulation, walk, resolved: resolvedSummary(resolved, approvesAutomatically) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The quick walk of the converted workflow (src/workflow-walk/quick.mjs): what it walked and each stop, with its
 * explanation and fix, where a Story of it would loop or stop. `workflow from-agent` shows them and writes nothing.
 */
async function walkConverted(scratch, resolved, definition) {
  const [{ quickWalkResolved }, { buildStudioModel }] = await Promise.all([import('./workflow-walk/quick.mjs'), import('./workflow-studio.mjs')]);
  const model = await buildStudioModel(scratch).catch(() => null);
  const walk = quickWalkResolved(resolved, { approvalAuthorities: definition.approvalAuthorities, groups: new Map((model?.groups ?? []).map((group) => [group.id, group])) });
  return { mode: 'quick', outcome: walk.outcome, paths: walk.paths, routes: walk.routes, hosts: walk.hosts, stops: walk.stops, notes: walk.notes };
}

/** What Stage 2 derived for each step, in the words `workflow from-agent` shows. */
function resolvedSummary(resolved, approvesAutomatically) {
  return resolved.phases.map((phase) => ({
    step: phase.id, intent: phase.intent ?? null, kind: phase.artifact?.kind ?? null, changesSource: phase.writeScope === 'source-and-artifact',
    approval: phase.approval?.mode === 'none' ? 'none' : approvesAutomatically(phase.approval) ? 'sflow-when-clean' : 'person',
    questions: phase.clarification?.mode ?? 'off', repositoryTests: phase.repositoryTests ?? 'off', testEvidenceFrom: phase.testEvidenceFrom ?? null,
    reads: (phase.inputs ?? []).map((input) => input.phase).filter(Boolean)
  }));
}
