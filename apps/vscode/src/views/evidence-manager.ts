/** A full-page, governed evidence catalog and attachment surface. */
import * as vscode from 'vscode';
import type { WorkspaceStore } from '../state.ts';
import {
  evidenceCatalog, evidenceTargets, type EvidenceCatalogItem, type EvidenceTarget
} from '../evidence.ts';
import { brandLockup,
  contentSecurityPolicy, escape, icon, navigationTarget, nonce, page, type IconName
} from './webview.ts';
import { navigateTo } from './navigate.ts';

export type EvidenceSourceKind = 'files' | 'figma-export' | 'figma-link' | 'url';

export interface EvidenceManagerActions {
  attach(target: EvidenceTarget, source: EvidenceSourceKind): Promise<void>;
  open(item: EvidenceCatalogItem): Promise<void>;
  detach(item: EvidenceCatalogItem): Promise<void>;
}

function targetKey(target: EvidenceTarget): string {
  return `${target.kind}:${target.id}`;
}

function itemKey(item: EvidenceCatalogItem): string {
  return `${targetKey(item.target)}:${item.id}`;
}

export function evidenceManagerHtml(
  webview: vscode.Webview,
  targets: EvidenceTarget[],
  items: EvidenceCatalogItem[]
): string {
  const token = nonce();
  const active = items.filter((item) => item.status === 'active');
  const detached = items.filter((item) => item.status === 'detached');
  const targetOptions = targets.map((target) =>
    `<option value="${escape(targetKey(target))}">${escape(target.label)}</option>`).join('');
  const attachDisabled = targets.length ? '' : ' disabled';
  const sourceCards: Array<[EvidenceSourceKind, string, string, IconName]> = [
    ['files', 'Files, images & PDFs', 'Choose one or more local documents, screenshots, spreadsheets, or design assets.', 'document'],
    ['figma-export', 'Figma export package', 'Attach an exported folder as pinned, reviewable design evidence.', 'visual'],
    ['figma-link', 'Figma design link', 'Record an HTTPS Figma reference without storing credentials.', 'visual'],
    ['url', 'HTTPS reference', 'Record a governed link to an external document or design system.', 'document']
  ];
  const sourceButtons = sourceCards.map(([source, label, description, glyph]) => `
    <button class="evidence-source" type="button" data-attach="${source}"${attachDisabled}>
      <span class="evidence-source-icon">${icon(glyph, { size: 24 })}</span>
      <strong>${escape(label)}</strong><span>${escape(description)}</span>
    </button>`).join('');
  const itemCards = (catalog: EvidenceCatalogItem[], history = false): string => catalog.map((item) => `
    <article class="evidence-item${history ? ' detached' : ''}">
      <span class="evidence-item-icon">${icon(item.mimeType?.startsWith('image/') ? 'visual' : 'document', { size: 20 })}</span>
      <div><strong>${escape(item.label)}</strong>
        <p>${escape(item.target.label)} · ${escape(item.id)} · ${escape(item.mimeType ?? item.kind)}</p>
        <small>${item.sha256 ? `sha256 ${escape(item.sha256.slice(0, 16))}…` : escape(item.url ?? item.path ?? 'metadata only')}</small>
        ${history ? `<small>Detached${item.detachReason ? ` · ${escape(item.detachReason)}` : ''}${item.detachedBy ? ` · ${escape(item.detachedBy)}` : ''}</small>` : ''}
      </div>
      <div class="evidence-actions">
        <button class="secondary" type="button" data-open="${escape(itemKey(item))}">${history ? 'Open history' : 'Open'}</button>
        ${history ? '' : `<button class="danger secondary" type="button" data-detach="${escape(itemKey(item))}">Detach…</button>`}
      </div>
    </article>`).join('');

  const body = `
    ${brandLockup()}
    <header class="inbox-header">
      <p class="eyebrow">Governed lifecycle evidence</p>
      <h1>${icon('visual', { size: 24 })}Evidence & designs</h1>
      <p class="meta">Attach source material once, then review exactly what each Story or Epic can use. Files are hashed, committed, and pushed by the Flow CLI.</p>
    </header>
    <div class="summary-grid">
      <div class="summary-card"><strong>${active.length}</strong><span>Active evidence</span></div>
      <div class="summary-card"><strong>${detached.length}</strong><span>Detached records</span></div>
      <div class="summary-card"><strong>${targets.length}</strong><span>Governed owners</span></div>
    </div>
    <section class="evidence-attach">
      <div class="section-heading"><h2>${icon('add')}Attach evidence</h2></div>
      ${targets.length ? `<label class="field compact"><span>Attach to</span><select id="evidence-target">${targetOptions}</select>
        <small>The selected Story or Epic owns the evidence and its audit history.</small></label>`
        : `<div class="empty-state"><strong>No governed owner is active.</strong><p>Start or resume a Story or Epic, then return here to attach its evidence.</p></div>`}
      <div class="evidence-source-grid">${sourceButtons}</div>
    </section>
    <section>
      <div class="section-heading"><h2>${icon('document')}Active evidence</h2><span class="count-badge">${active.length}</span></div>
      <div class="evidence-list">${active.length ? itemCards(active) : '<div class="empty">No evidence is attached yet. Use one of the attachment choices above.</div>'}</div>
    </section>
    <details class="detached-history"${detached.length ? '' : ' open'}>
      <summary>Detached evidence history · ${detached.length}</summary>
      <div class="evidence-list">${detached.length ? itemCards(detached, true) : '<p class="muted">Nothing has been detached.</p>'}</div>
    </details>`;
  const script = `
    const target=()=>document.getElementById('evidence-target')?.value;
    document.addEventListener('click',(event)=>{
      const attach=event.target.closest('[data-attach]');
      if(attach){window.__sfVscode.postMessage({type:'attach',targetKey:target(),source:attach.dataset.attach});return;}
      const open=event.target.closest('[data-open]');
      if(open){window.__sfVscode.postMessage({type:'open',itemKey:open.dataset.open});return;}
      const detach=event.target.closest('[data-detach]');
      if(detach) window.__sfVscode.postMessage({type:'detach',itemKey:detach.dataset.detach});
    });`;
  return page('Evidence & designs', body, contentSecurityPolicy(webview, token), token, script);
}

export class EvidenceManagerPanel implements vscode.Disposable {
  private static current: EvidenceManagerPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: WorkspaceStore,
    private readonly actions: EvidenceManagerActions
  ) {
    this.subscriptions.push(store.onDidChange(() => this.render()) as vscode.Disposable);
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      await this.receive(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
    this.render();
  }

  static show(
    store: WorkspaceStore,
    actions: EvidenceManagerActions
  ): EvidenceManagerPanel {
    if (EvidenceManagerPanel.current) {
      EvidenceManagerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      EvidenceManagerPanel.current.render();
      return EvidenceManagerPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.evidenceManager', 'Evidence & designs', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    EvidenceManagerPanel.current = new EvidenceManagerPanel(panel, store, actions);
    return EvidenceManagerPanel.current;
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as {
      type?: string; targetKey?: string; source?: EvidenceSourceKind; itemKey?: string;
    };
    const targets = evidenceTargets(this.store.current.snapshot);
    const items = evidenceCatalog(this.store.current.snapshot);
    if (message.type === 'attach' && message.targetKey && message.source) {
      const target = targets.find((candidate) => targetKey(candidate) === message.targetKey);
      if (target) await this.actions.attach(target, message.source);
    } else if (message.type === 'open' && message.itemKey) {
      const item = items.find((candidate) => itemKey(candidate) === message.itemKey);
      if (item) await this.actions.open(item);
    } else if (message.type === 'detach' && message.itemKey) {
      const item = items.find((candidate) => itemKey(candidate) === message.itemKey);
      if (item?.status === 'active') await this.actions.detach(item);
    }
    this.render();
  }

  private render(): void {
    this.panel.webview.html = evidenceManagerHtml(
      this.panel.webview,
      evidenceTargets(this.store.current.snapshot),
      evidenceCatalog(this.store.current.snapshot)
    );
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (EvidenceManagerPanel.current === this) EvidenceManagerPanel.current = null;
  }
}
