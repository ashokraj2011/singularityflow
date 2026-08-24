import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { exists } from './util.mjs';

const PLACEHOLDER = /\b(?:TODO|TBD)\b|\{\{[^}]+\}\}|\[\s*(?:describe|add|insert|provide|record)[^\]]*\]/gi;
const MANAGED_INPUTS = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/g;
const SINGLE_WORD_ANGLE_PLACEHOLDERS = new Set([
  'benefit', 'capability', 'decision', 'requirement', 'role'
]);

function maskBlock(block) {
  return '\n'.repeat((block.match(/\n/g) ?? []).length);
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
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
  const authored = String(text)
    .replace(/<!-- singularity-flow:metadata[\s\S]*?-->/, maskBlock)
    .replace(MANAGED_INPUTS, maskBlock);
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
  const bytes = Buffer.byteLength(text);
  const findings = [];
  if (minimumBytes && bytes < (phase.requiredArtifact.minimumBytes ?? 1)) findings.push({
    code: 'artifact.required.too-short', category: 'authoring', path: required, line: null,
    value: null, bytes, minimumBytes: phase.requiredArtifact.minimumBytes ?? 1
  });
  if (placeholders) {
    for (const placeholder of artifactPlaceholderFindings(text)) findings.push({
      code: 'artifact.placeholder.unresolved', category: 'authoring', path: required,
      line: placeholder.line, value: placeholder.value, bytes, minimumBytes: null
    });
  }
  return findings;
}

export function artifactFindingMessage(finding) {
  if (finding.code === 'artifact.required.missing') return `Required artifact missing: ${finding.path}`;
  if (finding.code === 'artifact.required.too-short') {
    return `Required artifact ${finding.path} is too short (${finding.bytes} bytes).`;
  }
  if (finding.code === 'artifact.placeholder.unresolved') {
    return `Required artifact ${finding.path} contains unresolved placeholder '${finding.value}' at line ${finding.line}.`;
  }
  return `Required artifact ${finding.path} is not publishable.`;
}

export async function validateRequiredArtifactContent(root, config, workflow, phase, options = {}) {
  return (await inspectRequiredArtifactContent(root, config, workflow, phase, options))
    .map(artifactFindingMessage);
}
