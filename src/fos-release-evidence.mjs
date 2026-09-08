import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ACCEPTANCE_COUNT = 50;
const ACCEPTANCE = Object.freeze(Array.from({ length: ACCEPTANCE_COUNT }, (_, index) =>
  `FOS:AC-${String(index + 1).padStart(3, '0')}`));

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function testFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await testFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) result.push(absolute);
  }
  return result.sort();
}

function quotedEnd(source, start, quote) {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === quote) return index;
  }
  return -1;
}

function functionBody(source, afterTitle) {
  const arrow = source.indexOf('=>', afterTitle);
  if (arrow < 0) return null;
  const start = source.indexOf('{', arrow + 2);
  if (start < 0) return null;
  let depth = 0;
  let state = 'normal';
  let escaped = false;
  let regexClass = false;
  let previousSignificant = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') { state = 'normal'; index += 1; }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if ((state === 'single' && character === "'")
          || (state === 'double' && character === '"')
          || (state === 'template' && character === '`')) state = 'normal';
      continue;
    }
    if (state === 'regex') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '[') regexClass = true;
      else if (character === ']') regexClass = false;
      else if (character === '/' && !regexClass) state = 'normal';
      continue;
    }
    if (character === '/' && next === '/') { state = 'line-comment'; index += 1; continue; }
    if (character === '/' && next === '*') { state = 'block-comment'; index += 1; continue; }
    if (character === "'") { state = 'single'; continue; }
    if (character === '"') { state = 'double'; continue; }
    if (character === '`') { state = 'template'; continue; }
    if (character === '/' && (!previousSignificant || /[({[=,:;!&|?+\-*%^~<>]/.test(previousSignificant))) {
      state = 'regex'; regexClass = false; continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
    if (!/\s/.test(character)) previousSignificant = character;
  }
  return null;
}

function witnessesInSource(source, relativeFile) {
  const witnesses = [];
  const declaration = /\btest\s*\(\s*(['"`])/g;
  let match;
  while ((match = declaration.exec(source))) {
    const quote = match[1];
    const titleStart = match.index + match[0].lastIndexOf(quote);
    const titleEnd = quotedEnd(source, titleStart, quote);
    if (titleEnd < 0) continue;
    const title = source.slice(titleStart + 1, titleEnd);
    const reference = /^FOS:(?:(PARTIAL|DEFERRED)-)?AC-(\d{3})(?:\s|$)/.exec(title);
    if (!reference) { declaration.lastIndex = titleEnd + 1; continue; }
    const acceptance = `FOS:AC-${reference[2]}`;
    const classification = reference[1]?.toLowerCase() ?? 'acceptance';
    const body = functionBody(source, titleEnd + 1);
    witnesses.push(Object.freeze({
      acceptance,
      classification,
      title,
      file: relativeFile,
      namePath: `${relativeFile} > ${title}`,
      testBodySha256: body ? sha256(body) : null,
      sourceLine: source.slice(0, match.index).split('\n').length
    }));
    declaration.lastIndex = titleEnd + 1;
  }
  return witnesses;
}

export async function collectFosWitnesses(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const files = await testFiles(path.join(root, 'test'));
  const witnesses = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    witnesses.push(...witnessesInSource(source, path.relative(root, file).split(path.sep).join('/')));
  }
  return Object.freeze(witnesses.sort((left, right) =>
    left.acceptance.localeCompare(right.acceptance) || left.namePath.localeCompare(right.namePath)));
}

function git(root, arguments_) {
  try {
    return execFileSync('git', arguments_, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch { return null; }
}

export async function buildFosEvidenceInventory(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const referencedTests = await collectFosWitnesses(root);
  const witnesses = referencedTests.filter((entry) => entry.classification === 'acceptance');
  const partialEvidence = referencedTests.filter((entry) => entry.classification === 'partial');
  const deferredEvidence = referencedTests.filter((entry) => entry.classification === 'deferred');
  const byAcceptance = Object.fromEntries(ACCEPTANCE.map((id) => [id,
    witnesses.filter((entry) => entry.acceptance === id)]));
  const missing = ACCEPTANCE.filter((id) => byAcceptance[id].length === 0);
  const malformed = witnesses.filter((entry) => !entry.testBodySha256);
  const duplicateTitles = witnesses.filter((entry, index) =>
    witnesses.findIndex((candidate) => candidate.title === entry.title) !== index)
    .map((entry) => entry.title);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const dirty = Boolean(git(root, ['status', '--porcelain=v1', '--untracked-files=all']));
  const witnessSetSha256 = sha256(JSON.stringify(witnesses.map((entry) => ({
    acceptance: entry.acceptance, namePath: entry.namePath, testBodySha256: entry.testBodySha256
  }))));
  return Object.freeze({
    schemaVersion: 1,
    kind: 'fos-release-evidence-inventory',
    status: missing.length || malformed.length || duplicateTitles.length ? 'incomplete' : 'inventory-complete',
    binding: {
      implementationCommit: commit,
      workingTree: dirty ? 'dirty-unbound' : 'clean',
      hashBound: Boolean(commit) && !dirty,
      witnessSetSha256
    },
    expectedAcceptanceCases: ACCEPTANCE,
    representedAcceptanceCases: ACCEPTANCE.filter((id) => byAcceptance[id].length > 0),
    unrepresentedAcceptanceCases: missing,
    malformedWitnesses: malformed.map((entry) => entry.namePath),
    duplicateTitles: [...new Set(duplicateTitles)].sort(),
    witnesses,
    partialEvidence,
    deferredEvidence,
    execution: { status: 'not-run', passed: [], failed: [], skipped: [] }
  });
}

function tapExecution(output, expectedTitles) {
  const passed = [];
  const failed = [];
  const skipped = [];
  for (const line of output.split(/\r?\n/)) {
    const result = /^\s*(not )?ok \d+ - (FOS:AC-\d{3}(?:\s+.*)??)(?: # (SKIP|TODO).*)?$/.exec(line);
    if (!result) continue;
    const title = result[2].replaceAll('\\#', '#').trim();
    if (result[3]) skipped.push(title);
    else if (result[1]) failed.push(title);
    else passed.push(title);
  }
  const observed = new Set([...passed, ...failed, ...skipped]);
  const unavailable = expectedTitles.filter((title) => !observed.has(title));
  return { passed, failed, skipped, unavailable };
}

export async function executeFosEvidenceInventory(repositoryRoot, { timeoutMs = 15 * 60_000 } = {}) {
  const inventory = await buildFosEvidenceInventory(repositoryRoot);
  const root = path.resolve(repositoryRoot);
  const files = [...new Set(inventory.witnesses.map((entry) => entry.file))];
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: 'test' }
  });
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const execution = tapExecution(output, inventory.witnesses.map((entry) => entry.title));
  const successful = run.status === 0 && !run.error && execution.failed.length === 0
    && execution.skipped.length === 0 && execution.unavailable.length === 0;
  return Object.freeze({
    ...inventory,
    status: inventory.status === 'inventory-complete' && successful ? 'local-evidence-complete' : 'incomplete',
    execution: {
      status: successful ? 'passed' : run.error?.code === 'ETIMEDOUT' ? 'timed-out' : 'failed',
      exitCode: run.status,
      passed: execution.passed,
      failed: execution.failed,
      skipped: execution.skipped,
      unavailable: execution.unavailable
    }
  });
}

export const FOS_ACCEPTANCE_CASES = ACCEPTANCE;
