/**
 * A capability's GitHub `requiredChecks` (CodeQL, SonarCloud, a CI job) as evidence beside a step's
 * review [CQF:REQ-055]: each check run's result on the commit the step submitted, read through gh as
 * `story checks` reads them (src/github-evidence.mjs), with gh's own sign-in. It is evidence only: it
 * never blocks a gate and never stands for an approval. A check that has not run yet reads as pending
 * or missing; GitHub unreachable, gh signed out or another host reads as unavailable.
 *
 * A read whose checks have all completed is kept in the checkout's private Git storage and read from
 * there again, since a completed run's conclusion does not change; any other is read at most once a
 * minute, so a review shown again and again asks GitHub once.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gitDir } from '../git.mjs';

const FRESH_MS = 60 * 1000;
const COMMIT = /^[0-9a-f]{40,64}$/u;

/** The Story's required check names: its source's and its capability's, as the Story pinned them. */
export function storyRequiredChecks(workflow) {
  return [...new Set((workflow?.lineage?.requiredChecks ?? []).map(String).filter(Boolean))];
}

function cacheFile(root, commit) {
  return path.join(gitDir(root), 'singularity-flow', 'required-checks', `${commit}.json`);
}

async function cached(root, commit, names, at) {
  try {
    const kept = JSON.parse(await readFile(cacheFile(root, commit), 'utf8'));
    if (JSON.stringify(kept.names) !== JSON.stringify(names)) return null;
    const settled = kept.evidence.status === 'read' && kept.evidence.checks.every((check) => ['passed', 'failed'].includes(check.status));
    return settled || Date.parse(at) - Date.parse(kept.evidence.observedAt) < FRESH_MS ? kept.evidence : null;
  } catch { return null; }
}

/** The words a reviewer reads for one read, on one line. */
export function requiredCheckWords(evidence) {
  if (!evidence || evidence.status === 'not-required') return null;
  const commit = String(evidence.commit ?? '').slice(0, 12);
  if (evidence.status !== 'read') return `Required checks on ${commit} could not be read (${evidence.reason}); they are evidence only and block nothing.`;
  return `Required checks on ${commit}: ${evidence.checks.map((check) => `${check.name} ${check.status}`).join(' · ')}. They are evidence for the reviewer; approval does not wait on them.`;
}

/**
 * The required checks' results on `commit`. `runCommand` is the process runner gh is asked through
 * (tests give their own); `refresh` reads GitHub even when a kept read would do.
 */
export async function requiredCheckEvidence(root, config, workflow, { commit, runCommand = null, refresh = false, at = new Date().toISOString() } = {}) {
  const names = storyRequiredChecks(workflow);
  if (!names.length) return { status: 'not-required', commit: commit ?? null, checks: [] };
  if (!COMMIT.test(String(commit ?? ''))) return { status: 'unavailable', commit: commit ?? null, reason: 'the step has no submitted commit to read', checks: [], observedAt: at };
  const kept = refresh ? null : await cached(root, commit, names, at);
  if (kept) return kept;
  let evidence;
  try {
    const { repositoryCheckEvidence, storyCheckRemote } = await import('../github-evidence.mjs');
    const options = runCommand ? { runCommand } : {};
    const read = repositoryCheckEvidence(root, { workId: workflow.workItem.id, remote: storyCheckRemote(root, config, ...(runCommand ? [runCommand] : [])), commit,
      requiredChecks: names, ...options });
    const runs = new Map((read.checkRuns ?? []).map((run) => [run.name, run]));
    evidence = { status: 'read', commit, repository: read.repository ?? null, observedAt: read.observedAt ?? at,
      checks: read.required.map((entry) => ({ name: entry.name, status: entry.status, conclusion: entry.conclusion ?? null,
        url: runs.get(entry.name)?.url ?? null, app: runs.get(entry.name)?.app ?? null })) };
  } catch (error) {
    evidence = { status: 'unavailable', commit, reason: String(error?.message ?? error).replace(/\s+/gu, ' ').slice(0, 300), checks: names.map((name) => ({ name, status: 'unread' })), observedAt: at };
  }
  try {
    await mkdir(path.dirname(cacheFile(root, commit)), { recursive: true, mode: 0o700 });
    await writeFile(cacheFile(root, commit), `${JSON.stringify({ names, evidence })}\n`, { mode: 0o600 });
  } catch { /* evidence only: a read that cannot be kept is read again */ }
  return evidence;
}
