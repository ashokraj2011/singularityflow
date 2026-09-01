/**
 * Native exact-confirm World Model build flow.
 *
 * Ordinary editor reads keep using the activation-long read-only gateway. A World Model build gets
 * a new, short-lived writable gateway only after a person opens this command. Planning is
 * deterministic and provider-free; the model/build/publication boundary is crossed only after the
 * exact request, Plan and state target have been shown in a modal confirmation.
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

import { createHostGateway } from '../../../src/gateway/host.mjs';
import { loadConfig } from '../../../src/state-stores.mjs';
import {
  configuredWorldModelV4ViewIds, worldModelV4GatewayDefaults
} from '../../../src/world-model/commands.mjs';
import { worldModelGatewayCapabilities } from '../../../src/gateway/planners/world-model-run.mjs';
import { DEFAULT_GATEWAY_POLICY } from '../../../src/gateway/policy.mjs';
import { editorPlanners, type ActiveRepositoryContext } from './gateway-session.ts';
import {
  exactWorldModelPlanDetail, runExactWorldModelBuild,
  type ExactBuildKernel, type ExactWorldModelBuildOutcome, type WorldModelBuildArguments
} from './world-model-build-model.ts';

export {
  exactWorldModelPlanDetail, runExactWorldModelBuild,
  type ExactWorldModelBuildOutcome, type WorldModelBuildArguments
} from './world-model-build-model.ts';

function firstChoice<T extends string>(configured: T, values: readonly T[]): readonly T[] {
  return [configured, ...values.filter((value) => value !== configured)];
}

async function collectArguments(config: any, defaults: Readonly<Record<string, any>>): Promise<WorldModelBuildArguments | null> {
  const configuredViews = configuredWorldModelV4ViewIds(config);
  const selectedViews = await vscode.window.showQuickPick(
    configuredViews.map((view) => ({ label: view, picked: true })),
    {
      title: 'World Model · exact governed build',
      placeHolder: 'Choose the approved registered views to build and publish',
      canPickMany: true,
      ignoreFocusOut: true
    }
  );
  if (!selectedViews?.length) return null;

  const depth = await vscode.window.showQuickPick(
    firstChoice(defaults.depth ?? 'standard', ['quick', 'standard', 'deep'] as const)
      .map((value) => ({ label: value, value })),
    { title: 'World Model depth', placeHolder: 'Choose the bounded build depth', ignoreFocusOut: true }
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
    cachePolicy: defaults.cachePolicy ?? 'reuse-valid'
  };
}

/** Open the complete native UI flow for the currently validated repository. */
export async function showGovernedWorldModelBuild(
  active: ActiveRepositoryContext,
  { modelRouting = 'enabled' }: { modelRouting?: 'enabled' | 'disabled' } = {}
): Promise<ExactWorldModelBuildOutcome> {
  // loadConfig resolves the approved configuration overlay/state authority for this exact root; it
  // never searches HOME or borrows repository context from a previous editor conversation.
  const config = await loadConfig(active.root);
  const defaults = worldModelV4GatewayDefaults(active.root, config);
  const args = await collectArguments(config, defaults);
  if (!args) return { status: 'cancelled', planned: null, result: null };

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

  return runExactWorldModelBuild(host.kernel as ExactBuildKernel, args, async (review) => {
    const action = 'Build & publish exact Plan';
    const accepted = await vscode.window.showWarningMessage(
      'Run this exact World Model build and atomically publish it to the governed state branch?',
      { modal: true, detail: exactWorldModelPlanDetail(review) },
      action
    );
    return accepted === action;
  }, (operation) => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Building and publishing the exact World Model Plan',
    cancellable: false
  }, operation));
}
