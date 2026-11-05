/**
 * What each installed extension adds to every Copilot call, and what to do about it.
 *
 * Copilot re-reads its starting context on every call. In recorded Stories that was 18% of the cost,
 * and a fifth of it was the skill list that two language extensions added to a repository in neither
 * language. A person can only act on that if they can see it per extension.
 *
 * What is exact and what is not:
 * - Skills: the list in the last chat's own system message, so each extension's share is measured.
 * - Tools: Copilot reports one total and can load tools on demand, so tools are counted, never priced.
 * - Tokens: Copilot's totals are its own. A skill's tokens are its characters divided by four.
 *
 * Nothing here changes a setting. VS Code offers no per-extension disable command, and which
 * extensions run in a workspace is the person's choice, so the page opens VS Code's own page for it.
 */
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { escape } from './webview.ts';

export interface ExtensionFacts {
  id: string; name: string; version: string;
  kind: 'extension' | 'copilot' | 'singularity-flow' | 'vs-code';
  tools: string[]; skills: { name: string; chars: number }[];
  agents: number; mcpServers: number; participants: number; instructions: number;
  activationEvents: string[]; dependedOnBy: string[];
}

export interface InstalledExtension {
  id: string; builtin: boolean; packageJSON: Record<string, unknown>;
  /** A contributed file's text, by the path in its manifest; null when it cannot be read. */
  text(file: string): Promise<string | null>;
}

export interface LastChat {
  at: string; sameWorkspace: boolean; firstCallTokens: number;
  toolTokens: number | null; toolCount: number | null; skills: { name: string; chars: number }[];
}

/** What the workspace search found for one extension's declared file patterns. */
export interface WorkspaceFinding { looked: string[]; found: string[]; complete: boolean }

export type AdviceKind = 'turn-off' | 'your-call' | 'leave-on';

export interface ExtensionRow {
  id: string; name: string; version: string; canOpen: boolean;
  skills: { name: string; tokens: number }[]; skillTokens: number; measured: boolean;
  tools: string[]; adds: string[]; dependedOnBy: string[];
  advice: AdviceKind; why: string;
}

export interface CopilotExtensionsView {
  chat: LastChat | null; rows: ExtensionRow[];
  /** Skills in the last chat that no enabled extension declares. */
  otherSkills: { name: string; tokens: number }[];
  savingTokens: number; savingShare: number | null;
}

const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object') as Record<string, unknown>[] : []);
const tokensOf = (chars: number): number => Math.round(chars / 4);

function frontMatterField(text: string, field: string): string | null {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? '';
  const match = new RegExp(`^${field}:[ \\t]*(.*(?:\\r?\\n[ \\t]+.*)*)$`, 'mu').exec(head);
  const value = match?.[1]?.replace(/^[>|][-+]?\s*/u, '').replace(/\s+/gu, ' ').trim().replace(/^(["'])(.*)\1$/u, '$2');
  return value || null;
}

/** The same shape Copilot lists a skill in, so an estimate before any chat is close to the measured size. */
function listedChars(name: string, description: string): number {
  return `<skill>\n<name>${name}</name>\n<description>${description}</description>\n<location>plugin</location>\n</skill>`.length;
}

/** Only extensions that add something to Copilot; everything else has no place on this page. */
export async function extensionFacts(extensions: readonly InstalledExtension[]): Promise<ExtensionFacts[]> {
  const facts: ExtensionFacts[] = [];
  for (const extension of extensions) {
    const manifest = extension.packageJSON;
    const contributes = (manifest.contributes && typeof manifest.contributes === 'object' ? manifest.contributes : {}) as Record<string, unknown>;
    const tools = list(contributes.languageModelTools).map(tool => String(tool.name ?? '')).filter(Boolean);
    const skills: ExtensionFacts['skills'] = [];
    for (const skill of list(contributes.chatSkills)) {
      const file = typeof skill.path === 'string' ? skill.path : null;
      const text = file ? await extension.text(file) : null;
      const name = (text && frontMatterField(text, 'name')) ?? (file ? path.basename(path.dirname(file)) : '');
      if (name) skills.push({ name, chars: listedChars(name, (text && frontMatterField(text, 'description')) ?? '') });
    }
    const count = (key: string): number => list(contributes[key]).length;
    const row = { agents: count('chatAgents'), mcpServers: count('mcpServerDefinitionProviders'),
      participants: count('chatParticipants'), instructions: count('chatInstructions') };
    if (!tools.length && !skills.length && !row.agents && !row.mcpServers && !row.participants && !row.instructions) continue;
    const id = extension.id.toLowerCase();
    facts.push({ id: extension.id,
      name: String(manifest.displayName ?? manifest.name ?? extension.id).trim(), version: String(manifest.version ?? ''),
      kind: id.startsWith('github.copilot') ? 'copilot' : id.startsWith('singularityflow.') ? 'singularity-flow' : extension.builtin ? 'vs-code' : 'extension',
      tools, skills, ...row, activationEvents: Array.isArray(manifest.activationEvents) ? manifest.activationEvents.map(String) : [], dependedOnBy: [] });
  }
  const names = new Map(extensions.map(extension => [extension.id.toLowerCase(), String(extension.packageJSON.displayName ?? extension.id)]));
  for (const fact of facts) {
    fact.dependedOnBy = extensions.filter(extension => Array.isArray(extension.packageJSON.extensionDependencies)
      && (extension.packageJSON.extensionDependencies as unknown[]).some(id => String(id).toLowerCase() === fact.id.toLowerCase()))
      .map(extension => names.get(extension.id.toLowerCase()) ?? extension.id);
  }
  return facts;
}

/** File patterns for each language id that any installed extension declares. */
export function languageFilePatterns(manifests: readonly Record<string, unknown>[]): Map<string, string[]> {
  const patterns = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    const contributes = (manifest.contributes && typeof manifest.contributes === 'object' ? manifest.contributes : {}) as Record<string, unknown>;
    for (const language of list(contributes.languages)) {
      const id = String(language.id ?? '');
      if (!id) continue;
      const known = patterns.get(id) ?? new Set<string>();
      for (const suffix of Array.isArray(language.extensions) ? language.extensions : []) known.add(`**/*${String(suffix)}`);
      for (const name of Array.isArray(language.filenames) ? language.filenames : []) known.add(`**/${String(name)}`);
      patterns.set(id, known);
    }
  }
  return new Map([...patterns].map(([id, known]) => [id, [...known]]));
}

/** The files an extension says it works on, from its own activation events. */
export function declaredFilePatterns(activationEvents: readonly string[], languages: ReadonlyMap<string, string[]>): string[] {
  const patterns = new Set<string>();
  for (const event of activationEvents) {
    if (event.startsWith('workspaceContains:')) patterns.add(event.slice('workspaceContains:'.length));
    if (event.startsWith('onLanguage:')) for (const pattern of languages.get(event.slice('onLanguage:'.length)) ?? []) patterns.add(pattern);
  }
  return [...patterns];
}

/** The skills a chat's own system message listed, each with its exact size there. */
export function listedSkills(systemMessage: string): { name: string; chars: number }[] {
  const listing = /<available_skills>([\s\S]*?)<\/available_skills>/u.exec(systemMessage)?.[1] ?? '';
  return [...listing.matchAll(/<skill>[\s\S]*?<\/skill>/gu)].flatMap((match) => {
    const name = /<name>([^<]*)<\/name>/u.exec(match[0])?.[1]?.trim();
    return name ? [{ name, chars: match[0].length }] : [];
  });
}

/** The system message and first model call of one chat; the log's start holds both. */
async function firstCall(file: string): Promise<Omit<LastChat, 'at' | 'sameWorkspace'> | null> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let skills: LastChat['skills'] | null = null;
  let call: Record<string, unknown> | null = null;
  let seen = 0;
  try {
    for await (const line of lines) {
      if (++seen > 4_000) break;
      if (!line.includes('"system.message"') && !line.includes('"session.usage_record"')) continue;
      let event: { type?: string; data?: Record<string, unknown> };
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'system.message' && !skills) skills = listedSkills(String(event.data?.content ?? ''));
      if (event.type === 'session.usage_record' && !call) call = (event.data?.usage ?? null) as Record<string, unknown> | null;
      if (skills && call) break;
    }
  } finally { lines.close(); stream.destroy(); }
  if (!call || typeof call.inputTokens !== 'number') return null;
  return { firstCallTokens: call.inputTokens, skills: skills ?? [],
    toolTokens: typeof call.toolTokenCount === 'number' ? call.toolTokenCount : null,
    toolCount: typeof call.availableToolCount === 'number' ? call.availableToolCount : null };
}

const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * The newest VS Code Copilot chat, preferring one in this window's folders. Reads Copilot's own local
 * logs and only when the page opens; nothing is kept or sent, and only skill names and totals are used.
 */
export async function readLastCopilotChat(copilotHome: string, folders: readonly string[]): Promise<LastChat | null> {
  const root = path.join(copilotHome, 'session-state');
  let names: string[];
  try { names = await readdir(root); } catch { return null; }
  const dated: { directory: string; modified: number }[] = [];
  for (let at = 0; at < names.length; at += 32) {
    await Promise.all(names.slice(at, at + 32).map(async (name) => {
      const directory = path.join(root, name);
      try { dated.push({ directory, modified: (await stat(path.join(directory, 'events.jsonl'))).mtimeMs }); } catch { /* not a chat */ }
    }));
  }
  dated.sort((left, right) => right.modified - left.modified);
  let other: LastChat | null = null;
  for (const { directory, modified } of dated.slice(0, 60)) {
    let yaml: string;
    try { yaml = await readFile(path.join(directory, 'workspace.yaml'), 'utf8'); } catch { continue; }
    if (!/^client_name:\s*vscode-agent-host\s*$/mu.test(yaml)) continue;
    const places = [...yaml.matchAll(/^(?:cwd|git_root):\s*(.+?)\s*$/gmu)].map(match => match[1]!);
    const sameWorkspace = places.some(place => folders.some(folder => inside(place, folder)));
    if (!sameWorkspace && other) continue;
    const call = await firstCall(path.join(directory, 'events.jsonl')).catch(() => null);
    if (!call) continue;
    const chat = { ...call, at: new Date(modified).toISOString(), sameWorkspace };
    if (sameWorkspace) return chat;
    other = chat;
  }
  return other;
}

function adviceFor(fact: ExtensionFacts, skillTokens: number, finding: WorkspaceFinding | undefined): { advice: AdviceKind; why: string } {
  if (fact.kind === 'copilot') return { advice: 'leave-on', why: 'This is Copilot itself.' };
  if (fact.kind === 'singularity-flow') return { advice: 'leave-on', why: 'Singularity Flow\'s own chat tools.' };
  if (fact.kind === 'vs-code') return { advice: 'leave-on', why: 'Part of VS Code.' };
  if (!skillTokens) return { advice: 'leave-on', why: 'It lists no skills in each call, so there is no measured saving from turning it off.' };
  const cost = `It adds about ${skillTokens.toLocaleString('en-US')} tokens to every call.`;
  const shown = (patterns: readonly string[]): string => patterns.map(pattern => pattern.replace(/^\*\*\//u, '')).join(', ');
  if (!finding?.looked.length) return { advice: 'your-call', why: `${cost} Its manifest does not say which files it works on, so only you can tell if you use it here.` };
  if (finding.found.length) return { advice: 'your-call', why: `${cost} This workspace has ${shown(finding.found.slice(0, 3))} files, which it says it works on. Turn it off here if you don't use it in this workspace.` };
  if (!finding.complete) return { advice: 'your-call', why: `${cost} The search of this workspace didn't finish, so only you can tell if you use it here.` };
  return { advice: 'turn-off', why: `${cost} Nothing in this workspace matches the files it says it works on (${shown(finding.looked.slice(0, 4))}${finding.looked.length > 4 ? ` and ${finding.looked.length - 4} more` : ''}).` };
}

const ADVICE_ORDER: Record<AdviceKind, number> = { 'turn-off': 0, 'your-call': 1, 'leave-on': 2 };

export function copilotExtensionsView(facts: readonly ExtensionFacts[], chat: LastChat | null, findings: ReadonlyMap<string, WorkspaceFinding>): CopilotExtensionsView {
  const inChat = new Map((chat?.skills ?? []).map(skill => [skill.name, skill.chars]));
  const owned = new Set<string>();
  const rows = facts.map((fact): ExtensionRow => {
    // A skill the last chat did not list costs nothing there, whatever its manifest says.
    const skills = fact.skills.flatMap((skill) => {
      owned.add(skill.name);
      if (chat) return inChat.has(skill.name) ? [{ name: skill.name, tokens: tokensOf(inChat.get(skill.name)!) }] : [];
      return [{ name: skill.name, tokens: tokensOf(skill.chars) }];
    });
    const skillTokens = skills.reduce((sum, skill) => sum + skill.tokens, 0);
    const adds = [fact.agents && `${fact.agents} chat agent${fact.agents === 1 ? '' : 's'}`, fact.mcpServers && `${fact.mcpServers} MCP server source${fact.mcpServers === 1 ? '' : 's'}`,
      fact.participants && `${fact.participants} chat participant${fact.participants === 1 ? '' : 's'}`, fact.instructions && `${fact.instructions} instruction file${fact.instructions === 1 ? '' : 's'}`].filter((entry): entry is string => Boolean(entry));
    return { id: fact.id, name: fact.name, version: fact.version, canOpen: fact.kind === 'extension', skills, skillTokens, measured: Boolean(chat),
      tools: fact.tools, adds, dependedOnBy: fact.dependedOnBy, ...adviceFor(fact, skillTokens, findings.get(fact.id)) };
  }).sort((left, right) => ADVICE_ORDER[left.advice] - ADVICE_ORDER[right.advice] || right.skillTokens - left.skillTokens || left.name.localeCompare(right.name));
  const savingTokens = rows.filter(row => row.advice === 'turn-off').reduce((sum, row) => sum + row.skillTokens, 0);
  return { chat, rows, savingTokens, savingShare: chat?.firstCallTokens ? savingTokens / chat.firstCallTokens : null,
    otherSkills: (chat?.skills ?? []).filter(skill => !owned.has(skill.name)).map(skill => ({ name: skill.name, tokens: tokensOf(skill.chars) })) };
}

const number = (value: number): string => value.toLocaleString('en-US');
const ADVICE_LABEL: Record<AdviceKind, string> = { 'turn-off': 'Turn off here', 'your-call': 'Your call', 'leave-on': 'Leave on' };

function details(summary: string, names: readonly string[]): string {
  return names.length ? `<details><summary>${escape(summary)}</summary><ul class="cx-names">${names.map(name => `<li><code>${escape(name)}</code></li>`).join('')}</ul></details>` : '';
}

function summaryHtml(view: CopilotExtensionsView): string {
  const { chat } = view;
  if (!chat) return '<p class="notice">No Copilot chat from VS Code was found on this computer, so the skill sizes below are estimates from each extension\'s manifest. After your next chat, choose Check again.</p>';
  const extensionSkills = view.rows.reduce((sum, row) => sum + row.skillTokens, 0);
  const otherSkills = view.otherSkills.reduce((sum, skill) => sum + skill.tokens, 0);
  const tools = chat.toolTokens ?? 0;
  const rest = Math.max(0, chat.firstCallTokens - extensionSkills - otherSkills - tools);
  return `<p>Your last Copilot chat ${chat.sameWorkspace ? 'in this workspace' : 'on this computer'} (${escape(chat.at.replace('T', ' ').slice(0, 16))} UTC) started at
      <strong>${number(chat.firstCallTokens)} tokens</strong> before any work, and Copilot reads them again on every call.</p>
    <dl class="cx-facts"><dt>Skill lists from extensions</dt><dd>about ${number(extensionSkills)}</dd>
      <dt>Other listed skills</dt><dd>about ${number(otherSkills)}</dd>
      <dt>Tools</dt><dd>${chat.toolTokens === null ? 'not reported' : `${number(tools)}${chat.toolCount === null ? '' : ` for ${number(chat.toolCount)} tools`}`}</dd>
      <dt>Everything else</dt><dd>about ${number(rest)}</dd></dl>
    ${view.savingTokens ? `<p class="notice"><strong>Turning off what's marked below would remove about ${number(view.savingTokens)} tokens from every call${view.savingShare === null ? '' : ` (${Math.round(view.savingShare * 100)}% of this start)`}.</strong></p>`
    : '<p class="notice">Nothing here is safe to recommend turning off in this workspace.</p>'}`;
}

export function copilotExtensionsHtml(view: CopilotExtensionsView | null, error: string | null = null): string {
  return `<header class="page-header"><h1>Copilot extensions</h1>
      <p class="muted">Which installed extensions add to every Copilot call, and what to do about each one. This page reads and advises; it changes nothing.</p></header>
    <p><button data-cx="refresh" class="secondary">Check again</button> <button data-cx="skills" class="secondary">Choose skills in VS Code</button></p>
    ${error ? `<p class="notice warning" role="alert">${escape(error)}</p>` : ''}
    ${view ? `${summaryHtml(view)}
    <div class="about-table"><table><thead><tr><th>Extension</th><th>Skills in each call</th><th>Tools</th><th>Advice</th></tr></thead><tbody>
      ${view.rows.map(row => `<tr data-advice="${row.advice}"><td><strong>${escape(row.name)}</strong><br><code>${escape(row.id)}</code>${row.adds.length ? `<p class="muted">Also adds ${escape(row.adds.join(', '))}.</p>` : ''}</td>
        <td>${row.skills.length ? `${row.skills.length}, about ${number(row.skillTokens)} tokens${row.measured ? '' : ' (estimate)'}` : 'None'}${details('Show skills', row.skills.map(skill => `${skill.name} (about ${number(skill.tokens)})`))}</td>
        <td>${row.tools.length ? number(row.tools.length) : 'None'}${details('Show tools', row.tools)}</td>
        <td><strong class="cx-advice cx-${row.advice}">${ADVICE_LABEL[row.advice]}</strong><p>${escape(row.why)}</p>
          ${row.dependedOnBy.length ? `<p class="muted">Needed by ${escape(row.dependedOnBy.join(', '))}.</p>` : ''}
          ${row.canOpen ? `<button data-cx="open" data-id="${escape(row.id)}" class="secondary">Open in Extensions</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    ${view.otherSkills.length ? details(`Skills in that chat from Copilot, your own files or an extension turned off since (${view.otherSkills.length})`, view.otherSkills.map(skill => `${skill.name} (about ${number(skill.tokens)})`)) : ''}
    <h2>How to turn one off</h2>
    <ol><li>Choose <strong>Open in Extensions</strong>.</li><li>In the page that opens, choose the arrow beside <strong>Disable</strong>, then <strong>Disable (Workspace)</strong>. It stays on for your other workspaces.</li>
      <li>Reload if VS Code asks, start a new chat, and choose <strong>Check again</strong> to see the new number.</li></ol>
    <p class="muted">Skill sizes come from the last chat's own prompt, at about four characters per token. Copilot reports tools only as one total and can load them on demand, so they are counted here but not priced. To keep an extension and hide only its skills, use Choose skills in VS Code.</p>`
    : error ? '' : '<p role="status" aria-live="polite">Reading your extensions and your last Copilot chat…</p>'}`;
}

export const COPILOT_EXTENSIONS_STYLE = `.cx-facts{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1.5rem;margin:.6rem 0}.cx-facts dd{margin:0}.cx-names{margin:.3rem 0 0;padding-left:1.1rem}.cx-advice{display:inline-block;margin-bottom:.2rem}.cx-turn-off{color:var(--vscode-editorWarning-foreground)}.cx-your-call{color:var(--vscode-foreground)}.cx-leave-on{color:var(--vscode-descriptionForeground)}.about-table td{vertical-align:top}.about-table td p{margin:.3rem 0}`;

export const COPILOT_EXTENSIONS_SCRIPT = `document.addEventListener('click',event=>{const button=event.target.closest('[data-cx]');if(button&&!button.disabled)window.__sfVscode.postMessage({type:button.dataset.cx,id:button.dataset.id})});`;
