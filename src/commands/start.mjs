/** Story intake command, isolated from the legacy CLI dispatcher. */
import { assertBaseCarriesGovernance, durableLocalStoryOnBranch, testRecoveryIntakePhases, resumeCommand, capabilityDoctorStoryPin } from './shared/start-context.mjs';
import { printCommandRoutes } from './shared/print-command-routes.mjs';
import { gitAnswer } from './shared/git-answer.mjs';
import { normalizeQualityGateMode } from '../phase-quality-risk.mjs';
import { activatePhaseAgent, summary } from './kernel.mjs';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import YAML from 'yaml';
import { SingularityFlowError, nowIso, optionBoolean, optionString, optionStrings, posix, readJson, requirePositional } from '../util.mjs';
import { assertClean, branch, changes, checkout, fetchRemote, fileAtRef, gitCommonDir, head, localBranches, localRefHeads, preflightPushBranch, refExists, refHead, remoteBranches, remoteNames, repoRoot, validBranch } from '../git.mjs';
import { buildRepositorySubjectIndexFromRefs, resolveContext } from '../repository-subject-index.mjs';
import { worldModelStateAuthority } from '../state-authority.mjs';
import { STORY_INTAKE_AUTHORITY_REUSE_MS, admitStoryIntakeReceipt, isStoryIntakeProof, verifyStoryIntakeWave } from '../story-intake-verification.mjs';
import { validatePortableWorkId } from '../work-id.mjs';
import { settleStoryStartReadWave } from '../story-start-read-wave.mjs';
import { storyPublicationPreflightError } from '../story-publication-preflight.mjs';
import { applyTestRecoveryAdmission, confirmTestRecoveryIntake, prepareTestRecoveryIntake, testRecoveryChoices } from '../test-recovery-intake.mjs';
import { commitAndPublish, createWorkflow, loadConfig, validateId, workDir, workDirRelative } from '../state-stores.mjs';
import { generationSkillForPhase } from '../code-delivery-policy.mjs';
import { directCopilotSkill } from '../copilot-guidance.mjs';
import { renderChangeDirectoryCommand } from '../safe-command-guidance.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { getIssue } from '../jira.mjs';
import { runDraftTransaction } from '../draft-unit-of-work.mjs';
import { assertWorkTypeStartable, resolveWorkType, WORKFLOW_PATH } from '../config.mjs';
import { loadCopilotSession, loadSession, recordStartedWorkItemSelection, selectIntakeSource, selectWorkType } from '../session.mjs';
import { documentSetLifecycleBinding } from '../document-publication.mjs';
import { loadManualStory, promptManualStory } from '../intake.mjs';
import { normalizeMcpTargetOrigin } from '../mcp-target.mjs';
import { automaticEnrollmentMayPublish, publishCurrentIdentityToConfiguration, enrolledConfigurationAuthority } from '../configuration-people.mjs';
import { GitRemoteSession } from '../git-execution.mjs';
import { configuredRemoteAuthority, configuredRemoteIdentity } from '../git-remote-diagnostics.mjs';
import { capabilityLines } from '../verification/capability.mjs';
import { materializeReferenceRepositories, materializeReferenceRepositoriesFromBranches, parseReferenceRepositoryOptions, resolveReferenceRepositoryPins } from '../reference-repositories.mjs';
import { consumeSelectionReceipt, readStartSelectionReceipt, resolveHandedOffStartSelectionReceipt, resolveSelectionReceipt } from '../choices.mjs';
import { writeReturnLocator } from '../return-locator.mjs';
import { getGitHubIssue, normalizeWorkSource, workflowSourceIdentity } from '../work-source.mjs';
import { workspaceRepositoryPath } from '../workspace.mjs';
import { captureConfigurationState, CONFIGURATION_BRANCH, configurationBranchHead, materializeConfigurationSnapshot, loadStoryConfigurationSnapshot, resolveNewStoryConfigurationAuthority, withStoryConfigurationSnapshotRead, withStoryConfigurationTransaction } from '../configuration-branch.mjs';
import { fosStoryConfigurationAuthority } from '../onboard.mjs';
import { beginStoryStartJournal, clearStoryStartJournal, recoverStoryStart, serializeConfigurationRestorePoint, updateStoryStartJournal } from '../story-start-journal.mjs';
import { assertStartDocuments, preflightInitialStoryDocuments, stageInitialStoryDocuments } from '../story-start-documents.mjs';
import { assertStoryStartReady, inspectStoryStartReadiness, requiredRepositoryReadinessScope, repositoryReadinessRequired } from '../story-start-readiness.mjs';
import { collectRepositoryReadinessEvidence, inspectRepositoryPrerequisitePresence } from '../repository-readiness-evidence.mjs';
import { intakeBaselineChoice, requiredIntakePrerequisites } from '../intake-baseline.mjs';
import { storyBaseRequired, assertStoryStartChoices } from '../story-start-inputs.mjs';
import { loadLegacyMaterializedStoryDefinition, loadLegacyStoryBaseContext, storyConfigurationUnavailableError } from '../story-start-base-configuration.mjs';
import { activateWorkspaceStoryContext, activeWorkspaceFile, workspaceRegistryFile } from '../workspace-context.mjs';
import { withLedgerRemoteView } from '../ledger.mjs';
import { normalizeLedgerConfig } from '../ledger-config.mjs';
import { CAPABILITIES_PATH, resolveEffectiveCapabilityPolicy } from '../capabilities.mjs';
import { validateConfigurationSnapshotCapabilities } from '../capability-context.mjs';
import { action as narrationAction, commandResult, effects, plannedAction as plannedNarrationAction, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { incrementCommandCounter, measureCommandSpan } from '../dx-timing-context.mjs';
import { publishCapabilityRepositoriesDurably, retainCapabilityPublicationRecovery } from '../capability-publication-recovery.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability('start', argv, options,
    () => withCommandConfirmation(options, () => startCommand(positionals, options)));
}

// This capability cannot be represented by CLI argv. It exists only for the same-process handoff
// from the launch checkout to the exact managed worktree created below. Keeping it on a private
// Symbol prevents a caller from claiming that an arbitrary linked worktree inherited another
// worktree's FOS authority pin.
const ISOLATED_STORY_CONFIGURATION_HANDOFF = Symbol('isolated-story-configuration-handoff');
// This is an operation-local optimization, never persisted or accepted from CLI flags. A later
// remote observation must still prove the selected base and Story destination before reusing it.
const ISOLATED_STORY_BASE_FETCH_HANDOFF = Symbol('isolated-story-base-fetch-handoff');
// What became of a presented intake receipt, and the wave's process-private proof when it passed.
// Never accepted from flags: only the isolated launch below creates it.
const ISOLATED_STORY_INTAKE_HANDOFF = Symbol('isolated-story-intake-handoff');
// A selection receipt read and checked in the launch checkout that recorded it. The Story worktree
// holds none of that checkout's receipts, so the start uses this record and consumes it there.
const ISOLATED_STORY_SELECTION_HANDOFF = Symbol('isolated-story-selection-handoff');

async function assertLaunchCheckoutRepositoryReady(sourceRoot, definition, sourceCommit = head(sourceRoot), baselineChoice = 'reuse') {
  intakeBaselineChoice(baselineChoice);
  if (!repositoryReadinessRequired(definition)) return null;
  const scope = requiredRepositoryReadinessScope(definition);
  const presence = await inspectRepositoryPrerequisitePresence(sourceRoot, {
    commit: sourceCommit, scope, testRuntime: definition.repositoryReadiness?.testRuntime,
    purposes: requiredIntakePrerequisites(definition)
  });
  if (presence.candidate) return presence;
  throw new SingularityFlowError(
    'Required non-test prerequisites lack current exact-base proof. Review the readiness plan or approved prerequisite policy. Test setup and results do not block Story creation.',
    { code: 'STORY_REPOSITORY_READINESS_REQUIRED', details: {
      sourceCommit, reasons: presence.reasons, baselinePolicy: 'choice',
      nextAction: `singularity-flow precheck --run --base-commit ${sourceCommit} --scope ${scope} --json`,
      nextSkill: scope === 'full' ? '/sf-ready --full' : '/sf-ready',
      recoveryCommands: [`singularity-flow precheck --run --base-commit ${sourceCommit} --scope ${scope} --json`]
    } }
  );
}

async function isolatedStoryConfiguration(options, root, workId, managedStoryWorktree) {
  const handoff = options[ISOLATED_STORY_CONFIGURATION_HANDOFF] ?? null;
  if (!handoff) return null;
  const [targetRepository, targetCommonDir, managedRepository] = await Promise.all([
    realpath(root),
    realpath(gitCommonDir(root)),
    managedStoryWorktree ? realpath(managedStoryWorktree) : Promise.resolve(null)
  ]);
  if (!managedStoryWorktree
      || managedRepository !== targetRepository
      || handoff.workId !== workId
      || targetRepository !== handoff.targetRepository
      || targetCommonDir !== handoff.sourceCommonDir) {
    throw new SingularityFlowError(
      'The isolated Story configuration handoff does not match this managed worktree.', {
        code: 'AUTHORITY_PIN_INVALID'
      }
    );
  }
  return handoff;
}

async function startCommandInIsolatedWorktree(sourceRoot, id, positionals, options) {
  const {
    completeStoryWorktree, prepareStoryWorktree, rollbackFailedStoryWorktree
  } = await import('../story-worktree.mjs');
  const { bindIsolatedStoryConfiguration, sealIsolatedStoryConfiguration } = await import('./start-configuration.mjs');
  // The operator's file paths are relative to where the command ran, not to the Story worktree the
  // start continues in after it changes directory.
  const launchDirectory = process.cwd();
  // A public FOS lookup remains strictly bound to the worktree where it was reviewed. Seal the
  // source authority before Git creates or enters another worktree; only this controlled start
  // path may carry the already-verified snapshot across that boundary.
  // Only a durable local Story carries its own immutable configuration. A materialized Epic seed
  // also has a local branch, but still needs today's approved configuration to create its first
  // lifecycle state, so branch existence alone is not enough to skip the FOS snapshot.
  const canonicalBranch = optionString(options, 'ref', id);
  const durableLocalStory = await durableLocalStoryOnBranch(sourceRoot, id, canonicalBranch);
  if (!durableLocalStory && refExists(sourceRoot, `refs/heads/${canonicalBranch}`)
      && fileAtRef(sourceRoot, `refs/heads/${canonicalBranch}`,
        posix(path.join('singularity', 'seeds', `${id}.yml`))) === null) {
    // This local name can never be adopted, irrespective of current authority or base. Refuse in
    // the launch checkout before a seal/fetch or disposable worktree is created and rolled back.
    throw new SingularityFlowError(
      `Local branch '${canonicalBranch}' exists but contains neither governed Story state nor a materialized Story seed. `
      + 'Singularity Flow will not adopt an ungoverned branch as a new Story. Rename or remove that branch, then retry.',
      { code: 'STORY_BRANCH_EXISTS' }
    );
  }
  const intakeReceiptId = optionString(options, 'intake-receipt');
  const intakeSession = new GitRemoteSession({ cwd: sourceRoot });
  let sealedConfiguration = durableLocalStory
    ? null
    : await measureCommandSpan('start.authority', () =>
      sealIsolatedStoryConfiguration(sourceRoot, id, {
        readStoryPin: capabilityDoctorStoryPin, session: intakeSession, fosOnly: Boolean(intakeReceiptId)
      }));
  let launchDefinition = sealedConfiguration?.snapshot?.definition
    ?? await loadConfig(sourceRoot).catch(() => null);
  const requestedBase = optionString(options, 'from-branch');
  let requestedRemote = optionString(options, 'remote')
    ?? launchDefinition?.git?.remote
    ?? 'origin';
  // A receipt from a passing readiness preview lets this start confirm every input the preview saw
  // in one concurrent wave instead of fetching and observing them again one by one. Whatever the
  // wave cannot confirm, the ordinary path below does exactly as before.
  const intake = { status: intakeReceiptId ? 'rejected' : 'absent', reason: null, reused: [] };
  let intakeAdmission = null;
  let intakeProof = null;
  const intakeReferences = intakeReceiptId ? parseReferenceRepositoryOptions(
    optionStrings(options, 'reference-repository'), optionStrings(options, 'reference-branch')
  ) : [];
  try {
    if (intakeReceiptId) {
      if (!requestedBase || optionString(options, 'ref', id) !== id) intake.reason = 'inputs';
      else if (durableLocalStory) intake.reason = 'story-exists';
      else {
        const admission = await admitStoryIntakeReceipt(sourceRoot, intakeReceiptId, {
          inputs: {
            workId: id, workType: optionString(options, 'work-type'), baseBranch: requestedBase,
            remote: requestedRemote, capabilityId: optionString(options, 'capability') ?? null,
            readinessBaseline: optionString(options, 'readiness-baseline', 'reuse'),
            testExecutionMode: optionString(options, 'test-execution-mode', 'changed-and-affected'),
            qualityGateMode: normalizeQualityGateMode(optionString(options, 'gate-mode', 'hard')),
            references: intakeReferences
              .map((request) => ({ id: request.id, url: request.repository, branch: request.requestedBranch }))
          },
          workId: id, remote: requestedRemote, baseBranch: requestedBase,
          configurationAuthority: sealedConfiguration ? {
            remote: sealedConfiguration.authority.remote,
            branch: sealedConfiguration.authority.branch,
            commit: sealedConfiguration.snapshot.observedCommit,
            sourceCommit: sealedConfiguration.snapshot.sourceCommit
          } : null
        });
        if (admission.status !== 'admitted') intake.reason = admission.reason;
        else {
          intakeAdmission = admission;
          const wave = await measureCommandSpan('start.intake-verification', () =>
            verifyStoryIntakeWave(sourceRoot, admission, {
              workId: id, references: intakeReferences, session: intakeSession
            }));
          if (wave.ok) {
            intakeProof = wave.proof;
            intake.status = 'verified';
          } else {
            await admission.release();
            intakeAdmission = null;
            intake.status = 'fallback';
            intake.reason = wave.reason;
          }
        }
      }
    }
    if (intakeReceiptId && !durableLocalStory && !sealedConfiguration) {
      // Observe an ordinary authority in the receipt wave, then load its exact approved snapshot
      // using that operation-local observation. A receipt is never itself configuration authority.
      // Failed/moved receipts still resolve current approved policy before launch prerequisites.
      sealedConfiguration = await measureCommandSpan('start.authority', () =>
        sealIsolatedStoryConfiguration(sourceRoot, id, {
          readStoryPin: capabilityDoctorStoryPin, session: intakeSession
        }));
      if (sealedConfiguration) {
        launchDefinition = sealedConfiguration.snapshot.definition;
        const approvedRemote = optionString(options, 'remote') ?? launchDefinition.git?.remote ?? 'origin';
        if (approvedRemote !== requestedRemote) {
          await intakeAdmission?.release();
          intakeAdmission = null;
          intakeProof = null;
          intake.status = 'fallback';
          intake.reason = 'remote';
        }
        requestedRemote = approvedRemote;
      }
    }
    let requestedBaseRef = null;
    let launchBaseCommit = null;
    let requestedBaseFetchAuthority = null;
    if (requestedBase && !durableLocalStory) {
      const fetchAuthority = configuredRemoteAuthority(sourceRoot, requestedRemote, {
        direction: 'fetch'
      });
      if (!fetchAuthority.url) {
        throw new SingularityFlowError(
          `Story remote '${requestedRemote}' has no credential-free fetch authority. Nothing was changed.`,
          { code: 'STORY_REMOTE_UNREACHABLE' }
        );
      }
      // Readiness, dependency hydration, and Story creation must all observe the same freshly
      // fetched base commit. Never prefer an old local tracking branch at this boundary, unless the
      // intake wave has just confirmed that this exact tracking ref is still the remote's tip.
      if (intakeProof && fetchAuthority.url === intakeProof.fetch.url
          && fetchAuthority.fingerprint === intakeProof.fetch.fingerprint
          && refHead(sourceRoot, `refs/remotes/${requestedRemote}/${requestedBase}`) === intakeProof.baseCommit) {
        incrementCommandCounter('git.story-launch-fetch-verified');
        intake.reused.push('launch-fetch');
      } else {
        await measureCommandSpan('start.fetch', () =>
          fetchRemote(sourceRoot, requestedRemote, {
            transportRemote: fetchAuthority.url,
            // A stale Story tracking ref needs the ordinary inventory/prune path before reuse or
            // resume can be decided. The normal new-Story path transfers only its chosen base.
            branches: refExists(sourceRoot, `refs/remotes/${requestedRemote}/${canonicalBranch}`)
              ? undefined : [requestedBase],
            respectPartialClone: true
          }));
      }
      requestedBaseFetchAuthority = fetchAuthority;
      requestedBaseRef = `refs/remotes/${requestedRemote}/${requestedBase}`;
      launchBaseCommit = localRefHeads(sourceRoot, [requestedBaseRef]).get(requestedBaseRef) ?? null;
      if (!launchBaseCommit) {
        throw new SingularityFlowError(
          `Selected base branch '${requestedBase}' is not published by remote '${requestedRemote}'. Nothing was changed.`,
          { code: 'STORY_BASE_INVALID' }
        );
      }
    }
    launchBaseCommit ??= head(sourceRoot);
    let baselineTarget = null;
    if (!durableLocalStory && optionStrings(options, 'test-baseline-record').length) {
      const { preparedStoryWorktreePath } = await import('../story-worktree.mjs');
      baselineTarget = await preparedStoryWorktreePath(sourceRoot, id, { baseCommit: launchBaseCommit });
      if (!baselineTarget) throw new SingularityFlowError(
        'Capture this Story baseline with story test-policy baseline --isolated-worktree before starting. '
        + 'A baseline from the launch checkout cannot authenticate a test run in the Story checkout. '
        + 'Refresh intake using the returned record digest; no Story or worktree was created.',
        { code: 'TRP_INTAKE_BASELINE_INVALID' }
      );
    }
    // Fail fast on missing mandatory observations without scanning the launch checkout. Only the
    // child evaluates plan currency against its clean selected base before governed mutation.
    // A separately reviewed native baseline keeps its existing exact-worktree admission route.
    const preparedBaselineReview = Boolean(baselineTarget)
      && launchDefinition?.testRecovery?.enabled === true
      && launchDefinition.testRecovery.enabledRiskCategories?.includes('known-test-failure')
      && optionString(options, 'test-baseline-disposition') === 'accept-known-failures';
    if (!durableLocalStory && !preparedBaselineReview) await assertLaunchCheckoutRepositoryReady(
      sourceRoot, launchDefinition, launchBaseCommit, optionString(options, 'readiness-baseline', 'reuse'));
    // Checked here, before any worktree exists, so a stale or foreign receipt refuses at once.
    const selectionToken = optionString(options, 'selection-receipt');
    const selectionHandoff = selectionToken && !durableLocalStory
      ? await readStartSelectionReceipt(sourceRoot, selectionToken, id) : null;
    const prepared = await measureCommandSpan('start.worktree', () =>
      prepareStoryWorktree(sourceRoot, id, {
        base: durableLocalStory ? 'HEAD' : launchBaseCommit
      }));
    const previousDirectory = process.cwd();
    let result;
    try {
      // Intake only creates the isolated checkout and Story. Dependency installation and test
      // execution belong to an explicitly reviewed readiness run or later code/verification work.
      const configurationHandoff = await bindIsolatedStoryConfiguration(sealedConfiguration, prepared);
      const childOptions = {
        ...options,
        'isolated-worktree': false,
        'managed-story-worktree': prepared.repositoryPath,
        'story-launch-repository': sourceRoot
      };
      if (requestedBaseRef) {
        childOptions['story-launch-remote'] = requestedRemote;
        childOptions['story-launch-base-branch'] = requestedBase;
        childOptions['story-launch-base-commit'] = launchBaseCommit;
        childOptions[ISOLATED_STORY_BASE_FETCH_HANDOFF] = Object.freeze({
          sourceCommonDir: gitCommonDir(sourceRoot),
          remote: requestedRemote,
          transportRemote: requestedBaseFetchAuthority.url,
          remoteFingerprint: requestedBaseFetchAuthority.fingerprint,
          baseBranch: requestedBase,
          baseCommit: launchBaseCommit,
          // Only the same-transport state tip is covered by the launch's full fetch. Capability
          // preflight re-observes these exact refs before admitting this process-private proof.
          stateBranch: worldModelStateAuthority(launchDefinition ?? {}).remote === requestedRemote
            ? worldModelStateAuthority(launchDefinition ?? {}).branch : null,
          stateCommit: worldModelStateAuthority(launchDefinition ?? {}).remote === requestedRemote
            ? refHead(sourceRoot, `refs/remotes/${requestedRemote}/${worldModelStateAuthority(launchDefinition ?? {}).branch}`)
            : null
        });
      }
      if (configurationHandoff) {
        childOptions[ISOLATED_STORY_CONFIGURATION_HANDOFF] = configurationHandoff;
      }
      if (intakeReceiptId) {
        childOptions[ISOLATED_STORY_INTAKE_HANDOFF] = Object.freeze({ proof: intakeProof, status: intake });
      }
      if (selectionHandoff) childOptions[ISOLATED_STORY_SELECTION_HANDOFF] = selectionHandoff;
      if (optionStrings(options, 'document').length) {
        childOptions.document = optionStrings(options, 'document').map((file) => path.resolve(launchDirectory, file));
      }
      if (optionString(options, 'story-file')) childOptions['story-file'] = path.resolve(launchDirectory, optionString(options, 'story-file'));
      process.chdir(prepared.repositoryPath);
      result = await startCommand(positionals, childOptions);
      completeStoryWorktree(prepared);
      // The Story exists now, so this receipt can never be used again.
      await intakeAdmission?.consume().catch(() => {});
      try {
        await activateWorkspaceStoryContext(
          activeWorkspaceFile(), workspaceRegistryFile(), prepared.repositoryPath,
          { storyId: id, selectionSource: 'story-start' }
        );
      } catch (error) {
        // The Story is already committed and may already be pushed. A machine-local navigation
        // receipt must never turn that durable success into a failed start or cause a duplicate retry.
        console.warn(`Warning: Story '${id}' started, but its active-checkout selection was not updated: ${error.message}`);
      }
    } catch (error) {
      // Whether or not the failed start left a durable commit behind, the next attempt verifies from
      // scratch: a receipt is never reused after a start that got this far.
      await intakeAdmission?.consume().catch(() => {});
      rollbackFailedStoryWorktree(prepared, error, previousDirectory);
    }
    process.chdir(previousDirectory);
    return result;
  } finally {
    // The claim belongs to the whole launch, including wave verification and failures before
    // worktree creation. Once the child starts it consumes the claim on success or failure;
    // release is then a no-op. Earlier refusals restore the exact receipt for a corrected retry.
    await intakeAdmission?.release();
  }
}

export async function startCommand(positionals, options) {
  normalizeQualityGateMode(optionString(options, 'gate-mode', 'hard'));
  const id = requirePositional(positionals, 1, 'work ID');
  const root = repoRoot();
  // These refusals need neither configuration authority nor a new worktree. Apply them before
  // recovery/isolated routing; the exact selected workflow still enforces its own ID policy later.
  validatePortableWorkId(id);
  validBranch(root, optionString(options, 'ref', id));
  if ([optionBoolean(options, 'jira'), Boolean(optionString(options, 'github')),
    Boolean(optionString(options, 'story-file'))].filter(Boolean).length > 1) {
    throw new SingularityFlowError('Choose exactly one of --jira, --github, or --story-file.');
  }
  if (optionString(options, 'base') && optionStrings(options, 'from-branch').length) {
    throw new SingularityFlowError('Choose either --from-branch or the compatibility --base option, not both.', {
      code: 'STORY_BASE_INVALID'
    });
  }
  parseReferenceRepositoryOptions(
    optionStrings(options, 'reference-repository'), optionStrings(options, 'reference-branch')
  );
  // Recovery owns the checkout that an interrupted start left behind. Run it before dirty-tree
  // routing; otherwise the recovery files themselves cause a second isolated worktree to be
  // created and the durable journal is never consumed.
  await recoverStoryStart(root, id);
  const managedStoryWorktree = optionString(options, 'managed-story-worktree');
  const configurationHandoff = await isolatedStoryConfiguration(
    options, root, id, managedStoryWorktree
  );
  // A Story owns a branch, index and working directory of its own. VS Code always asks for this
  // isolation; the CLI also selects it automatically when the launch checkout is dirty, so
  // unrelated files from an earlier Story can never become a global Story-start lock.
  if (!managedStoryWorktree && (optionBoolean(options, 'isolated-worktree')
      || (!optionBoolean(options, 'allow-dirty') && changes(root).trim()))) {
    return withStoryConfigurationTransaction(() => startCommandInIsolatedWorktree(root, id, positionals, options));
  }
  // The synchronous launch check above already proved this checkout clean. Only a managed child
  // skipped it and needs its own check. Never retain status across an await, checkout or mutation;
  // publication still independently checks the complete candidate working tree.
  if (managedStoryWorktree && !optionBoolean(options, 'allow-dirty')) assertClean(root, { refreshIndex: true });
  // The launch checkout is not configuration authority for a new Story. It may carry a stale or
  // malformed workflow while the approved sflow/config snapshot is healthy. Inspect local Story
  // refs and cheap input errors first; load the local workflow only if authority discovery later
  // proves there is no approved snapshot and the legacy branch-local fallback is needed.
  let config = null;
  // At this point the command has not established whether this is new work or an existing Story
  // carrying an older pinned policy. Enforce the transport-safe shape now; the selected lifecycle
  // branch enforces its exact `idPattern` below, while genuinely new work uses current configuration.
  validatePortableWorkId(id);
  const receiptToken = optionString(options, 'selection-receipt');
  let receipt = null;
  const jira = optionBoolean(options, 'jira');
  const githubReference = optionString(options, 'github');
  const storyFile = optionString(options, 'story-file');
  if ([jira, Boolean(githubReference), Boolean(storyFile)].filter(Boolean).length > 1) {
    throw new SingularityFlowError('Choose exactly one of --jira, --github, or --story-file.');
  }
  const title = optionString(options, 'title');
  const description = optionString(options, 'description');
  const acceptanceCriteria = optionString(options, 'acceptance-criteria');
  const explicitFiles = optionStrings(options, 'document');
  const explicitUrls = optionStrings(options, 'document-url');
  const explicitDocumentInputs = startDocumentInputs(options, explicitFiles, explicitUrls);
  const referenceRequests = parseReferenceRepositoryOptions(
    optionStrings(options, 'reference-repository'), optionStrings(options, 'reference-branch')
  );
  const hasManualInput = Boolean(storyFile || title || description || acceptanceCriteria || explicitFiles.length || explicitUrls.length);
  const declaredSource = githubReference ? 'github-issue' : jira ? 'jira' : hasManualInput ? 'manual' : null;
  let externalSourcePromise = null;
  const externalSource = () => {
    if (!externalSourcePromise) {
      externalSourcePromise = githubReference
        ? getGitHubIssue(githubReference)
        : jira ? getIssue(id).then((source) => normalizeWorkSource(source, { rawRef: id, fetchedAt: nowIso() }))
          : Promise.resolve(null);
    }
    return externalSourcePromise;
  };
  const explicitBase = optionString(options, 'base');
  const fromBranch = optionStrings(options, 'from-branch');
  const canonicalBranch = optionString(options, 'ref', id);
  const advertisedStoryRef = `refs/heads/${canonicalBranch}`;
  // An intake receipt verified by the isolated launch hands over the session holding its wave: the
  // stages below then answer from observations made a moment ago instead of repeating them.
  const intakeHandoff = options[ISOLATED_STORY_INTAKE_HANDOFF] ?? null;
  const intakeProof = isStoryIntakeProof(intakeHandoff?.proof) ? intakeHandoff.proof : null;
  const intakeStatus = intakeHandoff?.status
    ?? (optionString(options, 'intake-receipt')
      ? { status: 'rejected', reason: 'not-isolated', reused: [] } : null);
  const intakeFresh = () => Boolean(intakeProof)
    && Date.now() - intakeProof.observedAt < STORY_INTAKE_AUTHORITY_REUSE_MS;
  const storyRemoteSession = intakeProof?.session ?? new GitRemoteSession({ cwd: root });
  const observeStoryDestination = async (remoteName, { refresh = true } = {}) => {
    const fetchAuthority = configuredRemoteAuthority(root, remoteName, { direction: 'fetch' });
    const applicationRemote = fetchAuthority.url;
    // Capture the explicitly selected base in the same bounded observation. The command-local
    // session may share exact immutable reads, but a seed recheck after human intake stays fresh.
    const exactBases = fromBranch.length === 1 && !fromBranch[0].includes('=')
      ? [`refs/heads/${fromBranch[0]}`] : explicitBase ? [`refs/heads/${explicitBase}`] : [];
    // The state tip rides along when it lives on this remote: capability preflight's launch-fetch
    // reuse proof needs exactly this observation, and making it here saves that probe.
    const stateAuthority = worldModelStateAuthority(config ?? {});
    const stateRefs = stateAuthority.remote === remoteName ? [`refs/heads/${stateAuthority.branch}`] : [];
    const authority = applicationRemote ? await storyRemoteSession.observeAsync(applicationRemote, {
      includeHead: true, refs: [advertisedStoryRef, ...exactBases, ...stateRefs], refresh
    }) : null;
    let defaultBranch = authority?.defaultBranch ?? null;
    if (applicationRemote && !defaultBranch && authority?.ok) {
      const fallback = await storyRemoteSession.observeAsync(applicationRemote, {
        includeHead: true, includeAllHeads: true
      });
      defaultBranch = fallback.defaultBranch
        ?? fallback.branches.find((branchName) => branchName === 'main' || branchName === 'master')
        ?? fallback.branches[0]
        ?? 'main';
    }
    return {
      authority,
      defaultBranch: defaultBranch ?? 'main',
      transportRemote: applicationRemote || null
    };
  };
  let remote = config?.git?.remote ?? 'origin';
  const storySeedRelative = posix(path.join('singularity', 'seeds', `${id}.yml`));
  const localStoryRef = `refs/heads/${canonicalBranch}`;
  const durableStoryAtRef = async (ref, branchName) => {
    const index = await buildRepositorySubjectIndexFromRefs(root, {
      definition: config ?? {}, refs: [{ branch: branchName, ref }]
    });
    return resolveContext(index, { reference: id, kind: 'story', required: false });
  };

  // Starting is idempotent for durable Stories. A local workflow does not need a new base choice;
  // it is resumed from its own recorded branch and resolution. This check intentionally precedes
  // every remote/base prompt so an offline contributor can resume work already present locally.
  const localStoryExists = refExists(root, localStoryRef);
  const localStory = localStoryExists
    ? await durableStoryAtRef(localStoryRef, canonicalBranch)
    : null;
  if (localStory) {
    if (referenceRequests.length) {
      throw new SingularityFlowError(
        `Story '${id}' already exists. Reference repositories are immutable intake inputs; inspect its pinned set with singularity-flow story references list --work-id ${id}.`,
        { code: 'REFERENCE_REPOSITORY_STORY_EXISTS' }
      );
    }
    refuseStartDocumentsForExistingStory(root, id, localStory, explicitFiles, explicitUrls, optionStrings(options, 'document-name'));
    const requested = await externalSource();
    const existingIdentity = workflowSourceIdentity(localStory.state);
    if (requested?.stableId && existingIdentity && requested.stableId !== existingIdentity) {
      throw new SingularityFlowError(
        `Story '${id}' already belongs to source '${existingIdentity}', not '${requested.stableId}'. Nothing was changed.`,
        { code: 'STORY_SOURCE_CONFLICT' }
      );
    }
    // Put the exact self-contained lifecycle branch in the working tree before the generic resume
    // path selects configuration. `resumeCommand` deliberately prefers a working-tree Story pin,
    // but when `start ID` is invoked from application main it would otherwise ask today's origin
    // for approved configuration first. That defeats the offline/idempotent path above precisely
    // when the local Story already carries every governed configuration byte it needs.
    const { storyWorktreeForBranch } = await import('../story-worktree.mjs');
    if (branch(root) !== localStory.canonicalBranch
        && !storyWorktreeForBranch(root, localStory.canonicalBranch)) {
      await checkout(root, localStory.canonicalBranch, {
        base: localStory.state?.workItem?.baseBranch ?? 'main',
        fetch: false,
        existingOnly: true,
        remote
      });
    }
    return resumeCommand(['resume', id], { ...options, fetch: false });
  }

  // A local branch with the requested Story name is not evidence that the branch is governed.
  // Preserve this specific refusal before the fast missing-base path: otherwise `--json --yes`
  // reports that a base is missing even though selecting a base could never make the occupied
  // branch safe to adopt. Reading one exact blob from the already-known local ref is local,
  // bounded, and precedes every configuration or remote lookup.
  if (localStoryExists
      && fileAtRef(root, localStoryRef, storySeedRelative) === null) {
    throw new SingularityFlowError(
      `Local branch '${canonicalBranch}' exists but contains neither governed Story state nor a materialized Story seed. `
      + 'Singularity Flow will not adopt an ungoverned branch as a new Story. Rename or remove that branch, then retry.',
      { code: 'STORY_BRANCH_EXISTS' }
    );
  }

  /**
   * Refuse a definitely-new non-interactive Story before configuration and remote discovery.
   *
   * The base is mandatory input, but this check used to happen only after approved-configuration
   * resolution, a destination probe, external-source lookup and capability catalog construction.
   * On a loaded machine or an office network that turned a deterministic input error into a long
   * apparent hang. A locally cached remote Story ref is deliberately exempt: it may be durable
   * work that this checkout can fetch and resume. Jira/GitHub and signed selection receipts are
   * also exempt because they can identify an existing Story or carry the reviewed base choice.
   */
  const nonInteractive = optionBoolean(options, 'json') || optionBoolean(options, 'yes');
  // Configuration has not been selected yet. A locally cached Story ref under any configured
  // remote is enough to defer the missing-base refusal until approved authority identifies the
  // one that governs this Story. This inventory remains local-only.
  const cachedRemoteStory = remoteNames(root).some((name) =>
    refExists(root, `refs/remotes/${name}/${canonicalBranch}`));
  if (nonInteractive && !receiptToken && !explicitBase && fromBranch.length === 0
      && !jira && !githubReference
      && !cachedRemoteStory) {
    throw storyBaseRequired(id);
  }

  // Only after a local durable Story has had its network-free pinned resume path do we select policy
  // for genuinely new work. A workflow checked out by an older Story may name an obsolete or hostile
  // remote, so authority discovery uses the active workspace, raw origin, or the repository URL from
  // a verified immutable pin. Keep one verified snapshot for every remaining choice: remote,
  // default base, publication, receipt validation and workflow template. Reading current authority
  // later (after one of those choices) would combine two configuration revisions in one start.
  const currentPin = configurationHandoff?.currentPin ?? await capabilityDoctorStoryPin(root);
  let configurationAuthority = configurationHandoff?.authority
    ?? await measureCommandSpan('start.authority', async () =>
      await fosStoryConfigurationAuthority(root)
        ?? await resolveNewStoryConfigurationAuthority(root, {
          pinnedRemote: currentPin.valid ? currentPin.source.repository : null,
          session: storyRemoteSession
        }));
  let approvedConfigurationSnapshot = configurationHandoff?.snapshot
    ?? (configurationAuthority
      ? await measureCommandSpan('start.configuration', () =>
        loadStoryConfigurationSnapshot(configurationAuthority, {
          // The authority was just observed through this session. The live tip is checked again
          // before the first shared mutation, so the read need not observe it a second time.
          session: storyRemoteSession, useObjectCache: true, reuseAuthorityObservation: true
        }))
      : null);
  config = approvedConfigurationSnapshot?.definition
    ?? (existsSync(path.join(root, WORKFLOW_PATH)) ? await loadConfig(root) : null);
  if (!config) {
    throw storyConfigurationUnavailableError();
  }
  validateId(config, id);
  remote = config.git?.remote ?? 'origin';
  const launchRemote = optionString(options, 'story-launch-remote');
  if (launchRemote && launchRemote !== remote) {
    throw new SingularityFlowError(
      `Story remote changed from '${launchRemote}' to '${remote}' after the isolated launch was verified. Refresh Story intake and retry; nothing was changed.`,
      {
        code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
        details: { expectedRemote: launchRemote, observedRemote: remote }
      }
    );
  }
  // Both are explicitly requested, bounded reads and are independent after approved configuration
  // selected the application remote. No speculative fetch or enrollment mutation is started here.
  const destination = await settleStoryStartReadWave(
    () => measureCommandSpan('start.destination', () =>
      observeStoryDestination(remote, { refresh: !intakeFresh() })),
    externalSource
  );
  const destinationFromIntake = Boolean(intakeProof)
    && destination.authority === intakeProof.application.observation;
  if (destinationFromIntake) intakeStatus.reused.push('destination');
  const reuseIsolatedBaseFetch = async (selectedBase) => {
    const receipt = options[ISOLATED_STORY_BASE_FETCH_HANDOFF];
    if (!managedStoryWorktree || !receipt || receipt.remote !== remote
        || receipt.baseBranch !== selectedBase || destination.authority?.ok !== true) return false;
    const { samePlatformPath } = await import('../story-worktree.mjs');
    if (!samePlatformPath(receipt.sourceCommonDir, gitCommonDir(root))) return false;
    const fetchAuthority = configuredRemoteAuthority(root, remote, { direction: 'fetch' });
    const fetchIdentity = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
    if (!fetchAuthority.url || fetchAuthority.url !== receipt.transportRemote
        || fetchAuthority.fingerprint !== receipt.remoteFingerprint
        || !fetchIdentity.configured || fetchIdentity.ambiguous
        || destination.transportRemote !== receipt.transportRemote) return false;
    const localBaseRef = `refs/remotes/${remote}/${selectedBase}`;
    const localStoryRef = `refs/remotes/${remote}/${canonicalBranch}`;
    const selectedBaseRef = `refs/heads/${selectedBase}`;
    const expectedStoryCommit = destination.authority.refs.get(advertisedStoryRef) ?? null;
    const fetchedRefs = localRefHeads(root, [localBaseRef, localStoryRef]);
    if (fetchedRefs.get(localBaseRef) !== receipt.baseCommit
        || (fetchedRefs.get(localStoryRef) ?? null)
          !== expectedStoryCommit) return false;
    // A person may spend time reviewing intake after the source checkout fetched. One fresh,
    // exact-ref probe replaces the duplicate all-heads fetch only when neither governed input
    // moved. Failed probes, retargets, and races all use the normal fetch and its checks below.
    let current;
    if (destinationFromIntake && intakeFresh()) {
      // The intake wave observed exactly these refs on this remote moments ago.
      current = destination.authority;
      intakeStatus.reused.push('base-probe');
    } else try {
      current = await new GitRemoteSession({ cwd: root }).observeAsync(fetchAuthority.url, {
        includeHead: false, refs: [selectedBaseRef, advertisedStoryRef], refresh: true,
        // This probe is only an optimization. Do not add a full network timeout ahead of the
        // ordinary fetch when an office proxy cannot answer the cheap exact-ref request.
        timeoutMs: 5_000
      });
    } catch {
      // Reuse is optional. Let the ordinary fetch classify a failed probe and preserve its
      // existing retry/recovery behavior rather than making this optimization a new blocker.
      return false;
    }
    if (!current.ok || current.refs.get(selectedBaseRef) !== receipt.baseCommit
        || (current.refs.get(advertisedStoryRef) ?? null) !== expectedStoryCommit) return false;
    const confirmed = configuredRemoteAuthority(root, remote, { direction: 'fetch' });
    const confirmedIdentity = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
    return confirmed.url === fetchAuthority.url
      && confirmed.fingerprint === fetchAuthority.fingerprint
      && confirmedIdentity.configured && !confirmedIdentity.ambiguous;
  };
  let destinationFetchPromise = null;
  const fetchObservedStoryDestination = () => {
    // Destination and tracked-identity lookup consume one freshly fetched inventory in this
    // invocation. This is not a cross-command receipt: the later base/publication preflight still
    // refreshes mutable refs before the first Story mutation.
    destinationFetchPromise ??= fetchRemote(root, remote,
      destination.transportRemote ? { transportRemote: destination.transportRemote } : {});
    return destinationFetchPromise;
  };
  const applicationDefault = destination.defaultBranch;
  let remoteStoryRef = `refs/remotes/${remote}/${canonicalBranch}`;
  const approvedRemoteStoryExists = destination.authority?.ok === true
    && destination.authority.refs.has(advertisedStoryRef);
  if (approvedRemoteStoryExists) {
    await measureCommandSpan('start.fetch', fetchObservedStoryDestination);
    const remoteStory = await durableStoryAtRef(remoteStoryRef, canonicalBranch);
    if (remoteStory) {
      if (referenceRequests.length) {
        throw new SingularityFlowError(
          `Published Story '${id}' already exists. Reference repositories cannot be added during resume.`,
          { code: 'REFERENCE_REPOSITORY_STORY_EXISTS' }
        );
      }
      refuseStartDocumentsForExistingStory(root, id, remoteStory, explicitFiles, explicitUrls, optionStrings(options, 'document-name'));
      const requested = await externalSource();
      const existingIdentity = workflowSourceIdentity(remoteStory.state);
      if (requested?.stableId && existingIdentity && requested.stableId !== existingIdentity) {
        throw new SingularityFlowError(
          `Published Story '${id}' belongs to source '${existingIdentity}', not '${requested.stableId}'. Nothing was changed.`,
          { code: 'STORY_SOURCE_CONFLICT' }
        );
      }
      return resumeCommand(['resume', id], { ...options, fetch: true });
    }
  }
  // An Epic may already have published the Story branch and its seed without creating lifecycle
  // state. In legacy branch-local mode that exact seed tip—not the checkout used to launch this
  // command—owns workflow, agent, document and publication policy. Resolve it before receipts,
  // external-source checks, document admission, Git preflight or readiness use policy.
  const materializedSeedRef = approvedRemoteStoryExists && refExists(root, remoteStoryRef)
    ? remoteStoryRef
    : refExists(root, localStoryRef) ? localStoryRef : null;
  // Freeze the exact published seed tip even when workflow policy comes from the shared
  // configuration authority. The seed is separate governed input: configuration authority may
  // decide how a Story starts, but it cannot make a concurrently replaced Epic seed safe to use.
  // This commit is also the checkout/recovery/publication lease below, so every later operation
  // either advances the bytes inspected here or refuses before enrollment and checkout.
  const candidateMaterializedSeedCommit = materializedSeedRef
    ? refHead(root, materializedSeedRef)
    : null;
  // Read from the immutable commit, not the mutable branch name. Otherwise a ref movement between
  // reading the seed and resolving its commit could bind seed bytes from one revision to the lease
  // for another revision and the later equality check would be meaningless.
  const materializedSeedText = candidateMaterializedSeedCommit
    ? fileAtRef(root, candidateMaterializedSeedCommit, storySeedRelative)
    : null;
  const materializedSeedCommit = materializedSeedText === null
    ? null
    : candidateMaterializedSeedCommit;
  let materializedSeed = null;
  const assertMaterializedSeedUnchanged = async ({ observeRemote = false } = {}) => {
    if (!materializedSeedCommit) return;
    if (!materializedSeedRef || !refExists(root, materializedSeedRef)) {
      throw new SingularityFlowError(
        `Materialized Story branch '${canonicalBranch}' disappeared after its seed was accepted. Refresh the Story seed and retry; nothing was changed.`,
        { code: 'STORY_SEED_CHANGED' }
      );
    }
    const observedRefCommit = refHead(root, materializedSeedRef);
    if (observedRefCommit !== materializedSeedCommit) {
      throw new SingularityFlowError(
        `Materialized Story branch '${canonicalBranch}' moved after its seed was accepted. Refresh the Story seed and retry; nothing was changed.`,
        {
          code: 'STORY_SEED_CHANGED',
          details: {
            storyBranch: canonicalBranch,
            seedCommit: materializedSeedCommit,
            observedCommit: observedRefCommit
          }
        }
      );
    }
    if (!observeRemote || materializedSeedRef !== remoteStoryRef) return;
    // A person may spend minutes answering intake prompts. Re-observe the authoritative Story ref
    // after those prompts and immediately before automatic enrollment, rather than trusting the
    // earlier remote-tracking ref. This is a read-only ls-remote, not another fetch or checkout.
    const currentDestination = await observeStoryDestination(remote);
    const observedRemoteCommit = currentDestination.authority?.ok === true
      ? currentDestination.authority.refs.get(advertisedStoryRef) ?? null
      : null;
    if (observedRemoteCommit !== materializedSeedCommit) {
      throw new SingularityFlowError(
        `Materialized Story branch '${canonicalBranch}' moved while Story intake was being reviewed. Refresh the Story seed and retry; nothing was changed.`,
        {
          code: 'STORY_SEED_CHANGED',
          details: {
            storyBranch: canonicalBranch,
            seedCommit: materializedSeedCommit,
            observedCommit: observedRemoteCommit
          }
        }
      );
    }
  };
  if (materializedSeedText !== null) {
    materializedSeed = YAML.parse(materializedSeedText)?.story ?? null;
    if ((materializedSeed?.workId ?? materializedSeed?.id) !== id) {
      throw new SingularityFlowError(
        `Published Story branch '${canonicalBranch}' carries a seed for a different Story. Nothing was changed.`,
        { code: 'STORY_BRANCH_EXISTS' }
      );
    }
    if (!materializedSeed.parentBranch || !materializedSeed.baseCommit) {
      throw new SingularityFlowError(
        `Materialized Story '${id}' does not record its pinned parent branch and base commit. Nothing was changed.`,
        { code: 'STORY_BASE_INVALID' }
      );
    }
    if (!approvedConfigurationSnapshot) {
      config = await loadLegacyMaterializedStoryDefinition(root, {
        remote,
        storyBranch: canonicalBranch,
        seedCommit: materializedSeedCommit
      });
      validateId(config, id);
    }
  }
  const selectionHandoff = options[ISOLATED_STORY_SELECTION_HANDOFF]?.token === receiptToken
    ? options[ISOLATED_STORY_SELECTION_HANDOFF] : null;
  if (receiptToken) {
    const resolveReceipt = selectionHandoff
      ? async () => resolveHandedOffStartSelectionReceipt(selectionHandoff, config)
      : () => resolveSelectionReceipt(root, config, receiptToken, { action: 'start', workId: id });
    // Recompute the receipt's branch choices inside the same exact approved snapshot that will
    // govern Story creation. Otherwise a stale workspace URL could be contacted while checking a
    // receipt, before the later capability preflight had a chance to reject it.
    receipt = approvedConfigurationSnapshot
      ? await withStoryConfigurationSnapshotRead(root, approvedConfigurationSnapshot, resolveReceipt)
      : await resolveReceipt();
  }

  // A stable external identity wins over a proposed new Work ID. Fetch and search the governed
  // refs before choosing a base or checking out a branch, then attach to the existing Story.
  const requestedExternalSource = await externalSource();
  if (requestedExternalSource?.stableId) {
    await measureCommandSpan('start.fetch', fetchObservedStoryDestination);
    const refs = [
      ...localBranches(root).map((branchName) => ({ branch: branchName, ref: branchName })),
      ...remoteBranches(root, remote).map((branchName) => ({ branch: branchName, ref: `${remote}/${branchName}` }))
    ];
    const sourceIndex = await buildRepositorySubjectIndexFromRefs(root, { definition: config ?? {}, refs });
    const existing = resolveContext(sourceIndex, {
      reference: requestedExternalSource.stableId, kind: 'story', required: false
    });
    if (existing) {
      if (referenceRequests.length) {
        throw new SingularityFlowError(
          `Source ${requestedExternalSource.stableId} is already governed as Story '${existing.id}'. `
          + 'Reference repositories are immutable intake inputs and cannot be added while attaching.',
          { code: 'REFERENCE_REPOSITORY_STORY_EXISTS' }
        );
      }
      if (!optionBoolean(options, 'json')) {
        console.log(`Source ${requestedExternalSource.stableId} is already governed as ${existing.id}; attaching instead of creating ${id}.`);
      }
      return resumeCommand(['resume', existing.id], { ...options, fetch: true });
    }
  }

  const preselectedWorkType = receipt?.answers['workflow-template'] ?? optionString(options, 'work-type');

  if (refExists(root, localStoryRef) && !localStory && !materializedSeed) {
    throw new SingularityFlowError(
      `Local branch '${canonicalBranch}' exists but contains neither governed Story state nor a materialized Story seed. `
      + 'Singularity Flow will not adopt an ungoverned branch as a new Story. Rename or remove that branch, then retry.',
      { code: 'STORY_BRANCH_EXISTS' }
    );
  }
  if (!materializedSeed) validateId(config, id);
  /**
   * The base branch, chosen once for the whole capability.
   *
   * A Story is one unit of work but a capability is usually several repositories, and `--base` only
   * ever spoke for the one this command runs in. `--from-branch` speaks for all of them: it is
   * resolved against what each repository actually publishes, refuses before anything is touched if
   * any of them lack it, and is recorded per repository so the evidence says what the work was
   * really built on.
   *
   * Absent both flags, a terminal presents the remote-derived choices and requires an answer;
   * non-interactive callers receive STORY_BASE_REQUIRED before any checkout or session mutation.
   */
  if (explicitBase && fromBranch.length) {
    throw new SingularityFlowError('Choose either --from-branch or the compatibility --base option, not both.', {
      code: 'STORY_BASE_INVALID'
    });
  }
  const receiptBase = receipt?.answers?.['base-branch'] ?? null;
  const requestedBase = fromBranch.length
    ? fromBranch
    : receiptBase
      ? [receiptBase]
      : explicitBase
        ? [explicitBase]
        : [];
  const {
    assertApprovedCapabilityRepositoryPlan, assertStoryBaseSharesHistory, storyBaseForRepository, preflightStoryRepositories,
    capabilityPublicationPlan, prepareCapabilityRepositories, printCapabilityBase,
    preflightIncludesRepository, preflightPublicationAuthority
  } = await import('../capability-start.mjs');
  if (materializedSeed && requestedBase.length
    && requestedBase.some((value) => value !== materializedSeed.parentBranch)) {
    throw new SingularityFlowError(
      `Story '${id}' is already materialized from '${materializedSeed.parentBranch}'. Its pinned base is read-only.`,
      { code: 'STORY_BASE_INVALID' }
    );
  }
  const storyBase = materializedSeed
    ? {
        scope: 'materialized',
        capability: null,
        remote,
        localBase: materializedSeed.parentBranch,
        pinnedBaseCommit: materializedSeed.baseCommit
      }
    : await storyBaseForRepository(root, {
        values: requestedBase,
        interactive: !optionBoolean(options, 'json') && !optionBoolean(options, 'yes') && !receiptToken,
        remote,
        defaultBranch: config?.defaultBaseBranch ?? applicationDefault,
        stateBranch: config?.ledger?.branch,
        capabilityId: optionString(options, 'capability'),
        configurationSnapshot: approvedConfigurationSnapshot,
        // Legacy intake must choose a base before it can know which branch-local capability map is
        // authoritative. Treat the machine-local workspace membership as a provisional read-only
        // inventory, then validate it against the exact selected-base map below before mutation.
        deferCapabilityAuthority: !approvedConfigurationSnapshot
      });
  if (explicitBase && storyBase.scope === 'capability') {
    throw new SingularityFlowError(
      '--base is a compatibility alias for a standalone repository. Use --from-branch for a capability.',
      { code: 'STORY_BASE_INVALID' }
    );
  }
  const baseAtStart = storyBase.localBase;
  const launchBaseBranch = optionString(options, 'story-launch-base-branch');
  if (launchBaseBranch && launchBaseBranch !== baseAtStart) {
    throw new SingularityFlowError(
      `Selected Story base changed from '${launchBaseBranch}' to '${baseAtStart}' after the isolated launch was verified. Refresh Story intake and retry; nothing was changed.`,
      {
        code: 'STORY_BASE_INVALID',
        details: { expectedBranch: launchBaseBranch, observedBranch: baseAtStart }
      }
    );
  }
  const workflowCapabilityId = optionString(options, 'capability') ?? storyBase.capability ?? null;
  // With no shared authority, the selected remote base itself owns policy. Refresh and fully load
  // its bounded configuration before document policy, publication policy, capability preflight or
  // readiness can observe the launch checkout's potentially divergent workflow.
  let legacyBaseConfigurationCommit = null;
  let legacyCapabilityEvidence = null;
  if (!approvedConfigurationSnapshot && !materializedSeed) {
    const fetchAuthority = configuredRemoteAuthority(root, remote, { direction: 'fetch' });
    if (!fetchAuthority.url) {
      throw new SingularityFlowError(
        `Story remote '${remote}' has no credential-free fetch authority. Nothing was changed.`,
        { code: 'STORY_REMOTE_UNREACHABLE' }
      );
    }
    if (!await reuseIsolatedBaseFetch(baseAtStart)) {
      await measureCommandSpan('start.fetch', () =>
        fetchRemote(root, remote, {
          transportRemote: fetchAuthority.url,
          branches: refExists(root, remoteStoryRef) ? undefined : [baseAtStart], respectPartialClone: true
        }));
    }
    const selectedBaseRef = `refs/remotes/${remote}/${baseAtStart}`;
    const selectedBaseCommit = localRefHeads(root, [selectedBaseRef]).get(selectedBaseRef);
    if (!selectedBaseCommit) {
      throw new SingularityFlowError(
        `Selected base branch '${baseAtStart}' is no longer published by remote '${remote}'. Nothing was changed.`,
        { code: 'STORY_BASE_INVALID' }
      );
    }
    // Before reading the base's own configuration: an orphan base has none to read.
    assertStoryBaseSharesHistory(root, { remote, baseBranch: baseAtStart });
    legacyBaseConfigurationCommit = selectedBaseCommit;
    const selectedBaseConfiguration = await loadLegacyStoryBaseContext(root, {
      remote, baseBranch: baseAtStart, baseCommit: legacyBaseConfigurationCommit,
      capabilityId: workflowCapabilityId
    });
    config = selectedBaseConfiguration.definition;
    legacyCapabilityEvidence = selectedBaseConfiguration.capabilityEvidence;
    if (storyBase.scope === 'capability') {
      assertApprovedCapabilityRepositoryPlan(
        storyBase.plan.repositories,
        legacyCapabilityEvidence?.capability,
        null,
        { portfolio: legacyCapabilityEvidence?.portfolio ?? null }
      );
    }
    validateId(config, id);
  }
  const publishRequired = (config?.git?.publish ?? 'required') !== 'off';
  let capabilityPreflight = null;
  let capabilityPublications = [];
  let publicationAuthority = null;
  let startReadiness = null;
  // A published configuration authority always governs a new Story, including when start was
  // launched from an older pinned Story or an application base still contains a legacy workflow.
  // The legacy base remains a fallback only when no usable sflow/config/state mirror exists.
  const baseCarriesConfiguration = legacyBaseConfigurationCommit !== null || [
    `refs/remotes/${remote}/${baseAtStart}`,
    `refs/heads/${baseAtStart}`
  ].some((ref) => fileAtRef(root, ref, WORKFLOW_PATH) !== null);
  // The checked-out workflow is a fallback for positive remote absence, never for an unreadable or
  // invalid higher-priority authority. The resolver now distinguishes an unrelated unmarked `state`
  // branch from those failures, so swallowing an exception here would only reintroduce stale policy.
  let automaticEnrollment = null;
  if (!configurationAuthority && !materializedSeedCommit
      && !baseCarriesConfiguration) {
    throw storyConfigurationUnavailableError();
  }
  // Freeze and validate the exact approved payload before automatic enrollment is allowed to push
  // a shared configuration change. This validates both malformed catalogs and an explicit/workspace
  // capability selection without touching the application checkout.
  validateConfigurationSnapshotCapabilities(approvedConfigurationSnapshot, {
    capabilityId: workflowCapabilityId
  });
  let documentCapture = null;
  let preloadedManual = null;
  try {
  // Parse and snapshot every non-interactive supporting input before automatic enrollment or the
  // first Story checkout. A missing, unreadable, or malformed input therefore cannot publish a
  // shared identity change and then fail before the requested Story exists.
  preloadedManual = storyFile
    ? await loadManualStory(id, { storyFile, title, description, acceptanceCriteria })
    : null;
  // Explicit, receipt and already-materialized choices can be validated immediately. An ordinary
  // base may itself contain an Epic seed, so defer an otherwise-interactive workflow choice until
  // the exact refreshed base ref is available below; this preserves the seed as reviewed input
  // without letting enrollment happen before the choice is known.
  let deterministicWorkType = preselectedWorkType ?? materializedSeed?.suggestedWorkType ?? null;
  const validateDeterministicStartPolicy = async (definition, snapshot, evidence = []) => {
    let resolved = null;
    if (deterministicWorkType) {
      await selectWorkType(definition, { selection: deterministicWorkType });
      resolved = assertWorkTypeStartable(resolveWorkType(definition, deterministicWorkType));
    }
    const retainedCapabilityMap = validateConfigurationSnapshotCapabilities(snapshot, {
      capabilityId: workflowCapabilityId
    });
    const policy = retainedCapabilityMap?.definition && retainedCapabilityMap.capabilityId
      ? resolveEffectiveCapabilityPolicy(
        retainedCapabilityMap.definition, retainedCapabilityMap.capabilityId
      ).policy
      : legacyCapabilityEvidence?.capability?.policy ?? {};
    if (resolved) {
      const referenceMode = resolved.referenceRepositoryPolicy?.mode ?? 'optional';
      if (referenceMode === 'off' && referenceRequests.length) {
        throw new SingularityFlowError(
          `Work type '${deterministicWorkType}' does not allow reference repositories.`,
          { code: 'REFERENCE_REPOSITORIES_NOT_ALLOWED' }
        );
      }
      if (referenceMode === 'required' && !referenceRequests.length) {
        throw new SingularityFlowError(
          `Work type '${deterministicWorkType}' requires at least one read-only reference repository at intake. `
          + 'Pass paired --reference-repository ID=URL and --reference-branch ID=BRANCH options.',
          { code: 'REFERENCE_REPOSITORIES_REQUIRED' }
        );
      }
    }
    const maximumFileBytes = Math.min(
      resolved?.documents?.maxFileBytes ?? Math.max(
        definition.documents?.maxFileBytes ?? 26214400,
        ...Object.keys(definition.workTypes ?? {}).map((workTypeId) => (
          resolveWorkType(definition, workTypeId).documents?.maxFileBytes ?? 0
        ))
      ),
      policy.maxDocumentBytes ?? Number.MAX_SAFE_INTEGER
    );
    const allowedMimeTypes = Object.hasOwn(policy, 'allowedMimeTypes')
      ? policy.allowedMimeTypes : null;
    for (const record of evidence) {
      if (record.size > maximumFileBytes) {
        throw new SingularityFlowError(
          `Document exceeds the ${maximumFileBytes} byte limit: ${record.source}`
        );
      }
      if (allowedMimeTypes && !allowedMimeTypes.includes(record.mimeType)) {
        throw new SingularityFlowError(
          `Capability does not allow MIME type '${record.mimeType}' for ${record.source}.`
        );
      }
    }
    return { resolved, policy, maximumFileBytes, allowedMimeTypes };
  };
  let deterministicPolicy = await validateDeterministicStartPolicy(
    approvedConfigurationSnapshot?.definition ?? config,
    approvedConfigurationSnapshot
  );
  if (deterministicWorkType === 'poc-workflow') {
    normalizeMcpTargetOrigin(optionString(options, 'target-url'), {
      required: true,
      label: 'POC target URL'
    });
  }
  const initialDocumentInputs = [...withStartDocumentDefaults(preloadedManual?.documents ?? [], options), ...explicitDocumentInputs];
  await assertStartDocuments(initialDocumentInputs, {
    phaseOrder: deterministicPolicy.resolved?.phases?.map((phase) => phase.id) ?? null,
    documentPolicy: deterministicPolicy.resolved?.documents ?? null
  });
  documentCapture = await measureCommandSpan('start.documents', () => preflightInitialStoryDocuments(initialDocumentInputs, {
    repositoryRoot: root,
    launchRepository: optionString(options, 'story-launch-repository') ?? null,
    maxFileBytes: deterministicPolicy.maximumFileBytes,
    allowedMimeTypes: deterministicPolicy.allowedMimeTypes
  }));
  // Reference syntax was already validated when options were parsed. Resolve each read-only branch
  // to its exact advertised commit before enrollment as well: an inaccessible or missing reference
  // is an intake refusal, not authority to add a person to sflow/config.
  // Resolution exists this early only so an inaccessible reference refuses before enrollment can
  // publish a membership commit. When enrollment cannot publish, the fetch that materializes each
  // reference resolves its branch as well (null here), one round trip instead of two.
  const enrollmentMayPublish = configurationAuthority?.branch === CONFIGURATION_BRANCH
    && config.approvalSecurity?.autoEnrollNewIdentities !== false
    && automaticEnrollmentMayPublish(root, approvedConfigurationSnapshot);
  // The intake wave resolved exactly these reference branches a moment ago, before any mutation.
  const intakePins = intakeFresh() && referenceRequests.length > 0
    && intakeProof.referencePins.length === referenceRequests.length
    && referenceRequests.every((request) => intakeProof.referencePins.some((pin) =>
      pin.id === request.id && pin.requestedBranch === request.requestedBranch))
    ? intakeProof.referencePins.map((pin) => ({ ...pin })) : null;
  if (intakePins) intakeStatus.reused.push('reference-pins');
  const referencePins = intakePins ?? (!referenceRequests.length
    ? await resolveReferenceRepositoryPins(referenceRequests, { localNamespace: id })
    : enrollmentMayPublish
      ? await measureCommandSpan('start.reference-pins', () =>
        resolveReferenceRepositoryPins(referenceRequests, { localNamespace: id }))
      : null);
  // Complete the read-only capability and Git publication proof before automatic enrollment. A
  // contributor must never leave a shared membership commit behind only to discover that the base,
  // destination ref, or office Git policy prevents this Story from starting.
  capabilityPreflight = storyBase.scope === 'capability'
    ? await measureCommandSpan('start.repository-preflight', () =>
      preflightStoryRepositories(storyBase.workspaceRoot, storyBase.plan, canonicalBranch, {
        remote, publishRequired, lifecycleRoot: root, capabilityId: storyBase.capability,
        configurationSnapshot: approvedConfigurationSnapshot,
        capabilityEvidence: legacyCapabilityEvidence,
        launchFetchProof: options[ISOLATED_STORY_BASE_FETCH_HANDOFF] ?? null,
        // Destination discovery observed this remote after the launch fetch, a moment ago.
        launchFetchObservation: destination.authority?.ok === true
          ? { url: destination.transportRemote, observation: destination.authority } : null,
        intakeProof: intakeFresh() ? intakeProof : null
      }))
    : null;
  if (capabilityPreflight?.some((entry) => entry.dryRunVerified)) intakeStatus.reused.push('dry-run');
  if (destinationFromIntake && capabilityPreflight?.some((entry) => entry.fetchReused)) {
    intakeStatus.reused.push('base-probe');
  }
  const originalBranch = branch(root);
  // Fetch and prove the exact source and destination before the first checkout or session change.
  // Listing branches establishes read access; this dry-run additionally establishes that the
  // configured publication remote will accept the new Story ref.
  const rootFetchedByCapabilityPreflight = preflightIncludesRepository(capabilityPreflight, root);
  if (rootFetchedByCapabilityPreflight) {
    publicationAuthority = preflightPublicationAuthority(capabilityPreflight, root);
  } else {
    const fetchAuthority = configuredRemoteAuthority(root, remote, { direction: 'fetch' });
    if (!fetchAuthority.url) {
      throw new SingularityFlowError(
        `Story remote '${remote}' has no credential-free fetch authority. Nothing was changed.`,
        { code: 'STORY_REMOTE_UNREACHABLE' }
      );
    }
    if (!await reuseIsolatedBaseFetch(baseAtStart)) {
      await measureCommandSpan('start.fetch', () =>
        fetchRemote(root, remote, {
          transportRemote: fetchAuthority.url,
          branches: refExists(root, remoteStoryRef) ? undefined : [baseAtStart], respectPartialClone: true
        }));
    }
    if (publishRequired) publicationAuthority = configuredRemoteAuthority(root, remote);
  }
  if (publishRequired && !publicationAuthority?.url) {
    throw new SingularityFlowError(
      `Story remote '${remote}' has no credential-free push authority. Nothing was changed.`,
      { code: 'STORY_PUBLICATION_REMOTE_MISSING' }
    );
  }
  const remoteBaseRef = `refs/remotes/${remote}/${baseAtStart}`;
  // One fresh observation at this checkpoint, not a cache carried across fetches or intake.
  const selectedRefs = materializedSeed ? null : localRefHeads(root, [remoteBaseRef, remoteStoryRef]);
  if (!materializedSeed && !selectedRefs.has(remoteBaseRef)) {
    throw new SingularityFlowError(
      `Selected base branch '${baseAtStart}' is no longer published by remote '${remote}'. Nothing was changed.`,
      { code: 'STORY_BASE_INVALID' }
    );
  }
  // Every path reaches this check, approved configuration or not: an orphan branch is no line of work.
  if (!materializedSeed) assertStoryBaseSharesHistory(root, { remote, baseBranch: baseAtStart });
  if (!materializedSeed && selectedRefs.has(remoteStoryRef)) {
    throw new SingularityFlowError(
      `Story branch '${canonicalBranch}' already exists on '${remote}'. Resume it instead of starting it again. Nothing was changed.`,
      { code: 'STORY_BRANCH_EXISTS' }
    );
  }
  const baseCommitAtStart = materializedSeed?.baseCommit ?? selectedRefs.get(remoteBaseRef);
  const launchBaseCommit = optionString(options, 'story-launch-base-commit');
  if (launchBaseCommit && baseCommitAtStart !== launchBaseCommit) {
    throw new SingularityFlowError(
      `Selected base '${baseAtStart}' moved after repository readiness was checked. Refresh Story intake and retry; nothing was changed.`,
      {
        code: 'STORY_BASE_INVALID',
        details: {
          baseBranch: baseAtStart,
          readinessCommit: launchBaseCommit,
          observedCommit: baseCommitAtStart
        }
      }
    );
  }
  if (legacyBaseConfigurationCommit && baseCommitAtStart !== legacyBaseConfigurationCommit) {
    throw new SingularityFlowError(
      `Selected base '${baseAtStart}' moved while its workflow policy was being checked. Refresh Story intake and retry; nothing was changed.`,
      {
        code: 'STORY_BASE_INVALID',
        details: {
          baseBranch: baseAtStart,
          policyCommit: legacyBaseConfigurationCommit,
          observedCommit: baseCommitAtStart
        }
      }
    );
  }
  await assertMaterializedSeedUnchanged();
  const baseSeedText = materializedSeed ? null : fileAtRef(root, remoteBaseRef, storySeedRelative);
  const baseSeed = baseSeedText == null ? null : YAML.parse(baseSeedText)?.story ?? null;
  if (baseSeed && baseSeed.workId !== id && baseSeed.id !== id) {
    throw new SingularityFlowError(
      `Story seed ${storySeedRelative} does not belong to Work ID '${id}'.`
    );
  }
  const seedChoiceAllowed = !storyFile && !title && !description && !acceptanceCriteria;
  assertStoryStartChoices({
    nonInteractive,
    workType: deterministicWorkType ?? (seedChoiceAllowed ? baseSeed?.suggestedWorkType : null),
    source: declaredSource ?? receipt?.answers['intake-source'] ?? ((materializedSeed ?? baseSeed) ? 'manual' : null),
    manualInput: !seedChoiceAllowed || Boolean(materializedSeed ?? baseSeed)
  });
  if (!deterministicWorkType) {
    deterministicWorkType = (seedChoiceAllowed ? baseSeed?.suggestedWorkType : null)
      ?? await selectWorkType(config, {
        selection: null,
        nonInteractiveHint: 'Pass --work-type <id> to choose one without a terminal.'
      });
  }
  if (deterministicWorkType === 'poc-workflow') {
    normalizeMcpTargetOrigin(optionString(options, 'target-url'), {
      required: true,
      label: 'POC target URL'
    });
  }
  deterministicPolicy = await validateDeterministicStartPolicy(
    approvedConfigurationSnapshot?.definition ?? config,
    approvedConfigurationSnapshot,
    documentCapture.evidence
  );
  // A materialized Epic Story branch already contains its governed seed commit. Its lineage base is
  // still the parent commit recorded in the seed, but Story-start recovery must recognize the
  // branch tip that existed before intake began or any later refusal becomes an unrecoverable
  // "unrecognized commit" loop.
  const recoveryBaseCommit = materializedSeed
    ? materializedSeedCommit
    : baseCommitAtStart;
  // The intake wave dry-ran this exact destination from this exact base a moment ago.
  const dryRunFromIntake = !capabilityPreflight && Boolean(intakeProof?.dryRun) && intakeFresh() && !materializedSeed
    && intakeProof.dryRun.pushUrl === publicationAuthority?.url
    && intakeProof.dryRun.pushFingerprint === publicationAuthority?.fingerprint
    && intakeProof.dryRun.destinationRef === advertisedStoryRef
    && intakeProof.dryRun.baseCommit === baseCommitAtStart;
  if (dryRunFromIntake) intakeStatus.reused.push('dry-run');
  if (publishRequired && !capabilityPreflight && !dryRunFromIntake) {
    const dryRun = await preflightPushBranch(
      root, remote, materializedSeed ? materializedSeedCommit : remoteBaseRef, canonicalBranch,
      { transportRemote: publicationAuthority.url }
    );
    if (dryRun.status !== 0) {
      throw storyPublicationPreflightError(dryRun, { branch: canonicalBranch, remote });
    }
  }
  // The legacy loader already validated governance at this exact commit, and the live fetch
  // comparison above refuses a moved base. Do not re-read another (potentially stale local) base.
  if (!legacyBaseConfigurationCommit) assertBaseCarriesGovernance(root, {
    config, branchName: canonicalBranch, base: baseAtStart, remote, currentBranch: originalBranch,
    configurationRemote: configurationAuthority?.remote
      ?? (materializedSeedCommit ? remote : null)
  });
  const readinessRepositories = capabilityPreflight?.map((entry) => ({
    id: entry.repository,
    baseBranch: entry.baseBranch,
    baseCommit: entry.baseCommit,
    destinationRef: entry.destinationRef,
    publishRequired: entry.publishRequired
  })) ?? [{
    id: 'lifecycle', baseBranch: baseAtStart, baseCommit: baseCommitAtStart,
    destinationRef: advertisedStoryRef, publishRequired
  }];
  const repositoryReadiness = await measureCommandSpan('start.readiness', () =>
    collectRepositoryReadinessEvidence(
    capabilityPreflight?.map((entry) => ({
      id: entry.repository, root: entry.root, baseCommit: entry.baseCommit
    })) ?? [{ id: 'lifecycle', root, baseCommit: baseCommitAtStart }],
    { scope: requiredRepositoryReadinessScope(approvedConfigurationSnapshot?.definition ?? config),
      testRuntime: (approvedConfigurationSnapshot?.definition ?? config).repositoryReadiness?.testRuntime,
      advisory: !repositoryReadinessRequired(approvedConfigurationSnapshot?.definition ?? config) }
  ));
  const testRecoveryPreview = await prepareTestRecoveryIntake(root, {
    definition: approvedConfigurationSnapshot?.definition ?? config, workId: id,
    workType: deterministicWorkType, repositories: readinessRepositories, repositoryReadiness,
    choices: testRecoveryChoices(options),
    phaseDefinitions: testRecoveryIntakePhases(approvedConfigurationSnapshot?.definition ?? config,
      deterministicWorkType, approvedConfigurationSnapshot, workflowCapabilityId, legacyCapabilityEvidence)
  });
  const testRecoveryPlan = confirmTestRecoveryIntake(testRecoveryPreview,
    optionString(options, 'test-policy-confirm'), options);
  startReadiness = inspectStoryStartReadiness({
    workId: id,
    definition: approvedConfigurationSnapshot?.definition ?? config,
    configurationSnapshot: approvedConfigurationSnapshot,
    workType: deterministicWorkType,
    capabilityId: workflowCapabilityId,
    baseBranch: baseAtStart,
    repositories: readinessRepositories,
    repositoryReadiness,
    readinessBaseline: optionString(options, 'readiness-baseline', 'reuse'),
    publicationRequired: publishRequired,
    surface: optionBoolean(options, 'json') ? 'machine' : 'shell'
  });
  startReadiness = applyTestRecoveryAdmission(startReadiness, testRecoveryPlan);
  assertStoryStartReady(startReadiness);

  // Freeze every human/external intake choice and admit every document before the first shared
  // configuration mutation. A cancelled prompt, Jira failure, or disallowed interactive document
  // must leave both sflow/config and the application checkout untouched.
  const receiptSource = receipt?.answers['intake-source'] ?? null;
  if (declaredSource && receiptSource && declaredSource !== receiptSource) {
    throw new SingularityFlowError(
      `Selection receipt chose ${receiptSource} intake, but the start command explicitly requests ${declaredSource} intake.`);
  }
  const frozenSeed = materializedSeed ?? baseSeed;
  const frozenManualSeed = frozenSeed && !storyFile && !title && !description && !acceptanceCriteria
    ? frozenSeed : null;
  const sourceMode = declaredSource
    ?? receiptSource
    ?? (frozenSeed ? 'manual' : null)
    ?? await selectIntakeSource({
      selection: null,
      nonInteractiveHint: 'Pass --jira, or --title with --description, to say where the work came from.'
    });
  const manual = sourceMode === 'manual'
    ? (frozenManualSeed
        ? await loadManualStory(id, {
          title: frozenManualSeed.title ?? id,
          description: frozenManualSeed.description ?? '',
          acceptanceCriteria: (frozenManualSeed.acceptanceCriteria ?? []).join('\n')
        })
        : preloadedManual ?? (storyFile || title || description || acceptanceCriteria
          ? await loadManualStory(id, { storyFile, title, description, acceptanceCriteria })
          : await promptManualStory(id)))
    : null;
  const normalizedManualSource = manual ? normalizeWorkSource(manual.source) : null;
  let source = requestedExternalSource
    ?? (sourceMode === 'jira'
      ? normalizeWorkSource(await getIssue(id), { rawRef: id, fetchedAt: nowIso() })
      : {
          ...normalizedManualSource,
          // Manual source.json predates WorkSourceV1 and stores criteria as Markdown. Preserve that
          // public artifact shape while the normalized hash and provider contract remain list-based.
          acceptanceCriteria: manual.source.acceptanceCriteria
        });
  // The first capture already owns the exact bytes for every non-interactive input. Only a later
  // interactive manual intake can add documents here; never read the first sources a second time.
  const laterDocuments = preloadedManual ? [] : withStartDocumentDefaults(manual?.documents ?? [], options);
  let supportingDocuments = documentCapture.inputs;
  const workType = deterministicWorkType;
  const targetOrigin = normalizeMcpTargetOrigin(optionString(options, 'target-url'), {
    required: workType === 'poc-workflow',
    label: 'POC target URL'
  });
  if (targetOrigin) source = { ...source, targetOrigin };
  let resolvedWorkType = assertWorkTypeStartable(resolveWorkType(config, workType));
  const retainedCapabilityMapBeforeEnrollment = validateConfigurationSnapshotCapabilities(
    approvedConfigurationSnapshot, { capabilityId: workflowCapabilityId }
  );
  const capabilityPolicyBeforeEnrollment = retainedCapabilityMapBeforeEnrollment?.definition
      && retainedCapabilityMapBeforeEnrollment.capabilityId
    ? resolveEffectiveCapabilityPolicy(
      retainedCapabilityMapBeforeEnrollment.definition,
      retainedCapabilityMapBeforeEnrollment.capabilityId
    ).policy
    : legacyCapabilityEvidence?.capability?.policy ?? {};
  // Names are unique across every Story-start document, and phases belong to the chosen work type.
  await assertStartDocuments([...documentCapture.inputs, ...laterDocuments], {
    phaseOrder: resolvedWorkType.phases.map((phase) => phase.id),
    documentPolicy: resolvedWorkType.documents ?? null
  });
  documentCapture = await measureCommandSpan('start.documents', () =>
    preflightInitialStoryDocuments(laterDocuments, {
    repositoryRoot: root,
    launchRepository: optionString(options, 'story-launch-repository') ?? null,
    priorCapture: documentCapture,
    maxFileBytes: Math.min(
      resolvedWorkType.documents?.maxFileBytes ?? 26214400,
      capabilityPolicyBeforeEnrollment.maxDocumentBytes ?? Number.MAX_SAFE_INTEGER
    ),
    allowedMimeTypes: Object.hasOwn(capabilityPolicyBeforeEnrollment, 'allowedMimeTypes')
      ? capabilityPolicyBeforeEnrollment.allowedMimeTypes : null
  }));
  supportingDocuments = documentCapture.inputs;
  const referenceMode = resolvedWorkType.referenceRepositoryPolicy?.mode ?? 'optional';
  if (referenceMode === 'off' && referenceRequests.length) {
    throw new SingularityFlowError(
      `Work type '${workType}' does not allow reference repositories.`,
      { code: 'REFERENCE_REPOSITORIES_NOT_ALLOWED' }
    );
  }
  if (referenceMode === 'required' && !referenceRequests.length) {
    throw new SingularityFlowError(
      `Work type '${workType}' requires at least one read-only reference repository at intake. `
      + 'Pass paired --reference-repository ID=URL and --reference-branch ID=BRANCH options.',
      { code: 'REFERENCE_REPOSITORIES_REQUIRED' }
    );
  }
  // Human intake can outlive the earlier fetch. Re-observe the exact published seed immediately
  // before automatic enrollment so a concurrent Epic rematerialization cannot leave a membership
  // commit behind for a Story whose accepted seed is no longer current.
  await assertMaterializedSeedUnchanged({ observeRemote: true });
  // One fresh look at approved configuration before the first shared mutation. It proves the
  // authority did not move after Story choices were frozen — whether or not enrollment runs — and
  // the same observation answers enrollment's own resolution and no-op comparison below. When the
  // ledger's state branch lives on the same remote it rides along, and publication's ledger reads
  // answer from it instead of observing the state tip twice more.
  const publicationStateViews = [];
  if (configurationAuthority?.branch === CONFIGURATION_BRANCH) {
    const selectedCommit = approvedConfigurationSnapshot?.sourceCommit ?? configurationAuthority.commit;
    const configurationRef = `refs/heads/${CONFIGURATION_BRANCH}`;
    const ledgerConfig = normalizeLedgerConfig(config.ledger ?? {});
    // Same repository is decided by raw configured identity, as the authority was; the view is
    // keyed by the ledger's transport URL, which an ambient insteadOf rule may spell differently.
    let ledgerIdentity = null;
    try {
      ledgerIdentity = ledgerConfig.enabled
        ? configuredRemoteIdentity(root, ledgerConfig.remote, { direction: 'fetch' }) : null;
    } catch { ledgerIdentity = null; }
    const ledgerRemote = ledgerIdentity?.url === configurationAuthority.remote && !ledgerIdentity.ambiguous
      ? configuredRemoteAuthority(root, ledgerConfig.remote, { direction: 'fetch' }).url : null;
    const stateRef = `refs/heads/${ledgerConfig.branch}`;
    const alongside = ledgerRemote ? [stateRef] : [];
    // The intake wave's authority observation is that fresh look while it is recent enough.
    const authorityFromIntake = intakeFresh() && intakeProof.authority.remote === configurationAuthority.remote
      && intakeProof.authority.commit === configurationAuthority.commit;
    const observed = await measureCommandSpan('start.authority-check', () =>
      storyRemoteSession.observeAsync(configurationAuthority.remote, {
        refs: [configurationRef, ...alongside], includeHead: false, refresh: !authorityFromIntake
      }));
    if (authorityFromIntake) intakeStatus.reused.push('authority-check');
    const current = await configurationBranchHead(configurationAuthority.remote, { observation: observed });
    if (!current.reachable) {
      throw new SingularityFlowError(
        `Cannot re-read approved configuration before starting Story '${id}': ${current.error} Nothing was changed.`,
        { code: observed.failure?.code ?? 'REMOTE_UNKNOWN' }
      );
    }
    if (alongside.length && observed.refs.get(stateRef)) {
      publicationStateViews.push({
        remote: ledgerRemote, branch: ledgerConfig.branch, commit: observed.refs.get(stateRef)
      });
    }
    if (current.sha !== selectedCommit) {
      throw new SingularityFlowError(
        'Approved configuration changed after Story choices were frozen. Refresh Story intake and retry; nothing was changed.',
        {
          code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
          details: { selectedCommit, currentCommit: current.sha }
        }
      );
    }
  }
  // Enrollment is a separate shared-configuration mutation. It is allowed only after every Story
  // input and Git destination has passed the read-only readiness gate above. The exact-parent check
  // proves the enrollment commit advances the snapshot we inspected rather than a concurrent edit.
  if (configurationAuthority?.branch === CONFIGURATION_BRANCH
      && config.approvalSecurity?.autoEnrollNewIdentities !== false) {
    const enrollment = await measureCommandSpan('start.enrollment', () =>
      publishCurrentIdentityToConfiguration(root, {
      target: '*', automatic: true, configurationSnapshot: approvedConfigurationSnapshot,
      expectedSourceCommit: approvedConfigurationSnapshot?.sourceCommit ?? null,
      session: storyRemoteSession
    }));
    automaticEnrollment = enrollment;
    if (enrollment.changed && !enrollment.pushed) {
      throw new SingularityFlowError(
        `Automatic approval enrollment is pending publication. ${enrollment.nextAction?.command
          ? `Run: ${enrollment.nextAction.command}`
          : 'Run singularity-flow push status, retry the retained configuration commit with singularity-flow push retry <ID>, and start again.'}`,
        { code: 'CONFIGURATION_ENROLLMENT_PENDING' }
      );
    }
    if (enrollment.changed) {
      const enrollmentParent = gitAnswer(root, ['rev-parse', '--verify', '--quiet', `${enrollment.commit}^`],
        'Automatic enrollment parent', { absentStatus: 1 })?.trim() ?? '';
      if (!approvedConfigurationSnapshot?.sourceCommit
          || enrollmentParent !== approvedConfigurationSnapshot.sourceCommit) {
        throw new SingularityFlowError(
          'Approved configuration changed after Story choices were frozen and before automatic enrollment. Refresh Story intake and retry; no Story checkout was changed.',
          {
            code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
            details: {
              selectedCommit: approvedConfigurationSnapshot?.sourceCommit ?? null,
              enrollmentParent: enrollmentParent || null,
              enrollmentCommit: enrollment.commit
            }
          }
        );
      }
      configurationAuthority = await resolveNewStoryConfigurationAuthority(root, {
        pinnedRemote: currentPin.valid ? currentPin.source.repository : null
      });
      if (!configurationAuthority || configurationAuthority.commit !== enrollment.commit) {
        throw new SingularityFlowError(
          'Approved configuration changed again after automatic enrollment. Refresh Story intake and retry; nothing was changed.',
          { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' }
        );
      }
      configurationAuthority = enrolledConfigurationAuthority(enrollment, configurationAuthority);
      approvedConfigurationSnapshot = await measureCommandSpan('start.enrollment-refresh', () =>
        loadStoryConfigurationSnapshot(configurationAuthority, {
          session: storyRemoteSession, useObjectCache: true
        }));
      config = approvedConfigurationSnapshot.definition;
      validateConfigurationSnapshotCapabilities(approvedConfigurationSnapshot, {
        capabilityId: workflowCapabilityId
      });
      deterministicPolicy = await validateDeterministicStartPolicy(
        config, approvedConfigurationSnapshot, documentCapture.evidence
      );
      startReadiness = inspectStoryStartReadiness({
        workId: id,
        definition: config,
        configurationSnapshot: approvedConfigurationSnapshot,
        workType: deterministicWorkType,
        capabilityId: workflowCapabilityId,
        baseBranch: baseAtStart,
        repositories: readinessRepositories,
        repositoryReadiness,
        readinessBaseline: optionString(options, 'readiness-baseline', 'reuse'),
        publicationRequired: publishRequired,
        surface: optionBoolean(options, 'json') ? 'machine' : 'shell'
      });
      startReadiness = applyTestRecoveryAdmission(startReadiness, testRecoveryPlan);
      assertStoryStartReady(startReadiness);
    }
  }
  // Candidate retention writes immutable machine-local SGOS sidecars. Persist it only after
  // enrollment and its refreshed readiness proof so a refused enrollment or authority race leaves
  // no Story-specific candidate authority behind.
  capabilityPublications = await capabilityPublicationPlan(capabilityPreflight, root);

  const originalSession = await loadSession(root, { required: false });
  const originalCopilotSession = await loadCopilotSession(root);
  const siblingRepositories = storyBase.scope === 'capability'
    ? storyBase.plan.repositories.map((repository) => {
        const target = repoRoot(workspaceRepositoryPath({ path: storyBase.workspaceRoot }, repository));
        const base = storyBase.plan.resolution.resolved[repository.id];
        const baseRef = `refs/remotes/${remote}/${base.branch}`;
        const refs = localRefHeads(target, [`refs/heads/${canonicalBranch}`, baseRef]);
        return {
          repository: repository.id,
          target,
          from: branch(target),
          targetBranchExisted: refs.has(`refs/heads/${canonicalBranch}`),
          baseCommit: refs.get(baseRef) ?? null
        };
      }).filter((repository) => !managedStoryWorktree
        || gitCommonDir(repository.target) !== gitCommonDir(root))
    : [];
  const startJournal = await beginStoryStartJournal(root, {
    id,
    targetBranch: canonicalBranch,
    targetBranchExisted: refExists(root, localStoryRef),
    originalBranch,
    originalHead: head(root),
    baseCommit: recoveryBaseCommit,
    publicationRemote: remote,
    publicationRemoteFingerprint: publicationAuthority?.fingerprint ?? null,
    ...(publishRequired ? {
      // Ordinary Story start creates the remote ref. A materialized Epic Story advances the exact
      // seed commit already published at that ref, so crash recovery must reconstruct the same
      // lease used by the opening publication rather than treating it as create-only.
      publicationExpectedRemoteSha: materializedSeed ? recoveryBaseCommit : null
    } : {}),
    originalSession,
    originalCopilotSession,
    siblingRepositories
  });
  let createdBranch = false;
  let capabilityRepositoriesPrepared = null;
  let configurationSnapshot = null;
  let configurationRestorePoint = null;
  const checkoutResult = await checkout(root, canonicalBranch, materializedSeed
    // The remote-tracking ref was refreshed and compared with materializedSeedCommit above. Do not
    // fetch it a second time after the Story-start journal exists: that could replace the checked
    // out seed after readiness approved different bytes. The eventual push is separately protected
    // by publicationExpectedRemoteSha using the same immutable commit.
    ? {
        base: baseAtStart,
        fetch: false,
        existingOnly: true,
        remote,
        exactCommit: materializedSeedCommit,
        exactCommitErrorCode: 'STORY_SEED_CHANGED'
      }
    : { base: baseAtStart, fetch: false, remote, preferRemoteBase: true });
  createdBranch = checkoutResult.startsWith('created-from-');
  await updateStoryStartJournal(root, id, startJournal.transactionId, {
    stage: 'root-checked-out', createdBranch, checkoutMode: checkoutResult
  });

  /**
   * The siblings follow the same base.
   *
   * After this repository, not before: if the Story cannot start here there is no reason to have
   * moved four other repositories onto a branch for it. Each is refused if dirty, and a repository
   * the workspace has not cloned is named rather than silently left behind.
   */
  if (storyBase.scope === 'capability') {
    capabilityRepositoriesPrepared = await prepareCapabilityRepositories(
      storyBase.workspaceRoot, storyBase.plan, canonicalBranch, {
        remote, lifecycleRoot: managedStoryWorktree ? root : null,
        fetched: Boolean(capabilityPreflight)
      }
    );
    if (!optionBoolean(options, 'json')) printCapabilityBase(storyBase.plan, capabilityRepositoriesPrepared);
    await updateStoryStartJournal(root, id, startJournal.transactionId, {
      stage: 'siblings-prepared', capabilityRepositoriesPrepared
    });
  }
  // Application branches do not own shared configuration. A new Story receives the exact approved
  // configuration revision here, before any selection or generation happens, and the initial Story
  // commit publishes the copied files together with their provenance record.
  // A managed isolated start may enter an already-materialized Epic seed branch, so Git reports
  // `already-on-branch` even though no durable Story exists yet. The private handoff proves that
  // this is still first creation and carries the exact approved snapshot sealed in the launch
  // checkout. Materialize it under the same journal/restore guards as a newly-created branch.
  if ((createdBranch || configurationHandoff) && configurationAuthority) {
    configurationRestorePoint = await measureCommandSpan('start.configuration-capture', () => captureConfigurationState(root));
    await updateStoryStartJournal(root, id, startJournal.transactionId, {
      stage: 'configuration-captured',
      configurationRestorePoint: serializeConfigurationRestorePoint(configurationRestorePoint)
    });
    configurationSnapshot = await measureCommandSpan('start.configuration-materialize', () => materializeConfigurationSnapshot(root, {
      authority: configurationAuthority,
      snapshot: approvedConfigurationSnapshot,
      remoteName: remote
    }));
  }
  // The selected lifecycle branch, not the checkout the user happened to start from, owns the
  // workflow definition. Reload after materialization so a newly fetched phase graph, agent,
  // template, or world-model policy is what gets pinned into the Story.
  config = await measureCommandSpan('start.configuration-bind', async () => configurationSnapshot
    ? await (await import('./start-configuration.mjs')).loadMaterializedConfigurationDefinition(root, approvedConfigurationSnapshot)
    : await loadConfig(root));
  validateId(config, id);
  await updateStoryStartJournal(root, id, startJournal.transactionId, {
    stage: 'configuration-ready', workItemRelative: workDirRelative(config, id)
  });
  if (receiptToken && !receipt) {
    throw new SingularityFlowError('A start selection receipt requires an initialized governed definition before checkout.');
  }
  // Re-run the same pure gate against the exact definition materialized onto the Story checkout
  // before any governed state, commit, or publication is created, closing the preflight race.
  resolvedWorkType = assertWorkTypeStartable(resolveWorkType(config, workType));
  startReadiness = inspectStoryStartReadiness({
    workId: id,
    definition: config,
    configurationSnapshot: approvedConfigurationSnapshot,
    workType,
    capabilityId: workflowCapabilityId,
    baseBranch: baseAtStart,
    repositories: readinessRepositories,
    repositoryReadiness,
    readinessBaseline: optionString(options, 'readiness-baseline', 'reuse'),
    publicationRequired: publishRequired,
    surface: optionBoolean(options, 'json') ? 'machine' : 'shell'
  });
  if (testRecoveryPlan) {
    const finalTestRecoveryPreview = await prepareTestRecoveryIntake(root, {
      definition: config, workId: id, workType,
      repositories: readinessRepositories, repositoryReadiness,
      choices: testRecoveryChoices(options), phaseDefinitions: testRecoveryIntakePhases(config,
        workType, approvedConfigurationSnapshot, workflowCapabilityId, legacyCapabilityEvidence)
    });
    confirmTestRecoveryIntake(finalTestRecoveryPreview, optionString(options, 'test-policy-confirm'), options);
  }
  startReadiness = applyTestRecoveryAdmission(startReadiness, testRecoveryPlan);
  assertStoryStartReady(startReadiness);
  await validateDeterministicStartPolicy(config, approvedConfigurationSnapshot, documentCapture.evidence);
  // A reference repository is a full checkout of its pinned tree: often the largest transfer in a start.
  const referenceRepositories = referencePins === null
    ? await measureCommandSpan('start.references', () =>
      materializeReferenceRepositoriesFromBranches(root, referenceRequests, { localNamespace: id }))
    : referencePins.length
      ? await measureCommandSpan('start.references', () => materializeReferenceRepositories(root, referencePins))
      : await materializeReferenceRepositories(root, referencePins);
  const selectedAgent = await activatePhaseAgent(
    root, config, id, resolvedWorkType.phases[0], optionString(options, 'agent') ?? null
  );
  let base = baseAtStart;
  const seedFile = path.join(root, 'singularity', 'seeds', `${id}.yml`);
  if (existsSync(seedFile)) {
    const seed = YAML.parse(await readFile(seedFile, 'utf8'));
    if (seed?.story?.workId !== id && seed?.story?.id !== id) {
      throw new SingularityFlowError(`Story seed ${posix(path.relative(root, seedFile))} does not belong to Work ID '${id}'.`);
    }
    source = {
      ...source,
      type: source.type ?? 'jira',
      key: seed.story.jiraKey ?? source.key ?? id,
      id: seed.story.jiraIssueId ?? source.id ?? null,
      epicId: seed.initiative?.id ?? seed.story.epicId ?? null,
      planId: seed.story.planId ?? null,
      branchCompletionPolicy: seed.story.branchCompletionPolicy ?? 'pr',
      requiredChecks: seed.story.requiredChecks ?? [],
      parentBranch: seed.story.parentBranch ?? null,
      seed: posix(path.relative(root, seedFile))
    };
    // Materialization records the branch this story was actually cut from. Use it as the work
    // item's base so change detection (`<base>...HEAD`) sees only the story's own commits, not
    // the epic branch's governance artifacts.
    if (!explicitBase && seed.story.parentBranch) base = seed.story.parentBranch;
  }
  let workflow;
  let returnLocator;
  let publication;
  let initialDocuments = [];
  try {
    await measureCommandSpan('start.publication', () => withLedgerRemoteView(publicationStateViews, () => runDraftTransaction(root, {
      subject: { kind: 'story', id, branch: canonicalBranch },
      allowedPaths: [workDirRelative(config, id)],
      operation: 'story-start',
      write: async (creationPreimage) => {
        workflow = await measureCommandSpan('start.publication.workflow', () => createWorkflow(root, config, {
          id,
          title: optionString(options, 'title', source.title || id),
          source,
          baseBranch: base,
          baseCommit: baseCommitAtStart,
          baseRemote: remote,
          canonicalBranch,
          workType,
          agent: selectedAgent.agent,
          resolved: resolvedWorkType,
          approvedConfigurationSnapshot,
          repositoryReadiness,
          readinessRepositories,
          readinessBaseline: optionString(options, 'readiness-baseline', 'reuse'),
          testExecutionMode: optionString(options, 'test-execution-mode', 'changed-and-affected'),
          qualityGateMode: optionString(options, 'gate-mode', 'hard'),
          testRecoveryPlan,
          capabilityId: workflowCapabilityId,
          // Always carry the verified catalog digest across the preflight/creation boundary. The
          // creation guard applies it only when resolution selected a capability, including one
          // inferred from the approved map; collection-only catalogs remain capability-free.
          capabilityMapSha256: configurationSnapshot?.files?.[CAPABILITIES_PATH]
            ?? legacyCapabilityEvidence?.mapSha256 ?? null,
          referenceRepositories,
          baselineFailures: optionString(options, 'baseline-failures') ?? null
        }));
        returnLocator = await writeReturnLocator(root, config, workflow);
        publication = await measureCommandSpan('start.publication.commit', () => commitAndPublish(
          root,
          config,
          workflow,
          { type: LIFECYCLE_EVENT.BINDING, payload: configurationSnapshot ? {
            configurationBranch: configurationSnapshot.branch,
            configurationCommit: configurationSnapshot.commit
          } : {} },
          `[${id}][init] start ${workType} workflow`,
          [...(configurationSnapshot?.paths ?? []), returnLocator.path],
          {
            beforeStateWrite: async () => {
              initialDocuments = await stageInitialStoryDocuments(root, config, workflow, {
                inputs: supportingDocuments,
                requireFrozen: true
              });
              return initialDocuments;
            },
            eventFromResult: (created) => created?.length ? {
              payload: {
                operation: 'supporting-document-upload',
                ...documentSetLifecycleBinding(created)
              }
            } : null,
            recoveryPreimage: creationPreimage,
            transactionId: startJournal.transactionId,
            // Ordinary Story start creates a ref. A materialized Epic Story already has one exact
            // seed commit, so its first lifecycle commit advances only that reviewed revision.
            expectedRemoteSha: materializedSeed ? recoveryBaseCommit : null,
            expectedLocalHead: recoveryBaseCommit,
            ...(publicationAuthority ? { publicationAuthority } : {}),
            ...(capabilityPublications.length ? {
              publicationTail: {
                recoveryStage: 'capability-publication-pending',
                capabilityPublications,
                error: 'Capability Story branch publication has not started.'
              }
            } : {})
          }
        ));
        return { workflow, publication };
      }
    })));
  } catch (error) {
    if (workflow) {
      await retainCapabilityPublicationRecovery(root, id, {
        remote,
        branch: canonicalBranch,
        commit: publication?.sha ?? head(root),
        event: publication?.event ?? null
      }, capabilityPublications, error);
    }
    throw error;
  }
  await clearStoryStartJournal(root, id, startJournal.transactionId);
  let capabilityPublication = { published: [], pending: [], error: null };
  if (publication.pushed && capabilityPublications.length) {
    capabilityPublication = await publishCapabilityRepositoriesDurably(root, id, {
      remote,
      branch: canonicalBranch,
      commit: publication.sha ?? head(root),
      event: publication.event ?? null
    }, capabilityPublications, { rootPublished: true });
    if (capabilityPublication.pending.length) {
      throw new SingularityFlowError(
        `Story '${id}' was published in its lifecycle repository, but capability branch publication `
        + `failed for '${capabilityPublication.pending[0].repository}': ${capabilityPublication.error}. `
        + 'The remaining exact branch publications were retained; run singularity-flow sync after fixing remote access.',
        { code: 'STORY_CAPABILITY_PUBLICATION_PENDING' }
      );
    }
  } else if (!publication.pushed && capabilityPublications.length) {
    await retainCapabilityPublicationRecovery(root, id, {
      remote,
      branch: canonicalBranch,
      commit: publication.sha ?? head(root),
      event: publication.event ?? null
    }, capabilityPublications, new Error('The lifecycle Story branch is still pending publication.'));
  }
  // Spent once the start has landed, not before it is attempted, in the checkout that recorded it.
  if (receiptToken) {
    try { await consumeSelectionReceipt(selectionHandoff?.root ?? root, receiptToken); }
    catch (error) {
      // The governed approval is already committed and may already be on the remote. Failure to
      // clean up a machine-local one-shot receipt must not turn that success into a red refusal that
      // sends the reviewer back into an "already approved" loop.
      console.warn(`Warning: Story start succeeded, but selection receipt cleanup is pending: ${error.message}`);
    }
  }
  // FOS:CON-004: a durable Story start is the boundary of this command. Optional AST work is
  // exposed as an explicit next action and is never launched (including in the background).
  const astWarm = {
    status: 'available-on-request',
    blocking: false,
    launched: false,
    command: 'singularity-flow wm ast build --all'
  };
  // What this repository can test, sealed with the Story and disclosed before any code [E2G-019, §12 #18].
  const sealedTestPolicy = workflow.testPolicy
    ? await readJson(path.join(workDir(root, config, workflow.workItem.id), workflow.testPolicy.path)).catch(() => null) : null;
  const startResult = commandResult({
    operation: { id: 'start', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('start.succeeded', {
      workId: workflow.workItem.id,
      branch: workflow.workItem.branch,
      phase: workflow.currentPhase
    }),
    // Creates the branch, writes the pinned resolution, and publishes the opening commit.
    effects: effects({ filesChanged: true, stateChanged: true, publicationCreated: true }),
    data: {
      workItem: { id: workflow.workItem.id, branch: workflow.workItem.branch, title: workflow.workItem.title },
      id: workflow.workItem.id,
      testPolicy: sealedTestPolicy ? {
        path: workflow.testPolicy.path, sha256: workflow.testPolicy.sha256, baselineFailures: sealedTestPolicy.baselineFailures,
        executionScope: sealedTestPolicy.executionScope, capability: sealedTestPolicy.capability
      } : null,
      repositoryPath: root,
      workType,
      currentPhase: workflow.currentPhase,
      configuration: approvedConfigurationSnapshot ? {
        branch: approvedConfigurationSnapshot.authority.branch,
        commit: approvedConfigurationSnapshot.sourceCommit,
        authorityCommit: approvedConfigurationSnapshot.observedCommit
      } : null,
      readiness: startReadiness,
      documents: supportingDocuments.length,
      // Present only when a capability base was chosen, so `--json` consumers can tell the
      // single-repository start from the capability-wide one instead of inferring it.
      base: {
        branch: base,
        commit: baseCommitAtStart,
        remote
      },
      publication: {
        remote,
        branch: workflow.workItem.branch,
        ref: `refs/heads/${workflow.workItem.branch}`,
        pushed: publication.pushed === true,
        commit: publication.sha
      },
      returnLocator: {
        path: returnLocator.path,
        integritySha256: returnLocator.locator.integritySha256,
        portability: returnLocator.locator.repositories.every((repository) => repository.portability === 'portable')
          ? 'portable'
          : 'partial'
      },
      measurement: workflow.measurement?.plan ? {
        status: workflow.measurement.status,
        studyId: workflow.measurement.plan.studyId,
        studyRunId: workflow.measurement.plan.studyRunId ?? null,
        cohort: workflow.measurement.plan.groupId,
        promptVariant: workflow.measurement.plan.variantId ?? null
      } : { status: workflow.measurement?.status ?? 'not-enrolled' },
      astWarm,
      ...(automaticEnrollment?.changed ? {
        approvalEnrollment: {
          automatic: true,
          target: '*',
          commit: automaticEnrollment.commit,
          pushed: automaticEnrollment.pushed === true
        }
      } : {}),
      ...(storyBase.scope === 'capability' ? {
        capabilityBase: {
          ...storyBase.plan.record,
          prepared: capabilityRepositoriesPrepared ?? [],
          publications: capabilityPublication.published
        }
      } : {}),
      ...(managedStoryWorktree ? {
        worktree: {
          isolated: true,
          repositoryPath: root,
          launchRepository: optionString(options, 'story-launch-repository') ?? null
        }
      } : {}),
      ...(intakeStatus ? {
        intakeReceipt: {
          status: intakeStatus.status, reason: intakeStatus.reason, reused: [...intakeStatus.reused]
        }
      } : {})
    },
    next: [
      plannedNarrationAction({
        id: 'start.prepare',
        label: `Materialise the ${workflow.currentPhase} artifact so it can be filled in`,
        command: `singularity-flow prepare ${workflow.currentPhase}`
      }, directCopilotSkill(generationSkillForPhase(workflow.phases[workflow.currentPhase], workflow))),
      narrationAction({
        id: 'start.help',
        label: 'See what this phase expects',
        command: `singularity-flow phase show ${workflow.currentPhase}`,
        rank: 'LATER'
      })
    ]
  });
  if (!optionBoolean(options, 'json')) {
    summary(workflow);
    console.log(`Story-start readiness: ${startReadiness.status} · configuration, workflow agents, and Git publication verified.`);
    for (const warning of startReadiness.warnings ?? []) console.log(`Readiness advisory: ${warning.message}`);
    if (sealedTestPolicy?.capability?.status === 'not-checked' || sealedTestPolicy?.capability?.modules?.length) {
      console.log('Test capability (sealed with the Story; plan each criterion where its test can run):');
      for (const line of capabilityLines(sealedTestPolicy.capability)) console.log(`  ${line}`);
    }
    if (startReadiness.warnings?.some((warning) => warning.id === 'configuration-authority')) {
      printCommandRoutes(startReadiness.upgrade.shell, {
        skill: startReadiness.upgrade.copilot,
        label: 'Review the optional configuration upgrade'
      });
    }
    if (automaticEnrollment?.changed) {
      console.log(`Approval enrollment: current Git identity added to configured authorities on ${CONFIGURATION_BRANCH}@${automaticEnrollment.commit.slice(0, 12)} (published).`);
    }
    if (managedStoryWorktree) {
      console.log(`Isolated Story checkout: ${root}`);
      console.log(`Continue there: ${renderChangeDirectoryCommand(root)}`);
    }
    if (workflow.measurement?.plan?.variantId) {
      console.log(`Prompt study assignment: ${workflow.measurement.plan.variantId} · ${workflow.measurement.plan.studyRunId}.`);
    }
    if (supportingDocuments.length) console.log(`Supporting documents: ${supportingDocuments.length} uploaded and published.`);
    console.log(`Optional AST warm-up: ${astWarm.command}`);
  }
  // Starting a Story is the explicit choice a Copilot conversation's work-item selection asks for.
  // Record it for this checkout, as session attach does, so the first /sf-next after a start is not
  // refused for a missing selection. A local record never turns a durable start into a failure.
  await recordStartedWorkItemSelection(root, config, workflow).catch((error) => console.warn(
    `Warning: Story '${workflow.workItem.id}' started, but this checkout's Copilot selection was not recorded: ${error.message}`));
  emitCommandResult(startResult, { json: optionBoolean(options, 'json'), postState: workflow });
  return startResult;
  } catch (error) {
    // One recovery implementation handles both an ordinary throw and the next process after a hard
    // kill. It restores configuration/session/sibling checkouts only while Git still proves they
    // are the exact uncommitted start state; a durable Story commit is preserved for sync/resume.
    try { await recoverStoryStart(root, id, { force: true }); }
    catch (recoveryError) {
      throw new SingularityFlowError(
        `${error.message} Story-start recovery also stopped: ${recoveryError.message}`,
        {
          code: recoveryError.code ?? 'STORY_START_RECOVERY_FAILED',
          details: {
            originalError: {
              code: typeof error?.code === 'string' ? error.code : null,
              message: error?.message ?? String(error),
              details: error?.details ?? null
            },
            recoveryError: {
              code: typeof recoveryError?.code === 'string' ? recoveryError.code : null,
              message: recoveryError?.message ?? String(recoveryError),
              details: recoveryError?.details ?? null
            }
          },
          cause: error
        }
      );
    }
    throw error;
  } finally {
    await documentCapture?.dispose().catch(() => {});
  }
}

/**
 * Documents given to start belong to a new Story's opening record. Resuming a Story would drop them
 * without a word, so it refuses and names the command that adds them to the Story that exists —
 * unless the Story already has every one of them, which is the same start repeated (after a
 * timeout, say) and resumes as before. A link matches by URL; a file by its document name, or by
 * its file name when no name was given.
 */
function refuseStartDocumentsForExistingStory(root, id, story, files, urls, names = []) {
  if (!files.length && !urls.length) return;
  const location = story?.location ?? null;
  let recorded = [];
  if (location?.path) {
    const relative = path.posix.join(path.posix.dirname(location.path), 'documents.json');
    const text = location.source === 'working-tree'
      ? (existsSync(path.join(root, relative)) ? readFileSync(path.join(root, relative), 'utf8') : null)
      : fileAtRef(root, location.commit ?? location.ref, relative);
    try { recorded = (JSON.parse(text ?? '{}').documents ?? []).filter((record) => record?.status !== 'detached'); } catch { recorded = []; }
  }
  const missingUrls = urls.filter((url) => !recorded.some((record) => record.type === 'url' && record.url === url));
  const missingFiles = files.filter((file, index) => {
    const name = names[index]; const base = path.basename(file);
    return !recorded.some((record) => record.type === 'file' && (name
      ? record.name === name || record.label === name
      : record.sourceName === base || path.posix.basename(record.path ?? '') === base));
  });
  const missing = missingUrls.length + missingFiles.length;
  if (!missing) return;
  throw new SingularityFlowError(
    `Story '${id}' already exists, so the ${missing} document(s) given here would not be added. Resume it without --document or --document-url, then add them with singularity-flow documents upload <FILE...> --name <NAME>... (or --url <URL> --name <NAME>). Nothing was changed.`,
    { code: 'STORY_START_DOCUMENTS_STORY_EXISTS', details: { workId: id, documents: missing } }
  );
}

/**
 * Story-start documents from `--document` and `--document-url`, each named by the matching
 * `--document-name` or `--document-url-name` in the same order. `--document-phases` and
 * `--document-store` are given once for every file or once per `--document`, in the same order;
 * `--document-url-phases` does the same for links, which otherwise follow a single
 * `--document-phases`. A count mismatch is refused here; a missing name by assertStartDocuments.
 */
function startDocumentInputs(options, files, urls) {
  const fileNames = optionStrings(options, 'document-name');
  const urlNames = optionStrings(options, 'document-url-name');
  if (fileNames.length > files.length) {
    throw new SingularityFlowError(`--document-name is given ${fileNames.length} times for ${files.length} --document input${files.length === 1 ? '' : 's'}. Give one name per --document, in the same order.`,
      { code: 'DOCUMENT_NAME_REQUIRED' });
  }
  if (urlNames.length > urls.length) {
    throw new SingularityFlowError(`--document-url-name is given ${urlNames.length} times for ${urls.length} --document-url input${urls.length === 1 ? '' : 's'}. Give one name per --document-url, in the same order.`,
      { code: 'DOCUMENT_NAME_REQUIRED' });
  }
  const phaseLists = optionStrings(options, 'document-phases').map(startDocumentPhaseList);
  const filePhases = perStartDocument(phaseLists, files.length, 'document-phases', 'document');
  // Where the files' bytes are kept; a link has none.
  const fileStores = perStartDocument(optionStrings(options, 'document-store'), files.length, 'document-store', 'document');
  const urlPhaseLists = optionStrings(options, 'document-url-phases').map(startDocumentPhaseList);
  const urlPhases = urlPhaseLists.length
    ? perStartDocument(urlPhaseLists, urls.length, 'document-url-phases', 'document-url')
    : urls.map(() => (phaseLists.length === 1 ? phaseLists[0] : null));
  return [
    ...files.map((candidate, index) => ({
      type: 'file', path: candidate, name: fileNames[index] ?? null, label: null, kind: null,
      phases: filePhases[index], store: fileStores[index]
    })),
    ...urls.map((url, index) => ({ type: 'url', url, name: urlNames[index] ?? null, label: null, kind: null, phases: urlPhases[index] }))
  ];
}

/**
 * A --document-store or --document-phases given once is the default for documents a story file
 * lists too, so `--story-file … --document-store local` keeps them on this machine as it says; an
 * entry's own `store` or `phases` wins. Given once per --document, they belong to those files.
 */
function withStartDocumentDefaults(documents, options) {
  const stores = optionStrings(options, 'document-store');
  const phaseLists = optionStrings(options, 'document-phases').map(startDocumentPhaseList);
  const store = stores.length === 1 ? stores[0] : null;
  const phases = phaseLists.length === 1 ? phaseLists[0] : null;
  return documents.map((document) => ({
    ...document,
    store: document.store ?? (document.type === 'url' ? null : store),
    phases: document.phases ?? phases
  }));
}

/** One value for every Story-start document, or one per document in the same order. */
function perStartDocument(values, count, option, input) {
  if (values.length <= 1) return Array.from({ length: count }, () => values[0] ?? null);
  if (values.length === count) return values;
  throw new SingularityFlowError(`--${option} is given ${values.length} times for ${count} --${input} input${count === 1 ? '' : 's'}. Give it once for all of them, or once per --${input}, in the same order.`,
    { code: 'DOCUMENT_OPTION_COUNT', details: { option, given: values.length, documents: count } });
}

/** `specification,planning` or `all`; an empty value means the default phases. */
function startDocumentPhaseList(value) {
  const phases = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  return phases.length ? phases : null;
}
