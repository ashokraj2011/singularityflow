import * as vscode from 'vscode';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { phaseArtifactsBody, PHASE_ARTIFACTS_SCRIPT, PHASE_ARTIFACTS_STYLE,
  type ArtifactVersion, type PhaseArtifactCatalog } from './phase-artifacts-page.ts';

export function showPhaseArtifacts(catalog: PhaseArtifactCatalog,
  onOpen: (id: string, version: ArtifactVersion) => Promise<void>, onRefresh: () => void): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('singularityFlow.artifacts', `Artifacts · ${catalog.workId}`,
    vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
  let selected = catalog.phases.find(item => item.id === catalog.currentPhase)?.id ?? catalog.phases[0]?.id ?? '';
  let version: ArtifactVersion = 'draft';
  const render = (): void => {
    const token = nonce();
    panel.webview.html = page('Artifacts', `<style nonce="${token}">${PHASE_ARTIFACTS_STYLE}</style>`
      + phaseArtifactsBody(catalog, selected, version), contentSecurityPolicy(panel.webview, token), token, PHASE_ARTIFACTS_SCRIPT);
  };
  const router = registerMessageRouter('singularityFlow.artifacts', {
    navigate: raw => { const target = navigationTarget(raw); if (target) void navigateTo(target); },
    phase: raw => { const id = stringField(raw, 'id'); if (catalog.phases.some(item => item.id === id)) { selected = id!; render(); } },
    version: raw => { const value = stringField(raw, 'version'); if (value === 'draft' || value === 'approved') { version = value; render(); } },
    open: async raw => {
      const id = stringField(raw, 'id');
      const phase = catalog.phases.find(item => item.id === selected);
      if (id && phase?.artifacts.some(item => item.id === id) && (version === 'draft' || phase.approved)) await onOpen(id, version);
    },
    refresh: onRefresh
  });
  const messages = panel.webview.onDidReceiveMessage(raw => router.route(raw));
  panel.onDidDispose(() => messages.dispose());
  render();
  return panel;
}
