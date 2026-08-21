import { createHash } from 'node:crypto';

import { nowIso, run, SingularityFlowError } from './util.mjs';

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function cleanText(value, maximumLength = 128 * 1024) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, maximumLength);
}

function stringList(value, maximumItems = 100) {
  const items = Array.isArray(value) ? value : cleanText(value).split(/\r?\n/);
  return [...new Set(items.map((entry) => cleanText(entry, 4096)).filter(Boolean))].slice(0, maximumItems);
}

function safeScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { in: [], out: [] };
  return { in: stringList(value.in), out: stringList(value.out) };
}

function safeSubtasks(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry) => ({
    key: cleanText(entry?.key, 256),
    status: cleanText(entry?.status, 256),
    title: cleanText(entry?.title, 4096)
  })).filter((entry) => entry.key || entry.title);
}

function acceptanceSignals(body) {
  return [...new Set(cleanText(body).split('\n')
    .map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean))].slice(0, 100);
}

function safeIssueUrl(value) {
  if (!value) return null;
  let parsed;
  try { parsed = new URL(String(value)); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function optionalBoolean(value) {
  if (value == null || value === '') return null;
  return value === true || String(value).trim().toLowerCase() === 'true';
}

function repositoryCount(value) {
  if (value == null || value === '') return 1;
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? Math.min(count, 10_000) : 1;
}

function jiraStableId(source) {
  const url = safeIssueUrl(source.url);
  const host = url ? new URL(url).host.toLowerCase() : 'configured-jira';
  const identity = String(source.id ?? source.key ?? '').trim().toLowerCase();
  return identity ? `jira:${host}:${identity}` : null;
}

/** Normalize tracker and manual inputs without retaining credentials or provider payloads. */
export function normalizeWorkSource(source = {}, { rawRef = null, fetchedAt = null } = {}) {
  const type = source.type === 'github-issue' ? 'github-issue'
    : source.type === 'jira' ? 'jira' : 'manual';
  const title = cleanText(source.title, 4096);
  const description = cleanText(source.description);
  const rawCriteria = Array.isArray(source.acceptanceCriteria)
    ? source.acceptanceCriteria
    : cleanText(source.acceptanceCriteria).split(/\r?\n/);
  const acceptanceCriteria = [...new Set(rawCriteria
    .map((entry) => cleanText(entry).replace(/^[-*]\s+(?:\[[ xX]\]\s*)?/, ''))
    .filter(Boolean))].slice(0, 100);
  const stableId = type === 'github-issue'
    ? String(source.stableId ?? '').trim() || null
    : type === 'jira' ? jiraStableId(source) : null;
  const id = source.id == null ? null : cleanText(source.id, 512);
  const key = source.key == null ? null : cleanText(source.key, 512);
  const url = safeIssueUrl(source.url);
  // Provider payloads are deliberately projected through this allowlist. Credentials, response
  // headers, custom fields and other opaque tracker data must never enter governed artifacts.
  const content = {
    type, stableId, id, key, url, title, description, acceptanceCriteria,
    labels: stringList(source.labels).sort(),
    user: cleanText(source.user ?? source.audience, 4096),
    desiredOutcome: cleanText(source.desiredOutcome, 16 * 1024),
    scope: safeScope(source.scope),
    outOfScope: stringList(source.outOfScope),
    stakeholders: stringList(source.stakeholders),
    urgency: cleanText(source.urgency, 4096),
    constraints: stringList(source.constraints),
    dependencies: stringList(source.dependencies),
    risks: stringList(source.risks),
    // These declarations drive the deterministic quick-fix waiver. They are source facts rather
    // than provider payload, so normalisation must preserve them while still rejecting arbitrary
    // custom fields. Dropping `risk` silently widened every quick fix into human review.
    risk: cleanText(source.risk, 256) || null,
    repositoryCount: repositoryCount(source.repositoryCount),
    publicInterfaceChange: optionalBoolean(source.publicInterfaceChange),
    dataMigration: optionalBoolean(source.dataMigration),
    securityBoundaryChange: optionalBoolean(source.securityBoundaryChange),
    regulatedDataChange: optionalBoolean(source.regulatedDataChange),
    deploymentPolicyChange: optionalBoolean(source.deploymentPolicyChange),
    crossRepositoryChange: optionalBoolean(source.crossRepositoryChange),
    targetOrigin: cleanText(source.targetOrigin, 4096) || null,
    notes: cleanText(source.notes, 16 * 1024),
    epicId: source.epicId == null ? null : cleanText(source.epicId, 512),
    status: cleanText(source.status, 512),
    priority: cleanText(source.priority, 512),
    storyPoints: Number.isFinite(Number(source.storyPoints)) ? Number(source.storyPoints) : null,
    assignee: cleanText(source.assignee, 1024),
    subtasks: safeSubtasks(source.subtasks)
  };
  return {
    ...content,
    rawRef: rawRef ? cleanText(rawRef, 4096) : source.rawRef ? cleanText(source.rawRef, 4096) : null,
    fetchedAt: fetchedAt ?? source.fetchedAt ?? null,
    contentSha256: sha256(content)
  };
}

export function parseGitHubIssueReference(value, { defaultHost = 'github.com' } = {}) {
  let raw = String(value ?? '').trim();
  let host = defaultHost;
  let owner;
  let repository;
  let number;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('unsafe URL');
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
    if (!match) throw new Error('not an issue URL');
    host = parsed.host;
    [, owner, repository, number] = match;
    parsed.search = '';
    parsed.hash = '';
    raw = parsed.toString();
  } catch {
    const match = raw.match(/^([^\s/#]+)\/([^\s#]+)#(\d+)$/);
    if (!match) {
      throw new SingularityFlowError(
        "A GitHub Issue must be an HTTPS issue URL or 'owner/repository#number'.",
        { code: 'GITHUB_ISSUE_REFERENCE_INVALID' }
      );
    }
    [, owner, repository, number] = match;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(host) || !/^[A-Za-z0-9_.-]+$/.test(owner)
      || !/^[A-Za-z0-9_.-]+$/.test(repository) || !/^[1-9]\d*$/.test(number)) {
    throw new SingularityFlowError('The GitHub Issue reference contains an unsupported host, owner, repository, or number.', {
      code: 'GITHUB_ISSUE_REFERENCE_INVALID'
    });
  }
  return { raw, host: host.toLowerCase(), owner, repository, number: Number(number) };
}

/** Read one issue through the configured `gh` credential boundary. */
export async function getGitHubIssue(reference, {
  env = process.env, runCommand = run, fetchedAt = nowIso()
} = {}) {
  const parsed = parseGitHubIssueReference(reference, { defaultHost: env.GH_HOST ?? 'github.com' });
  const apiPath = `repos/${parsed.owner}/${parsed.repository}/issues/${parsed.number}`;
  const result = runCommand('gh', ['api', '--hostname', parsed.host, apiPath], {
    env, allowFailure: true, maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new SingularityFlowError(
      `GitHub Issue '${parsed.owner}/${parsed.repository}#${parsed.number}' could not be read through gh: `
      + `${(result.stderr || result.stdout || 'gh returned no diagnostic').trim()}`,
      { code: 'GITHUB_ISSUE_UNAVAILABLE' }
    );
  }
  let payload;
  try { payload = JSON.parse(result.stdout); } catch {
    throw new SingularityFlowError('GitHub returned an invalid Issue payload.', { code: 'GITHUB_ISSUE_RESPONSE_INVALID' });
  }
  if (payload.pull_request || Number(payload.number) !== parsed.number || !payload.title) {
    throw new SingularityFlowError('The GitHub reference did not resolve to the requested Issue.', {
      code: 'GITHUB_ISSUE_RESPONSE_INVALID'
    });
  }
  const stableId = `github-issue:${parsed.host}/${parsed.owner.toLowerCase()}/${parsed.repository.toLowerCase()}#${parsed.number}`;
  return normalizeWorkSource({
    type: 'github-issue', stableId,
    key: `${parsed.owner}/${parsed.repository}#${parsed.number}`,
    id: String(payload.id ?? payload.node_id ?? parsed.number),
    url: payload.html_url ?? `https://${parsed.host}/${parsed.owner}/${parsed.repository}/issues/${parsed.number}`,
    title: payload.title,
    description: payload.body ?? '',
    acceptanceCriteria: acceptanceSignals(payload.body),
    labels: (payload.labels ?? []).map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean)
  }, { rawRef: parsed.raw, fetchedAt });
}

export function workflowSourceIdentity(workflow) {
  return workflow?.workItem?.source?.stableId ?? null;
}
