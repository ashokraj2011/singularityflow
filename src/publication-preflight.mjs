import { artifactBytesAreText, authoredArtifactText, inspectManagedArtifactMetadata, authoredArtifactFingerprint, requiredArtifactRepoPath, readReviewArtifact, readReviewArtifactBytes, reviewableMarkdownPath } from './artifact-review-read.mjs';
export { reviewArtifactIdentityDecision, reviewArtifactBytesStable, authoredArtifactText, authoredArtifactFingerprint, requiredArtifactRepoPath, phaseAuthoredReviewArtifacts } from './artifact-review-read.mjs';
import path from 'node:path';
import { memberRoot, resolvedArtifactSet } from './artifact-sets.mjs';
export { inspectManagedArtifactMetadata };

import { sha256 } from './artifact-review-read.mjs';
import { artifactContentObservation, inspectArtifactContentObservation, requiredArtifactContentContract,
  requiredArtifactContentFindings, artifactMetadataInvalid, inspectBinaryArtifactSize, parseMarkdownStructure,
  artifactPlaceholderFindings, sortArtifactFindings } from './kernel/artifact-content.mjs';
export { repairPreparedArtifactMetadata, artifactPlaceholderFindings } from './kernel/artifact-content.mjs';

export function artifactContentContractLines(contract = null) {
  if (!contract) return [];
  const minimum = contract.minimumBytes ?? 1;
  const maximum = contract.maximumBytes;
  const headings = contract.validation?.requiredHeadings ?? [];
  const forbidden = contract.validation?.forbiddenPlaceholders ?? [];
  return [
    `- Authored content: at least ${minimum} UTF-8 bytes${maximum == null ? '' : ` and at most ${maximum} UTF-8 bytes`}; managed metadata and approved-input blocks do not count.`,
    `- Required Markdown headings: ${headings.length ? headings.map((heading) => `\`${heading}\``).join(', ') : 'none beyond the configured template'}.`,
    `- Completion rule: replace every TODO, TBD, unresolved template marker, and configured forbidden placeholder${forbidden.length ? ` (${forbidden.map((value) => `\`${value}\``).join(', ')})` : ''}; an unchanged prepared template is refused.`,
    '- Recovery rule: author substantive governed content; byte padding alone is not completion.'
  ];
}

export function inspectArtifactContent(text, {
  path: pathName = 'artifact', contract = {}, baseline = null
} = {}) {
  const observation = artifactContentObservation(text);
  const fingerprint = sha256(observation.fingerprintText);
  return inspectArtifactContentObservation(observation, { path: pathName, contract, baseline, fingerprint });
}

/** Validate candidate bytes without replacing the currently approved artifact. */
export function inspectRequiredArtifactText(text, phase, {
  path: required = 'artifact', generation = null, placeholders = true, minimumBytes = true
} = {}) {
  const contract = requiredArtifactContentContract(phase, { generation, placeholders, minimumBytes });
  const inspected = inspectArtifactContent(text, { path: required, contract, baseline: phase.authoringBaseline ?? null });
  const metadata = phase.authoringBaseline == null ? null : inspectManagedArtifactMetadata(text);
  return requiredArtifactContentFindings(inspected, { path: required, metadata, placeholders,
    rawBytes: artifactMetadataInvalid(metadata) ? Buffer.byteLength(text) : null });
}

/** Complete artifact authoring preflight used by publish, recover, and host guidance. */
export async function inspectRequiredArtifactContent(root, config, workflow, phase, options = {}) {
  const required = requiredArtifactRepoPath(config, workflow, phase);
  const bytes = await readReviewArtifactBytes(root, required, 'Required phase artifact');
  if (bytes == null) return [{
    code: 'artifact.required.missing', category: 'authoring', path: required, line: null,
    value: null, bytes: null, minimumBytes: phase.requiredArtifact.minimumBytes ?? 1
  }];
  if (!artifactBytesAreText(bytes)) return binaryArtifactFindings(bytes, phase, { ...options, path: required });
  return inspectRequiredArtifactText(bytes.toString('utf8'), phase, { ...options, path: required });
}

/**
 * A binary artifact (PDF, DOCX, PNG) is judged as manual import judges one: its exact byte bounds,
 * and a contract that needs text (headings, placeholders) cannot be met. Decoding it as UTF-8 counted
 * a 73-byte PDF as 5 authored bytes and refused it (2026-10-29).
 */
function binaryArtifactFindings(bytes, phase, { path: required, minimumBytes = true } = {}) {
  const contract = phase.requiredArtifact ?? {};
  const minimum = minimumBytes ? (contract.minimumBytes ?? 1) : 0;
  const maximum = contract.maximumBytes ?? Number.MAX_SAFE_INTEGER;
  const base = { category: 'authoring', path: required, line: null, value: null, bytes: bytes.length };
  const findings = [];
  if (bytes.length < minimum) findings.push({ ...base, code: 'artifact.required.too-short', minimumBytes: minimum });
  if (bytes.length > maximum) findings.push({ ...base, code: 'artifact.required.too-large', maximumBytes: maximum });
  if (contract.validation?.requiredHeadings?.length || contract.validation?.forbiddenPlaceholders?.length) {
    findings.push({ ...base, code: 'artifact.binary.text-contract', minimumBytes: null });
  }
  return findings;
}

/**
 * Inspect every human-reviewable document owned by a Story phase.
 *
 * The primary keeps its full authored-content contract. Present, non-directory Markdown members
 * in a typed artifact set receive the same placeholder scan. Directories and arbitrary registered
 * artifacts are deliberately excluded: those can contain source, test fixtures, or machine
 * evidence where strings such as `TODO` are data rather than an unfinished review document.
 */
async function inspectRawPhaseAuthoredReviewContent(root, config, workflow, phase, {
  placeholders = true, minimumBytes = true
} = {}) {
  const findings = await inspectRequiredArtifactContent(root, config, workflow, phase, {
    placeholders, minimumBytes
  });
  if (!placeholders) return findings;

  const set = resolvedArtifactSet(config, workflow, phase);
  if (!set) return findings;
  const required = requiredArtifactRepoPath(config, workflow, phase);
  const phaseArtifactRoot = path.posix.join(
    config.workItemRoot ?? 'singularity/work-items',
    workflow.workItem.id,
    memberRoot(phase)
  );
  for (const member of set.members) {
    // Advisory members are context only: their absence, content, or unfinished prose cannot become
    // a lifecycle gate. Only governed review members contribute hard authoring findings.
    if (member.authority !== 'governed') continue;
    const relative = path.posix.join(phaseArtifactRoot, member.path);
    if (relative === required || member.path.endsWith('/') || !reviewableMarkdownPath(relative)) continue;
    const text = await readReviewArtifact(root, relative, 'Supporting review artifact');
    if (text == null) continue;
    const bytes = Buffer.byteLength(authoredArtifactText(text));
    const fingerprint = authoredArtifactFingerprint(text);
    const structure = parseMarkdownStructure(authoredArtifactText(text, { preserveLines: true }));
    for (const comment of structure.unclosedComments) findings.push({
      code: 'artifact.comment.unclosed', category: 'authoring', path: relative,
      line: comment.line, value: '<!--', bytes, minimumBytes: null, fingerprint,
      artifactScope: 'supporting'
    });
    for (const placeholder of artifactPlaceholderFindings(text, { structure })) findings.push({
      code: 'artifact.placeholder.unresolved', category: 'authoring', path: relative,
      line: placeholder.line, value: placeholder.value, bytes, minimumBytes: null, fingerprint,
      artifactScope: 'supporting'
    });
  }
  sortArtifactFindings(findings, { byPath: true });
  return findings;
}

/** Every lifecycle boundary consumes the same exceptions, never a host-supplied ready result. */
export async function inspectPhaseArtifactQuality(root, config, workflow, phase, options = {}) {
  const findings = await inspectRawPhaseAuthoredReviewContent(root, config, workflow, phase, options);
  if (options.resolveRisks === false || !(workflow.qualityRiskDecisions ?? []).some(record =>
    record?.gate === 'PHASE_ARTIFACT_QUALITY' && record.binding?.phaseId === phase.id)) {
    return { findings, acceptedFindings: [], risks: null };
  }
  const { resolveArtifactQualityFindings } = await import('./phase-artifact-risk.mjs');
  const transition = options.transition ?? (phase.status === 'awaiting_approval' ? 'approve'
    : Number(phase.generation) > 0 && phase.generationIntent?.status !== 'open' ? 'submit' : 'publish');
  return resolveArtifactQualityFindings(root, config, workflow, phase, findings,
    { transition, generation: options.generation ?? null });
}

export async function inspectPhaseAuthoredReviewContent(root, config, workflow, phase, options = {}) {
  return (await inspectPhaseArtifactQuality(root, config, workflow, phase, options)).findings;
}

export function artifactFindingMessage(finding) {
  const label = finding.artifactScope === 'supporting' ? 'Supporting review artifact' : 'Required artifact';
  if (finding.code === 'artifact.required.missing') return `Required artifact missing: ${finding.path}`;
  if (finding.code === 'artifact.metadata.invalid') {
    return `Required artifact ${finding.path} has ${finding.value} Singularity Flow metadata at line ${finding.line}; rerun prepare once to restore the engine-owned envelope without changing authored content.`;
  }
  if (finding.code === 'artifact.binary.text-contract') {
    return `Required artifact ${finding.path} is binary, but its step's contract asks for text (required headings or placeholder checks); publish a text artifact or remove that validation from the step.`;
  }
  if (finding.code === 'artifact.required.too-short') {
    return `Required artifact ${finding.path} has ${finding.bytes} authored bytes; minimum ${finding.minimumBytes}.`;
  }
  if (finding.code === 'artifact.required.too-large') {
    return `Required artifact ${finding.path} has ${finding.bytes} authored bytes; maximum ${finding.maximumBytes}.`;
  }
  if (finding.code === 'artifact.placeholder.unresolved') {
    return `${label} ${finding.path} contains unresolved placeholder '${finding.value}' at line ${finding.line}: TODO (in capitals), TBD, TBC, FIXME, {{...}} and [describe ...] read as unfinished work, even inside code spans; finish that text or reword it.`;
  }
  if (finding.code === 'artifact.comment.unclosed') {
    return `${label} ${finding.path} contains an unclosed HTML comment opened at line ${finding.line}.`;
  }
  if (finding.code === 'artifact.template.unchanged') {
    return `Required artifact ${finding.path} still matches its prepared template.`;
  }
  if (finding.code === 'artifact.heading.missing') {
    return `Required artifact ${finding.path} is missing required Markdown heading '${finding.value}'.${finding.near
      ? ` Line ${finding.line} has '${finding.near}': write it as a heading with exactly that text, without numbering, bold or a colon.` : ''}`;
  }
  if (finding.code === 'artifact.heading.empty') {
    return `Required artifact ${finding.path} has no authored content under required heading '${finding.value}' at line ${finding.line}.`;
  }
  return `Required artifact ${finding.path} is not publishable.`;
}

export async function validateRequiredArtifactContent(root, config, workflow, phase, options = {}) {
  return (await inspectRequiredArtifactContent(root, config, workflow, phase, options))
    .map(artifactFindingMessage);
}

export async function validatePhaseAuthoredReviewContent(root, config, workflow, phase, options = {}) {
  return (await inspectPhaseAuthoredReviewContent(root, config, workflow, phase, options))
    .map(artifactFindingMessage);
}
