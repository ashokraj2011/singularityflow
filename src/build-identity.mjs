/**
 * One value that changes whenever the running engine does. `[perf]`
 *
 * Machine-local receipts minted by one build must not steer another. A stamped package already
 * names its commit or source digest. A development checkout carries no stamp, and its version has
 * stayed the same across hundreds of changed lines, so the modules that decide Story intake and
 * start are identified by size and modification time as well. Nothing here reads file content or
 * records a path.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { versionLine } from './build-info.mjs';

const DECIDING_MODULES = Object.freeze([
  'cli.mjs', 'capability-start.mjs', 'configuration-branch.mjs', 'story-intake-receipt.mjs',
  'story-intake-verification.mjs', 'build-info.mjs', 'version.mjs',
  'configuration-state-service.mjs', 'configuration-state-git.mjs', 'configuration-proposal.mjs',
  'configuration-definition-cache.mjs', 'configuration-object-store.mjs',
  'configuration-read-worker.mjs', 'configuration-read-worker-client.mjs', 'config.mjs',
  'read-worker.mjs', 'read-worker-client.mjs', 'read-worker-protocol.mjs', 'read-worker-service.mjs',
  'command-observability.mjs', 'command-confirmation.mjs', 'phase-generation.mjs', 'cli-steps.mjs',
  'commands/session.mjs', 'commands/session-entry.mjs', 'commands/choices.mjs', 'commands/choices-entry.mjs',
  'commands/phase-lifecycle.mjs', 'commands/prepare.mjs', 'commands/inputs.mjs',
  'commands/review-source.mjs', 'commands/submit.mjs', 'commands/approve.mjs',
  'commands/help.mjs', 'commands/inbox.mjs', 'commands/progress.mjs', 'commands/report.mjs',
  'commands/receipt.mjs', 'commands/guide.mjs', 'commands/validate.mjs', 'commands/doctor.mjs',
  'commands/telemetry.mjs', 'commands/context.mjs', 'commands/wm.mjs', 'commands/secrets.mjs',
  'commands/story.mjs', 'commands/logs.mjs', 'commands/session-open-local.mjs', 'session-read-service.mjs', 'stable-read.mjs',
  'commands/start.mjs', 'commands/shared/start-context.mjs',
  'commands/shared/session-repository-selection.mjs',
  'commands/shared/session-repository-authority.mjs', 'commands/shared/session-repository-remotes.mjs',
  'commands/shared/session-discovery-configuration.mjs', 'commands/shared/definition-at-ref.mjs',
  'commands/shared/git-answer.mjs', 'commands/shared/accepted-story-execution-if-present.mjs',
  'commands/shared/checklist-decisions.mjs', 'commands/shared/completion-continuation.mjs',
  'commands/shared/convergence-preparation-state.mjs', 'commands/shared/copilot-activity-line.mjs',
  'commands/shared/decision-workflow.mjs', 'commands/shared/path-for-display.mjs',
  'commands/shared/phase-review.mjs', 'commands/shared/post-publication-step.mjs',
  'commands/shared/prepare-configured-phase.mjs', 'commands/shared/prepared-phase-next-actions.mjs',
  'commands/shared/print-command-routes.mjs', 'commands/shared/print-phase-review.mjs',
  'commands/shared/print-selection-receipt.mjs', 'commands/shared/record-required-receipts-after-transition.mjs',
  'commands/shared/selected-phase-argument.mjs', 'commands/shared/step-action-hold-after-transition.mjs',
  'commands/shared/story-draft-transaction.mjs', 'commands/shared/with-refusal-memory.mjs'
]);

let memoized = null;

export function runningBuildIdentity() {
  if (memoized) return memoized;
  const hash = createHash('sha256').update(versionLine());
  for (const name of DECIDING_MODULES) {
    try {
      const entry = statSync(fileURLToPath(new URL(`./${name}`, import.meta.url)));
      hash.update(`\0${name}:${entry.size}:${entry.mtimeMs}`);
    } catch {
      hash.update(`\0${name}:absent`);
    }
  }
  memoized = `sha256:${hash.digest('hex')}`;
  return memoized;
}
