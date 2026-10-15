/** Tagged authoring lowers to the existing Story definition and portable bundle compiler. */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { parseWorkflowMarkup, markupChildren, markupShape, markupId, markupText, markupError } from './workflow-markup-parser.mjs';
import { scanEntries } from './secrets.mjs';
import { inlineInstructionTags } from './skill-instruction-composition.mjs';

export const WORKFLOW_MARKUP_FORMAT = 'sflow-workflow-markup/v1';
const digest = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const list = value => value?.trim() ? value.trim().split(/\s+/u) : [];
const children = (node, name) => markupChildren(node).filter(child => child.name === name);
const text = (value, node, label) => {
  if (typeof value !== 'string' || !value.trim()) markupError(`${label} is required.`, node);
  return value.trim().replace(/\r\n?/gu, '\n');
};
function one(node, name) {
  const matches = children(node, name);
  if (matches.length > 1) markupError(`Only one <${name}> is allowed here.`, node);
  return matches[0] ?? null;
}
function description(node) {
  const value = one(node, 'description');
  if (!value) return null;
  markupShape(value, 'description', [], [], true);
  return text(markupText(value), value, 'Description');
}
function empty(node) { if (node.children.some(child => typeof child !== 'string' || child.trim())) markupError('Reference and route tags must be empty.', node); }
function integer(value, node) {
  if (!/^[1-9][0-9]?$/u.test(value ?? '') || Number(value) > 20) markupError('A backward rule needs max-attempts between 1 and 20.', node);
  return Number(value);
}
function prose(node) {
  return node.children.map(child => {
    if (typeof child === 'string') return child;
    markupShape(child, 'instruction', [], [], true);
    return `<instruction>${markupId(markupText(child), child, 'Instruction reference')}</instruction>`;
  }).join('').trim();
}
function omit(node) {
  markupShape(node, 'omit', ['responsibility', 'reason', 'authority']); empty(node);
  if (!['scope', 'plan', 'implement', 'verify', 'review'].includes(node.attrs.responsibility)) markupError('Unknown omitted responsibility.', node);
  return { responsibility: node.attrs.responsibility, reason: text(node.attrs.reason, node, 'Omission reason'),
    authority: markupId(node.attrs.authority, node, 'Omission authority') };
}

/**
 * Pure lowering against an explicit installed starter. It cannot fetch a URL, execute a command,
 * change group membership, invent a test runner or rewrite another workflow's phase or skills.
 */
export function lowerWorkflowMarkup(source, { definition, agents = [] }) {
  const root = parseWorkflowMarkup(source);
  markupShape(root, 'workflow', ['version', 'id', 'label', 'extends'], ['description', 'agent', 'skill', 'instruction', 'phase', 'omit']);
  if (root.attrs.version !== '1') markupError('Declare workflow version="1".', root);
  const id = markupId(root.attrs.id, root); const baseId = markupId(root.attrs.extends, root, 'Starter workflow');
  const base = Object.hasOwn(definition.workTypes ?? {}, baseId) ? definition.workTypes[baseId] : null;
  if (!base) markupError('The extends workflow is not an installed starter.', root);
  if (Object.hasOwn(definition.workTypes, id)) markupError('Workflow ID already exists; choose a new namespace.', root);
  const workflow = structuredClone(base);
  workflow.label = text(root.attrs.label, root, 'Workflow label');
  workflow.description = description(root) ?? base.description ?? '';
  const phaseNodes = children(root, 'phase');
  if (!phaseNodes.length || phaseNodes.length > 30 || phaseNodes.length !== base.phases.length) markupError('Version 1 explicitly maps every starter phase once, in its existing order.', root);
  const phaseMap = new Map(); const phaseIds = new Set();
  const declared = new Map(); const sourceMap = [{ target: `workflow:${id}`, start: root.start, end: root.end, line: root.line }];
  const claim = (kind, value, node) => {
    const name = markupId(value, node);
    if (!name.startsWith(`${id}-`)) markupError(`New ${kind} IDs must start with '${id}-'.`, node);
    const key = `${kind}:${name}`;
    if (declared.has(key)) markupError(`Duplicate ${kind} ID.`, node);
    declared.set(key, node); sourceMap.push({ target: key, start: node.start, end: node.end, line: node.line });
    return name;
  };
  phaseNodes.forEach((node, index) => {
    markupShape(node, 'phase', ['id', 'label', 'from', 'agent', 'next'], ['description', 'skill', 'decision', 'loop', 'approval']);
    const phaseId = claim('phase', node.attrs.id, node);
    if (node.attrs.from !== base.phases[index]) markupError('Each from must match the corresponding starter phase; no phase contract is silently dropped or reordered.', node);
    if (phaseIds.has(phaseId) || Object.hasOwn(definition.phases, phaseId)) markupError('Phase ID already exists.', node);
    phaseMap.set(node.attrs.from, phaseId); phaseIds.add(phaseId);
  });
  const phaseRef = (value, node) => {
    if (['next', 'end'].includes(value)) return value;
    if (!phaseIds.has(value)) markupError('Route must name a declared phase, next, or end. Checkpoint IDs are not phase destinations.', node);
    return value;
  };
  const remap = value => {
    if (!phaseMap.has(value)) markupError('A starter dependency is outside the selected workflow; select a self-contained starter.', root);
    return phaseMap.get(value);
  };
  const remapPhase = original => {
    const phase = structuredClone(original);
    if (phase.inputs) phase.inputs = phase.inputs.map(input => typeof input === 'string' ? remap(input) : { ...input, phase: remap(input.phase) });
    if (phase.testEvidenceFrom) phase.testEvidenceFrom = phase.testEvidenceFrom.map(remap);
    if (phase.approval?.rejectTo) phase.approval.rejectTo = phase.approval.rejectTo.map(remap);
    if (phase.repairBudget?.resetOnPhase) phase.repairBudget.resetOnPhase = remap(phase.repairBudget.resetOnPhase);
    return phase;
  };
  workflow.phases = phaseNodes.map(node => node.attrs.id);
  if (workflow.plannedClaims?.clausePhases) workflow.plannedClaims.clausePhases = workflow.plannedClaims.clausePhases.map(remap);
  if (workflow.plannedClaims?.owners) workflow.plannedClaims.owners = Object.fromEntries(Object.entries(workflow.plannedClaims.owners).map(([a, b]) => [remap(a), remap(b)]));
  for (const key of ['phaseOverrides', 'templateOverrides']) if (workflow[key]) workflow[key] = Object.fromEntries(Object.entries(workflow[key]).map(([phase, value]) => [remap(phase), key === 'phaseOverrides' ? remapPhase(value) : value]));
  if (workflow.documents?.allowedPhases) workflow.documents.allowedPhases = workflow.documents.allowedPhases.map(remap);
  if (workflow.sourceReview?.phases) workflow.sourceReview.phases = workflow.sourceReview.phases.map(remap);
  if (workflow.reworkLoops) workflow.reworkLoops = workflow.reworkLoops.map(loop => ({ ...loop, from: remap(loop.from), to: remap(loop.to), ...(loop.resetOnPhase ? { resetOnPhase: remap(loop.resetOnPhase) } : {}) }));
  if (workflow.contextPolicy?.phaseOverrides) workflow.contextPolicy.phaseOverrides = Object.fromEntries(Object.entries(workflow.contextPolicy.phaseOverrides).map(([phase, value]) => [remap(phase), value]));
  // Known per-phase references must be explicit; do not clone arbitrary future reference fields.
  const decisions = (base.decisions ?? []).map((decision, index) => ({ ...structuredClone(decision),
    id: markupId(`${id}-decision-${index + 1}`, root), after: remap(decision.after),
    ...(decision.back ? { back: remap(decision.back) } : {}),
    ...(decision.routes ? { routes: decision.routes.map((route, at) => ({ ...structuredClone(route), id: markupId(`${id}-route-${index + 1}-${at + 1}`, root), to: ['next', 'end'].includes(route.to) ? route.to : remap(route.to) })) } : {}) }));
  const skills = []; const instructions = []; const newAgents = []; const attachments = [];
  const knownSkills = new Set(); const knownInstructions = new Set();
  for (const node of children(root, 'instruction')) {
    markupShape(node, 'instruction', ['id', 'description'], [], true);
    const name = claim('instruction', node.attrs.id, node); knownInstructions.add(name);
    instructions.push({ id: name, description: text(node.attrs.description, node, 'Instruction description'), instructions: text(markupText(node), node, 'Instruction text') });
  }
  for (const node of children(root, 'skill')) {
    markupShape(node, 'skill', ['id', 'description'], ['instruction'], true);
    const name = claim('skill', node.attrs.id, node); knownSkills.add(name);
    skills.push({ id: name, description: text(node.attrs.description, node, 'Skill description'), instructions: text(prose(node), node, 'Skill procedure') });
  }
  const references = (node, target) => {
    for (const child of children(node, 'skill')) {
      markupShape(child, 'skill', ['ref']); empty(child);
      const skill = markupId(child.attrs.ref, child, 'Skill reference');
      attachments.push({ skill, ...target });
    }
  };
  for (const node of children(root, 'agent')) {
    markupShape(node, 'agent', ['id', 'description', 'tools'], ['description', 'skill']);
    const name = claim('agent', node.attrs.id, node);
    if (agents.some(agent => agent.id === name)) markupError('Agent ID already exists.', node);
    newAgents.push({ id: name, description: text(node.attrs.description, node, 'Agent description'),
      instructions: text(description(node), node, 'Agent prompt'), tools: list(node.attrs.tools) });
    references(node, { agent: name });
  }
  const knownAgents = new Set(newAgents.map(agent => agent.id));
  const phases = {};
  const decisionIds = new Set(decisions.map(decision => decision.id));
  for (const node of phaseNodes) {
    const phaseId = node.attrs.id;
    const phase = remapPhase(definition.phases[node.attrs.from]);
    if (phase.kind === 'skill' || typeof phase.artifact?.path !== 'string') markupError('Version 1 supports ordinary Story phase contracts; use the existing skill-contract authoring route for this starter.', node);
    if (node.attrs.label !== undefined) phase.label = text(node.attrs.label, node, 'Phase label');
    const override = workflow.phaseOverrides?.[phaseId];
    const agent = markupId(node.attrs.agent, node, 'Phase agent');
    if (!knownAgents.has(agent)) markupError('A remapped phase needs a declared custom agent; installed agents’ global mappings are not changed.', node);
    phase.agents = [agent];
    phase.artifact.path = `artifacts/${phaseId}/${path.posix.basename(phase.artifact.path)}`;
    if (override?.artifact?.path) override.artifact.path = `artifacts/${phaseId}/${path.posix.basename(override.artifact.path)}`;
    const approval = one(node, 'approval');
    if (approval) {
      markupShape(approval, 'approval', ['authority', 'on-reject']); empty(approval);
      const group = markupId(approval.attrs.authority, approval, 'Human approval group');
      if (!Object.hasOwn(definition.approvalAuthorities ?? {}, group)) markupError('Approval needs a named installed human authority, not an agent or the word human.', approval);
      const current = override?.approval ?? phase.approval;
      const updated = { ...(typeof current === 'object' ? current : {}), mode: 'required', authorities: [group], minimum: current?.minimum ?? 1 };
      if (approval.attrs['on-reject']) updated.rejectTo = [phaseRef(approval.attrs['on-reject'], approval)];
      if (updated.rejectTo?.some(target => ['end', 'next'].includes(target))) markupError('Rejection must return to a declared phase.', approval);
      phase.approval = updated; if (override?.approval) override.approval = structuredClone(updated);
    }
    const phaseDescription = description(node);
    if (phaseDescription) {
      const name = claim('skill', `${phaseId}-guidance`, node); knownSkills.add(name);
      skills.push({ id: name, description: `Phase guidance for ${phaseId}.`, instructions: phaseDescription });
      attachments.push({ skill: name, workflow: id, steps: [phaseId] });
    }
    references(node, { workflow: id, steps: [phaseId] });
    const after = [...children(node, 'decision'), ...children(node, 'loop')];
    if (after.length > 1 || after.length && node.attrs.next) markupError('A phase has one decision, one loop, or next; do not specify conflicting routes.', node);
    let decision = null;
    if (after.length) {
      const item = after[0];
      markupShape(item, item.name, ['id', 'label', 'source', 'values', 'max-attempts', 'by', 'kind', 'goal', 'back'], item.name === 'loop' ? [] : ['when', 'otherwise', 'option']);
      const decisionId = claim('decision', item.attrs.id, item);
      if (decisionIds.has(decisionId)) markupError('Decision ID collides with an inherited decision.', item);
      decisionIds.add(decisionId);
      const kind = item.name === 'loop' ? 'loop' : item.attrs.kind ?? 'branch';
      if (item.name === 'loop' && item.attrs.kind !== undefined) markupError('A loop tag cannot also declare a decision kind.', item);
      if (!['branch', 'loop', 'ask'].includes(kind) || item.name !== 'loop' && kind === 'loop') markupError('Use decision kind="branch" or "ask", or a <loop>.', item);
      const by = list(item.attrs.by).map(value => markupId(value, item, 'Decision authority'));
      decision = { id: decisionId, after: phaseId, kind, label: text(item.attrs.label, item, 'Decision label'), ...(by.length ? { by } : {}) };
      if (kind !== 'ask') {
        const input = item.attrs.source;
        if (!/^[a-z][a-zA-Z0-9-]{0,39}$/u.test(input ?? '')) markupError('source is the exact recorded decision input name, not an expression or script.', item);
        const values = list(item.attrs.values);
        if (!values.length || new Set(values.map(value => value.toLowerCase())).size !== values.length) markupError('Declare unique decision values.', item);
        decision.inputs = [{ name: input, values }]; decision.enforceConditions = true;
      } else if (['source', 'values', 'max-attempts', 'goal', 'back'].some(key => item.attrs[key] !== undefined)) markupError('An ask decision is an authorized human choice, not a rule or automatic loop.', item);
      if (kind === 'loop') {
        decision.back = phaseRef(item.attrs.back, item);
        decision.goal = { [item.attrs.source]: text(item.attrs.goal, item, 'Loop goal') };
        decision.maxRounds = integer(item.attrs['max-attempts'], item);
      } else {
        if (item.attrs.goal !== undefined || item.attrs.back !== undefined) markupError('goal and back belong on <loop>.', item);
        const routeNodes = markupChildren(item);
        if (kind === 'branch' && (routeNodes.at(-1)?.name !== 'otherwise' || routeNodes.slice(0, -1).some(route => route.name !== 'when'))
            || kind === 'ask' && routeNodes.some(route => route.name !== 'option')) markupError('Branches end with one otherwise; human choices use option tags.', item);
        decision.routes = routeNodes.map(route => {
          markupShape(route, route.name, ['id', 'label', 'equals', 'next'], ['omit']);
          const routeId = markupId(route.attrs.id, route, 'Route ID');
          const when = route.name === 'when' ? { [item.attrs.source]: text(route.attrs.equals, route, 'Branch condition') } : undefined;
          if (route.name !== 'when' && route.attrs.equals !== undefined) markupError('Only when takes equals.', route);
          sourceMap.push({ target: `decision:${decisionId}/route:${routeId}`, start: route.start, end: route.end, line: route.line });
          return { id: routeId, label: route.attrs.label ?? routeId, to: phaseRef(route.attrs.next, route), ...(when ? { when } : {}),
            ...(children(route, 'omit').length ? { omits: children(route, 'omit').map(omit) } : {}) };
        });
        const backward = decision.routes.some(route => workflow.phases.indexOf(route.to) >= 0 && workflow.phases.indexOf(route.to) <= workflow.phases.indexOf(phaseId));
        if (kind === 'branch' && backward) decision.maxRounds = integer(item.attrs['max-attempts'], item);
        else if (item.attrs['max-attempts']) markupError('max-attempts needs a backward rule route.', item);
      }
    } else if (node.attrs.next) {
      const next = phaseRef(node.attrs.next, node);
      const expected = workflow.phases[workflow.phases.indexOf(phaseId) + 1] ?? 'end';
      if (next !== 'next' && next !== expected) markupError('Non-sequential or backward routes need an explicit decision/loop and recorded conditions.', node);
    }
    if (decision || node.attrs.next) {
      const prior = decisions.findIndex(value => value.after === phaseId);
      if (prior >= 0) decisions.splice(prior, 1);
      if (decision) decisions.push(decision);
    }
    phases[phaseId] = phase;
  }
  for (const attachment of attachments) if (!knownSkills.has(attachment.skill)) markupError('Every attached skill must be declared in this portable markup.', root);
  const placedInstructions = new Set();
  for (const skill of skills) for (const tag of inlineInstructionTags(skill.instructions)) {
    if (!knownInstructions.has(tag.id)) markupError('Every instruction tag must resolve to an instruction declared in this portable markup.', root);
    placedInstructions.add(tag.id);
  }
  for (const name of knownSkills) if (!attachments.some(item => item.skill === name)) markupError('A declared skill is unattached; attach it to a phase or agent so export cannot drop it.', declared.get(`skill:${name}`));
  for (const name of knownInstructions) if (!placedInstructions.has(name)) markupError('A declared instruction is not placed in a live skill procedure; quoted examples do not select it.', declared.get(`instruction:${name}`));
  for (const agent of newAgents) if (!phaseNodes.some(node => node.attrs.agent === agent.id)) markupError('A declared agent is not used by any phase.', declared.get(`agent:${agent.id}`));
  const codeAgents = new Set(phaseNodes.filter(node => phases[node.attrs.id].generation?.task === 'code').map(node => node.attrs.agent));
  for (const node of phaseNodes) if (phases[node.attrs.id].artifact.kind === 'test-evidence' && codeAgents.has(node.attrs.agent)) {
    markupError('Independent test evidence and code repair require separate custom agents.', node);
  }
  workflow.decisions = decisions;
  if (children(root, 'omit').length) workflow.omits = children(root, 'omit').map(omit);
  return { id, extends: baseId, workflow, phases, agents: newAgents, skills, instructions, attachments,
    phaseAgents: Object.fromEntries(phaseNodes.map(node => [node.attrs.id, node.attrs.agent])), sourceMap };
}

/** All temporary writes are isolated; only --out writes a new explicit bundle after every check. */
export async function compileWorkflowMarkup(source, { out = null } = {}) {
  // Parse and credential-screen before initializing the scratch, loading catalogs or writing output.
  parseWorkflowMarkup(source);
  if (!scanEntries([{ path: 'workflow-markup.xml', content: source, forceScan: true }]).clean) markupError('Possible credentials in markup; no bundle emitted.', null, 'WORKFLOW_MARKUP_CONTENT_BLOCKED');
  const [{ initializeDefinition, loadDefinition, resolveWorkType, assertWorkTypeStartable },
    { discoverAgents }, { compileWorkflowBundle, writeWorkflowBundle },
    { simulateWorkflowRoutes }, { librarySkillText, skillAttachmentsText, parseSkillAttachments, SKILL_ATTACHMENTS_PATH },
    { instructionText }] = await Promise.all([
    import('./config.mjs'), import('./agents.mjs'), import('./workflow-transfer.mjs'), import('./workflow-route-simulation.mjs'),
    import('./skill-library.mjs'), import('./instruction-library.mjs')
  ]);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-markup-'));
  try {
    await initializeDefinition(scratch);
    const file = path.join(scratch, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(file, 'utf8'));
    const baselineAgents = await discoverAgents(scratch);
    const lowered = lowerWorkflowMarkup(source, { definition, agents: baselineAgents });
    const put = async (relative, content) => {
      const target = path.join(scratch, ...relative.split('/')); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content, 'utf8');
    };
    for (const [kind, entries, fileName] of [['skill-library', lowered.skills, 'SKILL.md'], ['instruction-library', lowered.instructions, 'INSTRUCTIONS.md']]) {
      for (const entry of entries) if (await lstat(path.join(scratch, 'singularity', kind, entry.id, fileName)).catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
      })) markupError('A declared dependency collides with the installed catalog; choose a fresh workflow namespace.');
    }
    for (const [id, phase] of Object.entries(lowered.phases)) definition.phases[id] = phase;
    definition.workTypes[lowered.id] = lowered.workflow;
    // New phases use explicit custom agents. The bundle compiler captures scoped source bytes,
    // never an implicit change to an installed agent or its global attachments.
    const front = fields => `---\n${YAML.stringify(fields, { lineWidth: 0 })}---\n\n`;
    for (const agent of lowered.agents) {
      const selected = Object.entries(lowered.phaseAgents).filter(([, id]) => id === agent.id).map(([phase]) => phase);
      await put(`.github/agents/${agent.id}.agent.md`, front({ name: agent.id, description: agent.description, tools: agent.tools,
        metadata: { 'sflow-phases': selected.join(', '), 'sflow-default-for': selected.join(', ') } }) + agent.instructions + '\n');
    }
    for (const skill of lowered.skills) await put(`singularity/skill-library/${skill.id}/SKILL.md`, librarySkillText(skill));
    for (const instruction of lowered.instructions) await put(`singularity/instruction-library/${instruction.id}/INSTRUCTIONS.md`, instructionText(instruction));
    const baselineAttachments = parseSkillAttachments(await readFile(path.join(scratch, SKILL_ATTACHMENTS_PATH), 'utf8'));
    const attached = new Map();
    for (const item of lowered.attachments) {
      const key = `${item.agent ? 'agent:' + item.agent : 'workflow:' + item.workflow}/${item.skill}`;
      const entry = attached.get(key) ?? { id: item.skill, ...(item.agent ? { agent: item.agent } : { workflow: item.workflow }), phases: [], use: '' };
      entry.phases = [...new Set([...entry.phases, ...(item.steps ?? [])])]; attached.set(key, entry);
    }
    await put(SKILL_ATTACHMENTS_PATH, skillAttachmentsText([...baselineAttachments, ...attached.values()]));
    await writeFile(file, YAML.stringify(definition, { lineWidth: 0 }), 'utf8');
    const validated = await loadDefinition(scratch); const resolved = resolveWorkType(validated, lowered.id);
    assertWorkTypeStartable(resolved);
    const simulation = simulateWorkflowRoutes(resolved, { approvalAuthorities: validated.approvalAuthorities });
    if (simulation.status === 'failed') markupError('The native route simulation refused the graph.', null, 'WORKFLOW_MARKUP_GRAPH_INVALID');
    const bundle = await compileWorkflowBundle(scratch, [lowered.id]);
    const outputPath = out ? await writeWorkflowBundle(bundle, out) : null;
    return { schemaVersion: 1, resultType: 'workflow-markup-compilation', format: WORKFLOW_MARKUP_FORMAT,
      status: 'portable-ready', sourceSha256: digest(source), bundleSha256: bundle.bundleSha256,
      workflow: { id: lowered.id, label: lowered.workflow.label, phases: resolved.phases.map(phase => ({ id: phase.id, label: phase.label, agent: lowered.phaseAgents[phase.id] })), decisions: resolved.decisions },
      sourceMap: lowered.sourceMap, routeSimulation: simulation, outputPath, ...(out ? {} : { bundle }),
      effects: { configurationChanged: false, storyChanged: false, approvalRecorded: false, bundleWritten: Boolean(out) },
      meaning: 'Portable-ready means deterministic definition, dependency and route checks passed; it is not approved, imported, activated or executed.' };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
