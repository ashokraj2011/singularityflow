import { MANAGED_INPUTS, MANAGED_METADATA, MANAGED_METADATA_MARKER, authoredArtifactText, authoredArtifactFingerprint, requiredArtifactRepoPath, readReviewArtifact, reviewableMarkdownPath } from './artifact-review-read.mjs';
export { reviewArtifactIdentityDecision, reviewArtifactBytesStable, authoredArtifactText, authoredArtifactFingerprint, requiredArtifactRepoPath, phaseAuthoredReviewArtifacts } from './artifact-review-read.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import path from 'node:path';
import { memberRoot, resolvedArtifactSet } from './artifact-sets.mjs';
import { normalizeMarkdownHeading, parseMarkdownStructure } from './markdown-structure.mjs';
import { qualifiedClauseMatches } from './traceability-ids.mjs';

const PLACEHOLDER = /\b(?:TODO|TBD|FIXME|TBC)\b|\{\{[^}]+\}\}|\[\s*(?:describe|add|insert|provide|record)[^\]]*\]/gi;
// These words are useful in ordinary prose when lower-cased. Treat only the conventional uppercase
// authoring markers as unfinished work so a sentence such as "no placeholder remains" is not itself
// rejected by the placeholder guard.
const EXPLICIT_UPPERCASE_PLACEHOLDER = /\b(?:XXX|PLACEHOLDER)\b/g;
const SINGLE_WORD_ANGLE_PLACEHOLDERS = new Set([
  'benefit', 'capability', 'decision', 'module', 'owner', 'path', 'requirement', 'role'
]);

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Inspect the engine-owned metadata envelope without trusting its JSON payload.
 *
 * Publication replaces this envelope from durable workflow state. Authoring tools therefore only
 * need to prove that there is exactly one complete envelope at byte zero and that another marker
 * was not copied into author-owned prose. Approved input blocks may quote an upstream artifact and
 * are excluded for the same reason they are excluded by the publication boundary.
 */
export function inspectManagedArtifactMetadata(text) {
  const source = String(text ?? '');
  const leading = source.match(MANAGED_METADATA)?.[0] ?? null;
  const authoredRegion = (leading == null ? source : source.slice(leading.length))
    // Keep offsets stable so the reported line still refers to the original artifact.
    .replace(MANAGED_INPUTS, (block) => block.replace(/[^\n]/gu, ' '));
  const markerIndex = authoredRegion.search(MANAGED_METADATA_MARKER);
  if (leading != null && markerIndex < 0) {
    return Object.freeze({ status: 'valid', line: null, leading });
  }
  if (leading == null && markerIndex < 0) {
    return Object.freeze({ status: 'missing', line: 1, leading: null });
  }
  const absoluteIndex = leading == null
    ? markerIndex
    : leading.length + markerIndex;
  return Object.freeze({
    status: leading == null && absoluteIndex === 0 ? 'malformed' : 'duplicate-or-misplaced',
    line: lineAt(source, Math.max(0, absoluteIndex)),
    leading
  });
}

function normalizedHeading(line) {
  return String(line ?? '').trim()
    .replace(/[\u2010-\u2015-]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');
}

function dedentMarkdown(text) {
  const lines = String(text).replaceAll('\r\n', '\n').split('\n');
  const indents = lines.filter((line) => line.trim()).map((line) => /^ */u.exec(line)?.[0].length ?? 0);
  const indent = indents.length ? Math.min(...indents) : 0;
  return indent > 0 ? lines.map((line) => line.slice(Math.min(indent, line.length))).join('\n') : lines.join('\n');
}

/**
 * Repair only the bounded corruption produced when an editor starts authoring inside the managed
 * JSON prefix and a later prepare prepends a fresh canonical envelope.
 *
 * The candidate must begin where author-owned content normally begins, share a substantial exact
 * prefix with the canonical envelope, and resume at the same first Markdown heading as the Git
 * baseline. Anything less certain remains a refusal; this helper never guesses where prose starts.
 */
export function repairPreparedArtifactMetadata(text, { canonicalMetadata, baselineText = null } = {}) {
  const source = String(text ?? '');
  const canonical = String(canonicalMetadata ?? '').trimEnd();
  const placement = inspectManagedArtifactMetadata(source);
  if (placement.status === 'valid') return Object.freeze({ status: 'unchanged', text: source });
  if (placement.status === 'missing') {
    return Object.freeze({ status: 'inserted', text: `${canonical}\n\n${source}` });
  }

  const initial = source.match(MANAGED_METADATA)?.[0] ?? '';
  const authoredRegion = source.slice(initial.length);
  const candidate = authoredRegion.trimStart();
  if (candidate.search(MANAGED_METADATA_MARKER) !== 0) return null;

  const candidateLines = candidate.replaceAll('\r\n', '\n').split('\n');
  const canonicalLines = canonical.replaceAll('\r\n', '\n').split('\n');
  let shared = 0;
  while (shared < candidateLines.length && shared < canonicalLines.length
      && candidateLines[shared] === canonicalLines[shared]) shared += 1;
  if (shared < 4) return null;

  const recoveredBody = dedentMarkdown(candidateLines.slice(shared).join('\n')).trimStart();
  const recoveredHeading = recoveredBody.split('\n').find((line) => /^#{1,6}\s+\S/u.test(line.trim())) ?? '';
  const baselineBody = baselineText == null ? '' : authoredArtifactText(baselineText).trimStart();
  const baselineHeading = baselineBody.split(/\r?\n/u)
    .find((line) => /^#{1,6}\s+\S/u.test(line.trim())) ?? '';
  if (!recoveredHeading
      || (!baselineHeading && !initial)
      || (baselineHeading && normalizedHeading(recoveredHeading) !== normalizedHeading(baselineHeading))) return null;

  return Object.freeze({
    status: initial ? 'removed-duplicate-truncated-envelope' : 'replaced-truncated-envelope',
    text: `${canonical}\n\n${recoveredBody}`
  });
}

/** Human/model-facing rendering of the same authored-content boundary the kernel enforces. */
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

function anglePlaceholderFindings(text) {
  const findings = [];
  for (const candidate of text.matchAll(/<([^<>\r\n]+)>/g)) {
    const body = candidate[1].trim();
    if (!body || /^(?:https?:|mailto:|\/|!|\?)/i.test(body) || body.includes('=')) continue;
    // Uppercase command metavariables are executable documentation, not unfinished prose. They
    // intentionally occur in phase artifacts such as `--url <AUTHORIZED-URL>` and `<DIRECTORY>`.
    if (/^[A-Z][A-Z0-9 _-]+$/.test(body)) continue;
    const singleWord = body.toLocaleLowerCase('en-US');
    const placeholder = /\s/.test(body)
      || /(?:…|\.\.\.)/.test(body)
      || SINGLE_WORD_ANGLE_PLACEHOLDERS.has(singleWord);
    if (placeholder) findings.push({ value: candidate[0], index: candidate.index });
  }
  return findings;
}

/**
 * Locate every unfinished marker in the current producer's authored bytes.
 *
 * Managed approved inputs and kernel metadata preserve their line count but cannot make the
 * consumer fail publication: those bytes were governed by their producer and are evidence here.
 */
export function artifactPlaceholderFindings(text, { structure = null } = {}) {
  const authored = authoredArtifactText(text, { preserveLines: true });
  const visible = (structure ?? parseMarkdownStructure(authored)).visibleText;
  // Clause namespaces are user-chosen: ADD-FACTORIAL and even TODO are legal. Mask only
  // complete, valid identities (bracketed, inline code, or prose), not their surrounding
  // instructions or unfinished markers.
  // Keep offsets/newlines intact so every remaining finding still points at the source line.
  let placeholderText = visible;
  for (const match of qualifiedClauseMatches(visible)) {
    const bracketed = visible[match.index - 1] === '[' && visible[match.index + match[0].length] === ']';
    const start = match.index - (bracketed ? 1 : 0);
    const length = match[0].length + (bracketed ? 2 : 0);
    placeholderText = placeholderText.slice(0, start) + ' '.repeat(length)
      + placeholderText.slice(start + length);
  }
  const regular = [...placeholderText.matchAll(PLACEHOLDER)].map((match) => ({
    value: visible.slice(match.index, match.index + match[0].length), index: match.index
  }));
  const explicitUppercase = [...placeholderText.matchAll(EXPLICIT_UPPERCASE_PLACEHOLDER)]
    .map((match) => ({ value: match[0], index: match.index }))
    .filter((finding) => !regular.some((candidate) => finding.index >= candidate.index
      && finding.index + finding.value.length <= candidate.index + candidate.value.length));
  const seen = new Set();
  return [...regular, ...explicitUppercase, ...anglePlaceholderFindings(visible)]
    .sort((left, right) => left.index - right.index)
    .filter((finding) => {
      const key = `${finding.index}:${finding.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((finding) => ({ value: finding.value, line: lineAt(visible, finding.index) }));
}

function requiredHeadingFindings(structure, required, pathName) {
  if (!required?.length) return [];
  const { headings, visibleText } = structure;
  const findings = [];
  for (const requested of required) {
    const normalized = normalizeMarkdownHeading(requested);
    const index = headings.findIndex((heading) => heading.normalized === normalized);
    if (index < 0) {
      findings.push({
        code: 'artifact.heading.missing', category: 'authoring', path: pathName, line: null,
        value: String(requested), bytes: null, minimumBytes: null
      });
      continue;
    }
    const heading = headings[index];
    const body = visibleText.slice(heading.contentStart, heading.end).trim();
    if (!body) findings.push({
      code: 'artifact.heading.empty', category: 'authoring', path: pathName, line: heading.line,
      value: String(requested), bytes: null, minimumBytes: null
    });
  }
  return findings;
}

const FINDING_PRIORITY = Object.freeze({
  'artifact.metadata.invalid': 0,
  'artifact.comment.unclosed': 5,
  'artifact.placeholder.unresolved': 10,
  'artifact.template.unchanged': 20,
  'artifact.heading.missing': 30,
  'artifact.heading.empty': 30,
  'artifact.required.too-short': 40,
  'artifact.required.too-large': 40
});

/** Pure content inspection shared by in-place, imported, recovery and publication paths. */
export function inspectArtifactContent(text, {
  path: pathName = 'artifact', contract = {}, baseline = null
} = {}) {
  const authored = authoredArtifactText(text);
  const inspectionText = authoredArtifactText(text, { preserveLines: true });
  const structure = parseMarkdownStructure(inspectionText);
  const bytes = Buffer.byteLength(authored);
  const fingerprint = authoredArtifactFingerprint(authored);
  const findings = [];

  for (const comment of structure.unclosedComments) findings.push({
    code: 'artifact.comment.unclosed', category: 'authoring', path: pathName,
    line: comment.line, value: '<!--', bytes, minimumBytes: null, fingerprint
  });
  for (const placeholder of artifactPlaceholderFindings(text, { structure })) findings.push({
    code: 'artifact.placeholder.unresolved', category: 'authoring', path: pathName,
    line: placeholder.line, value: placeholder.value, bytes, minimumBytes: null, fingerprint
  });
  for (const forbidden of contract.validation?.forbiddenPlaceholders ?? []) {
    const escaped = String(forbidden).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(escaped, 'i').exec(structure.visibleText);
    if (match && !findings.some((finding) => finding.value.toLocaleLowerCase('en-US') === String(forbidden).toLocaleLowerCase('en-US'))) {
      findings.push({
        code: 'artifact.placeholder.unresolved', category: 'authoring', path: pathName,
        line: lineAt(structure.visibleText, match.index), value: String(forbidden), bytes,
        minimumBytes: null, fingerprint
      });
    }
  }
  if (baseline?.generation != null && baseline.generation === contract.generation
      && baseline.fingerprint === fingerprint) findings.push({
    code: 'artifact.template.unchanged', category: 'authoring', path: pathName, line: null,
    value: null, bytes, minimumBytes: null, fingerprint
  });
  findings.push(...requiredHeadingFindings(structure, contract.validation?.requiredHeadings, pathName)
    .map((finding) => ({ ...finding, bytes, fingerprint })));
  const minimum = contract.minimumBytes ?? 1;
  const maximum = contract.maximumBytes ?? Number.MAX_SAFE_INTEGER;
  if (bytes < minimum) findings.push({
    code: 'artifact.required.too-short', category: 'authoring', path: pathName, line: null,
    value: null, bytes, minimumBytes: minimum, fingerprint
  });
  if (bytes > maximum) findings.push({
    code: 'artifact.required.too-large', category: 'authoring', path: pathName, line: null,
    value: null, bytes, maximumBytes: maximum, minimumBytes: null, fingerprint
  });
  findings.sort((left, right) => (FINDING_PRIORITY[left.code] ?? 100) - (FINDING_PRIORITY[right.code] ?? 100)
    || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER));
  return { authored, bytes, fingerprint, findings };
}

/** Validate candidate bytes without replacing the currently approved artifact. */
export function inspectRequiredArtifactText(text, phase, {
  path: required = 'artifact', generation = null, placeholders = true, minimumBytes = true
} = {}) {
  const contract = {
    ...phase.requiredArtifact,
    // During authoring the contract describes the next generation; after publication it describes
    // the current submitted generation. This lets submit/approval retain the unchanged-template
    // invariant instead of accidentally comparing generation N's bytes with an N+1 contract.
    generation: generation ?? (phase.status === 'in_progress'
      ? nextPhaseGeneration(phase)
      : Number(phase.generation)),
    ...(minimumBytes ? {} : { minimumBytes: 0 }),
    ...(!placeholders ? {
      validation: { ...phase.requiredArtifact.validation, forbiddenPlaceholders: [] }
    } : {})
  };
  const inspected = inspectArtifactContent(text, {
    path: required,
    contract,
    baseline: phase.authoringBaseline ?? null
  });
  const metadata = phase.authoringBaseline == null ? null : inspectManagedArtifactMetadata(text);
  // A model may replace the complete prepared file with author-owned prose; publication restores
  // the canonical envelope. Only a remaining marker is an integrity problem. Missing metadata is
  // therefore compatible, while truncated, duplicated, or displaced metadata is never accepted.
  const metadataFindings = metadata && !['valid', 'missing'].includes(metadata.status) ? [{
    code: 'artifact.metadata.invalid', category: 'integrity', path: required,
    line: metadata.line, value: metadata.status, bytes: Buffer.byteLength(text),
    minimumBytes: null, fingerprint: inspected.fingerprint
  }] : [];
  const findings = [...metadataFindings, ...inspected.findings];
  return placeholders
    ? findings
    : findings.filter((finding) => finding.code !== 'artifact.placeholder.unresolved');
}

/** Complete artifact authoring preflight used by publish, recover, and host guidance. */
export async function inspectRequiredArtifactContent(root, config, workflow, phase, options = {}) {
  const required = requiredArtifactRepoPath(config, workflow, phase);
  const text = await readReviewArtifact(root, required, 'Required phase artifact');
  if (text == null) return [{
    code: 'artifact.required.missing', category: 'authoring', path: required, line: null,
    value: null, bytes: null, minimumBytes: phase.requiredArtifact.minimumBytes ?? 1
  }];
  return inspectRequiredArtifactText(text, phase, { ...options, path: required });
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
  findings.sort((left, right) => (FINDING_PRIORITY[left.code] ?? 100) - (FINDING_PRIORITY[right.code] ?? 100)
    || left.path.localeCompare(right.path)
    || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER));
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
  if (finding.code === 'artifact.required.too-short') {
    return `Required artifact ${finding.path} has ${finding.bytes} authored bytes; minimum ${finding.minimumBytes}.`;
  }
  if (finding.code === 'artifact.required.too-large') {
    return `Required artifact ${finding.path} has ${finding.bytes} authored bytes; maximum ${finding.maximumBytes}.`;
  }
  if (finding.code === 'artifact.placeholder.unresolved') {
    return `${label} ${finding.path} contains unresolved placeholder '${finding.value}' at line ${finding.line}.`;
  }
  if (finding.code === 'artifact.comment.unclosed') {
    return `${label} ${finding.path} contains an unclosed HTML comment opened at line ${finding.line}.`;
  }
  if (finding.code === 'artifact.template.unchanged') {
    return `Required artifact ${finding.path} still matches its prepared template.`;
  }
  if (finding.code === 'artifact.heading.missing') {
    return `Required artifact ${finding.path} is missing required Markdown heading '${finding.value}'.`;
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
