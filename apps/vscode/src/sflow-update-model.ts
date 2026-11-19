/**
 * Update SFlow…, as data: which VS Code to install into, the words of each screen, and the updater's
 * arguments. No `vscode` import, so tests check every path rule for Windows and macOS on any host.
 */
import path from 'node:path';

export interface UpdateSourceChoice { mode: 'folder' | 'local-folder'; source?: string; localFolder?: string }

/** What the updater writes for this window to read: runtime/update.mjs `--result`. */
export interface UpdateRunResult {
  status: 'running' | 'checked' | 'complete' | 'failed';
  pid?: number;
  version?: string;
  route?: string;
  cli?: string | null;
  error?: string;
  code?: string | null;
  sourceProblem?: boolean;
  work?: string | null;
}

/** One update run this window started, kept in global state so a reloaded window can finish it. */
export interface PendingUpdate {
  runDirectory: string;
  resultFile: string;
  terminalName: string;
  source: UpdateSourceChoice;
  startedAt: string;
}

export const UPDATE_TERMINAL_NAME = 'Update SFlow';
export const PENDING_UPDATE_KEY = 'singularityFlow.sflowUpdate.pending.v1';

const layoutFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * The command-line launcher of the VS Code running this extension: `bin/<applicationName>` beside its
 * app folder (`code`, or `code-insiders` for Insiders), so the VSIX goes into this VS Code even when
 * another `code` comes first on PATH. On Windows the launcher is `bin\<name>.cmd` two or three levels
 * above `resources\app` (newer builds keep the app in a versioned folder).
 */
export function vscodeLauncher(appRoot: string | undefined, platform: NodeJS.Platform, applicationName: string | undefined,
  exists: (file: string) => boolean): string | null {
  if (!appRoot) return null;
  const layout = layoutFor(platform);
  const name = /^[a-z0-9-]+$/iu.test(applicationName ?? '') ? applicationName! : 'code';
  const candidates = platform === 'darwin'
    ? [layout.join(appRoot, 'bin', name)]
    : platform === 'win32'
      ? [layout.resolve(appRoot, '..', '..', 'bin', name + '.cmd'), layout.resolve(appRoot, '..', '..', '..', 'bin', name + '.cmd')]
      : [layout.resolve(appRoot, '..', '..', 'bin', name), layout.join(appRoot, 'bin', name)];
  return candidates.find(exists) ?? null;
}

/**
 * This VS Code's extensions folder when VS Code would not find it on its own: VSCODE_EXTENSIONS, or the
 * folder an installed copy of this extension sits in when that is not `~/<dataFolderName>/extensions`
 * (VS Code started with --extensions-dir). Portable VS Code finds its own folder from its launcher.
 */
export function vscodeExtensionsDirectory({ extensionPath, production, environment, homeDirectory, dataFolderName, platform }: {
  extensionPath: string; production: boolean; environment: NodeJS.ProcessEnv; homeDirectory: string;
  dataFolderName: string | undefined; platform: NodeJS.Platform;
}): string | null {
  const layout = layoutFor(platform);
  if (environment.VSCODE_EXTENSIONS && layout.isAbsolute(environment.VSCODE_EXTENSIONS)) return layout.resolve(environment.VSCODE_EXTENSIONS);
  if (environment.VSCODE_PORTABLE || !production) return null;
  const folder = layout.dirname(layout.resolve(extensionPath));
  const standard = layout.join(homeDirectory, dataFolderName || '.vscode', 'extensions');
  const same = platform === 'win32' ? folder.toLowerCase() === standard.toLowerCase() : folder === standard;
  return same ? null : folder;
}

/** The folder whose files are the updater this extension ships: the VSIX's cli/, or the checkout in development. */
export function updaterSourceRoot(extensionPath: string, exists: (file: string) => boolean): string {
  const staged = path.join(extensionPath, 'cli');
  return exists(path.join(staged, 'package.json')) ? staged : path.resolve(extensionPath, '..', '..');
}

export function sourceLabel(source: UpdateSourceChoice): string {
  return source.mode === 'local-folder' ? `Files in ${source.localFolder}` : `SharePoint link ${source.source}`;
}

/** The arguments of runtime/update.mjs for one run from this window. */
export function updaterArguments({ script, source, resultFile, currentCli, launcher, extensionsDirectory }: {
  script: string; source: UpdateSourceChoice; resultFile: string; currentCli: string | null;
  launcher: string | null; extensionsDirectory: string | null;
}): string[] {
  return [
    script,
    ...(source.mode === 'local-folder' ? ['--local-folder', source.localFolder!] : ['--source', source.source!]),
    '--reinstall-copilot',
    '--result', resultFile,
    ...(currentCli ? ['--current-cli', currentCli] : []),
    ...(launcher ? ['--code', launcher] : []),
    ...(extensionsDirectory ? ['--code-extensions-dir', extensionsDirectory] : [])
  ];
}

/** The one confirmation before anything changes: the source, what is installed now, and every step. */
export function confirmationDetail({ source, installed, extensionVersion, steps, others, settingChange }: {
  source: UpdateSourceChoice; installed: string; extensionVersion: string | null; steps: string[];
  others: string[]; settingChange: string | null;
}): string {
  return [
    `From: ${sourceLabel(source)}`,
    `Installed now: ${installed}${extensionVersion ? ` The VS Code extension is ${extensionVersion}.` : ''}`,
    ...others.map((other) => `Another SFlow CLI is installed in ${other}. It is left as it is.`),
    '',
    'This will:',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    ...(settingChange ? ['', settingChange] : []),
    '',
    'Nothing changes until you choose Update. Each step shows in a terminal named "Update SFlow".'
  ].join('\n');
}

/**
 * The same confirmation in five short lines, for the native dialog (it shows at most a few lines;
 * View details opens the full text above). Each line stays under 140 characters.
 */
export function confirmationSummary({ source, route, version, prefix, extensionVersion }: {
  source: UpdateSourceChoice; route: 'managed' | 'npm-global'; version: string | null | undefined; prefix?: string | null;
  extensionVersion: string | null;
}): string {
  const clip = (text: string) => (text.length > 138 ? text.slice(0, 137) + '…' : text);
  const where = route === 'npm-global' ? `npm, ${prefix}` : 'SFlow\'s own folder';
  const installed = version ? `CLI ${version} (${where})` : route === 'npm-global' ? `CLI (${where})` : 'no CLI for terminals yet';
  const fetch = source.mode === 'local-folder' ? 'copy the .tgz + .vsix' : 'download the .tgz + .vsix';
  const cli = route === 'npm-global' ? `npm install -g the CLI into ${prefix}` : 'install the CLI in SFlow\'s own folder';
  const tail = route === 'npm-global'
    ? ['4 uninstall + reinstall the Copilot plugin', '5 install the .vsix into this VS Code']
    : ['4 install the .vsix into this VS Code', '5 uninstall + reinstall the Copilot plugin'];
  return [
    clip(`From: ${sourceLabel(source)}`),
    clip(`Installed now: ${installed}${extensionVersion ? ` · VS Code extension ${extensionVersion}` : ''}`),
    clip(`1 ${fetch} · 2 check they are one build · 3 ${cli}`),
    clip(tail.join(' · ')),
    'Progress shows in the "Update SFlow" terminal.'
  ].join('\n');
}

export type EndScreen = {
  kind: 'success' | 'failure';
  message: string;
  detail: string;
  /** The detail wrapped into the few short lines a native dialog shows. */
  summary: string;
  actions: string[];
};

/** Words wrapped into at most `lines` lines of `width` characters; the last line ends with … when cut. */
export function wrapLines(text: string, width = 138, lines = 5): string {
  const out: string[] = [];
  for (const paragraph of text.split(/\n+/u)) {
    let current = '';
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      const piece = word.length > width ? word.slice(0, width - 1) + '…' : word;
      if (current && current.length + 1 + piece.length > width) { out.push(current); current = piece; }
      else current = current ? `${current} ${piece}` : piece;
    }
    if (current) out.push(current);
  }
  if (out.length <= lines) return out.join('\n');
  const kept = out.slice(0, lines);
  kept[lines - 1] = kept[lines - 1]!.slice(0, width - 1) + '…';
  return kept.join('\n');
}

/** What the person reads when the run ends. Every screen ends with something to do next. */
export function endScreen(result: UpdateRunResult | null, { stopped = false }: { stopped?: boolean } = {}): EndScreen {
  if (result?.status === 'complete') {
    const detail = 'Reload this window to start using it. Restart any Copilot CLI sessions too, so they load the new plugin and skills, and open a new terminal.';
    return {
      kind: 'success',
      message: `SFlow ${result.version ?? ''} is installed`.replace(/\s+is/u, ' is'),
      detail, summary: wrapLines(detail),
      actions: ['Reload Window']
    };
  }
  const reason = result?.status === 'failed' && result.error
    ? result.error
    : stopped ? 'The update stopped before it finished. Nothing more was changed after it stopped.'
      : 'The update did not report how it ended.';
  const kept = result?.work ? `\n\nThe downloaded files were kept in ${result.work}.` : '';
  return {
    kind: 'failure',
    message: 'SFlow was not updated',
    detail: reason + kept,
    summary: wrapLines(reason + kept),
    actions: result?.sourceProblem ? ['Change source…', 'Try again', 'Show log'] : ['Try again', 'Change source…', 'Show log']
  };
}

/** The link check people see while pasting: plain words, never a stack. */
export function linkProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  let url: URL;
  try { url = new URL(text); } catch { return 'Paste the whole link, starting with https://'; }
  if (url.protocol !== 'https:') return 'The link must start with https://';
  if (url.username || url.password) return 'Use the link without a user name or password in it.';
  const kind = /\/:([a-z]):\//iu.exec(url.pathname)?.[1]?.toLowerCase();
  if (kind && kind !== 'f') return 'That link opens a single file. Use the link to the folder that holds the .tgz and .vsix.';
  return null;
}
