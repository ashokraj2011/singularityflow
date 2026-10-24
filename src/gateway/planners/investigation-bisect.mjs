/**
 * `investigation.bisect`: a confirmed, disposable search for the introducing commit.
 * `[INT:IFC-042]` `[INT:CON-095]` `[INT:CON-096]` `[INT:CON-097]` `[INT:REQ-095]` `[INT:REQ-083]`
 *
 * The planner names everything a person is confirming: the exact known-good and known-bad commits,
 * the repository, the configured test command by ID (with the argv it runs, so nothing is hidden),
 * the signal, the most steps it will take, where the disposable worktrees go, the network policy
 * as it actually is, and what is cleaned up. Only commands the repository's own workflow declares
 * as `kind: test` with argv are allowed; words from a conversation never become arguments.
 *
 * The executor checks each commit out into a new detached worktree under the system temporary
 * directory — never the developer's — runs the command, records the observation, and removes it.
 * An "introducing commit" is `verified` only when both endpoints behave as claimed and the boundary
 * reproduces on a second run under the same command; anything less stays a `candidate`, and a run
 * whose endpoints contradict the claim is `unknown` with the contradiction recorded.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SingularityFlowError } from '../../util.mjs';
import { planDescriptor } from '../plan-descriptor.mjs';
import { effects, plannerNavigation, sflowResult } from '../result.mjs';
import { configuredTestCommands } from './problem-investigate.mjs';

export { configuredTestCommands };

const STEP_TIMEOUT_MS = 10 * 60 * 1000;
/** The most first-parent commits one bisection walks. */
const MAX_RANGE_COMMITS = 4096;

/**
 * The walked range, exact or refused. Past the cap, or with the known-good commit off the known-bad
 * one's first-parent chain, the range does not start at the known-good commit's child, and a
 * boundary "verified" in it would be drawn between commits that are not neighbours.
 */
function exactRange(typedFirstParentRange, root, good, bad) {
  const range = typedFirstParentRange(root, good, bad, { max: MAX_RANGE_COMMITS });
  if (!range?.commits.length) {
    throw new SingularityFlowError('The known-good commit is not an ancestor of the known-bad one.', { code: 'BISECT_RANGE_INVALID' });
  }
  if (range.truncated) {
    throw new SingularityFlowError(`More than ${MAX_RANGE_COMMITS} first-parent commits separate the endpoints; choose a known-good commit closer to the known-bad one.`, {
      code: 'BISECT_RANGE_TOO_LONG', details: { maximum: MAX_RANGE_COMMITS }
    });
  }
  if (!range.firstParentChain) {
    throw new SingularityFlowError('The known-good commit is reached only through a merge, not along the known-bad commit\'s first-parent history; choose one on that history, such as the merge\'s first parent.', {
      code: 'BISECT_RANGE_NOT_FIRST_PARENT'
    });
  }
  return range.commits;
}

export async function investigationBisectPlan({ arguments: args = {}, root = null } = {}) {
  if (!root) throw new SingularityFlowError('Bisection needs the repository it runs against.', { code: 'BISECT_NO_ROOT' });
  const [{ loadDefinition }, { typedFirstParentRange, typedRevision }] = await Promise.all([
    import('../../config.mjs'), import('../../git-access.mjs')
  ]);
  const commands = configuredTestCommands(await loadDefinition(root));
  const command = commands.find((entry) => entry.id === args.testCommandId);
  if (!command) {
    throw new SingularityFlowError(`'${args.testCommandId}' is not a test command this repository configures.`, {
      code: 'BISECT_TEST_COMMAND_UNKNOWN', details: { known: commands.map((entry) => entry.id) }
    });
  }
  const good = typedRevision(root, args.good);
  const bad = typedRevision(root, args.bad ?? 'HEAD');
  if (!good || !bad) throw new SingularityFlowError('Both bisection endpoints must be exact revisions here.', { code: 'BISECT_REVISION_UNRESOLVED' });
  const range = exactRange(typedFirstParentRange, root, good, bad);
  const needed = Math.ceil(Math.log2(range.length + 1)) + 4;
  return planDescriptor({
    effects: { filesChanged: true },
    idempotencyKey: `investigation.bisect:${root}:${good}:${bad}:${command.id}`,
    preview: {
      action: 'bisect',
      repository: root,
      good: { revision: String(args.good), commit: good },
      bad: { revision: String(args.bad ?? 'HEAD'), commit: bad },
      commitsInRange: range.length,
      testCommand: command,
      signal: 'exit status 0 passes; any other status or a timeout fails',
      maxSteps: Math.min(args.maxSteps ?? needed, needed),
      disposableWorktrees: path.join(os.tmpdir(), 'sflow-bisect-*'),
      networkPolicy: 'inherited: SFlow does not isolate the network of a configured test command',
      cleanup: 'each disposable worktree is removed after its step, and the directory at the end or on failure',
      developerWorktree: 'never checked out or modified'
    }
  });
}

/** Run the reviewed bisection. Every observation is kept, including those before a stop. */
export async function investigationBisectExecute({ plan, root }) {
  const preview = plan.review.preview;
  const [{ addCandidateWorktree, removeCandidateWorktree }, { runQualityCommand }, { typedFirstParentRange }] = await Promise.all([
    import('../../git.mjs'), import('../../quality-command-runner.mjs'), import('../../git-access.mjs')
  ]);
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-bisect-'));
  if (path.resolve(base).startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new SingularityFlowError('A disposable worktree must be outside the repository.', { code: 'BISECT_WORKTREE_UNSAFE' });
  }
  const observations = [];
  let steps = 0;
  const testAt = async (commit) => {
    steps += 1;
    const target = path.join(base, `step-${steps}`);
    if (!addCandidateWorktree(root, target, commit)) {
      throw new SingularityFlowError(`A disposable worktree for ${commit.slice(0, 12)} could not be created.`, { code: 'BISECT_WORKTREE_FAILED' });
    }
    try {
      const [executable, ...args] = preview.testCommand.argv;
      const ran = await runQualityCommand(executable, args, {
        cwd: path.join(target, preview.testCommand.workingDirectory), timeoutMs: STEP_TIMEOUT_MS, captureBytes: 4096
      });
      const passed = ran.status === 0 && !ran.timedOut;
      observations.push({ step: steps, commit, passed, status: ran.status ?? null, timedOut: Boolean(ran.timedOut) });
      return passed;
    } finally {
      removeCandidateWorktree(root, target);
      await rm(target, { recursive: true, force: true });
    }
  };
  let verdict;
  try {
    // Checked again here, before any commit is tested: a plan made any other way gets no verdict either.
    const range = exactRange(typedFirstParentRange, root, preview.good.commit, preview.bad.commit);
    const goodPasses = await testAt(preview.good.commit);
    const badFails = !(await testAt(preview.bad.commit));
    if (!goodPasses || !badFails) {
      verdict = { confidence: 'unknown', boundary: null, contradiction: { goodPasses, badFails } };
    } else {
      let low = -1;
      let high = range.length - 1;
      while (high - low > 1 && steps < preview.maxSteps - 2) {
        const middle = Math.floor((low + high) / 2);
        if (await testAt(range[middle])) low = middle; else high = middle;
      }
      const lastPassing = low < 0 ? preview.good.commit : range[low];
      const firstFailing = range[high];
      if (high - low === 1) {
        // The same command, the same commits, again: a boundary that reproduces is a verdict.
        const reproduced = (await testAt(lastPassing)) && !(await testAt(firstFailing));
        verdict = { confidence: reproduced ? 'verified' : 'candidate', boundary: { lastPassing, firstFailing }, reproduced };
      } else {
        verdict = { confidence: 'candidate', boundary: { lastPassing, firstFailing, unresolvedCommits: high - low - 1 }, reproduced: false };
      }
    }
  } catch (error) {
    verdict = { confidence: 'unknown', boundary: null, stopped: String(error?.code ?? error?.message ?? 'failed').slice(0, 128) };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  const firstFailing = verdict.boundary?.firstFailing ?? null;
  return sflowResult({
    kind: 'read',
    operation: { id: 'investigation.bisect', classification: 'mutation' },
    subject: { kind: 'repository', id: preview.repository, revision: { sourceCommit: preview.bad.commit } },
    outcome: { status: 'succeeded', messageId: 'gateway.completed', slots: { confidence: verdict.confidence, steps: String(steps) } },
    effects: effects({ filesChanged: true }),
    why: [{
      code: verdict.confidence === 'verified' ? 'investigation.boundary-verified'
        : verdict.confidence === 'candidate' ? 'investigation.boundary-candidate' : 'investigation.boundary-unknown',
      source: 'evidence', reference: firstFailing, slots: { steps: String(steps), command: preview.testCommand.id }
    }],
    next: firstFailing ? [plannerNavigation({
      handle: `bisect:show:${firstFailing}`, id: 'bisect:show-change', label: 'Show the exact change', rank: 0, kind: 'read',
      reasonCode: 'investigation.boundary-candidate', confirmation: 'none', interaction: 'navigation', emphasis: 'primary', executable: false,
      fallback: { label: 'Show it in the terminal', command: 'sflow explain investigation' }
    }, 'repository.query', { query: 'commit', revision: firstFailing })] : [],
    restState: firstFailing ? null : 'informational',
    data: {
      verdict: verdict.confidence,
      boundary: verdict.boundary,
      contradiction: verdict.contradiction ?? null,
      stopped: verdict.stopped ?? null,
      observations,
      command: preview.testCommand.id,
      disposableWorktreesRemoved: true,
      developerWorktreeTouched: false
    }
  });
}
