/** Machine-local opaque expansion handles bound to exact governed and source state. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir, head } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { loadConfig, loadStoryAggregate } from './state-stores.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';

const HANDLE = /^ctx_([a-f0-9]{32})_([a-f0-9]{32})$/;

function localRoot(root) { return path.join(gitCommonDir(root), 'singularity-flow', 'evidence-packets'); }
function secretFile(root) { return path.join(localRoot(root), 'handle-secret'); }
function handleFile(root, id) { return path.join(localRoot(root), 'handles', `${id}.json`); }

async function handleSecret(root) {
  const file = secretFile(root);
  try {
    const value = await readFile(file, 'utf8');
    if (/^[A-Za-z0-9_-]{40,}$/.test(value.trim())) return value.trim();
    throw new SingularityFlowError('Evidence Packet handle secret is malformed.', { code: 'EPC_EXPANSION_INVALID' });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const secret = randomBytes(32).toString('base64url');
  await mkdir(path.dirname(file), { recursive: true });
  let descriptor;
  try {
    descriptor = await open(file, 'wx', 0o600);
    await descriptor.writeFile(`${secret}\n`, 'utf8');
    await descriptor.close();
    descriptor = null;
    await chmod(file, 0o600);
    return secret;
  } catch (error) {
    await descriptor?.close().catch(() => {});
    if (error?.code !== 'EEXIST') throw error;
    const winner = (await readFile(file, 'utf8')).trim();
    if (/^[A-Za-z0-9_-]{40,}$/.test(winner)) return winner;
    throw new SingularityFlowError('Evidence Packet handle secret is malformed.', { code: 'EPC_EXPANSION_INVALID' });
  }
}

function signature(secret, identity) {
  return createHmac('sha256', secret).update(identity).digest('hex').slice(0, 32);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function issueContextExpansionHandle(root, {
  packetId,
  workId = null,
  flightPlanId = null,
  sourceRevision,
  lifecycleRevision = null,
  itemId,
  expansionKind,
  maximumOutputBytes,
  source = null
}) {
  const record = {
    schemaVersion: currentSchemaVersion('context-expansion-handle'),
    packetId, workId, flightPlanId, sourceRevision, lifecycleRevision,
    itemId, expansionKind, maximumOutputBytes,
    source: source == null ? null : structuredClone(source),
    boundary: 'source-and-lifecycle-revision'
  };
  const identity = recordSha256(record);
  const secret = await handleSecret(root);
  const id = `ctx_${identity.slice(0, 32)}_${signature(secret, identity)}`;
  await writeAtomic(handleFile(root, id), `${JSON.stringify({ ...record, handleId: id }, null, 2)}\n`, { mode: 0o600 });
  return id;
}

export async function readContextExpansionHandle(root, handle, { revalidate = true } = {}) {
  const match = HANDLE.exec(String(handle ?? ''));
  if (!match) throw new SingularityFlowError('Context expansion handle is malformed.', { code: 'EPC_EXPANSION_INVALID' });
  let record;
  try {
    record = readRecord('context-expansion-handle', await readFile(handleFile(root, handle))).record;
  } catch (error) {
    if (error?.code === 'ENOENT' || /Required file not found/.test(error?.message ?? '')) {
      throw new SingularityFlowError('Context expansion handle is unknown or no longer retained.', { code: 'EPC_EXPANSION_INVALID' });
    }
    throw error;
  }
  const { handleId: _handleId, ...unsigned } = record;
  const identity = recordSha256(unsigned);
  const secret = await handleSecret(root);
  if (match[1] !== identity.slice(0, 32) || !safeEqual(match[2], signature(secret, identity))) {
    throw new SingularityFlowError('Context expansion handle does not match its sealed record.', { code: 'EPC_EXPANSION_INVALID' });
  }
  if (!revalidate) return record;
  if (head(root) !== record.sourceRevision) {
    throw new SingularityFlowError('Context expansion is stale because the source revision changed.', {
      code: 'EPC_EXPANSION_STALE', details: { nextAction: 'Request a refreshed context packet.' }
    });
  }
  if (record.workId) {
    let workflow;
    try {
      workflow = await loadStoryAggregate(root, await loadConfig(root), record.workId);
    } catch {
      throw new SingularityFlowError('Context expansion is not authorized for visible governed work.', {
        code: 'EPC_EXPANSION_UNAUTHORIZED', details: { nextAction: 'Attach the governed work item and request context again.' }
      });
    }
    if (record.lifecycleRevision && recordSha256(workflow) !== record.lifecycleRevision) {
      throw new SingularityFlowError('Context expansion is stale because governed work changed.', {
        code: 'EPC_EXPANSION_STALE', details: { nextAction: 'Request a refreshed context packet.' }
      });
    }
    if (record.flightPlanId && workflow.changeFlightPlan?.planId !== record.flightPlanId) {
      throw new SingularityFlowError('Context expansion belongs to a different accepted Flight Plan.', {
        code: 'EPC_EXPANSION_UNAUTHORIZED', details: { nextAction: 'Request context for the currently accepted Flight Plan.' }
      });
    }
  }
  return record;
}
