/** Model-free execution-environment declaration, binding, and audit CLI. */
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import {
  bindEnvironment, environmentBindingStatus, unbindEnvironment
} from '../environment-bindings.mjs';
import {
  loadEnvironmentDeclaration, matchEnvironmentLocalPath
} from '../environment-declaration.mjs';
import { environmentAuditGitSnapshot, repoRoot } from '../git.mjs';
import { scanEntries, scannablePath } from '../secrets.mjs';
import { optionBoolean, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['status', 'audit', 'bind', 'unbind']);
const MAXIMUM_STDIN_BYTES = 256 * 1024;
const MAXIMUM_AUDIT_FILE_BYTES = 1024 * 1024;
const MAXIMUM_AUDIT_BYTES = 16 * 1024 * 1024;

function fail(message, code = 'ENVIRONMENT_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function rejectOptions(options, allowed) {
  const supported = new Set([...allowed, 'json', 'timings']);
  const unknown = Object.keys(options).filter((key) => !supported.has(key));
  if (unknown.length) {
    fail(`Unsupported option(s): ${unknown.sort().map((key) => `--${key}`).join(', ')}. Runtime values are accepted only through --stdin.`);
  }
}

async function readBindingStdin(input = process.stdin) {
  if (input.isTTY) {
    fail('Pipe a bounded JSON binding object into --stdin; interactive input is not accepted.',
      'ENVIRONMENT_BINDING_STDIN_REQUIRED');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAXIMUM_STDIN_BYTES) {
      fail(`Environment binding input exceeds ${MAXIMUM_STDIN_BYTES} bytes.`,
        'ENVIRONMENT_BINDING_INPUT_TOO_LARGE');
    }
    chunks.push(value);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.concat(chunks));
  } catch {
    fail('Environment binding input must be valid UTF-8.', 'ENVIRONMENT_BINDING_INVALID');
  }
  try { return JSON.parse(text); }
  catch {
    // Node's JSON parser diagnostics can quote the malformed input around the error position.
    // Binding input is private, so never relay the parser's message to logs or terminal output.
    fail('Environment binding input is not valid JSON.', 'ENVIRONMENT_BINDING_INVALID');
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function readStableAuditFile(absolute, expected) {
  let handle;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(expected, opened)
        || opened.size > MAXIMUM_AUDIT_FILE_BYTES) return null;
    const buffer = Buffer.alloc(MAXIMUM_AUDIT_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const completed = await handle.stat();
    if (offset > MAXIMUM_AUDIT_FILE_BYTES || !sameFileIdentity(opened, completed)
        || opened.size !== completed.size || opened.mtimeMs !== completed.mtimeMs
        || opened.ctimeMs !== completed.ctimeMs || offset !== completed.size) return null;
    return buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function environmentPolicySet(...declarations) {
  const byDigest = new Map();
  for (const declaration of declarations.flat().filter(Boolean)) {
    byDigest.set(declaration.declarationSha256, declaration);
  }
  return [...byDigest.values()];
}

function environmentPathMatches(declarations, relative) {
  const matches = declarations.map((declaration) => (
    matchEnvironmentLocalPath(declaration, relative)
  )).filter(Boolean);
  return matches.filter((entry, index) => matches.findIndex((candidate) => (
    candidate.environmentId === entry.environmentId
      && candidate.kind === entry.kind
      && candidate.pattern === entry.pattern
  )) === index);
}

async function auditEnvironment(root) {
  const worktreeDeclaration = await loadEnvironmentDeclaration(root, { optional: false });
  const gitSnapshot = environmentAuditGitSnapshot(root, {
    maximumObjectBytes: MAXIMUM_AUDIT_FILE_BYTES,
    maximumTotalBytes: MAXIMUM_AUDIT_BYTES
  });
  const { tracked, untracked, ignored, headPaths, headEntries } = gitSnapshot;
  const worktreePolicies = environmentPolicySet(
    worktreeDeclaration,
    gitSnapshot.declarations.candidateIndex,
    gitSnapshot.declarations.lastPublication
  );
  const candidatePolicies = environmentPolicySet(
    gitSnapshot.declarations.candidateIndex,
    worktreeDeclaration,
    gitSnapshot.declarations.lastPublication
  );
  const lastPublicationPolicies = environmentPolicySet(
    gitSnapshot.declarations.lastPublication,
    gitSnapshot.declarations.candidateIndex,
    worktreeDeclaration
  );
  const findings = [];
  const localFiles = [];
  for (const relative of tracked) {
    for (const rule of environmentPathMatches(candidatePolicies, relative)) findings.push(Object.freeze({
      code: 'environment.local-file-tracked', path: relative, ...rule
    }));
  }
  for (const relative of untracked) {
    for (const rule of environmentPathMatches(worktreePolicies, relative)) findings.push(Object.freeze({
      code: 'environment.local-file-unignored', path: relative, ...rule
    }));
  }
  for (const relative of ignored) {
    for (const rule of environmentPathMatches(worktreePolicies, relative)) {
      localFiles.push(Object.freeze({ path: relative, ...rule }));
    }
  }
  for (const relative of headPaths) {
    for (const rule of environmentPathMatches(lastPublicationPolicies, relative)) findings.push(Object.freeze({
      code: 'environment.local-file-tracked', source: 'last-publication', path: relative, ...rule
    }));
  }

  const worktreeEntries = [];
  const skipped = [...gitSnapshot.skipped];
  let admittedBytes = gitSnapshot.admittedBytes;
  for (const relative of [...new Set([...tracked, ...untracked])].sort()) {
    if (!scannablePath(relative)) continue;
    const absolute = path.join(root, ...relative.split('/'));
    let info;
    try { info = await lstat(absolute); }
    catch { skipped.push(Object.freeze({ path: relative, reason: 'unreadable' })); continue; }
    if (!info.isFile() || info.isSymbolicLink()) {
      skipped.push(Object.freeze({ path: relative, reason: 'not-regular-file' }));
      continue;
    }
    if (info.size > MAXIMUM_AUDIT_FILE_BYTES
        || admittedBytes + info.size > MAXIMUM_AUDIT_BYTES) {
      skipped.push(Object.freeze({ path: relative, reason: 'audit-byte-ceiling' }));
      continue;
    }
    const bytes = await readStableAuditFile(absolute, info);
    if (!bytes) {
      skipped.push(Object.freeze({ path: relative, reason: 'changed-or-unreadable' }));
      continue;
    }
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch {
      skipped.push(Object.freeze({ path: relative, reason: 'invalid-utf8' }));
      continue;
    }
    admittedBytes += bytes.length;
    worktreeEntries.push({ path: relative, content });
  }

  const scans = [
    ['worktree', worktreeEntries],
    ['candidate-index', gitSnapshot.stagedEntries],
    ['last-publication', headEntries]
  ];
  let scanned = 0;
  for (const [source, entries] of scans) {
    const secretScan = scanEntries(entries);
    scanned += secretScan.scanned;
    findings.push(...secretScan.blocking.map((entry) => Object.freeze({
      code: 'environment.possible-secret', source,
      path: entry.path, line: entry.line, rule: entry.rule, severity: entry.severity
    })));
  }
  const coverageComplete = skipped.length === 0;
  return Object.freeze({
    schemaVersion: 1,
    resultType: 'environment-audit',
    status: findings.length ? 'findings' : coverageComplete ? 'clean' : 'unavailable',
    declarationSha256: worktreeDeclaration.declarationSha256,
    findings: Object.freeze(findings.sort((left, right) => left.path.localeCompare(right.path)
      || left.code.localeCompare(right.code))),
    localFiles: Object.freeze(localFiles.sort((left, right) => left.path.localeCompare(right.path))),
    scanned,
    skipped: Object.freeze(skipped.sort((left, right) => left.path.localeCompare(right.path))),
    coverageComplete,
    assurance: 'worktree-candidate-index-last-publication-and-declared-local-paths'
  });
}

function emit(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (value.resultType === 'environment-audit') {
    console.log(`Environment audit: ${value.status} · ${value.findings.length} finding(s) · ${value.localFiles.length} ignored local file(s)`);
    for (const finding of value.findings) {
      console.log(`- ${finding.path}: ${finding.code}${finding.pattern ? ` (${finding.pattern})` : ''}`);
    }
  } else if (value.environments) {
    console.log(`Environment declaration: ${value.declaration.status} · ${value.storageAssurance}`);
    for (const entry of value.environments) {
      console.log(`- ${entry.environment.name}: ${entry.status}${entry.missing.length ? ` · missing ${entry.missing.join(', ')}` : ''}`);
    }
  } else {
    console.log(`Environment '${value.environment}': ${value.removed ? 'private binding removed' : 'no private binding existed'}`);
  }
  return value;
}

export async function run(_argv, { positionals, options }) {
  const subcommand = positionals[1] ?? 'status';
  if (!SUBCOMMANDS.includes(subcommand)) {
    fail(`Unknown env subcommand '${subcommand}'. Supported: ${SUBCOMMANDS.join(', ')}.`,
      'UNKNOWN_SUBCOMMAND');
  }
  const root = repoRoot(process.cwd());
  const json = optionBoolean(options, 'json');
  if (subcommand === 'status') {
    rejectOptions(options, []);
    if (positionals.length > 3) fail('env status accepts at most one environment ID.');
    return emit(await environmentBindingStatus(root, positionals[2] ?? null), json);
  }
  if (subcommand === 'audit') {
    rejectOptions(options, []);
    if (positionals.length > 2) fail('env audit does not accept positional arguments.');
    return emit(await auditEnvironment(root), json);
  }
  const environmentId = positionals[2];
  if (!environmentId || positionals.length > 3) {
    fail(`env ${subcommand} requires exactly one environment ID.`);
  }
  if (subcommand === 'bind') {
    rejectOptions(options, ['stdin']);
    if (!optionBoolean(options, 'stdin')) {
      fail('env bind accepts runtime values only through --stdin.',
        'ENVIRONMENT_BINDING_STDIN_REQUIRED');
    }
    const resolved = await bindEnvironment(root, environmentId, await readBindingStdin());
    return emit({
      schemaVersion: 1,
      resultType: 'environment-binding-result',
      status: resolved.status,
      environment: resolved.environment,
      missing: resolved.missing,
      storageAssurance: 'filesystem-private'
    }, json);
  }
  rejectOptions(options, []);
  return emit(await unbindEnvironment(root, environmentId), json);
}
