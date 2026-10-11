/** Archive immutable snapshots, then retire only their exact branch refs. Never erase history. */
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { resolveConfigurationRemote } from './configuration-branch.mjs';
import { configurationHistoryRefs, retainedConfigurationHistoryRef } from './configuration-history-refs.mjs';
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { frozenRemoteTransport, sanitizeRemote } from './git-remote-diagnostics.mjs';
import { GitRemoteSession, requireRemoteObservation, runRemoteGitAsync } from './git-execution.mjs';
import { recordSha256 } from './records.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';

const PREFIX = 'refs/heads/sflow/config-history/';
const AUTHORITY = 'refs/heads/sflow/config';
const MAX_HISTORY = 1000;
const MAX_BATCH = 100;
const fail = (message, code = 'CONFIGURATION_HISTORY_CLEANUP_UNSAFE', details = {}) => {
  throw new SingularityFlowError(message, { code, details });
};

export async function cleanupConfigurationHistory(root, { apply = false, confirm = null, keep = 10,
  env = process.env, remote: selectedRemote = null, runRemoteCommand = runRemoteGitAsync } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100) fail('Keep must be an integer from 1 to 100.');
  const gitEnv = enterpriseGitEnvironment(env);
  const resolver = new GitRemoteSession({ env: gitEnv,
    runAsyncCommand: (args, options) => runRemoteCommand(args, { ...options, cwd: root }) });
  const remote = selectedRemote ?? await resolveConfigurationRemote(root, 'origin', { session: resolver });
  if (!remote) fail('No approved configuration remote is available. Nothing was cleaned.');
  const transport = frozenRemoteTransport(remote, { push: apply, env: gitEnv });
  const session = new GitRemoteSession({ env: transport.env,
    runAsyncCommand: (args, options) => runRemoteCommand(args, { ...options, cwd: root }) });
  const patterns = [AUTHORITY, `${PREFIX}*`, 'refs/tags/sflow/config-history/*'];
  const before = await session.observeAsync(transport.remote, { refs: patterns, includeHead: false, refresh: true });
  requireRemoteObservation(before, 'configuration history cleanup');
  const approved = before.refs.get(AUTHORITY);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(approved ?? '')) fail('No exact approved sflow/config authority is available.');
  const heads = [...before.refs].filter(([ref]) => ref.startsWith(PREFIX));
  if (heads.length > MAX_HISTORY) fail(`History exceeds the bounded ${MAX_HISTORY}-ref cleanup inventory. No refs changed.`,
    'CONFIGURATION_HISTORY_CLEANUP_LIMIT');
  const retained = [], histories = [];
  for (const [ref, commit] of heads) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(ref.slice(PREFIX.length)) || ref.slice(PREFIX.length) !== commit) {
      retained.push({ branch: ref.slice('refs/heads/'.length), commit, reason: 'noncanonical-history-ref' }); continue;
    }
    try { retainedConfigurationHistoryRef(before.refs, commit); }
    catch { retained.push({ branch: ref.slice('refs/heads/'.length), commit, reason: 'archive-collision' }); continue; }
    histories.push({ ...configurationHistoryRefs(commit), commit });
  }
  let scratch, returned;
  const done = value => { returned = value; return value; };
  try {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-history-cleanup-'));
    const git = (args, extra = {}) => run('git', args, { cwd: scratch, env: transport.env,
      timeoutMs: 15_000, maxBuffer: 1024 * 1024, ...extra });
    git(['init', '--bare', '--quiet']);
    if (histories.length) {
      // Commit headers only on filter-capable servers; no application checkout or worktree edits.
      const fetched = await runRemoteCommand(['fetch', '--quiet', '--no-tags', '--filter=tree:0', '--depth=1',
        '--recurse-submodules=no', '--', transport.remote,
        `+${AUTHORITY}:refs/sflow-history-cleanup/approved`,
        ...histories.map(item => `+${item.branch}:refs/sflow-history-cleanup/${item.commit}`)],
      { cwd: scratch, env: transport.env, operation: 'remote-configuration' });
      if (fetched.status !== 0) fail('Configuration history could not be inspected. No remote refs changed.',
        'CONFIGURATION_HISTORY_CLEANUP_READ_FAILED');
    }
    const listing = git(['for-each-ref', '--format=%(objectname)%09%(committerdate:unix)', 'refs/sflow-history-cleanup/']);
    const dates = new Map(listing.stdout.trim().split(/\r?\n/u).filter(Boolean).map(line => {
      const [commit, date] = line.split('\t'); return [commit, Number(date)];
    }));
    for (const item of histories) {
      if (!dates.has(item.commit) || !Number.isSafeInteger(dates.get(item.commit))) fail('A snapshot moved during inspection. Preview again.');
      item.time = dates.get(item.commit);
    }
    histories.sort((a, b) => b.time - a.time || a.commit.localeCompare(b.commit));
    const recent = new Set(histories.slice(0, keep).map(item => item.commit));
    const eligible = [];
    for (const item of histories) {
      if (item.commit === approved || recent.has(item.commit)) retained.push({ branch: item.name,
        commit: item.commit, reason: item.commit === approved ? 'current-approved-configuration' : 'recent-history' });
      else eligible.push({ branch: item.name, commit: item.commit, archiveRef: item.archive });
    }
    const candidates = eligible.slice(0, MAX_BATCH);
    const plan = { remote: sanitizeRemote(transport.url), approvedCommit: approved, keep,
      candidates, retained: retained.sort((a, b) => a.branch.localeCompare(b.branch)),
      remaining: Math.max(0, eligible.length - candidates.length),
      observedRefs: Object.fromEntries([...before.refs].sort(([a], [b]) => a.localeCompare(b))) };
    const confirmation = `sha256:${recordSha256(plan)}`;
    const argv = ['configuration', 'cleanup-history', '--keep-recent', String(keep), '--apply', '--confirm', confirmation, '--json'];
    const result = { schemaVersion: 1, // schema-transient: cleanup preview/result, not lifecycle authority
      resultType: 'sflow-configuration-history-cleanup', status: 'preview',
      ...plan, confirmation, commandGuidance: { next: safeCommandGuidance({ executable: 'singularity-flow', argv }) },
      effects: { applicationCode: 'unchanged', worktree: 'unchanged', index: 'unchanged',
        stories: 'unchanged', approvals: 'unchanged', configuration: 'unchanged', history: 'preserved-as-tags' } };
    if (!apply) return done(result);
    if (confirm !== confirmation) fail('Preview and confirm the exact current cleanup packet. No remote refs changed.',
      'CONFIGURATION_HISTORY_CLEANUP_STALE', { confirmation });
    if (!candidates.length) return done({ ...result, status: 'current', archived: [] });
    const fresh = await session.observeAsync(transport.remote, { refs: patterns, includeHead: false, refresh: true });
    requireRemoteObservation(fresh, 'configuration history cleanup recheck');
    if (recordSha256(Object.fromEntries([...fresh.refs].sort(([a], [b]) => a.localeCompare(b)))) !== recordSha256(plan.observedRefs)) {
      fail('Configuration history changed after preview. Preview again; no remote refs changed.', 'CONFIGURATION_HISTORY_CLEANUP_STALE');
    }
    const leases = [`--force-with-lease=${AUTHORITY}:${approved}`], updates = [`${approved}:${AUTHORITY}`];
    for (const item of candidates) {
      const refs = configurationHistoryRefs(item.commit);
      leases.push(`--force-with-lease=${refs.branch}:${item.commit}`,
        `--force-with-lease=${refs.archive}:${before.refs.get(refs.archive) ?? ''}`);
      updates.push(`${item.commit}:${refs.archive}`, `:${refs.branch}`);
    }
    const pushed = await runRemoteCommand(['push', '--porcelain', '--atomic', ...leases, '--', transport.remote, ...updates],
      { cwd: scratch, env: transport.env, operation: 'remote-push' });
    const after = await session.observeAsync(transport.remote, { refs: candidates.flatMap(item => {
      const refs = configurationHistoryRefs(item.commit); return [refs.branch, refs.archive];
    }), includeHead: false, refresh: true });
    if (!after.ok) return done({ ...result, status: 'outcome-unknown', archived: [],
      failure: { message: 'Cleanup acknowledgement is unavailable. Preview again to reconcile; do not assume deletion or failure.' } });
    const archived = candidates.filter(item => {
      const refs = configurationHistoryRefs(item.commit);
      return !after.refs.has(refs.branch) && after.refs.get(refs.archive) === item.commit;
    });
    return done({ ...result, status: archived.length === candidates.length ? 'cleaned' : 'not-cleaned', archived,
      reconciled: pushed.status !== 0 && archived.length === candidates.length,
      ...(archived.length === candidates.length ? {} : { failure: {
        message: 'The atomic archive transaction was refused or changed concurrently. History is not reported cleaned; inspect a fresh preview.'
      } }) });
  } finally {
    if (scratch) await removeTemporaryTree(scratch).catch(() => {
      // A locked temporary snapshot must not turn a verified remote result into false uncertainty.
      if (returned) returned.warnings = [{ code: 'CONFIGURATION_HISTORY_CLEANUP_TEMPORARY_RETAINED',
        path: scratch, message: 'Temporary read snapshot cleanup is delayed; the reported remote outcome is unchanged.' }];
    });
  }
}
