/** Tagged authoring lowers to the existing Story definition and portable bundle compiler. */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { parseWorkflowMarkup, markupChildren, markupShape, markupId, markupText, markupError, markupCompilerError } from './workflow-markup-parser.mjs';
import { remapMarkupPhase, remapMarkupWorkflow } from './workflow-markup-references.mjs';
import { mergePhaseOverride } from './phase-overrides.mjs';
import { scanEntries } from './secrets.mjs';
import { inlineInstructionTags } from './skill-instruction-composition.mjs';
import { withoutAttachedSkills, effectiveLibrarySkills } from './skill-library.mjs';
import { derivedMcpPolicy } from './workflow-markup-mcp.mjs';
import { normalizeApprovalPolicy } from './approval-authority.mjs';
import { STEP_OUTPUTS, newStepContract, newStepTemplate } from './step-outputs.mjs';

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
 * A phase of a new workflow (one with no `extends`) that copies one library step: the step's own
 * contract, with each step it refers to localized to this workflow. What it reads is either
 * `reads` or the copied inputs; a send-back target this workflow does not have before it is
 * dropped, never widened, as a workflow running a shared step keeps only the targets it has.
 */
function copiedStep(node, { definition, from, phaseId, order, localize: shared }) {
  // The step itself is this copy, even when the workflow copies the same library step twice.
  const localize = value => (value === from ? phaseId : shared(value));
  const source = structuredClone(definition.phases[from]);
  const rejectTo = source.approval?.rejectTo;
  if (rejectTo) delete source.approval.rejectTo;
  if (node.attrs.reads !== undefined) delete source.inputs;
  const phase = remapMarkupPhase(source, value => localize(value)
    ?? markupError(`Phase '${phaseId}' copies '${from}', which refers to step '${value}'. Copy that step into this workflow once, or say what this phase reads with reads="…".`, node));
  if (rejectTo) {
    const kept = [...new Set(rejectTo.map(localize).filter(target => target && order.indexOf(target) <= order.indexOf(phaseId)))];
    phase.approval.rejectTo = kept.length ? kept : [phaseId];
  }
  return phase;
}

/**
 * Pure lowering against an explicit installed starter, or of a new workflow designed from its own
 * steps. It cannot fetch a URL, execute a command, change group membership, invent a test runner
 * or rewrite another workflow's phase or skills.
 */
export function lowerWorkflowMarkup(source, { definition, agents = [], catalog = null }) {
  const root = parseWorkflowMarkup(source);
  const version2 = root.attrs.version === '2';
  markupShape(root, 'workflow', ['version', 'id', 'label', 'extends', ...(version2 ? ['catalog', 'catalog-source'] : [])], ['description', 'agent', 'skill', 'instruction', 'phase', 'omit', ...(version2 ? ['intent', 'attachment'] : [])]);
  if (!['1', '2'].includes(root.attrs.version)) markupError('Declare workflow version="1" or catalog-bound version="2".', root);
  if (version2 && (!catalog || root.attrs.catalog !== catalog.sourceSha256 || !['approved', 'installed'].includes(root.attrs['catalog-source']))) markupError('Version 2 requires the exact captured catalog and catalog-source.', root, 'WORKFLOW_MARKUP_CATALOG_REQUIRED');
  const reusedAssets = [];
  const reuse = (kind, name, node, as = name) => {
    const found = catalog?.entries.find(item => item.kind === kind && item.id === name && item.available);
    if (!found) markupError(`No available ${kind} '${name}' exists in the bound catalog. Search the catalog; do not invent IDs.`, node);
    if (!reusedAssets.some(item => item.kind === kind && item.id === name && item.as === as)) reusedAssets.push({ kind, id: name, as, sha256: found.sha256 });
    return found.value;
  };
  // Without extends the workflow is new: its phases are its own, in the order the intent needs.
  const fresh = root.attrs.extends === undefined;
  const id = markupId(root.attrs.id, root); const baseId = fresh ? null : markupId(root.attrs.extends, root, 'Starter workflow');
  const base = fresh ? null : Object.hasOwn(definition.workTypes ?? {}, baseId) ? definition.workTypes[baseId] : null;
  if (!fresh && !base) markupError('The extends workflow is not in the selected configuration.', root);
  if (version2 && !fresh) reuse('workflow', baseId, root);
  if (Object.hasOwn(definition.workTypes, id)) markupError('Workflow ID already exists; choose a new namespace.', root);
  const phaseNodes = children(root, 'phase');
  if (fresh && (!phaseNodes.length || phaseNodes.length > 30)) markupError('A new workflow declares between 1 and 30 phases.', root);
  if (!fresh && (!phaseNodes.length || phaseNodes.length > 30 || phaseNodes.length !== base.phases.length)) markupError('Map every selected workflow-contract phase once, in its existing order. Use the canvas or reviewed workflow-authoring package route for a different topology.', root);
  const phaseMap = new Map(); const phaseIds = new Set(); const copies = new Map();
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
    markupShape(node, 'phase', ['id', 'label', 'from', 'agent', 'next', ...(fresh ? ['output', 'reads'] : [])], ['description', 'skill', 'decision', 'loop', 'approval']);
    const phaseId = claim('phase', node.attrs.id, node);
    if (fresh) {
      if ((node.attrs.from === undefined) === (node.attrs.output === undefined)) markupError(`A phase of a new workflow is either a new step with output="${STEP_OUTPUTS.map(entry => entry.id).join('|')}" or a copy of one library step with from.`, node);
      if (node.attrs.output !== undefined && !STEP_OUTPUTS.some(entry => entry.id === node.attrs.output)) markupError(`A new step's output is one of: ${STEP_OUTPUTS.map(entry => entry.id).join(', ')}.`, node);
      if (node.attrs.output !== undefined && node.attrs.label === undefined) markupError('A new step needs a label.', node);
      if (node.attrs.from !== undefined) {
        const from = markupId(node.attrs.from, node, 'Copied step');
        if (!Object.hasOwn(definition.phases, from)) markupError(`There is no library step '${from}' to copy. Create the step with output instead.`, node);
        if (version2) reuse('phase', from, node, phaseId);
        copies.set(from, [...(copies.get(from) ?? []), phaseId]);
      }
    } else {
      if (node.attrs.from !== base.phases[index]) markupError('Each from must match the corresponding starter phase; no phase contract is silently dropped or reordered.', node);
      if (version2) reuse('phase', node.attrs.from, node, phaseId);
      phaseMap.set(node.attrs.from, phaseId);
    }
    if (phaseIds.has(phaseId) || Object.hasOwn(definition.phases, phaseId)) markupError('Phase ID already exists.', node);
    phaseIds.add(phaseId);
  });
  // A library step copied once is this workflow's version of it; one copied twice is named by reads.
  for (const [from, ids] of copies) if (ids.length === 1) phaseMap.set(from, ids[0]);
  const localize = value => phaseMap.get(value) ?? null;
  const phaseRef = (value, node) => {
    if (['next', 'end'].includes(value)) return value;
    if (!phaseIds.has(value)) markupError('Route must name a declared phase, next, or end. Checkpoint IDs are not phase destinations.', node);
    return value;
  };
  const remap = value => {
    if (!phaseMap.has(value)) markupError('A starter dependency is outside the selected workflow; select a self-contained starter.', root);
    return phaseMap.get(value);
  };
  const remapPhase = original => remapMarkupPhase(original, remap);
  const workflow = fresh ? {} : remapMarkupWorkflow(base, remap);
  workflow.label = text(root.attrs.label, root, 'Workflow label');
  workflow.description = description(root) ?? base?.description ?? '';
  workflow.phases = phaseNodes.map(node => node.attrs.id);
  // Known per-phase references must be explicit; do not clone arbitrary future reference fields.
  const decisions = (base?.decisions ?? []).map((decision, index) => ({ ...structuredClone(decision),
    id: markupId(`${id}-decision-${index + 1}`, root), after: remap(decision.after),
    ...(decision.back ? { back: remap(decision.back) } : {}),
    ...(decision.routes ? { routes: decision.routes.map((route, at) => ({ ...structuredClone(route), id: markupId(`${id}-route-${index + 1}-${at + 1}`, root), to: ['next', 'end'].includes(route.to) ? route.to : remap(route.to) })) } : {}) }));
  const skills = []; const instructions = []; const newAgents = []; const attachments = [];
  if (version2 && !fresh) for (const use of catalog.attachments.filter(item => item.workflow === baseId)) {
    attachments.push({ skill: use.id, workflow: id, steps: use.phases.map(remap), use: use.use });
  }
  const knownSkills = new Set(); const knownInstructions = new Set();
  for (const node of children(root, 'instruction')) {
    markupShape(node, 'instruction', ['id', 'description', ...(version2 ? ['from'] : [])], [], true);
    const name = claim('instruction', node.attrs.id, node); knownInstructions.add(name);
    const parent = node.attrs.from ? reuse('instruction', node.attrs.from, node, name) : null;
    if (parent && markupText(node).trim()) markupError('A from instruction reuses its exact body; declare a new instruction to change it.', node);
    instructions.push({ id: name, description: text(node.attrs.description ?? parent?.description, node, 'Instruction description'), instructions: text(parent?.instructions ?? markupText(node), node, 'Instruction text'), ...(parent ? { tags: parent.tags } : {}) });
  }
  for (const node of children(root, 'skill')) {
    markupShape(node, 'skill', ['id', 'description', ...(version2 ? ['from'] : [])], ['instruction'], true);
    const name = claim('skill', node.attrs.id, node); knownSkills.add(name);
    const parent = node.attrs.from ? reuse('skill', node.attrs.from, node, name) : null;
    if (parent && prose(node).trim()) markupError('A from skill reuses its exact procedure; declare a new skill for different instructions.', node);
    skills.push({ id: name, description: text(node.attrs.description ?? parent?.description, node, 'Skill description'),
      instructions: text(parent?.instructions ?? prose(node), node, 'Skill procedure'), ...(parent ? { loading: parent.loading, instructionRefs: parent.declaredInstructionRefs, tags: parent.tags } : {}) });
  }
  const references = (node, target) => {
    for (const child of children(node, 'skill')) {
      markupShape(child, 'skill', ['ref']); empty(child);
      const skill = markupId(child.attrs.ref, child, 'Skill reference');
      attachments.push({ skill, ...target });
    }
  };
  for (const node of children(root, 'agent')) {
    markupShape(node, 'agent', ['id', 'description', 'tools', ...(version2 ? ['from'] : [])], ['description', 'skill']);
    const name = claim('agent', node.attrs.id, node);
    if (agents.some(agent => agent.id === name)) markupError('Agent ID already exists.', node);
    const parent = node.attrs.from ? reuse('agent', node.attrs.from, node, name) : null;
    if (parent?.dependencies?.length) markupError('This agent has remote resources. Use the existing reviewed authoring/import route; they cannot be silently dropped or fetched.', node);
    if (parent && node.attrs.tools !== undefined && list(node.attrs.tools).some(tool => !parent.tools.includes(tool))) markupError('A derived agent cannot silently expand its parent tools.', node);
    const extra = description(node);
    // The skill table is remapped below; copying its old phase selectors would silently lose skills.
    const body = parent ? withoutAttachedSkills(parent.prompt).trim() : null;
    newAgents.push({ id: name, description: text(node.attrs.description ?? parent?.description, node, 'Agent description'),
      instructions: text(parent ? [body, extra ? `## Workflow-specific guidance\n\n${extra}` : ''].filter(Boolean).join('\n\n') : extra, node, 'Agent prompt'),
      tools: node.attrs.tools !== undefined ? list(node.attrs.tools) : parent?.tools ?? [], ...(parent ? { parentId: parent.id, views: parent.worldModelViews } : {}) });
    if (parent) for (const use of effectiveLibrarySkills(parent)) {
      const steps = (use.phases ?? []).map(id => phaseMap.get(id)).filter(Boolean);
      if (use.phases?.length && !steps.length) continue;
      attachments.push({ skill: use.id, agent: name, use: use.use, ...(steps.length ? { steps } : {}) });
    }
    references(node, { agent: name });
  }
  const knownAgents = new Set(newAgents.map(agent => agent.id));
  const phases = {}; const templates = [];
  const decisionIds = new Set(decisions.map(decision => decision.id));
  for (const node of phaseNodes) {
    const phaseId = node.attrs.id;
    // Resolve the selected contract first: shared defaults may point outside this workflow,
    // while its approved override replaces those inputs, return routes or generation policy.
    let phase;
    if (!fresh) phase = remapPhase(mergePhaseOverride(definition.phases[node.attrs.from], base.phaseOverrides?.[node.attrs.from]));
    else if (node.attrs.from !== undefined) phase = copiedStep(node, { definition, from: node.attrs.from, phaseId, order: workflow.phases, localize });
    else {
      phase = { ...newStepContract(phaseId, text(node.attrs.label, node, 'Phase label'), node.attrs.output), approval: 'none' };
      templates.push({ path: phase.defaultTemplate, content: newStepTemplate(phaseId, phase.label) });
    }
    if (fresh && node.attrs.reads !== undefined) {
      const reads = list(node.attrs.reads);
      for (const value of reads) if (!phaseIds.has(value) || workflow.phases.indexOf(value) >= workflow.phases.indexOf(phaseId)) {
        markupError('reads names phases this workflow declares before this one.', node);
      }
      if (new Set(reads).size !== reads.length) markupError('reads names each phase once.', node);
      if (reads.length) phase.inputs = reads; else delete phase.inputs;
    }
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
      const current = phase.approval;
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
  for (const attachment of attachments) if (!knownSkills.has(attachment.skill)) {
    if (!version2) markupError('Every attached skill must be declared in this portable markup.', root);
    reuse('skill', attachment.skill, root);
  }
  const placedInstructions = new Set();
  for (const skill of skills) for (const tag of inlineInstructionTags(skill.instructions)) {
    if (!knownInstructions.has(tag.id)) {
      if (!version2) markupError('Every instruction tag must resolve to an instruction declared in this portable markup.', root);
      reuse('instruction', tag.id, root);
    }
    placedInstructions.add(tag.id);
  }
  for (const name of knownSkills) if (!attachments.some(item => item.skill === name)) markupError('A declared skill is unattached; attach it to a phase or agent so export cannot drop it.', declared.get(`skill:${name}`));
  for (const name of knownInstructions) if (!placedInstructions.has(name)) markupError('A declared instruction is not placed in a live skill procedure; quoted examples do not select it.', declared.get(`instruction:${name}`));
  if (version2) for (const selected of [...reusedAssets].filter(item => item.kind === 'skill')) {
    const skill = reuse('skill', selected.id, root, selected.as);
    for (const name of skill.instructionRefs) reuse('instruction', name, root);
  }
  for (const agent of newAgents) if (!phaseNodes.some(node => node.attrs.agent === agent.id)) markupError('A declared agent is not used by any phase.', declared.get(`agent:${agent.id}`));
  const codeAgents = new Set(phaseNodes.filter(node => phases[node.attrs.id].generation?.task === 'code').map(node => node.attrs.agent));
  const principal = id => newAgents.find(agent => agent.id === id)?.parentId ?? id;
  const codePrincipals = new Set([...codeAgents].map(principal));
  for (const node of phaseNodes) if (phases[node.attrs.id].artifact.kind === 'test-evidence' && codePrincipals.has(principal(node.attrs.agent))) {
    markupError('Independent test evidence and code repair require separate custom agents.', node);
  }
  workflow.decisions = decisions;
  if (fresh) {
    // A copied step keeps document upload where its library step allowed it, as a Studio copy does.
    const uploads = step => (definition.documents?.allowedPhases ?? []).includes(step)
      || Object.values(definition.workTypes ?? {}).some(type => type.phases?.includes(step) && type.documents?.allowedPhases?.includes(step));
    const allowedPhases = phaseNodes.filter(node => node.attrs.from !== undefined && uploads(node.attrs.from)).map(node => node.attrs.id);
    if (allowedPhases.length) workflow.documents = { allowedPhases };
  }
  if (children(root, 'omit').length) workflow.omits = children(root, 'omit').map(omit);
  const phaseAgents = Object.fromEntries(phaseNodes.map(node => [node.attrs.id, node.attrs.agent]));
  // A library step copied twice takes its MCP policy in each copy.
  const sourcePhases = fresh ? [...copies].flatMap(([from, ids]) => ids.map(phase => [from, phase])) : phaseMap;
  const mcp = derivedMcpPolicy({ id, definition, phaseMap: sourcePhases, phaseAgents, agents: newAgents, workflow, phases });
  for (const [sourceId, alias] of mcp.aliases) {
    markupId(alias, root, 'Derived MCP policy');
    if (Object.hasOwn(definition.mcpServers ?? {}, alias)) markupError('Derived MCP policy ID already exists.', root);
    if (version2) reuse('mcp-server', sourceId, root, alias);
  }
  let intent = null;
  if (version2) {
    const node = one(root, 'intent');
    if (!node) markupError('Version 2 needs the original intent and a structural coverage map.', root);
    markupShape(node, 'intent', ['family'], ['description', 'requirement', 'pattern']);
    const { WORKFLOW_INTENT_PATTERNS, WORKFLOW_INTENT_FAMILIES } = catalog;
    if (!WORKFLOW_INTENT_FAMILIES.some(item => item.id === node.attrs.family)) markupError('Choose a catalog workflow family.', node);
    const patterns = children(node, 'pattern').map(item => {
      markupShape(item, 'pattern', ['ref']); empty(item);
      const selected = WORKFLOW_INTENT_PATTERNS.find(pattern => pattern.id === item.attrs.ref);
      if (!selected) markupError('Unknown workflow pattern.', item);
      if (selected.status !== 'supported') markupError(`Pattern '${selected.id}' requires ${selected.route} and qualified adapters; do not silently replace it with sequential phases.`, item, 'WORKFLOW_MARKUP_CAPABILITY_REQUIRED');
      return selected.id;
    });
    const targets = new Set([...sourceMap.map(item => item.target), ...decisions.map(item => `decision:${item.id}`), ...reusedAssets.map(item => `${item.kind}:${item.as}`)]);
    const requirementIds = new Set();
    const requirements = children(node, 'requirement').map(item => {
      markupShape(item, 'requirement', ['id', 'maps-to'], [], true);
      const id = markupId(item.attrs.id, item, 'Intent requirement');
      if (requirementIds.has(id)) markupError('Intent requirement IDs must be unique.', item);
      requirementIds.add(id);
      const mapping = list(item.attrs['maps-to']);
      if (!mapping.length || mapping.some(target => !targets.has(target))) markupError('Every intent requirement must map to exact generated nodes or selected assets.', item);
      return { id, statement: text(markupText(item), item, 'Intent requirement statement'), targets: mapping };
    });
    if (!requirements.length) markupError('Capture at least one intent requirement; coverage is structural and still requires human review.', node);
    if (!patterns.length) markupError('Declare the requested workflow patterns explicitly; prose alone does not qualify runtime capabilities.', node);
    if (patterns.includes('choice') && !decisions.some(item => ['ask', 'branch'].includes(item.kind))) markupError('The requested choice pattern has no generated decision.', node);
    if (patterns.includes('bounded-loop') && !decisions.some(item => item.maxRounds > 0)) markupError('The requested bounded loop has no finite native round limit.', node);
    if (patterns.includes('human-checkpoint') && !Object.entries(phases).some(([id, phase]) => normalizeApprovalPolicy(workflow.phaseOverrides?.[id]?.approval ?? phase.approval,
      definition.approvalAuthorities, id, definition.approvalSecurity).mode === 'required')) markupError('The requested human checkpoint has no required native phase approval.', node);
    if (patterns.includes('test-repair') && !(Object.values(phases).some(phase => phase.artifact.kind === 'test-evidence') && codeAgents.size && decisions.some(item => item.maxRounds > 0))) markupError('A test-repair pattern needs independent test evidence, a code phase and a bounded return route.', node);
    const original = text(description(node), node, 'Original intent');
    intent = { family: node.attrs.family, text: original, sha256: digest(original), patterns: [...new Set(patterns)], requirements, structuralOnly: true, humanReviewRequired: true };
    // Keep authoring trace in an existing native prose field, so ordinary export/import retains it.
    // It is not a new executable policy field and never fabricates a semantic review or approval.
    workflow.description += `\n\n## Authoring intent\n\n${original}\n\nCatalog: ${catalog.sourceSha256}. Family: ${intent.family}.\n\nStructural coverage (requires human semantic review):\n`
      + requirements.map(item => `- ${item.id}: ${item.statement} -> ${item.targets.join(', ')}`).join('\n')
      + (reusedAssets.length ? '\n\nSource bindings:\n' + reusedAssets.map(item => `- ${item.kind}:${item.id} (${item.sha256}) -> ${item.as}`).join('\n') : '');
  }
  if (fresh && !workflow.description) delete workflow.description;
  const attachmentMappings = []; const localIds = new Set();
  for (const node of children(root, 'attachment')) {
    markupShape(node, 'attachment', ['id', 'sha256', 'kind', 'maps-to']); empty(node);
    const localId = markupId(node.attrs.id, node, 'Captured attachment ID');
    if (localIds.has(localId) || !/^sha256:[a-f0-9]{64}$/u.test(node.attrs.sha256 ?? '')) markupError('Attachment IDs must be unique and bind the captured SHA-256.', node);
    localIds.add(localId);
    const kind = node.attrs.kind, targets = list(node.attrs['maps-to']);
    if (!['agent', 'skill', 'instruction', 'reference'].includes(kind) || !targets.length || targets.some(target => !(sourceMap.some(item => item.target === target) || reusedAssets.some(item => `${item.kind}:${item.as}` === target))
        || kind !== 'reference' && !target.startsWith(`${kind}:`))) markupError('Map each attachment to declared objects of its proposed type; reference documents map to declared nodes.', node);
    attachmentMappings.push({ id: localId, sha256: node.attrs.sha256, kind, targets });
  }
  if (attachmentMappings.length) workflow.description += '\n\n## Local source mapping (candidate; requires human review)\n\n'
    + attachmentMappings.map(item => `- ${item.id} (${item.sha256}) as ${item.kind} -> ${item.targets.join(', ')}`).join('\n');
  return { id, extends: baseId, fresh, templates, workflow, phases, agents: newAgents, skills, instructions, attachments,
    phaseAgents, sourceMap, intent, reusedAssets, attachmentMappings, mcpServers: mcp.servers, mcpAliases: mcp.aliases };
}

/** All temporary writes are isolated; only --out writes a new explicit bundle after every check. */
export async function compileWorkflowMarkup(source, { out = null, repository = null, designReview = false, inspectPhase = null } = {}) {
  if (inspectPhase != null && out) markupError('Inspect the candidate without writing a bundle; save separately after review.');
  // Parse and credential-screen before initializing the scratch, loading catalogs or writing output.
  const parsed = parseWorkflowMarkup(source);
  if (!scanEntries([{ path: 'workflow-markup.xml', content: source, forceScan: true }]).clean) markupError('Possible credentials in markup; no bundle emitted.', null, 'WORKFLOW_MARKUP_CONTENT_BLOCKED');
  if (parsed.attrs.version === '2') {
    if (!/^sha256:[a-f0-9]{64}$/u.test(parsed.attrs.catalog ?? '') || !['approved', 'installed'].includes(parsed.attrs['catalog-source'])) markupError('Version 2 requires the exact catalog SHA-256 and an explicit catalog-source.', parsed, 'WORKFLOW_MARKUP_CATALOG_REQUIRED');
    const { withWorkflowIntentCatalog } = await import('./workflow-intent-catalog.mjs');
    try {
      return await withWorkflowIntentCatalog(repository, { source: parsed.attrs['catalog-source'], expectedSource: parsed.attrs.catalog }, catalog => {
        if (!parsed.attrs.catalog) markupError('Version 2 requires an exact catalog digest.', parsed);
        return compileCapturedMarkup(source, { out, catalog, designReview, inspectPhase });
      });
    } catch (error) { throw markupCompilerError(error); }
  }
  try { return await compileCapturedMarkup(source, { out, catalog: null, designReview, inspectPhase }); }
  catch (error) { throw markupCompilerError(error); }
}

/** Candidate-only review uses the same resolved policy and skill composer as runtime, without a Story. */
async function reviewDesign(root, resolved, definition, phaseAgents, { inspectPhase = null } = {}) {
  const order = resolved.phases.map(phase => phase.id);
  const phases = resolved.phases.map(phase => ({ id: phase.id, label: phase.label, agent: phaseAgents[phase.id],
    task: phase.generation?.task ?? null, writeScope: phase.writeScope ?? null, artifact: phase.artifact,
    inputs: phase.inputs ?? [], authoringSkill: phase.authoringSkill ?? null,
    approval: normalizeApprovalPolicy(phase.approval, definition.approvalAuthorities, phase.id, definition.approvalSecurity),
    qualityCommands: (phase.qualityCommands ?? []).map((command, index) => ({ id: command.id ?? `qualityCommands[${index}]`, name: command.name ?? command.label ?? null })) }));
  const edges = phases.flatMap((phase, index) => {
    const decision = (resolved.decisions ?? []).find(item => item.after === phase.id);
    const routes = decision ? decision.routes : [{ id: 'next', label: 'Continue', to: order[index + 1] ?? 'end' }];
    return routes.map(route => ({ from: phase.id, to: route.to === 'next' ? order[index + 1] ?? 'end' : route.to,
      label: route.label, decision: decision?.id ?? null, when: route.when ?? null,
      kind: order.indexOf(route.to) >= 0 && order.indexOf(route.to) <= index ? 'return' : 'forward',
      maxRounds: decision?.maxRounds ?? null, by: decision?.by ?? [] }));
  });
  const result = { schemaVersion: 1, kind: 'candidate-design-review', phases, edges, inspection: null,
    notice: 'Static candidate guidance only. Story inputs, World Model context, permissions, tool availability and final generation prompts are resolved at Story runtime. This is not approval or execution.' };
  if (inspectPhase != null) {
    const phase = resolved.phases.find(item => item.id === inspectPhase);
    if (!phase) markupError('Inspect a phase declared in the exact checked workflow.', null, 'WORKFLOW_MARKUP_PHASE_UNKNOWN');
    const { discoverAgents, renderAgentSkills } = await import('./agents.mjs');
    const agent = (await discoverAgents(root)).find(item => item.id === phaseAgents[phase.id]);
    if (!agent || agent.dependencies.length) markupError('Design inspection accepts only retained local agent guidance; it never fetches dependencies.');
    const guidance = await renderAgentSkills(root, { workItem: { id: 'design-preview', workType: resolved.id } }, phase, { agent: agent.id },
      { fetchImpl: async () => { throw new Error('Design inspection cannot fetch remote resources.'); } });
    const text = [withoutAttachedSkills(agent.prompt).trim(), guidance.text].filter(Boolean).join('\n\n');
    const instructions = [...new Map(guidance.skills.flatMap(skill => skill.referencedInstructions ?? []).map(item => [item.id, { id: item.id, label: item.label, sha256: item.sha256 }])).values()];
    result.inspection = { phase: phase.id, agent: { id: agent.id, description: agent.description, tools: agent.tools, sha256: agent.sha256, worldModelViews: agent.worldModelViews },
      skills: guidance.skills.map(skill => ({ id: skill.id, label: skill.label, sha256: skill.sha256, loading: skill.loading, use: skill.use, scopes: skill.scopes, instructionRefs: skill.instructionRefs })),
      instructions, representation: 'static-expanded-guidance', runtimeContextIncluded: false,
      bytes: Buffer.byteLength(text), estimatedTokens: Math.ceil(text.length / 4), tokenEstimate: 'Approximate characters / 4, not measured provider tokens; excludes runtime context.',
      sha256: digest(text), text: Buffer.byteLength(text) <= 256 * 1024 ? text : null,
      display: Buffer.byteLength(text) <= 256 * 1024 ? 'complete' : 'over-display-limit', warnings: guidance.warnings };
  }
  return result;
}

async function compileCapturedMarkup(source, { out, catalog, designReview, inspectPhase }) {
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
    if (catalog) for (const [relative, contents] of catalog.files) {
      const target = path.join(scratch, ...relative.split('/'));
      if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..') || !target.startsWith(scratch + path.sep)) markupError('Catalog asset is not a safe relative source path.');
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, contents, 'utf8');
    }
    const file = path.join(scratch, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(file, 'utf8'));
    const baselineAgents = await discoverAgents(scratch);
    const patterns = catalog ? await import('./workflow-intent-patterns.mjs') : null;
    const lowered = lowerWorkflowMarkup(source, { definition, agents: baselineAgents, catalog: catalog ? { ...catalog, ...patterns } : null });
    const put = async (relative, content) => {
      const target = path.join(scratch, ...relative.split('/')); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content, 'utf8');
    };
    const present = relative => lstat(path.join(scratch, ...relative.split('/'))).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    for (const [kind, entries, fileName] of [['skill-library', lowered.skills, 'SKILL.md'], ['instruction-library', lowered.instructions, 'INSTRUCTIONS.md']]) {
      for (const entry of entries) if (await present(`singularity/${kind}/${entry.id}/${fileName}`)) markupError('A declared dependency collides with the installed catalog; choose a fresh workflow namespace.');
    }
    // A new step's starter template, where Workflow Studio would write it.
    for (const template of lowered.templates) {
      const relative = path.posix.join(definition.templatesRoot ?? 'singularity/templates', template.path);
      if (await present(relative)) markupError('A new step template collides with the installed catalog; choose a fresh workflow namespace.');
      await put(relative, template.content);
    }
    for (const [id, phase] of Object.entries(lowered.phases)) definition.phases[id] = phase;
    definition.workTypes[lowered.id] = lowered.workflow;
    definition.mcpServers = { ...(definition.mcpServers ?? {}), ...lowered.mcpServers };
    // New phases use explicit custom agents. The bundle compiler captures scoped source bytes,
    // never an implicit change to an installed agent or its global attachments.
    const front = fields => `---\n${YAML.stringify(fields, { lineWidth: 0 })}---\n\n`;
    if (catalog) for (const [sourceId, alias] of lowered.mcpAliases) {
      const { mcpDescriptorPath } = await import('./mcp-descriptor.mjs');
      const descriptor = catalog.files.get(mcpDescriptorPath(sourceId));
      if (descriptor) await put(mcpDescriptorPath(alias), descriptor);
    }
    for (const agent of lowered.agents) {
      const selected = Object.entries(lowered.phaseAgents).filter(([, id]) => id === agent.id).map(([phase]) => phase);
      await put(`.github/agents/${agent.id}.agent.md`, front({ name: agent.id, description: agent.description, tools: agent.tools,
        metadata: { 'sflow-phases': selected.join(', '), 'sflow-default-for': selected.join(', '), ...(agent.views?.length ? { 'sflow-world-model-views': agent.views.join(', ') } : {}) } }) + agent.instructions + '\n');
    }
    for (const skill of lowered.skills) await put(`singularity/skill-library/${skill.id}/SKILL.md`, librarySkillText(skill));
    for (const instruction of lowered.instructions) await put(`singularity/instruction-library/${instruction.id}/INSTRUCTIONS.md`, instructionText(instruction));
    const baselineAttachments = parseSkillAttachments(await readFile(path.join(scratch, SKILL_ATTACHMENTS_PATH), 'utf8'));
    const attached = new Map();
    for (const item of lowered.attachments) {
      const key = `${item.agent ? 'agent:' + item.agent : 'workflow:' + item.workflow}/${item.skill}`;
      const prior = attached.get(key), steps = item.steps ?? [];
      if (prior && prior.use !== (item.use ?? '')) markupError('Duplicate skill attachments have conflicting use conditions; preserve the inherited condition or choose a separate namespaced procedure.');
      const entry = prior ?? { id: item.skill, ...(item.agent ? { agent: item.agent } : { workflow: item.workflow }), phases: steps, use: item.use ?? '' };
      entry.phases = prior && prior.phases.length && steps.length ? [...new Set([...prior.phases, ...steps])] : prior ? [] : steps;
      attached.set(key, entry);
    }
    await put(SKILL_ATTACHMENTS_PATH, skillAttachmentsText([...baselineAttachments, ...attached.values()]));
    let definitionText = YAML.stringify(definition, { lineWidth: 0 });
    if (lowered.fresh) {
      // A new workflow pins its planned claims as Workflow Studio does for one it creates.
      const [{ pinAuthoredStoryPlannedClaims, STORES }] = await Promise.all([import('./workflow-authoring.mjs')]);
      const document = YAML.parseDocument(definitionText);
      try { pinAuthoredStoryPlannedClaims(document, STORES.story, lowered.id, { newlyCreated: true }); }
      catch (error) {
        if (!/plannedClaims|planned-claim/u.test(error.message ?? '')) throw error;
        markupError(`${error.message.trim()} A phase with output="code" needs a phase before it that defines the requirements: copy one with from (for example from="requirements" or from="implementation-spec").`);
      }
      definitionText = document.toString({ lineWidth: 0 });
    }
    await writeFile(file, definitionText, 'utf8');
    const validated = await loadDefinition(scratch); const resolved = resolveWorkType(validated, lowered.id);
    assertWorkTypeStartable(resolved);
    const simulation = simulateWorkflowRoutes(resolved, { approvalAuthorities: validated.approvalAuthorities });
    if (simulation.status === 'failed') markupError('The native route simulation refused the graph.', null, 'WORKFLOW_MARKUP_GRAPH_INVALID');
    const bundle = await compileWorkflowBundle(scratch, [lowered.id]);
    const review = designReview || inspectPhase != null ? await reviewDesign(scratch, resolved, validated, lowered.phaseAgents, { inspectPhase }) : null;
    const outputPath = out ? await writeWorkflowBundle(bundle, out) : null;
    return { schemaVersion: 1, resultType: 'workflow-markup-compilation', format: WORKFLOW_MARKUP_FORMAT,
      status: 'portable-ready', sourceSha256: digest(source), bundleSha256: bundle.bundleSha256,
      workflow: { id: lowered.id, label: lowered.workflow.label, phases: resolved.phases.map(phase => ({ id: phase.id, label: phase.label, agent: lowered.phaseAgents[phase.id] })), decisions: resolved.decisions ?? [] },
      sourceMap: lowered.sourceMap, routeSimulation: simulation, intent: lowered.intent, reusedAssets: lowered.reusedAssets, attachmentMappings: lowered.attachmentMappings,
      ...(review ? { designReview: review } : {}),
      ...(catalog ? { catalog: { source: catalog.source, sourceSha256: catalog.sourceSha256 } } : {}), outputPath, ...(out ? {} : { bundle }),
      effects: { configurationChanged: false, storyChanged: false, approvalRecorded: false, bundleWritten: Boolean(out) },
      meaning: 'Portable-ready means deterministic definition, dependency and route checks passed; it is not approved, imported, activated or executed.' };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
