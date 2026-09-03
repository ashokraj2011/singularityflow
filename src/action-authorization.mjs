import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { gitDir, identity } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { SingularityFlowError, nowIso, writeAtomic } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

const AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function authorizationDirectory(root) {
  return path.join(gitDir(root), 'singularity-flow', 'action-authorizations');
}

function authorizationPath(root, token) {
  if (!TOKEN_PATTERN.test(String(token ?? ''))) throw new SingularityFlowError('Enter a valid one-time action authorization token.');
  return path.join(authorizationDirectory(root), `${token}.json`);
}

function authorizationStorageFailure(action) {
  return new SingularityFlowError(
    `Action authorization storage could not ${action}. Review and authorize a fresh action.`,
    { code: 'ACTION_AUTHORIZATION_STORAGE_UNAVAILABLE' }
  );
}

function validate(record, token) {
  record = readRecord('action-authorization', record).record;
  if (record?.kind !== 'governed-action-authorization') {
    throw new SingularityFlowError('The action authorization has an unsupported schema.');
  }
  if (record.token !== token) throw new SingularityFlowError('The action authorization does not match its filename.');
  const created = Date.parse(record.createdAt ?? '');
  const expires = Date.parse(record.expiresAt ?? '');
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created
    || expires - created > AUTHORIZATION_TTL_MS) {
    throw new SingularityFlowError('The action authorization has invalid timestamps.');
  }
  if (expires <= Date.now()) throw new SingularityFlowError('The action authorization expired; review the action again.');
  const expectedQuestionId = recordSha256({ planId: record.planId, actionId: record.actionId, channel: record.channel }).slice(0, 24);
  const expectedAnswerReceipt = recordSha256({ token, authorizationId: record.authorizationId, planHash: record.planHash, actionId: record.actionId });
  if (record.questionId !== expectedQuestionId || record.answerReceipt !== expectedAnswerReceipt || !record.authorizationId) {
    throw new SingularityFlowError('The action authorization failed its question and answer-receipt binding.');
  }
  return record;
}

function actorKey(actor) {
  return String(actor?.email ?? actor?.login ?? actor?.name ?? '').trim().toLowerCase();
}

export async function issueActionAuthorization(root, plan, action, {
  confirmation,
  channel = 'terminal'
} = {}) {
  if (!action.confirmation?.required) return null;
  if (confirmation !== action.actionId) {
    throw new SingularityFlowError(`Type the exact action ID '${action.actionId}' after reviewing plan '${plan.planId}'.`);
  }
  const createdAt = nowIso();
  const token = randomUUID();
  const authorizationId = randomUUID();
  const questionId = recordSha256({ planId: plan.planId, actionId: action.actionId, channel }).slice(0, 24);
  const record = {
    schemaVersion: currentSchemaVersion('action-authorization'),
    kind: 'governed-action-authorization',
    token,
    authorizationId,
    questionId,
    answerReceipt: recordSha256({ token, authorizationId, planHash: plan.planHash, actionId: action.actionId }),
    planId: plan.planId,
    planHash: plan.planHash,
    actionId: action.actionId,
    subject: plan.subject,
    revision: plan.revision,
    actor: identity(root),
    channel,
    assurance: 'configured-local-review',
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + AUTHORIZATION_TTL_MS).toISOString()
  };
  try {
    await mkdir(authorizationDirectory(root), { recursive: true, mode: 0o700 });
    await writeAtomic(authorizationPath(root, token), canonicalJson(record), { mode: 0o600 });
  } catch {
    throw authorizationStorageFailure('write the local authorization');
  }
  return record;
}

export async function consumeActionAuthorization(root, token, plan, action) {
  if (!action.confirmation?.required) return null;
  const source = authorizationPath(root, token);
  const claimed = `${source}.consuming-${process.pid}-${randomUUID()}`;
  try {
    await rename(source, claimed);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new SingularityFlowError('The action authorization was not found or was already consumed.');
    }
    throw authorizationStorageFailure('claim the local authorization');
  }
  try {
    let record;
    try { record = JSON.parse(await readFile(claimed, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) throw new SingularityFlowError('The action authorization is invalid JSON.');
      throw authorizationStorageFailure('read the local authorization');
    }
    record = validate(record, token);
    if (record.planId !== plan.planId || record.planHash !== plan.planHash || record.actionId !== action.actionId) {
      throw new SingularityFlowError('The action authorization is not bound to this exact plan and action.');
    }
    if (!actorKey(record.actor) || actorKey(record.actor) !== actorKey(identity(root))) {
      throw new SingularityFlowError('The action authorization belongs to a different local Git identity.');
    }
    return record;
  } finally {
    // Claiming is the consumption boundary. A failed action requires a fresh human review rather
    // than silently reusing consent that may no longer describe the next attempt.
    try { await rm(claimed, { force: true }); }
    catch { throw authorizationStorageFailure('remove the consumed local authorization'); }
  }
}
