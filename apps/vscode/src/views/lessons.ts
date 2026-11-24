/**
 * Lessons [LRN:REQ-014]: what earlier Stories learned in this repository, read from `lessons --json`, with Drop, Keep and
 * Edit. The engine decides and records; this view shows its answer and sends a person's choice back to it.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, escape, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';

export interface LessonView {
  id: string;
  text: string;
  kind: string;
  trust: string;
  from: string;
  paths: string[];
  steps: string[];
  repeats: number;
  pinned: boolean;
  mayBeOutOfDate: boolean;
  workId: string | null;
}

export interface LessonsList {
  words: string;
  warnings: string[];
  lessons: LessonView[];
}

const errorText = (error: unknown): string => (error as Error)?.message ?? String(error);
const KIND_WORDS: Record<string, string> = {
  'test-command': 'Testing', environment: 'Set-up', refusal: 'Kept coming back', finding: 'Reviewers flag', override: 'A check is wrong here',
  'failing-test': 'A test broke', coupling: 'Changes together', agent: "The agent's words", person: 'A person wrote'
};

/** The engine's answer, either bare or in its result envelope. */
export function lessonsListFrom(value: unknown): LessonsList | null {
  const data = (value && typeof value === 'object' && 'data' in (value as Record<string, unknown>) ? (value as { data: unknown }).data : value) as Partial<LessonsList> | null;
  if (!data || !Array.isArray(data.lessons)) return null;
  return { words: String(data.words ?? ''), warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [], lessons: data.lessons as LessonView[] };
}

export function lessonsPageHtml({ list, busy, error, notice, filter }: { list: LessonsList | null; busy: boolean; error: string | null; notice: string | null; filter: string | null }): string {
  const rows = (list?.lessons ?? []).map((lesson) => {
    const marks = [lesson.pinned ? 'pinned' : '', lesson.trust === 'confirmed' ? 'confirmed' : lesson.trust === 'agent' ? "agent's words" : '', lesson.mayBeOutOfDate ? 'may be out of date' : '']
      .filter(Boolean).map((mark) => `<span class="lsn-mark">${escape(mark)}</span>`).join('');
    const paths = lesson.paths.length ? `<div class="lsn-paths">${lesson.paths.slice(0, 4).map((item) => `<code>${escape(item)}</code>`).join(' ')}${lesson.paths.length > 4 ? ' …' : ''}</div>` : '';
    return `<li class="lsn-row">
  <div class="lsn-head"><span class="lsn-kind">${escape(KIND_WORDS[lesson.kind] ?? lesson.kind)}</span>${marks}</div>
  <p class="lsn-text">${escape(lesson.text)}</p>
  ${paths}
  <div class="lsn-foot"><span class="lsn-from">From ${escape(lesson.from)}</span>
    <span class="lsn-actions">
      ${lesson.trust === 'confirmed' ? '' : `<button type="button" data-keep="${escape(lesson.id)}" title="Confirm it: it comes first">Keep</button>`}
      <button type="button" data-edit="${escape(lesson.id)}" title="Put it in your words">Edit</button>
      <button type="button" data-drop="${escape(lesson.id)}" title="Never give it to a step again">Drop</button>
    </span></div>
</li>`;
  }).join('\n');
  const empty = list && !list.lessons.length
    ? `<p class="lsn-empty">No lessons${filter ? ` for ${escape(filter)}` : ''} yet. A Story leaves them when its steps are approved.</p>` : '';
  return `<main class="lsn">
  <header class="lsn-bar"><h1>Lessons</h1>
    <input type="search" id="lsn-filter" placeholder="Only lessons about a file or folder…" value="${escape(filter ?? '')}" aria-label="Only lessons about a file or folder">
    <button type="button" data-refresh ${busy ? 'disabled' : ''}>${busy ? 'Reading…' : 'Refresh'}</button></header>
  <p class="lsn-words">${escape(list?.words ?? 'What earlier Stories learned in this repository. Each step is given the ones for the files it touches, as guidance only.')}</p>
  ${notice ? `<p class="lsn-notice" role="status">${escape(notice)}</p>` : ''}
  ${error ? `<p class="lsn-error" role="alert">${escape(error)}</p>` : ''}
  ${(list?.warnings ?? []).map((warning) => `<p class="lsn-notice">${escape(warning)}</p>`).join('')}
  ${empty}
  <ul class="lsn-list">${rows}</ul>
</main>`;
}

export const LESSONS_STYLE = `
.lsn { padding: 12px 16px; max-width: 980px; }
.lsn-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lsn-bar h1 { margin: 0; font-size: 1.3em; flex: none; }
.lsn-bar input { flex: 1 1 220px; min-width: 0; padding: 4px 8px; }
.lsn-words { color: var(--vscode-descriptionForeground); }
.lsn-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.lsn-row { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; }
.lsn-head { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: .85em; }
.lsn-kind { font-weight: 600; }
.lsn-mark { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 0 6px; color: var(--vscode-descriptionForeground); }
.lsn-text { margin: 6px 0; }
.lsn-paths code { font-size: .85em; }
.lsn-foot { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; align-items: center; font-size: .85em; color: var(--vscode-descriptionForeground); }
.lsn-actions { display: flex; gap: 6px; }
.lsn-error { color: var(--vscode-errorForeground); }
.lsn-notice { color: var(--vscode-descriptionForeground); }
`;

export const LESSONS_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-drop],[data-keep],[data-edit],[data-refresh]');
    if (!target || target.disabled) return;
    if (target.dataset.drop) api.postMessage({ type: 'lessons.drop', id: target.dataset.drop });
    else if (target.dataset.keep) api.postMessage({ type: 'lessons.keep', id: target.dataset.keep });
    else if (target.dataset.edit) api.postMessage({ type: 'lessons.edit', id: target.dataset.edit });
    else api.postMessage({ type: 'lessons.refresh' });
  });
  document.addEventListener('change', (event) => {
    if (event.target.id === 'lsn-filter') api.postMessage({ type: 'lessons.filter', path: event.target.value });
  });
})();
`;

export class LessonsPanel implements vscode.Disposable {
  private static current: LessonsPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private list: LessonsList | null = null;
  private filter: string | null = null;
  private busy = false;
  private error: string | null = null;
  private notice: string | null = null;
  private disposed = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly client: SingularityFlowClient) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open (or reveal) Lessons, optionally only those about one file, and read them fresh. */
  static show(client: SingularityFlowClient, filter: string | null = null): LessonsPanel {
    const existing = LessonsPanel.current;
    if (existing && existing.client === client) {
      if (filter !== null) existing.filter = filter || null;
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.load();
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.lessons', 'Lessons', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    LessonsPanel.current = new LessonsPanel(panel, client);
    LessonsPanel.current.filter = filter || null;
    void LessonsPanel.current.load();
    return LessonsPanel.current;
  }

  private router = registerMessageRouter('singularityFlow.lessons', {
    'lessons.refresh': () => this.load(),
    'lessons.filter': (message) => { this.filter = stringField(message, 'path')?.trim() || null; return this.load(); },
    'lessons.drop': (message) => this.change('drop', stringField(message, 'id')),
    'lessons.keep': (message) => this.change('keep', stringField(message, 'id')),
    'lessons.edit': (message) => this.edit(stringField(message, 'id'))
  });

  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try {
      const list = lessonsListFrom(await this.client.run(['lessons', ...(this.filter ? ['--path', this.filter] : []), '--json']));
      if (!list) throw new Error("The lessons could not be read from the engine's answer.");
      this.list = list;
      this.error = null;
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async change(action: 'drop' | 'keep', id: string | null | undefined): Promise<void> {
    if (!id || !/^K-[0-9a-f]{12}$/iu.test(id)) return;
    try {
      const result = await this.client.run<{ words?: string }>(['lessons', action, id, '--json']);
      this.notice = String(result?.words ?? `${action === 'drop' ? 'Dropped' : 'Kept'} ${id}.`);
    } catch (error) {
      this.notice = null;
      this.error = errorText(error);
    }
    await this.load();
  }

  private async edit(id: string | null | undefined): Promise<void> {
    if (!id || !/^K-[0-9a-f]{12}$/iu.test(id)) return;
    const lesson = this.list?.lessons.find((item) => item.id === id);
    const text = await vscode.window.showInputBox({ title: 'Edit lesson', prompt: 'Your words replace SFlow\'s, and the lesson is confirmed.', value: lesson?.text ?? '' });
    if (!text?.trim()) return;
    try {
      const result = await this.client.run<{ words?: string }>(['lessons', 'edit', id, '--text', text.trim(), '--json']);
      this.notice = String(result?.words ?? `Edited ${id}.`);
    } catch (error) {
      this.error = errorText(error);
    }
    await this.load();
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page('Lessons', lessonsPageHtml({ list: this.list, busy: this.busy, error: this.error, notice: this.notice, filter: this.filter }),
      contentSecurityPolicy(this.panel.webview, token), token, LESSONS_SCRIPT, { styles: LESSONS_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    if (LessonsPanel.current === this) LessonsPanel.current = null;
    while (this.subscriptions.length) this.subscriptions.pop()?.dispose();
  }
}
