import { loadPortfolio } from './initiative-config.mjs';
import {
  discoverJiraConnection,
  getMyPermissions,
  listBoards,
  listEpics
} from './jira.mjs';
import {
  activeWorkspaceFile,
  readActiveWorkspaceContext,
  workspaceRegistryFile
} from './workspace-context.mjs';
import { readWorkspace } from './workspace.mjs';

function message(error) {
  return String(error?.message ?? error ?? 'Unknown error');
}

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim().toUpperCase()).filter(Boolean))];
}

function uniqueMessages(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function credentialSnapshot(env) {
  const deployment = String(env.JIRA_DEPLOYMENT ?? 'cloud').trim().toLowerCase();
  const dataCenter = deployment === 'data-center';
  const required = dataCenter
    ? ['JIRA_BASE_URL', 'JIRA_PAT']
    : ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];
  const present = Object.fromEntries(required.map((name) => [name, Boolean(String(env[name] ?? '').trim())]));
  return {
    deployment: dataCenter ? 'data-center' : 'cloud',
    source: 'process-environment',
    required,
    present,
    missing: required.filter((name) => !present[name]),
    note: 'Electron keychain credentials are intentionally not exposed to the standalone CLI.'
  };
}

async function workspaceSnapshot(env) {
  try {
    const active = await readActiveWorkspaceContext(
      activeWorkspaceFile(env),
      workspaceRegistryFile(env),
      { refresh: false }
    );
    if (!active) return { active: false, remediation: 'Run singularity-flow workspace list, then singularity-flow workspace use <WORKSPACE>.' };
    const workspace = await readWorkspace(active.workspacePath);
    return {
      active: true,
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      leadRepository: workspace.leadRepository,
      selectedRepository: active.repositoryId,
      repositoryPath: active.repositoryPath,
      projects: unique(Object.values(workspace.repositories).map((repository) => repository.jira?.board))
    };
  } catch (error) {
    return { active: false, error: message(error), remediation: 'Select the workspace again with singularity-flow workspace use <WORKSPACE>.' };
  }
}

async function policySnapshot(root) {
  try {
    const portfolio = await loadPortfolio(root, { required: false });
    if (!portfolio) return { configured: false, enabled: false, projects: [], remediation: 'Add singularity/portfolio.yml or configure the workspace in the desktop app.' };
    return {
      configured: true,
      enabled: portfolio.jira?.enabled === true,
      connection: portfolio.jira?.connection ?? null,
      deployment: portfolio.jira?.deployment ?? 'cloud',
      allowedHosts: portfolio.jira?.allowedHosts ?? [],
      allowedProjects: portfolio.jira?.allowedProjects ?? [],
      writeMode: portfolio.jira?.writeMode ?? 'off',
      projects: unique([
        ...(portfolio.jira?.allowedProjects ?? []),
        ...Object.values(portfolio.repositories ?? {}).map((repository) => repository.jira?.projectKey)
      ])
    };
  } catch (error) {
    return { configured: true, enabled: false, projects: [], error: message(error), remediation: 'Correct singularity/portfolio.yml and run singularity-flow validate.' };
  }
}

function permissionSummary(permissions) {
  const entries = Object.entries(permissions ?? {});
  return {
    total: entries.length,
    granted: entries.filter(([, value]) => value?.havePermission).map(([key]) => key),
    denied: entries.filter(([, value]) => !value?.havePermission).map(([key]) => key)
  };
}

export async function jiraDoctor(root, { env = process.env } = {}) {
  const [workspace, policy] = await Promise.all([workspaceSnapshot(env), policySnapshot(root)]);
  const credentials = credentialSnapshot(env);
  const result = {
    ok: false,
    checkedAt: new Date().toISOString(),
    root,
    workspace,
    policy,
    credentials,
    connection: { connected: false },
    projects: [],
    remediation: []
  };

  if (!workspace.active) result.remediation.push(workspace.remediation);
  if (!policy.configured || policy.error) result.remediation.push(policy.remediation);
  else if (!policy.enabled) result.remediation.push('Enable jira.enabled in singularity/portfolio.yml and publish the configuration.');
  if (credentials.missing.length) {
    result.remediation.push(`Set the CLI credential variables: ${credentials.missing.join(', ')}. A desktop Jira sign-in is not automatically shared with Copilot CLI.`);
  }

  try {
    const connection = await discoverJiraConnection({ env });
    result.connection = {
      connected: true,
      baseUrl: connection.baseUrl,
      deployment: connection.deployment,
      authenticationMode: connection.authenticationMode,
      account: {
        id: connection.account?.accountId ?? connection.account?.name ?? null,
        displayName: connection.account?.displayName ?? null,
        email: connection.account?.email ?? null
      },
      serverTitle: connection.server?.serverTitle ?? null,
      visibleProjects: connection.projects.map((project) => ({ key: project.key, name: project.name }))
    };
  } catch (error) {
    result.connection = { connected: false, error: message(error) };
    result.remediation.push(`Fix Jira connectivity: ${message(error)}`);
    return result;
  }

  const configuredProjects = unique([...workspace.projects ?? [], ...policy.projects ?? []]);
  const visible = new Set(result.connection.visibleProjects.map((project) => project.key.toUpperCase()));
  for (const key of configuredProjects) {
    const project = { key, visible: visible.has(key), permissions: null, boards: null, epics: null, errors: [] };
    if (!project.visible) {
      project.errors.push(`Project ${key} is not visible to the authenticated Jira account.`);
      result.remediation.push(`Correct project key ${key} or request Jira Browse Projects access.`);
      result.projects.push(project);
      continue;
    }
    const [permissions, boards, epics] = await Promise.allSettled([
      getMyPermissions(key, { env }),
      listBoards({ project: key, limit: 25, env }),
      listEpics(key, { limit: 25, env })
    ]);
    if (permissions.status === 'fulfilled') project.permissions = permissionSummary(permissions.value);
    else project.errors.push(`Permissions: ${message(permissions.reason)}`);
    if (boards.status === 'fulfilled') project.boards = boards.value.map((board) => ({ id: board.id, name: board.name, type: board.type }));
    else project.errors.push(`Boards: ${message(boards.reason)}`);
    if (epics.status === 'fulfilled') project.epics = { visible: epics.value.length, sample: epics.value.slice(0, 5).map((epic) => epic.key) };
    else project.errors.push(`Epics: ${message(epics.reason)}`);
    if (project.errors.length) result.remediation.push(`Review Jira access for ${key}: ${project.errors.join(' ')}`);
    result.projects.push(project);
  }

  if (!configuredProjects.length) result.remediation.push('Add a Jira project key to the workspace repository or jira.allowedProjects in singularity/portfolio.yml.');
  result.remediation = uniqueMessages(result.remediation);
  result.ok = result.connection.connected
    && policy.configured
    && policy.enabled
    && configuredProjects.length > 0
    && result.projects.every((project) => project.visible && project.errors.length === 0);
  return result;
}

export function jiraDoctorText(result) {
  const lines = [
    `Jira doctor: ${result.ok ? 'READY' : 'ATTENTION REQUIRED'}`,
    `Workspace: ${result.workspace.active ? `${result.workspace.name} (${result.workspace.selectedRepository})` : 'not selected'}`,
    `Policy: ${result.policy.configured ? `${result.policy.enabled ? 'enabled' : 'disabled'} · ${result.policy.writeMode ?? 'off'}` : 'missing'}`,
    `CLI credentials: ${result.credentials.missing.length ? `missing ${result.credentials.missing.join(', ')}` : `available (${result.credentials.deployment})`}`,
    `Connection: ${result.connection.connected ? `${result.connection.account.displayName ?? result.connection.account.id ?? 'authenticated'} · ${result.connection.baseUrl}` : `failed · ${result.connection.error ?? 'not checked'}`}`
  ];
  for (const project of result.projects) {
    lines.push(`Project ${project.key}: ${project.visible ? 'visible' : 'not visible'} · permissions ${project.permissions?.granted.length ?? 0}/${project.permissions?.total ?? 0} · boards ${project.boards?.length ?? 0} · epics ${project.epics?.visible ?? 0}`);
    for (const error of project.errors) lines.push(`  ! ${error}`);
  }
  if (result.remediation.length) {
    lines.push('Next actions:');
    result.remediation.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`));
  }
  return lines.join('\n');
}
