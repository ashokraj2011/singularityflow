import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  atomicJson, listWorkspaceDocuments, readWorkspace, stageWorkspaceDocuments,
  workspaceRepositoryPath
} from './workspace.mjs';
import { nowIso, run, SingularityFlowError } from './util.mjs';
import { invokeModel } from './model-runner.mjs';

export const WORKSPACE_IMPACT_SCHEMA_VERSION = 1;
const MAX_COPILOT_OUTPUT_BYTES = 8 * 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function portableId(value, label) {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new SingularityFlowError(`${label} must be a portable identifier.`);
  }
  return id;
}

function impactId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `impact-${stamp}-${randomUUID().slice(0, 8)}`;
}

function impactRoot(workspace) {
  return path.join(workspace.path, workspace.directories.copilotCache, 'impact');
}

function impactDirectory(workspace, id) {
  return path.join(impactRoot(workspace), portableId(id, 'Impact analysis ID'));
}

async function regularFile(file) {
  const info = await lstat(file).catch(() => null);
  return info?.isFile() && !info.isSymbolicLink();
}

function repositorySnapshot(workspace, id) {
  const repository = workspace.repositories[id];
  if (!repository) throw new SingularityFlowError(`Workspace repository '${id}' is not configured.`);
  const root = workspaceRepositoryPath(workspace, repository);
  const git = run('git', ['rev-parse', '--show-toplevel'], { cwd: root, allowFailure: true });
  if (git.status !== 0 || path.resolve(git.stdout.trim()) !== path.resolve(root)) {
    throw new SingularityFlowError(`Workspace repository '${id}' is not a ready Git checkout: ${root}`);
  }
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new SingularityFlowError(`Repository '${id}' has no full HEAD commit.`);
  const branch = run('git', ['branch', '--show-current'], { cwd: root, allowFailure: true }).stdout.trim() || null;
  const dirty = run('git', ['status', '--porcelain'], { cwd: root, allowFailure: true }).stdout.trim().length > 0;
  const manifest = run('git', ['show', `${commit}:singularity/world-model/manifest.json`], {
    cwd: root, allowFailure: true
  });
  return {
    id,
    role: repository.role,
    sourcePath: root,
    sandboxPath: `repos/${id}`,
    branch,
    commit,
    dirty,
    worldModel: manifest.status === 0
      ? { present: true, sha256: sha256(manifest.stdout) }
      : { present: false, sha256: null }
  };
}

function selectedIds(available, requested, label) {
  const chosen = requested?.length ? [...new Set(requested.map(String))] : available;
  for (const id of chosen) {
    if (!available.includes(id)) throw new SingularityFlowError(`Unknown workspace ${label} '${id}'.`);
  }
  return chosen;
}

function requestPrompt(record) {
  const repositories = record.repositories.map((repository) => [
    `- ${repository.id}: ${repository.sandboxPath}`,
    `  - revision: ${repository.commit}`,
    `  - configured branch: ${repository.branch ?? 'detached'}`,
    `  - world model: ${repository.worldModel.present ? `present (${repository.worldModel.sha256})` : 'missing'}`
  ].join('\n')).join('\n');
  const documents = record.documents.length
    ? record.documents.map((document) => `- documents/${document.name} (${document.sha256}, ${document.bytes} bytes)`).join('\n')
    : '- none';
  return `# Singularity Flow workspace impact analysis\n\n`
    + `You are performing an advisory, read-only impact analysis. There is no Work ID and no lifecycle branch.\n`
    + `Do not create, edit, delete, commit, checkout, push, or publish anything. Inspect only the detached repository copies and documents listed below.\n`
    + `Distinguish observed evidence from inference. Cite repository-relative paths and symbols for every concrete claim.\n\n`
    + `## Request\n\nTitle: ${record.title}\n\n${record.description}\n\n`
    + `## Workspace\n\n- ID: ${record.workspace.id}\n- Name: ${record.workspace.name}\n`
    + `- Capabilities: ${record.capabilities.length ? record.capabilities.join(', ') : 'not mapped'}\n\n`
    + `## Repository snapshots\n\n${repositories}\n\n`
    + `## Staged reference documents\n\n${documents}\n\n`
    + `## Required report\n\nReturn concise Markdown with exactly these headings:\n\n`
    + `# Impact summary\n## Executive summary\n## Affected capabilities and repositories\n`
    + `## Affected components, files, APIs, schemas, and contracts\n## Dependencies and delivery order\n`
    + `## Security, data, operations, migration, and testing impact\n## Clarifying questions and unknowns\n`
    + `## Suggested work type and Story breakdown\n## Confidence and evidence limitations\n\n`
    + `Do not claim that this advisory report is approved, governed, or implementation-ready.\n`;
}

async function buildRecord(workspacePath, options = {}) {
  const workspace = await readWorkspace(workspacePath);
  const description = String(options.description ?? '').trim();
  if (!description) throw new SingularityFlowError('Workspace impact analysis requires a description.');
  const repositoryIds = selectedIds(Object.keys(workspace.repositories), options.repositories, 'repository');
  const capabilities = selectedIds(workspace.capabilities ?? [], options.capabilities, 'capability');
  const allDocuments = await listWorkspaceDocuments(workspace.path);
  const requestedDocuments = options.documents?.length ? new Set(options.documents.map(String)) : null;
  const documents = requestedDocuments
    ? allDocuments.filter((document) => requestedDocuments.has(document.path) || requestedDocuments.has(document.name))
    : allDocuments;
  if (requestedDocuments && documents.length !== requestedDocuments.size) {
    const found = new Set(documents.flatMap((document) => [document.path, document.name]));
    const missing = [...requestedDocuments].filter((document) => !found.has(document));
    throw new SingularityFlowError(`Unknown staged workspace document${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);
  }
  const id = options.id ? portableId(options.id, 'Impact analysis ID') : impactId();
  const record = {
    schemaVersion: WORKSPACE_IMPACT_SCHEMA_VERSION,
    id,
    status: 'prepared',
    advisory: true,
    title: String(options.title ?? 'Workspace change impact').trim() || 'Workspace change impact',
    description,
    workspace: { id: workspace.id, name: workspace.name, path: workspace.path },
    capabilities,
    repositories: repositoryIds.map((repositoryId) => repositorySnapshot(workspace, repositoryId)),
    documents,
    createdAt: nowIso(),
    completedAt: null,
    model: options.model ? { provider: 'github-copilot', name: String(options.model) } : null,
    tokenUsage: { status: 'unavailable' },
    prompt: { path: 'prompt.md', sha256: null },
    result: null,
    warnings: []
  };
  record.warnings = [
    ...record.repositories.filter((repository) => repository.dirty)
      .map((repository) => `${repository.id} has uncommitted changes; this analysis uses committed HEAD ${repository.commit.slice(0, 12)} only.`),
    ...record.repositories.filter((repository) => !repository.worldModel.present)
      .map((repository) => `${repository.id} has no committed repository world model at this revision.`)
  ];
  const prompt = requestPrompt(record);
  record.prompt.sha256 = sha256(prompt);
  return { workspace, record, prompt };
}

async function materializeSandbox(workspace, record) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-impact-'));
  await mkdir(path.join(root, 'repos'), { recursive: true });
  await mkdir(path.join(root, 'documents'), { recursive: true });
  try {
    for (const repository of record.repositories) {
      const target = path.join(root, repository.sandboxPath);
      const clone = run('git', ['clone', '--no-local', '--no-checkout', repository.sourcePath, target], { allowFailure: true });
      if (clone.status !== 0) throw new SingularityFlowError(`Could not create detached analysis copy for '${repository.id}': ${clone.stderr.trim() || clone.stdout.trim()}`);
      const checkout = run('git', ['checkout', '--detach', repository.commit], { cwd: target, allowFailure: true });
      if (checkout.status !== 0) throw new SingularityFlowError(`Could not check out ${repository.id}@${repository.commit.slice(0, 12)} in the analysis sandbox.`);
      // The analysis copy is self-contained. Removing origin prevents a model/tool invocation from
      // following the clone metadata back to the contributor's real working tree.
      run('git', ['remote', 'remove', 'origin'], { cwd: target, allowFailure: true });
    }
    for (const document of record.documents) {
      const source = path.join(workspace.path, document.path);
      if (!(await regularFile(source))) throw new SingularityFlowError(`Workspace document changed or disappeared: ${document.path}`);
      const content = await readFile(source);
      if (sha256(content) !== document.sha256) throw new SingularityFlowError(`Workspace document changed after impact preparation: ${document.path}`);
      await copyFile(source, path.join(root, 'documents', document.name));
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function defaultCopilotRunner({ cwd, prompt, model = null, provider = 'copilot-cli', providerConfig = null }) {
  return invokeModel({
    provider, providerConfig, model, cwd,
    allowedRoots: [cwd],
    prompt: { text: prompt },
    channel: 'workspace-impact-analysis',
    subject: { kind: 'workspace-impact' },
    tools: { mode: 'all' },
    limits: { timeoutMs: 15 * 60 * 1000, outputBytes: MAX_COPILOT_OUTPUT_BYTES }
  });
}

export async function previewWorkspaceImpact(workspacePath, options = {}) {
  const { record, prompt } = await buildRecord(workspacePath, options);
  return { ...record, prompt: { ...record.prompt, content: prompt } };
}

export async function analyzeWorkspaceImpact(workspacePath, options = {}, { runner = defaultCopilotRunner } = {}) {
  const { workspace, record, prompt } = await buildRecord(workspacePath, options);
  const directory = impactDirectory(workspace, record.id);
  if (await stat(directory).catch(() => null)) throw new SingularityFlowError(`Workspace impact analysis '${record.id}' already exists.`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'prompt.md'), prompt, 'utf8');
  await atomicJson(path.join(directory, 'report.json'), record);
  let sandbox = null;
  try {
    sandbox = await materializeSandbox(workspace, record);
    process.stderr.write(`Workspace impact ${record.id}: Copilot is analyzing ${record.repositories.length} detached repository snapshot${record.repositories.length === 1 ? '' : 's'}.\n`);
    const result = await runner({
      cwd: sandbox,
      prompt,
      // Threaded rather than left to the runner's defaults. `defaultCopilotRunner` declares
      // `provider`/`providerConfig` parameters that no caller supplied, so a repository configured
      // to use a specific executable and arguments got bare `copilot` from PATH here alone.
      provider: options.provider ?? 'copilot-cli',
      providerConfig: options.providerConfig ?? null,
      model: options.model ?? options.providerConfig?.model ?? null
    });
    const summary = String(result?.output ?? '').trim();
    if (!summary) throw new SingularityFlowError('GitHub Copilot returned an empty impact analysis.');
    const summaryFile = `${summary}\n`;
    await writeFile(path.join(directory, 'summary.md'), summaryFile, 'utf8');
    record.status = 'complete';
    record.completedAt = nowIso();
    record.result = {
      path: 'summary.md',
      sha256: sha256(summaryFile),
      bytes: Buffer.byteLength(summaryFile),
      summaryMarkdown: summary
    };
    await atomicJson(path.join(directory, 'report.json'), record);
    return await workspaceImpactStatus(workspace.path, record.id);
  } catch (error) {
    record.status = 'failed';
    record.completedAt = nowIso();
    record.failure = error.message;
    await atomicJson(path.join(directory, 'report.json'), record);
    throw error;
  } finally {
    if (sandbox) await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}

export async function readWorkspaceImpact(workspacePath, id) {
  const workspace = await readWorkspace(workspacePath);
  const directory = impactDirectory(workspace, id);
  let report;
  try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new SingularityFlowError(`Workspace impact analysis '${id}' does not exist.`);
    throw new SingularityFlowError(`Unable to read workspace impact analysis '${id}': ${error.message}`);
  }
  if (report.schemaVersion !== WORKSPACE_IMPACT_SCHEMA_VERSION || report.id !== id) {
    throw new SingularityFlowError(`Workspace impact analysis '${id}' has an unsupported record.`);
  }
  return report;
}

export async function workspaceImpactStatus(workspacePath, id) {
  const workspace = await readWorkspace(workspacePath);
  const report = await readWorkspaceImpact(workspace.path, id);
  const directory = impactDirectory(workspace, id);
  const changes = [];
  for (const recorded of report.repositories ?? []) {
    const configured = workspace.repositories[recorded.id];
    if (!configured) {
      changes.push({ repository: recorded.id, reason: 'repository is no longer configured' });
      continue;
    }
    const root = workspaceRepositoryPath(workspace, configured);
    const current = run('git', ['rev-parse', 'HEAD'], { cwd: root, allowFailure: true }).stdout.trim();
    if (current !== recorded.commit) {
      changes.push({ repository: recorded.id, reason: 'HEAD changed', recorded: recorded.commit, current: current || null });
    }
  }
  for (const artifact of [report.prompt, report.result].filter((entry) => entry?.path && entry?.sha256)) {
    const file = path.join(directory, artifact.path);
    if (!(await regularFile(file))) {
      changes.push({ repository: 'analysis', reason: `${artifact.path} is missing` });
      continue;
    }
    const current = sha256(await readFile(file));
    if (current !== artifact.sha256) {
      changes.push({ repository: 'analysis', reason: `${artifact.path} changed`, recorded: artifact.sha256, current });
    }
  }
  return { ...report, freshness: changes.length ? 'stale' : 'current', changes };
}

export async function listWorkspaceImpacts(workspacePath) {
  const workspace = await readWorkspace(workspacePath);
  const root = impactRoot(workspace);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try { reports.push(await workspaceImpactStatus(workspace.path, entry.name)); }
    catch { /* An incomplete foreign directory is not a workspace impact record. */ }
  }
  return reports.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export async function promoteWorkspaceImpact(workspacePath, id) {
  const workspace = await readWorkspace(workspacePath);
  const report = await workspaceImpactStatus(workspace.path, id);
  if (report.status !== 'complete' || !report.result?.path) {
    throw new SingularityFlowError(`Workspace impact analysis '${id}' is not complete.`);
  }
  if (report.freshness !== 'current') {
    throw new SingularityFlowError(`Workspace impact analysis '${id}' is stale; run it again before using it as governed intake context.`);
  }
  if (report.promotedDocument) {
    const promoted = path.join(workspace.path, report.promotedDocument.path);
    if (await regularFile(promoted)) {
      const current = sha256(await readFile(promoted));
      if (current === report.promotedDocument.sha256) {
        return {
          analysisId: id,
          workspaceId: workspace.id,
          document: report.promotedDocument,
          alreadyPromoted: true,
          next: 'Start governed work and select this staged report as an intake source. No Work ID or branch was created automatically.'
        };
      }
    }
    throw new SingularityFlowError(`The staged intake copy for workspace impact analysis '${id}' changed or disappeared. Review it before promoting again.`);
  }
  const source = path.join(impactDirectory(workspace, id), report.result.path);
  const staged = await stageWorkspaceDocuments(workspace.path, [source]);
  report.promotedAt = nowIso();
  report.promotedDocument = staged.added[0] ?? null;
  await atomicJson(path.join(impactDirectory(workspace, id), 'report.json'), report);
  return {
    analysisId: id,
    workspaceId: workspace.id,
    document: staged.added[0],
    next: 'Start governed work and select this staged report as an intake source. No Work ID or branch was created automatically.'
  };
}
