import path from 'node:path';

import { planAgentBriefs } from './agent-briefs.mjs';
import {
  evaluateCodeDeliveryPreflight, phaseRequiresCodeDelivery, resolveDeliveryQualityCommands
} from './delivery-evidence.mjs';
import {
  normalizeRequiredTestCommand, structuredTestCommandRequiredError
} from './code-delivery-tests.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import { inspectPhaseAuthoredReviewContent } from './publication-preflight.mjs';
import { applicationChangeSetProjection, applicationPathContext } from './work-intervals.mjs';
import { publishedGenerationCommit } from './generation-boundary.mjs';
import { phasePublicationCommand } from './manual-authorship.mjs';
import { assertConvergencePublicationReady } from './convergence-context.mjs';
import { generationSkillForPhase } from './code-delivery-policy.mjs';
import { directCopilotSkill } from './copilot-guidance.mjs';
import { convergenceReviewRoute } from './convergence-review-route.mjs';

function generationSkill(phase) {
  return directCopilotSkill(generationSkillForPhase(phase));
}

function action({ id, mode = 'guided', detail, command = null, skill = null, evidence = null, retry = null }) {
  return {
    id, safe: mode !== 'manual', automatic: mode === 'automatic', mode,
    detail, command, skill, evidence,
    confirmation: mode === 'automatic' ? 'plan-hash' : mode === 'manual' ? 'human-authority' : 'none',
    ...(retry ? { retry } : {})
  };
}

function artifactActions(workflow, phase, findings) {
  const first = findings[0];
  if (!first) return [];
  if (first.code === 'artifact.required.missing') return [action({
    id: `prepare-artifact:${phase.id}`,
    detail: `Create the required ${phase.id} artifact at ${first.path}.`,
    command: `singularity-flow prepare ${phase.id}`,
    skill: generationSkill(phase), evidence: { path: first.path, line: null }
  })];
  return [action({
    id: `complete-artifact:${phase.id}`,
    detail: first.line
      ? `Complete all ${findings.length} authoring blocker(s), starting at ${first.path}:${first.line}. A Copilot host must re-author from the governed prompt before retrying.`
      : `Complete all ${findings.length} authoring blocker(s) at ${first.path}. A Copilot host must re-author from the governed prompt before retrying.`,
    command: `singularity-flow phase show ${phase.id} --show-artifact`,
    skill: generationSkill(phase), evidence: { path: first.path, line: first.line },
    retry: {
      maximumAttempts: 1,
      requiresFingerprintChange: true,
      beforeRetry: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`,
      command: phasePublicationCommand(phase)
    }
  })];
}

export async function generationRecovery(root, workflow, phase, generationDigest) {
  if (!phaseRequiresCodeDelivery(phase)
      || phase.generationIntent?.status !== 'consumed'
      || Number(phase.generationIntent.generation) !== Number(phase.generation)) return null;
  const digest = await generationDigest(root, phase);
  if (digest === phase.generationIntent.publication?.resultDigest) return null;

  let command = null;
  let mode = 'guided';
  let changeSetDigest = null;
  let previousGenerationCommit = null;
  let publicationAuthorityError = null;
  let changeSetInspectionError = null;
  try {
    previousGenerationCommit = publishedGenerationCommit(root, workflow, phase, phase.generation);
  } catch (error) {
    publicationAuthorityError = error;
  }
  // A successor generation must be based on the authenticated prior publication, not merely an
  // older interval baseline. `beginCodeGeneration` enforces this too; do not offer a guided
  // rollover that can only fail after the user has reviewed and confirmed its digest.
  if (!previousGenerationCommit) mode = 'manual';
  const baseCommit = previousGenerationCommit;
  if (baseCommit) {
    try {
      const changeSet = await buildRepositoryChangeSet(root, {
        baseCommit,
        subject: {
          workId: workflow.workItem.id, phase: phase.id, generation: Number(phase.generation) + 1,
          generationIntentId: null
        }
      });
      const applicationChangeSet = applicationChangeSetProjection(
        changeSet, applicationPathContext(workflow)
      );
      if (applicationChangeSet.entries.length) {
        changeSetDigest = applicationChangeSet.digest;
      }
    } catch (error) {
      // The rollover command needs this same change-set inspection. Do not offer an apparently
      // guided action that can only fail after the user has confirmed its digest.
      changeSetInspectionError = error;
      mode = 'manual';
    }
  }
  const rolloverConfirmation = changeSetDigest ?? digest;
  if (mode !== 'manual') {
    command = `singularity-flow phase rollover ${phase.id} --confirm ${rolloverConfirmation}`;
  }
  return {
    blocker: {
      code: 'generation.intent.consumed-changed', category: 'lifecycle', blocking: true,
      phase: phase.id, generation: phase.generation, path: phase.generationIntent.path ?? null,
      line: null, value: null,
      details: {
        generationIntentId: phase.generationIntent.id,
        publishedResultDigest: phase.generationIntent.publication?.resultDigest ?? null,
        currentResultDigest: digest,
        changeSetDigest,
        rolloverConfirmation,
        riskAcceptance: {
          eligible: false,
          reason: 'A published generation may be superseded only by an authenticated successor; its changed bytes cannot be accepted as a waiver.'
        },
        changeSetInspection: changeSetInspectionError ? {
          code: changeSetInspectionError.code ?? 'GENERATION_CHANGE_SET_UNAVAILABLE',
          message: changeSetInspectionError.message
        } : null,
        publicationAuthority: publicationAuthorityError ? {
          code: publicationAuthorityError.code ?? 'GENERATION_PUBLICATION_UNAVAILABLE',
          message: publicationAuthorityError.message
        } : null
      }
    },
    action: action({
      id: mode === 'manual'
        ? `${!previousGenerationCommit ? 'repair-publication-authority' : 'repair-generation-change-set'}:${phase.id}`
        : `begin-new-generation:${phase.id}`, mode,
      detail: mode === 'manual'
        ? publicationAuthorityError
          ? `Published bytes changed, but the exact prior generation commit could not be authenticated (${publicationAuthorityError.code ?? 'GENERATION_PUBLICATION_UNAVAILABLE'}: ${publicationAuthorityError.message}). Preserve the work and repair or migrate publication authority before beginning another generation.`
          : changeSetInspectionError
            ? `Published bytes changed, but the application change set could not be inspected (${changeSetInspectionError.code ?? 'GENERATION_CHANGE_SET_UNAVAILABLE'}: ${changeSetInspectionError.message}). Preserve the work and repair the repository read before beginning another generation.`
            : 'Published bytes changed, but the exact prior generation commit is unavailable. Preserve the work and repair publication authority before beginning another generation.'
        : 'Review the exact current artifact and application changes, then begin a successor generation without changing the published generation. Use /sf-recover for this phase-scoped rollover; /sf-code resumes only after recovery clears.',
      command: mode === 'manual' ? 'singularity-flow doctor --json' : command,
      skill: mode === 'manual' ? '/sf-doctor' : '/sf-recover',
      evidence: { path: phase.generationIntent.path ?? null, line: null }
    })
  };
}

function projectionFinding(error, phase) {
  return {
    code: error.code === 'AGENT_BRIEF_HEADING_AMBIGUOUS'
      ? 'projection.agent-brief.heading-ambiguous'
      : `projection.agent-brief.${String(error.code ?? 'invalid').toLocaleLowerCase('en-US').replaceAll('_', '-')}`,
    category: 'projection', blocking: true, phase: phase.id, generation: Number(phase.generation) + 1,
    path: phase.requiredArtifact?.path ?? null,
    line: error.details?.lines?.[0] ?? null,
    value: error.details?.heading ?? null,
    details: { sourceCode: error.code ?? null, message: error.message, ...(error.details ?? {}) }
  };
}

/**
 * Inspect the prospective publication without writing workflow, projection, telemetry, or Git
 * state. Models and AST are deliberately absent: recovery classification is deterministic and AST
 * availability cannot block ordinary file-based work.
 */
export async function inspectPhaseRecovery(root, config, workflow, phase, { generationDigest } = {}) {
  if (!phase || !['in_progress', 'awaiting_approval'].includes(phase.status)) {
    return { phaseId: phase?.id ?? null, blockers: [], actions: [], requiresLifecycleRecovery: false,
      testExecution: { status: phase && phaseRequiresCodeDelivery(phase) ? 'unavailable' : 'not-required', commands: [] } };
  }
  const blockers = [];
  const actions = [];
  const testExecution = {
    status: phaseRequiresCodeDelivery(phase) ? 'unavailable' : 'not-required', commands: []
  };

  const generation = generationDigest
    ? await generationRecovery(root, workflow, phase, generationDigest)
    : null;
  if (generation) {
    blockers.push(generation.blocker);
    actions.push(generation.action);
  }

  const deterministicConvergence = phase.id === 'convergence';
  let artifactFindings = [];
  if (deterministicConvergence) {
    try {
      await assertConvergencePublicationReady(root, config, workflow, phase);
    } catch (error) {
      const review = convergenceReviewRoute(error, workflow);
      blockers.push({
        code: `convergence.${String(error.code ?? 'not-ready').toLocaleLowerCase('en-US').replaceAll('_', '-')}`,
        category: 'convergence', blocking: true, phase: phase.id,
        generation: Number(phase.generation) + 1,
        path: error.details?.path ?? null, line: null, value: null,
        details: { sourceCode: error.code ?? null, message: error.message, ...(error.details ?? {}) }
      });
      actions.push(action({
        id: review ? `convergence-${review.kind}` : 'prepare-convergence',
        detail: review?.guidance
          ?? 'Recompute the canonical projection from the current bound inputs, then follow only its returned review or publication action.',
        command: review?.command ?? 'singularity-flow prepare convergence',
        skill: review?.skill ?? '/sf-converge'
      }));
    }
  } else {
    artifactFindings = await inspectPhaseAuthoredReviewContent(root, config, workflow, phase);
    blockers.push(...artifactFindings.map((finding) => ({
      ...finding, blocking: true, phase: phase.id, generation: Number(phase.generation) + 1,
      details: {
        bytes: finding.bytes ?? null, minimumBytes: finding.minimumBytes ?? null
      }
    })));
    actions.push(...artifactActions(workflow, phase, artifactFindings));
  }

  if (!artifactFindings.length && !blockers.some((finding) => finding.category === 'convergence')) {
    const itemRelative = `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}`;
    try {
      await planAgentBriefs(root, workflow, phase, {
        itemDirectory: path.join(root, itemRelative), itemRelative,
        generation: Number(phase.generation) + 1
      });
    } catch (error) {
      blockers.push(projectionFinding(error, phase));
      actions.push(action({
        id: `repair-agent-brief-source:${phase.id}`,
        detail: `${error.message} Edit only the authored source; approved managed inputs and existing published briefs remain preserved.`,
        command: `singularity-flow phase show ${phase.id} --show-artifact`,
        skill: generationSkill(phase),
        evidence: {
          path: `${itemRelative}/${phase.requiredArtifact.path}`,
          line: error.details?.lines?.[0] ?? null
        }
      }));
    }

    const publishedCodeGeneration = phaseRequiresCodeDelivery(phase)
      && phase.generationIntent?.status === 'consumed';
    if (phaseRequiresCodeDelivery(phase)
        && ((phase.generationIntent?.status === 'open' && !generation)
          || publishedCodeGeneration)) {
      let testCommands = [];
      try {
        // An already published generation has no open intent. Its retained delivery paths are
        // sufficient for a read-only runner preview; prospective change-set preflight would
        // incorrectly reject that lifecycle state before showing the command. Publication still
        // requires a guarded rollover and a fresh test execution for the successor generation.
        const deliveryEvidence = publishedCodeGeneration
          ? phase.deliveryEvidence
          : await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
        testCommands = (await resolveDeliveryQualityCommands(root, {
          ...phase, deliveryEvidence
        })).filter((command) => command && typeof command === 'object'
          && !Array.isArray(command) && command.kind === 'test');
        const normalized = testCommands.map((command, index) =>
          normalizeRequiredTestCommand(command, index));
        if (!testCommands.length) throw structuredTestCommandRequiredError(phase);
        const testPolicy = workflow.resolution?.codeDelivery?.tests;
        testExecution.status = 'not-run';
        testExecution.commands = normalized.map((command, index) => {
          // Native inference emits a bounded, known argv. Approved configured argv can contain
          // arbitrary positional secrets, so the read-only JSON projection never echoes it.
          const configuredIndex = (phase.qualityCommands ?? []).indexOf(testCommands[index]);
          const configured = configuredIndex >= 0;
          return {
            id: configured ? `qualityCommands[${configuredIndex}]` : command.id,
            argv: configured ? null : command.argv,
            argvSource: configured ? 'approved-configuration' : 'inferred',
            workingDirectory: command.workingDirectory,
            affectedRoots: command.affectedRoots,
            result: {
              adapter: command.result.adapter,
              path: command.result.path,
              minimumDiscovered: Math.max(command.result.minimumDiscovered,
                testPolicy?.minimumDiscovered ?? 1),
              minimumPassed: Math.max(command.result.minimumPassed,
                testPolicy?.minimumPassed ?? 1)
            }
          };
        });
      } catch (error) {
        if (publishedCodeGeneration) {
          // The published generation is preserved. A changed or unavailable current checkout
          // cannot retroactively invalidate its retained test receipt; the guarded rollover is
          // responsible for validating any new generation against current repository inputs.
          testExecution.status = 'unavailable';
        } else {
          const missingRepositoryRunner = error.code === 'CODE_DELIVERY_TEST_COMMAND_REQUIRED';
          const failingCommand = testCommands[error.details?.commandIndex];
          const pinnedCommand = (phase.qualityCommands ?? []).includes(failingCommand);
          const invalidPinnedCommand = error.details?.configurationDependency === true
            && pinnedCommand
            && ['CODE_TEST_RESULT_REQUIRED', 'CODE_TEST_SUPPRESSED'].includes(error.code);
          const unsupportedRuntimeAdapter = error.code === 'RUST_TEST_ADAPTER_REQUIRED';
          const configurationDependency = missingRepositoryRunner || invalidPinnedCommand
            || unsupportedRuntimeAdapter;
          blockers.push({
            code: 'code.delivery.incomplete', category: 'code-delivery', blocking: true,
            phase: phase.id, generation: Number(phase.generation) + 1,
            path: null, line: null, value: null,
            details: {
              sourceCode: error.code ?? null, message: error.message, ...(error.details ?? {}),
              ...(invalidPinnedCommand ? {
                recoveryBoundary: {
                  kind: 'pinned-test-policy', currentStoryConfigurationRefresh: false,
                  retryRequiresChangedRuntimeOrPolicy: true
                }
              } : missingRepositoryRunner ? {
                recoveryBoundary: {
                  kind: 'repository-test-runner', currentStoryConfigurationRefresh: false,
                  retryRequiresChangedRuntimeOrPolicy: true,
                  inScopeRepositoryRepair: true
                }
              } : unsupportedRuntimeAdapter ? {
                recoveryBoundary: {
                  kind: 'unsupported-runtime-adapter', currentStoryConfigurationRefresh: false,
                  retryRequiresChangedRuntimeOrPolicy: true
                }
              } : {})
            }
          });
          actions.push(action({
            id: missingRepositoryRunner
              ? `repair-repository-test-runner:${phase.id}`
              : invalidPinnedCommand
                ? `resolve-code-delivery-test-policy:${phase.id}`
                : unsupportedRuntimeAdapter
                  ? `resolve-code-delivery-runtime-adapter:${phase.id}`
                  : `complete-code-delivery:${phase.id}`,
            mode: invalidPinnedCommand || unsupportedRuntimeAdapter ? 'manual' : 'guided',
            detail: missingRepositoryRunner
              ? `${error.message} Inspect the affected module and, only within this phase's approved source scope, repair its repository-owned test script, manifest, or runner declaration so a supported structured command can be inferred. Preserve the Story pin and existing tests. Recheck recovery and prepublish after the repository change; do not retry publication against unchanged inputs. If in-scope runner repair is unavailable, an authorized reviewer can preview story test-policy amend --reason TEXT to adopt a newly approved explicit runner from the original configuration authority. Follow the engine's eligibility and returned route; unsupported native runners still need a supported adapter.`
              : invalidPinnedCommand
                ? `${error.message} This Story's configured test command is pinned; refreshing sflow/config alone does not change it. Do not replace or suppress the command in Story state. An authorized reviewer can preview story test-policy amend --reason TEXT to adopt a corrected structured test command from the original approved configuration authority for the current active phase. ${Number(phase.generation) === 0 ? 'It preserves code and prior phases and still requires fresh tests.' : 'The old publication and evidence remain historical; fresh validation and submission are required in the new policy epoch, without republishing unchanged code.'} Do not repeat publication against the unchanged blocker.`
                : unsupportedRuntimeAdapter
                  ? `${error.message} This runtime cannot produce the required structured Rust test receipt. Use a supported registered adapter or a separately approved test policy; repeating /sf-code or publication against unchanged inputs cannot recover this phase.`
                  : `${error.message} Keep this phase in progress, complete its application and test evidence, then inspect recovery again before publication.`,
            // Repository-owned runner declarations are ordinary in-scope application edits. A
            // malformed pinned command is not: it requires a distinct reviewed policy amendment.
            command: configurationDependency
              ? missingRepositoryRunner
                ? `singularity-flow phase show ${phase.id} --json`
                : invalidPinnedCommand && Number(phase.generation) === 0
                  ? 'singularity-flow explain test-recovery'
                  : null
              : `singularity-flow phase show ${phase.id} --json`,
            skill: configurationDependency
              ? missingRepositoryRunner ? '/sf-code' : null
              : '/sf-code'
          }));
        }
      }
    }
  }

  if (generationDigest && phaseRequiresCodeDelivery(phase)
      && phase.generationIntent?.status === 'consumed' && !generation
      && phase.status === 'in_progress' && blockers.length === 0
      && testExecution.status === 'not-run') {
    actions.push(action({
      id: `submit-published-generation:${phase.id}`,
      detail: 'This published generation still matches its retained bytes. Submit it after resolving any reported test environment or runtime failure; submission re-executes required checks. Do not republish unchanged code or retry an unchanged failing test.',
      command: `singularity-flow submit ${phase.id} --work-id ${workflow.workItem.id}`,
      skill: '/sf-submit'
    }));
  }

  const uniqueActions = [...new Map(actions.map((entry) => [entry.id, entry])).values()];
  return {
    phaseId: phase.id,
    blockers,
    actions: uniqueActions,
    requiresLifecycleRecovery: blockers.some((finding) => finding.category === 'lifecycle'),
    testExecution
  };
}
