function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is unavailable.`);
  return value;
}

function projectKey(value) {
  const key = String(value ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(key) ? key : null;
}

export function workspaceJiraRouting(workspace, credentials = {}) {
  const manifest = object(workspace, 'Workspace');
  const repositories = object(manifest.repositories, 'Workspace repository registry');
  const projectKeys = [...new Set(Object.values(repositories)
    .map((repository) => projectKey(repository?.jira?.board))
    .filter(Boolean))];
  const leadProjectKey = projectKey(repositories[manifest.leadRepository]?.jira?.board) ?? projectKeys[0] ?? null;
  return {
    configured: projectKeys.length > 0,
    connected: Boolean(credentials.connected && credentials.connection),
    projectKeys,
    leadProjectKey,
    connection: credentials.connection ?? null
  };
}

export function assertWorkspaceEpicKey(routing, value) {
  const key = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Error('Enter a valid Jira Epic key such as KAN-8.');
  const issueProject = key.slice(0, key.lastIndexOf('-'));
  if (!routing.projectKeys.includes(issueProject)) {
    throw new Error(`Jira ${key} is outside this workspace. Allowed projects: ${routing.projectKeys.join(', ') || 'none'}.`);
  }
  return key;
}

export function workspacePortfolioConfiguration(workspace, credentials = {}) {
  const manifest = object(workspace, 'Workspace');
  const routing = workspaceJiraRouting(manifest, credentials);
  const repositories = Object.fromEntries(Object.entries(object(manifest.repositories, 'Workspace repository registry'))
    .map(([id, repository]) => [id, {
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      required: repository.required !== false,
      metadata: repository.metadata ?? {}
    }]));
  const jira = routing.connected && routing.configured ? {
    enabled: true,
    connection: routing.connection.name,
    deployment: routing.connection.deployment,
    baseUrl: routing.connection.baseUrl,
    projectKey: routing.leadProjectKey,
    allowedProjects: routing.projectKeys,
    writeMode: 'approved'
  } : { enabled: false };
  return { repositories, jira };
}
