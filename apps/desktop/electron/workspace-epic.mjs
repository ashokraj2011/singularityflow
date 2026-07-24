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
  const raw = String(value ?? '').trim();
  let reference = raw;
  if (/^https:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch {
      throw new Error('The Jira Epic URL is invalid. Paste a complete HTTPS browse URL such as https://company.atlassian.net/browse/KAN-8.');
    }
    reference = url.pathname.match(/\/browse\/([^/?#]+)/i)?.[1]
      ?? url.searchParams.get('selectedIssue')
      ?? url.searchParams.get('issueKey')
      ?? '';
  }
  const key = reference.trim().toUpperCase();
  if (!/^(?:[A-Z][A-Z0-9_]*-\d+|\d+)$/.test(key)) {
    throw new Error('Enter a Jira Epic key such as KAN-8, paste its Jira browse URL, or enter its numeric issue ID.');
  }
  if (key.includes('-')) {
    const issueProject = key.slice(0, key.lastIndexOf('-'));
    if (!routing.projectKeys.includes(issueProject)) {
      throw new Error(`Jira ${key} is outside this workspace. Allowed projects: ${routing.projectKeys.join(', ') || 'none'}.`);
    }
  }
  return key;
}

export function assertWorkspaceEpicIssue(routing, issue) {
  const key = String(issue?.key ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Error('Jira returned an issue without a valid key.');
  const issueProject = key.slice(0, key.lastIndexOf('-'));
  if (!routing.projectKeys.includes(issueProject)) {
    throw new Error(`Jira ${key} is outside this workspace. Allowed projects: ${routing.projectKeys.join(', ') || 'none'}.`);
  }
  return issue;
}

export function summarizeWorkspaceEpicProjects(results) {
  const epics = new Map();
  const warnings = [];
  for (const result of results ?? []) {
    const projectKeyValue = projectKey(result?.projectKey) ?? String(result?.projectKey ?? 'unknown');
    const repositoryIds = Array.isArray(result?.repositoryIds)
      ? result.repositoryIds.map((value) => String(value)).filter(Boolean)
      : [];
    if (result?.error) {
      warnings.push({
        projectKey: projectKeyValue,
        repositoryIds,
        message: String(result.error?.message ?? result.error)
      });
      continue;
    }
    for (const epic of result?.epics ?? []) {
      const key = String(epic?.key ?? '').trim().toUpperCase();
      if (key && !epics.has(key)) epics.set(key, epic);
    }
  }
  return {
    epics: [...epics.values()]
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
        || String(left.key).localeCompare(String(right.key))),
    warnings
  };
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
