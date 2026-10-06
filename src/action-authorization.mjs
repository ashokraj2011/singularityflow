import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { isatty } from 'node:tty';
import { gitDir, identity } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { SingularityFlowError, nowIso, writeAtomic } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

const AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// This is a live presentation witness, not a durable authorization ledger. Files and public
// issuer calls cannot manufacture it. It is deliberately unavailable across process boundaries.
const terminalPresentations = new Map();

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

/**
 * Direct-terminal confirmation. No caller-supplied answer, stream or receipt can stand in for the
 * named action on the exact card. This is terminal-local review, not authenticated Copilot consent.
 */
export async function captureTerminalActionAuthorization(root, plan, action, { label = 'Confirm action' } = {}) {
  if (stdin.isTTY !== true || stdout.isTTY !== true || stderr.isTTY !== true
      || !isatty(stdin.fd) || !isatty(stdout.fd) || !isatty(stderr.fd)) {
    throw new SingularityFlowError('This action requires direct terminal review of its exact current plan.',
      { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  }
  if (!action.confirmation?.required || typeof label !== 'string' || !label.trim()
      || label.length > 128 || /[\0\r\n\x1b]/u.test(label)) {
    throw new SingularityFlowError('The terminal confirmation card is invalid.',
      { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  }
  const reviewedPlan = structuredClone(plan);
  const reviewedAction = structuredClone(action);
  const beforeActor = actorKey(identity(root));
  // Live human review must not enter the --json stdout buffer: the handler awaits an answer,
  // while that buffer flushes only after it returns. stderr remains a real, visible terminal.
  stderr.write(`${JSON.stringify({ plan: reviewedPlan, action: reviewedAction }, null, 2)}\n`);
  const terminal = readline.createInterface({ input: stdin, output: stderr });
  let confirmed = false;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = (await terminal.question(`Type ${label} to confirm this exact action, or Enter to cancel: `)).trim();
      if (!answer) break;
      if (answer === label) { confirmed = true; break; }
      stderr.write(`Confirmation did not match. Type exactly: ${label}.\n`);
    }
  }
  finally { terminal.close(); }
  if (!confirmed) return null;
  if (!beforeActor || beforeActor !== actorKey(identity(root))) {
    throw new SingularityFlowError('Local identity changed during terminal review; review the action again.',
      { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  }
  const record = await issueActionAuthorization(root, reviewedPlan, reviewedAction,
    { confirmation: reviewedAction.actionId, channel: 'terminal' });
  terminalPresentations.set(record.token, {
    root: path.resolve(root), planHash: record.planHash, actionId: record.actionId,
    subject: canonicalJson(reviewedPlan.subject), revision: reviewedPlan.revision,
    cardSha256: recordSha256({ plan: reviewedPlan, action: reviewedAction }),
    actor: beforeActor, expiresAt: Date.parse(record.expiresAt)
  });
  return record;
}

export async function consumeActionAuthorization(root, token, plan, action, {
  requireTerminalPresentation = false
} = {}) {
  if (!action.confirmation?.required) return null;
  if (requireTerminalPresentation) {
    const presented = terminalPresentations.get(token);
    // Every attempted use consumes the live witness, including stale/changed-plan attempts.
    terminalPresentations.delete(token);
    if (!presented || presented.root !== path.resolve(root)
        || presented.planHash !== plan.planHash || presented.actionId !== action.actionId
        || presented.subject !== canonicalJson(plan.subject) || presented.revision !== plan.revision
        || presented.cardSha256 !== recordSha256({ plan, action })
        || presented.actor !== actorKey(identity(root)) || presented.expiresAt <= Date.now()) {
      throw new SingularityFlowError('A live direct-terminal presentation is required; a local receipt is not human consent.',
        { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
    }
  }
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
