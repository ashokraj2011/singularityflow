import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { activeWorkspaceFile, workspaceContextForRepository, workspaceRegistryFile } from './workspace-context.mjs';
import { gitDir } from './git.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';

export const PROMPT_AUDIT_SCHEMA_VERSION = 1;
const DIRECTORY = 'prompt-audit';
const SETTINGS = 'settings.json';
const LOG = 'prompts.jsonl';

// Prompt capture is deliberately narrower than diagnostic logging. It preserves the governed
// prompt a reviewer needs to audit, while removing common bearer-token shapes before bytes touch
// disk. The record says when this happened so it is never represented as a byte-exact transcript.
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
];

export function scrubPrompt(value) {
  let prompt = String(value ?? '');
  let redactions = 0;
  for (const pattern of SECRET_PATTERNS) {
    prompt = prompt.replace(pattern, () => { redactions += 1; return '[redacted-secret]'; });
  }
  return { prompt, redactions };
}

async function location(root) {
  const workspace = await workspaceContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile()
  ).catch(() => null);
  const directory = workspace
    ? path.join(workspace.workspacePath, '.singularity-flow', DIRECTORY)
    : path.join(gitDir(root), 'singularity-flow', DIRECTORY);
  return {
    scope: workspace ? 'workspace' : 'repository',
    workspaceId: workspace?.workspaceId ?? null,
    workspaceName: workspace?.workspaceName ?? null,
    workspacePath: workspace?.workspacePath ?? null,
    repositoryPath: path.resolve(root),
    directory,
    settingsFile: path.join(directory, SETTINGS),
    logFile: path.join(directory, LOG)
  };
}

async function settings(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return { enabled: value?.enabled === true, updatedAt: value?.updatedAt ?? null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { enabled: false, updatedAt: null };
    throw new SingularityFlowError(`Prompt-audit settings are invalid: ${error.message}`);
  }
}

async function entries(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new SingularityFlowError(`Prompt-audit log contains invalid JSON on line ${index + 1}.`); }
  });
}

export async function promptAuditStatus(root) {
  const target = await location(root);
  const config = await settings(target.settingsFile);
  const records = await entries(target.logFile);
  return {
    schemaVersion: PROMPT_AUDIT_SCHEMA_VERSION,
    enabled: config.enabled,
    updatedAt: config.updatedAt,
    count: records.length,
    latestAt: records.at(-1)?.recordedAt ?? null,
    ...target
  };
}

export async function setPromptAudit(root, enabled) {
  const target = await location(root);
  await mkdir(target.directory, { recursive: true });
  const value = {
    schemaVersion: PROMPT_AUDIT_SCHEMA_VERSION,
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString()
  };
  await writeAtomic(target.settingsFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return promptAuditStatus(root);
}

export async function recordPromptAudit(root, input) {
  const status = await promptAuditStatus(root);
  if (!status.enabled) return null;
  const scrubbed = scrubPrompt(input.prompt);
  const recordedAt = new Date().toISOString();
  const promptSha256 = createHash('sha256').update(scrubbed.prompt).digest('hex');
  const record = {
    schemaVersion: PROMPT_AUDIT_SCHEMA_VERSION,
    id: `${recordedAt.replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`,
    recordedAt,
    workspaceId: status.workspaceId,
    workspaceName: status.workspaceName,
    repositoryPath: status.repositoryPath,
    workId: input.workId ?? null,
    workType: input.workType ?? null,
    phase: input.phase,
    generation: input.generation ?? null,
    agent: input.agent,
    task: input.task ?? null,
    source: input.source ?? 'wm-compose',
    promptSha256,
    bytes: Buffer.byteLength(scrubbed.prompt),
    redactions: scrubbed.redactions,
    prompt: scrubbed.prompt
  };
  await mkdir(status.directory, { recursive: true });
  await appendFile(status.logFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export async function listPromptAudits(root, filters = {}) {
  const status = await promptAuditStatus(root);
  const limit = Math.max(1, Math.min(Number(filters.limit ?? 100), 1000));
  let records = await entries(status.logFile);
  for (const key of ['agent', 'phase', 'workId']) {
    if (filters[key]) records = records.filter((record) => record[key] === filters[key]);
  }
  records = records.slice(-limit).reverse();
  if (!filters.includePrompt) records = records.map(({ prompt: _prompt, ...record }) => record);
  return { ...status, records };
}

export async function readPromptAudit(root, id = 'latest') {
  const status = await promptAuditStatus(root);
  const records = await entries(status.logFile);
  const record = id === 'latest' ? records.at(-1) : records.find((entry) => entry.id === id);
  if (!record) throw new SingularityFlowError(id === 'latest' ? 'No governed prompts have been captured.' : `Prompt-audit record '${id}' was not found.`);
  return { status, record };
}
