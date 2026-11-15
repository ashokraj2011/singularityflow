/**
 * What each step's agent receives, layer by layer, as the phase prompt composer puts it together
 * (src/phase-prompt-composer.mjs): its agent file, the step's own template, the skills and the
 * instructions they place, the workflow's own guidance (its skills and constitution), and the
 * platform's rules, which every agent of that step gets whatever the team wrote. Each layer with its
 * file, who owns its text, and its size.
 *
 * Who owns a text decides what is judged: `team` is the repository's own; `sflow` is SFlow's own text
 * (a line SFlow ships in its agents, templates, skills or instructions, kept by a copy, or the
 * boundary every agent file carries); `platform` is composed. Paths come from the Studio model, so
 * an agent file is read wherever this repository keeps its agents.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { bodyOf, blockSentences, bytesOf, markdownLines, sectionsOf, textBlocks, tokensOf } from './text.mjs';

const WORK_ID = 'WORK-ID';

/** Lines SFlow ships in its own agents, templates, skills and instructions, read once per process. */
let shippedLinesPromise = null;
async function shippedLines() {
  shippedLinesPromise ??= (async () => {
    const { PACKAGE_ROOT } = await import('../package-root.mjs');
    const { AGENT_CLARIFICATION_GUIDANCE, REPOSITORY_AGENT_BOUNDARY, STORY_AGENT_BOUNDARY } = await import('../agent-guidance.mjs');
    const lines = new Set([AGENT_CLARIFICATION_GUIDANCE, REPOSITORY_AGENT_BOUNDARY, STORY_AGENT_BOUNDARY].map(normalizedLine));
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (/\.md$/u.test(entry.name)) {
          for (const line of (await readFile(target, 'utf8').catch(() => '')).split('\n')) {
            const key = normalizedLine(line);
            if (key.length >= 20) lines.add(key);
          }
        }
      }
    };
    for (const folder of ['agents', 'artifacts', 'skill-library', 'instruction-library']) await walk(path.join(PACKAGE_ROOT, 'templates', folder));
    return lines;
  })();
  return shippedLinesPromise;
}
const normalizedLine = (line) => String(line ?? '').replace(/\s+/gu, ' ').trim();

/**
 * A file's text, read as Markdown: its lines, blocks and sentences, each sentence owned by SFlow
 * when every line it spans is a line SFlow ships.
 */
export async function readSource(text, file) {
  const shipped = await shippedLines();
  const { offset } = bodyOf(text);
  const lines = markdownLines(text, { from: offset });
  const byLine = new Map(lines.map((entry) => [entry.line, entry]));
  const blocks = textBlocks(lines);
  const sentences = [];
  for (const block of blocks) {
    const own = [];
    for (let line = block.line; line <= block.endLine; line += 1) own.push(shipped.has(normalizedLine(byLine.get(line)?.text)));
    for (const sentence of blockSentences(text, block)) {
      const line = lineAt(lines, sentence.start);
      const endLine = lineAt(lines, Math.max(sentence.start, sentence.end - 1));
      const sflow = own.slice(line - block.line, endLine - block.line + 1).every(Boolean);
      sentences.push({ ...sentence, file, line, endLine, block, section: block.section?.title ?? null, owner: sflow ? 'sflow' : 'team' });
    }
  }
  const judged = lines.filter((entry) => ['prose', 'list', 'guidance', 'quote'].includes(entry.kind));
  const owner = judged.length && judged.every((entry) => shipped.has(normalizedLine(entry.text))) ? 'sflow' : judged.length ? 'team' : 'sflow';
  return { text, file, lines, blocks, sentences, sections: sectionsOf(text, lines), owner };
}

function lineAt(lines, offset) {
  let found = lines[0]?.line ?? 1;
  for (const entry of lines) { if (entry.start > offset) break; found = entry.line; }
  return found;
}

/** Read a configuration file once per assessment; `overlay` gives a file's text as an edit would leave it. */
function fileCache(configRoot, overlay = null) {
  const cache = new Map();
  return (file) => {
    if (!file) return Promise.resolve(null);
    if (!cache.has(file)) {
      cache.set(file, overlay?.has(file) ? readSource(overlay.get(file), file)
        : readFile(path.join(configRoot, file), 'utf8').then((text) => readSource(text, file), () => null));
    }
    return cache.get(file);
  };
}

/**
 * A Story at a step's first draft, enough for the composer's pure contract renderers: the step in
 * progress with no generation yet, a code step's first generation open.
 */
function storyOf(definition, workflowId, resolved, phaseRequiresCodeDelivery) {
  const phases = Object.fromEntries((resolved.phases ?? []).map((phase) => {
    const state = { ...phase, status: 'in_progress', generationPolicy: phase.generationPolicy ?? phase.generation, generation: 0 };
    return [phase.id, phaseRequiresCodeDelivery(state) ? { ...state, generationIntent: { status: 'open', generation: 1 } } : state];
  }));
  return { workItem: { id: WORK_ID, title: '', workType: workflowId }, phaseOrder: (resolved.phases ?? []).map((phase) => phase.id), phases,
    resolution: { phases: resolved.phases, spec: definition.spec ?? null } };
}

/**
 * The platform's own rules for one step, as the composer renders them for every Story: the phase
 * contract's lines, the clarification checkpoint and its final guard, the runtime protocols, the
 * approved-inputs lead and the step's MCP policy. Measured from the composer's own renderers; a
 * renderer that needs a live Story is left out and said so.
 */
async function platformText(definition, story, phase, { agent, hasInputs, templateText }) {
  const composer = await import('../phase-prompt-composer.mjs');
  const { renderClarificationProtocol, resolvedClarificationPolicy } = await import('../clarifications.mjs');
  const { phaseRequiresCodeDelivery } = await import('../code-delivery-policy.mjs');
  const mcp = await import('../mcp.mjs');
  const parts = [];
  const missing = [];
  const attempt = (name, render) => { try { const text = render(); if (text) parts.push({ name, text }); } catch (error) { missing.push({ name, reason: error.message }); } };
  let contract = null;
  attempt('phase contract', () => {
    contract = composer.phasePromptExecutionContract(definition, story, story.phases[phase.id], { template: templateText ?? '' });
    return [`# Active Story phase contract: ${phase.label ?? phase.id}`, '', ...contract.lines,
      `- Write scope: \`${phase.writeScope ?? 'artifact-only'}\``].join('\n');
  });
  const policy = contract?.clarification ?? (() => { try { return resolvedClarificationPolicy(definition, story, story.phases[phase.id]); } catch { return { mode: 'off', maxQuestions: 0, topics: [] }; } })();
  attempt('clarification checkpoint', () => renderClarificationProtocol(policy, phase.id));
  if (hasInputs) attempt('approved inputs', () => composer.APPROVED_INPUTS_LEAD);
  attempt('final clarification guard', () => composer.renderFinalClarificationGuard(phase.id, policy, {
    deterministicOnly: Boolean(contract?.deterministicOnly), codeStep: phaseRequiresCodeDelivery(story.phases[phase.id]) }));
  attempt('runtime protocols', () => composer.withPhasePromptRuntimeGuidance('', definition, story, story.phases[phase.id]).trim());
  attempt('MCP policy', () => mcp.renderMcpPromptPolicy(definition, { agent, phase: phase.id, workflow: story }));
  return { text: parts.map((part) => part.text).join('\n\n'), parts: parts.map((part) => ({ name: part.name, bytes: bytesOf(part.text) })), missing, policy };
}

/** One layer: `text` is what the agent receives, `view` the text a builder move edits (text-moves.mjs). */
function layerOf({ layer, id, label, source, delivered = 'always', text, owner, target = null, scope = null, view = null }) {
  const body = text ?? source?.text ?? '';
  const bytes = bytesOf(body);
  // The team's own sentences, as many bytes as the agent receives of them; the rest of a file is SFlow's.
  const own = owner === 'platform' ? 0 : (source?.sentences ?? []).filter((sentence) => sentence.owner === 'team').reduce((sum, sentence) => sum + bytesOf(sentence.exact) + 1, 0);
  return { key: `${target?.kind ?? layer}:${target?.id ?? source?.file ?? id}`, layer, id, label, file: source?.file ?? null, owner: owner ?? source?.owner ?? 'sflow',
    delivered, bytes, tokens: tokensOf(body), teamBytes: Math.min(bytes, own), text: body, source: source ?? null, target, scope, view: target ? view : null,
    // A section the agent never receives (the skill tables Studio keeps) is not one of its sizes.
    sections: (source?.sections ?? []).filter((section) => !/^(?:attached|remote) skills$|^remote (?:artifact templates|generated artifacts)$/iu.test(section.title)) };
}

/**
 * Every step of `workflowId` with the layers its agent receives. `context` holds what one
 * assessment reads once: the Studio model, the loaded definition, the configuration root.
 */
export async function workflowLayers(workflowId, { model, definition, configRoot, resolveWorkType, overlay = null }) {
  const { mcpServersForContext } = await import('../mcp.mjs');
  const { withoutAttachedSkills, withoutTableSection } = await import('../skill-library.mjs');
  const read = fileCache(configRoot, overlay);
  // A file the overlay edits is read as edited: what its agent receives and the text a move edits.
  const edited = (source) => Boolean(source && overlay?.has(source.file));
  const body = (source) => bodyOf(source.text).body;
  const workflow = model.workflows.find((entry) => entry.id === workflowId);
  const resolved = resolveWorkType(definition, workflowId);
  const story = storyOf(definition, workflowId, resolved, (await import('../code-delivery-policy.mjs')).phaseRequiresCodeDelivery);
  const agents = new Map(model.agents.map((agent) => [agent.id, agent]));
  const skills = new Map((model.skills ?? []).map((skill) => [skill.id, skill]));
  const instructions = new Map((model.instructions ?? []).map((item) => [item.id, item]));
  const templatesRoot = definition.templatesRoot ?? model.templatesRoot ?? 'singularity/templates';
  const constitution = (model.constitutions ?? []).find((file) => file.present && file.workflows.some((entry) => entry.id === workflowId)) ?? null;
  const steps = [];
  for (const step of workflow.steps) {
    const phase = resolved.phases.find((entry) => entry.id === step.id) ?? { id: step.id, label: step.label };
    const layers = [];
    const agent = step.agent ? agents.get(step.agent) : null;
    const agentDefinition = step.agent ? definition.agents?.[step.agent] : null;
    if (agent) {
      const source = agent.path ? await read(agent.path) : null;
      const prompt = String(edited(source) ? body(source) : agentDefinition?.prompt ?? agent.prompt ?? agent.instructions ?? '').replaceAll('{{WORLD_MODEL}}', '');
      layers.push(layerOf({ layer: 'agent', id: agent.id, label: agent.label, source, text: withoutTableSection(withoutAttachedSkills(prompt), 'Remote skills').trimEnd(),
        owner: agent.scope === 'repository' && source ? source.owner : 'sflow', target: agent.scope === 'repository' && agent.path ? { kind: 'agent', id: agent.id } : null,
        view: edited(source) ? withoutAttachedSkills(body(source)).trim() : agent.instructions ?? '' }));
    }
    const template = typeof (phase.template ?? phase.defaultTemplate) === 'string' ? phase.template ?? phase.defaultTemplate : null;
    let templateSource = null;
    if (template) {
      templateSource = await read(path.posix.join(templatesRoot, template));
      if (templateSource) layers.push(layerOf({ layer: 'step', id: template, label: `template ${template}`, source: templateSource, target: { kind: 'template', id: template }, view: templateSource.text }));
    }
    const placed = new Set();
    for (const entry of step.skills ?? []) {
      const skill = skills.get(entry.id);
      if (!skill) continue;
      const source = await read(skill.path);
      const skillText = edited(source) ? body(source).trim() : skill.instructions;
      layers.push(layerOf({ layer: entry.scope === 'workflow' ? 'workflow' : 'skill', id: skill.id, label: skill.label ?? skill.id, source,
        text: skillText, delivered: skill.loading === 'on-demand' ? 'on-demand' : 'always', target: source ? { kind: 'skill', id: skill.id } : null, scope: entry.scope ?? 'agent',
        view: skillText ?? '' }));
      for (const ref of skill.instructionRefs ?? []) {
        const item = instructions.get(ref);
        if (!item || placed.has(ref)) continue;
        placed.add(ref);
        const itemSource = await read(item.path);
        const itemText = edited(itemSource) ? body(itemSource).trim() : item.instructions;
        layers.push(layerOf({ layer: 'instruction', id: item.id, label: item.label ?? item.id, source: itemSource, text: itemText,
          delivered: skill.loading === 'on-demand' ? 'on-demand' : 'always', target: itemSource ? { kind: 'instruction', id: item.id } : null, view: itemText ?? '' }));
      }
    }
    if (constitution) {
      const source = await read(constitution.path);
      if (source) layers.push(layerOf({ layer: 'workflow', id: constitution.path, label: 'constitution', source }));
    }
    const platform = await platformText(definition, story, phase, { agent: step.agent, hasInputs: (step.inputs ?? []).length > 0, templateText: templateSource?.text ?? null });
    layers.push({ ...layerOf({ layer: 'platform', id: 'platform', label: 'the platform\'s rules', text: platform.text, owner: 'platform' }), parts: platform.parts, missing: platform.missing });
    const agentTools = agentDefinition?.tools ?? agent?.tools ?? [];
    steps.push({
      id: step.id, label: step.label, agent: agent ? { id: agent.id, label: agent.label, tools: [...agentTools] } : null,
      settings: {
        output: step.output, changesCode: Boolean(step.changesCode ?? step.output === 'code'), writeScope: phase.writeScope ?? 'artifact-only',
        clarification: platform.policy?.mode ?? 'off', inputs: [...(step.inputs ?? [])], template,
        templateHeadings: (templateSource?.lines ?? []).filter((entry) => entry.kind === 'heading').map((entry) => entry.heading.title),
        definesClauses: Boolean(step.definesClauses), mcpServers: mcpServersForContext(definition, { agent: step.agent, phase: step.id }).map((server) => server.id),
        authorIsAgent: (phase.generation?.allowedProducers ?? ['governed-agent']).includes('governed-agent')
      },
      layers
    });
  }
  return { workflow, resolved, steps, templatesRoot };
}

