import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  SingularityFlowError, exists, invariant, nowIso, posix, readJson, repoRelative,
  run, snapshot, truncate, writeJson, writeText
} from './util.mjs';
import { add, branch, changedFiles, commit, head, identity, pushBranch, remoteContains } from './git.mjs';
import {
  WORKFLOW_PATH, loadDefinition, renderArtifactTemplate, resolveWorkType, snapshotResolution
} from './config.mjs';
import { loadSession } from './session.mjs';

export const CONFIG_PATH = WORKFLOW_PATH;
export const loadConfig = loadDefinition;

export function validateId(config, id) {
  if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) throw new SingularityFlowError('Work ID must be one safe identifier without slashes.');
  if (!(new RegExp(config.idPattern ?? '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')).test(id)) throw new SingularityFlowError(`Work ID ${id} does not match ${config.idPattern}.`);
}

export function workDir(root, config, id) { return path.join(root, config.workItemRoot ?? '.singularity/work-items', id); }
export function workDirRelative(config, id) { return posix(path.join(config.workItemRoot ?? '.singularity/work-items', id)); }
export function workflowPath(root, config, id) { return path.join(workDir(root, config, id), 'workflow.json'); }
export function statusPath(root, config, id) { return path.join(workDir(root, config, id), 'STATUS.md'); }
export function sourcePath(root, config, id) { return path.join(workDir(root, config, id), 'source.json'); }
export function userStoryPath(root, config, id) { return path.join(workDir(root, config, id), 'USER-STORY.md'); }
export function approvalPath(root, config, id, phase) { return path.join(workDir(root, config, id), 'approvals', `${phase}.json`); }
export function decisionDir(root, config, id, phase) { return path.join(workDir(root, config, id), 'approvals', phase); }
export function pendingPublicationPath(root, config, id) { return path.join(workDir(root, config, id), 'publication-pending.json'); }

function actorKey(actor) { return actor.login ?? actor.email ?? actor.name; }

function sourceMarkdown(source) {
  const details = [
    `- Source: ${source.type}`, source.url ? `- URL: ${source.url}` : null,
    source.status ? `- Status: ${source.status}` : null,
    source.priority ? `- Priority: ${source.priority}` : null,
    source.storyPoints != null ? `- Story points: ${source.storyPoints}` : null,
    source.assignee ? `- Assignee: ${source.assignee}` : null
  ].filter(Boolean).join('\n');
  const subtasks = source.subtasks?.length ? source.subtasks.map((item) => `- ${item.key}${item.status ? ` [${item.status}]` : ''}${item.title ? ` — ${item.title}` : ''}`).join('\n') : '_None._';
  return `# ${source.key ?? source.id} — ${source.title}\n\n${details}\n\n## Description\n\n${source.description || '_No description provided._'}\n\n## Acceptance criteria\n\n${source.acceptanceCriteria || '_Not provided._'}\n\n## Subtasks\n\n${subtasks}\n`;
}

function phaseState(definition, index) {
  const requiredArtifact = structuredClone(definition.artifact);
  return {
    id: definition.id,
    label: definition.label,
    order: index,
    owner: definition.suggestedPersonas?.[0] ?? null,
    suggestedPersonas: [...(definition.suggestedPersonas ?? [])],
    status: index === 0 ? 'in_progress' : 'not_started',
    requiredArtifact,
    template: definition.template,
    worldModel: structuredClone(definition.worldModel ?? {}),
    writeScope: definition.writeScope ?? 'artifact-only',
    comparison: structuredClone(definition.comparison ?? {}),
    approvalPolicy: structuredClone(definition.approval ?? { personas: [], minimum: 0, rejectTo: [definition.id] }),
    qualityCommands: [...(definition.qualityCommands ?? [])],
    startedAt: index === 0 ? nowIso() : null,
    submittedAt: null,
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    generation: 0,
    generatedBy: null,
    generatedPersona: null,
    usage: [],
    approvals: [],
    artifacts: [],
    checks: []
  };
}

function managedMetadata(workflow, phase) {
  return {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    phase: phase.id,
    generation: phase.generation,
    status: phase.status,
    generatedBy: phase.generatedBy,
    generatedPersona: phase.generatedPersona,
    sourceCommit: phase.sourceCommit ?? null,
    generationCommit: phase.generationCommit ?? null,
    publicationCommit: phase.publicationCommit ?? null,
    configSha256: workflow.resolution.configSha256,
    sourceSha256: workflow.resolution.sourceSha256 ?? null,
    template: workflow.resolution.templates[phase.id],
    usage: phase.usage,
    approvals: phase.approvals,
    selfApproval: phase.approvals.some((approval) => approval.selfApproval && !approval.invalidatedAt),
    conformanceTree: phase.conformanceTree ?? null
  };
}

function metadataBlock(metadata) {
  return `<!-- singularity-flow:metadata\n${JSON.stringify(metadata, null, 2)}\n-->`;
}

async function updateArtifactMetadata(root, config, workflow, phase) {
  const file = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path);
  if (!(await exists(file))) return;
  const text = await readFile(file, 'utf8');
  const block = metadataBlock(managedMetadata(workflow, phase));
  const pattern = /<!-- singularity-flow:metadata\n[\s\S]*?\n-->/;
  await writeText(file, pattern.test(text) ? text.replace(pattern, block) : `${block}\n\n${text}`);
}

function statusMarkdown(workflow) {
  const lines = [
    `# ${workflow.workItem.id} — ${workflow.workItem.title}`, '',
    `- Branch: \`${workflow.workItem.branch}\``,
    `- Work type: **${workflow.workItem.workType}**`,
    `- Overall status: **${workflow.status}**`,
    `- Current phase: **${workflow.currentPhase ?? 'complete'}**`, '',
    '| # | Phase | Suggested personas | Status | Generation | Approvals | Tokens |',
    '|---:|---|---|---|---:|---:|---:|'
  ];
  for (const id of workflow.phaseOrder) {
    const phase = workflow.phases[id];
    const approvals = phase.approvals.filter((item) => !item.invalidatedAt).length;
    const tokens = phase.usage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0);
    lines.push(`| ${phase.order + 1} | ${phase.label} (\`${id}\`) | ${phase.suggestedPersonas.join(', ')} | **${phase.status}** | ${phase.generation} | ${approvals} | ${tokens || 'unavailable'} |`);
    for (const approval of phase.approvals.filter((item) => !item.invalidatedAt && item.selfApproval)) lines.push(`|  | ⚠ self-approval | ${approval.persona} / ${approval.actor.name} | **warning** |  |  |  |`);
  }
  lines.push('', '## Recent history', '');
  workflow.history.slice(-15).reverse().forEach((item) => lines.push(`- ${item.at} — **${item.event}**${item.phase ? ` (${item.phase})` : ''} by ${item.actor ?? 'unknown'}${item.persona ? ` as ${item.persona}` : ''}${item.detail ? `: ${item.detail}` : ''}`));
  return `${lines.join('\n')}\n`;
}

export async function saveWorkflow(root, config, workflow) {
  await writeJson(workflowPath(root, config, workflow.workItem.id), workflow);
  await writeText(statusPath(root, config, workflow.workItem.id), statusMarkdown(workflow));
}

export async function createWorkflow(root, config, { id, title, source, baseBranch, workType, persona, resolved } = {}) {
  validateId(config, id);
  if (branch(root) !== id) throw new SingularityFlowError(`Current branch ${branch(root)} must exactly match work ID ${id}.`);
  if (await exists(workflowPath(root, config, id))) throw new SingularityFlowError(`${id} already exists. Use singularity-flow resume ${id}.`);
  const selectedType = workType ?? Object.keys(config.workTypes)[0];
  const resolution = resolved ?? resolveWorkType(config, selectedType);
  const snapshotState = config._legacy ? { configSha256: null, templates: Object.fromEntries(resolution.phases.map((phase) => [phase.id, { path: phase.template, sha256: null }])) } : await snapshotResolution(root, config, resolution);
  const actor = identity(root);
  const phases = resolution.phases.map(phaseState);
  const createdAt = nowIso();
  const workflow = {
    schemaVersion: 2,
    workItem: { id, title: title || id, workType: selectedType, workTypeLabel: resolution.label, branch: branch(root), baseBranch, createdAt, createdBy: actor, source: { type: source.type, key: source.key ?? null, url: source.url ?? null } },
    resolution: {
      ...snapshotState,
      workType: selectedType,
      workTypeLabel: resolution.label,
      sourceSha256: createHash('sha256').update(`${JSON.stringify(source, null, 2)}\n`).digest('hex'),
      phases: resolution.phases
    },
    status: 'in_progress',
    currentPhase: phases[0]?.id ?? null,
    phaseOrder: phases.map((phase) => phase.id),
    phases: Object.fromEntries(phases.map((phase) => [phase.id, phase])),
    usage: {
      mode: config.tokens?.mode ?? 'exact-or-unavailable', totalTokens: 0, records: 0,
      exactRecords: 0, unavailableRecords: 0, byPhase: {}, byPersona: {}, byWorkType: {}, byWorkItem: {}
    },
    history: [{ at: createdAt, actor: actorKey(actor), persona: persona ?? null, event: 'work_started', phase: phases[0]?.id ?? null, detail: `Created ${selectedType} branch ${branch(root)}` }]
  };
  await writeJson(sourcePath(root, config, id), source);
  if (source.type === 'jira') await writeText(userStoryPath(root, config, id), sourceMarkdown(source));
  await writeText(path.join(workDir(root, config, id), 'README.md'), `# ${id} — ${workflow.workItem.title}\n\nDurable ${selectedType} workflow state for branch \`${id}\`.\n\n- [workflow.json](./workflow.json) — machine state\n- [STATUS.md](./STATUS.md) — human status\n- [source.json](./source.json) — source context\n${source.type === 'jira' ? '- [USER-STORY.md](./USER-STORY.md) — Jira snapshot\n' : ''}- [artifacts/](./artifacts/) — generated phase artifacts\n- [approvals/](./approvals/) — append-only decisions\n`);
  await saveWorkflow(root, config, workflow);
  await preparePhase(root, config, workflow, phases[0]?.id);
  await saveWorkflow(root, config, workflow);
  return workflow;
}

function upgradeWorkflow(workflow) {
  if (workflow.schemaVersion === 2) return workflow;
  workflow.schemaVersion = 2;
  workflow.workItem.workType ??= 'legacy';
  workflow.resolution ??= { configSha256: null, templates: {}, phases: [] };
  workflow.resolution.workType ??= workflow.workItem.workType;
  workflow.resolution.workTypeLabel ??= workflow.workItem.workTypeLabel ?? 'Legacy workflow';
  workflow.usage ??= { mode: 'exact-or-unavailable', totalTokens: 0, records: 0 };
  workflow.usage.exactRecords ??= 0; workflow.usage.unavailableRecords ??= 0;
  workflow.usage.byPhase ??= {}; workflow.usage.byPersona ??= {}; workflow.usage.byWorkType ??= {}; workflow.usage.byWorkItem ??= {};
  for (const id of workflow.phaseOrder) {
    const phase = workflow.phases[id];
    phase.suggestedPersonas ??= phase.owner ? [phase.owner] : [];
    phase.approvalPolicy ??= { personas: phase.owner ? [phase.owner] : [], minimum: 1, rejectTo: [id] };
    phase.writeScope ??= 'source-and-artifact'; phase.comparison ??= {};
    phase.generation ??= phase.artifacts?.length ? 1 : 0;
    phase.usage ??= [];
    phase.approvals ??= phase.approvedBy ? [{ actor: { name: phase.approvedBy }, persona: phase.owner, at: phase.approvedAt, selfApproval: false, channel: 'legacy' }] : [];
  }
  return workflow;
}

export async function loadWorkflow(root, config, id = undefined) {
  const resolved = id ?? branch(root);
  const file = workflowPath(root, config, resolved);
  if (!(await exists(file))) throw new SingularityFlowError(`No workflow found for ${resolved}. Expected ${posix(path.relative(root, file))}.`);
  const workflow = upgradeWorkflow(await readJson(file));
  invariant(workflow.workItem?.id === resolved, `Workflow ID does not match ${resolved}.`);
  return workflow;
}

export function currentPhase(workflow) {
  if (!workflow.currentPhase) return null;
  const phase = workflow.phases[workflow.currentPhase];
  invariant(phase, `Unknown current phase ${workflow.currentPhase}.`);
  return phase;
}

function assertCurrent(workflow, requested) {
  const phase = currentPhase(workflow);
  if (!phase) throw new SingularityFlowError(`${workflow.workItem.id} is complete.`);
  if (requested && requested !== phase.id) throw new SingularityFlowError(`Current phase is ${phase.id}, not ${requested}.`);
  return phase;
}

function requiredRepoPath(config, workflow, phase) { return `${workDirRelative(config, workflow.workItem.id)}/${phase.requiredArtifact.path}`; }

export async function preparePhase(root, config, workflow, requested = undefined) {
  const phase = assertCurrent(workflow, requested);
  const target = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path);
  if (!(await exists(target))) {
    let text;
    if (config._legacy) text = `# ${workflow.workItem.id} — ${phase.label}\n\nTODO: Complete the ${phase.label} artifact.\n`;
    else text = await renderArtifactTemplate(root, config, workflow.resolution.phases.find((item) => item.id === phase.id), { id: workflow.workItem.id, title: workflow.workItem.title, workType: workflow.workItem.workType });
    await writeText(target, `${metadataBlock(managedMetadata(workflow, phase))}\n\n${text}`);
  }
  return posix(path.relative(root, target));
}

const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx', '.kt', '.kts', '.mjs', '.php', '.py', '.rb', '.rs', '.scala', '.scss', '.sql', '.swift', '.ts', '.tsx', '.vue']);
export function inferKind(relativePath) {
  const value = relativePath.toLowerCase();
  if (value.includes('/implementation-spec')) return 'implementation-spec';
  if (value.includes('/spec-code-comparison')) return 'conformance-report';
  if (/(^|\/)(test|tests|spec|specs)(\/|$)/.test(value) || /\.(test|spec)\.[^.]+$/.test(value)) return 'test';
  if (SOURCE_EXTENSIONS.has(path.extname(value))) return 'code';
  if (/\.(md|mdx|txt|adoc|rst)$/.test(value)) return 'document';
  if (/\.(json|ya?ml|toml|ini|properties)$/.test(value)) return 'configuration';
  return 'file';
}

function artifactFor(phase, relativePath) { return phase.artifacts.find((item) => item.path === relativePath); }
function canModify(phase) { if (phase.status !== 'in_progress') throw new SingularityFlowError(`Phase ${phase.id} is ${phase.status}; it cannot accept artifact changes.`); }

export async function registerArtifact(root, workflow, candidate, { phaseId, kind } = {}) {
  const phase = assertCurrent(workflow, phaseId); canModify(phase);
  const absolute = path.resolve(root, candidate); const relativePath = repoRelative(root, absolute);
  const info = await snapshot(absolute); const existing = artifactFor(phase, relativePath); const timestamp = nowIso();
  const record = { path: relativePath, kind: kind ?? inferKind(relativePath), status: 'pending', exists: info.exists, size: info.size, sha256: info.sha256, registeredAt: existing?.registeredAt ?? timestamp, updatedAt: timestamp };
  if (existing) Object.assign(existing, record); else phase.artifacts.push(record);
  phase.artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return record;
}

function ignored(config, workflow, relativePath) {
  if ([WORKFLOW_PATH, '.singularity/config.json', '.singularity/worldmodel.json'].includes(relativePath)) return true;
  if (relativePath.startsWith('.singularity/world-model/')) return true;
  if (['.git/', 'node_modules/', '.idea/', '.vscode/'].some((prefix) => relativePath.startsWith(prefix))) return true;
  const itemRoot = workDirRelative(config, workflow.workItem.id);
  return relativePath.startsWith(`${itemRoot}/`) && !relativePath.startsWith(`${itemRoot}/artifacts/`);
}

export async function scanArtifacts(root, config, workflow, phaseId = undefined) {
  const phase = assertCurrent(workflow, phaseId); canModify(phase); const records = [];
  for (const file of changedFiles(root).filter((item) => !ignored(config, workflow, item))) records.push(await registerArtifact(root, workflow, file, { phaseId: phase.id }));
  return records;
}

const PLACEHOLDER = /\b(?:TODO|TBD)\b|\{\{[^}]+\}\}|\[\s*(?:describe|add|insert|provide|record)[^\]]*\]/i;
async function validatePhase(root, config, workflow, phase, { placeholders = true } = {}) {
  const errors = []; const required = requiredRepoPath(config, workflow, phase); const absolute = path.join(root, required);
  if (!(await exists(absolute))) errors.push(`Required artifact missing: ${required}`);
  else {
    const text = await readFile(absolute, 'utf8'); const bytes = Buffer.byteLength(text);
    if (bytes < (phase.requiredArtifact.minimumBytes ?? 1)) errors.push(`Required artifact ${required} is too short (${bytes} bytes).`);
    if (placeholders && PLACEHOLDER.test(text.replace(/<!-- singularity-flow:metadata[\s\S]*?-->/, ''))) errors.push(`Required artifact ${required} contains TODO/TBD/template placeholders.`);
    if (!artifactFor(phase, required)) errors.push(`Required artifact is not registered to ${phase.id}: ${required}`);
  }
  for (const artifact of phase.artifacts) {
    const current = await snapshot(path.join(root, artifact.path));
    if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) errors.push(`Artifact changed after registration: ${artifact.path}. Run singularity-flow artifact scan.`);
  }
  return errors;
}

function normalizeUsage(raw, session) {
  const startedAt = raw?.startedAt ?? nowIso(); const completedAt = raw?.completedAt ?? nowIso();
  const numeric = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens'];
  const exact = raw && numeric.some((key) => Number.isFinite(raw[key]));
  const usage = { status: exact ? 'exact' : 'unavailable', source: raw?.source ?? (exact ? 'provider' : 'copilot-unavailable'), provider: raw?.provider ?? null, model: raw?.model ?? null, inputTokens: raw?.inputTokens ?? null, outputTokens: raw?.outputTokens ?? null, cachedInputTokens: raw?.cachedInputTokens ?? null, totalTokens: raw?.totalTokens ?? (exact ? (raw.inputTokens ?? 0) + (raw.outputTokens ?? 0) : null), startedAt, completedAt, persona: session.persona };
  return usage;
}

function addUsageAggregate(workflow, phase, usage) {
  const increment = (collection, key) => {
    const aggregate = collection[key] ??= { records: 0, exactRecords: 0, unavailableRecords: 0, totalTokens: 0 };
    aggregate.records += 1;
    aggregate[usage.status === 'exact' ? 'exactRecords' : 'unavailableRecords'] += 1;
    aggregate.totalTokens += usage.totalTokens ?? 0;
  };
  workflow.usage.records += 1;
  workflow.usage[usage.status === 'exact' ? 'exactRecords' : 'unavailableRecords'] += 1;
  workflow.usage.totalTokens += usage.totalTokens ?? 0;
  increment(workflow.usage.byPhase, phase.id);
  increment(workflow.usage.byPersona, usage.persona);
  increment(workflow.usage.byWorkType, workflow.workItem.workType);
  increment(workflow.usage.byWorkItem, workflow.workItem.id);
}

function generationCommit(root, workflow, phase, number = phase.generation) {
  const subject = `[${workflow.workItem.id}][phase:${phase.id}][generated:${number}]`;
  const result = run('git', ['log', '--format=%H%x09%s', '--fixed-strings', '--grep', subject], { cwd: root, allowFailure: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t')).find(([, message]) => message.startsWith(subject))?.[0] ?? null;
}

export async function sourceTreeHash(root) {
  const tracked = run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean);
  const files = [...new Set([...tracked, ...changedFiles(root)])].filter((file) => !file.startsWith('.singularity/') && !file.startsWith('.git/') && !file.startsWith('node_modules/')).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    if (!existsSync(path.join(root, file))) continue;
    hash.update(file).update('\0').update(await readFile(path.join(root, file))).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function publishGeneration(root, config, workflow, { phaseId, usage: rawUsage } = {}) {
  if (await exists(pendingPublicationPath(root, config, workflow.workItem.id))) throw new SingularityFlowError('Publication is pending; run singularity-flow sync before continuing.');
  const phase = assertCurrent(workflow, phaseId); canModify(phase); const session = await loadSession(root);
  const changed = changedFiles(root);
  const protectedChange = (config.governance?.protectedPaths ?? []).find((protectedPath) => changed.some((file) => file === protectedPath || file.startsWith(`${protectedPath}/`)));
  if (protectedChange) throw new SingularityFlowError(`Generation cannot modify protected process path: ${protectedChange}`);
  if ((phase.writeScope ?? 'artifact-only') === 'artifact-only') {
    const allowed = `${workDirRelative(config, workflow.workItem.id)}/artifacts/${phase.id}/`;
    const outside = changed.filter((file) => !ignored(config, workflow, file) && !file.startsWith(allowed));
    if (outside.length) throw new SingularityFlowError(`Phase ${phase.id} is artifact-only; move these changes to implementation/verification: ${outside.join(', ')}`);
  }
  phase.generation += 1; phase.generatedBy = session.actor; phase.generatedPersona = session.persona; phase.sourceCommit = head(root);
  if (phase.id === 'conformance') phase.conformanceTree = await sourceTreeHash(root);
  phase.usage.push(normalizeUsage(rawUsage, session));
  await updateArtifactMetadata(root, config, workflow, phase);
  await scanArtifacts(root, config, workflow, phase.id);
  const errors = await validatePhase(root, config, workflow, phase);
  if (errors.length) throw new SingularityFlowError(`Phase ${phase.id} generation is not publishable:\n- ${errors.join('\n- ')}`);
  addUsageAggregate(workflow, phase, phase.usage.at(-1));
  workflow.history.push({ at: nowIso(), actor: actorKey(session.actor), persona: session.persona, event: 'phase_generated', phase: phase.id, detail: `generation ${phase.generation}` });
  await saveWorkflow(root, config, workflow); return phase;
}

async function qualityChecks(root, phase) {
  const checks = [];
  for (const command of phase.qualityCommands ?? []) {
    const startedAt = nowIso(); const result = run(command, [], { cwd: root, shell: true, allowFailure: true });
    checks.push({ command, startedAt, completedAt: nowIso(), status: result.status === 0 ? 'passed' : 'failed', exitCode: result.status, stdout: truncate(result.stdout), stderr: truncate(result.stderr) });
  }
  return checks;
}

export async function submitPhase(root, config, workflow, { phaseId, runChecks = true } = {}) {
  if (await exists(pendingPublicationPath(root, config, workflow.workItem.id))) throw new SingularityFlowError('Publication is pending; run singularity-flow sync before continuing.');
  const phase = assertCurrent(workflow, phaseId); canModify(phase); const session = await loadSession(root);
  if (phase.generation < 1) throw new SingularityFlowError(`Phase ${phase.id} has no published generation.`);
  phase.generationCommit = generationCommit(root, workflow, phase);
  if (!phase.generationCommit) throw new SingularityFlowError(`Generation commit is missing for ${phase.id} generation ${phase.generation}.`);
  phase.publicationCommit = config.git?.publish === 'off' || remoteContains(root, phase.generationCommit, config.git?.remote ?? 'origin', workflow.workItem.branch) ? phase.generationCommit : null;
  if (config.git?.publish === 'required' && !phase.publicationCommit) throw new SingularityFlowError(`Generation commit ${phase.generationCommit.slice(0, 8)} is not published; run singularity-flow sync.`);
  phase.checks = runChecks ? await qualityChecks(root, phase) : [];
  const errors = await validatePhase(root, config, workflow, phase); const failed = phase.checks.filter((check) => check.status !== 'passed');
  if (failed.length) errors.push(`Quality command failed: ${failed.map((check) => check.command).join(', ')}`);
  if (errors.length) throw new SingularityFlowError(`Phase ${phase.id} is not ready:\n- ${errors.join('\n- ')}`);
  phase.status = 'awaiting_approval'; phase.submittedAt = nowIso(); await updateArtifactMetadata(root, config, workflow, phase); await refreshRequiredArtifact(root, config, workflow, phase);
  workflow.history.push({ at: phase.submittedAt, actor: actorKey(session.actor), persona: session.persona, event: 'phase_submitted', phase: phase.id, detail: `${phase.artifacts.length} artifacts` });
  await saveWorkflow(root, config, workflow); return phase;
}

function nextPhase(workflow, phase) { const id = workflow.phaseOrder[workflow.phaseOrder.indexOf(phase.id) + 1]; return id ? workflow.phases[id] : null; }

async function writeDecision(root, config, workflow, phase, decision) {
  const safe = decision.at.replace(/[:.]/g, '-');
  await writeJson(path.join(decisionDir(root, config, workflow.workItem.id, phase.id), `${safe}-${decision.decision}.json`), decision);
  await writeJson(approvalPath(root, config, workflow.workItem.id, phase.id), { schemaVersion: 2, phase: phase.id, decisions: phase.approvals });
}

export async function approvePhase(root, config, workflow, { phaseId, channel = 'terminal' } = {}) {
  if (await exists(pendingPublicationPath(root, config, workflow.workItem.id))) throw new SingularityFlowError('Publication is pending; run singularity-flow sync before continuing.');
  const phase = assertCurrent(workflow, phaseId); if (phase.status !== 'awaiting_approval') throw new SingularityFlowError(`Phase ${phase.id} must be submitted before approval.`);
  const session = await loadSession(root); const allowed = phase.approvalPolicy.personas ?? [];
  if (!allowed.includes(session.persona) || !(config.personas[session.persona]?.mayApprove ?? []).includes(phase.id)) throw new SingularityFlowError(`Persona '${session.persona}' cannot approve phase '${phase.id}'. Choose one of: ${allowed.join(', ')}.`);
  const actor = session.actor; const key = actorKey(actor); const active = phase.approvals.filter((item) => !item.invalidatedAt && item.decision === 'approved');
  if (active.some((item) => actorKey(item.actor) === key)) throw new SingularityFlowError(`${key} already approved phase ${phase.id}; approvals require distinct identities.`);
  const decision = { decision: 'approved', phase: phase.id, at: nowIso(), actor, persona: session.persona, channel, generation: phase.generation, selfApproval: actorKey(phase.generatedBy ?? {}) === key };
  phase.approvals.push(decision); const reached = phase.approvals.filter((item) => !item.invalidatedAt && item.decision === 'approved').length >= (phase.approvalPolicy.minimum ?? 1);
  if (reached) {
    phase.status = 'approved'; phase.approvedAt = decision.at; phase.approvedBy = key;
    const upcoming = nextPhase(workflow, phase);
    if (upcoming) { upcoming.status = 'in_progress'; upcoming.startedAt = decision.at; workflow.currentPhase = upcoming.id; }
    else { workflow.currentPhase = null; workflow.status = 'complete'; }
  }
  await updateArtifactMetadata(root, config, workflow, phase); await registerApprovedSnapshot(root, config, workflow, phase);
  await writeDecision(root, config, workflow, phase, decision);
  workflow.history.push({ at: decision.at, actor: key, persona: session.persona, event: decision.selfApproval ? 'phase_self_approved' : 'phase_approved', phase: phase.id, detail: reached ? `threshold reached${workflow.currentPhase ? `; advanced to ${workflow.currentPhase}` : '; complete'}` : 'approval recorded' });
  await saveWorkflow(root, config, workflow); return { phase, next: reached ? currentPhase(workflow) : phase, approval: { approvedBy: key, ...decision }, reached };
}

async function registerApprovedSnapshot(root, config, workflow, phase) {
  const required = requiredRepoPath(config, workflow, phase); const current = await snapshot(path.join(root, required)); const existing = artifactFor(phase, required);
  if (existing) Object.assign(existing, { ...current, status: phase.status === 'approved' ? 'approved' : 'pending', approvedAt: phase.approvedAt, approvedBy: phase.approvedBy });
}

async function refreshRequiredArtifact(root, config, workflow, phase) {
  const required = requiredRepoPath(config, workflow, phase); const current = await snapshot(path.join(root, required)); const existing = artifactFor(phase, required);
  if (existing) Object.assign(existing, { ...current, updatedAt: nowIso() });
  else phase.artifacts.push({ path: required, kind: phase.requiredArtifact.kind ?? inferKind(required), status: 'pending', ...current, registeredAt: nowIso(), updatedAt: nowIso() });
}

export async function rejectPhase(root, config, workflow, { phaseId, target, reason, channel = 'terminal' } = {}) {
  if (await exists(pendingPublicationPath(root, config, workflow.workItem.id))) throw new SingularityFlowError('Publication is pending; run singularity-flow sync before continuing.');
  const phase = assertCurrent(workflow, phaseId); if (phase.status !== 'awaiting_approval') throw new SingularityFlowError(`Only an awaiting_approval phase can be rejected; current status is ${phase.status}.`);
  if (!reason?.trim()) throw new SingularityFlowError('A rejection reason is required.');
  const session = await loadSession(root); const allowedPersonas = phase.approvalPolicy.personas ?? [];
  if (!allowedPersonas.includes(session.persona) || !(config.personas[session.persona]?.mayApprove ?? []).includes(phase.id)) throw new SingularityFlowError(`Persona '${session.persona}' cannot reject phase '${phase.id}'.`);
  const targetId = target ?? phase.id; if (!(phase.approvalPolicy.rejectTo ?? [phase.id]).includes(targetId)) throw new SingularityFlowError(`Phase '${phase.id}' cannot be rejected to '${targetId}'. Allowed: ${(phase.approvalPolicy.rejectTo ?? []).join(', ')}.`);
  const targetIndex = workflow.phaseOrder.indexOf(targetId); if (targetIndex < 0 || targetIndex > workflow.phaseOrder.indexOf(phase.id)) throw new SingularityFlowError(`Invalid rejection target '${targetId}'.`);
  const timestamp = nowIso(); const key = actorKey(session.actor);
  for (let index = targetIndex; index < workflow.phaseOrder.length; index += 1) {
    const affected = workflow.phases[workflow.phaseOrder[index]];
    affected.approvals.forEach((approval) => { if (!approval.invalidatedAt) approval.invalidatedAt = timestamp; });
    affected.status = index === targetIndex ? 'in_progress' : 'not_started'; affected.submittedAt = null; affected.approvedAt = null; affected.approvedBy = null;
    if (index === targetIndex) { affected.rejectedAt = timestamp; affected.rejectedBy = key; affected.rejectionReason = reason.trim(); }
    await updateArtifactMetadata(root, config, workflow, affected);
  }
  workflow.currentPhase = targetId; workflow.status = 'in_progress';
  const decision = { decision: 'rejected', phase: phase.id, target: targetId, reason: reason.trim(), at: timestamp, actor: session.actor, persona: session.persona, channel };
  phase.approvals.push(decision); await writeDecision(root, config, workflow, phase, decision);
  workflow.history.push({ at: timestamp, actor: key, persona: session.persona, event: 'phase_rejected', phase: phase.id, detail: `returned to ${targetId}: ${reason.trim()}` });
  await saveWorkflow(root, config, workflow); return workflow.phases[targetId];
}

export async function commitAndPublish(root, config, workflow, message, extraPaths = []) {
  const pending = pendingPublicationPath(root, config, workflow.workItem.id);
  if (await exists(pending)) throw new SingularityFlowError('A previous publication is pending. Run: singularity-flow sync');
  add(root, [...new Set([workDirRelative(config, workflow.workItem.id), ...extraPaths])]);
  const sha = commit(root, message); const mode = config.git?.publish ?? 'required';
  if (mode === 'off') return { sha, pushed: false };
  const remote = config.git?.remote ?? 'origin'; const result = pushBranch(root, remote, workflow.workItem.branch);
  if (result.status !== 0) {
    await writeJson(pending, { schemaVersion: 1, workId: workflow.workItem.id, branch: workflow.workItem.branch, remote, commit: sha, createdAt: nowIso(), error: (result.stderr || result.stdout).trim() });
    throw new SingularityFlowError(`Commit ${sha.slice(0, 8)} was created but push failed. Run singularity-flow sync after fixing remote access.`);
  }
  return { sha, pushed: true };
}

export async function syncPublication(root, config, workflow) {
  const pending = pendingPublicationPath(root, config, workflow.workItem.id); const record = (await exists(pending)) ? await readJson(pending) : { remote: config.git?.remote ?? 'origin', branch: workflow.workItem.branch };
  const result = pushBranch(root, record.remote, record.branch); if (result.status !== 0) throw new SingularityFlowError(`Push still fails: ${(result.stderr || result.stdout).trim()}`);
  if (await exists(pending)) await unlink(pending); return { pushed: head(root), remote: record.remote, branch: record.branch };
}

export async function validateWorkflow(root, config, workflow, { strict = false } = {}) {
  const errors = [], warnings = []; if (branch(root) !== workflow.workItem.branch) errors.push(`Current branch ${branch(root)} does not match ${workflow.workItem.branch}.`);
  if (workflow.schemaVersion === 2 && workflow.resolution?.workType !== workflow.workItem.workType) errors.push('Work type differs from the immutable profile snapshot.');
  const resolvedOrder = workflow.resolution?.phases?.map((phase) => phase.id);
  if (resolvedOrder?.length && JSON.stringify(resolvedOrder) !== JSON.stringify(workflow.phaseOrder)) errors.push('Phase order differs from the immutable profile snapshot.');
  let activeCount = 0;
  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId]; if (!phase) { errors.push(`Missing phase ${phaseId}.`); continue; }
    if (['in_progress', 'awaiting_approval'].includes(phase.status)) activeCount += 1;
    if (phase.status === 'approved' && !(await exists(path.join(root, requiredRepoPath(config, workflow, phase))))) errors.push(`Approved artifact missing: ${requiredRepoPath(config, workflow, phase)}`);
  }
  if (workflow.status === 'complete') { if (workflow.currentPhase !== null) errors.push('Complete workflow must have currentPhase null.'); if (activeCount) errors.push('Complete workflow cannot have an active phase.'); }
  else { if (!workflow.currentPhase) errors.push('In-progress workflow must have a current phase.'); if (activeCount !== 1) errors.push(`In-progress workflow must have exactly one active phase; found ${activeCount}.`); }
  const active = currentPhase(workflow); if (strict && active && active.status === 'awaiting_approval') errors.push(...await validatePhase(root, config, workflow, active));
  if (await exists(pendingPublicationPath(root, config, workflow.workItem.id))) errors.push('Publication is pending; run singularity-flow sync.');
  return { valid: errors.length === 0, errors, warnings };
}
