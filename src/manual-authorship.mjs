import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { SingularityFlowError, writeBytes } from './util.mjs';

export const AUTHORSHIP_PRODUCERS = Object.freeze([
  'human', 'governed-agent', 'deterministic', 'external-tool', 'legacy-unspecified'
]);

export const AUTHORSHIP_CHANNELS = Object.freeze([
  'manual-in-place', 'manual-import', 'copilot-host', 'kernel-model', 'kernel-generator', 'external-tool', 'legacy'
]);

const CHANNELS_BY_PRODUCER = Object.freeze({
  human: new Set(['manual-in-place', 'manual-import']),
  'governed-agent': new Set(['copilot-host', 'kernel-model']),
  deterministic: new Set(['kernel-generator']),
  'external-tool': new Set(['external-tool']),
  'legacy-unspecified': new Set(['legacy'])
});

const MANAGED_METADATA = /^<!-- singularity-flow:metadata\n[\s\S]*?\n-->\s*/;
const MANAGED_METADATA_MARKER = '<!-- singularity-flow:metadata';
const MANAGED_INPUTS = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/g;

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

const MEDIA_TYPES = Object.freeze({
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
  '.json': 'application/json', '.yml': 'application/yaml', '.yaml': 'application/yaml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.pdf': 'application/pdf'
});

function artifactMediaType(filePath) {
  return MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function validateArtifactType(filePath, contract, label) {
  const extension = path.extname(filePath).toLowerCase();
  const mediaType = artifactMediaType(filePath);
  const allowedExtensions = contract.allowedExtensions?.map((value) => String(value).toLowerCase());
  if (allowedExtensions?.length && !allowedExtensions.includes(extension)) {
    throw new SingularityFlowError(`${label} has extension '${extension || '(none)'}'; allowed extensions: ${allowedExtensions.join(', ')}.`, { code: 'MANUAL_ARTIFACT_INVALID' });
  }
  if (contract.allowedMediaTypes?.length && !contract.allowedMediaTypes.includes(mediaType)) {
    throw new SingularityFlowError(`${label} has media type '${mediaType}'; allowed media types: ${contract.allowedMediaTypes.join(', ')}.`, { code: 'MANUAL_ARTIFACT_INVALID' });
  }
  return mediaType;
}

function defaultChannel(producer, imported) {
  if (producer === 'human') return imported ? 'manual-import' : 'manual-in-place';
  if (producer === 'governed-agent') return 'copilot-host';
  if (producer === 'deterministic') return 'kernel-generator';
  if (producer === 'external-tool') return 'external-tool';
  return 'legacy';
}

export function normalizeAuthorshipOptions({ producer, channel, imported = false, externalAiUse = null } = {}) {
  const normalizedProducer = producer ?? 'legacy-unspecified';
  if (!AUTHORSHIP_PRODUCERS.includes(normalizedProducer)) {
    throw new SingularityFlowError(`Unknown authorship producer '${normalizedProducer}'. Expected ${AUTHORSHIP_PRODUCERS.join(', ')}.`, { code: 'MANUAL_AUTHORSHIP_REQUIRED' });
  }
  const normalizedChannel = channel ?? defaultChannel(normalizedProducer, imported);
  if (!AUTHORSHIP_CHANNELS.includes(normalizedChannel) || !CHANNELS_BY_PRODUCER[normalizedProducer].has(normalizedChannel)) {
    throw new SingularityFlowError(`Authorship channel '${normalizedChannel}' is incompatible with producer '${normalizedProducer}'.`, { code: 'MANUAL_AUTHORSHIP_REQUIRED' });
  }
  if (externalAiUse != null && !['none', 'assisted'].includes(externalAiUse)) {
    throw new SingularityFlowError('--external-ai must be none or assisted when supplied.');
  }
  return Object.freeze({ producer: normalizedProducer, channel: normalizedChannel, externalAiUse });
}

export function assertProducerAllowed(phase, producer) {
  const allowed = phase.generationPolicy?.allowedProducers ?? ['governed-agent', 'human'];
  if (!allowed.includes(producer) && producer !== 'legacy-unspecified') {
    throw new SingularityFlowError(`Phase '${phase.id}' does not permit '${producer}' authorship. Allowed producers: ${allowed.join(', ')}.`, {
      code: 'MANUAL_ARTIFACT_INVALID', details: { phase: phase.id, producer, allowedProducers: allowed }
    });
  }
}

function validateHeadings(text, headings, label) {
  if (!headings?.length) return;
  const present = new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) => match[1].trim().toLowerCase()));
  const missing = headings.filter((heading) => !present.has(String(heading).trim().toLowerCase()));
  if (missing.length) throw new SingularityFlowError(`${label} is missing required Markdown headings: ${missing.join(', ')}.`, { code: 'MANUAL_ARTIFACT_INVALID' });
}

function validateArtifactBytes(bytes, contract, label, { text = null } = {}) {
  const minimum = contract.minimumBytes ?? 1;
  const maximum = contract.maximumBytes ?? Number.MAX_SAFE_INTEGER;
  if (bytes.length < minimum) throw new SingularityFlowError(`${label} is too short (${bytes.length} bytes; minimum ${minimum}).`, { code: 'MANUAL_ARTIFACT_INVALID' });
  if (bytes.length > maximum) throw new SingularityFlowError(`${label} is too large (${bytes.length} bytes; maximum ${maximum}).`, { code: 'MANUAL_ARTIFACT_INVALID' });
  const needsTextValidation = Boolean(contract.validation?.requiredHeadings?.length || contract.validation?.forbiddenPlaceholders?.length);
  if (needsTextValidation && text == null) {
    throw new SingularityFlowError(`${label} is binary but its artifact contract requires text validation.`, { code: 'MANUAL_ARTIFACT_INVALID' });
  }
  if (text == null) return;
  validateHeadings(text, contract.validation?.requiredHeadings, label);
  const forbidden = contract.validation?.forbiddenPlaceholders ?? [];
  const found = forbidden.find((value) => text.toLowerCase().includes(String(value).toLowerCase()));
  if (found) throw new SingularityFlowError(`${label} contains forbidden placeholder '${found}'.`, { code: 'MANUAL_ARTIFACT_INVALID' });
}

export async function importManualArtifact({ sourcePath, targetPath, contract }) {
  const info = await lstat(sourcePath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError('Manual artifact source must be an existing regular file and must not be a symbolic link.', { code: 'MANUAL_ARTIFACT_INVALID' });
  }
  const original = await readFile(sourcePath);
  const mediaType = validateArtifactType(sourcePath, contract, path.basename(sourcePath));
  let authored = original;
  if (/\.(?:md|markdown|txt)$/i.test(sourcePath)) {
    const sanitized = original.toString('utf8').replace(MANAGED_METADATA, '');
    if (sanitized.includes(MANAGED_METADATA_MARKER)) {
      throw new SingularityFlowError('Manual artifact contains forged or misplaced Singularity Flow metadata.', { code: 'MANUAL_ARTIFACT_INVALID' });
    }
    authored = Buffer.from(sanitized, 'utf8');
  }
  const text = /^(?:text\/|application\/(?:json|yaml)$)/.test(mediaType) ? authored.toString('utf8') : null;
  validateArtifactBytes(authored, contract, path.basename(sourcePath), { text });
  const after = await readFile(sourcePath);
  if (sha256(after) !== sha256(original)) {
    throw new SingularityFlowError('Manual artifact source changed while it was being imported. Retry with a stable file.', { code: 'MANUAL_ARTIFACT_INVALID' });
  }
  await writeBytes(targetPath, authored);
  return Object.freeze({ kind: 'import', filename: path.basename(sourcePath), mediaType, sha256: sha256(authored), bytes: authored.length });
}

export async function inspectInPlaceArtifact(targetPath, contract) {
  const info = await lstat(targetPath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new SingularityFlowError('Prepared artifact must be a regular file and must not be a symbolic link.', { code: 'MANUAL_ARTIFACT_INVALID' });
  const bytes = await readFile(targetPath);
  const mediaType = validateArtifactType(targetPath, contract, path.basename(targetPath));
  let authored = bytes;
  if (/^(?:text\/|application\/(?:json|yaml)$)/.test(mediaType)) {
    const sanitized = bytes.toString('utf8').replace(MANAGED_METADATA, '');
    // Prepared phases may legitimately embed approved upstream artifacts (including their
    // metadata) inside the engine-owned inputs block. A marker anywhere else is authored input
    // masquerading as lifecycle metadata and must be rejected.
    if (sanitized.replace(MANAGED_INPUTS, '').includes(MANAGED_METADATA_MARKER)) {
      throw new SingularityFlowError('Prepared artifact contains forged or misplaced Singularity Flow metadata.', { code: 'MANUAL_ARTIFACT_INVALID' });
    }
    authored = Buffer.from(sanitized, 'utf8');
  }
  validateArtifactBytes(authored, contract, path.basename(targetPath), {
    text: authored === bytes ? null : authored.toString('utf8')
  });
  return Object.freeze({ kind: 'in-place', filename: path.basename(targetPath), mediaType, sha256: sha256(authored), bytes: authored.length });
}

export function buildGenerationAuthorship({ options, actor, governedAgentContext, source, kernelInvocationIds = [] }) {
  const kernelInvoked = kernelInvocationIds.length > 0;
  return Object.freeze({
    schemaVersion: 1,
    producer: options.producer,
    channel: options.channel,
    actor: structuredClone(actor),
    governedAgentContext: governedAgentContext == null
      ? null
      : typeof governedAgentContext === 'string'
        ? { agentId: governedAgentContext }
        : structuredClone(governedAgentContext),
    kernelModel: { invoked: kernelInvoked, status: 'exact', invocationIds: [...kernelInvocationIds] },
    externalAiUse: options.externalAiUse == null
      ? { value: 'unknown', status: 'unavailable' }
      : { value: options.externalAiUse, status: 'self-reported' },
    source: structuredClone(source)
  });
}
