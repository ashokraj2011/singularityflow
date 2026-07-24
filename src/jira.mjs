import { SingularityFlowError } from './util.mjs';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const JIRA_DEPLOYMENTS = new Set(['cloud', 'data-center']);
const JIRA_AUTH_MODES = new Set(['user-token', 'service-account', 'pat']);
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_RETRIES = 5;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_SEARCH_RESULTS = 500;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function jiraFailure(message, { status = null, category = 'request', retryAfter = null } = {}) {
  const error = new SingularityFlowError(message);
  error.status = status;
  error.category = category;
  error.retryAfter = retryAfter;
  return error;
}

function normalizeHttpsUrl(value, label = 'Jira URL') {
  let parsed;
  try { parsed = new URL(String(value ?? '')); } catch {
    throw new SingularityFlowError(`${label} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:') throw new SingularityFlowError(`${label} must use HTTPS.`);
  if (parsed.username || parsed.password) throw new SingularityFlowError(`${label} must not contain embedded credentials.`);
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

export function normalizeJiraConnection(input = {}) {
  const deployment = String(input.deployment ?? 'cloud').toLowerCase();
  if (!JIRA_DEPLOYMENTS.has(deployment)) throw new SingularityFlowError('Jira deployment must be cloud or data-center.');
  const baseUrl = normalizeHttpsUrl(input.baseUrl);
  const mode = String(input.auth?.mode ?? input.authMode ?? (deployment === 'data-center' ? 'pat' : 'user-token')).toLowerCase();
  if (!JIRA_AUTH_MODES.has(mode)) throw new SingularityFlowError('Jira authentication mode must be user-token, service-account, or pat.');
  if (deployment === 'data-center' && mode !== 'pat') throw new SingularityFlowError('Jira Data Center uses PAT authentication in this connector.');
  if (deployment === 'cloud' && mode === 'pat') throw new SingularityFlowError('Jira Cloud uses an API token with an email or service-account identity.');

  const email = input.auth?.email ?? input.email ?? null;
  const token = input.auth?.token ?? input.apiToken ?? input.token ?? null;
  if (!token) throw new SingularityFlowError('A Jira API token or PAT is required.');
  if (mode !== 'pat' && !email) throw new SingularityFlowError('Jira Cloud authentication requires an email address.');

  const cloudId = input.cloudId ? String(input.cloudId).trim() : null;
  const apiBaseUrl = cloudId
    ? `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}`
    : baseUrl;
  return {
    name: String(input.name ?? 'jira').trim() || 'jira',
    deployment,
    baseUrl,
    apiBaseUrl,
    apiVersion: deployment === 'cloud' ? '3' : '2',
    cloudId,
    auth: { mode, email: email ? String(email).trim() : null, token: String(token) }
  };
}

export function jiraCredentials(env = process.env) {
  const baseUrl = env.JIRA_BASE_URL?.replace(/\/$/, '');
  const deployment = String(env.JIRA_DEPLOYMENT ?? 'cloud').toLowerCase();
  const email = env.JIRA_EMAIL ?? null;
  const apiToken = env.JIRA_API_TOKEN ?? env.JIRA_PAT;
  if (!baseUrl || !apiToken || (deployment !== 'data-center' && !email)) {
    throw new SingularityFlowError('Jira access requires JIRA_BASE_URL plus JIRA_EMAIL and JIRA_API_TOKEN for Cloud, or JIRA_PAT for Data Center. Singularity Flow never accepts or stores a password.');
  }
  return { baseUrl, email, apiToken, deployment };
}

export function jiraConnectionFromEnv(env = process.env) {
  const credentials = jiraCredentials(env);
  return normalizeJiraConnection({
    baseUrl: credentials.baseUrl,
    deployment: credentials.deployment,
    email: credentials.email,
    token: credentials.apiToken,
    authMode: credentials.deployment === 'data-center' ? 'pat' : (env.JIRA_AUTH_MODE ?? 'user-token'),
    cloudId: env.JIRA_CLOUD_ID,
    name: env.JIRA_CONNECTION_NAME ?? 'environment'
  });
}

export function quoteJql(value) {
  return JSON.stringify(String(value ?? ''));
}

function validateProjectKey(value) {
  const key = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) throw new SingularityFlowError(`Invalid Jira project key: ${value ?? ''}`);
  return key;
}

export function assertJiraProjectPolicy(value, policy = {}, label = 'Jira project') {
  const key = validateProjectKey(value);
  if (policy.allowedProjects?.length && !policy.allowedProjects.includes(key)) {
    throw new SingularityFlowError(`${label} ${key} is outside the configured allowedProjects.`);
  }
  return key;
}

export function assertJiraIssuePolicy(value, policy = {}, label = 'Jira issue') {
  const key = validateIssueKey(value, `${label} key`);
  assertJiraProjectPolicy(key.slice(0, key.lastIndexOf('-')), policy, `${label} project`);
  return key;
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
    issueTypeId: fields.issuetype?.id ?? null,
    hierarchyLevel: fields.issuetype?.hierarchyLevel ?? null,
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

export function resolveJiraConnection({ connection, env = process.env } = {}) {
  return connection ? normalizeJiraConnection(connection) : jiraConnectionFromEnv(env);
}

export function assertJiraConnectionPolicy(connection, policy = {}) {
  const resolved = normalizeJiraConnection(connection);
  const hostname = new URL(resolved.baseUrl).hostname.toLowerCase();
  if (policy.allowedHosts?.length && !policy.allowedHosts.includes(hostname)) {
    throw new SingularityFlowError(`Jira host ${hostname} is outside the Jira allowlist.`);
  }
  if (policy.deployment && resolved.deployment !== policy.deployment) {
    throw new SingularityFlowError(`Repository policy requires Jira ${policy.deployment}.`);
  }
  if (policy.authentication?.permitted?.length && !policy.authentication.permitted.includes(resolved.auth.mode)) {
    throw new SingularityFlowError(`Jira authentication mode ${resolved.auth.mode} is not permitted by repository policy.`);
  }
  return resolved;
}

function resolveConnection(options = {}) {
  return resolveJiraConnection(options);
}

function restPath(connection, suffix) {
  return `/rest/api/${connection.apiVersion}/${String(suffix).replace(/^\/+/, '')}`;
}

function authorizationHeader(connection) {
  if (connection.auth.mode === 'pat') return `Bearer ${connection.auth.token}`;
  return `Basic ${Buffer.from(`${connection.auth.email}:${connection.auth.token}`).toString('base64')}`;
}

function jiraApiTarget(apiPath, connection) {
  const relative = String(apiPath ?? '');
  if (
    !relative.startsWith('/')
    || relative.startsWith('//')
    || relative.includes('\\')
    || /[\u0000-\u001F\u007F]/.test(relative)
  ) {
    throw new SingularityFlowError('Jira requests require a relative Jira API path beginning with one forward slash.');
  }
  const base = new URL(connection.apiBaseUrl);
  const target = new URL(`${connection.apiBaseUrl}${relative}`);
  const basePath = base.pathname.replace(/\/+$/, '');
  if (
    target.origin !== base.origin
    || (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`))
  ) {
    throw new SingularityFlowError('Jira request path escapes the configured Jira API base.');
  }
  return target.href;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}

function retryDelay(response, attempt) {
  const header = response.headers?.get?.('retry-after');
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(500 * (2 ** attempt), 8_000);
}

function responseSizeFailure(maxBytes) {
  return jiraFailure(`Jira response exceeds the configured ${maxBytes} bytes limit. Narrow the query or ask the Jira administrator to inspect the endpoint.`, {
    category: 'response-size'
  });
}

async function readBoundedResponseText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw responseSizeFailure(maxBytes);
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw responseSizeFailure(maxBytes);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw responseSizeFailure(maxBytes);
  return text;
}

export async function jiraRequest(apiPath, {
  method = 'GET',
  body,
  env = process.env,
  connection,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxRetries = 3,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
} = {}) {
  const resolved = resolveConnection({ connection, env });
  if (typeof fetchImpl !== 'function') throw new SingularityFlowError('This Node.js runtime does not provide fetch().');
  const target = jiraApiTarget(apiPath, resolved);
  const retries = boundedInteger(maxRetries, 3, 0, MAX_REQUEST_RETRIES);
  const timeoutMs = boundedInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1, MAX_REQUEST_TIMEOUT_MS);
  const responseLimit = boundedInteger(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, MAX_RESPONSE_BYTES);
  let attempt = 0;
  while (true) {
    let response;
    let text = null;
    let requestError = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetchImpl(target, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: authorizationHeader(resolved)
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= retries) {
        text = await readBoundedResponseText(response, responseLimit);
      }
    } catch (error) {
      requestError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (requestError) {
      const timedOut = controller.signal.aborted;
      if (!timedOut && requestError?.category) throw requestError;
      if (attempt < retries) {
        await sleep(Math.min(500 * (2 ** attempt), 8_000));
        attempt += 1;
        continue;
      }
      if (timedOut) {
        throw jiraFailure(`Jira request timed out after ${timeoutMs} milliseconds. Check the Jira URL, VPN, proxy, and firewall, then try again.`, {
          category: 'timeout'
        });
      }
      throw jiraFailure(`Jira is unreachable: ${requestError.message}`, { category: 'network' });
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
      await sleep(retryDelay(response, attempt));
      attempt += 1;
      continue;
    }
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw jiraFailure('Jira returned a non-JSON success response. Check whether a proxy, SSO gateway, or incorrect base URL intercepted the API request.', {
            category: 'response'
          });
        }
        payload = text;
      }
    }
    if (!response.ok) {
      const detail = typeof payload === 'string'
        ? payload
        : payload?.errorMessages?.join('; ') || payload?.errors && JSON.stringify(payload.errors) || payload?.message || JSON.stringify(payload);
      const category = response.status === 401 ? 'authentication'
        : response.status === 403 ? 'authorization'
          : response.status === 404 ? 'not-found'
            : response.status === 409 ? 'conflict'
              : response.status === 429 ? 'rate-limit' : 'request';
      throw jiraFailure(`Jira request failed (${response.status}): ${detail}`, {
        status: response.status,
        category,
        retryAfter: response.headers?.get?.('retry-after') ?? null
      });
    }
    return { payload };
  }
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
  connection,
  fetchImpl = globalThis.fetch,
  acceptanceField = env.SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD,
  storyPointsField = env.SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD,
  sprintField = env.SINGULARITY_FLOW_JIRA_SPRINT_FIELD,
  extraFields = envFields(env)
} = {}) {
  const resolved = resolveConnection({ connection, env });
  const requestedKey = validateIssueKey(key);
  const fields = [...new Set([...STANDARD_FIELDS, acceptanceField, storyPointsField, sprintField, ...extraFields].filter(Boolean))];
  const query = new URLSearchParams({ fields: fields.join(','), expand: 'names' });
  const { payload } = await jiraRequest(`${restPath(resolved, `issue/${encodeURIComponent(requestedKey)}`)}?${query}`, { connection: resolved, fetchImpl });
  const returnedKey = String(payload?.key ?? '').trim().toUpperCase();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || returnedKey !== requestedKey) {
    throw jiraFailure(`Jira returned ${returnedKey || 'an invalid payload'} for requested issue ${requestedKey}.`, {
      category: 'response'
    });
  }
  return normalizeIssue(payload, { baseUrl: resolved.baseUrl, acceptanceField, storyPointsField, sprintField, extraFields });
}

export async function listMyIssues({
  project,
  issueType = 'Story',
  limit = 25,
  jql,
  env = process.env,
  connection,
  fetchImpl = globalThis.fetch,
  acceptanceField = env.SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD,
  storyPointsField = env.SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD,
  sprintField = env.SINGULARITY_FLOW_JIRA_SPRINT_FIELD,
  extraFields = envFields(env)
} = {}) {
  const resolved = resolveConnection({ connection, env });
  const clauses = [];
  if (project) clauses.push(`project = ${quoteJql(validateProjectKey(project))}`);
  clauses.push('assignee = currentUser()');
  if (issueType) clauses.push(`issuetype = ${quoteJql(issueType)}`);
  clauses.push('statusCategory != Done');
  const resolvedJql = jql || `${clauses.join(' AND ')} ORDER BY priority DESC, updated DESC`;
  const fields = [...new Set([...STANDARD_FIELDS, acceptanceField, storyPointsField, sprintField, ...extraFields].filter(Boolean))];
  const searchPath = resolved.deployment === 'cloud' ? 'search/jql' : 'search';
  const { payload } = await jiraRequest(restPath(resolved, searchPath), {
    method: 'POST',
    body: { jql: resolvedJql, fields, maxResults: Math.max(1, Math.min(Number(limit) || 25, 100)), expand: 'names' },
    connection: resolved,
    fetchImpl
  });
  return {
    jql: resolvedJql,
    issues: (payload?.issues ?? []).map((issue) => normalizeIssue(issue, {
      baseUrl: resolved.baseUrl,
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
  connection,
  fetchImpl = globalThis.fetch
} = {}) {
  const resolved = resolveConnection({ connection, env });
  const { payload } = await jiraRequest(restPath(resolved, 'field'), { connection: resolved, fetchImpl });
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
  connection,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!String(jql ?? '').trim()) throw new SingularityFlowError('Jira search requires JQL.');
  const resolved = resolveConnection({ connection, env });
  const searchPath = resolved.deployment === 'cloud' ? 'search/jql' : 'search';
  const requested = boundedInteger(limit, 50, 1, MAX_SEARCH_RESULTS);
  const issues = [];
  const seenIssues = new Set();
  const seenCloudTokens = new Set();
  let nextPageToken = null;
  let startAt = 0;
  while (issues.length < requested) {
    const maxResults = Math.min(100, requested - issues.length);
    const body = resolved.deployment === 'cloud'
      ? {
          jql: String(jql),
          fields,
          maxResults,
          ...(nextPageToken ? { nextPageToken } : {})
        }
      : { jql: String(jql), fields, maxResults, startAt };
    const { payload } = await jiraRequest(restPath(resolved, searchPath), {
      method: 'POST',
      body,
      connection: resolved,
      fetchImpl
    });
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.issues)) {
      throw jiraFailure('Jira search response does not contain an issues array.', { category: 'response' });
    }
    const page = payload.issues;
    const accepted = page.slice(0, requested - issues.length);
    for (const issue of accepted) {
      const identity = String(issue?.key ?? issue?.id ?? '').trim();
      if (!identity) throw jiraFailure('Jira returned an issue without a key or ID.', { category: 'response' });
      if (seenIssues.has(identity)) {
        throw jiraFailure(`Jira returned duplicate issue ${identity} across paginated results. Refresh after Jira ordering stabilizes.`, {
          category: 'response'
        });
      }
      seenIssues.add(identity);
      issues.push(issue);
    }
    if (resolved.deployment === 'cloud') {
      if (payload?.isLast === true || !page.length) break;
      const token = payload?.nextPageToken == null ? '' : String(payload.nextPageToken);
      if (!token) break;
      if (seenCloudTokens.has(token)) {
        throw jiraFailure('Jira Cloud returned a repeated pagination token.', { category: 'response' });
      }
      seenCloudTokens.add(token);
      nextPageToken = token;
      continue;
    }
    const providedStart = payload.startAt == null ? Number.NaN : Number(payload.startAt);
    if (Number.isFinite(providedStart) && providedStart !== startAt) {
      throw jiraFailure(`Jira Data Center pagination did not advance to requested offset ${startAt}; it returned ${providedStart}.`, {
        category: 'response'
      });
    }
    const pageStart = Number.isFinite(providedStart) ? providedStart : startAt;
    const nextStart = pageStart + page.length;
    const total = payload.total == null ? Number.NaN : Number(payload.total);
    if (!page.length || (Number.isFinite(total) && nextStart >= total) || (!Number.isFinite(total) && page.length < maxResults)) break;
    startAt = nextStart;
  }
  return issues.map((issue) => normalizeIssue(issue, { baseUrl: resolved.baseUrl }));
}

export function adfParagraph(text) {
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
  connection,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!projectKey || !issueType || !summary) throw new SingularityFlowError('Jira issue creation requires projectKey, issueType, and summary.');
  const resolved = resolveConnection({ connection, env });
  const body = {
    fields: {
      project: { key: validateProjectKey(projectKey) },
      issuetype: /^\d+$/.test(String(issueType)) ? { id: String(issueType) } : { name: issueType },
      summary,
      description: resolved.deployment === 'cloud' ? adfParagraph(description) : String(description ?? ''),
      labels: [...new Set(labels)],
      ...(parentKey ? { parent: { key: parentKey } } : {}),
      ...fields
    }
  };
  const { payload } = await jiraRequest(restPath(resolved, 'issue'), { method: 'POST', body, connection: resolved, fetchImpl });
  return {
    id: payload?.id ?? null,
    key: payload?.key ?? null,
    url: payload?.key ? `${resolved.baseUrl}/browse/${payload.key}` : null
  };
}

export async function findOrCreateIssue({
  idempotencyLabel,
  ...issue
} = {}, options = {}) {
  if (!idempotencyLabel || !/^[A-Za-z0-9_-]+$/.test(idempotencyLabel)) throw new SingularityFlowError('Jira idempotencyLabel must contain letters, numbers, underscores, or hyphens.');
  const existing = await searchIssues(`labels = ${quoteJql(idempotencyLabel)} ORDER BY created ASC`, { ...options, limit: 2 });
  if (existing.length) return { id: existing[0].id, key: existing[0].key, url: existing[0].url, created: false };
  return { ...await createIssue({ ...issue, labels: [...(issue.labels ?? []), idempotencyLabel] }, options), created: true };
}

export async function getCurrentUser(options = {}) {
  const resolved = resolveConnection(options);
  const { payload } = await jiraRequest(restPath(resolved, 'myself'), { ...options, connection: resolved });
  const accountId = payload?.accountId ?? payload?.key ?? payload?.name ?? null;
  const displayName = payload?.displayName ?? payload?.name ?? null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (!accountId && !displayName)) {
    throw jiraFailure('Jira current-user response does not contain a current-user identity.', { category: 'response' });
  }
  return {
    accountId,
    displayName,
    email: payload?.emailAddress ?? null,
    active: payload?.active !== false,
    locale: payload?.locale ?? null,
    timeZone: payload?.timeZone ?? null
  };
}

export async function getServerInfo(options = {}) {
  const resolved = resolveConnection(options);
  const { payload } = await jiraRequest(restPath(resolved, 'serverInfo'), { ...options, connection: resolved });
  return {
    deployment: resolved.deployment,
    baseUrl: resolved.baseUrl,
    version: payload?.version ?? null,
    buildNumber: payload?.buildNumber ?? null,
    serverTitle: payload?.serverTitle ?? null,
    deploymentType: payload?.deploymentType ?? (resolved.deployment === 'cloud' ? 'Cloud' : 'Data Center')
  };
}

export async function listProjects({
  query,
  limit = 50,
  ...options
} = {}) {
  const resolved = resolveConnection(options);
  const suffix = resolved.deployment === 'cloud'
    ? `project/search?${new URLSearchParams({ maxResults: String(Math.max(1, Math.min(Number(limit) || 50, 100))), ...(query ? { query: String(query) } : {}) })}`
    : 'project';
  const { payload } = await jiraRequest(restPath(resolved, suffix), { ...options, connection: resolved });
  const values = Array.isArray(payload) ? payload : (payload?.values ?? []);
  return values.map((project) => ({
    id: project.id ?? null,
    key: project.key ?? null,
    name: project.name ?? project.key ?? null,
    projectType: project.projectTypeKey ?? null,
    simplified: project.simplified ?? null,
    url: project.key ? `${resolved.baseUrl}/browse/${project.key}` : null
  }));
}

export async function getMyPermissions(projectKey, options = {}) {
  const resolved = resolveConnection(options);
  const query = new URLSearchParams({
    projectKey: validateProjectKey(projectKey),
    permissions: 'BROWSE_PROJECTS,CREATE_ISSUES,EDIT_ISSUES,ADD_COMMENTS'
  });
  const { payload } = await jiraRequest(`${restPath(resolved, 'mypermissions')}?${query}`, { ...options, connection: resolved });
  return Object.fromEntries(Object.entries(payload?.permissions ?? {}).map(([key, permission]) => [key, {
    id: permission.id ?? null,
    name: permission.name ?? key,
    havePermission: Boolean(permission.havePermission)
  }]));
}

export async function listIssueTypes(projectKey, options = {}) {
  const resolved = resolveConnection(options);
  if (resolved.deployment === 'cloud') {
    const { payload } = await jiraRequest(restPath(resolved, `issue/createmeta/${encodeURIComponent(validateProjectKey(projectKey))}/issuetypes`), {
      ...options,
      connection: resolved
    });
    return (payload?.issueTypes ?? payload?.values ?? []).map((type) => ({
      id: type.id ?? null,
      name: type.name ?? null,
      subtask: Boolean(type.subtask),
      hierarchyLevel: type.hierarchyLevel ?? null
    }));
  }
  const query = new URLSearchParams({ projectKeys: validateProjectKey(projectKey), expand: 'projects.issuetypes' });
  const { payload } = await jiraRequest(`${restPath(resolved, 'issue/createmeta')}?${query}`, { ...options, connection: resolved });
  return (payload?.projects?.[0]?.issuetypes ?? []).map((type) => ({
    id: type.id ?? null,
    name: type.name ?? null,
    subtask: Boolean(type.subtask),
    hierarchyLevel: type.hierarchyLevel ?? null
  }));
}

export async function discoverJiraConnection(options = {}) {
  const resolved = resolveConnection(options);
  const discoveryOptions = {
    ...options,
    connection: resolved,
    maxRetries: options.maxRetries ?? 1,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  };
  const [server, account, projects] = await Promise.all([
    getServerInfo(discoveryOptions),
    getCurrentUser(discoveryOptions),
    listProjects({ ...discoveryOptions, limit: 25 })
  ]);
  return {
    connected: true,
    name: resolved.name,
    deployment: resolved.deployment,
    baseUrl: resolved.baseUrl,
    account,
    server,
    projects,
    discoveredAt: new Date().toISOString()
  };
}

export async function listEpics(projectKey, {
  issueType = 'Epic',
  limit = 100,
  ...options
} = {}) {
  const key = validateProjectKey(projectKey);
  return searchIssues(`project = ${quoteJql(key)} AND issuetype = ${quoteJql(issueType)} ORDER BY updated DESC`, {
    ...options,
    limit,
    fields: [...STANDARD_FIELDS]
  });
}

export async function listEpicStories(epicKey, {
  limit = 100,
  ...options
} = {}) {
  if (!/^[A-Za-z][A-Za-z0-9_-]*-\d+$/.test(String(epicKey ?? ''))) throw new SingularityFlowError('A valid Jira Epic key is required.');
  return searchIssues(`(parent = ${quoteJql(epicKey)} OR "Epic Link" = ${quoteJql(epicKey)}) ORDER BY rank, key`, {
    ...options,
    limit,
    fields: [...STANDARD_FIELDS]
  });
}

function validateIssueKey(value, label = 'Jira issue key') {
  const key = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]*-\d+$/.test(key)) throw new SingularityFlowError(`A valid ${label} is required.`);
  return key;
}

export async function listWorkspaceAnchors(projectKey, {
  limit = 100,
  ...options
} = {}) {
  const key = validateProjectKey(projectKey);
  const types = await listIssueTypes(key, options);
  const effectiveLevel = (type) => Number.isInteger(Number(type.hierarchyLevel))
    ? Number(type.hierarchyLevel)
    : String(type.name).toLowerCase() === 'epic' ? 1 : null;
  const anchorTypes = types.filter((type) => Number(effectiveLevel(type)) >= 1);
  if (!anchorTypes.length) return [];
  const typeIds = anchorTypes.map((type) => quoteJql(type.id ?? type.name));
  const issues = await searchIssues(`project = ${quoteJql(key)} AND issuetype in (${typeIds.join(', ')}) ORDER BY updated DESC`, {
    ...options,
    limit,
    fields: [...STANDARD_FIELDS]
  });
  const levels = new Map(anchorTypes.flatMap((type) => [[String(type.id), effectiveLevel(type)], [String(type.name), effectiveLevel(type)]]));
  return issues.map((issue) => ({
    ...issue,
    hierarchyLevel: issue.hierarchyLevel ?? levels.get(String(issue.issueTypeId)) ?? levels.get(String(issue.issueType)) ?? null
  })).filter((issue) => Number(issue.hierarchyLevel) >= 1);
}

export async function listIssueChildren(parentKey, {
  includeLegacyEpicLink = false,
  limit = 100,
  ...options
} = {}) {
  const key = validateIssueKey(parentKey, 'Jira parent key');
  const clause = includeLegacyEpicLink
    ? `(parent = ${quoteJql(key)} OR "Epic Link" = ${quoteJql(key)})`
    : `parent = ${quoteJql(key)}`;
  return searchIssues(`${clause} ORDER BY rank, key`, {
    ...options,
    limit,
    fields: [...STANDARD_FIELDS]
  });
}

export async function getIssueHierarchy(anchorKey, {
  maxDepth = 8,
  maxIssues = 500,
  ...options
} = {}) {
  const key = validateIssueKey(anchorKey, 'Jira workspace anchor key');
  const anchor = await getIssue(key, options);
  if (anchor.hierarchyLevel == null && String(anchor.issueType).toLowerCase() === 'epic') anchor.hierarchyLevel = 1;
  if (!Number.isInteger(Number(anchor.hierarchyLevel)) || Number(anchor.hierarchyLevel) < 1) {
    throw new SingularityFlowError(`Jira ${key} is '${anchor.issueType ?? 'unknown'}' at hierarchy level ${anchor.hierarchyLevel ?? 'unknown'}; choose an Epic or higher-level item.`);
  }
  const ancestors = [];
  let parent = anchor.parent;
  const visited = new Set([anchor.key]);
  while (parent?.key && ancestors.length < maxDepth) {
    if (visited.has(parent.key)) throw new SingularityFlowError(`Jira hierarchy cycle detected at ${parent.key}.`);
    visited.add(parent.key);
    const issue = await getIssue(parent.key, options);
    ancestors.unshift(issue);
    parent = issue.parent;
  }
  const descendants = [];
  const queue = [{ issue: anchor, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= maxDepth || descendants.length >= maxIssues) continue;
    const children = await listIssueChildren(current.issue.key, {
      ...options,
      includeLegacyEpicLink: Number(current.issue.hierarchyLevel) === 1,
      limit: Math.min(MAX_SEARCH_RESULTS, maxIssues - descendants.length)
    });
    for (const child of children) {
      if (visited.has(child.key)) throw new SingularityFlowError(`Jira hierarchy cycle detected at ${child.key}.`);
      visited.add(child.key);
      const record = { ...child, depth: current.depth + 1 };
      descendants.push(record);
      queue.push({ issue: record, depth: current.depth + 1 });
      if (descendants.length >= maxIssues) break;
    }
  }
  return {
    anchor,
    ancestors,
    descendants,
    tree: {
      key: anchor.key,
      title: anchor.title,
      issueType: anchor.issueType,
      hierarchyLevel: anchor.hierarchyLevel,
      children: descendants.filter((item) => item.parent?.key === anchor.key).map((item) => item.key)
    },
    fetchedAt: new Date().toISOString(),
    truncated: descendants.length >= maxIssues
  };
}

export async function updateIssue(key, fields, {
  expectedUpdatedAt = null,
  env = process.env,
  connection,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!key || !fields || typeof fields !== 'object' || Array.isArray(fields)) throw new SingularityFlowError('Jira update requires an issue key and fields.');
  const resolved = resolveConnection({ connection, env });
  if (expectedUpdatedAt) {
    const current = await getIssue(key, { connection: resolved, fetchImpl });
    if (current.updatedAt !== expectedUpdatedAt) {
      throw jiraFailure(`Jira issue ${key} changed after the write plan was created. Refresh the plan before applying it.`, { category: 'conflict', status: 409 });
    }
  }
  const normalizedFields = {
    ...fields,
    ...(typeof fields.description === 'string'
      ? { description: resolved.deployment === 'cloud' ? adfParagraph(fields.description) : fields.description }
      : {})
  };
  await jiraRequest(restPath(resolved, `issue/${encodeURIComponent(key)}`), {
    method: 'PUT',
    body: { fields: normalizedFields },
    connection: resolved,
    fetchImpl
  });
  return getIssue(key, { connection: resolved, fetchImpl });
}

export async function addComment(key, body, options = {}) {
  const resolved = resolveConnection(options);
  const content = resolved.deployment === 'cloud' ? adfParagraph(body) : String(body ?? '');
  const { payload } = await jiraRequest(restPath(resolved, `issue/${encodeURIComponent(key)}/comment`), {
    ...options,
    method: 'POST',
    body: { body: content },
    connection: resolved
  });
  return { id: payload?.id ?? null, createdAt: payload?.created ?? null };
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
