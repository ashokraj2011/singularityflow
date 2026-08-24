import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { exists } from './util.mjs';

const PLACEHOLDER = /\b(?:TODO|TBD)\b|\{\{[^}]+\}\}|\[\s*(?:describe|add|insert|provide|record)[^\]]*\]/gi;
const MANAGED_INPUTS = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/g;
const MANAGED_METADATA = /^<!-- singularity-flow:metadata\n[\s\S]*?\n-->\s*/;
const SINGLE_WORD_ANGLE_PLACEHOLDERS = new Set([
  'benefit', 'capability', 'decision', 'requirement', 'role'
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
  const seen = new Set();
  return [...regular, ...anglePlaceholderFindings(authored)]
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

/** Pure, complete artifact authoring preflight used by publish, recover, and host guidance. */
export async function inspectRequiredArtifactContent(root, config, workflow, phase, {
  placeholders = true, minimumBytes = true
} = {}) {
  const required = requiredArtifactRepoPath(config, workflow, phase);
  const absolute = path.join(root, required);
  if (!(await exists(absolute))) return [{
    code: 'artifact.required.missing', category: 'authoring', path: required, line: null,
    value: null, bytes: null, minimumBytes: phase.requiredArtifact.minimumBytes ?? 1
  }];
  const text = await readFile(absolute, 'utf8');
  const contract = {
    ...phase.requiredArtifact,
    generation: Number(phase.generation) + 1,
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

export function artifactFindingMessage(finding) {
  if (finding.code === 'artifact.required.missing') return `Required artifact missing: ${finding.path}`;
  if (finding.code === 'artifact.required.too-short') {
    return `Required artifact ${finding.path} has ${finding.bytes} authored bytes; minimum ${finding.minimumBytes}.`;
  }
  if (finding.code === 'artifact.required.too-large') {
    return `Required artifact ${finding.path} has ${finding.bytes} authored bytes; maximum ${finding.maximumBytes}.`;
  }
  if (finding.code === 'artifact.placeholder.unresolved') {
    return `Required artifact ${finding.path} contains unresolved placeholder '${finding.value}' at line ${finding.line}.`;
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
