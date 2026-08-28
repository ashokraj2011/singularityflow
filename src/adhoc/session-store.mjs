import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { exists, readJson, writeJson } from '../util.mjs';
import { assertRecordHash, stampRecord, adhocError } from './contracts.mjs';

const FILES = Object.freeze({
  session: ['adhoc-session', 'session.json', 'sessionSha256'],
  baseline: ['adhoc-baseline', 'baseline.json', 'baselineSha256'],
  preview: ['adhoc-change-set', 'landing-preview.json', 'changeSetSha256'],
  candidate: ['adhoc-intent-candidate', 'intent-candidate.json', 'candidateSha256'],
  intent: ['adhoc-confirmed-intent', 'confirmed-intent.json', 'intentSha256'],
  disposition: ['adhoc-change-disposition-map', 'disposition-map.json', 'mapSha256'],
  verificationPlan: ['adhoc-verification-plan', 'verification-plan.json', 'planSha256'],
  verificationResult: ['adhoc-verification-result', 'verification-result.json', 'resultSha256'],
  eligibility: ['adhoc-landing-eligibility', 'eligibility.json', 'resultSha256'],
  packet: ['adhoc-landing-packet', 'landing-packet.json', 'packetSha256'],
  receipt: ['adhoc-landing-receipt', 'landing-receipt.json', 'receiptSha256']
});

function safeId(value) {
  const id = String(value ?? '').trim();
  if (!/^AHS-[A-Z0-9-]{8,80}$/.test(id)) {
    throw adhocError('ADH_SESSION_NOT_FOUND', `Invalid ad hoc session ID '${value}'.`, 'Use the exact AHS-* ID from adhoc status.');
  }
  return id;
}

export function adhocRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'adhoc');
}

export function adhocSessionDirectory(root, sessionId) {
  return path.join(adhocRoot(root), safeId(sessionId));
}

export function activeSessionFile(root) {
  return path.join(adhocRoot(root), 'active.json');
}

export async function writeSessionRecord(root, sessionId, name, value) {
  const descriptor = FILES[name];
  if (!descriptor) throw new Error(`Unknown ad hoc operational record '${name}'.`);
  const [family, file, hashField] = descriptor;
  const record = stampRecord(family, value, hashField);
  await writeJson(path.join(adhocSessionDirectory(root, sessionId), file), record);
  return record;
}

export async function readSessionRecord(root, sessionId, name, { required = true } = {}) {
  const descriptor = FILES[name];
  if (!descriptor) throw new Error(`Unknown ad hoc operational record '${name}'.`);
  const [family, file, hashField] = descriptor;
  const target = path.join(adhocSessionDirectory(root, sessionId), file);
  if (!await exists(target)) {
    if (!required) return null;
    throw adhocError('ADH_SESSION_NOT_FOUND', `Ad hoc ${name} record is missing for '${sessionId}'.`, 'Run adhoc status and recover from the last complete local record.');
  }
  const result = readRecord(family, await readFile(target, 'utf8')).record;
  return assertRecordHash(result, hashField, `${name} record`);
}

export async function writeActiveSession(root, sessionId) {
  await mkdir(adhocRoot(root), { recursive: true });
  await writeJson(activeSessionFile(root), {
    schemaVersion: currentSchemaVersion('adhoc-active-session'),
    sessionId: safeId(sessionId)
  });
}

export async function clearActiveSession(root, sessionId) {
  const active = await readActiveSessionId(root, { required: false });
  if (active !== sessionId) return;
  await writeJson(activeSessionFile(root), {
    schemaVersion: currentSchemaVersion('adhoc-active-session'),
    sessionId: null
  });
}

export async function readActiveSessionId(root, { required = true } = {}) {
  const target = activeSessionFile(root);
  if (!await exists(target)) {
    if (!required) return null;
    throw adhocError('ADH_SESSION_NOT_FOUND', 'No active ad hoc session exists.', "Run 'singularity-flow land' to inspect existing work or 'singularity-flow adhoc start'.");
  }
  const record = readRecord('adhoc-active-session', await readFile(target, 'utf8')).record;
  if (!record.sessionId) {
    if (!required) return null;
    throw adhocError('ADH_SESSION_NOT_FOUND', 'No active ad hoc session exists.', "Run 'singularity-flow land' to inspect existing work or 'singularity-flow adhoc start'.");
  }
  return safeId(record.sessionId);
}

export async function resolveSessionId(root, requested = null) {
  return requested ? safeId(requested) : readActiveSessionId(root);
}

export async function listSessions(root) {
  const directory = adhocRoot(root);
  if (!await exists(directory)) return [];
  const names = await readdir(directory, { withFileTypes: true });
  const records = [];
  for (const entry of names.filter((candidate) => candidate.isDirectory() && candidate.name.startsWith('AHS-'))) {
    const record = await readSessionRecord(root, entry.name, 'session', { required: false }).catch(() => null);
    if (record) records.push(record);
  }
  return records.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export async function rawOperationalRecord(root, sessionId, name) {
  const descriptor = FILES[name];
  return descriptor ? readJson(path.join(adhocSessionDirectory(root, sessionId), descriptor[1])) : null;
}
