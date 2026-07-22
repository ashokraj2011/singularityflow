import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exists, nowIso, posix, snapshot, writeJson } from './util.mjs';

export const INPUTS_START = '<!-- singularity-flow:inputs:start -->';
export const INPUTS_END = '<!-- singularity-flow:inputs:end -->';
const INPUTS_PATTERN = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function utf8Prefix(buffer, maxBytes) {
  if (maxBytes == null || buffer.length <= maxBytes) return buffer.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function severity(mode, optional, status) {
  if (status === 'captured' || (optional && ['missing', 'unapproved'].includes(status))) return null;
  return mode === 'enforce' ? 'error' : 'warning';
}

function inputMessage(consumer, entry) {
  if (entry.status === 'missing') return `${consumer.id} requires approved input from ${entry.phase}; ${entry.path} is missing`;
  if (entry.status === 'unapproved') return `${consumer.id} requires approved input from ${entry.phase}; ${entry.phase} is ${entry.producerStatus}`;
  if (entry.status === 'hash_mismatch') return `${consumer.id} input from ${entry.phase} no longer matches its approved hash`;
  return null;
}

export function workflowInputsMode(workflow) {
  return workflow.resolution?.inputsMode ?? 'off';
}

export function resolvedPhaseInputs(workflow, phase) {
  return workflow.resolution?.phases?.find((candidate) => candidate.id === phase.id)?.inputs ?? phase.inputs ?? [];
}

export async function collectInputs(root, workflow, phase, { itemDirectory, itemRelative, generation = phase.generation + 1 } = {}) {
  const mode = workflowInputsMode(workflow);
  const declarations = resolvedPhaseInputs(workflow, phase);
  const records = [];
  const warnings = [];
  const errors = [];
  if (mode === 'off') return { mode, generation, records, warnings, errors };

  for (const declaration of declarations) {
    const producer = workflow.phases[declaration.phase];
    const relativeArtifact = declaration.path ?? producer?.requiredArtifact?.path ?? null;
    const repositoryPath = relativeArtifact ? posix(path.join(itemRelative, relativeArtifact)) : null;
    const registered = producer?.artifacts?.find((artifact) => artifact.path === repositoryPath);
    const current = relativeArtifact ? await snapshot(path.join(itemDirectory, relativeArtifact)) : { exists: false, size: 0, sha256: null };
    let status = 'captured';
    if (!current.exists) status = 'missing';
    else if (producer?.status !== 'approved' || registered?.status !== 'approved') status = 'unapproved';
    else if (!registered?.sha256 || registered.sha256 !== current.sha256) status = 'hash_mismatch';

    const record = {
      phase: declaration.phase,
      path: relativeArtifact,
      optional: declaration.optional ?? false,
      maxBytes: declaration.maxBytes ?? null,
      status,
      producerStatus: producer?.status ?? 'missing',
      producerGeneration: producer?.generation ?? 0,
      approvedAt: producer?.approvedAt ?? null,
      approvedBy: producer?.approvedBy ?? null,
      approvedSha256: registered?.sha256 ?? null,
      sha256: current.sha256,
      bytes: current.size,
      injectedBytes: 0,
      truncated: false,
      content: null
    };
    if (status === 'captured') {
      const raw = await readFile(path.join(itemDirectory, relativeArtifact));
      record.content = utf8Prefix(raw, declaration.maxBytes ?? null);
      record.injectedBytes = Buffer.byteLength(record.content, 'utf8');
      record.truncated = record.injectedBytes < raw.length;
    }
    const level = severity(mode, record.optional, status);
    const message = inputMessage(phase, record);
    if (level === 'error' && message) errors.push(message);
    if (level === 'warning' && message) warnings.push(message);
    records.push(record);
  }
  return { mode, generation, records, warnings, errors };
}

export function renderInputsBlock(result) {
  if (result.mode === 'off' || !result.records.length) return { text: '', sha256: null };
  const sections = result.records.map((entry) => {
    const header = `## Approved phase input: ${entry.phase}`;
    const metadata = `<!-- source=${entry.path ?? 'missing'} sha256=${entry.sha256 ?? 'unavailable'} status=${entry.status} -->`;
    if (entry.status !== 'captured') return `${header}\n\n${metadata}\n\n> ${inputMessage({ id: 'This phase' }, entry) ?? `Input is ${entry.status}.`}`;
    const suffix = entry.truncated ? '\n\n> Input truncated at its configured byte limit.' : '';
    return `${header}\n\n${metadata}\n\n${entry.content.trimEnd()}${suffix}`;
  });
  const text = `${INPUTS_START}\n\n# Approved phase inputs\n\n${sections.join('\n\n')}\n\n${INPUTS_END}`;
  return { text, sha256: sha256(text) };
}

export function applyInputsBlock(text, block, mode) {
  if (mode === 'off') return text.replace(INPUTS_PATTERN, '').replaceAll('{{inputs}}', '').replace(/\n{3,}/g, '\n\n');
  if (!block) return text.replaceAll('{{inputs}}', '');
  if (INPUTS_PATTERN.test(text)) return text.replace(INPUTS_PATTERN, block).replaceAll('{{inputs}}', '');
  if (text.includes('{{inputs}}')) return text.replaceAll('{{inputs}}', block);
  return `${text.trimEnd()}\n\n${block}\n`;
}

export function extractInputsBlock(text) {
  return text.match(INPUTS_PATTERN)?.[0] ?? null;
}

export async function recordInputs(root, workflow, phase, result, { itemDirectory } = {}) {
  const rendered = renderInputsBlock(result);
  const record = {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    phase: phase.id,
    generation: result.generation,
    mode: result.mode,
    recordedAt: nowIso(),
    renderedSha256: rendered.sha256,
    warnings: result.warnings,
    inputs: result.records.map(({ content, ...entry }) => entry)
  };
  const file = path.join(itemDirectory, 'context', `inputs-${phase.id}-gen${result.generation}.json`);
  await writeJson(file, record);
  const info = await snapshot(file);
  return { record, rendered, file, path: posix(path.relative(root, file)), sha256: info.sha256 };
}

export async function verifyInputsIntegrity(root, workflow, phase, { itemDirectory, itemRelative } = {}) {
  const mode = workflowInputsMode(workflow);
  const errors = [];
  const warnings = [];
  const passes = [];
  const declarations = resolvedPhaseInputs(workflow, phase);
  if (mode === 'off' || !declarations.length || phase.generation < 1) return { errors, warnings, passes };
  const add = (message) => (mode === 'enforce' ? errors : warnings).push(message);
  const file = path.join(itemDirectory, 'context', `inputs-${phase.id}-gen${phase.generation}.json`);
  if (!(await exists(file))) {
    add(`${phase.id} generation ${phase.generation} has no phase-input record`);
    return { errors, warnings, passes };
  }
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (record.workId !== workflow.workItem.id || record.phase !== phase.id || record.generation !== phase.generation || record.mode !== mode) add(`${phase.id} phase-input record identity or mode does not match workflow state`);
  const live = await collectInputs(root, workflow, phase, { itemDirectory, itemRelative, generation: phase.generation });
  for (const message of [...live.errors, ...live.warnings]) add(message);
  const recordedByPhase = new Map((record.inputs ?? []).map((entry) => [entry.phase, entry]));
  for (const entry of live.records) {
    const prior = recordedByPhase.get(entry.phase);
    if (!prior) add(`${phase.id} phase-input record omits ${entry.phase}`);
    else if (prior.status !== entry.status || prior.sha256 !== entry.sha256 || prior.approvedSha256 !== entry.approvedSha256) add(`${phase.id} phase-input record is stale for ${entry.phase}`);
  }
  const artifact = path.join(itemDirectory, phase.requiredArtifact.path);
  const artifactText = await readFile(artifact, 'utf8').catch(() => '');
  const block = extractInputsBlock(artifactText);
  if (!block || sha256(block) !== record.renderedSha256) add(`${phase.id} artifact does not contain the recorded managed input block`);
  if (!errors.length && !warnings.length) {
    const captured = live.records.filter((entry) => entry.status === 'captured');
    passes.push(`phase inputs verified: ${phase.id} ← ${captured.map((entry) => `${entry.phase}@${entry.sha256.slice(0, 8)}`).join(', ') || 'none'}`);
  }
  return { errors, warnings, passes };
}
