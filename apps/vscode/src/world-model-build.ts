/**
 * Native exact-confirm World Model build flow.
 *
 * Ordinary editor reads keep using the activation-long read-only gateway. A World Model build gets
 * a new, short-lived writable gateway only after a person opens this command for registered-v4.
 * Its exact Plan remains the v4 authority. Legacy-v3 uses a separate, deterministic state-only
 * CLI action after an exact modal review; neither route runs a model during configuration reads.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';

import { createHostGateway } from '../../../src/gateway/host.mjs';
import {
  configuredWorldModelV4ViewSelections, isWorldModelV4, worldModelV4GatewayDefaults
} from '../../../src/world-model/commands.mjs';
import { loadWorldModelConfig, resolveWorldModelViewIds } from '../../../src/worldmodel.mjs';
import { worldModelSourceSnapshot } from '../../../src/grounding.mjs';
import { worldModelGatewayCapabilities } from '../../../src/gateway/planners/world-model-run.mjs';
import { DEFAULT_GATEWAY_POLICY } from '../../../src/gateway/policy.mjs';
import { editorPlanners, type ActiveRepositoryContext } from './gateway-session.ts';
import {
  exactWorldModelPlanDetail, legacyWorldModelLightArguments, legacyWorldModelLightDetail,
  loadScopedWorldModelBuildConfig, runExactWorldModelBuild,
  worldModelAuthorityRefreshArguments,
  type ExactBuildKernel, type ExactWorldModelBuildOutcome, type WorldModelBuildArguments
} from './world-model-build-model.ts';

export {
  exactWorldModelPlanDetail, legacyWorldModelLightArguments, legacyWorldModelLightDetail,
  loadScopedWorldModelBuildConfig, runExactWorldModelBuild,
  worldModelAuthorityRefreshArguments,
  type ExactWorldModelBuildOutcome, type WorldModelBuildArguments
} from './world-model-build-model.ts';

function firstChoice<T extends string>(configured: T, values: readonly T[]): readonly T[] {
  return [configured, ...values.filter((value) => value !== configured)];
}

async function collectArguments(config: any, defaults: Readonly<Record<string, any>>): Promise<WorldModelBuildArguments | null> {
  const configuredViews = configuredWorldModelV4ViewSelections(config);
  const selectedViews = await vscode.window.showQuickPick(
    configuredViews.map((view) => ({
      label: view.reference,
      description: `Installed registered contract · ${view.viewId}`,
      picked: true
    })),
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
  {
    modelRouting = 'enabled', capabilityId: preferredCapabilityId = null, executeLegacyLight
  }: {
    modelRouting?: 'enabled' | 'disabled'; capabilityId?: string | null;
    executeLegacyLight?: (argv: readonly string[], signal: AbortSignal) => Promise<void>;
  } = {}
): Promise<ExactWorldModelBuildOutcome> {
  // The canonical loader resolves the approved configuration overlay/state authority for this
  // exact root; it never searches HOME or borrows context from a previous editor conversation.
  const scoped = await loadScopedWorldModelBuildConfig(
    (capabilityId) => loadWorldModelConfig(active.root, capabilityId ? { capabilityId } : undefined),
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
  if (!isWorldModelV4(config)) {
    if (!executeLegacyLight) throw new Error('No governed legacy World Model executor is configured.');
    if (config.materialization?.publish !== 'governed') {
      throw Object.assign(new Error('Legacy Build / refresh requires governed state publication. Review and publish the World Model materialization policy first.'), {
        code: 'WMB_STATE_PUBLICATION_REQUIRED'
      });
    }
    const remote = String(config.remote ?? 'origin');
    const stateBranch = String(config.stateBranch ?? 'state');
    try {
      execFileSync('git', ['remote', 'get-url', remote], { cwd: active.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      throw Object.assign(new Error(`The configured World Model remote '${remote}' is not available. Restore the governed remote before Build / refresh.`), {
        code: 'WMB_STATE_REMOTE_REQUIRED'
      });
    }
    const git = (...argv: string[]) => execFileSync('git', argv, {
      cwd: active.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    const sourceCommit = git('rev-parse', 'HEAD');
    const source = await worldModelSourceSnapshot(active.root, config.definition);
    const views = resolveWorldModelViewIds(config, ['all']);
    const reviewIdentity = JSON.stringify({
      repository: active.root, workspace: active.workspaceId, branch, sourceCommit,
      sourceTreeSha256: source.sha256, definition: config.definition,
      workflow: config.workflow, repositoryCapability: config.repositoryCapability,
      remote, stateBranch
    });
    const detail = legacyWorldModelLightDetail({
      repository: active.root, branch, sourceCommit, sourceTreeSha256: source.sha256,
      views, remote, stateBranch, outputDir: config.outputDir,
      capabilityId
    });
    const accepted = await vscode.window.showWarningMessage(
      'Build the current legacy-v3 World Model deterministically and publish only to governed state?',
      { modal: true, detail }, 'Build deterministic legacy model'
    );
    if (accepted !== 'Build deterministic legacy model') {
      return { status: 'cancelled', planned: null, result: null, capabilityId, format: 'legacy-v3' };
    }
    // A modal can stay open while the Story pin, source, or selected repository changes. Repeat
    // the same canonical reads immediately before dispatch; the engine rechecks the source hash.
    const latest = await loadWorldModelConfig(active.root,
      capabilityId ? { capabilityId } : undefined);
    const latestSource = await worldModelSourceSnapshot(active.root, latest.definition);
    const latestIdentity = JSON.stringify({
      repository: active.root, workspace: active.workspaceId,
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'), sourceCommit: git('rev-parse', 'HEAD'),
      sourceTreeSha256: latestSource.sha256, definition: latest.definition,
      workflow: latest.workflow, repositoryCapability: latest.repositoryCapability,
      remote: String(latest.remote ?? 'origin'), stateBranch: String(latest.stateBranch ?? 'state')
    });
    if (reviewIdentity !== latestIdentity) {
      throw Object.assign(new Error('World Model source, Story pin, or approved configuration changed during review. Reopen Build / refresh.'), {
        code: 'WMB_REVIEW_STALE'
      });
    }
    const argv = legacyWorldModelLightArguments(capabilityId, source.sha256);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Building deterministic legacy World Model into governed state',
      cancellable: true
    }, async (_progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested?.(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try { await executeLegacyLight(argv, controller.signal); }
      finally { cancellation?.dispose(); }
    });
    return { status: 'completed', planned: null, result: null, capabilityId, format: 'legacy-v3' };
  }
  const defaults = worldModelV4GatewayDefaults(active.root, config);
  const args = await collectArguments(config, defaults);
  if (!args) return { status: 'cancelled', planned: null, result: null, capabilityId };

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
    const action = 'Build & publish exact Plan';
    const accepted = await vscode.window.showWarningMessage(
      'Run this exact World Model build and atomically publish it to the governed state branch?',
      { modal: true, detail: exactWorldModelPlanDetail(review, { capabilityId }) },
      action
    );
    return accepted === action;
  }, (operation) => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Building and publishing the exact World Model Plan',
    cancellable: false
  }, operation));
  return { ...outcome, capabilityId };
}
