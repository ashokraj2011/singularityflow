import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderAgentSkills } from './agents.mjs';
import { loadDefinition } from './config.mjs';
import {
  resolveWorldModelContext,
  groundingMode,
  worldModelCommit
} from './grounding.mjs';
import { validatePortfolioWorldModelViews } from './initiative-config.mjs';
import {
  initiativeDir,
  loadInitiative,
  verifyInitiativePhaseInputs
} from './initiative-state.mjs';
import { loadSession } from './session.mjs';
import {
  SingularityFlowError,
  exists,
  nowIso,
  posix,
  run,
  snapshot,
  writeJson,
  writeText
} from './util.mjs';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function promptRelative(initiative, phaseId, generation) {
  return posix(path.join('context', 'prompts', `${phaseId}-gen${generation}.md`));
}

function recordRelative(phaseId, generation) {
  return posix(path.join('context', `prompt-context-${phaseId}-gen${generation}.json`));
}

function phaseContract(phase) {
  const lines = [
    `# Initiative phase contract: ${phase.label}`,
    '',
    `- Phase ID: \`${phase.id}\``,
    `- Lanes: ${phase.lanes.length ? phase.lanes.join(', ') : 'not classified'}`,
    '- Outputs:'
  ];
  for (const output of phase.outputs) {
    lines.push(`  - \`${output.id}\` (${output.kind}, ${output.required ? 'required' : 'optional'})${output.consumes.length ? ` consumes ${output.consumes.join(', ')}` : ''}`);
  }
  lines.push('- Checklist:');
  for (const check of phase.checklist) {
    lines.push(`  - \`${check.id}\` (${check.requirement}, gate=${check.gate}, assurance=${check.acceptedAssurance.join('|')})`);
  }
  return lines.join('\n');
}

async function approvedInputSections(root, portfolio, initiative, phase) {
  const verified = await verifyInitiativePhaseInputs(root, portfolio, initiative, phase.id);
  const references = unique(verified.map((item) => item.producer));
  const sections = [];
  for (const reference of references) {
    const [producerPhase, producerOutput] = reference.split('/');
    const record = initiative.phases[producerPhase].outputs[producerOutput];
    const absolute = path.join(initiativeDir(root, portfolio, initiative.initiative.id), record.path);
    const content = await readFile(absolute, 'utf8');
    sections.push({
      reference,
      path: posix(path.relative(root, absolute)),
      sha256: record.sha256,
      bytes: Buffer.byteLength(content),
      content
    });
  }
  return sections;
}

async function repositoryGrounding(root, definition, phase, persona, mode) {
  const warnings = [];
  if (mode === 'off') return { text: '', files: [], warnings, record: { mode, available: false } };
  const requiredViews = unique([
    ...(phase.worldModelViews ?? []),
    ...(definition.personas[persona]?.worldModelViews ?? [])
  ]);
  const config = {
    outputDir: definition.worldModel?.outputDir ?? 'singularity/world-model',
    grounding: mode,
    staleness: definition.worldModel?.staleness ?? 'warn',
    context: { always: ['core/summary.md'], includeDomains: 'matched', includeEvidence: false },
    phases: { [phase.id]: { views: requiredViews, depth: 'standard', evidence: false } }
  };
  try {
    const resolved = await resolveWorldModelContext(root, config, phase.id);
    const commit = worldModelCommit(root, config.outputDir);
    const changes = run('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', config.outputDir], { cwd: root }).stdout.trim();
    const issues = [];
    if (!commit) issues.push('repository world model is not committed');
    if (changes) issues.push('repository world-model files have uncommitted changes');
    if (!resolved.freshness.fresh) issues.push('repository world model is stale');
    if (issues.length && mode === 'enforce') {
      throw new SingularityFlowError(`${issues.join('; ')}. Run singularity-flow wm build --views "${requiredViews.join(',')}" --focus "initiative phase ${phase.id}" before composing the initiative prompt.`);
    }
    if (issues.length) warnings.push(...issues);
    const files = [];
    for (const item of resolved.selected) {
      const content = await readFile(item.absolute, 'utf8');
      files.push({
        path: posix(path.relative(root, item.absolute)),
        sha256: item.sha256,
        bytes: item.size,
        reason: item.reason,
        content
      });
    }
    const text = files.map((file) => [
      `## Repository world model: ${file.path}`,
      '',
      `<!-- sha256=${file.sha256} reason=${file.reason} -->`,
      '',
      file.content.trim()
    ].join('\n')).join('\n\n');
    return {
      text,
      files: files.map(({ content, ...file }) => file),
      warnings,
      record: {
        mode,
        available: true,
        commit,
        sourceTreeSha256: resolved.manifest.source_tree_sha256 ?? null,
        fresh: resolved.freshness.fresh,
        requiredViews
      }
    };
  } catch (error) {
    if (mode === 'enforce') {
      throw new SingularityFlowError(`${error.message} Run singularity-flow wm build --views "${requiredViews.join(',')}" --focus "initiative phase ${phase.id}", then retry.`);
    }
    warnings.push(`Repository world model unavailable: ${error.message}`);
    return { text: '', files: [], warnings, record: { mode, available: false, requiredViews } };
  }
}

export async function composeInitiativeContext(root, initiativeId, requestedPhase = null, {
  persona = null,
  dryRun = false
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const definition = await loadDefinition(root);
  validatePortfolioWorldModelViews(portfolio, definition);
  const phaseId = requestedPhase ?? initiative.currentPhase;
  if (!phaseId || phaseId !== initiative.currentPhase) {
    throw new SingularityFlowError(`Current initiative phase is '${initiative.currentPhase ?? 'complete'}'; cannot compose '${phaseId ?? 'none'}'.`);
  }
  const phase = initiative.resolution.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new SingularityFlowError(`Unknown initiative phase '${phaseId}'.`);
  const session = await loadSession(root, { required: false });
  const selectedPersona = persona ?? (session?.workId === initiativeId ? session.persona : null);
  if (!selectedPersona || !definition.personas[selectedPersona]) {
    throw new SingularityFlowError(`Initiative prompt composition requires a selected session persona for ${initiativeId}. Resume the initiative and choose one.`);
  }
  const generation = initiative.phases[phaseId].generation + 1;
  const itemDirectory = initiativeDir(root, portfolio, initiativeId);
  if (!dryRun && await exists(path.join(itemDirectory, recordRelative(phaseId, generation)))) {
    const verification = await verifyInitiativeContext(root, portfolio, initiative, phaseId, generation);
    if (verification.valid && !verification.warnings.length && verification.record?.persona === selectedPersona) {
      return {
        portfolio,
        initiative,
        phase,
        rendered: await readFile(path.join(root, verification.record.promptPath), 'utf8'),
        record: verification.record,
        warnings: verification.record.warnings ?? [],
        dryRun,
        reused: true
      };
    }
  }
  const personaPath = path.join(root, definition.personaPromptsRoot, definition.personas[selectedPersona].prompt);
  if (!(await exists(personaPath))) throw new SingularityFlowError(`Persona prompt is missing: ${posix(path.relative(root, personaPath))}`);
  const personaText = await readFile(personaPath, 'utf8');
  const personaSnapshot = await snapshot(personaPath);
  const inputs = await approvedInputSections(root, portfolio, initiative, phase);
  const mode = initiative.resolution.worldModelGrounding ?? groundingMode(definition);
  const grounding = await repositoryGrounding(root, definition, phase, selectedPersona, mode);
  const pseudoWorkflow = {
    workItem: { id: initiativeId, workType: `initiative:${initiative.initiative.profile}` },
    currentPhase: phaseId
  };
  const remote = await renderAgentSkills(
    root,
    pseudoWorkflow,
    { id: phaseId, generation: initiative.phases[phaseId].generation },
    session?.workId === initiativeId ? session : { persona: selectedPersona },
    { record: !dryRun, itemDirectory }
  );
  const inputText = inputs.map((input) => [
    `## Approved initiative input: ${input.reference}`,
    '',
    `<!-- path=${input.path} sha256=${input.sha256} bytes=${input.bytes} -->`,
    '',
    input.content.trim()
  ].join('\n')).join('\n\n');
  const rendered = [
    `# Governed Copilot prompt — ${initiativeId}/${phaseId} generation ${generation}`,
    '',
    phaseContract(phase),
    '',
    `## Selected persona: ${definition.personas[selectedPersona].label}`,
    '',
    `<!-- path=${posix(path.relative(root, personaPath))} sha256=${personaSnapshot.sha256} -->`,
    '',
    personaText.trim(),
    grounding.text,
    remote.text,
    inputText
  ].filter((section) => section?.trim()).join('\n\n') + '\n';
  const renderedSha256 = createHash('sha256').update(rendered).digest('hex');
  const record = {
    schemaVersion: 1,
    initiativeId,
    profile: initiative.initiative.profile,
    phase: phaseId,
    generation,
    persona: selectedPersona,
    phaseResolutionSha256: initiative.resolution.resolutionSha256,
    personaPrompt: {
      path: posix(path.relative(root, personaPath)),
      sha256: personaSnapshot.sha256,
      bytes: personaSnapshot.size
    },
    worldModel: grounding.record,
    worldModelFiles: grounding.files,
    inputs: inputs.map(({ content, ...input }) => input),
    remoteAgent: session?.workId === initiativeId && session.agent ? {
      id: session.agent,
      skills: remote.skills.map((skill) => ({ id: skill.id, sha256: skill.sha256, bytes: skill.size }))
    } : null,
    renderedSha256,
    renderedBytes: Buffer.byteLength(rendered),
    promptPath: posix(path.join(
      path.relative(root, itemDirectory),
      promptRelative(initiative, phaseId, generation)
    )),
    warnings: [...grounding.warnings, ...remote.warnings],
    recordedAt: nowIso()
  };
  if (!dryRun) {
    await writeText(path.join(itemDirectory, promptRelative(initiative, phaseId, generation)), rendered);
    await writeJson(path.join(itemDirectory, recordRelative(phaseId, generation)), record);
  }
  return { portfolio, initiative, phase, rendered, record, warnings: record.warnings, dryRun };
}

export async function verifyInitiativeContext(root, portfolio, initiative, phaseId, generation = null) {
  const targetGeneration = generation ?? initiative.phases[phaseId].generation + 1;
  const itemDirectory = initiativeDir(root, portfolio, initiative.initiative.id);
  const relative = recordRelative(phaseId, targetGeneration);
  const absolute = path.join(itemDirectory, relative);
  const mode = initiative.resolution.worldModelGrounding ?? 'off';
  const errors = [];
  const warnings = [];
  if (!(await exists(absolute))) {
    const message = `governed Copilot prompt is missing for ${phaseId} generation ${targetGeneration}; run singularity-flow initiative context ${phaseId}`;
    (mode === 'enforce' ? errors : warnings).push(message);
    return { valid: !errors.length, mode, errors, warnings, path: relative, record: null };
  }
  const record = JSON.parse(await readFile(absolute, 'utf8'));
  const expectedPrompt = posix(path.join(
    path.relative(root, itemDirectory),
    promptRelative(initiative, phaseId, targetGeneration)
  ));
  if (record.promptPath !== expectedPrompt) errors.push(`initiative prompt path mismatch: ${record.promptPath ?? 'missing'}`);
  const prompt = await snapshot(path.join(root, record.promptPath ?? ''));
  if (record.initiativeId !== initiative.initiative.id || record.phase !== phaseId || record.generation !== targetGeneration) errors.push(`initiative prompt identity mismatch: ${relative}`);
  if (!prompt.exists || prompt.sha256 !== record.renderedSha256) errors.push(`initiative prompt content changed after composition: ${record.promptPath ?? relative}`);
  for (const input of record.inputs ?? []) {
    const current = await snapshot(path.join(root, input.path));
    if (!current.exists || current.sha256 !== input.sha256) errors.push(`initiative prompt input changed: ${input.reference}`);
  }
  for (const file of record.worldModelFiles ?? []) {
    const current = await snapshot(path.join(root, file.path));
    if (!current.exists || current.sha256 !== file.sha256) errors.push(`initiative world-model context changed: ${file.path}`);
    if (record.worldModel?.commit) {
      const committed = run('git', ['show', `${record.worldModel.commit}:${file.path}`], { cwd: root, allowFailure: true });
      if (committed.status !== 0 || createHash('sha256').update(committed.stdout).digest('hex') !== file.sha256) {
        errors.push(`initiative world-model commit does not pin ${file.path}`);
      }
    }
  }
  if (mode === 'enforce') {
    if (!record.worldModel?.available || !record.worldModel?.fresh) errors.push(`initiative world-model grounding is not fresh for ${phaseId}`);
    if (!/^[0-9a-f]{40}$/.test(record.worldModel?.commit ?? '')) errors.push(`initiative world-model commit is missing for ${phaseId}`);
  }
  if (errors.length && mode !== 'enforce') warnings.push(...errors.splice(0));
  return { valid: !errors.length, mode, errors, warnings, path: relative, record };
}
