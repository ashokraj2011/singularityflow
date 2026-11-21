/**
 * "Try it" on VS Code's approval and outcome pages (step intents spec §12.5): the ready ways SFlow's runtime check
 * found to try a code step's version, as the CLI returns them (`tryIt` of `review --format json` and of
 * `outcome --json`, src/runtime-check.mjs runtimeTryItView). One optional line per way:
 *   - a URL, opened in the browser;
 *   - ready requests, each with a copy button;
 *   - commands to paste, each with a copy button;
 *   - a snippet, with a copy button.
 * It is optional: it records nothing, holds nothing and asks nothing. The page posts only which way and which entry;
 * the panel looks the text up in what it loaded, never in the page. No `vscode` import, so tests render it directly.
 */
import { escape } from './webview.ts';

export type TryItWay =
  | { kind: string; shape: 'url'; url: string; start: string | null }
  | { kind: string; shape: 'requests'; baseUrl: string; requests: string[]; start: string | null }
  | { kind: string; shape: 'commands'; commands: string[] }
  | { kind: string; shape: 'snippet'; snippet: string };

export interface TryItView {
  ways: TryItWay[];
  /** What the check found, in one line (the CLI's words). */
  words: string | null;
  /** False once what the version delivered changed after the check ran. */
  current: boolean;
}

const MAXIMUM_WAYS = 8;
/** The entry of a way's start command, past every list entry (message fields carry no negative index). */
export const TRY_IT_START_ENTRY = 1_000;
const MAXIMUM_ENTRIES = 16;
const MAXIMUM_TEXT = 4_000;

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= MAXIMUM_TEXT;
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter(text).slice(0, MAXIMUM_ENTRIES) : []);

/** A loopback http(s) address with no credentials: the only kind the browser button opens. */
export function loopbackTryUrl(value: unknown): string | null {
  if (!text(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? url.href : null;
}

function way(raw: unknown): TryItWay | null {
  const entry = raw as Record<string, any> | null;
  if (!entry || typeof entry !== 'object') return null;
  const kind = text(entry.kind) ? entry.kind : 'change';
  const start = text(entry.start?.command) ? entry.start.command : null;
  const url = loopbackTryUrl(entry.url);
  if (url) return { kind, shape: 'url', url, start };
  const requests = texts(entry.requests);
  const baseUrl = loopbackTryUrl(entry.baseUrl);
  if (requests.length && baseUrl) return { kind, shape: 'requests', baseUrl, requests, start };
  const commands = texts(entry.commands);
  if (commands.length) return { kind, shape: 'commands', commands };
  if (text(entry.snippet)) return { kind, shape: 'snippet', snippet: entry.snippet };
  return null;
}

/** The ways to try it, or null when the result carries none this page can show. */
export function tryItOf(raw: unknown): TryItView | null {
  const value = raw as { ways?: unknown; words?: unknown; current?: unknown } | null;
  if (!value || typeof value !== 'object' || !Array.isArray(value.ways)) return null;
  const ways = value.ways.slice(0, MAXIMUM_WAYS).map(way).filter((entry): entry is TryItWay => entry !== null);
  if (!ways.length) return null;
  return { ways, words: text(value.words) ? value.words : null, current: value.current !== false };
}

/** The text one copy button copies: a request, a command, the snippet or the start command. */
export function tryItCopyText(view: TryItView | null | undefined, wayIndex: number | null, entry: number | null): string | null {
  const chosen = wayIndex === null ? null : view?.ways[wayIndex];
  if (!chosen || entry === null) return null;
  if (entry === TRY_IT_START_ENTRY) return 'start' in chosen ? chosen.start : null;
  if (chosen.shape === 'requests') return chosen.requests[entry] ?? null;
  if (chosen.shape === 'commands') return chosen.commands[entry] ?? null;
  if (chosen.shape === 'snippet') return entry === 0 ? chosen.snippet : null;
  return null;
}

/** The address the browser button opens, or null. */
export function tryItOpenUrl(view: TryItView | null | undefined, wayIndex: number | null): string | null {
  const chosen = wayIndex === null ? null : view?.ways[wayIndex];
  return chosen?.shape === 'url' ? chosen.url : null;
}

/** A button's attributes: what it does, on which way and which entry (TRY_IT_START_ENTRY is the start command). */
export type TryItAttributes = (action: 'open' | 'copy', way: number, entry: number) => string;

const KIND_WORDS: Record<string, string> = { web: 'the app', backend: 'the service', cli: 'the command', library: 'the library', job: 'the job', mobile: 'the app' };

function copyButton(attributes: TryItAttributes, wayIndex: number, entry: number, label = 'Copy'): string {
  return `<button type="button" class="secondary try-it-copy" ${attributes('copy', wayIndex, entry)}>${escape(label)}</button>`;
}

function startLine(way: TryItWay, wayIndex: number, attributes: TryItAttributes): string {
  return 'start' in way && way.start
    ? `<p class="muted try-it-start">Start it first: <code>${escape(way.start)}</code> ${copyButton(attributes, wayIndex, TRY_IT_START_ENTRY)}</p>` : '';
}

function wayHtml(way: TryItWay, index: number, attributes: TryItAttributes): string {
  const what = KIND_WORDS[way.kind] ?? 'the change';
  if (way.shape === 'url') {
    return `<li class="try-it-way" data-try-kind="${escape(way.kind)}"><p>Optional: open ${escape(what)} at <code>${escape(way.url)}</code>
      <button type="button" class="secondary" ${attributes('open', index, 0)}>Open in browser</button></p>${startLine(way, index, attributes)}</li>`;
  }
  if (way.shape === 'requests') {
    return `<li class="try-it-way" data-try-kind="${escape(way.kind)}"><details><summary>Optional: ${way.requests.length} ready request${way.requests.length === 1 ? '' : 's'} against <code>${escape(way.baseUrl)}</code></summary>
      ${startLine(way, index, attributes)}<ul class="try-it-entries">${way.requests.map((request, entry) => `<li><code>${escape(request)}</code> ${copyButton(attributes, index, entry)}</li>`).join('')}</ul></details></li>`;
  }
  if (way.shape === 'commands') {
    return `<li class="try-it-way" data-try-kind="${escape(way.kind)}"><details><summary>Optional: ${way.commands.length === 1 ? 'a command' : `${way.commands.length} commands`} to paste in a terminal</summary>
      <ul class="try-it-entries">${way.commands.map((command, entry) => `<li><code>${escape(command)}</code> ${copyButton(attributes, index, entry)}</li>`).join('')}</ul></details></li>`;
  }
  return `<li class="try-it-way" data-try-kind="${escape(way.kind)}"><details><summary>Optional: a snippet that uses ${escape(what)}</summary>
    <pre class="try-it-snippet"><code>${escape(way.snippet)}</code></pre>${copyButton(attributes, index, 0, 'Copy the snippet')}</details></li>`;
}

/** The "Try it" section, or nothing when there is no way to try it. Never a field, never required. */
export function tryItHtml(view: TryItView | null | undefined, attributes: TryItAttributes): string {
  if (!view?.ways.length) return '';
  return `<section class="try-it" aria-label="Try it">
    <h2>Try it</h2>
    <p class="muted">Optional ways to try this version, from SFlow's run of it${view.current ? '' : ' (of an earlier delivery: it may be out of date)'}. Trying it records nothing and holds nothing.</p>
    ${view.words ? `<p class="muted">${escape(view.words)}</p>` : ''}
    <ul class="try-it-ways">${view.ways.map((entry, index) => wayHtml(entry, index, attributes)).join('')}</ul>
  </section>`;
}

export const TRY_IT_STYLE = `
.try-it-ways, .try-it-entries { list-style:none; margin:.4rem 0; padding:0; display:grid; gap:.4rem; }
.try-it-way p { margin:.2rem 0; }
.try-it code, .try-it-snippet { overflow-wrap:anywhere; white-space:pre-wrap; }
.try-it-snippet { margin:.4rem 0; padding:.6rem .75rem; border:var(--sf-border); border-radius:var(--sf-radius); }
.try-it summary { cursor:pointer; }
`;
