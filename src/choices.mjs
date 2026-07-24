import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gitDir, head } from './git.mjs';
import { loadCopilotSession } from './session.mjs';
import { SingularityFlowError, nowIso, writeAtomic } from './util.mjs';

const RECEIPT_TTL_MS = 15 * 60 * 1000;
const RECEIPT_LOCK_TIMEOUT_MS = 5 * 1000;
const RECEIPT_LOCK_STALE_MS = 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function receiptDirectory(root) {
  return path.join(gitDir(root), 'singularity-flow', 'choices');
}

function receiptPath(root, token) {
  if (!TOKEN_PATTERN.test(String(token ?? ''))) throw new SingularityFlowError('Invalid selection receipt token.');
  return path.join(receiptDirectory(root), `${token}.json`);
}

function options(entries) {
  return entries.map(([id, item]) => ({ id, label: item.label ?? id, description: item.description ?? '' }));
}

function approvalContext(workflow) {
  const phase = workflow?.currentPhase ? workflow.phases?.[workflow.currentPhase] : null;
  if (!phase || phase.status !== 'awaiting_approval') {
    throw new SingularityFlowError(`Work item '${workflow?.workItem?.id ?? 'unknown'}' has no phase awaiting approval.`);
  }
  return {
    phase: phase.id,
    label: phase.label,
    generation: phase.generation,
    submittedAt: phase.submittedAt ?? null,
    artifacts: (phase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null }))
  };
}

function choiceSets(definition, action, workflow = null) {
  if (action === 'start') return [
    {
      id: 'intake-source',
      label: 'Intake source',
      options: [
        { id: 'jira', label: 'Jira story', description: 'Retrieve the work item and configured fields from Jira.' },
        { id: 'manual', label: 'Manual description and documents', description: 'Use supplied story details, local files, and URLs.' }
      ]
    },
    { id: 'workflow-template', label: 'Workflow template', options: options(Object.entries(definition.workTypes ?? {})) },
    { id: 'persona', label: 'Persona', options: options(Object.entries(definition.personas ?? {})) }
  ];
  if (action === 'approve') {
    const context = approvalContext(workflow);
    const phase = workflow.phases[context.phase];
    const allowed = new Set(phase.approvalPolicy?.personas ?? []);
    const personas = Object.entries(definition.personas ?? {}).filter(([id, persona]) =>
      allowed.has(id) && (persona.mayApprove ?? []).includes(phase.id));
    if (!personas.length) throw new SingularityFlowError(`No configured persona can approve phase '${phase.id}'.`);
    return [
      { id: 'persona', label: 'Approval persona', options: options(personas) },
      {
        id: 'phase-confirmation',
        label: 'Exact phase confirmation',
        options: [{ id: phase.id, label: `Approve ${phase.label}`, description: `The reviewer must explicitly type '${phase.id}' to approve generation ${phase.generation}.` }]
      }
    ];
  }
  throw new SingularityFlowError(`Selection receipts do not support action '${action}'. Use start or approve.`);
}

async function writeReceipt(root, receipt) {
  const directory = receiptDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = receiptPath(root, receipt.token);
  await writeAtomic(target, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
  return receipt;
}

function validateReceipt(receipt, token) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new SingularityFlowError(`Selection receipt '${token}' is not an object.`);
  }
  if (receipt.schemaVersion !== 1) {
    throw new SingularityFlowError(`Selection receipt '${token}' uses unsupported version ${receipt.schemaVersion}; expected version 1.`);
  }
  if (receipt.token !== token) throw new SingularityFlowError(`Selection receipt '${token}' token does not match its filename.`);
  if (typeof receipt.action !== 'string' || !receipt.action.trim()) throw new SingularityFlowError(`Selection receipt '${token}' has no action.`);
  if (typeof receipt.workId !== 'string' || !receipt.workId.trim()) throw new SingularityFlowError(`Selection receipt '${token}' has no work ID.`);
  if (typeof receipt.repositoryHead !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(receipt.repositoryHead)) {
    throw new SingularityFlowError(`Selection receipt '${token}' has an invalid repository HEAD.`);
  }
  if (!Array.isArray(receipt.choiceSets)) throw new SingularityFlowError(`Selection receipt '${token}' has invalid choices.`);
  if (!receipt.answers || typeof receipt.answers !== 'object' || Array.isArray(receipt.answers)) {
    throw new SingularityFlowError(`Selection receipt '${token}' has invalid answers.`);
  }
  if (typeof receipt.ready !== 'boolean') throw new SingularityFlowError(`Selection receipt '${token}' has an invalid readiness state.`);
  const createdAt = Date.parse(receipt.createdAt ?? '');
  const expiresAt = Date.parse(receipt.expiresAt ?? '');
  if (!Number.isFinite(createdAt)) throw new SingularityFlowError(`Selection receipt '${token}' creation timestamp is invalid.`);
  if (!Number.isFinite(expiresAt) || expiresAt <= createdAt || expiresAt - createdAt > RECEIPT_TTL_MS) {
    throw new SingularityFlowError(`Selection receipt '${token}' expiry timestamp is invalid.`);
  }
  return receipt;
}

async function readReceipt(root, token) {
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptPath(root, token), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new SingularityFlowError(`Selection receipt '${token}' was not found or was already consumed.`);
    if (error instanceof SyntaxError) throw new SingularityFlowError(`Selection receipt '${token}' is invalid JSON.`);
    throw error;
  }
  return validateReceipt(receipt, token);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withReceiptMutation(root, token, operation) {
  const target = receiptPath(root, token);
  const directory = path.dirname(target);
  const lock = `${target}.lock`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + RECEIPT_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await lstat(lock).catch((readError) => {
        if (readError?.code === 'ENOENT') return null;
        throw readError;
      });
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new SingularityFlowError(`Selection receipt '${token}' has an unsafe mutation lock.`);
      }
      if (Date.now() - info.mtimeMs > RECEIPT_LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new SingularityFlowError(`Selection receipt '${token}' is busy in another process. Retry the action.`);
      }
      await wait(20);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
}

async function assertActive(root, receipt) {
  if (Date.parse(receipt.expiresAt) <= Date.now()) throw new SingularityFlowError(`Selection receipt '${receipt.token}' expired. Ask the contributor to make the choices again.`);
  const copilot = await loadCopilotSession(root);
  if (receipt.copilotSessionId && copilot?.sessionId !== receipt.copilotSessionId) {
    throw new SingularityFlowError(`Selection receipt '${receipt.token}' belongs to a different Copilot session.`);
  }
}

async function removeExpired(root) {
  const directory = receiptDirectory(root);
  let files = [];
  try { files = await readdir(directory); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
    const token = file.slice(0, -'.json'.length);
    if (!TOKEN_PATTERN.test(token)) return;
    try {
      await withReceiptMutation(root, token, async () => {
        const receipt = await readReceipt(root, token);
        if (Date.parse(receipt.expiresAt) <= Date.now()) await unlink(receiptPath(root, token));
      });
    } catch { /* Invalid local receipts remain unusable and are handled when explicitly referenced. */ }
  }));
}

export async function beginSelectionReceipt(root, definition, { action, workId, workflow = null }) {
  return beginCustomSelectionReceipt(root, {
    action,
    workId,
    context: action === 'approve' ? approvalContext(workflow) : null,
    choiceSets: choiceSets(definition, action, workflow)
  });
}

export async function beginCustomSelectionReceipt(root, { action, workId, choiceSets: configuredChoices, context = null }) {
  await removeExpired(root);
  const copilot = await loadCopilotSession(root);
  const createdAt = new Date();
  const receipt = {
    schemaVersion: 1,
    token: randomUUID(),
    action,
    workId,
    repositoryHead: head(root),
    copilotSessionId: copilot?.sessionId ?? null,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + RECEIPT_TTL_MS).toISOString(),
    ...(context ? { actionContext: context, ...(action === 'approve' ? { approvalContext: context } : {}) } : {}),
    choiceSets: configuredChoices,
    answers: {},
    ready: false
  };
  return writeReceipt(root, receipt);
}

export async function answerSelectionReceipt(root, token, choiceId, selectedId) {
  return withReceiptMutation(root, token, async () => {
    const receipt = await readReceipt(root, token);
    await assertActive(root, receipt);
    const choices = receipt.choiceSets.find((item) => item.id === choiceId);
    if (!choices) throw new SingularityFlowError(`Selection receipt '${token}' has no choice '${choiceId}'.`);
    if (!Array.isArray(choices.options) || !choices.options.some((item) => item.id === selectedId)) {
      const allowed = Array.isArray(choices.options) ? choices.options.map((item) => item.id).join(', ') : 'none';
      throw new SingularityFlowError(`Unknown ${String(choices.label ?? choiceId).toLowerCase()} '${selectedId}'. Allowed: ${allowed}.`);
    }
    receipt.answers[choiceId] = { id: selectedId, answeredAt: nowIso() };
    receipt.ready = receipt.choiceSets.every((item) => receipt.answers[item.id]?.id);
    return writeReceipt(root, receipt);
  });
}

export async function selectionReceiptStatus(root, token) {
  const receipt = await readReceipt(root, token);
  await assertActive(root, receipt);
  return receipt;
}

export async function resolveSelectionReceipt(root, definition, token, { action, workId, workflow = null }) {
  return resolveCustomSelectionReceipt(root, token, {
    action,
    workId,
    context: action === 'approve' ? approvalContext(workflow) : null,
    choiceSets: choiceSets(definition, action, workflow)
  });
}

export async function resolveCustomSelectionReceipt(root, token, { action, workId, choiceSets: current, context = null }) {
  const receipt = await readReceipt(root, token);
  await assertActive(root, receipt);
  if (receipt.action !== action || receipt.workId !== workId) {
    throw new SingularityFlowError(`Selection receipt '${token}' is for ${receipt.action} ${receipt.workId}, not ${action} ${workId}.`);
  }
  if (receipt.repositoryHead !== head(root)) {
    throw new SingularityFlowError(`Selection receipt '${token}' is stale because the repository HEAD changed. Ask the contributor to review the choices again.`);
  }
  if (JSON.stringify(receipt.actionContext ?? receipt.approvalContext ?? null) !== JSON.stringify(context ?? null)) {
    throw new SingularityFlowError(`Selection receipt '${token}' is stale because the action context changed.`);
  }
  const answers = {};
  for (const choices of current) {
    const selected = receipt.answers?.[choices.id]?.id;
    if (!selected) throw new SingularityFlowError(`Selection receipt '${token}' is incomplete: ${choices.label} has not been answered.`);
    if (!choices.options.some((item) => item.id === selected)) throw new SingularityFlowError(`Selection receipt '${token}' is stale: ${choices.label} '${selected}' is no longer configured.`);
    answers[choices.id] = selected;
  }
  return { ...receipt, answers };
}

export async function consumeSelectionReceipt(root, token) {
  return withReceiptMutation(root, token, async () => {
    try {
      await unlink(receiptPath(root, token));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new SingularityFlowError(`Selection receipt '${token}' was not found or was already consumed.`);
      throw error;
    }
  });
}
