import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitDir, head } from './git.mjs';
import { loadCopilotSession } from './session.mjs';
import { SingularityFlowError, nowIso } from './util.mjs';

const RECEIPT_TTL_MS = 15 * 60 * 1000;
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

function choiceSets(definition, action) {
  if (action !== 'start') throw new SingularityFlowError(`Selection receipts do not support action '${action}'. Use start.`);
  return [
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
}

async function writeReceipt(root, receipt) {
  const directory = receiptDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = receiptPath(root, receipt.token);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  return receipt;
}

async function readReceipt(root, token) {
  try { return JSON.parse(await readFile(receiptPath(root, token), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new SingularityFlowError(`Selection receipt '${token}' was not found or was already consumed.`);
    if (error instanceof SyntaxError) throw new SingularityFlowError(`Selection receipt '${token}' is invalid JSON.`);
    throw error;
  }
}

async function assertActive(root, receipt) {
  if (Date.parse(receipt.expiresAt ?? '') <= Date.now()) throw new SingularityFlowError(`Selection receipt '${receipt.token}' expired. Ask the contributor to make the choices again.`);
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
    try {
      const receipt = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
      if (Date.parse(receipt.expiresAt ?? '') <= Date.now()) await unlink(path.join(directory, file));
    } catch { /* Invalid local receipts remain unusable and are handled when explicitly referenced. */ }
  }));
}

export async function beginSelectionReceipt(root, definition, { action, workId }) {
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
    choiceSets: choiceSets(definition, action),
    answers: {},
    ready: false
  };
  return writeReceipt(root, receipt);
}

export async function answerSelectionReceipt(root, token, choiceId, selectedId) {
  const receipt = await readReceipt(root, token);
  await assertActive(root, receipt);
  const choices = receipt.choiceSets.find((item) => item.id === choiceId);
  if (!choices) throw new SingularityFlowError(`Selection receipt '${token}' has no choice '${choiceId}'.`);
  if (!choices.options.some((item) => item.id === selectedId)) {
    throw new SingularityFlowError(`Unknown ${choices.label.toLowerCase()} '${selectedId}'. Allowed: ${choices.options.map((item) => item.id).join(', ')}.`);
  }
  receipt.answers[choiceId] = { id: selectedId, answeredAt: nowIso() };
  receipt.ready = receipt.choiceSets.every((item) => receipt.answers[item.id]?.id);
  return writeReceipt(root, receipt);
}

export async function selectionReceiptStatus(root, token) {
  const receipt = await readReceipt(root, token);
  await assertActive(root, receipt);
  return receipt;
}

export async function resolveSelectionReceipt(root, definition, token, { action, workId }) {
  const receipt = await readReceipt(root, token);
  await assertActive(root, receipt);
  if (receipt.action !== action || receipt.workId !== workId) {
    throw new SingularityFlowError(`Selection receipt '${token}' is for ${receipt.action} ${receipt.workId}, not ${action} ${workId}.`);
  }
  if (receipt.repositoryHead !== head(root)) {
    throw new SingularityFlowError(`Selection receipt '${token}' is stale because the repository HEAD changed. Ask the contributor to review the choices again.`);
  }
  const current = choiceSets(definition, action);
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
  await unlink(receiptPath(root, token));
}
