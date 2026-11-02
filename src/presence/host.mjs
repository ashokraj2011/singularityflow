/**
 * SF Guard M4: what the Git host knows that a clone cannot forge (SPEC-PSS-v1 REQ-021, REQ-030, REQ-042).
 *
 * - Branch protection: whether the remote check SF Guard's opt-in named is a required status check
 *   on the default branch. Read only, at opt-in and by `guard status`; SF Guard never changes it.
 * - When a commit first reached the host: the host's own record of pushes, which an agent on this
 *   computer cannot backdate the way it can backdate a commit. The remote check compares a new
 *   Story's first push with the opt-in's.
 * - Whether a configuration change was reviewed on the host: the lone-approver fallback (REQ-042).
 *
 * Every read is GitHub's REST API through the anchor's transport (bundled root certificates, no
 * environment proxy). Unreachable or unknown is reported as unavailable, never as a pass or a fail.
 */
import { githubApiJson } from './anchor.mjs';

const PUBLIC_GITHUB_HOST = ['github', 'com'].join('.');
const NAME = /^[A-Za-z0-9._-]{1,100}$/u;
const MAX_ACTIVITY_PAGES = 10;
const REVIEWER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** `{ owner, repo }` of a GitHub remote URL (HTTPS or SSH), or null for any other host. */
export function githubRepository(url) {
  const text = String(url ?? '').trim();
  const host = PUBLIC_GITHUB_HOST.replaceAll('.', '\\.');
  const match = text.match(new RegExp(`^(?:https://(?:[^@/]+@)?${host}/|ssh://git@${host}/|git@${host}:)([^/]+)/([^/]+?)(?:\\.git)?/?$`, 'u'));
  if (!match || !NAME.test(match[1]) || !NAME.test(match[2])) return null;
  return { owner: match[1], repo: match[2] };
}

const repoPath = ({ owner, repo }) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

async function readJson(request, pathname, token) {
  let answer;
  try { answer = await request(pathname, token ? { token } : undefined); }
  catch (error) { return { ok: false, reason: `GitHub could not be reached: ${error.message}` }; }
  if (answer.status !== 200) return { ok: false, status: answer.status, reason: `GitHub answered ${answer.status}` };
  try { return { ok: true, body: JSON.parse(answer.body), link: answer.link ?? null }; }
  catch { return { ok: false, reason: 'GitHub answered with something that is not JSON' }; }
}

/**
 * Whether `check` is a required status check on `branch`: `{ status: 'required'|'not-required'|
 * 'unprotected'|'unavailable', contexts, reason }`.
 */
export async function requiredStatusCheck(repository, branch, check, { request = githubApiJson, token = null } = {}) {
  if (!repository || !branch || !check) return { status: 'unavailable', contexts: [], reason: 'no GitHub repository, default branch or check name to read' };
  const read = await readJson(request, `${repoPath(repository)}/branches/${encodeURIComponent(branch)}`, token);
  if (!read.ok) {
    return { status: 'unavailable', contexts: [], reason: read.status === 404
      ? 'GitHub would not show this branch (a private repository needs a signed-in read); check it in the repository settings'
      : read.reason };
  }
  if (read.body?.protected !== true) return { status: 'unprotected', contexts: [], reason: `${branch} has no branch protection` };
  const checks = read.body?.protection?.required_status_checks;
  if (!checks || typeof checks !== 'object') {
    return { status: 'unavailable', contexts: [], reason: 'GitHub did not show the required checks (a signed-in read may be needed)' };
  }
  const contexts = [...new Set([...(checks.contexts ?? []), ...(checks.checks ?? []).map((entry) => entry?.context)].filter((value) => typeof value === 'string'))];
  return { status: contexts.includes(check) ? 'required' : 'not-required', contexts, reason: null };
}

function nextCursor(link) {
  const match = String(link ?? '').match(/<[^>]*[?&]after=([^&>]+)[^>]*>;\s*rel="next"/u);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * When `commit` first reached the host, from its activity record: the earliest push or branch
 * creation whose new tip contains it (`contains(commit, after)`, a local ancestry check). Returns
 * `{ status: 'known'|'unknown'|'unavailable', at, reason }`.
 */
export async function firstPushTime(repository, commit, { contains, request = githubApiJson, token = null } = {}) {
  if (!repository || !commit) return { status: 'unavailable', at: null, reason: 'no GitHub repository or commit' };
  let cursor = null;
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page += 1) {
    const query = `direction=asc&per_page=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
    const read = await readJson(request, `${repoPath(repository)}/activity?${query}`, token);
    if (!read.ok) return { status: 'unavailable', at: null, reason: read.reason };
    if (!Array.isArray(read.body)) return { status: 'unavailable', at: null, reason: 'GitHub answered with something that is not an activity list' };
    for (const activity of read.body) {
      if (!['push', 'force_push', 'branch_creation', 'pr_merge', 'merge_queue_merge'].includes(activity?.activity_type)) continue;
      if (typeof activity.after !== 'string' || !/^[0-9a-f]{40}$/u.test(activity.after)) continue;
      if (activity.after === commit || contains(commit, activity.after)) return { status: 'known', at: activity.timestamp ?? null, reason: null };
    }
    cursor = nextCursor(read.link);
    if (!cursor) break;
  }
  return { status: 'unknown', at: null, reason: `GitHub's activity record (up to ${MAX_ACTIVITY_PAGES * 100} entries) does not show when ${commit.slice(0, 12)} was first pushed` };
}

/**
 * Whether the change was approved on the host by a member other than its author: the pull request
 * `pullRequest` (a pull request's own run), else every pull request carrying `commit` (a push run).
 * `{ status: 'reviewed'|'not-reviewed'|'unavailable', pullRequest, reviewer, reason }`.
 */
export async function hostReview(repository, { commit = null, pullRequest = null } = {}, { request = githubApiJson, token = null } = {}) {
  if (!repository || (!commit && !pullRequest)) return { status: 'unavailable', pullRequest: null, reviewer: null, reason: 'no GitHub repository, commit or pull request' };
  let candidates;
  if (Number.isInteger(pullRequest)) {
    const pull = await readJson(request, `${repoPath(repository)}/pulls/${pullRequest}`, token);
    if (!pull.ok) return { status: 'unavailable', pullRequest, reviewer: null, reason: pull.reason };
    candidates = [pull.body];
  } else {
    const pulls = await readJson(request, `${repoPath(repository)}/commits/${encodeURIComponent(commit)}/pulls`, token);
    if (!pulls.ok) return { status: 'unavailable', pullRequest: null, reviewer: null, reason: pulls.reason };
    candidates = Array.isArray(pulls.body) ? pulls.body : [];
  }
  for (const pull of candidates) {
    if (!Number.isInteger(pull?.number)) continue;
    const reviews = await readJson(request, `${repoPath(repository)}/pulls/${pull.number}/reviews?per_page=100`, token);
    if (!reviews.ok) return { status: 'unavailable', pullRequest: pull.number, reviewer: null, reason: reviews.reason };
    const author = String(pull.user?.login ?? '').toLowerCase();
    const approved = (Array.isArray(reviews.body) ? reviews.body : []).find((review) => review?.state === 'APPROVED'
      && String(review.user?.login ?? '').toLowerCase() !== author && REVIEWER_ASSOCIATIONS.has(review.author_association));
    if (approved) return { status: 'reviewed', pullRequest: pull.number, reviewer: approved.user?.login ?? null, reason: null };
  }
  return { status: 'not-reviewed', pullRequest: null, reviewer: null,
    reason: 'no pull request carrying it was approved on GitHub by a member other than its author' };
}
