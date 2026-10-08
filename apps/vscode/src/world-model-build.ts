import { showCompactWarningMessage } from "./compact-message.ts";
/**
 * Native exact-confirm World Model build flow.
 *
 * Ordinary editor reads keep using the activation-long read-only gateway. A World Model build gets
 * a new, short-lived writable gateway only after a person opens this command for registered-v4.
 * Its exact Plan remains the authority; no route runs a model during configuration reads.
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

import { createHostGateway } from '../../../src/gateway/host.mjs';
import {
  configuredWorldModelV4ViewSelections, worldModelV4GatewayDefaults
} from '../../../src/world-model/commands.mjs';
import { loadWorldModelConfig } from '../../../src/worldmodel.mjs';
import { assertRegisteredWorldModel } from '../../../src/world-model-format.mjs';
import { worldModelGatewayCapabilities } from '../../../src/gateway/planners/world-model-run.mjs';
import { DEFAULT_GATEWAY_POLICY } from '../../../src/gateway/policy.mjs';
import { withApprovedConfigurationRead } from '../../../src/approved-configuration-reader.mjs';
import { editorPlanners, type ActiveRepositoryContext } from './gateway-session.ts';
import { hasConfiguredGitRemote } from './cli/git-observations.ts';
import {
  assertWorldModelBuildConfigurationSelection,
  exactWorldModelPlanDetail,
  loadScopedWorldModelBuildConfig, runExactWorldModelBuild,
  observeWorldModelBuildConfigurationSelection,
  worldModelAuthorityRefreshArguments, worldModelBuildCompletionMessage,
  withWorldModelBuildConfigurationBoundary, worldModelBuildConfigurationBoundary,
  type ExactBuildKernel, type ExactWorldModelBuildOutcome,
  type WorldModelBuildArguments, type WorldModelBuildConfigurationSelection
} from './world-model-build-model.ts';

export {
  exactWorldModelPlanDetail,
  loadScopedWorldModelBuildConfig, runExactWorldModelBuild,
  observeWorldModelBuildConfigurationSelection,
  worldModelAuthorityRefreshArguments, worldModelBuildCompletionMessage,
  withWorldModelBuildConfigurationBoundary, worldModelBuildConfigurationBoundary,
  type ExactWorldModelBuildOutcome, type WorldModelBuildArguments
} from './world-model-build-model.ts';

function firstChoice<T extends string>(configured: T, values: readonly T[]): readonly T[] {
  return [configured, ...values.filter((value) => value !== configured)];
}

async function collectArguments(
  config: any, defaults: Readonly<Record<string, any>>, { rebuild = false }: { rebuild?: boolean } = {}
): Promise<WorldModelBuildArguments | null> {
  const configuredViews = configuredWorldModelV4ViewSelections(config);
  const selectedViews = await vscode.window.showQuickPick(
    configuredViews.map((view) => ({
      label: view.reference,
      description: `Installed registered contract · ${view.viewId}`,
      picked: true
    })),
    {
      title: rebuild ? 'Rebuild World Model · registered views' : 'World Model · exact governed build',
      placeHolder: 'Choose the approved registered views to build and publish',
      canPickMany: true,
      ignoreFocusOut: true
    }
  );
  if (!selectedViews?.length) return null;

  const depth = await vscode.window.showQuickPick(
    firstChoice(defaults.depth ?? 'standard', ['quick', 'standard', 'deep'] as const)
      .map((value) => ({
        label: value === 'quick' ? 'Quick' : value === 'standard' ? 'Standard' : 'Deep',
        description: value === 'quick' ? 'Compact analysis' : value === 'standard'
          ? 'Balanced analysis' : 'Broadest registered analysis; slower and potentially costlier',
        value
      })),
    { title: 'World Model complexity for this capability', placeHolder: 'Choose Quick, Standard, or Deep', ignoreFocusOut: true }
  );
  if (!depth) return null;
  const composer = await vscode.window.showQuickPick(
    firstChoice(defaults.composer ?? 'deterministic', ['deterministic', 'auto', 'model'] as const)
      .map((value) => ({
        label: value,
        description: value === 'deterministic' ? 'No model invocation' : value === 'auto' ? 'Use a model only when the view contract allows it' : 'Require model composition',
        value
      })),
    { title: 'World Model composer', placeHolder: 'Choose how registered facts are composed', ignoreFocusOut: true }
  );
  if (!composer) return null;

  return {
    views: selectedViews.map((entry) => entry.label).sort(),
    depth: depth.value,
    consumer: defaults.consumer ?? 'developer',
    composer: composer.value,
    cachePolicy: rebuild ? 'rebuild' : defaults.cachePolicy ?? 'reuse-valid'
  };
}

/** Open the complete native UI flow for the currently validated repository. */
export async function showGovernedWorldModelBuild(
  active: ActiveRepositoryContext,
  {
    modelRouting = 'enabled', capabilityId: preferredCapabilityId = null, rebuild = false
  }: {
    modelRouting?: 'enabled' | 'disabled'; capabilityId?: string | null; rebuild?: boolean;
  } = {}
): Promise<ExactWorldModelBuildOutcome> {
  const selection = await observeWorldModelBuildConfigurationSelection(active.root);
  return withWorldModelBuildConfigurationBoundary(selection.boundary, {
    readStoryPinned: () => showGovernedWorldModelBuildInConfigurationScope(active, {
      modelRouting, capabilityId: preferredCapabilityId, rebuild
    }, selection),
    withApprovedAuthority: (read) => withApprovedConfigurationRead(
      active.root, read, { preferAuthority: true }
    ),
    readInScope: () => showGovernedWorldModelBuildInConfigurationScope(active, {
      modelRouting, capabilityId: preferredCapabilityId, rebuild
    }, selection)
  });
}

async function showGovernedWorldModelBuildInConfigurationScope(
  active: ActiveRepositoryContext,
  {
    modelRouting, capabilityId: preferredCapabilityId, rebuild
  }: {
    modelRouting: 'enabled' | 'disabled'; capabilityId: string | null; rebuild: boolean;
  },
  configurationSelection: WorldModelBuildConfigurationSelection
): Promise<ExactWorldModelBuildOutcome> {
  // The canonical loader resolves the approved configuration overlay/state authority for this
  // exact root; it never searches HOME or borrows context from a previous editor conversation.
  const scoped = await loadScopedWorldModelBuildConfig(
    (capabilityId) => loadWorldModelConfig(active.root, {
      ...(capabilityId ? { capabilityId } : {}),
      ...(configurationSelection.workId ? { workId: configurationSelection.workId } : {})
    }),
    async (capabilityIds) => {
      const selected = await vscode.window.showQuickPick(
        capabilityIds.map((id) => ({
          label: id,
          description: 'Approved delivery capability',
          id
        })),
        {
          title: 'World Model capability scope',
          placeHolder: 'Choose the capability this reusable repository model represents',
          canPickMany: false,
          ignoreFocusOut: true
        }
      );
      return selected?.id ?? null;
    },
    preferredCapabilityId
  );
  if (!scoped) return { status: 'cancelled', planned: null, result: null };
  const { config, capabilityId } = scoped;
  // A Story pinned to the removed legacy-v3 World Model cannot build one.
  assertRegisteredWorldModel(config.definition);
  const defaults = worldModelV4GatewayDefaults(active.root, config);
  if (rebuild && !await hasConfiguredGitRemote(active.root, defaults.ledgerConfig.remote)) {
    throw Object.assign(new Error(
      `The governed Git remote '${defaults.ledgerConfig.remote}' is not configured. Rebuild requires publication to Git; restore the remote and retry.`
    ), { code: 'WMB_STATE_REMOTE_REQUIRED' });
  }
  const args = await collectArguments(config, defaults, { rebuild });
  if (!args) return { status: 'cancelled', planned: null, result: null, capabilityId };
  await assertWorldModelBuildConfigurationSelection(active.root, configurationSelection);

  const capabilities = worldModelGatewayCapabilities({ defaults });
  const host = createHostGateway({
    root: active.root,
    workspaceId: active.workspaceId,
    hostSessionId: `vscode_wmb_${randomUUID()}`,
    planners: editorPlanners(),
    planBuilders: capabilities.planBuilders,
    mutationExecutors: capabilities.mutationExecutors,
    readOnly: false,
    ...(modelRouting === 'disabled' ? {
      policyLayers: [DEFAULT_GATEWAY_POLICY, {
        layer: 'host-capability', modelRouting: 'disabled', confirmation: {}, denied: []
      }]
    } : {})
  });

  const outcome = await runExactWorldModelBuild(host.kernel as ExactBuildKernel, args, async (review) => {
    const action = rebuild ? 'Rebuild & push exact Plan' : 'Build & publish exact Plan';
    const accepted = await showCompactWarningMessage(
      rebuild
        ? 'Rebuild this capability World Model at the selected complexity and push it to the governed Git state branch?'
        : 'Run this exact World Model build and atomically publish it to the governed state branch?',
      { modal: true, detail: exactWorldModelPlanDetail(review, { capabilityId }) },
      action
    );
    if (accepted !== action) return false;
    await assertWorldModelBuildConfigurationSelection(active.root, configurationSelection);
    return true;
  }, (operation) => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Building and publishing the exact World Model Plan',
    cancellable: false
  }, operation));
  return { ...outcome, capabilityId };
}
