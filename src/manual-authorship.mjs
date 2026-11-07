export { buildGenerationAuthorship } from './kernel/phase-policy.mjs';
export { phasePublicationContract, phasePublicationCommand, phasePublicationCommandForProducer } from './phase-publication-guidance.mjs';
export { AUTHORSHIP_PRODUCERS, AUTHORSHIP_CHANNELS, CHANGE_ORIGINS, phasePublicationAuthorship, phaseUsesDeterministicGeneration, effectivePhasePublicationProducer, agentPublicationProducer, normalizeAuthorshipOptions, assertProducerAllowed } from './kernel/phase-policy.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { SingularityFlowError, writeBytes } from './util.mjs';
import { artifactFindingMessage, authoredArtifactText, inspectArtifactContent, requiredArtifactRepoPath } from './publication-preflight.mjs';

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

async function validateArtifactBytes(bytes, contract, label, {
  text = null, baseline = null, retrySkill = '/sf-phase', qualityContext = null
} = {}) {
  const needsTextValidation = Boolean(contract.validation?.requiredHeadings?.length || contract.validation?.forbiddenPlaceholders?.length);
  if (needsTextValidation && text == null) {
    throw new SingularityFlowError(`${label} is binary but its artifact contract requires text validation.`, { code: 'MANUAL_ARTIFACT_INVALID' });
  }
  if (text == null) {
    const minimum = contract.minimumBytes ?? 1;
    const maximum = contract.maximumBytes ?? Number.MAX_SAFE_INTEGER;
    if (bytes.length < minimum || bytes.length > maximum) {
      const comparison = bytes.length < minimum ? `minimum ${minimum}` : `maximum ${maximum}`;
      throw new SingularityFlowError(`${label} has ${bytes.length} bytes; ${comparison}.`, {
        code: 'MANUAL_ARTIFACT_INVALID'
      });
    }
    return;
  }
  const inspected = inspectArtifactContent(text, { path: label, contract, baseline });
  if (qualityContext && inspected.findings.length) {
    const { resolveArtifactQualityFindings } = await import('./phase-artifact-risk.mjs');
    const { root, config, workflow, phase } = qualityContext;
    inspected.findings = (await resolveArtifactQualityFindings(root, config, workflow, phase,
      inspected.findings, { transition: 'publish', generation: qualityContext.generation ?? null })).findings;
  }
  if (inspected.findings.length) throw new SingularityFlowError(
    `${label} is not publishable:\n- ${inspected.findings.map(artifactFindingMessage).join('\n- ')}\n`
    + 'Complete every listed authoring issue before publishing; adding padding alone is not a recovery.',
    {
      code: 'ARTIFACT_AUTHORING_INCOMPLETE',
      details: {
        findings: inspected.findings,
        fingerprint: inspected.fingerprint,
        retry: { skill: retrySkill, maximumAttempts: 1, requiresFingerprintChange: true }
      }
    }
  );
}

export async function importManualArtifact({
  sourcePath, targetPath, contract, baseline = null, retrySkill = '/sf-phase'
}) {
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
    authored = Buffer.from(authoredArtifactText(sanitized), 'utf8');
  }
  const text = /^(?:text\/|application\/(?:json|yaml)$)/.test(mediaType) ? original.toString('utf8') : null;
  await validateArtifactBytes(authored, contract, path.basename(sourcePath), { text, baseline, retrySkill });
  const after = await readFile(sourcePath);
  if (sha256(after) !== sha256(original)) {
    throw new SingularityFlowError('Manual artifact source changed while it was being imported. Retry with a stable file.', { code: 'MANUAL_ARTIFACT_INVALID' });
  }
  await writeBytes(targetPath, authored);
  return Object.freeze({ kind: 'import', filename: path.basename(sourcePath), mediaType, sha256: sha256(authored), bytes: authored.length });
}

async function inspectPreparedArtifact(targetPath, contract, {
  baseline = null, deterministic = false, retrySkill = '/sf-phase', qualityContext = null
} = {}) {
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
    authored = Buffer.from(authoredArtifactText(sanitized), 'utf8');
  }
  if (deterministic) {
    // Exact kernel projections can quote TODO/template text and intentionally own their heading
    // layout. Their content is authorized by the projection verifier, while this boundary still
    // enforces safe file type, metadata placement, and configured byte limits.
    await validateArtifactBytes(authored, { ...contract, validation: {} }, path.basename(targetPath));
  } else {
    // Only the pinned in-place document can consume a live, content-bound decision. Imports
    // are validated independently and cannot inherit exceptions for the old target's bytes.
    const relative = qualityContext && requiredArtifactRepoPath(qualityContext.config,
      qualityContext.workflow, qualityContext.phase);
    if (qualityContext && (!relative || path.resolve(qualityContext.root, relative) !== path.resolve(targetPath))) {
      throw new SingularityFlowError('Quality review target does not match the pinned phase artifact.', { code: 'MANUAL_ARTIFACT_INVALID' });
    }
    await validateArtifactBytes(authored, contract, relative ?? path.basename(targetPath), {
      text: /^(?:text\/|application\/(?:json|yaml)$)/.test(mediaType) ? bytes.toString('utf8') : null,
      baseline,
      retrySkill,
      qualityContext
    });
  }
  const after = await lstat(targetPath);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino
      || sha256(await readFile(targetPath)) !== sha256(bytes)) {
    throw new SingularityFlowError('Prepared artifact changed during inspection. Preserve it and review stable bytes.', { code: 'MANUAL_ARTIFACT_INVALID' });
  }
  return Object.freeze({ kind: 'in-place', filename: path.basename(targetPath), mediaType, sha256: sha256(authored), bytes: authored.length });
}

export async function inspectInPlaceArtifact(targetPath, contract, options = {}) {
  return inspectPreparedArtifact(targetPath, contract, options);
}

export async function inspectDeterministicInPlaceArtifact(targetPath, contract) {
  return inspectPreparedArtifact(targetPath, contract, { deterministic: true });
}
