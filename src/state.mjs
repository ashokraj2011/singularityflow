import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SingularityFlowError,
  exists,
  invariant,
  nowIso,
  posix,
  readJson,
  repoRelative,
  run,
  snapshot,
  truncate,
  writeJson,
  writeText
} from './util.mjs';
import { add, branch, changedFiles, commit, head, identity } from './git.mjs';

export const CONFIG_PATH = '.sdlc/config.json';

export const DEFAULT_PHASES = [
  ['requirements', 'Requirements', 'product-owner', 'artifacts/requirements/requirements.md', 'requirements', 300],
  ['design', 'Architecture & Design', 'architect', 'artifacts/design/design.md', 'design', 300],
  ['implementation', 'Implementation', 'developer', 'artifacts/implementation/implementation-summary.md', 'implementation-summary', 250],
  ['verification', 'Verification', 'qa', 'artifacts/verification/test-evidence.md', 'test-evidence', 250],
  ['review', 'Independent Review', 'reviewer', 'artifacts/review/review.md', 'review', 250],
  ['release', 'Release Readiness', 'release-manager', 'artifacts/release/release-plan.md', 'release-plan', 250]
].map(([id, label, owner, requiredPath, kind, minimumBytes]) => ({
  id,
  label,
  owner,
  requiredArtifact: { path: requiredPath, kind, minimumBytes },
  qualityCommands: []
}));

export function defaultConfig() {
  return {
    schemaVersion: 1,
    defaultBaseBranch: 'main',
    workItemRoot: '.sdlc/work-items',
    idPattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
    phases: structuredClone(DEFAULT_PHASES),
    artifactScan: {
      ignorePrefixes: ['.git/', 'node_modules/', '.idea/', '.vscode/']
    },
    jira: {
      issueType: 'Story',
      maxResults: 25
    },
    governance: {
      requireGithubApprovals: false,
      requireAcceptanceCriteriaTags: true,
      protectedPaths: ['.sdlc/config.json', '.github/workflows/singularity-flow-approve.yml', '.github/workflows/singularity-flow-validation.yml'],
      roles: {}
    }
  };
}

export async function loadConfig(root, { create = false } = {}) {
  const file = path.join(root, CONFIG_PATH);
  if (!(await exists(file))) {
    const config = defaultConfig();
    if (create) await writeJson(file, config);
    return config;
  }
  const user = await readJson(file);
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...user,
    artifactScan: { ...defaults.artifactScan, ...(user.artifactScan ?? {}) },
    jira: { ...defaults.jira, ...(user.jira ?? {}) },
    governance: { ...defaults.governance, ...(user.governance ?? {}) },
    phases: Array.isArray(user.phases) && user.phases.length ? user.phases : defaults.phases
  };
}

export function validateId(config, id) {
  if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) {
    throw new SingularityFlowError('Work ID must be one safe identifier without slashes.');
  }
  if (!(new RegExp(config.idPattern)).test(id)) {
    throw new SingularityFlowError(`Work ID ${id} does not match ${config.idPattern}.`);
  }
}

export function workDir(root, config, id) {
  return path.join(root, config.workItemRoot, id);
}

export function workDirRelative(config, id) {
  return posix(path.join(config.workItemRoot, id));
}

export function workflowPath(root, config, id) {
  return path.join(workDir(root, config, id), 'workflow.json');
}

export function statusPath(root, config, id) {
  return path.join(workDir(root, config, id), 'STATUS.md');
}

export function sourcePath(root, config, id) {
  return path.join(workDir(root, config, id), 'source.json');
}

export function userStoryPath(root, config, id) {
  return path.join(workDir(root, config, id), 'USER-STORY.md');
}

export function approvalPath(root, config, id, phase) {
  return path.join(workDir(root, config, id), 'approvals', `${phase}.json`);
}

function jiraSourceMarkdown(source) {
  const metadata = [
    source.url ? `- URL: ${source.url}` : null,
    source.issueType ? `- Type: ${source.issueType}` : null,
    source.project ? `- Project: ${source.project.key ?? ''}${source.project.name ? ` — ${source.project.name}` : ''}` : null,
    source.status ? `- Status: ${source.status}${source.statusCategory ? ` (${source.statusCategory})` : ''}` : null,
    source.priority ? `- Priority: ${source.priority}` : null,
    source.assignee ? `- Assignee: ${source.assignee}` : null,
    source.reporter ? `- Reporter: ${source.reporter}` : null,
    source.parent ? `- Parent: ${source.parent.key}${source.parent.title ? ` — ${source.parent.title}` : ''}` : null,
    source.storyPoints != null ? `- Story points: ${source.storyPoints}` : null,
    source.sprints?.length ? `- Sprint: ${source.sprints.map((sprint) => `${sprint.name ?? sprint.id ?? 'unnamed'}${sprint.state ? ` [${sprint.state}]` : ''}`).join(', ')}` : null,
    source.dueDate ? `- Due date: ${source.dueDate}` : null,
    source.createdAt ? `- Created: ${source.createdAt}` : null,
    source.updatedAt ? `- Updated: ${source.updatedAt}` : null,
    source.labels?.length ? `- Labels: ${source.labels.join(', ')}` : null,
    source.components?.length ? `- Components: ${source.components.join(', ')}` : null,
    source.fetchedAt ? `- Fetched: ${source.fetchedAt}` : null
  ].filter(Boolean).join('\n');
  const sections = [
    ['Description', source.description || '_No description provided._'],
    ['Acceptance criteria', source.acceptanceCriteria || '_No acceptance-criteria field was configured or populated._'],
    ['Environment', source.environment],
    ['Subtasks', source.subtasks?.map((item) => `- ${item.key}${item.status ? ` [${item.status}]` : ''}${item.title ? ` — ${item.title}` : ''}`).join('\n')],
    ['Linked issues', source.issueLinks?.map((item) => `- ${item.relationship ?? 'Related to'}: ${item.issue?.key ?? 'unknown'}${item.issue?.status ? ` [${item.issue.status}]` : ''}${item.issue?.title ? ` — ${item.issue.title}` : ''}`).join('\n')],
    ['Attachments', source.attachments?.map((item) => `- ${item.filename ?? item.id}${item.mimeType ? ` (${item.mimeType})` : ''}`).join('\n')]
  ].filter(([, value]) => String(value ?? '').trim());
  return `# ${source.key} — ${source.title}\n\n${metadata}\n${sections.map(([heading, value]) => `\n## ${heading}\n\n${String(value).trim()}\n`).join('')}`.trimEnd() + '\n';
}

function requirementsTemplate({ id, title, source }) {
  const description = source.description?.trim() || 'TODO: Describe the business problem, user need, and expected outcome.';
  const acceptance = source.acceptanceCriteria?.trim() || 'TODO: Add clear, testable acceptance criteria.';
  const sourceLines = source.type === 'jira'
    ? [`- Source: Jira`, `- Key: ${source.key}`, source.url ? `- URL: ${source.url}` : null, source.status ? `- Jira status: ${source.status}` : null].filter(Boolean).join('\n')
    : `- Source: Manual identifier\n- ID: ${id}`;
  return `# ${id} — Requirements\n\n## Work item\n\n- Title: ${title}\n${sourceLines}\n\n## Problem statement\n\n${description}\n\n## Scope\n\n### In scope\n\n- TODO: Define included behavior.\n\n### Out of scope\n\n- TODO: Define explicit exclusions.\n\n## Acceptance criteria\n\n${acceptance}\n\n## Dependencies and assumptions\n\n- TODO: Record dependencies and assumptions.\n\n## Risks and open questions\n\n- TODO: Resolve or explicitly track open questions.\n`;
}

function phaseTemplate(phase, context) {
  const { id, title, source } = context;
  if (phase === 'requirements') return requirementsTemplate({ id, title, source });
  const templates = {
    design: `# ${id} — Architecture & Design\n\n## Objective\n\nTODO: Summarize the approved requirements and design objective for **${title}**.\n\n## Current-state assessment\n\nTODO: Identify affected components, constraints, and existing patterns.\n\n## Proposed design\n\nTODO: Describe components, interfaces, data flow, and responsibilities.\n\n## Alternatives considered\n\nTODO: Record alternatives and why they were not selected.\n\n## Security, privacy, and compliance\n\nTODO: Identify threats, data handling, permissions, and controls.\n\n## Observability and operations\n\nTODO: Define logging, metrics, alerts, supportability, and capacity.\n\n## Migration and rollback\n\nTODO: Describe compatibility, rollout, migration, and rollback.\n\n## Implementation plan\n\nTODO: Break the design into ordered, testable work.\n`,
    implementation: `# ${id} — Implementation Summary\n\n## Implemented outcome\n\nTODO: Summarize what changed for **${title}**.\n\n## Changed components\n\nTODO: List code, configuration, data, and documentation changes.\n\n## Key decisions and deviations\n\nTODO: Record deviations from the approved design and their rationale.\n\n## Tests added or updated\n\nTODO: List test coverage and important scenarios.\n\n## Known limitations\n\nTODO: Record limitations or explicitly state none.\n\n## Operational notes\n\nTODO: Record feature flags, migrations, configuration, and deployment considerations.\n`,
    verification: `# ${id} — Verification Evidence\n\n## Verification scope\n\nTODO: Describe what was verified for **${title}** and against which acceptance criteria.\n\n## Automated checks\n\nTODO: Record exact commands, environments, outcomes, and logs.\n\n## Acceptance-criteria results\n\nTODO: Map every acceptance criterion to evidence and a pass/fail result.\n\n## Regression and edge cases\n\nTODO: Record negative cases, boundaries, failures, and regression coverage.\n\n## Security and non-functional checks\n\nTODO: Record applicable security, performance, accessibility, reliability, or privacy checks.\n\n## Defects and residual risk\n\nTODO: List defects, waivers, residual risk, or explicitly state none.\n`,
    review: `# ${id} — Independent Review\n\n## Review scope\n\nTODO: Describe the implementation and evidence reviewed for **${title}**.\n\n## Findings\n\nTODO: Record findings by severity, location, impact, and action.\n\n## Acceptance-criteria assessment\n\nTODO: Confirm whether each criterion is implemented and evidenced.\n\n## Maintainability and architecture assessment\n\nTODO: Evaluate readability, coupling, interfaces, tests, and design alignment.\n\n## Security and operational assessment\n\nTODO: Evaluate security, failures, observability, rollout, and rollback.\n\n## Review decision\n\nTODO: State approved, approved with conditions, or changes requested.\n`,
    release: `# ${id} — Release Plan\n\n## Release scope\n\nTODO: Summarize the releasable outcome for **${title}**.\n\n## Preconditions\n\nTODO: List approvals, migrations, configuration, secrets, and dependencies.\n\n## Deployment steps\n\nTODO: Provide ordered deployment and validation steps.\n\n## Observability and success criteria\n\nTODO: Define metrics, logs, alerts, dashboards, and success window.\n\n## Rollback plan\n\nTODO: Define triggers, steps, data considerations, and owners.\n\n## Communication and support\n\nTODO: Identify stakeholders, release notes, support handoff, and escalation.\n\n## Final readiness decision\n\nTODO: State ready, conditionally ready, or not ready, with rationale.\n`
  };
  return templates[phase] ?? `# ${id} — ${phase}\n\nTODO: Complete the phase artifact.\n`;
}

function phaseState(definition, index) {
  return {
    id: definition.id,
    label: definition.label ?? definition.id,
    owner: definition.owner ?? null,
    order: index,
    status: index === 0 ? 'in_progress' : 'not_started',
    requiredArtifact: structuredClone(definition.requiredArtifact ?? null),
    qualityCommands: [...(definition.qualityCommands ?? [])],
    startedAt: index === 0 ? nowIso() : null,
    submittedAt: null,
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    artifacts: [],
    checks: []
  };
}

export async function createWorkflow(root, config, { id, title, source, baseBranch }) {
  validateId(config, id);
  if (branch(root) !== id) throw new SingularityFlowError(`Current branch ${branch(root)} must exactly match work ID ${id}.`);
  if (await exists(workflowPath(root, config, id))) throw new SingularityFlowError(`${id} already exists. Use singularity-flow resume ${id}.`);
  const actor = identity(root);
  const phases = config.phases.map(phaseState);
  const createdAt = nowIso();
  const workflow = {
    schemaVersion: 1,
    workItem: {
      id,
      title: title || id,
      branch: branch(root),
      baseBranch,
      createdAt,
      createdBy: actor,
      source: { type: source.type, key: source.key ?? null, url: source.url ?? null }
    },
    status: 'in_progress',
    currentPhase: phases[0]?.id ?? null,
    phaseOrder: phases.map((phase) => phase.id),
    phases: Object.fromEntries(phases.map((phase) => [phase.id, phase])),
    history: [{ at: createdAt, actor: actor.name, event: 'work_started', phase: phases[0]?.id ?? null, detail: `Created branch ${branch(root)}` }]
  };
  await writeJson(sourcePath(root, config, id), source);
  if (source.type === 'jira') await writeText(userStoryPath(root, config, id), jiraSourceMarkdown(source));
  await writeText(path.join(workDir(root, config, id), 'README.md'), `# ${id} — ${workflow.workItem.title}\n\nDurable SDLC state for branch \`${workflow.workItem.branch}\`.\n\n- [workflow.json](./workflow.json) — machine state\n- [STATUS.md](./STATUS.md) — human-readable phase status\n- [source.json](./source.json) — normalized input context\n${source.type === 'jira' ? '- [USER-STORY.md](./USER-STORY.md) — human-readable Jira story snapshot\n' : ''}- [artifacts/](./artifacts/) — phase deliverables\n- [approvals/](./approvals/) — immutable approval snapshots\n`);
  const first = phases[0];
  if (first?.requiredArtifact?.path) {
    await writeText(path.join(workDir(root, config, id), first.requiredArtifact.path), phaseTemplate(first.id, { id, title: workflow.workItem.title, source }));
  }
  await saveWorkflow(root, config, workflow);
  return workflow;
}

export async function loadWorkflow(root, config, id = undefined) {
  const resolved = id ?? branch(root);
  const file = workflowPath(root, config, resolved);
  if (!(await exists(file))) throw new SingularityFlowError(`No workflow found for ${resolved}. Expected ${posix(path.relative(root, file))}.`);
  const workflow = await readJson(file);
  invariant(workflow.workItem?.id === resolved, `Workflow ID does not match ${resolved}.`);
  return workflow;
}

export function currentPhase(workflow) {
  if (!workflow.currentPhase) return null;
  const phase = workflow.phases[workflow.currentPhase];
  invariant(phase, `Unknown current phase ${workflow.currentPhase}.`);
  return phase;
}

function assertCurrent(workflow, requested = undefined) {
  const phase = currentPhase(workflow);
  if (!phase) throw new SingularityFlowError(`${workflow.workItem.id} is complete.`);
  if (requested && requested !== phase.id) throw new SingularityFlowError(`Current phase is ${phase.id}, not ${requested}.`);
  return phase;
}

function requiredRepoPath(config, workflow, phase) {
  return phase.requiredArtifact?.path ? `${workDirRelative(config, workflow.workItem.id)}/${phase.requiredArtifact.path}` : null;
}

function statusMarkdown(workflow) {
  const lines = [
    `# ${workflow.workItem.id} — ${workflow.workItem.title}`,
    '',
    `- Branch: \`${workflow.workItem.branch}\``,
    `- Base branch: \`${workflow.workItem.baseBranch}\``,
    `- Overall status: **${workflow.status}**`,
    `- Current phase: **${workflow.currentPhase ?? 'complete'}**`,
    '',
    '## SDLC phases',
    '',
    '| # | Phase | Owner | Status | Submitted | Approved |',
    '|---:|---|---|---|---|---|'
  ];
  workflow.phaseOrder.forEach((id, index) => {
    const phase = workflow.phases[id];
    lines.push(`| ${index + 1} | ${phase.label} (\`${id}\`) | ${phase.owner ?? '—'} | **${phase.status}** | ${phase.submittedAt ?? '—'} | ${phase.approvedAt ?? '—'} |`);
  });
  const active = currentPhase(workflow);
  if (active) {
    lines.push('', `## Current phase artifacts — ${active.label}`, '');
    if (!active.artifacts.length) lines.push('_No artifacts registered yet._');
    else {
      lines.push('| Path | Kind | Status | Snapshot |', '|---|---|---|---|');
      active.artifacts.forEach((artifact) => lines.push(`| \`${artifact.path}\` | ${artifact.kind} | ${artifact.status} | ${artifact.sha256 ? artifact.sha256.slice(0, 12) : artifact.exists ? 'non-file' : 'deleted'} |`));
    }
  }
  lines.push('', '## Recent history', '');
  workflow.history.slice(-10).reverse().forEach((item) => lines.push(`- ${item.at} — **${item.event}**${item.phase ? ` (${item.phase})` : ''} by ${item.actor ?? 'unknown'}${item.detail ? `: ${item.detail}` : ''}`));
  return `${lines.join('\n')}\n`;
}

export async function saveWorkflow(root, config, workflow) {
  await writeJson(workflowPath(root, config, workflow.workItem.id), workflow);
  await writeText(statusPath(root, config, workflow.workItem.id), statusMarkdown(workflow));
}

export async function preparePhase(root, config, workflow, requested = undefined) {
  const phase = assertCurrent(workflow, requested);
  if (!phase.requiredArtifact?.path) throw new SingularityFlowError(`No required artifact configured for ${phase.id}.`);
  const target = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path);
  if (!(await exists(target))) {
    const source = await readJson(sourcePath(root, config, workflow.workItem.id));
    await writeText(target, phaseTemplate(phase.id, { id: workflow.workItem.id, title: workflow.workItem.title, source }));
  }
  return posix(path.relative(root, target));
}

const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx', '.kt', '.kts', '.mjs', '.php', '.py', '.rb', '.rs', '.scala', '.scss', '.sql', '.swift', '.ts', '.tsx', '.vue']);

export function inferKind(relativePath) {
  const value = relativePath.toLowerCase();
  if (value.endsWith('/requirements.md')) return 'requirements';
  if (value.endsWith('/design.md')) return 'design';
  if (value.endsWith('/implementation-summary.md')) return 'implementation-summary';
  if (value.endsWith('/test-evidence.md')) return 'test-evidence';
  if (value.endsWith('/review.md')) return 'review';
  if (value.endsWith('/release-plan.md')) return 'release-plan';
  if (/(^|\/)(test|tests|spec|specs)(\/|$)/.test(value) || /\.(test|spec)\.[^.]+$/.test(value)) return 'test';
  const extension = path.extname(value);
  if (SOURCE_EXTENSIONS.has(extension)) return 'code';
  if (['.md', '.mdx', '.txt', '.adoc', '.rst'].includes(extension)) return 'document';
  if (['.json', '.yml', '.yaml', '.toml', '.ini', '.properties'].includes(extension)) return 'configuration';
  return 'file';
}

function canModify(phase) {
  if (phase.status !== 'in_progress') throw new SingularityFlowError(`Phase ${phase.id} is ${phase.status}; it cannot accept artifact changes.`);
}

function artifactFor(phase, relativePath) {
  return phase.artifacts.find((item) => item.path === relativePath);
}

export async function registerArtifact(root, workflow, candidate, { phaseId, kind } = {}) {
  const phase = assertCurrent(workflow, phaseId);
  canModify(phase);
  const relativePath = repoRelative(root, candidate);
  if (relativePath === '.') throw new SingularityFlowError('Repository root cannot be an artifact.');
  const info = await snapshot(path.join(root, relativePath));
  const timestamp = nowIso();
  const existing = artifactFor(phase, relativePath);
  const record = {
    path: relativePath,
    kind: kind || existing?.kind || inferKind(relativePath),
    status: 'pending',
    exists: info.exists,
    size: info.size,
    sha256: info.sha256,
    registeredAt: existing?.registeredAt ?? timestamp,
    updatedAt: timestamp
  };
  if (existing) Object.assign(existing, record);
  else phase.artifacts.push(record);
  phase.artifacts.sort((a, b) => a.path.localeCompare(b.path));
  workflow.history.push({ at: timestamp, actor: identity(root).name, event: existing ? 'artifact_updated' : 'artifact_registered', phase: phase.id, detail: `${record.kind}: ${relativePath}` });
  return record;
}

function ignored(config, workflow, relativePath) {
  if (relativePath === CONFIG_PATH) return true;
  if ((config.artifactScan?.ignorePrefixes ?? []).some((prefix) => relativePath.startsWith(prefix))) return true;
  const itemRoot = workDirRelative(config, workflow.workItem.id);
  return relativePath.startsWith(`${itemRoot}/`) && !relativePath.startsWith(`${itemRoot}/artifacts/`);
}

export async function scanArtifacts(root, config, workflow, phaseId = undefined) {
  const phase = assertCurrent(workflow, phaseId);
  canModify(phase);
  const records = [];
  for (const file of changedFiles(root).filter((item) => !ignored(config, workflow, item))) {
    records.push(await registerArtifact(root, workflow, file, { phaseId: phase.id }));
  }
  return records;
}

const PLACEHOLDER = /\b(?:TODO|TBD)\b|\{\{[^}]+\}\}|\[\s*(?:describe|add|insert|provide|record)[^\]]*\]/i;

async function validatePhase(root, config, workflow, phase) {
  const errors = [];
  const required = requiredRepoPath(config, workflow, phase);
  if (required) {
    const absolute = path.join(root, required);
    if (!(await exists(absolute))) errors.push(`Required artifact missing: ${required}`);
    else {
      const text = await readFile(absolute, 'utf8');
      const bytes = Buffer.byteLength(text);
      if (bytes < (phase.requiredArtifact.minimumBytes ?? 1)) errors.push(`Required artifact ${required} is too short (${bytes} bytes).`);
      if (PLACEHOLDER.test(text)) errors.push(`Required artifact ${required} contains TODO/TBD/template placeholders.`);
      if (!artifactFor(phase, required)) errors.push(`Required artifact is not registered to ${phase.id}: ${required}`);
    }
  }
  for (const artifact of phase.artifacts) {
    const current = await snapshot(path.join(root, artifact.path));
    if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) {
      errors.push(`Artifact changed after registration: ${artifact.path}. Run singularity-flow artifact scan.`);
    }
  }
  return errors;
}

async function qualityChecks(root, phase) {
  const checks = [];
  for (const command of phase.qualityCommands ?? []) {
    const startedAt = nowIso();
    const result = run(command, [], { cwd: root, shell: true, allowFailure: true });
    checks.push({
      command,
      startedAt,
      completedAt: nowIso(),
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr)
    });
  }
  return checks;
}

export async function submitPhase(root, config, workflow, { phaseId, runChecks = true } = {}) {
  const phase = assertCurrent(workflow, phaseId);
  canModify(phase);
  await scanArtifacts(root, config, workflow, phase.id);
  phase.checks = runChecks ? await qualityChecks(root, phase) : [];
  const errors = await validatePhase(root, config, workflow, phase);
  const failed = phase.checks.filter((check) => check.status !== 'passed');
  if (failed.length) errors.push(`Quality command failed: ${failed.map((check) => check.command).join(', ')}`);
  if (errors.length) throw new SingularityFlowError(`Phase ${phase.id} is not ready:\n- ${errors.join('\n- ')}`);
  phase.status = 'awaiting_approval';
  phase.submittedAt = nowIso();
  workflow.history.push({ at: phase.submittedAt, actor: identity(root).name, event: 'phase_submitted', phase: phase.id, detail: `${phase.artifacts.length} artifact(s), ${phase.checks.length} check(s)` });
  await saveWorkflow(root, config, workflow);
  return phase;
}

function nextPhase(workflow, phase) {
  const nextId = workflow.phaseOrder[workflow.phaseOrder.indexOf(phase.id) + 1];
  return nextId ? workflow.phases[nextId] : null;
}

export async function approvePhase(root, config, workflow, { phaseId, by, createCommit = false, message } = {}) {
  const phase = assertCurrent(workflow, phaseId);
  if (phase.status !== 'awaiting_approval') throw new SingularityFlowError(`Phase ${phase.id} must be submitted before approval.`);
  if (branch(root) !== workflow.workItem.branch) throw new SingularityFlowError(`Approval must run on branch ${workflow.workItem.branch}.`);
  const errors = await validatePhase(root, config, workflow, phase);
  if (errors.length) throw new SingularityFlowError(`Phase ${phase.id} cannot be approved:\n- ${errors.join('\n- ')}`);
  const githubActor = process.env.SINGULARITY_FLOW_GITHUB_ACTOR;
  const actor = githubActor || by || identity(root).name;
  if (githubActor) {
    const allowed = config.governance?.roles?.[phase.owner] ?? [];
    if (!allowed.includes(githubActor)) {
      throw new SingularityFlowError(`@${githubActor} is not authorized for role ${phase.owner}.`);
    }
  }
  const timestamp = nowIso();
  phase.artifacts.forEach((artifact) => Object.assign(artifact, { status: 'approved', approvedAt: timestamp, approvedBy: actor }));
  Object.assign(phase, { status: 'approved', approvedAt: timestamp, approvedBy: actor, rejectedAt: null, rejectedBy: null, rejectionReason: null });
  const upcoming = nextPhase(workflow, phase);
  if (upcoming) {
    upcoming.status = 'in_progress';
    upcoming.startedAt = timestamp;
    workflow.currentPhase = upcoming.id;
  } else {
    workflow.currentPhase = null;
    workflow.status = 'complete';
  }
  workflow.history.push({ at: timestamp, actor, event: 'phase_approved', phase: phase.id, detail: upcoming ? `Advanced to ${upcoming.id}` : 'Workflow completed' });
  const approval = {
    schemaVersion: 1,
    workItemId: workflow.workItem.id,
    branch: workflow.workItem.branch,
    phase: phase.id,
    phaseLabel: phase.label,
    approvedAt: timestamp,
    approvedBy: actor,
    provenance: githubActor ? {
      channel: 'github-pr-comment',
      actor: githubActor,
      repository: process.env.GITHUB_REPOSITORY ?? null,
      pullRequest: process.env.SINGULARITY_FLOW_GITHUB_PR ?? null,
      commentUrl: process.env.SINGULARITY_FLOW_GITHUB_COMMENT_URL ?? null
    } : { channel: 'local', actor },
    headBeforeApproval: head(root),
    intakeApprovals: Object.fromEntries(await Promise.all(
      workflow.phaseOrder.slice(0, workflow.phaseOrder.indexOf(phase.id)).map(async (priorId) => {
        const priorPath = approvalPath(root, config, workflow.workItem.id, priorId);
        return [priorId, (await exists(priorPath)) ? (await snapshot(priorPath)).sha256 : null];
      })
    )),
    artifacts: phase.artifacts.map(({ path: artifactPath, kind, sha256, size, exists: present }) => ({ path: artifactPath, kind, sha256, size, exists: present })),
    checks: phase.checks.map(({ command, status, exitCode, completedAt }) => ({ command, status, exitCode, completedAt }))
  };
  await writeJson(approvalPath(root, config, workflow.workItem.id, phase.id), approval);
  await saveWorkflow(root, config, workflow);
  if (createCommit) {
    add(root, [...new Set([CONFIG_PATH, workDirRelative(config, workflow.workItem.id), ...phase.artifacts.map((artifact) => artifact.path)])]);
    commit(root, message || `${workflow.workItem.id} approve ${phase.id}`);
  }
  return { phase, next: upcoming, approval };
}

export async function rejectPhase(root, config, workflow, { reason, by } = {}) {
  const phase = currentPhase(workflow);
  if (!phase) throw new SingularityFlowError(`${workflow.workItem.id} is complete.`);
  if (phase.status !== 'awaiting_approval') throw new SingularityFlowError(`Only an awaiting_approval phase can be rejected; current status is ${phase.status}.`);
  if (!reason?.trim()) throw new SingularityFlowError('A rejection reason is required.');
  const actor = by || identity(root).name;
  const timestamp = nowIso();
  Object.assign(phase, { status: 'in_progress', submittedAt: null, rejectedAt: timestamp, rejectedBy: actor, rejectionReason: reason.trim() });
  phase.artifacts.forEach((artifact) => { artifact.status = 'pending'; });
  workflow.history.push({ at: timestamp, actor, event: 'phase_rejected', phase: phase.id, detail: reason.trim() });
  await saveWorkflow(root, config, workflow);
  return phase;
}

export async function validateWorkflow(root, config, workflow, { strict = false } = {}) {
  const errors = [];
  const warnings = [];
  if (branch(root) !== workflow.workItem.branch) errors.push(`Current branch ${branch(root)} does not match ${workflow.workItem.branch}.`);
  let activeCount = 0;
  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId];
    if (!phase) {
      errors.push(`Missing phase ${phaseId}.`);
      continue;
    }
    if (['in_progress', 'awaiting_approval'].includes(phase.status)) activeCount += 1;
    if (phase.status === 'approved') {
      const required = requiredRepoPath(config, workflow, phase);
      if (required && !(await exists(path.join(root, required)))) errors.push(`Approved artifact missing: ${required}`);
    }
  }
  if (workflow.status === 'complete') {
    if (workflow.currentPhase !== null) errors.push('Complete workflow must have currentPhase null.');
    if (activeCount) errors.push('Complete workflow cannot have an active phase.');
  } else {
    if (!workflow.currentPhase) errors.push('In-progress workflow must have a current phase.');
    if (activeCount !== 1) errors.push(`In-progress workflow must have exactly one active phase; found ${activeCount}.`);
  }
  const active = currentPhase(workflow);
  if (strict && active && active.status === 'awaiting_approval') errors.push(...await validatePhase(root, config, workflow, active));
  if (active) {
    const unregistered = changedFiles(root).filter((file) => !ignored(config, workflow, file) && !artifactFor(active, file));
    if (unregistered.length) warnings.push(`Unregistered changed files: ${unregistered.join(', ')}`);
  }
  return { valid: errors.length === 0, errors, warnings };
}
