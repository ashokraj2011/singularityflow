import { SingularityFlowError } from './util.mjs';

export function jiraCredentials(env = process.env) {
  const baseUrl = env.JIRA_BASE_URL?.replace(/\/$/, '');
  const email = env.JIRA_EMAIL;
  const apiToken = env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !apiToken) {
    throw new SingularityFlowError('Jira access requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN. Singularity Flow never accepts or stores an Atlassian password.');
  }
  return { baseUrl, email, apiToken };
}

function nodeText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return node.attrs?.text ?? node.attrs?.id ?? '';
  if (node.type === 'emoji') return node.attrs?.text ?? node.attrs?.shortName ?? '';
  const children = nodeText(node.content ?? []);
  if (node.type === 'listItem') return `- ${children.trim()}\n`;
  if (node.type === 'orderedList' || node.type === 'bulletList') return children;
  return ['paragraph', 'heading', 'blockquote', 'codeBlock', 'panel'].includes(node.type)
    ? `${children}\n`
    : children;
}

export function adfToText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return nodeText(value).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function userName(user) {
  return user?.displayName ?? null;
}

function normalizeSprint(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    if (item && typeof item === 'object') {
      return {
        id: item.id ?? null,
        name: item.name ?? null,
        state: item.state ?? null,
        startDate: item.startDate ?? null,
        endDate: item.endDate ?? null,
        completeDate: item.completeDate ?? null
      };
    }
    const text = String(item);
    const read = (name) => text.match(new RegExp(`(?:^|,)${name}=([^,\\]]*)`))?.[1] ?? null;
    return {
      id: read('id'),
      name: read('name') ?? text,
      state: read('state'),
      startDate: read('startDate'),
      endDate: read('endDate'),
      completeDate: read('completeDate')
    };
  });
}

function normalizeLinkedIssue(issue) {
  if (!issue) return null;
  return {
    id: issue.id ?? null,
    key: issue.key ?? null,
    title: issue.fields?.summary ?? null,
    status: issue.fields?.status?.name ?? null,
    issueType: issue.fields?.issuetype?.name ?? null
  };
}

function normalizeCustomValue(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value.type === 'doc') return adfToText(value);
  if (Array.isArray(value)) return value.map(normalizeCustomValue);
  if (typeof value === 'object') {
    if (value.value !== undefined) return value.value;
    if (value.name !== undefined) return value.name;
    return value;
  }
  return String(value);
}

export function normalizeIssue(issue, {
  baseUrl,
  acceptanceField,
  storyPointsField,
  sprintField,
  extraFields = []
} = {}) {
  const fields = issue.fields ?? {};
  const names = issue.names ?? {};
  const customFieldIds = [...new Set([acceptanceField, storyPointsField, sprintField, ...extraFields].filter(Boolean))];
  const customFields = Object.fromEntries(customFieldIds
    .filter((fieldId) => fieldId in fields)
    .map((fieldId) => [names[fieldId] ?? fieldId, normalizeCustomValue(fields[fieldId])]));

  const links = (fields.issuelinks ?? []).flatMap((link) => {
    const result = [];
    if (link.outwardIssue) result.push({
      direction: 'outward',
      relationship: link.type?.outward ?? link.type?.name ?? null,
      issue: normalizeLinkedIssue(link.outwardIssue)
    });
    if (link.inwardIssue) result.push({
      direction: 'inward',
      relationship: link.type?.inward ?? link.type?.name ?? null,
      issue: normalizeLinkedIssue(link.inwardIssue)
    });
    return result;
  });

  return {
    type: 'jira',
    id: issue.id ?? null,
    key: issue.key,
    title: fields.summary ?? issue.key,
    issueType: fields.issuetype?.name ?? null,
    project: fields.project ? {
      id: fields.project.id ?? null,
      key: fields.project.key ?? null,
      name: fields.project.name ?? null
    } : null,
    description: adfToText(fields.description),
    environment: adfToText(fields.environment),
    acceptanceCriteria: acceptanceField ? adfToText(fields[acceptanceField]) : '',
    storyPoints: storyPointsField ? fields[storyPointsField] ?? null : null,
    sprints: sprintField ? normalizeSprint(fields[sprintField]) : [],
    status: fields.status?.name ?? null,
    statusCategory: fields.status?.statusCategory?.name ?? null,
    resolution: fields.resolution?.name ?? null,
    priority: fields.priority?.name ?? null,
    assignee: userName(fields.assignee),
    assigneeAccountId: fields.assignee?.accountId ?? null,
    reporter: userName(fields.reporter),
    reporterAccountId: fields.reporter?.accountId ?? null,
    creator: userName(fields.creator),
    labels: fields.labels ?? [],
    components: (fields.components ?? []).map((item) => item.name).filter(Boolean),
    fixVersions: (fields.fixVersions ?? []).map((item) => ({
      id: item.id ?? null,
      name: item.name ?? null,
      released: item.released ?? false,
      releaseDate: item.releaseDate ?? null
    })),
    parent: fields.parent ? {
      id: fields.parent.id ?? null,
      key: fields.parent.key,
      title: fields.parent.fields?.summary ?? null,
      issueType: fields.parent.fields?.issuetype?.name ?? null,
      status: fields.parent.fields?.status?.name ?? null
    } : null,
    subtasks: (fields.subtasks ?? []).map(normalizeLinkedIssue).filter(Boolean),
    issueLinks: links,
    attachments: (fields.attachment ?? []).map((item) => ({
      id: item.id ?? null,
      filename: item.filename ?? null,
      mimeType: item.mimeType ?? null,
      size: item.size ?? null,
      createdAt: item.created ?? null,
      author: userName(item.author),
      url: item.content ?? null
    })),
    dueDate: fields.duedate ?? null,
    createdAt: fields.created ?? null,
    updatedAt: fields.updated ?? null,
    resolutionDate: fields.resolutiondate ?? null,
    customFields,
    url: baseUrl && issue.key ? `${baseUrl}/browse/${issue.key}` : null,
    fetchedAt: new Date().toISOString()
  };
}

async function request(apiPath, {
  method = 'GET',
  body,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const credentials = jiraCredentials(env);
  if (typeof fetchImpl !== 'function') throw new SingularityFlowError('This Node.js runtime does not provide fetch().');
  const response = await fetchImpl(`${credentials.baseUrl}${apiPath}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64')}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!response.ok) {
    const detail = typeof payload === 'string'
      ? payload
      : payload?.errorMessages?.join('; ') || payload?.message || JSON.stringify(payload);
    throw new SingularityFlowError(`Jira request failed (${response.status}): ${detail}`);
  }
  return { payload, credentials };
}

const STANDARD_FIELDS = [
  'summary', 'description', 'environment', 'status', 'resolution', 'priority',
  'assignee', 'reporter', 'creator', 'issuetype', 'project', 'labels', 'components',
  'parent', 'subtasks', 'issuelinks', 'fixVersions', 'attachment', 'duedate',
  'created', 'updated', 'resolutiondate'
];

function envFields(env = process.env) {
  return String(env.SINGULARITY_FLOW_JIRA_EXTRA_FIELDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function getIssue(key, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  acceptanceField = env.SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD,
  storyPointsField = env.SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD,
  sprintField = env.SINGULARITY_FLOW_JIRA_SPRINT_FIELD,
  extraFields = envFields(env)
} = {}) {
  const fields = [...new Set([...STANDARD_FIELDS, acceptanceField, storyPointsField, sprintField, ...extraFields].filter(Boolean))];
  const query = new URLSearchParams({ fields: fields.join(','), expand: 'names' });
  const { payload, credentials } = await request(`/rest/api/3/issue/${encodeURIComponent(key)}?${query}`, { env, fetchImpl });
  return normalizeIssue(payload, { baseUrl: credentials.baseUrl, acceptanceField, storyPointsField, sprintField, extraFields });
}

export async function listMyIssues({
  project,
  issueType = 'Story',
  limit = 25,
  jql,
  env = process.env,
  fetchImpl = globalThis.fetch,
  acceptanceField = env.SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD,
  storyPointsField = env.SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD,
  sprintField = env.SINGULARITY_FLOW_JIRA_SPRINT_FIELD,
  extraFields = envFields(env)
} = {}) {
  const clauses = [];
  if (project) clauses.push(`project = ${JSON.stringify(project)}`);
  clauses.push('assignee = currentUser()');
  if (issueType) clauses.push(`issuetype = ${JSON.stringify(issueType)}`);
  clauses.push('statusCategory != Done');
  const resolvedJql = jql || `${clauses.join(' AND ')} ORDER BY priority DESC, updated DESC`;
  const fields = [...new Set([...STANDARD_FIELDS, acceptanceField, storyPointsField, sprintField, ...extraFields].filter(Boolean))];
  const { payload, credentials } = await request('/rest/api/3/search/jql', {
    method: 'POST',
    body: { jql: resolvedJql, fields, maxResults: Math.max(1, Math.min(Number(limit) || 25, 100)), expand: 'names' },
    env,
    fetchImpl
  });
  return {
    jql: resolvedJql,
    issues: (payload?.issues ?? []).map((issue) => normalizeIssue(issue, {
      baseUrl: credentials.baseUrl,
      acceptanceField,
      storyPointsField,
      sprintField,
      extraFields
    })),
    isLast: payload?.isLast ?? true,
    nextPageToken: payload?.nextPageToken ?? null
  };
}

export async function listFields({
  query,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const { payload } = await request('/rest/api/3/field', { env, fetchImpl });
  const needle = String(query ?? '').trim().toLowerCase();
  return (Array.isArray(payload) ? payload : [])
    .filter((field) => !needle || `${field.id} ${field.name}`.toLowerCase().includes(needle))
    .map((field) => ({
      id: field.id,
      name: field.name,
      custom: Boolean(field.custom),
      type: field.schema?.type ?? null,
      customType: field.schema?.custom ?? null
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function searchIssues(jql, {
  fields = ['summary', 'status', 'issuetype', 'parent', 'labels'],
  limit = 50,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!String(jql ?? '').trim()) throw new SingularityFlowError('Jira search requires JQL.');
  const { payload, credentials } = await request('/rest/api/3/search/jql', {
    method: 'POST',
    body: { jql: String(jql), fields, maxResults: Math.max(1, Math.min(Number(limit) || 50, 100)) },
    env,
    fetchImpl
  });
  return (payload?.issues ?? []).map((issue) => normalizeIssue(issue, { baseUrl: credentials.baseUrl }));
}

function adfParagraph(text) {
  return {
    type: 'doc',
    version: 1,
    content: String(text ?? '').split(/\r?\n/).filter(Boolean).map((lineValue) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: lineValue }]
    }))
  };
}

export async function createIssue({
  projectKey,
  issueType,
  summary,
  description,
  parentKey = null,
  labels = [],
  fields = {}
} = {}, {
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!projectKey || !issueType || !summary) throw new SingularityFlowError('Jira issue creation requires projectKey, issueType, and summary.');
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { name: issueType },
      summary,
      description: adfParagraph(description),
      labels: [...new Set(labels)],
      ...(parentKey ? { parent: { key: parentKey } } : {}),
      ...fields
    }
  };
  const { payload, credentials } = await request('/rest/api/3/issue', { method: 'POST', body, env, fetchImpl });
  return {
    id: payload?.id ?? null,
    key: payload?.key ?? null,
    url: payload?.key ? `${credentials.baseUrl}/browse/${payload.key}` : null
  };
}

export async function findOrCreateIssue({
  idempotencyLabel,
  ...issue
} = {}, options = {}) {
  if (!idempotencyLabel || !/^[A-Za-z0-9_-]+$/.test(idempotencyLabel)) throw new SingularityFlowError('Jira idempotencyLabel must contain letters, numbers, underscores, or hyphens.');
  const existing = await searchIssues(`labels = ${JSON.stringify(idempotencyLabel)} ORDER BY created ASC`, { ...options, limit: 2 });
  if (existing.length) return { id: existing[0].id, key: existing[0].key, url: existing[0].url, created: false };
  return { ...await createIssue({ ...issue, labels: [...(issue.labels ?? []), idempotencyLabel] }, options), created: true };
}

function line(label, value) {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
  return `- ${label}: ${Array.isArray(value) ? value.join(', ') : value}`;
}

function section(title, content) {
  const value = String(content ?? '').trim();
  return value ? `\n## ${title}\n\n${value}\n` : '';
}

export function issueToMarkdown(issue) {
  const metadata = [
    line('URL', issue.url),
    line('Type', issue.issueType),
    line('Project', issue.project ? `${issue.project.key ?? ''}${issue.project.name ? ` — ${issue.project.name}` : ''}` : null),
    line('Status', issue.statusCategory && issue.statusCategory !== issue.status ? `${issue.status} (${issue.statusCategory})` : issue.status),
    line('Resolution', issue.resolution),
    line('Priority', issue.priority),
    line('Assignee', issue.assignee),
    line('Reporter', issue.reporter),
    line('Creator', issue.creator),
    line('Parent', issue.parent ? `${issue.parent.key}${issue.parent.title ? ` — ${issue.parent.title}` : ''}` : null),
    line('Story points', issue.storyPoints),
    line('Sprint', issue.sprints?.map((sprint) => `${sprint.name ?? sprint.id ?? 'unnamed'}${sprint.state ? ` [${sprint.state}]` : ''}`)),
    line('Due date', issue.dueDate),
    line('Created', issue.createdAt),
    line('Updated', issue.updatedAt),
    line('Labels', issue.labels),
    line('Components', issue.components),
    line('Fix versions', issue.fixVersions?.map((version) => version.name).filter(Boolean)),
    line('Fetched', issue.fetchedAt)
  ].filter(Boolean).join('\n');

  const subtasks = issue.subtasks?.map((item) => `- ${item.key}${item.status ? ` [${item.status}]` : ''}${item.title ? ` — ${item.title}` : ''}`).join('\n');
  const links = issue.issueLinks?.map((item) => `- ${item.relationship ?? 'Related to'}: ${item.issue?.key ?? 'unknown'}${item.issue?.status ? ` [${item.issue.status}]` : ''}${item.issue?.title ? ` — ${item.issue.title}` : ''}`).join('\n');
  const attachments = issue.attachments?.map((item) => `- ${item.filename ?? item.id}${item.mimeType ? ` (${item.mimeType}` : ''}${item.size != null ? `, ${item.size} bytes` : ''}${item.mimeType ? ')' : ''}`).join('\n');
  const customFields = Object.entries(issue.customFields ?? {})
    .map(([name, value]) => `- ${name}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join('\n');

  return `# ${issue.key} — ${issue.title}\n\n${metadata}\n${section('Description', issue.description || '_No description provided._')}${section('Acceptance criteria', issue.acceptanceCriteria || '_No acceptance-criteria field was configured or populated._')}${section('Environment', issue.environment)}${section('Subtasks', subtasks)}${section('Linked issues', links)}${section('Attachments', attachments)}${section('Configured custom fields', customFields)}`.trimEnd() + '\n';
}
