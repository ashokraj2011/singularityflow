/** Read-only developer orientation and return experience. */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { TreeNode } from './tree-model.ts';
import { brandLockup, contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';

interface HomeChoice {
  id: string; operation: string; goalId: string; label: string; detail: string;
  target: { workspaceId?: string; repositoryId?: string; workId?: string; phase?: string | null };
  handle: string; subjectRevision: string; actor: string; hostSession: string | null;
  issuedAt: string; expiresAt: string; fallbackCommand: string; navigationTarget: string;
}
interface HomeResult {
  resultType: 'developer-home'; asOf: string; subjectRevision: string;
  actor: { name?: string; email?: string; login?: string };
  context: {
    workspace: { id: string; name: string };
    repository: { repositoryId: string; branch: string; head: string; dirty: boolean; changedFiles: string[] };
    activeStory: { id: string; phase: string; status: string } | null;
    freshness: { capturedAt: string; networkContacted: boolean };
  };
  briefing: { headline: string; counts: Record<string, number> };
  choices: HomeChoice[]; notices: string[];
}
interface ReturnResult {
  resultType: 'developer-return'; subjectRevision: string;
  context: {
    story: { id: string; title: string; canonicalBranch: string | null };
    repository: { branch: string; head: string; dirty: boolean; changedFiles: string[] };
    freshness: { capturedAt: string };
  };
  briefing: {
    headline: string;
    lifecycle: { currentPhase: string | null; approved: number; total: number; phases: Array<{
      id: string; label: string; status: string; generation: number;
      artifacts: Array<{ id: string; path: string; sha256: string | null }>;
      approvals: Array<{ decision: string; actor: unknown; agent: string | null; at: string | null; selfApproval: boolean }>;
    }> };
    pinned: Record<string, unknown>; git: { dirty: boolean; changedFiles: string[] };
    interval: unknown; recovery: { required: boolean; kind?: string }; evidenceGaps: string[];
  };
  choices: HomeChoice[]; notices: string[];
}

interface HomeAcknowledgement {
  at: string;
  subjectRevision: string;
  repositoryHead: string;
  activeStory: { id: string; phase: string; status: string } | null;
  dirty: boolean;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) vscode.postMessage({ type: action.dataset.action, id: action.dataset.id, path: action.dataset.path });
  });
`;

function actorLabel(home: HomeResult): string {
  return home.actor.name || home.actor.email || home.actor.login || 'Local Git identity';
}

function contextBanner(home: HomeResult): string {
  const repository = home.context.repository;
  return `<section class="context-banner plain"><div><span class="eyebrow">Workspace</span><strong>${escape(home.context.workspace.name)}</strong></div>
    <div><span class="eyebrow">Repository</span><strong>${escape(repository.repositoryId)}</strong></div>
    <div><span class="eyebrow">Branch</span><strong>${escape(repository.branch)}</strong></div>
    <div><span class="eyebrow">HEAD</span><code>${escape((repository.head ?? 'unavailable').slice(0, 12))}</code></div>
    <div><span class="eyebrow">Actor</span><strong>${escape(actorLabel(home))}</strong></div>
    <div><span class="eyebrow">Freshness</span><strong>${escape(home.context.freshness.capturedAt)}</strong></div></section>`;
}

function choices(home: HomeResult): string {
  return `<section><h2>${icon('prompt')}What is on your mind today?</h2>
    <div class="home-choices">${home.choices.slice(0, 6).map((choice, index) => `<button class="home-choice${index === 0 ? ' primary-choice' : ''}" data-action="choose" data-id="${escape(choice.id)}">
      <span class="choice-number">${index + 1}</span><span><strong>${escape(choice.label)}</strong><small>${escape(choice.detail)}</small><code>${escape(choice.fallbackCommand)}</code></span>
    </button>`).join('')}</div></section>`;
}

function acknowledgedDelta(home: HomeResult, acknowledgement: HomeAcknowledgement | null): string {
  if (!acknowledgement) return '';
  if (acknowledgement.subjectRevision === home.subjectRevision) return 'No governed repository-state changes since this acknowledgement.';
  const changes: string[] = [];
  if (acknowledgement.repositoryHead !== home.context.repository.head) changes.push('repository HEAD changed');
  const before = acknowledgement.activeStory;
  const after = home.context.activeStory;
  if (before?.id !== after?.id) changes.push(after ? `active Story is now ${after.id}` : 'there is no active Story');
  else if (before && after && (before.phase !== after.phase || before.status !== after.status)) {
    changes.push(`${after.id} moved from ${before.phase} (${before.status}) to ${after.phase} (${after.status})`);
  }
  if (acknowledgement.dirty !== home.context.repository.dirty) {
    changes.push(home.context.repository.dirty ? 'local worktree now has changes' : 'local worktree is now clean');
  }
  return changes.length ? changes.join('; ') + '.' : 'Governed work inventory changed; review the refreshed choices below.';
}

function homeBody(home: HomeResult, acknowledgement: HomeAcknowledgement | null, error: string | null): string {
  const delta = acknowledgedDelta(home, acknowledgement);
  return `<header class="inbox-header">${brandLockup()}<p class="eyebrow">Developer home</p><h1>${icon('prompt', { size: 24 })}Talk to SFlow</h1>
    <p class="meta">A local, read-only briefing. Opening this page never fetches, checks out, commits, pushes, or invokes a model.</p></header>
    ${contextBanner(home)}
    ${error ? `<p class="warning-text">${icon('warning')}${escape(error)}</p>` : ''}
    <section class="plain briefing"><div><p class="eyebrow">${acknowledgement ? 'Since you last checked' : 'Current state'}</p><h2>${escape(home.briefing.headline)}</h2>${delta ? `<p class="meta">${escape(delta)}</p>` : ''}</div>
      <button class="secondary" data-action="acknowledge">${acknowledgement ? 'Update acknowledgement' : 'Mark as checked'}</button></section>
    ${choices(home)}
    ${home.notices.length ? `<section><h2>${icon('warning')}Notices</h2><ul>${home.notices.map((notice) => `<li>${escape(notice)}</li>`).join('')}</ul></section>` : ''}`;
}

function returnBody(home: HomeResult, returned: ReturnResult, error: string | null): string {
  const lifecycle = returned.briefing.lifecycle;
  return `<header class="inbox-header">${brandLockup()}<p class="eyebrow">Story return</p><h1>${icon('story', { size: 24 })}${escape(returned.context.story.id)}</h1>
    <p class="meta">${escape(returned.briefing.headline)}</p></header>${contextBanner(home)}
    ${error ? `<p class="warning-text">${icon('warning')}${escape(error)}</p>` : ''}
    <section class="plain"><div class="summary-grid"><div class="summary-card important"><strong>${lifecycle.approved}/${lifecycle.total}</strong><span>Phases approved</span></div>
      <div class="summary-card"><strong>${escape(lifecycle.currentPhase ?? 'Complete')}</strong><span>Current phase</span></div>
      <div class="summary-card"><strong>${returned.context.repository.dirty ? 'Changed' : 'Clean'}</strong><span>Local worktree</span></div>
      <div class="summary-card"><strong>${returned.briefing.recovery.required ? 'Required' : 'Clear'}</strong><span>Recovery</span></div></div></section>
    <section><h2>${icon('phase')}Lifecycle and generated artifacts</h2><div class="return-phases">${lifecycle.phases.map((phase) => `<details${phase.id === lifecycle.currentPhase ? ' open' : ''}>
      <summary><strong>${escape(phase.label)}</strong><span>${escape(phase.status)} · generation ${phase.generation}</span></summary>
      ${phase.artifacts.length ? `<div class="artifact-cards">${phase.artifacts.map((artifact) => `<button class="artifact-card" data-action="artifact" data-id="${escape(artifact.id)}" data-path="${escape(artifact.path)}"><span class="artifact-title">${icon('artifact')}${escape(artifact.id)}</span><span class="artifact-meta"><code>${escape(artifact.path)}</code>${artifact.sha256 ? ` · ${escape(artifact.sha256.slice(0, 12))}` : ''}</span></button>`).join('')}</div>` : '<p class="muted">No registered artifacts for this phase.</p>'}
      <p class="muted">${phase.approvals.length} approval decision(s)</p></details>`).join('')}</div></section>
    <section><h2>${icon('commit')}Repository return check</h2><p>${returned.context.repository.changedFiles.length ? `${returned.context.repository.changedFiles.length} local change(s):` : 'No local changes.'}</p>
      ${returned.context.repository.changedFiles.length ? `<ul>${returned.context.repository.changedFiles.map((path) => `<li><code>${escape(path)}</code></li>`).join('')}</ul>` : ''}
      ${returned.briefing.evidenceGaps.length ? `<p class="warning-text">Evidence gaps: ${escape(returned.briefing.evidenceGaps.join(', '))}</p>` : ''}</section>
    <p class="card-foot"><button class="secondary" data-action="back">Back to home</button><button data-action="refresh">Refresh briefing</button></p>`;
}

export class DeveloperHomePanel {
  private static current: DeveloperHomePanel | null = null;
  private readonly hostSession = randomUUID();
  private home: HomeResult | null = null;
  private returned: ReturnResult | null = null;
  private error: string | null = null;
  private acknowledgement: HomeAcknowledgement | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly client: SingularityFlowClient
  ) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.receive(raw);
    });
    panel.onDidDispose(() => { DeveloperHomePanel.current = null; });
    void this.refresh();
  }

  static show(context: vscode.ExtensionContext, client: SingularityFlowClient): DeveloperHomePanel {
    if (DeveloperHomePanel.current) {
      DeveloperHomePanel.current.panel.reveal(vscode.ViewColumn.Active);
      void DeveloperHomePanel.current.refresh();
      return DeveloperHomePanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.developerHome', 'Talk to SFlow', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    DeveloperHomePanel.current = new DeveloperHomePanel(panel, context, client);
    return DeveloperHomePanel.current;
  }

  private acknowledgementKey(home: HomeResult): string {
    return `developerHome.ack.${home.context.workspace.id}.${home.choices[0]?.actor ?? 'unknown'}`;
  }

  private async refresh(): Promise<void> {
    try {
      this.home = await this.client.run<HomeResult>(['home', '--json', '--host-session', this.hostSession]);
      this.acknowledgement = this.context.globalState.get<HomeAcknowledgement>(this.acknowledgementKey(this.home)) ?? null;
      if (this.returned) {
        const id = this.returned.context.story.id;
        this.returned = await this.client.run<ReturnResult>(['story', 'return', id, '--json', '--host-session', this.hostSession]);
      }
      this.error = null;
    } catch (error) { this.error = (error as Error).message; }
    this.render();
  }

  private async revalidate(original: HomeChoice): Promise<HomeChoice> {
    if (Date.parse(original.expiresAt) <= Date.now()) throw new Error('This choice expired. Refresh and choose again.');
    const fresh = await this.client.run<HomeResult>(['home', '--json', '--host-session', this.hostSession]);
    if (fresh.subjectRevision !== original.subjectRevision) throw new Error('The briefing revision changed. Review the refreshed choices and choose again.');
    const current = fresh.choices.find((choice) => choice.id === original.id);
    if (!current || current.operation !== original.operation || current.goalId !== original.goalId
      || JSON.stringify(current.target) !== JSON.stringify(original.target)
      || current.actor !== original.actor || current.hostSession !== original.hostSession) {
      throw new Error('This action is no longer valid. Refresh and choose again.');
    }
    this.home = fresh;
    return current;
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as { type?: string; id?: string; path?: string };
    try {
      if (message.type === 'refresh') return void this.refresh();
      if (message.type === 'back') { this.returned = null; this.error = null; return this.render(); }
      if (message.type === 'acknowledge' && this.home) {
        await this.context.globalState.update(this.acknowledgementKey(this.home), {
          at: new Date().toISOString(), subjectRevision: this.home.subjectRevision,
          repositoryHead: this.home.context.repository.head,
          activeStory: this.home.context.activeStory,
          dirty: this.home.context.repository.dirty
        });
        this.acknowledgement = this.context.globalState.get<HomeAcknowledgement>(this.acknowledgementKey(this.home)) ?? null;
        return this.render();
      }
      if (message.type === 'artifact' && message.path) {
        const node: TreeNode = { kind: 'artifact', id: message.id ?? message.path, label: message.id ?? message.path, path: message.path };
        await vscode.commands.executeCommand('singularityFlow.openArtifact', node); return;
      }
      if (message.type !== 'choose' || !this.home || !message.id) return;
      const original = this.home.choices.find((choice) => choice.id === message.id);
      if (!original) throw new Error('That choice is not part of the current briefing.');
      const choice = await this.revalidate(original);
      if (choice.operation === 'work.continue' || choice.operation === 'work.readiness') {
        const workId = choice.target.workId;
        if (!workId) throw new Error('This Story choice has no Work ID.');
        this.returned = await this.client.run<ReturnResult>(['story', 'return', workId, '--json', '--host-session', this.hostSession]);
      } else if (choice.operation === 'review.packet') await vscode.commands.executeCommand('singularityFlow.openApprovals');
      else if (choice.operation === 'work.list') await vscode.commands.executeCommand('singularityFlow.openInbox');
      else if (choice.operation === 'work.start.intake') await vscode.commands.executeCommand('singularityFlow.startWork');
      else if (choice.operation === 'workspace.switch') await vscode.commands.executeCommand('singularityFlow.openWorkspaces');
      else if (choice.operation === 'context.explain') {
        void vscode.window.showInformationMessage(`${this.home.context.workspace.name} · ${this.home.context.repository.repositoryId} · ${this.home.context.repository.branch}`);
      }
      this.error = null;
    } catch (error) { this.error = (error as Error).message; }
    this.render();
  }

  private render(): void {
    const token = nonce();
    const body = this.home
      ? (this.returned ? returnBody(this.home, this.returned, this.error) : homeBody(this.home, this.acknowledgement, this.error))
      : `<header>${brandLockup()}<h1>Talk to SFlow</h1></header><section><p>${escape(this.error ?? 'Reading the active workspace…')}</p><button class="secondary" data-action="refresh">Retry</button></section>`;
    this.panel.webview.html = page('Talk to SFlow', body, contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }
}
