import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';

function rootFor(root, name) {
  return path.join(path.resolve(root, gitCommonDir(root)), 'singularity-flow', 'fos', name);
}
function fail(message, code) { throw new SingularityFlowError(message, { code }); }
function without(record, field) {
  const result = { ...record };
  delete result[field];
  return result;
}

export async function retainFosReusableDefault(root, record) {
  const parsed = readRecord('fos-reusable-default', record).record;
  if (parsed.authoritative !== false || parsed.grantsAuthority !== false
      || parsed.defaultSha256 !== `sha256:${recordSha256(without(parsed, 'defaultSha256'))}`) {
    fail('Reusable default record failed integrity or authority checks.', 'FOS_DEFAULT_INVALID');
  }
  const directory = rootFor(root, 'defaults');
  const target = path.join(directory, `${parsed.defaultSha256.slice(7)}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(parsed, null, 2)}\n`;
  const existing = await readFile(target, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing != null && existing !== bytes) fail('Reusable default content address collision.', 'FOS_DEFAULT_INVALID');
  if (existing == null) await writeAtomic(target, bytes, { mode: 0o600 });
  return Object.freeze({ status: existing == null ? 'retained' : 'already-retained', path: target, record: Object.freeze(parsed) });
}

export async function enqueueFosApprovalRequest(root, request) {
  const parsed = readRecord('fos-approval-request', request).record;
  if (parsed.grantsAuthority !== false
      || parsed.requestSha256 !== `sha256:${recordSha256(without(parsed, 'requestSha256'))}`) {
    fail('Approval request failed integrity or authority checks.', 'FOS_APPROVAL_REQUEST_INVALID');
  }
  const directory = rootFor(root, 'approval-outbox');
  const target = path.join(directory, `${parsed.requestSha256.slice(7)}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const envelope = { request: parsed, delivery: { status: 'pending', attempts: 0, lastErrorCode: null } };
  const existing = await readFile(target, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing == null) await writeAtomic(target, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  return Object.freeze({ status: existing == null ? 'queued' : 'already-queued', path: target, request: Object.freeze(parsed) });
}

export async function deliverFosApprovalOutbox(root, deliver) {
  if (typeof deliver !== 'function') fail('Approval delivery requires a configured provider adapter.', 'TRUST_REQUIRED');
  const directory = rootFor(root, 'approval-outbox');
  const names = (await readdir(directory).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  const outcomes = [];
  for (const name of names) {
    const target = path.join(directory, name);
    const envelope = JSON.parse(await readFile(target, 'utf8'));
    const request = readRecord('fos-approval-request', envelope.request).record;
    if (envelope.delivery?.status === 'delivered') {
      outcomes.push({ requestId: request.requestId, status: 'already-delivered' });
      continue;
    }
    let result;
    try { result = await deliver(request); }
    catch (error) { result = { delivered: false, code: error?.code ?? 'DELIVERY_FAILED' }; }
    const delivery = {
      status: result?.delivered === true ? 'delivered' : 'pending',
      attempts: Number(envelope.delivery?.attempts ?? 0) + 1,
      lastErrorCode: result?.delivered === true ? null : String(result?.code ?? 'DELIVERY_FAILED'),
      // Provider message IDs are delivery receipts only and can never act as approval handles.
      providerMessageId: result?.delivered === true ? String(result.messageId ?? '') || null : null,
      grantsAuthority: false
    };
    await writeAtomic(target, `${JSON.stringify({ request, delivery }, null, 2)}\n`, { mode: 0o600 });
    outcomes.push({ requestId: request.requestId, status: delivery.status, attempts: delivery.attempts });
  }
  return Object.freeze(outcomes);
}
