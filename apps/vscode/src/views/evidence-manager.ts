/** A full-page, governed evidence catalog and attachment surface. */
import * as vscode from 'vscode';
import type { WorkspaceStore } from '../state.ts';
import {
  evidenceCatalog, evidenceStorageLabel, evidenceTargets, type EvidenceCatalogItem, type EvidenceTarget
} from '../evidence.ts';
import { brandLockup,
  contentSecurityPolicy, escape, icon, navigationTarget, nonce, page, type IconName
} from './webview.ts';
import { navigateTo } from './navigate.ts';
import { enumField, registerMessageRouter, stringField, type InboundMessage } from './messages.ts';

/**
 * The sources evidence can come from, enumerated so a message can be checked against them. The
 * last is offered only to a Story released from an Epic: a verified copy of one of its sources.
 */
export const EVIDENCE_SOURCE_KINDS = Object.freeze(['files', 'figma-export', 'figma-link', 'url', 'epic-source'] as const);
export type EvidenceSourceKind = typeof EVIDENCE_SOURCE_KINDS[number];

export interface EvidenceManagerActions {
  attach(target: EvidenceTarget, source: EvidenceSourceKind): Promise<void>;
  open(item: EvidenceCatalogItem): Promise<void>;
  detach(item: EvidenceCatalogItem): Promise<void>;
  /** Change which phases use a Story document. */
  scope(item: EvidenceCatalogItem): Promise<void>;
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
  items: EvidenceCatalogItem[],
  { releasedFrom = null }: { releasedFrom?: string | null } = {}
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
    ['url', 'HTTPS reference', 'Record a governed link to an external document or design system.', 'document'],
    ...(releasedFrom ? [['epic-source', 'Source from the Epic', `Import a verified copy of one of Epic ${releasedFrom}'s sources into the Story.`, 'document'] as [EvidenceSourceKind, string, string, IconName]] : [])
  ];
  const sourceButtons = sourceCards.map(([source, label, description, glyph]) => `
    <button class="evidence-source" type="button" data-attach="${source}"${attachDisabled}>
      <span class="evidence-source-icon">${icon(glyph, { size: 24 })}</span>
      <strong>${escape(label)}</strong><span>${escape(description)}</span>
    </button>`).join('');
  const itemCards = (catalog: EvidenceCatalogItem[], history = false): string => catalog.map((item) => {
    const storage = evidenceStorageLabel(item);
    const story = item.target.kind === 'story';
    // Only this checkout's copy can be opened; elsewhere a machine-local document has no bytes.
    const openable = item.storage !== 'local' || item.availability === 'available';
    return `
    <article class="evidence-item${history ? ' detached' : ''}">
      <span class="evidence-item-icon">${icon(item.mimeType?.startsWith('image/') ? 'visual' : 'document', { size: 20 })}</span>
      <div><strong>${escape(item.label)}</strong>
        <p>${escape(item.target.label)} · ${escape(item.id)} · ${escape(item.mimeType ?? item.kind)}</p>
        <small>${item.sha256 ? `sha256 ${escape(item.sha256.slice(0, 16))}…` : escape(item.url ?? item.path ?? 'metadata only')}</small>
        ${storage ? `<small class="evidence-storage${item.storage === 'local' && item.availability !== 'available' ? ' warn' : ''}">${escape(storage)}</small>` : ''}
        ${story ? `<small class="evidence-phases">Used in: ${escape(item.phases?.length ? item.phases.join(', ') : 'every phase')}</small>` : ''}
        ${history ? `<small>Detached${item.detachReason ? ` · ${escape(item.detachReason)}` : ''}${item.detachedBy ? ` · ${escape(item.detachedBy)}` : ''}</small>` : ''}
      </div>
      <div class="evidence-actions">
        ${openable ? `<button class="secondary" type="button" data-open="${escape(itemKey(item))}">${history ? 'Open history' : 'Open'}</button>` : ''}
        ${!history && story ? `<button class="secondary" type="button" data-scope="${escape(itemKey(item))}">Phases…</button>` : ''}
        ${history ? '' : `<button class="danger secondary" type="button" data-detach="${escape(itemKey(item))}">Detach…</button>`}
      </div>
    </article>`;
  }).join('');

  const body = `
    ${brandLockup()}
    <header class="inbox-header">
      <p class="eyebrow">Governed lifecycle evidence</p>
      <h1>${icon('visual', { size: 24 })}Evidence & designs</h1>
      <p class="meta">Attach source material once, then review exactly what each Story or Epic can use. The Flow CLI hashes every file and commits and pushes the record; a Story file kept on this machine only commits its name, size and SHA-256, never its bytes.</p>
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
      const scope=event.target.closest('[data-scope]');
      if(scope){window.__sfVscode.postMessage({type:'scope',itemKey:scope.dataset.scope});return;}
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
      await this.router.route(raw);
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

  /**
   * The four messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
   *
   * Both lookups are unchanged: the page names a key and the *snapshot* says which target or item
   * that is, so a forged key finds nothing rather than reaching something it should not.
   *
   * **The handlers return their promise.** This panel's outer listener awaits, and a caller that
   * awaits `post()` is relying on the attach having finished before it asserts. Discarding the
   * promise with `void` compiled, ran, and made the host test read "none pinned" — the write had not
   * landed yet. `route()` returns whatever the handler returns, so returning the promise keeps the
   * chain the migration inherited.
   *
   * `source` gains a real check it did not have. It was `message.source && …` — any non-empty
   * string passed and was handed straight to `actions.attach` typed as an `EvidenceSourceKind` it
   * might not be. `enumField` holds it to the kinds the type actually declares.
   */
  private router = registerMessageRouter('singularityFlow.evidenceManager', {
    attach: (message) => {
      const key = stringField(message, 'targetKey');
      const source = enumField(message, 'source', EVIDENCE_SOURCE_KINDS);
      const target = key
        ? evidenceTargets(this.store.current.snapshot).find((candidate) => targetKey(candidate) === key)
        : null;
      return target && source ? this.act(() => this.actions.attach(target, source as EvidenceSourceKind)) : undefined;
    },
    open: (message) => {
      const item = this.itemFor(message);
      return item ? this.act(() => this.actions.open(item)) : undefined;
    },
    detach: (message) => {
      const item = this.itemFor(message);
      // Only an active attachment can be detached; the page cannot ask to detach a superseded one.
      return item?.status === 'active' ? this.act(() => this.actions.detach(item)) : undefined;
    },
    scope: (message) => {
      const item = this.itemFor(message);
      // Phase scope belongs to active Story documents; Epic sources have no phases.
      return item?.status === 'active' && item.target.kind === 'story' ? this.act(() => this.actions.scope(item)) : undefined;
    }
  });

  private itemFor(message: InboundMessage) {
    const key = stringField(message, 'itemKey');
    return key
      ? evidenceCatalog(this.store.current.snapshot).find((candidate) => itemKey(candidate) === key) ?? null
      : null;
  }

  /** Every accepted message re-renders, including the ones whose lookup found nothing. */
  private async act(action: () => Promise<void>): Promise<void> {
    await action();
    this.render();
  }

  private render(): void {
    this.panel.webview.html = evidenceManagerHtml(
      this.panel.webview,
      evidenceTargets(this.store.current.snapshot),
      evidenceCatalog(this.store.current.snapshot),
      { releasedFrom: (this.store.current.snapshot?.workflow as { lineage?: { epicId?: string | null } } | undefined)?.lineage?.epicId ?? null }
    );
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (EvidenceManagerPanel.current === this) EvidenceManagerPanel.current = null;
  }
}
