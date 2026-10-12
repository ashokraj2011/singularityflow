/**
 * `inputs restore <phase>`: put back the exact approved bytes of an earlier phase's artifact that
 * this phase reads (a declared input, or an approved artifact file that the specification index or
 * convergence verifies), when they changed or disappeared in the working tree only.
 *
 * Without `--confirm` it previews: which inputs differ from their approved digest, the digest, and
 * where the bytes come from, sealed by a plan digest. With the matching `--confirm` it first saves
 * a private recovery checkpoint of every dirty file and the Git index (the appeal checkpoint, under
 * the repository Git directory), then writes the approved bytes and verifies them. It never stages,
 * commits, edits Story state, or touches a file whose approved bytes it cannot prove.
 *
 * Only uncommitted drift is restored. When a commit on the branch already carries the changed
 * bytes, writing the approved copy back would leave an uncommitted change to another phase's
 * artifact, which this phase's publication then refuses (PHASE_ARTIFACT_ONLY_CHANGES and the
 * cross-phase checks compare against HEAD). Teaching those checks to accept "restored approved
 * bytes" would let a later phase commit another phase's artifact, so committed drift is refused
 * here with its own code and the producer's return or amendment route instead.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { collectInputs, inputReadinessFindings } from '../inputs.mjs';
import {
  committedFileBytes, committedFilesAtRevisions, head, recentCommitFileSets, worktreeStatusDetail
} from '../git.mjs';
import { createPhaseCheckpoint } from '../phase-checkpoint.mjs';
import { canonicalJson } from '../records.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { upstreamChangeRoutes } from '../upstream-routes.mjs';
import {
  optionBoolean, optionString, posix, secureRepositoryPath, SingularityFlowError, snapshot, writeAtomic
} from '../util.mjs';

const HISTORY_LIMIT = 200;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const plain = (value) => String(value ?? '').replace(/^sha256:/u, '');

function restorePhase(workflow, phaseId) {
  const id = phaseId ?? workflow.currentPhase;
  const phase = id ? workflow.phases?.[id] ?? null : null;
  if (!phase) {
    throw new SingularityFlowError(`Story ${workflow.workItem.id} has no phase '${id ?? 'none'}' to restore inputs for.`, {
      code: 'INPUT_RESTORE_PHASE_UNKNOWN', details: { workId: workflow.workItem.id, phase: id ?? null }
    });
  }
  return phase;
}

/** Paths whose Git index entry differs from HEAD: restoring the working copy alone would not settle them. */
function stagedPaths(root) {
  return new Set(worktreeStatusDetail(root).entries
    .filter((entry) => ['ordinary', 'rename-or-copy'].includes(entry.type) && entry.xy.index !== '.')
    .flatMap((entry) => [entry.path, entry.sourcePath].filter(Boolean))
    .filter((value) => value.kind === 'utf8').map((value) => value.value));
}

/** The newest commit on this branch whose copy of `relative` has the approved digest, or null. */
function approvedCommitInHistory(root, relative, approvedSha256) {
  // Git reads a relative date before the epoch ("100 years ago") as no commits at all; an absolute
  // floor keeps the whole bounded window.
  const commits = recentCommitFileSets(root, {
    since: '1971-01-01', limit: HISTORY_LIMIT, paths: [relative], ref: 'HEAD'
  }).map((entry) => entry.commit);
  if (!commits.length) return null;
  const bytes = committedFilesAtRevisions(root, commits.map((commit) => ({ key: commit, ref: commit, path: relative })));
  return commits.find((commit) => bytes.has(commit) && sha256(bytes.get(commit)) === approvedSha256) ?? null;
}

function unrestorableReason(finding) {
  if (finding.status === 'unapproved') {
    return `${finding.phase} is ${finding.producerStatus ?? 'not approved'}; only an approved phase has bytes to restore. Complete or return ${finding.phase} through its own route.`;
  }
  if (finding.status === 'skipped') return `${finding.phase} was skipped by a decision in this Story; there are no approved bytes to restore.`;
  return `This input is ${finding.status.replaceAll('_', ' ')}. Restoring file bytes cannot repair it; ${finding.phase} must produce it through its own route.`;
}

async function planEntry(root, finding, staged, headCommit) {
  const entry = {
    phase: finding.phase, path: finding.path, status: finding.status,
    approvedSha256: finding.approvedSha256 ?? null, currentSha256: finding.sha256 ?? null,
    restorable: false, drift: null, source: null, code: null, reason: null
  };
  if (!finding.restorable || !finding.path) {
    return { ...entry, code: 'INPUT_RESTORE_NOT_APPROVED_BYTES', reason: unrestorableReason(finding) };
  }
  await secureRepositoryPath(root, finding.path, { label: `Approved ${finding.phase} input` });
  const approved = plain(finding.approvedSha256);
  const committed = committedFileBytes(root, 'HEAD', finding.path);
  if (committed && sha256(committed) === approved) {
    if (staged.has(finding.path)) {
      return { ...entry, drift: 'staged', source: { kind: 'head', commit: headCommit },
        code: 'INPUT_RESTORE_STAGED_DRIFT',
        reason: `The changed bytes are staged in the Git index. Unstage ${finding.path} first (its committed copy is already the approved one), then preview the restore again.` };
    }
    return { ...entry, restorable: true, drift: 'uncommitted', source: { kind: 'head', commit: headCommit } };
  }
  const historical = approvedCommitInHistory(root, finding.path, approved);
  return { ...entry, drift: 'committed', source: historical ? { kind: 'commit', commit: historical } : null,
    code: 'INPUT_RESTORE_COMMITTED_DRIFT',
    reason: historical
      ? `A commit after ${historical.slice(0, 12)} changed ${finding.path}, so the branch itself no longer holds the approved bytes. Restoring only the working copy would leave this phase's publication refused. Use ${finding.phase}'s return or amendment route.`
      : `No commit on this branch holds the approved bytes of ${finding.path}. Use ${finding.phase}'s return or amendment route.` };
}

/**
 * Earlier approved phases' own artifact files whose bytes no longer match their approved digest,
 * even when this phase does not declare them as inputs (the specification index and convergence
 * read them too). Only Story artifact files are considered: application source is never reverted.
 */
async function approvedArtifactDrift(root, workflow, phase, itemRelative) {
  const order = workflow.phaseOrder ?? [];
  const findings = [];
  for (const id of order.slice(0, Math.max(0, order.indexOf(phase.id)))) {
    const producer = workflow.phases?.[id];
    if (producer?.status !== 'approved') continue;
    for (const artifact of producer.artifacts ?? []) {
      if (artifact.status !== 'approved' || !artifact.sha256 || artifact.symbolicLink
          || !String(artifact.path ?? '').startsWith(`${itemRelative}/artifacts/${id}/`)) continue;
      const secured = await secureRepositoryPath(root, artifact.path, { label: `Approved ${id} artifact` });
      const current = await snapshot(secured.absolute);
      if (current.exists && current.sha256 === plain(artifact.sha256)) continue;
      findings.push({ phase: id, path: artifact.path, status: current.exists ? 'hash_mismatch' : 'missing',
        producerStatus: 'approved', approvedSha256: artifact.sha256, sha256: current.sha256 ?? null, restorable: true });
    }
  }
  return findings;
}

/** Read-only preview with a digest the apply step must repeat exactly. */
export async function inputRestorePlan(root, config, workflow, phaseId = null) {
  const phase = restorePhase(workflow, phaseId);
  const itemRelative = posix(path.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id));
  const inputs = await collectInputs(root, workflow, phase, {
    definition: config, itemDirectory: path.join(root, itemRelative), itemRelative
  });
  const declared = inputReadinessFindings(inputs);
  const findings = [...declared, ...(await approvedArtifactDrift(root, workflow, phase, itemRelative))
    .filter((finding) => !declared.some((entry) => entry.path === finding.path))];
  const headCommit = head(root);
  const staged = findings.some((finding) => finding.restorable) ? stagedPaths(root) : new Set();
  const entries = [];
  for (const finding of findings) entries.push(await planEntry(root, finding, staged, headCommit));
  const core = {
    schemaVersion: 1, // schema-transient: a preview digest for one confirmation, never persisted
    kind: 'phase-input-restore-plan', workId: workflow.workItem.id, phase: phase.id, head: headCommit,
    entries
  };
  const planSha256 = `sha256:${sha256(canonicalJson(core))}`;
  const producers = [...new Set(entries.filter((entry) => !entry.restorable).map((entry) => entry.phase))];
  const changes = producers.map((producer) => upstreamChangeRoutes(workflow, producer, { currentPhaseId: phase.id }));
  return {
    ...core, planSha256,
    restorable: entries.filter((entry) => entry.restorable).length,
    confirmCommand: entries.some((entry) => entry.restorable)
      ? `singularity-flow inputs restore ${phase.id} --confirm ${planSha256}` : null,
    routes: changes.flatMap((entry) => entry.routes),
    notes: changes.flatMap((entry) => entry.notes)
  };
}

function nothingToRestore(plan) {
  const committed = plan.entries.find((entry) => entry.code === 'INPUT_RESTORE_COMMITTED_DRIFT');
  const code = committed ? 'INPUT_RESTORE_COMMITTED_DRIFT'
    : plan.entries.find((entry) => entry.code)?.code ?? 'INPUT_RESTORE_NOTHING_TO_RESTORE';
  const reasons = plan.entries.map((entry) => `${entry.path ?? entry.phase}: ${entry.reason}`);
  return new SingularityFlowError(
    plan.entries.length
      ? `No input of ${plan.phase} can be restored from approved bytes:\n- ${reasons.join('\n- ')}`
      : `Every approved input of ${plan.phase} already matches its approved bytes; nothing needs restoring.`,
    { code, details: {
      workId: plan.workId, phase: plan.phase, currentPhase: plan.phase,
      upstreamPhases: [...new Set(plan.entries.map((entry) => entry.phase))],
      findings: plan.entries.map((entry) => ({ phase: entry.phase, path: entry.path, status: entry.status,
        code: entry.code, message: entry.reason })),
      routes: plan.routes, notes: plan.notes
    } }
  );
}

/** Checkpoint, then restore the exact approved bytes of every restorable entry of a confirmed plan. */
export async function applyInputRestore(root, config, workflow, phaseId = null, { confirm = null } = {}) {
  const phase = restorePhase(workflow, phaseId);
  if (workflow.currentPhase !== phase.id || !['in_progress', 'awaiting_approval'].includes(phase.status)) {
    throw new SingularityFlowError(
      `Restore approved inputs from the current phase. ${phase.id} is ${phase.status}; the Story is at ${workflow.currentPhase ?? 'no active phase'}.`,
      { code: 'INPUT_RESTORE_PHASE_NOT_CURRENT', details: { workId: workflow.workItem.id, phase: phase.id,
        currentPhase: workflow.currentPhase ?? null } }
    );
  }
  return withSubjectLock(root, { kind: 'story', id: workflow.workItem.id }, async () => {
    const plan = await inputRestorePlan(root, config, workflow, phase.id);
    if (plan.planSha256 !== confirm) {
      throw new SingularityFlowError(
        `The input restore plan changed since it was previewed, or the confirmation does not match. Preview it again with: singularity-flow inputs restore ${phase.id}`,
        { code: 'INPUT_RESTORE_PLAN_CHANGED', details: { workId: workflow.workItem.id, phase: phase.id,
          currentPhase: phase.id, planSha256: plan.planSha256,
          recoveryCommand: `singularity-flow inputs restore ${phase.id} --json` } }
      );
    }
    const restorable = plan.entries.filter((entry) => entry.restorable);
    if (!restorable.length) throw nothingToRestore(plan);
    const checkpoint = await createPhaseCheckpoint(root, config, workflow, phase);
    const restored = [];
    for (const entry of restorable) {
      const bytes = committedFileBytes(root, entry.source.commit, entry.path);
      if (!bytes || sha256(bytes) !== plain(entry.approvedSha256)) {
        throw new SingularityFlowError(
          `The approved bytes of ${entry.path} are no longer readable from ${entry.source.commit.slice(0, 12)}. Nothing further was restored; checkpoint ${checkpoint.id} holds the earlier copy.`,
          { code: 'INPUT_RESTORE_SOURCE_UNAVAILABLE', details: { workId: workflow.workItem.id, phase: phase.id,
            path: entry.path, checkpoint: checkpoint.id, restored } }
        );
      }
      const target = await secureRepositoryPath(root, entry.path, { label: `Approved ${entry.phase} input` });
      await writeAtomic(target.absolute, bytes);
      const written = await snapshot(target.absolute);
      if (written.sha256 !== plain(entry.approvedSha256)) {
        throw new SingularityFlowError(`${entry.path} did not read back with its approved digest after the restore.`, {
          code: 'INPUT_RESTORE_VERIFICATION_FAILED', details: { workId: workflow.workItem.id, phase: phase.id,
            path: entry.path, checkpoint: checkpoint.id }
        });
      }
      restored.push({ phase: entry.phase, path: entry.path, approvedSha256: entry.approvedSha256,
        previousSha256: entry.currentSha256, source: entry.source });
    }
    return {
      status: 'restored', workId: workflow.workItem.id, phase: phase.id, planSha256: plan.planSha256,
      restored, skipped: plan.entries.filter((entry) => !entry.restorable),
      checkpoint: { id: checkpoint.id, files: checkpoint.files, next: checkpoint.next },
      effects: { workingTreeChanged: true, indexChanged: false, storyStateChanged: false, committed: false, pushed: false },
      next: `singularity-flow inputs ${phase.id} --dry-run --json`,
      routes: plan.routes, notes: plan.notes
    };
  });
}

function planLines(plan) {
  const lines = [`Input restore plan — ${plan.workId}/${plan.phase}`, `Plan: ${plan.planSha256}`, ''];
  if (!plan.entries.length) lines.push('Every approved input already matches its approved bytes.');
  for (const entry of plan.entries) {
    lines.push(`${entry.restorable ? 'RESTORE' : 'KEEP'} ${entry.path ?? entry.phase} (from ${entry.phase}, ${entry.status})`);
    lines.push(`  approved ${entry.approvedSha256 ?? 'none'}; now ${entry.currentSha256 ?? 'missing'}`);
    if (entry.restorable) lines.push(`  bytes come from HEAD ${entry.source.commit.slice(0, 12)}, which holds the approved copy`);
    if (entry.reason) lines.push(`  ${entry.reason}`);
  }
  return lines;
}

function routeLines(result) {
  return [
    ...result.routes.map((route) => `Route: ${route.label}\n  ${route.command}`),
    ...result.notes.map((note) => `Note: ${note}`)
  ];
}

export async function inputsRestoreCommand(root, positionals, options) {
  if (positionals.length > 3) {
    throw new SingularityFlowError('Use singularity-flow inputs restore [PHASE] [--confirm PLAN-SHA256] [--json].', {
      code: 'INPUT_RESTORE_ARGUMENTS_INVALID'
    });
  }
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const { definition: config, workflow } = await loadAcceptedStoryExecution(root);
  const confirm = optionString(options, 'confirm');
  const json = optionBoolean(options, 'json');
  if (!confirm) {
    const plan = await inputRestorePlan(root, config, workflow, positionals[2] ?? null);
    if (json) {
      console.log(JSON.stringify({ resultType: 'sflow-input-restore', status: 'preview', ...plan,
        effects: { workingTreeChanged: false, indexChanged: false, storyStateChanged: false } }, null, 2));
      return;
    }
    const lines = planLines(plan);
    if (plan.confirmCommand) lines.push('', `Restore with: ${plan.confirmCommand}`, 'A private checkpoint of every dirty file and the Git index is saved first; nothing is staged or committed.');
    if (plan.routes.length || plan.notes.length) lines.push('', ...routeLines(plan));
    console.log(lines.join('\n'));
    return;
  }
  const result = await applyInputRestore(root, config, workflow, positionals[2] ?? null, { confirm });
  if (json) {
    console.log(JSON.stringify({ resultType: 'sflow-input-restore', ...result }, null, 2));
    return;
  }
  console.log([
    `Restored ${result.restored.length} approved input file(s) for ${result.phase}:`,
    ...result.restored.map((entry) => `  ${entry.path} (from ${entry.phase}) → ${entry.approvedSha256}`),
    `Checkpoint of the earlier copies: ${result.checkpoint.id}`,
    `  Inspect it with: ${result.checkpoint.next}`,
    `Check the inputs again with: ${result.next}`,
    ...(result.skipped.length ? ['', ...result.skipped.map((entry) => `Not restored ${entry.path ?? entry.phase}: ${entry.reason}`)] : []),
    ...(result.routes.length || result.notes.length ? ['', ...routeLines(result)] : [])
  ].join('\n'));
}
