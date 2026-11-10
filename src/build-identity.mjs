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
  'schema-migrations.mjs', 'foundation/package.json', 'foundation/record-schema.mjs', 'foundation/failures.mjs',
  'story-intake-verification.mjs', 'build-info.mjs', 'version.mjs',
  'configuration-state-service.mjs', 'configuration-state-git.mjs', 'configuration-proposal.mjs',
  'configuration-definition-cache.mjs', 'configuration-object-store.mjs',
  'configuration-read-worker.mjs', 'configuration-read-worker-client.mjs', 'config.mjs',
  'read-worker.mjs', 'read-worker-client.mjs', 'read-worker-protocol.mjs', 'read-worker-service.mjs',
  'command-observability.mjs', 'command-confirmation.mjs', 'phase-generation.mjs', 'cli-steps.mjs',
  'kernel/decision-plan.mjs',
  'kernel/decision-limits.mjs',
  'engine-sdk/decision-execution.mjs',
  'engine-compatibility/git-decisions.mjs',
  'engine-compatibility/git-decision-record.mjs', 'commands/decision-record.mjs',
    'engine-compatibility/git-plan-correction.mjs', 'commands/decision-plan.mjs', 'commands/plan-correction.mjs',
    'engine-compatibility/git-upstream.mjs', 'engine-compatibility/native-forward-amendments.mjs', 'engine-compatibility/upstream-artifact-issues.mjs',
    'engine-compatibility/git-query.mjs', 'engine-compatibility/git-nextsteps.mjs', 'engine-compatibility/nextsteps-deferred.mjs', 'nextsteps.mjs', 'commands/nextsteps.mjs', 'engine-compatibility/git-phase-review.mjs', 'engine-compatibility/native-phase-review.mjs',
    'api.mjs', 'documents-read.mjs', 'commands/phase-show.mjs', 'agent-briefs.mjs',
    'engine-compatibility/native-witness-decisions.mjs', 'commands/decision-witness.mjs', 'commands/decision-witness-exception.mjs',
    'engine-compatibility/git-test-decision-record.mjs', 'engine-compatibility/record-decision-context.mjs',
    'engine-compatibility/test-decision-intent.mjs', 'commands/shared/test-decision-operation.mjs', 'test-command-selection.mjs',
  'engine-compatibility/native-story-decisions.mjs',
  'engine-compatibility/native-plan-decisions.mjs',
  'engine-compatibility/native-obligation-risk.mjs',
  'engine-compatibility/native-evidence-decisions.mjs', 'engine-compatibility/native-visual-decisions.mjs',
  'engine-compatibility/native-test-command-decisions.mjs', 'engine-compatibility/native-test-narrowing-decisions.mjs',
  'engine-compatibility/native-test-risk-decisions.mjs', 'engine-compatibility/native-upstream-decisions.mjs',
  'commands/decision-evidence-reuse.mjs', 'commands/decision-visual-profile.mjs',
  'commands/decision-test-command.mjs', 'commands/decision-test-narrowing.mjs',
  'commands/decision-test-risk.mjs', 'commands/upstream-issue.mjs',
  'commands/decision-story-records.mjs', 'commands/decision-plan-amendment.mjs', 'commands/decision-obligation-risk.mjs',
  'decision-list.mjs',
  'plan-amendments.mjs',
  'commands/decisions.mjs',
  'clarifications.mjs', 'clarification-markers.mjs', 'skp-contract.mjs',
  'kernel/phase-inputs.mjs', 'inputs.mjs', 'verification/witness-decisions.mjs',
  'kernel/auto-policy.mjs', 'auto/auto-plan-read.mjs',
  'kernel/adhoc-policy.mjs',
  'kernel/mcp-policy.mjs',
  'kernel/step-action-policy.mjs',
  'kernel/test-report-codec.mjs','kernel/phase-checks.mjs','verification/test-report-reader.mjs','test-runtime.mjs',
  'kernel/javascript-declarations.mjs','kernel/source-comments.mjs','engine-compatibility/node-source-analysis.mjs',
  'kernel/code-documentation.mjs','kernel/polyglot-lexical.mjs',
  'kernel/code-delivery-evidence.mjs','implementation-bindings.mjs',
  'kernel/configuration-policy.mjs', 'kernel/configuration-declarations.mjs', 'kernel/configuration-path-policies.mjs',
  'kernel/specification-policy.mjs', 'kernel/skill-binding-header.mjs',
  'kernel/skill-phase-contract.mjs', 'foundation/portable-paths.mjs', 'configuration-read-scope.mjs', 'engine-compatibility/node-network-syntax.mjs', 'repository-commit-policy/diagnostics.mjs',
  'records.mjs', 'kernel/workflow-obligations.mjs', 'kernel/phase-responsibilities.mjs',
  'repository-commit-policy/policy.mjs', 'repository-commit-policy/profile.mjs', 'repository-commit-policy/pattern.mjs',
  'engine-compatibility/node-workflow-obligations.mjs',
  'engine-compatibility/node-configuration-path.mjs',
  'kernel/workflow-configuration.mjs', 'kernel/phase-admission.mjs', 'kernel/lifecycle-transitions.mjs', 'sequence.mjs', 'phase-actor-policy.mjs',
  'kernel/phase-entry.mjs', 'phase-entry.mjs', 'phase-entry-context.mjs',
  'kernel/phase-prepublish.mjs', 'kernel/phase-preparation.mjs', 'kernel/phase-findings.mjs', 'phase-prepublish.mjs', 'phase-draft-check.mjs', 'phase-finding-policy.mjs', 'code-delivery-policy.mjs',
  'source-review-policy.mjs', 'phase-inspection-generation.mjs', 'phase-generation-need.mjs',
  'phase-entry-admission.mjs', 'phase-entry-authoring.mjs', 'phase-input-policy.mjs', 'document-runtime.mjs',
  'engine-compatibility/git-phase-entry.mjs', 'engine-compatibility/native-phase-entry.mjs', 'engine-compatibility/native-convergence.mjs',
  'kernel/document-read.mjs', 'engine-compatibility/git-document-read.mjs', 'engine-compatibility/native-document-references.mjs',
  'commands/documents.mjs', 'commands/documents-view.mjs',
  'commands/shared/document-options.mjs', 'commands/shared/document-presentation.mjs',
  'engine-sdk/index.mjs', 'kernel/project-enrollment.mjs', 'kernel/phase-policy.mjs', 'kernel/next-plan.mjs', 'kernel/artifact-content.mjs', 'kernel/conformance-report.mjs',
  'kernel/scope-statements.mjs', 'kernel/scope-inventory.mjs', 'kernel/scope-decisions.mjs', 'kernel/applicability.mjs', 'kernel/test-recovery.mjs', 'kernel/upstream-issues.mjs', 'kernel/story-documents.mjs', 'kernel/plan-amendments.mjs', 'kernel/obligation-risks.mjs', 'engine-compatibility/node-scope-policy.mjs', 'engine-compatibility/node-plan-policy.mjs', 'engine-compatibility/git-scope-context.mjs', 'foundation/traceability-ids.mjs', 'kernel/publication-intent.mjs',
  'kernel/workflow-assets.mjs', 'engine-compatibility/git-workflow-assets.mjs', 'workflow-transfer.mjs',
  'kernel/decision-inputs.mjs', 'kernel/workflow-decisions.mjs', 'kernel/submission-intent.mjs',
  'kernel/approval-policy.mjs', 'kernel/approval-fallback.mjs',
  'engine-compatibility/post-transition.mjs', 'phase-post-transition-guidance.mjs',
  'engine-compatibility/git-publication.mjs', 'engine-compatibility/generation-publication.mjs',
  'engine-compatibility/git-submission.mjs', 'engine-compatibility/submission-transition.mjs',
  'engine-compatibility/git-advancement.mjs', 'engine-compatibility/convergence-projection-read.mjs',
  'engine-compatibility/git-approval.mjs', 'engine-compatibility/approval-transition.mjs',
  'engine-compatibility/decision-context.mjs',
  'phase-publication-guidance.mjs',
  'commands/session.mjs', 'commands/session-entry.mjs', 'commands/session-current.mjs', 'commands/choices.mjs', 'commands/choices-entry.mjs',
  'commands/phase-lifecycle.mjs', 'commands/prepare.mjs', 'commands/inputs.mjs',
  'commands/review-source.mjs', 'commands/submit.mjs', 'commands/approve.mjs',
  'commands/help.mjs', 'commands/inbox.mjs', 'commands/progress.mjs', 'commands/report.mjs',
  'commands/receipt.mjs', 'commands/guide.mjs', 'commands/validate.mjs', 'commands/doctor.mjs',
  'commands/telemetry.mjs', 'commands/context.mjs', 'commands/wm.mjs', 'commands/secrets.mjs',
  'commands/story.mjs', 'commands/logs.mjs', 'commands/session-open-local.mjs', 'session-read-service.mjs', 'stable-read.mjs',
  'commands/start.mjs', 'commands/shared/start-context.mjs',
  'commands/shared/session-repository-selection.mjs',
  'commands/shared/session-repository-authority.mjs', 'commands/shared/session-repository-remotes.mjs',
  'commands/shared/session-storage-refusal.mjs',
  'commands/shared/session-discovery-configuration.mjs', 'commands/shared/definition-at-ref.mjs',
  'commands/shared/git-answer.mjs', 'commands/shared/accepted-story-execution-if-present.mjs',
  'commands/shared/checklist-decisions.mjs', 'commands/shared/completion-continuation.mjs',
  'commands/shared/convergence-preparation-state.mjs', 'commands/shared/copilot-activity-line.mjs',
  'commands/shared/decision-workflow.mjs', 'commands/shared/path-for-display.mjs',
  'commands/shared/phase-review.mjs', 'commands/shared/post-publication-step.mjs',
  'commands/shared/prepare-configured-phase.mjs', 'commands/shared/prepared-phase-next-actions.mjs',
  'commands/shared/print-command-routes.mjs', 'commands/shared/print-phase-review.mjs',
  'commands/shared/print-selection-receipt.mjs', 'commands/shared/record-required-receipts-after-transition.mjs',
  'commands/shared/record-spec-usage-after-transition.mjs',
  'commands/shared/selected-phase-argument.mjs', 'commands/shared/step-action-hold-after-transition.mjs',
  'engine-compatibility/story-draft-transaction.mjs', 'commands/shared/story-draft-transaction.mjs',
  'generation-boundary.mjs', 'state.mjs',
  'commands/shared/with-refusal-memory.mjs'
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
