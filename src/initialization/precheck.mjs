import { createHash } from 'node:crypto';
import path from 'node:path';
import { access, lstat, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import YAML from 'yaml';

import { gitCommonDir, identity } from '../git.mjs';
import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { resolvePlatformProcess } from '../platform-process.mjs';
import { captureSmartInitSnapshot } from './source-snapshot.mjs';
import { readLatestSmartInitActivation } from './recovery.mjs';

function sha(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

async function regularFile(file, { executable = false } = {}) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    if (executable && process.platform !== 'win32') await access(file, fsConstants.X_OK);
    return true;
  } catch { return false; }
}

async function pathExecutable(name, environment = process.env) {
  if (process.platform === 'win32') {
    try { return Boolean(resolvePlatformProcess(name, [], { environment })); } catch { return false; }
  }
  const systemExecutable = async (file) => {
    try {
      const info = await stat(file);
      if (!info.isFile()) return false;
      await access(file, fsConstants.X_OK);
      return true;
    } catch { return false; }
  };
  if (name.includes('/')) return systemExecutable(name);
  for (const directory of String(environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (await systemExecutable(path.join(directory, name))) return true;
  }
  return false;
}

async function commandAvailability(root, command) {
  const cwd = path.resolve(root, command.workingDirectory);
  const relative = path.relative(root, cwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { status: 'fail', reason: 'working-directory-escape' };
  try { if (!(await lstat(cwd)).isDirectory()) return { status: 'fail', reason: 'working-directory-missing' }; }
  catch { return { status: 'fail', reason: 'working-directory-missing' }; }
  let launcher = command.launcher;
  if (launcher === 'maven-wrapper') {
    const candidates = process.platform === 'win32' ? ['mvnw.cmd', 'mvnw'] : ['mvnw', 'mvnw.cmd'];
    const selected = candidates.map((name) => path.join(cwd, name));
    const available = (await Promise.all(selected.map((file) => regularFile(file, { executable: process.platform !== 'win32' })))).some(Boolean);
    return { status: available ? 'pass' : 'unavailable', reason: available ? 'repository-wrapper' : 'wrapper-missing' };
  }
  if (launcher === 'gradle-wrapper') {
    const candidates = process.platform === 'win32' ? ['gradlew.bat', 'gradlew'] : ['gradlew', 'gradlew.bat'];
    const available = (await Promise.all(candidates.map((name) => regularFile(path.join(cwd, name), { executable: process.platform !== 'win32' })))).some(Boolean);
    return { status: available ? 'pass' : 'unavailable', reason: available ? 'repository-wrapper' : 'wrapper-missing' };
  }
  return { status: await pathExecutable(launcher) ? 'pass' : 'unavailable', reason: 'path-metadata' };
}

function verifySelfHash(record, field) {
  const core = structuredClone(record);
  const supplied = core[field];
  delete core[field];
  return supplied === `sha256:${recordSha256(core)}`;
}

export async function smartInitPrecheck(root) {
  const workflowFile = path.join(root, 'singularity', 'workflow.yml');
  const receiptSource = await readLatestSmartInitActivation(root);
  const checks = [];
  if (!receiptSource) checks.push({ id: 'activation-receipt', status: 'unavailable', subject: 'smart-init', reason: 'receipt-missing' });
  else checks.push({
    id: 'activation-receipt',
    status: verifySelfHash(receiptSource.record, 'receiptSha256') ? 'pass' : 'fail',
    subject: path.relative(root, receiptSource.file).replaceAll(path.sep, '/')
  });
  let workflow = null; let workflowBytes = null;
  try {
    workflowBytes = await readFile(workflowFile);
    workflow = YAML.parse(workflowBytes.toString('utf8'));
    checks.push({ id: 'configuration-parse', status: workflow?.version === 2 ? 'pass' : 'fail', subject: 'singularity/workflow.yml' });
  } catch {
    checks.push({ id: 'configuration-parse', status: 'fail', subject: 'singularity/workflow.yml' });
  }
  if (receiptSource && workflowBytes) checks.push({
    id: 'configuration-binding',
    status: receiptSource.record.installed?.configurationSha256 === sha(workflowBytes) ? 'pass' : 'fail',
    subject: 'singularity/workflow.yml'
  });
  const originPath = path.join(root, 'singularity', 'configuration-origin.json');
  try {
    const originBytes = await readFile(originPath);
    const origin = readRecord('configuration-origin-map', originBytes).record;
    const receiptBound = !receiptSource || receiptSource.record.installed?.originMapSha256 === sha(originBytes);
    checks.push({ id: 'configuration-origin', status: verifySelfHash(origin, 'originMapSha256') && receiptBound ? 'pass' : 'fail', subject: 'singularity/configuration-origin.json' });
  } catch { checks.push({ id: 'configuration-origin', status: 'unavailable', subject: 'singularity/configuration-origin.json' }); }
  const policy = workflow?.initialization ?? null;
  const presetPath = policy?.preset?.id && policy?.preset?.version
    ? path.join(root, 'singularity', 'presets', `${policy.preset.id}.v${policy.preset.version}.yml`)
    : null;
  if (presetPath) {
    try {
      const preset = readRecord('smart-init-preset-snapshot', YAML.parse(await readFile(presetPath, 'utf8'))).record;
      checks.push({
        id: 'preset-binding',
        status: verifySelfHash(preset, 'presetSha256')
          && (!receiptSource || receiptSource.record.installed?.presetSha256 === preset.presetSha256) ? 'pass' : 'fail',
        subject: path.relative(root, presetPath).replaceAll(path.sep, '/')
      });
    } catch { checks.push({ id: 'preset-binding', status: 'fail', subject: path.relative(root, presetPath).replaceAll(path.sep, '/') }); }
  } else checks.push({ id: 'preset-binding', status: 'unavailable', subject: 'smart-init-preset' });
  if (receiptSource?.record?.subject?.repositoryFingerprint) {
    try {
      const snapshot = await captureSmartInitSnapshot(root);
      checks.push({
        id: 'repository-identity',
        status: snapshot.subject.repositoryFingerprint === receiptSource.record.subject.repositoryFingerprint ? 'pass' : 'fail',
        subject: 'credential-free-remote'
      });
    } catch { checks.push({ id: 'repository-identity', status: 'unavailable', subject: 'credential-free-remote' }); }
  } else checks.push({ id: 'repository-identity', status: 'unavailable', subject: 'credential-free-remote' });
  if (receiptSource) {
    const journal = path.join(gitCommonDir(root), 'singularity-flow', 'journals', 'init', `${receiptSource.record.proposalSha256.slice(7, 19)}.json`);
    try {
      const record = readRecord('smart-init-activation-journal', await readFile(journal)).record;
      checks.push({ id: 'activation-recovery', status: record.status === 'complete' ? 'pass' : 'fail', subject: 'git-private-init-journal', reason: record.status });
    } catch { checks.push({ id: 'activation-recovery', status: 'unavailable', subject: 'git-private-init-journal', reason: 'journal-missing' }); }
  }
  checks.push({ id: 'implicit-capability', status: policy?.capability?.id === 'repository-root' ? 'pass' : 'unavailable', subject: 'repository-root' });
  const configured = Object.values(policy?.commands ?? {}).flat();
  for (const command of configured) {
    const shapeValid = command && typeof command === 'object'
      && typeof command.id === 'string' && typeof command.launcher === 'string'
      && Array.isArray(command.args) && command.args.every((argument) => typeof argument === 'string' && !argument.includes('\0'))
      && typeof command.workingDirectory === 'string'
      && ['verify', 'quality', 'build'].includes(command.purpose)
      && command.modelPolicy === 'never'
      && (command.adapter === null || command.adapter === 'exit-code');
    if (!shapeValid) {
      checks.push({ id: 'command-contract', status: 'fail', subject: command?.id ?? 'unknown-command', reason: 'invalid-structured-command' });
      continue;
    }
    checks.push({ id: 'command-contract', status: 'pass', subject: command.id, reason: 'structured-argv' });
    const result = await commandAvailability(root, command);
    checks.push({ id: 'command-availability', status: result.status, subject: command.id, reason: result.reason });
  }
  try {
    const actor = identity(root, { offline: true });
    checks.push({ id: 'git-identity', status: actor.email ? 'pass' : 'unavailable', subject: actor.email ? 'configured-local' : 'missing-email' });
  } catch { checks.push({ id: 'git-identity', status: 'unavailable', subject: 'configured-local' }); }
  const readiness = policy?.proof?.readiness ?? 'unavailable';
  checks.push({ id: 'proof-readiness', status: readiness === 'ready' ? 'pass' : 'unavailable', subject: policy?.proof?.profile ?? 'standard' });
  const status = checks.some((entry) => entry.status === 'fail') ? 'fail'
    : checks.some((entry) => entry.status === 'unavailable') ? 'unavailable' : 'pass';
  const core = {
    schemaVersion: currentSchemaVersion('smart-init-precheck-receipt'), kind: 'smart-init-precheck-receipt',
    activationReceiptSha256: receiptSource?.record?.receiptSha256 ?? null,
    configurationSha256: workflowBytes ? sha(workflowBytes) : null,
    checks: checks.map((entry) => ({ ...entry, evidenceSha256: `sha256:${recordSha256(entry)}` })),
    proofReadiness: readiness, status, observedAt: new Date().toISOString()
  };
  return { ...core, receiptSha256: `sha256:${recordSha256(core)}` };
}
