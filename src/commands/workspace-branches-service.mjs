/** Canonical Story intake branch/readiness preview; no legacy dispatcher or nested CLI. */
import { durableLocalStoryOnBranch, assertBaseCarriesGovernance, testRecoveryIntakePhases } from "./shared/start-context.mjs";
import { normalizeQualityGateMode } from "../phase-quality-risk.mjs";
import path from "node:path";
import { SingularityFlowError, optionBoolean, optionString, optionStrings, posix } from "../util.mjs";
import { branch, fetchRemote, fileAtRef, gitCommonDir, refExists, refHead, repoRoot } from "../git.mjs";
import { worldModelStateAuthority } from "../state-authority.mjs";
import { mintStoryIntakeReceipt, storyIntakeReceiptsDisabled } from "../story-intake-receipt.mjs";
import { validatePortableWorkId } from "../work-id.mjs";
import { applyTestRecoveryAdmission, prepareTestRecoveryIntake, testRecoveryChoices } from "../test-recovery-intake.mjs";
import { loadConfig, validateId } from "../state-stores.mjs";
import { workflowCodeGeneration } from "../code-delivery-policy.mjs";
import { resolveWorkType } from "../config.mjs";
import { documentStorageChoices } from "../document-storage-policy.mjs";
import { GitRemoteSession } from "../git-execution.mjs";
import { configuredRemoteAuthority } from "../git-remote-diagnostics.mjs";
import { parseReferenceRepositoryOptions } from "../reference-repositories.mjs";
import { optionalWorkflowCatalog, workflowCatalogForDefinition } from "../workflow-catalog.mjs";
import { loadPortfolio } from "../initiative-config.mjs";
import { CONFIGURATION_BRANCH } from "../configuration-branch.mjs";
import { inspectStoryStartReadiness, requiredRepositoryReadinessScope, repositoryReadinessRequired } from "../story-start-readiness.mjs";
import { collectRepositoryReadinessEvidence, preflightTestReadiness } from "../repository-readiness-evidence.mjs";
import { loadLegacyStoryBaseContext } from "../story-start-base-configuration.mjs";
import { withApprovedConfigurationRead } from "../approved-configuration-reader.mjs";
import { configurationReadSnapshot } from "../configuration-read-scope.mjs";
import { measureCommandSpan } from "../dx-timing-context.mjs";
import { withReadScope } from '../read-scope.mjs';

export async function readWorkspaceBranchesAtRoot(options, root) {
  return withReadScope(() => readAtRoot(options, root));
}

async function readAtRoot(options, root) {
  const intakeRequested = optionBoolean(options, 'intake');
  const narrowReadiness = optionBoolean(options, 'selected-base-only') && optionString(options, 'preflight-story');
  // Initiative and local Epic start still resolve profiles from the execution checkout. Read the
  // same catalog before entering the approved-configuration overlay; otherwise an older Story
  // checkout could offer a newly approved profile that its immediately following start rejects.
  const localIntakeProfiles = intakeRequested && !narrowReadiness
    ? await loadPortfolio(root)
      .then((portfolio) => intakePortfolioChoices(portfolio))
      .catch((error) => ({
        profiles: [], profileReason: error instanceof Error ? error.message : String(error)
      }))
    : { profiles: [], profileReason: null };
  // [perf] Authority resolution lists its first candidate (the workspace's capability authority,
  // otherwise this checkout's own origin) anyway. For a readiness preview that same listing also
  // carries the chosen base, the Story destination and the state tip; resolution answers from it,
  // and the preview skips its fetch when that is the repository's own remote and the tracking refs
  // already name those tips. Nothing is listed that resolution would not list.
  const intakeSession = new GitRemoteSession({ cwd: root });
  const unionStory = optionString(options, 'preflight-story');
  const unionBases = optionStrings(options, 'from-branch');
  let originTips = null;
  if (unionStory && unionBases.length === 1 && !unionBases[0].includes('=')) {
    const { firstStoryAuthorityCandidate } = await import('../configuration-branch.mjs');
    const originUrl = await firstStoryAuthorityCandidate(root);
    const observation = originUrl ? await intakeSession.observeAsync(originUrl, {
      includeHead: false,
      refs: [
        `refs/heads/${CONFIGURATION_BRANCH}`, 'refs/heads/state',
        `refs/heads/${unionBases[0]}`, `refs/heads/${unionStory}`
      ]
    }).catch(() => null) : null;
    if (observation?.ok) originTips = { url: originUrl, observation };
  }
  // [perf] When authority resolution's first candidate is also the repository the catalog lists,
  // one listing of every head serves both: resolution answers from it, and so does the inventory.
  let originHeads = null;
  if (intakeRequested && !unionStory) {
    const { firstStoryAuthorityCandidate } = await import('../configuration-branch.mjs');
    const originUrl = await firstStoryAuthorityCandidate(root);
    const observation = originUrl ? await intakeSession.observeAsync(originUrl, {
      includeHead: false, includeAllHeads: true
    }).catch(() => null) : null;
    if (observation?.ok) originHeads = { url: originUrl, observation };
  }
  return withApprovedConfigurationRead(root, async () => {
    let definition = await loadConfig(root);
    const approvedConfigurationSnapshot = configurationReadSnapshot(root);
    const {
      assertApprovedCapabilityRepositoryPlan, storyBaseCatalog, storyBaseForRepository,
      preflightStoryRepositories
    } = await import('../capability-start.mjs');
    // Story workflows deliberately come from the latest approved definition because Story start
    // consumes that same authority. Keep the two execution contracts explicit in one response.
    // A configuration-free application branch cannot supply Initiative/Epic profiles locally.
    // In that case the approved read scope already mounted the exact sflow/config snapshot, so
    // recover the profiles from that same authority instead of returning an empty selector. A
    // malformed local portfolio is not hidden: when local configuration exists, this second read
    // resolves to the same checkout and preserves its validation error.
    const intakeProfiles = intakeRequested && !narrowReadiness && localIntakeProfiles.profiles.length === 0
      ? await loadPortfolio(root)
        .then((portfolio) => intakePortfolioChoices(portfolio))
        .catch(() => localIntakeProfiles)
      : localIntakeProfiles;
    let packagedCatalog = intakeRequested && !narrowReadiness
      ? await optionalWorkflowCatalog(() => workflowCatalogForDefinition(definition))
      : { workflows: [], reason: null };
    const packagedStoryWorkflows = packagedCatalog.workflows
      .filter((workflow) => workflow.installed === false);
    let intake = intakeRequested ? {
        ...intakeProfiles,
        // Intake may offer only installed work types: these are the exact profiles Story start can
        // pin from this already-validated approved definition. Re-reading the packaged workflow
        // catalog would load configuration again only to filter every uninstalled row back out.
        storyWorkflows: Object.entries(definition.workTypes).map(([id, workflow]) => ({
          id, label: workflow.label ?? id, description: workflow.description ?? '',
          phases: workflow.phases ?? [], references: workflow.references?.mode ?? 'optional',
          governs: 'story', installed: true,
          ...workflowCodeGeneration(resolveWorkType(definition, id)),
          // Where its documents may be kept, so Start Work offers only what the policy allows.
          documentStorage: documentStorageChoices(resolveWorkType(definition, id).documents)
        })),
        // These are catalog entries, not executable choices. Keeping them in a separate field
        // prevents an editor from accidentally sending an unavailable ID to Story start while
        // still letting it explain where the rest of the packaged workflows went.
        availableStoryWorkflows: packagedStoryWorkflows.map((workflow) => ({
          id: workflow.id, label: workflow.label ?? workflow.id,
          description: workflow.description ?? '', phases: workflow.phases ?? [],
          references: workflow.references?.mode ?? 'optional', governs: 'story',
          installed: false, status: workflow.status,
          generatesCode: workflow.generatesCode, codePhases: workflow.codePhases
        })),
        workflowCatalogReason: packagedCatalog.reason,
        workflowReason: null
      } : null;
    const storyId = optionString(options, 'preflight-story');
    const selectedBaseValues = optionStrings(options, 'from-branch');
    // The editor already loaded the complete branch catalog before a person selected a base.
    // Its readiness request needs a fresh fetch of that selected base, not another all-heads
    // ls-remote from every capability repository. Keep the ordinary command's complete choices
    // unchanged; the opt-in response below explicitly marks its choices as selected-only.
    const selectedBaseOnly = optionBoolean(options, 'selected-base-only');
    if (selectedBaseOnly && (!storyId || !selectedBaseValues.length)) {
      throw new SingularityFlowError(
        '--selected-base-only requires --preflight-story and --from-branch.'
      );
    }
    const existingWorkId = optionString(options, 'work-id');
    if (existingWorkId) {
      validatePortableWorkId(existingWorkId);
      // Existence is read from the complete heads listing, which a selected-base request skips.
      if (selectedBaseOnly) {
        throw new SingularityFlowError('--work-id reads the complete branch catalog; omit --selected-base-only.');
      }
    }
    let catalog = selectedBaseOnly ? null : await measureCommandSpan('intake.catalog', () => storyBaseCatalog(root, {
      // Catalog discovery is not readiness. Do not read every local branch's history/artifacts
      // merely to populate the form; exact-base preflight and start retain their full validation.
      includeLocalMetadata: optionBoolean(options, 'include-local-metadata'),
      observedHeads: originHeads,
      remote: definition.git?.remote ?? 'origin',
      defaultBranch: definition.defaultBaseBranch,
      stateBranch: definition.ledger?.branch,
      capabilityId: optionString(options, 'capability'),
      configurationSnapshot: approvedConfigurationSnapshot,
      // With no shared configuration authority, the exact base chosen later in this request is
      // the only map allowed to authorize the provisional workspace repository set.
      deferCapabilityAuthority: !approvedConfigurationSnapshot
    }));
    let preflight = null;
    if (storyId) {
      validateId(definition, storyId);
      const preflightWorkType = optionString(options, 'work-type');
      const selected = await storyBaseForRepository(root, {
        values: selectedBaseValues,
        interactive: false,
        remote: definition.git?.remote ?? 'origin',
        defaultBranch: definition.defaultBaseBranch,
        stateBranch: definition.ledger?.branch,
        capabilityId: optionString(options, 'capability'),
        configurationSnapshot: approvedConfigurationSnapshot,
        ...(catalog ? { catalog } : {})
      });
      if (selectedBaseOnly) catalog = selected;
      let legacyBaseConfigurationCommit = null;
      let legacyCapabilityEvidence = null;
      if (!approvedConfigurationSnapshot) {
        const fetchAuthority = configuredRemoteAuthority(root, selected.remote, {
          direction: 'fetch'
        });
        if (!fetchAuthority.url) {
          throw new SingularityFlowError(
            `Story remote '${selected.remote}' has no credential-free fetch authority. Nothing was changed.`,
            { code: 'STORY_REMOTE_UNREACHABLE' }
          );
        }
        await fetchRemote(root, selected.remote, {
          transportRemote: fetchAuthority.url, branches: [selected.localBase], respectPartialClone: true
        });
        const selectedBaseRef = `refs/remotes/${selected.remote}/${selected.localBase}`;
        if (!refExists(root, selectedBaseRef)) {
          throw new SingularityFlowError(
            `Selected base branch '${selected.localBase}' is no longer published by remote '${selected.remote}'. Nothing was changed.`,
            { code: 'STORY_BASE_INVALID' }
          );
        }
        legacyBaseConfigurationCommit = refHead(root, selectedBaseRef);
        const selectedBaseConfiguration = await loadLegacyStoryBaseContext(root, {
          remote: selected.remote,
          baseBranch: selected.localBase,
          baseCommit: legacyBaseConfigurationCommit,
          capabilityId: selected.capability
        });
        definition = selectedBaseConfiguration.definition;
        legacyCapabilityEvidence = selectedBaseConfiguration.capabilityEvidence;
        if (selected.scope === 'capability') {
          assertApprovedCapabilityRepositoryPlan(
            selected.plan.repositories,
            legacyCapabilityEvidence?.capability,
            null,
            { portfolio: legacyCapabilityEvidence?.portfolio ?? null }
          );
        }
        validateId(definition, storyId);
        // Do not throw on a workflow selected from the launch checkout. The exact selected base
        // may intentionally carry a different catalog. Return that catalog with a blocked
        // readiness result so non-interactive surfaces can replace their choices and let the
        // user select one valid for this base without mutating anything.
        if (intake) {
          packagedCatalog = await optionalWorkflowCatalog(
            () => workflowCatalogForDefinition(definition)
          );
          intake = {
            ...intake,
            storyWorkflows: Object.entries(definition.workTypes).map(([id, workflow]) => ({
              id, label: workflow.label ?? id, description: workflow.description ?? '',
              phases: workflow.phases ?? [], references: workflow.references?.mode ?? 'optional',
              governs: 'story', installed: true,
              ...workflowCodeGeneration(resolveWorkType(definition, id)),
              // Where its documents may be kept, so Start Work offers only what the policy allows.
              documentStorage: documentStorageChoices(resolveWorkType(definition, id).documents)
            })),
            availableStoryWorkflows: packagedCatalog.workflows
              .filter((workflow) => workflow.installed === false)
              .map((workflow) => ({
                id: workflow.id, label: workflow.label ?? workflow.id,
                description: workflow.description ?? '', phases: workflow.phases ?? [],
                references: workflow.references?.mode ?? 'optional', governs: 'story',
                installed: false, status: workflow.status,
                generatesCode: workflow.generatesCode, codePhases: workflow.codePhases
              })),
            workflowCatalogReason: packagedCatalog.reason
          };
        }
      }
      const publishRequired = (definition.git?.publish ?? 'required') !== 'off';
      const repositories = await measureCommandSpan('intake.preflight.repositories', () => preflightStoryRepositories(
        selected.workspaceRoot, selected.plan, storyId,
        {
          remote: selected.remote,
          publishRequired,
          lifecycleRoot: root,
          capabilityId: selected.capability,
          configurationSnapshot: approvedConfigurationSnapshot,
          capabilityEvidence: legacyCapabilityEvidence,
          observedTips: originTips,
          previewOnly: true
        }
      ));
      if (legacyBaseConfigurationCommit) {
        const observedCommit = refHead(
          root, `refs/remotes/${selected.remote}/${selected.localBase}`
        );
        if (observedCommit !== legacyBaseConfigurationCommit) {
          throw new SingularityFlowError(
            `Selected base '${selected.localBase}' moved while its workflow policy was being checked. Refresh Story intake and retry; nothing was changed.`,
            {
              code: 'STORY_BASE_INVALID',
              details: {
                baseBranch: selected.localBase,
                policyCommit: legacyBaseConfigurationCommit,
                observedCommit
              }
            }
          );
        }
      }
      // When there is no approved sflow/config authority, this command is using the legacy
      // branch-local definition. Prove that the exact freshly fetched base selected above carries
      // that definition too. Otherwise the editor could show a green preflight from main's local
      // workflow even though Story start would cut a branch that immediately loses governance.
      if (!approvedConfigurationSnapshot) {
        assertBaseCarriesGovernance(root, {
          config: definition,
          branchName: storyId,
          base: selected.localBase,
          remote: selected.remote,
          currentBranch: branch(root),
          configurationRemote: null,
          // This is a new-Story preview of the selected base. A stale local branch with the same
          // name cannot substitute for governance on that exact remote base.
          allowExistingStoryBranch: false
        });
      }
      const repositoryReadiness = await measureCommandSpan('intake.preflight.readiness', () => collectRepositoryReadinessEvidence(
        repositories.map((entry) => ({
          id: entry.repository, root: entry.root, baseCommit: entry.baseCommit
        })),
        { scope: requiredRepositoryReadinessScope(definition), advisory: !repositoryReadinessRequired(definition),
          testRuntime: definition.repositoryReadiness?.testRuntime }
      ));
      let readiness = inspectStoryStartReadiness({
        workId: storyId,
        definition,
        configurationSnapshot: approvedConfigurationSnapshot,
        workType: preflightWorkType,
        capabilityId: selected.capability,
        baseBranch: selected.localBase,
        repositories: repositories.map((entry) => ({
          id: entry.repository,
          baseBranch: entry.baseBranch,
          baseCommit: entry.baseCommit,
          destinationRef: entry.destinationRef,
          publishRequired: entry.publishRequired
        })),
        repositoryReadiness,
        readinessBaseline: optionString(options, 'readiness-baseline', 'reuse'),
        publicationRequired: publishRequired,
        publicationVerified: !publishRequired,
        surface: 'vscode-preflight'
      });
      const testRecovery = await measureCommandSpan('intake.preflight.test-policy', () => prepareTestRecoveryIntake(root, {
        definition, workId: storyId, workType: preflightWorkType,
        isolatedWorktree: optionBoolean(options, 'isolated-worktree'),
        repositories: repositories.map(entry => ({ id: entry.repository, baseCommit: entry.baseCommit })),
        repositoryReadiness, choices: testRecoveryChoices(options),
        phaseDefinitions: definition.workTypes?.[preflightWorkType]
          ? testRecoveryIntakePhases(definition, preflightWorkType,
            approvedConfigurationSnapshot, selected.capability, legacyCapabilityEvidence) : []
      }));
      readiness = applyTestRecoveryAdmission(readiness, testRecovery);
      const receiptReferences = optionBoolean(options, 'mint-intake-receipt')
        ? parseReferenceRepositoryOptions(
          optionStrings(options, 'reference-repository'), optionStrings(options, 'reference-branch')
        ) : [];
      preflight = {
        passed: readiness.ready,
        storyBranch: storyId,
        remote: selected.remote,
        destinationRef: `refs/heads/${storyId}`,
        repositories: repositories.map((entry) => ({
          repository: entry.repository,
          remote: entry.remote,
          baseBranch: entry.baseBranch,
          baseCommit: entry.baseCommit,
          destinationRef: entry.destinationRef,
          publishRequired: entry.publishRequired
        })),
        readiness,
        testRecovery,
        testReadiness: preflightTestReadiness(repositories.map((entry) => ({
          id: entry.repository, baseCommit: entry.baseCommit
        })), repositoryReadiness),
        ...(optionBoolean(options, 'mint-intake-receipt') ? {
          intakeReceipt: await intakeReceiptForPreflight(root, {
            passed: readiness.ready === true, storyId, workType: preflightWorkType,
            capabilityOption: optionString(options, 'capability') ?? null,
            repositories, snapshot: approvedConfigurationSnapshot, definition,
            references: receiptReferences,
            readinessBaseline: optionString(options, 'readiness-baseline', 'reuse'),
            testExecutionMode: optionString(options, 'test-execution-mode', 'changed-and-affected'),
            qualityGateMode: normalizeQualityGateMode(optionString(options, 'gate-mode', 'hard'))
          })
        } : {})
      };
    }
    const result = {
      resultType: 'capability-branches',
      schemaVersion: 2,
      choicesComplete: !selectedBaseOnly,
      scope: catalog.scope,
      selectionRequired: true,
      remote: catalog.remote,
      capability: catalog.capability,
      repositories: catalog.repositories.map((repository) => ({
        id: repository.id, defaultBranch: repository.defaultBranch
      })),
      // Reported rather than thrown: the editor should render the branches it does know about and
      // say which repositories it could not reach, not show an empty list or an error dialog.
      unreachable: catalog.unreachable,
      choices: catalog.choices,
      // Full catalogs explain known orphan exclusions. Initial intake deliberately defers local
      // history reads; names alone are not evidence that a base is ready for Story creation.
      orphaned: catalog.orphaned ?? {},
      ...(catalog.localMetadata ? { localMetadata: catalog.localMetadata } : {}),
      preflight,
      ...(existingWorkId ? { existingWork: await intakeExistingWork(root, existingWorkId, catalog) } : {}),
      ...(intake ? { intake: {
        ...intake,
        // With approved shared configuration the workflows are the same whichever base is chosen,
        // so no base-only readiness request is needed to learn them. A legacy repository's
        // workflows come from the chosen base itself.
        workflowCatalogScope: approvedConfigurationSnapshot ? 'approved-configuration' : 'selected-base'
      } } : {})
    };
    return result;
    // The catalog and its readiness preview are advisory: Story start observes authority again and
    // recomputes readiness before it mutates anything. One authority listing therefore serves both
    // the selection and the cached read of that exact revision.
  }, {
    preferAuthority: true, useObjectCache: true, reuseAuthorityObservation: true,
    authoritySession: intakeSession
  });
  
}

/** Reuse this catalog's observations. Unread repositories mean unknown, never a new ID. */
async function intakeExistingWork(root, workId, catalog) {
  const localRef = `refs/heads/${workId}`;
  let local = null;
  if (refExists(root, localRef)) {
    if (await durableLocalStoryOnBranch(root, workId, workId)) local = 'story';
    else if (fileAtRef(root, localRef, posix(path.join('singularity', 'seeds', `${workId}.yml`))) !== null) local = 'seed';
    else local = 'ungoverned';
  }
  const unread = new Set((catalog.unreachable ?? []).map((entry) => entry.repository));
  const publishedBy = (catalog.repositories ?? [])
    .filter((repository) => !unread.has(repository.id)
      && (catalog.published?.[repository.id] ?? []).includes(workId))
    .map((repository) => repository.id);
  const status = local === 'story' ? 'local-story'
    : local === 'seed' ? 'local-seed'
      : local === 'ungoverned' ? 'local-conflict'
        : publishedBy.length ? 'published'
          : unread.size ? 'unknown' : 'new';
  return { workId, status, localBranch: local !== null, publishedBy, unreadRepositories: [...unread].sort() };
}

/** Optional private bearer receipt for a request start can freshly verify in one wave.
 * Platform/store qualification belongs to mintStoryIntakeReceipt; failure keeps full validation.
 */
async function intakeReceiptForPreflight(root, {
  passed, storyId, workType, capabilityOption, repositories, snapshot, definition, references,
  readinessBaseline = 'reuse', testExecutionMode = 'changed-and-affected', qualityGateMode = 'hard'
}) {
  const declined = (reason) => ({ issued: false, reason });
  if (storyIntakeReceiptsDisabled()) return declined('disabled');
  if (!passed) return declined('not-ready');
  if (!workType) return declined('work-type');
  if (snapshot?.authority?.branch !== CONFIGURATION_BRANCH) return declined('configuration');
  if (repositories.length !== 1) return declined('capability');
  const [entry] = repositories;
  if (gitCommonDir(entry.root) !== gitCommonDir(root)) return declined('repository');
  const fetch = configuredRemoteAuthority(root, entry.remote, { direction: 'fetch' });
  if (!fetch.url) return declined('repository');
  const stateAuthority = worldModelStateAuthority(definition ?? {});
  const minted = await mintStoryIntakeReceipt(root, {
    inputs: {
      workId: storyId, workType, baseBranch: entry.baseBranch, remote: entry.remote,
      // The option as given, which start's launch sees too; a capability the workspace implies
      // is re-derived by the start itself, and its repository is bound by the checks below.
      capabilityId: capabilityOption,
      readinessBaseline,
      testExecutionMode,
      qualityGateMode,
      references: references.map((request) => ({
        id: request.id, url: request.repository, branch: request.requestedBranch
      }))
    },
    authority: {
      remote: snapshot.authority.remote, branch: snapshot.authority.branch,
      commit: snapshot.authority.commit, sourceCommit: snapshot.sourceCommit ?? null
    },
    repositories: [{
      id: entry.repository, remote: entry.remote, baseBranch: entry.baseBranch,
      baseCommit: entry.baseCommit, destinationRef: entry.destinationRef,
      fetch: { url: fetch.url, fingerprint: fetch.fingerprint },
      push: entry.publishRequired
        ? { url: entry.transportRemote, fingerprint: entry.remoteFingerprint } : null,
      state: stateAuthority.remote === entry.remote ? {
        branch: stateAuthority.branch,
        commit: refHead(root, `refs/remotes/${entry.remote}/${stateAuthority.branch}`)
      } : null
    }]
  }).catch(() => null);
  // Receipt storage is a best-effort optimization, never a new Story-start prerequisite. In
  // particular an unqualified Windows ACL or unavailable system tool leaves full validation on.
  if (!minted) return declined('storage');
  return { issued: true, id: minted.id, expiresAt: minted.expiresAt };
}

function intakePortfolioChoices(portfolio) {
  const authorities = Object.values(portfolio?.approvalAuthorities ?? {});
  return {
    profiles: initiativeProfileChoices(portfolio),
    profileReason: null,
    approvalAuthorityMissing: authorities.length > 0
      && !authorities.some((authority) => (authority?.members ?? []).length)
  };
}

function initiativeProfileChoices(portfolio) {
  return Object.entries(portfolio.initiativeProfiles).map(([id, profile]) => ({
    id,
    label: profile.label ?? id,
    description: `${profile.phases.length} phases`,
    // The phases themselves, not only how many. Which phases a profile runs is the entire
    // difference between two profiles, and a count cannot be compared against anything.
    phases: [...profile.phases]
  }));
}

export function renderWorkspaceBranches(result) {
  console.log(result.scope === 'capability'
    ? `Base branches for capability '${result.capability}' (${result.repositories.length} repositories):`
    : `Base branches for repository '${result.repositories[0]?.id ?? 'repository'}' on '${result.remote}':`);
  for (const choice of result.choices) {
    console.log(`  ${choice.branch.padEnd(28)} ${choice.everywhere ? `all ${choice.total}` : `${choice.present} of ${choice.total}`}`
      + (choice.missingFrom.length ? ` — missing from ${choice.missingFrom.join(', ')}` : '')
      + (choice.story ? ` — Story ${choice.story.workId}: ${choice.story.title}` : ''));
  }
  const orphanNames = [...new Set(Object.values(result.orphaned).flat())].sort();
  if (orphanNames.length) console.log(`Not offered, because they share no history with the default branch: ${orphanNames.join(', ')}`);
  for (const entry of result.unreachable) console.warn(`Warning: could not read ${entry.repository} (${entry.url || result.remote}).`);
  return result;
}

