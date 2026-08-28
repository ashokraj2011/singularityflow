import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  branch, changes, gitCommitIdentity, gitCommonDir, head
} from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { nowIso, run } from '../util.mjs';
import { adhocError, assertSessionMutable } from './contracts.mjs';
import { normalizeAdhocPolicy } from './policy.mjs';
import {
  clearActiveSession, listSessions, readActiveSessionId, readSessionRecord,
  resolveSessionId, writeActiveSession, writeSessionRecord
} from './session-store.mjs';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sessionId() {
  const time = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `AHS-${time}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function resolveCommit(root, value) {
  const result = run('git', ['rev-parse', '--verify', `${value}^{commit}`], { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    throw adhocError('ADH_BASELINE_REQUIRED', `Baseline revision '${value}' is not an available commit.`, 'Fetch it or pass an exact available revision with --from.');
  }
  return result.stdout.trim();
}

function repositorySubject(root) {
  const common = gitCommonDir(root);
  return {
    kind: 'workspace',
    id: path.basename(root),
    bindingSha256: sha256(path.resolve(common))
  };
}

function workArea(root) {
  const status = changes(root);
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout
    .split('\0').filter(Boolean).sort();
  return {
    dirty: Boolean(status.trim()),
    statusSha256: sha256(status),
    untrackedManifestSha256: sha256(canonicalJson(untracked))
  };
}

export async function startAdhocSession(root, definition, {
  note = '', from = 'HEAD', includeExisting = false, mode = null, unstartedLanding = false
} = {}) {
  const policy = normalizeAdhocPolicy(definition.adhoc);
  if (!policy.enabled) {
    throw adhocError('ADH_DISABLED', 'Ad hoc work is disabled by repository policy.', 'Use a compiled Story workflow or ask the configuration owner to enable adhoc.');
  }
  if (!policy.localWork.allowed) {
    throw adhocError('ADH_DISABLED', 'Repository policy does not permit local ad hoc work.', 'Use a compiled Story workflow.');
  }
  if (!unstartedLanding && !policy.entry.allowExplicitStart) {
    throw adhocError('ADH_DISABLED', 'Explicit ad hoc session start is disabled.', "Use 'singularity-flow land' for existing work or a compiled Story workflow.");
  }
  if (unstartedLanding && !policy.entry.allowUnstartedLanding) {
    throw adhocError('ADH_DISABLED', 'Landing work without a prior session is disabled.', "Run 'singularity-flow adhoc start' before editing or use a compiled Story workflow.");
  }
  const selectedMode = mode ?? policy.entry.defaultMode;
  if (selectedMode !== 'in-place') {
    throw adhocError(
      'ADH_PROMOTION_REQUIRED',
      `The ADH v1 thin pilot supports in-place sessions; '${selectedMode}' is not active yet.`,
      "Use --mode in-place or promote the work into a compiled workflow."
    );
  }
  const current = await readActiveSessionId(root, { required: false });
  if (current) {
    const active = await readSessionRecord(root, current, 'session', { required: false });
    if (active && !['landed', 'promoted', 'split', 'local-only', 'discarded', 'cancelled'].includes(active.status)) {
      throw adhocError(
        'ADH_SESSION_ALREADY_ACTIVE',
        `Ad hoc session '${current}' is already active.`,
        `Resume it with 'singularity-flow adhoc status ${current}' or close it explicitly.`
      );
    }
  }
  const area = workArea(root);
  if (area.dirty && !includeExisting) {
    throw adhocError(
      'ADH_DIRTY_START_CHOICE_REQUIRED',
      'Existing tracked or untracked work was detected and was not silently adopted.',
      "Re-run with --include-existing to include it, or preserve it separately before starting. Current-tree baseline snapshots are not enabled in the thin pilot.",
      { choices: ['include-existing', 'cancel'] }
    );
  }
  const baselineCommit = resolveCommit(root, from);
  const baselineTree = run('git', ['rev-parse', `${baselineCommit}^{tree}`], { cwd: root }).stdout.trim();
  const id = sessionId();
  const now = nowIso();
  const baseline = await writeSessionRecord(root, id, 'baseline', {
    kind: 'adhoc-baseline',
    sessionId: id,
    subject: { kind: 'repository', id: path.basename(root) },
    revision: {
      logical: from === 'HEAD' ? `branch:${branch(root)}` : String(from),
      gitCommit: baselineCommit,
      treeSha256: sha256(baselineTree)
    },
    workArea: area,
    source: from === 'HEAD' ? 'current-head' : 'explicit-revision',
    confirmationRequired: false,
    createdAt: now
  });
  const principal = gitCommitIdentity(root);
  const effectivePolicySha256 = sha256(canonicalJson(policy));
  const session = await writeSessionRecord(root, id, 'session', {
    kind: 'adhoc-session',
    sessionId: id,
    generation: 1,
    principal: {
      id: principal.email ?? principal.name,
      name: principal.name,
      email: principal.email,
      assurance: principal.email ? 'git-configured' : 'local-process'
    },
    subject: repositorySubject(root),
    mode: selectedMode,
    initialNote: String(note ?? '').trim(),
    initialNoteSha256: sha256(String(note ?? '').trim()),
    baseline: { status: 'resolved', baselineSha256: baseline.baselineSha256 },
    policy: { policySha256: effectivePolicySha256, effective: policy },
    execution: { mode: 'human-agent-mixed', activeExecutionIds: [] },
    branch: branch(root),
    status: 'working',
    origin: unstartedLanding ? 'observed-existing-work' : 'explicit-start',
    startedAt: now,
    updatedAt: now
  });
  await writeActiveSession(root, id);
  return { session, baseline };
}

export async function readAdhocSession(root, requested = null) {
  const id = await resolveSessionId(root, requested);
  return readSessionRecord(root, id, 'session');
}

export async function updateAdhocSession(root, requested, updates) {
  const session = assertSessionMutable(await readAdhocSession(root, requested));
  return writeSessionRecord(root, session.sessionId, 'session', {
    ...session,
    ...updates,
    updatedAt: nowIso(),
    schemaVersion: currentSchemaVersion('adhoc-session'),
    sessionSha256: undefined
  });
}

export async function pauseAdhocSession(root, requested = null) {
  const session = await updateAdhocSession(root, requested, { status: 'paused' });
  return session;
}

export async function resumeAdhocSession(root, requested = null) {
  const session = await updateAdhocSession(root, requested, { status: 'working' });
  await writeActiveSession(root, session.sessionId);
  return session;
}

export async function closeAdhocSessionLocally(root, requested = null) {
  const session = await updateAdhocSession(root, requested, { status: 'local-only', closedAt: nowIso() });
  await clearActiveSession(root, session.sessionId);
  return session;
}

export async function adhocStatus(root, requested = null) {
  if (requested === 'all') return { sessions: await listSessions(root) };
  const session = await readAdhocSession(root, requested);
  return {
    session,
    baseline: await readSessionRecord(root, session.sessionId, 'baseline'),
    changeSet: await readSessionRecord(root, session.sessionId, 'preview', { required: false }),
    intent: await readSessionRecord(root, session.sessionId, 'intent', { required: false }),
    disposition: await readSessionRecord(root, session.sessionId, 'disposition', { required: false }),
    packet: await readSessionRecord(root, session.sessionId, 'packet', { required: false }),
    receipt: await readSessionRecord(root, session.sessionId, 'receipt', { required: false })
  };
}
