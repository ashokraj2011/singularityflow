/**
 * After-step writers for targets that are not one HTTP post. Each takes one sealed outbox record
 * and returns an attempt result the outbox understands: delivered, retry (a transient failure),
 * failed (a person has to act) or unavailable (this machine lacks what the target needs).
 *
 * A writer looks for the delivery key at the remote before it writes, so a retry after an
 * uncertain outcome never writes twice. Nothing a remote returns changes governed state.
 */
import {
  addComment, assertJiraConnectionPolicy, assertJiraIssuePolicy, jiraConnectionFromEnv, jiraRequest,
  listIssueTransitions, setIssueProperty, uploadJiraAttachment
} from './jira.mjs';
import { DEFAULT_GIT_DELIVERY_PATH, jiraTransitionFor, renderGitDeliveryPath, stepActionText } from './step-actions.mjs';

const JIRA_PROPERTY_PREFIX = 'sflow.delivery.';
const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,9}$/;
const MAX_COMMENTS_SCANNED = 50;

/** The issue property that records one delivery on its Jira issue. */
export function jiraDeliveryProperty(key) {
  return `${JIRA_PROPERTY_PREFIX}${key}`;
}

/** The issue a jira action writes to: the target's own, or the issue the Story was started from. */
export function jiraIssueFor(record) {
  return record?.action?.targetSpec?.issue ?? record?.event?.story?.jiraKey ?? null;
}

/**
 * The file name an attached artifact gets: its own name, the Story, step and generation, and the
 * delivery's short key, so a retry recognises an attachment it already made.
 */
export function jiraAttachmentName(record) {
  const base = String(record?.artifact?.path ?? 'artifact.md').split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'artifact.md';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : '.md';
  return `${stem}-${record.workId}-${record.phaseId}-g${record.generation}-${String(record.key).slice(4, 12)}${extension}`;
}

/** The comment a jira action writes: what happened, each artifact's hash, and the delivery key. */
export function jiraCommentText(record) {
  const lines = [stepActionText(record.event)];
  for (const artifact of record.event?.artifacts ?? []) {
    if (artifact?.path && artifact.sha256) lines.push(`Artifact ${artifact.path} · SHA-256 ${artifact.sha256.slice(0, 12)}`);
  }
  if (record.action?.send === 'artifact' && record.artifact?.base64) lines.push(`Attached ${jiraAttachmentName(record)}.`);
  lines.push(`Delivery ${record.key}`);
  return lines.join('\n');
}

function commentText(body) {
  if (typeof body === 'string') return body;
  const parts = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') parts.push(node.text);
    for (const child of Array.isArray(node.content) ? node.content : []) visit(child);
  };
  visit(body);
  return parts.join('\n');
}

/** A Jira failure as an attempt result: transient trouble is retried, a refusal waits for a person. */
export function jiraAttemptResult(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const category = error?.category ?? null;
  const detail = String(error?.message ?? error ?? 'Jira request failed.');
  if (['timeout', 'network', 'rate-limit'].includes(category) || (status !== null && status >= 500)) {
    return { outcome: 'retry', ...(status !== null ? { status } : {}), code: 'STEP_ACTION_JIRA_UNREACHABLE', detail };
  }
  const code = category === 'authentication' || category === 'authorization' ? 'STEP_ACTION_JIRA_REFUSED'
    : category === 'not-found' ? 'STEP_ACTION_JIRA_NOT_FOUND' : 'STEP_ACTION_JIRA_FAILED';
  return { outcome: 'failed', ...(status !== null ? { status } : {}), code, detail };
}

/**
 * The repository's Jira policy (allowed hosts and projects), when its portfolio turns one on. A
 * portfolio that exists but cannot be read refuses the delivery rather than skipping the policy.
 */
async function jiraPolicy(root) {
  if (!root) return null;
  const { loadPortfolio } = await import('./initiative-config.mjs');
  const portfolio = await loadPortfolio(root, { required: false });
  return portfolio?.jira?.enabled ? portfolio.jira : null;
}

/** Move the issue to a status, unless it is there already. Returns what happened, in words. */
async function moveIssue(issueKey, wanted, currentStatus, options) {
  if (currentStatus && currentStatus.toLowerCase() === wanted.toLowerCase()) return null;
  const transitions = await listIssueTransitions(issueKey, options);
  const matches = transitions.filter((transition) => transition.id === wanted
    || transition.name?.toLowerCase() === wanted.toLowerCase()
    || transition.to?.toLowerCase() === wanted.toLowerCase());
  if (matches.length !== 1) {
    const error = new Error(matches.length
      ? `Jira transition '${wanted}' is ambiguous on ${issueKey}; name one transition ID: ${matches.map((item) => item.id).join(', ')}.`
      : `${issueKey} cannot move to '${wanted}' now. Available: ${transitions.map((item) => `${item.name} → ${item.to}`).join(', ') || 'none'}.`);
    error.category = 'conflict';
    throw error;
  }
  const [selected] = matches;
  const required = selected.fields.filter((field) => field.required);
  if (required.length) {
    const error = new Error(`Jira transition '${selected.name}' on ${issueKey} needs fields a delivery cannot fill: ${required.map((field) => field.name).join(', ')}.`);
    error.category = 'conflict';
    throw error;
  }
  const { connection } = options;
  await jiraRequest(`/rest/api/${connection.apiVersion}/issue/${encodeURIComponent(issueKey)}/transitions`, {
    ...options, method: 'POST', body: { transition: { id: selected.id } }
  });
  return `moved to ${selected.to ?? selected.name}`;
}

/**
 * Comment on (and, when asked, attach the approved artifact to and transition) the Story's Jira
 * issue. The delivery key is kept as an issue property and in the comment, so nothing is written twice.
 */
export async function deliverToJira(record, { root = null, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const target = record.action.targetSpec;
  const issueKey = jiraIssueFor(record);
  if (!issueKey) {
    return { outcome: 'failed', code: 'STEP_ACTION_JIRA_ISSUE_UNKNOWN',
      detail: `${record.workId} was not started from a Jira issue and target ${target.id} names none; give the target an issue, or start Stories from Jira.` };
  }
  if (!JIRA_ISSUE_KEY.test(issueKey)) return { outcome: 'failed', code: 'STEP_ACTION_JIRA_ISSUE_UNKNOWN', detail: `'${issueKey}' is not a Jira issue key.` };
  let connection;
  try { connection = jiraConnectionFromEnv(env); }
  catch {
    return { outcome: 'unavailable', code: 'STEP_ACTION_JIRA_NOT_CONNECTED',
      detail: 'Jira is not connected on this machine: connect Jira in VS Code, or set JIRA_BASE_URL with JIRA_USERNAME and JIRA_PAT.' };
  }
  try {
    const policy = await jiraPolicy(root);
    if (policy) {
      assertJiraConnectionPolicy(connection, policy);
      assertJiraIssuePolicy(issueKey, policy);
    }
  } catch (error) {
    return { outcome: 'failed', code: 'STEP_ACTION_JIRA_POLICY', detail: error.message };
  }
  const options = { connection, fetchImpl, maxRetries: 0, requestTimeoutMs: timeoutMs };
  const issuePath = `/rest/api/${connection.apiVersion}/issue/${encodeURIComponent(issueKey)}`;
  const property = jiraDeliveryProperty(record.key);
  try {
    try {
      const { payload } = await jiraRequest(`${issuePath}/properties/${encodeURIComponent(property)}`, options);
      if (payload) return { outcome: 'delivered', status: 200, detail: `Already on ${issueKey}.` };
    } catch (error) {
      if (error?.category !== 'not-found') throw error;
    }
    const { payload: issue } = await jiraRequest(`${issuePath}?fields=status,attachment`, options);
    const actions = [];
    if (record.action.send === 'artifact') {
      if (!record.artifact?.base64) {
        return { outcome: 'failed', code: 'STEP_ACTION_ARTIFACT_UNAVAILABLE', detail: record.artifact?.problem ?? 'The approved artifact was not recorded with this delivery.' };
      }
      const name = jiraAttachmentName(record);
      if (!(issue?.fields?.attachment ?? []).some((item) => item?.filename === name)) {
        await uploadJiraAttachment(issueKey, {
          filename: name, bytes: Buffer.from(record.artifact.base64, 'base64'), mimeType: record.artifact.mediaType ?? 'text/markdown'
        }, { connection, fetchImpl, requestTimeoutMs: timeoutMs });
      }
      actions.push(`attached ${name}`);
    }
    const { payload: comments } = await jiraRequest(`${issuePath}/comment?orderBy=-created&maxResults=${MAX_COMMENTS_SCANNED}`, options);
    const posted = (comments?.comments ?? []).some((comment) => commentText(comment?.body).includes(record.key));
    if (!posted) await addComment(issueKey, jiraCommentText(record), options);
    actions.unshift(`commented on ${issueKey}`);
    const wanted = jiraTransitionFor(target, record.trigger);
    if (wanted) {
      const moved = await moveIssue(issueKey, wanted, issue?.fields?.status?.name ?? null, options);
      if (moved) actions.push(moved);
    }
    await setIssueProperty(issueKey, property, {
      delivery: record.key, workId: record.workId, step: record.phaseId, generation: record.generation, trigger: record.trigger
    }, options);
    return { outcome: 'delivered', status: 200, detail: actions.join('; ') };
  } catch (error) {
    return jiraAttemptResult(error);
  }
}

// ---- Git ----------------------------------------------------------------------------------------

const PROTECTED_BRANCH_NAMES = new Set(['main', 'master', 'develop', 'trunk']);
const MAX_HISTORY_SCANNED = 100;

/** One repository written different ways (https, SSH, with or without .git) compares equal. */
export function sameGitRepository(left, right) {
  const key = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(text);
    let host; let route;
    if (scp) { host = scp[1]; route = scp[2]; }
    else {
      try { const url = new URL(text); host = url.hostname; route = url.pathname; }
      catch { return text.replace(/\/+$/g, '').replace(/\.git$/i, '').toLowerCase(); }
    }
    return `${host.toLowerCase()}/${route.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()}`;
  };
  const a = key(left); const b = key(right);
  return Boolean(a && b && a === b);
}

/** The commit message a Git delivery writes; its trailers let a retry recognise the delivery. */
export function gitDeliveryMessage(record, relative) {
  const event = record.event ?? {};
  const title = `sflow: ${record.workId} ${event.step?.label ?? record.phaseId} ${record.trigger} — ${relative.split('/').pop()}`.slice(0, 200);
  const body = `Delivered by Singularity Flow from ${record.workId}${event.story?.title ? ` (${String(event.story.title).slice(0, 200)})` : ''}, step ${record.phaseId} generation ${record.generation}.`;
  return [title, '', body, '',
    `Sflow-Delivery: ${record.key}`,
    `Sflow-Story: ${record.workId}`,
    `Sflow-Step: ${record.phaseId}`,
    `Sflow-Generation: ${record.generation}`,
    ...(record.artifact?.sha256 ? [`Sflow-Artifact-Sha256: ${record.artifact.sha256}`] : [])
  ].join('\n').replace(/\0/g, '');
}

function trailer(message, name) {
  const match = new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'mi').exec(String(message ?? ''));
  return match ? match[1] : null;
}

const GIT_HINTS = Object.freeze({
  'network-transient': 'Check the network on this machine; the delivery is tried again.',
  offline: 'This machine is offline; the delivery is tried again.',
  'rate-limited': 'The Git host is limiting requests; the delivery is tried again later.',
  'authentication-required': 'Sign in to this Git host on this machine (credential helper or SSH key), then retry.',
  'credential-helper-unavailable': 'The Git credential helper on this machine is not available; fix it, then retry.',
  'sso-authorization-required': 'Authorize this machine\'s Git credential for the organisation (SSO), then retry.',
  'authorization-denied': 'The Git account on this machine cannot write to that repository.',
  'remote-not-found': 'Check the repository address in the target.',
  'policy-rejected': 'The repository refused the push (branch protection or a server hook).',
  'tls-trust': 'This machine does not trust the Git host\'s certificate.'
});

/** What to do about a Git failure, in words for a delivery (the shared advice speaks of bootstrap). */
export function gitDeliveryHint(error) {
  return GIT_HINTS[error?.remote?.classification] ?? null;
}

/** A Git failure as an attempt result: transport trouble is retried, a refusal waits for a person. */
export function gitAttemptResult(error) {
  const remote = error?.remote;
  const hint = gitDeliveryHint(error);
  const detail = String(hint ? `${error.message} ${hint}` : error?.message ?? error ?? 'Git delivery failed.');
  const transient = remote ? ['network-transient', 'offline', 'rate-limited', 'git-unavailable'].includes(remote.classification) : false;
  return { outcome: transient ? 'retry' : 'failed', code: remote?.code ?? error?.code ?? 'STEP_ACTION_GIT_FAILED', detail };
}

/**
 * Commit the approved artifact to a branch of another repository (or a non-protected branch of
 * this one), fast-forward only. Before writing, the branch's recent history is read: this
 * delivery's trailer, or a newer generation of the same step, means there is nothing to do, and
 * a file already holding these bytes is not committed again.
 */
export async function deliverToGit(record, { root = null, env = process.env, git = null } = {}) {
  const target = record.action.targetSpec;
  if (!record.artifact?.base64) {
    return { outcome: 'failed', code: 'STEP_ACTION_ARTIFACT_UNAVAILABLE', detail: record.artifact?.problem ?? 'The approved artifact was not recorded with this delivery.' };
  }
  const relative = renderGitDeliveryPath(target.path ?? DEFAULT_GIT_DELIVERY_PATH, {
    workId: record.workId, phaseId: record.phaseId, generation: record.generation, trigger: record.trigger, artifactPath: record.artifact.path
  });
  // Writing to this repository's own Story, base or main branches would skip its review.
  const story = record.event?.story ?? {};
  if (sameGitRepository(target.repository, record.event?.commit?.remote)
      && (PROTECTED_BRANCH_NAMES.has(target.branch) || target.branch === story.branch || target.branch === story.baseBranch)) {
    return { outcome: 'failed', code: 'STEP_ACTION_GIT_BRANCH_REFUSED',
      detail: `${target.branch} is a branch of this repository that changes only through review; write to another branch or repository.` };
  }
  const service = git ?? await import('./git.mjs');
  let identity;
  try { identity = service.resolveGitCommitIdentity(root ?? process.cwd(), { env }); }
  catch (error) { return { outcome: 'failed', code: 'STEP_ACTION_GIT_IDENTITY', detail: error.message }; }
  const bytes = Buffer.from(record.artifact.base64, 'base64');
  try {
    return await service.withIsolatedGitObjectRepository({ remote: target.repository }, async (scratch) => {
      const tip = await service.isolatedRemoteBranchTip(scratch, { remote: target.repository, branch: target.branch });
      if (tip) {
        await service.fetchIsolatedDeliveryHistory(scratch, { remote: target.repository, commit: tip, depth: MAX_HISTORY_SCANNED });
        const history = service.isolatedCommitMessages(scratch, { commit: tip, limit: MAX_HISTORY_SCANNED });
        const mine = history.find((entry) => trailer(entry.message, 'Sflow-Delivery') === record.key);
        if (mine) return { outcome: 'delivered', status: 200, detail: `Already on ${target.branch} as ${mine.commit.slice(0, 12)}.` };
        const newer = history.find((entry) => trailer(entry.message, 'Sflow-Story') === record.workId
          && trailer(entry.message, 'Sflow-Step') === record.phaseId && Number(trailer(entry.message, 'Sflow-Generation')) > record.generation);
        if (newer) return { outcome: 'delivered', status: 200, detail: `Superseded on ${target.branch} by generation ${trailer(newer.message, 'Sflow-Generation')}.` };
      }
      const commit = await service.writeExactGitFileCommit(scratch, {
        parentCommit: tip, relative, bytes, commitIdentity: identity, message: gitDeliveryMessage(record, relative)
      });
      if (!commit) return { outcome: 'delivered', status: 200, detail: `${relative} on ${target.branch} already holds these bytes.` };
      const pushed = await service.pushIsolatedDeliveryCommit(scratch, { remote: target.repository, commit, branch: target.branch });
      if (pushed === 'moved') return { outcome: 'retry', code: 'STEP_ACTION_GIT_BRANCH_MOVED', detail: `${target.branch} moved while this delivery was written; it is tried again on the new tip.` };
      return { outcome: 'delivered', status: 200, detail: `Committed ${relative} to ${target.branch} as ${commit.slice(0, 12)}.` };
    });
  } catch (error) {
    return gitAttemptResult(error);
  }
}

/** Writers by target kind; HTTP kinds go through the outbox's own request path instead. */
export const STEP_ACTION_WRITERS = Object.freeze({ jira: deliverToJira, git: deliverToGit });
