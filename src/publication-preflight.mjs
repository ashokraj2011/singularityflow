import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { memberRoot, resolvedArtifactSet } from './artifact-sets.mjs';

const PLACEHOLDER = /\b(?:TODO|TBD|FIXME|TBC)\b|\{\{[^}]+\}\}|\[\s*(?:describe|add|insert|provide|record)[^\]]*\]/gi;
// These words are useful in ordinary prose when lower-cased. Treat only the conventional uppercase
// authoring markers as unfinished work so a sentence such as "no placeholder remains" is not itself
// rejected by the placeholder guard.
const EXPLICIT_UPPERCASE_PLACEHOLDER = /\b(?:XXX|PLACEHOLDER)\b/g;
const MANAGED_INPUTS = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/g;
const MANAGED_METADATA = /^<!-- singularity-flow:(?:initiative-)?metadata\n[\s\S]*?\n-->\s*/;
const SINGLE_WORD_ANGLE_PLACEHOLDERS = new Set([
  'benefit', 'capability', 'decision', 'module', 'owner', 'path', 'requirement', 'role'
]);

function maskBlock(block) {
  return '\n'.repeat((block.match(/\n/g) ?? []).length);
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * Return only bytes owned by the current artifact author.
 *
 * Lifecycle metadata and approved upstream inputs can be large, but neither proves that the
 * current producer completed the artifact. Publication, recovery, manual import and host guidance
 * all use this boundary so an artifact cannot look complete on one surface and fail on another.
 */
export function authoredArtifactText(text, { preserveLines = false } = {}) {
  const source = String(text ?? '');
  const withoutMetadata = source.replace(MANAGED_METADATA, (block) => preserveLines ? maskBlock(block) : '');
  return withoutMetadata.replace(MANAGED_INPUTS, (block) => preserveLines ? maskBlock(block) : '');
}

/** Whitespace-only padding cannot make an untouched prepared template look authored. */
export function authoredArtifactFingerprint(text) {
  const normalized = authoredArtifactText(text)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return sha256(normalized);
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
export function artifactPlaceholderFindings(text) {
  const authored = authoredArtifactText(text, { preserveLines: true });
  const regular = [...authored.matchAll(PLACEHOLDER)].map((match) => ({
    value: match[0], index: match.index
  }));
  const explicitUppercase = [...authored.matchAll(EXPLICIT_UPPERCASE_PLACEHOLDER)]
    .map((match) => ({ value: match[0], index: match.index }))
    .filter((finding) => !regular.some((candidate) => finding.index >= candidate.index
      && finding.index + finding.value.length <= candidate.index + candidate.value.length));
  const seen = new Set();
  return [...regular, ...explicitUppercase, ...anglePlaceholderFindings(authored)]
    .sort((left, right) => left.index - right.index)
    .filter((finding) => {
      const key = `${finding.index}:${finding.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((finding) => ({ value: finding.value, line: lineAt(authored, finding.index) }));
}

function markdownHeadings(text) {
  return [...String(text).matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map((match) => ({
    level: match[1].length,
    name: match[2].trim(),
    normalized: match[2].trim().toLocaleLowerCase('en-US'),
    line: lineAt(text, match.index),
    start: match.index,
    bodyStart: match.index + match[0].length
  }));
}

function requiredHeadingFindings(text, required, pathName) {
  if (!required?.length) return [];
  const headings = markdownHeadings(text);
  const findings = [];
  for (const requested of required) {
    const normalized = String(requested).trim().toLocaleLowerCase('en-US');
    const index = headings.findIndex((heading) => heading.normalized === normalized);
    if (index < 0) {
      findings.push({
        code: 'artifact.heading.missing', category: 'authoring', path: pathName, line: null,
        value: String(requested), bytes: null, minimumBytes: null
      });
      continue;
    }
    const heading = headings[index];
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const body = text.slice(heading.bodyStart, next?.start ?? text.length)
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    if (!body) findings.push({
      code: 'artifact.heading.empty', category: 'authoring', path: pathName, line: heading.line,
      value: String(requested), bytes: null, minimumBytes: null
    });
  }
  return findings;
}

const FINDING_PRIORITY = Object.freeze({
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
  const bytes = Buffer.byteLength(authored);
  const fingerprint = authoredArtifactFingerprint(authored);
  const findings = [];

  for (const placeholder of artifactPlaceholderFindings(text)) findings.push({
    code: 'artifact.placeholder.unresolved', category: 'authoring', path: pathName,
    line: placeholder.line, value: placeholder.value, bytes, minimumBytes: null, fingerprint
  });
  for (const forbidden of contract.validation?.forbiddenPlaceholders ?? []) {
    const escaped = String(forbidden).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(escaped, 'i').exec(authored);
    if (match && !findings.some((finding) => finding.value.toLocaleLowerCase('en-US') === String(forbidden).toLocaleLowerCase('en-US'))) {
      findings.push({
        code: 'artifact.placeholder.unresolved', category: 'authoring', path: pathName,
        line: lineAt(authored, match.index), value: String(forbidden), bytes,
        minimumBytes: null, fingerprint
      });
    }
  }
  if (baseline?.generation != null && baseline.generation === contract.generation
      && baseline.fingerprint === fingerprint) findings.push({
    code: 'artifact.template.unchanged', category: 'authoring', path: pathName, line: null,
    value: null, bytes, minimumBytes: null, fingerprint
  });
  findings.push(...requiredHeadingFindings(authored, contract.validation?.requiredHeadings, pathName)
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

export function requiredArtifactRepoPath(config, workflow, phase) {
  return `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/${phase.requiredArtifact.path}`;
}

/**
 * Read one review document without following a final symlink or trusting a path after validation.
 *
 * `secureRepositoryPath` proves the lexical and canonical repository boundary. The descriptor then
 * pins that exact regular file with `O_NOFOLLOW` where the host provides it. Re-resolving the path
 * and comparing file identity closes replacement of either the file or one of its ancestors before
 * any bytes become governed review evidence.
 */
async function readReviewArtifact(root, relative, label) {
  const secured = await secureRepositoryPath(root, relative, { label, type: 'file' });
  if (!secured.exists) return null;
  let handle;
  try {
    handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new SingularityFlowError(`${label} must be a regular file: ${secured.relative}`, {
        code: 'REPOSITORY_PATH_UNSAFE', details: { path: secured.relative, reason: 'non-regular-file' }
      });
    }
    const rebound = await secureRepositoryPath(root, secured.relative, {
      label, mustExist: true, type: 'file'
    });
    if ((before.ino !== 0 && rebound.entry?.ino !== before.ino)
        || (before.dev !== 0 && rebound.entry?.dev !== before.dev)) {
      throw new SingularityFlowError(`${label} changed while it was being read: ${secured.relative}`, {
        code: 'REPOSITORY_PATH_UNSAFE', details: { path: secured.relative, reason: 'path-race' }
      });
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs) {
      throw new SingularityFlowError(`${label} changed while it was being read: ${secured.relative}`, {
        code: 'REPOSITORY_PATH_UNSAFE', details: { path: secured.relative, reason: 'content-race' }
      });
    }
    return bytes.toString('utf8');
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      throw new SingularityFlowError(`${label} cannot be a symbolic link: ${secured.relative}`, {
        code: 'REPOSITORY_PATH_UNSAFE', details: { path: secured.relative, reason: 'symbolic-link' }, cause: error
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Pure, complete artifact authoring preflight used by publish, recover, and host guidance. */
export async function inspectRequiredArtifactContent(root, config, workflow, phase, {
  placeholders = true, minimumBytes = true
} = {}) {
  const required = requiredArtifactRepoPath(config, workflow, phase);
  const text = await readReviewArtifact(root, required, 'Required phase artifact');
  if (text == null) return [{
    code: 'artifact.required.missing', category: 'authoring', path: required, line: null,
    value: null, bytes: null, minimumBytes: phase.requiredArtifact.minimumBytes ?? 1
  }];
  const contract = {
    ...phase.requiredArtifact,
    // During authoring the contract describes the next generation; after publication it describes
    // the current submitted generation. This lets submit/approval retain the unchanged-template
    // invariant instead of accidentally comparing generation N's bytes with an N+1 contract.
    generation: phase.status === 'in_progress'
      ? Number(phase.generation) + 1
      : Number(phase.generation),
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
  return placeholders
    ? inspected.findings
    : inspected.findings.filter((finding) => finding.code !== 'artifact.placeholder.unresolved');
}

function reviewableMarkdownPath(relativePath) {
  return /\.(?:md|markdown)$/i.test(String(relativePath));
}

function aggregateReviewableFingerprint(artifacts) {
  const digest = createHash('sha256');
  for (const artifact of [...artifacts].sort((left, right) => left.path.localeCompare(right.path))) {
    // Include absent declared members as well as present ones. Adding a previously absent optional
    // review document is a draft change just as surely as editing an existing document is.
    digest.update(`${artifact.path}\0${artifact.exists ? artifact.fingerprint : '<missing>'}\n`);
  }
  return `sha256:${digest.digest('hex')}`;
}

/**
 * Catalogue the complete human-reviewable Story draft, independent of declaration order.
 *
 * This is deliberately smaller than an artifact-set catalogue: source trees, test receipts and
 * binary evidence are not prose drafts. The returned aggregate is what authoring hosts use for
 * bounded repair progress, so changing only a supporting Markdown document must change it.
 */
export async function phaseAuthoredReviewArtifacts(root, config, workflow, phase) {
  const required = requiredArtifactRepoPath(config, workflow, phase);
  const declared = new Map([[required, { path: required, scope: 'primary' }]]);
  const set = resolvedArtifactSet(config, workflow, phase);
  if (set) {
    const phaseArtifactRoot = path.posix.join(
      config.workItemRoot ?? 'singularity/work-items',
      workflow.workItem.id,
      memberRoot(phase)
    );
    for (const member of set.members) {
      if (member.authority !== 'governed') continue;
      const relative = path.posix.join(phaseArtifactRoot, member.path);
      if (relative === required || member.path.endsWith('/') || !reviewableMarkdownPath(relative)) continue;
      declared.set(relative, { path: relative, scope: 'supporting' });
    }
  }

  const artifacts = [];
  for (const declaration of [...declared.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    const text = await readReviewArtifact(
      root,
      declaration.path,
      declaration.scope === 'primary' ? 'Required phase artifact' : 'Supporting review artifact'
    );
    const bytes = text == null ? null : Buffer.from(text, 'utf8');
    artifacts.push(Object.freeze({
      ...declaration,
      exists: bytes != null,
      bytes: bytes?.length ?? null,
      sha256: bytes == null ? null : sha256(bytes),
      fingerprint: bytes == null ? null : authoredArtifactFingerprint(text)
    }));
  }
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    fingerprint: aggregateReviewableFingerprint(artifacts)
  });
}

/**
 * Inspect every human-reviewable document owned by a Story phase.
 *
 * The primary keeps its full authored-content contract. Present, non-directory Markdown members
 * in a typed artifact set receive the same placeholder scan. Directories and arbitrary registered
 * artifacts are deliberately excluded: those can contain source, test fixtures, or machine
 * evidence where strings such as `TODO` are data rather than an unfinished review document.
 */
export async function inspectPhaseAuthoredReviewContent(root, config, workflow, phase, {
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
    for (const placeholder of artifactPlaceholderFindings(text)) findings.push({
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

export function artifactFindingMessage(finding) {
  const label = finding.artifactScope === 'supporting' ? 'Supporting review artifact' : 'Required artifact';
  if (finding.code === 'artifact.required.missing') return `Required artifact missing: ${finding.path}`;
  if (finding.code === 'artifact.required.too-short') {
    return `Required artifact ${finding.path} has ${finding.bytes} authored bytes; minimum ${finding.minimumBytes}.`;
  }
  if (finding.code === 'artifact.required.too-large') {
    return `Required artifact ${finding.path} has ${finding.bytes} authored bytes; maximum ${finding.maximumBytes}.`;
  }
  if (finding.code === 'artifact.placeholder.unresolved') {
    return `${label} ${finding.path} contains unresolved placeholder '${finding.value}' at line ${finding.line}.`;
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
