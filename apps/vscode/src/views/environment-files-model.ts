/**
 * Environment files, as VS Code shows them. [ENVF, docs/SPEC-ENVIRONMENT-FILES-v1.md, milestone 2]
 *
 * The engine owns every rule. `env files [ENV] [--repository ID | --workspace] --json` lists each
 * file a repository's environments use: its path, whether it is declared for the team or personal,
 * its template, where the real file is (a path only), its status and whether Git ignores it locally.
 * The other `env files` commands create, link, adopt, add, remove and place files, and `env files
 * path` answers where the real file is for an editor to open. This module reads those answers into
 * the page's rows, says which actions each row offers, builds the exact argv for each action, and
 * turns a missing file before a run into the plain words and fixes VS Code shows instead of a
 * failing task.
 *
 * Nothing here ever reads, holds or shows what a file contains: the engine never reports it, and
 * no field of the view could carry it.
 *
 * Pure on purpose (no `vscode` import, no file system), so the tests pin every row, action and argv.
 */
import YAML from 'yaml';

export type EnvironmentFileKind = 'declared' | 'personal';
export type EnvironmentFileSource = 'store' | 'linked' | 'root';
export type EnvironmentFileStatus = 'missing' | 'ready' | 'linked' | 'unmanaged' | 'placed-here' | 'unknown';

/** One file of one environment, as `env files --json` reports it. `repository` null: a workspace-level file. */
export interface EnvironmentFile {
  repository: string | null;
  /** The capability or source root the file belongs to; null for the repository as a whole. */
  app: string | null;
  environment: string;
  path: string;
  kind: EnvironmentFileKind;
  template: string | null;
  source: EnvironmentFileSource | null;
  /** The real file's location on this computer: a path, never contents. */
  location: string | null;
  status: EnvironmentFileStatus;
  /** Whether the path is in this clone's `.git/info/exclude`; null when the engine does not say. */
  excluded: boolean | null;
}

export interface EnvironmentFilesReading {
  scope: 'repository' | 'workspace';
  files: EnvironmentFile[];
  /** Environments the engine names (declared ones without files too), then those the files name. */
  environments: string[];
  /** The workspace's folder per environment, when the engine reports one. */
  roots: Record<string, string>;
  /** Entries left out because the engine's answer for them is incomplete. */
  dropped: number;
}

export type FileAction = 'create' | 'create-empty' | 'open' | 'link' | 'adopt' | 'reveal' | 'unlink' | 'remove';
export const FILE_ACTIONS: readonly FileAction[] = ['create', 'create-empty', 'open', 'link', 'adopt', 'reveal', 'unlink', 'remove'];
/** Actions that change files or records on this computer: each needs a trusted workspace. */
export const CHANGING_ACTIONS: ReadonlySet<FileAction> = new Set(['create', 'create-empty', 'link', 'adopt', 'unlink', 'remove']);

export const ACTION_LABELS: Record<FileAction, string> = {
  create: 'Create from template', 'create-empty': 'Create empty file', open: 'Open', link: 'Use existing file…', adopt: 'Adopt',
  reveal: 'Reveal', unlink: 'Stop using linked file', remove: 'Remove personal file'
};

const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const GLOB = /[*?[\]{}]/u;
const STATUSES: readonly EnvironmentFileStatus[] = ['missing', 'ready', 'linked', 'unmanaged', 'placed-here'];
const SOURCES: readonly EnvironmentFileSource[] = ['store', 'linked', 'root'];
const MAX_FILES = 2_000;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A command-result envelope (`{ resultType: 'command-result', data }`) or the bare answer. */
function unwrap(raw: unknown): unknown {
  let value = raw;
  for (let depth = 0; depth < 3; depth += 1) {
    const object = record(value);
    if (!object || !record(object.data) && !Array.isArray(object.data)) return value;
    value = object.data;
  }
  return value;
}

/**
 * A path relative to its repository (or the workspace root): no absolute path, no `..` segment, no
 * control character, no glob. A declared environment file is exact; a glob only protects.
 */
export function relativeFilePath(value: unknown): string | null {
  const candidate = text(value)?.trim();
  if (!candidate || candidate.length > 1024 || CONTROL.test(candidate) || GLOB.test(candidate)) return null;
  const normalised = candidate.replace(/\\/gu, '/');
  if (normalised.startsWith('/') || /^[A-Za-z]:/u.test(normalised)) return null;
  const parts = normalised.split('/');
  if (parts.some((part) => part === '..' || part === '')) return null;
  return parts.filter((part) => part !== '.').join('/') || null;
}

/** A location on this computer the engine reported: an absolute path, nothing else. */
export function absoluteLocation(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate || candidate.length > 4096 || CONTROL.test(candidate)) return null;
  return candidate.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith('\\\\') ? candidate : null;
}

function fileFrom(value: unknown, inherited: { repository?: string | null; app?: string | null; environment?: string | null }): EnvironmentFile | null {
  const entry = record(value);
  if (!entry) return null;
  const environment = text(entry.environment) ?? inherited.environment ?? null;
  const filePath = relativeFilePath(entry.path);
  if (!environment || !ENVIRONMENT.test(environment) || !filePath) return null;
  const repository = entry.repository === null ? null : text(entry.repository) ?? inherited.repository ?? null;
  if (repository !== null && !REPOSITORY.test(repository)) return null;
  const app = text(entry.app);
  const status = text(entry.status);
  const source = text(entry.source);
  return {
    repository,
    app: app && !CONTROL.test(app) && app.length <= 256 ? app : inherited.app ?? null,
    environment,
    path: filePath,
    kind: entry.kind === 'personal' ? 'personal' : 'declared',
    template: relativeFilePath(entry.template),
    source: SOURCES.includes(source as EnvironmentFileSource) ? source as EnvironmentFileSource : null,
    location: absoluteLocation(entry.location),
    status: STATUSES.includes(status as EnvironmentFileStatus) ? status as EnvironmentFileStatus : 'unknown',
    excluded: typeof entry.excluded === 'boolean' ? entry.excluded : null
  };
}

/** `roots: { ENV: DIR }` or `roots: [{ environment, directory | path | root }]`, from the answer or its workspace. */
function rootsFrom(answer: Record<string, unknown>): Record<string, string> {
  const raw = answer.roots ?? record(answer.workspace)?.roots;
  const roots: Record<string, string> = {};
  const add = (environment: unknown, directory: unknown) => {
    const name = text(environment);
    const location = absoluteLocation(directory);
    if (name && ENVIRONMENT.test(name) && location) roots[name] = location;
  };
  if (Array.isArray(raw)) for (const item of raw) { const entry = record(item); add(entry?.environment, entry?.directory ?? entry?.path ?? entry?.root); }
  else for (const [name, directory] of Object.entries(record(raw) ?? {})) add(name, typeof directory === 'string' ? directory : record(directory)?.directory ?? record(directory)?.path);
  return roots;
}

/**
 * The files from `env files --json`: a flat `files` list (the spec's shape), or files nested under
 * `repositories[].files` and `repositories[].apps[].files`, and workspace-level `workspace.files`.
 * Null when the answer is not a file list at all.
 */
export function environmentFilesFrom(raw: unknown): EnvironmentFilesReading | null {
  const value = unwrap(raw);
  const answer = Array.isArray(value) ? { files: value } : record(value);
  if (!answer) return null;
  const files: EnvironmentFile[] = [];
  let dropped = 0;
  let found = false;
  const take = (list: unknown, inherited: Parameters<typeof fileFrom>[1]) => {
    if (!Array.isArray(list)) return;
    found = true;
    for (const item of list) {
      if (files.length >= MAX_FILES) { dropped += 1; continue; }
      const file = fileFrom(item, inherited);
      if (file) files.push(file); else dropped += 1;
    }
  };
  take(answer.files, {});
  for (const item of Array.isArray(answer.repositories) ? answer.repositories : []) {
    const repository = record(item);
    const id = text(repository?.id) ?? text(repository?.repository);
    if (!repository || !id) continue;
    take(repository.files, { repository: id });
    for (const appItem of Array.isArray(repository.apps) ? repository.apps : []) {
      const app = record(appItem);
      take(app?.files, { repository: id, app: text(app?.id) ?? text(app?.app) });
    }
  }
  take(record(answer.workspace)?.files ?? answer.workspaceFiles, { repository: null });
  if (!found) return null;
  // One row per file: a nested answer that also lists the file flat is not shown twice.
  const seen = new Set<string>();
  const unique = files.filter((file) => { const key = fileKey(file); if (seen.has(key)) return false; seen.add(key); return true; });
  const named = (Array.isArray(answer.environments) ? answer.environments : []).flatMap((item) => {
    const name = typeof item === 'string' ? item : text(record(item)?.name);
    return name && ENVIRONMENT.test(name) ? [name] : [];
  });
  return {
    scope: answer.scope === 'workspace' || answer.workspace === true ? 'workspace' : 'repository',
    files: unique,
    environments: [...new Set([...named, ...unique.map((file) => file.environment)])],
    roots: rootsFrom(answer),
    dropped
  };
}

/** The identity of one row: its repository, environment and path. */
export const fileKey = (file: Pick<EnvironmentFile, 'repository' | 'environment' | 'path'>): string =>
  JSON.stringify([file.repository ?? null, file.environment, file.path]);

/** The row a page message names, looked up in the files read last; null when it is not one of them. */
export function fileByKey(files: readonly EnvironmentFile[], key: unknown): EnvironmentFile | null {
  return typeof key === 'string' && key.length <= 2_048 ? files.find((file) => fileKey(file) === key) ?? null : null;
}

/** `{ location }` from `env files path --json` or `env files create --json`; null without one. */
export function locationFrom(raw: unknown): string | null {
  const answer = record(unwrap(raw));
  return absoluteLocation(answer?.location ?? record(answer?.file)?.location);
}

/** Whether a refusal says this engine has no `env files` at all (an older Singularity Flow). */
export function environmentFilesUnsupported(error: unknown): boolean {
  const result = record((error as { result?: unknown } | null)?.result);
  const code = String(record(result?.error)?.code ?? result?.code ?? '');
  if (/^UNKNOWN_(?:SUBCOMMAND|COMMAND)$/u.test(code)) return true;
  return !code && /unknown (?:sub)?command/iu.test(String((error as Error | null)?.message ?? ''));
}

// ---------------------------------------------------------------------------------------------
// Actions per row

/** Whether the person points the path at a file of their own: then Stop using linked file applies. */
const linkedHere = (file: EnvironmentFile): boolean => file.source === 'linked' || file.status === 'linked';

/** What a row offers, in order, from its status, its source and its kind. Contents are never an action. */
export function fileActions(file: EnvironmentFile): FileAction[] {
  const actions: FileAction[] = [];
  const linked = linkedHere(file);
  switch (file.status) {
    case 'missing':
      actions.push(...(linked ? ['link', 'unlink'] as const : [file.template ? 'create' as const : 'create-empty' as const, 'link' as const]));
      break;
    case 'ready': case 'linked': case 'placed-here':
      actions.push('open', 'reveal', linked ? 'unlink' : 'link');
      break;
    case 'unmanaged':
      actions.push('adopt');
      break;
    default:
      break;
  }
  if (file.kind === 'personal') actions.push('remove');
  return actions;
}

const STATUS_WORDS: Record<EnvironmentFileStatus, string> = {
  missing: 'Missing', ready: 'Ready', linked: 'Linked', unmanaged: 'Not managed', 'placed-here': 'Placed here', unknown: 'Status unknown'
};
const STATUS_TONE: Record<EnvironmentFileStatus, '' | 'ok' | 'wait' | 'bad'> = {
  missing: 'bad', ready: 'ok', linked: 'ok', unmanaged: 'wait', 'placed-here': 'ok', unknown: ''
};

function statusDetail(file: EnvironmentFile): string {
  switch (file.status) {
    case 'missing': return linkedHere(file)
      ? 'The file it is linked to is not there any more. Use another existing file, or stop using the linked one.'
      : file.template ? `Create it from ${file.template}, or use a file you already have.` : 'There is no template beside it: create an empty file, or use a file you already have.';
    case 'ready': return 'The real file is on this computer; a run in this environment places it in the checkout.';
    case 'linked': return 'It uses a file you chose; a run in this environment places it in the checkout.';
    case 'placed-here': return 'It is in place in this checkout for runs in this environment.';
    case 'unmanaged': return 'A file is already at this path in the checkout and is never overwritten. Adopt moves it into the private store and links it back.';
    default: return 'The engine reported a status VS Code does not know; refresh after updating Singularity Flow.';
  }
}

function sourceWords(file: EnvironmentFile): string | null {
  switch (file.source) {
    case 'store': return 'Private store on this computer';
    case 'linked': return 'A file you chose';
    case 'root': return `The workspace folder for ${file.environment}`;
    default: return null;
  }
}

function excludedWords(file: EnvironmentFile): string | null {
  if (file.excluded === true) return 'Git ignores it in this clone (.git/info/exclude)';
  if (file.excluded === false) return file.status === 'missing' ? null : 'Not excluded in this clone yet; the next run excludes it';
  return null;
}

export interface FileRow {
  key: string;
  path: string;
  kind: EnvironmentFileKind;
  kindWords: string;
  status: EnvironmentFileStatus;
  statusWords: string;
  tone: '' | 'ok' | 'wait' | 'bad';
  detail: string;
  source: string | null;
  /** Where the real file is: a path, never what it holds. */
  location: string | null;
  template: string | null;
  excluded: string | null;
  actions: Array<{ action: FileAction; label: string; changes: boolean }>;
}

export interface AppGroup { id: string; label: string; files: FileRow[] }
export interface RepositoryGroup { id: string; label: string; apps: AppGroup[]; total: number; missing: number }
export interface EnvironmentTab { name: string; total: number; missing: number; selected: boolean }

export interface EnvironmentFileSuggestion {
  /** The `environments.yml` additions: names and paths only. */
  draft: string | null;
  candidates: Array<{ framework: string | null; environment: string | null; path: string; template: string | null }>;
  /** The command that proposes the edited file for review. */
  command: string;
}

export interface EnvironmentFilesView {
  available: boolean;
  /** This Singularity Flow has no `env files` commands. */
  unsupported: boolean;
  scope: 'repository' | 'workspace';
  environment: string | null;
  tabs: EnvironmentTab[];
  repositories: RepositoryGroup[];
  /** The workspace folder for the selected environment, when one is known. */
  root: { directory: string | null; set: boolean };
  trusted: boolean;
  busy: boolean;
  notice: string | null;
  error: string | null;
  dropped: number;
  suggestion: EnvironmentFileSuggestion | null;
  /** No file is declared or added in any environment. */
  empty: boolean;
}

function rowFrom(file: EnvironmentFile): FileRow {
  return {
    key: fileKey(file), path: file.path, kind: file.kind, kindWords: file.kind === 'personal' ? 'Personal, this computer only' : 'Declared for the team',
    status: file.status, statusWords: STATUS_WORDS[file.status], tone: STATUS_TONE[file.status], detail: statusDetail(file),
    source: sourceWords(file), location: file.location, template: file.template, excluded: excludedWords(file),
    actions: fileActions(file).map((action) => ({ action, label: ACTION_LABELS[action], changes: CHANGING_ACTIONS.has(action) }))
  };
}

/** The selected environment: the requested one, else the remembered one, else the first with files. */
export function chooseEnvironmentTab(environments: readonly string[], requested: string | null | undefined, remembered: string | null | undefined): string | null {
  if (requested && ENVIRONMENT.test(requested)) return requested;
  if (remembered && environments.includes(remembered)) return remembered;
  return environments[0] ?? null;
}

const appLabel = (app: string | null, names: Readonly<Record<string, string>>): string =>
  app === null ? 'Whole repository' : names[app] ? `${names[app]} (${app})` : app;

/**
 * The page's rows for one environment: repositories in the order the engine lists them (this
 * window's first, workspace-level files last), then each app, then the files.
 */
export function buildEnvironmentFilesView(reading: EnvironmentFilesReading | null, {
  environment = null, remembered = null, scope = 'repository', trusted = true, busy = false, notice = null, error = null,
  unsupported = false, suggestion = null, activeRepository = null, appNames = {}
}: {
  environment?: string | null; remembered?: string | null; scope?: 'repository' | 'workspace'; trusted?: boolean; busy?: boolean;
  notice?: string | null; error?: string | null; unsupported?: boolean; suggestion?: EnvironmentFileSuggestion | null;
  activeRepository?: string | null; appNames?: Readonly<Record<string, string>>;
} = {}): EnvironmentFilesView {
  const files = reading?.files ?? [];
  const environments = [...(reading?.environments ?? [])];
  const selected = chooseEnvironmentTab(environments, environment, remembered);
  if (selected && !environments.includes(selected)) environments.push(selected);
  const tabs = environments.map((name) => {
    const of = files.filter((file) => file.environment === name);
    return { name, total: of.length, missing: of.filter((file) => file.status === 'missing').length, selected: name === selected };
  });
  const shown = files.filter((file) => file.environment === selected);
  const order = [...new Set(shown.map((file) => file.repository ?? '\u0000workspace'))].sort((left, right) =>
    Number(right === activeRepository) - Number(left === activeRepository) || Number(left === '\u0000workspace') - Number(right === '\u0000workspace'));
  const repositories = order.map((id): RepositoryGroup => {
    const mine = shown.filter((file) => (file.repository ?? '\u0000workspace') === id);
    const apps = [...new Set(mine.map((file) => file.app ?? ''))].map((app) => ({
      id: app, label: id === '\u0000workspace' && !app ? 'Workspace root' : appLabel(app || null, appNames),
      files: mine.filter((file) => (file.app ?? '') === app).map(rowFrom)
    }));
    return {
      id: id === '\u0000workspace' ? '' : id,
      label: id === '\u0000workspace' ? 'Workspace' : `${id}${id === activeRepository ? ' (this window)' : ''}`,
      apps, total: mine.length, missing: mine.filter((file) => file.status === 'missing').length
    };
  });
  const directory = selected ? reading?.roots[selected] ?? null : null;
  return {
    available: Boolean(reading) && !unsupported, unsupported, scope, environment: selected, tabs, repositories,
    root: { directory, set: Boolean(directory) || shown.some((file) => file.source === 'root') },
    trusted, busy, notice, error, dropped: reading?.dropped ?? 0, suggestion,
    empty: Boolean(reading) && files.length === 0
  };
}

// ---------------------------------------------------------------------------------------------
// Argv: every command VS Code runs, built here and nowhere else

const required = (value: string, label: string, valid: (value: string) => boolean): string => {
  if (!valid(value)) throw new Error(`${label} is invalid: ${value}`);
  return value;
};
const environmentArg = (value: string) => required(value, 'Environment', (item) => ENVIRONMENT.test(item));
const pathArg = (value: string) => required(value, 'Path', (item) => relativeFilePath(item) === item);
const locationArg = (value: string) => required(value, 'File', (item) => absoluteLocation(item) === item);

/** Which repository a command acts on: named only when it is not this window's own. */
export interface RepositoryTarget { activeRepository: string | null; scope: 'repository' | 'workspace' }

/**
 * `--repository ID` for a member repository other than this window's, `--workspace` for a
 * workspace-level file; nothing for this window's own repository, which every command assumes.
 */
export function targetArgs(file: Pick<EnvironmentFile, 'repository'>, target: RepositoryTarget): string[] {
  if (target.scope !== 'workspace') return [];
  if (file.repository === null) return ['--workspace'];
  if (file.repository === target.activeRepository) return [];
  return ['--repository', required(file.repository, 'Repository', (item) => REPOSITORY.test(item))];
}

/** The read: `env files [ENV] [--workspace] --json`. */
export function envFilesArgv({ environment = null, scope = 'repository' }: { environment?: string | null; scope?: 'repository' | 'workspace' } = {}): string[] {
  return ['env', 'files', ...(environment ? [environmentArg(environment)] : []), ...(scope === 'workspace' ? ['--workspace'] : []), '--json'];
}

/** `env files path <ENV> <PATH> --json`: where the real file is, for the editor to open. */
export const envFilesPathArgv = (file: EnvironmentFile, target: RepositoryTarget): string[] =>
  ['env', 'files', 'path', environmentArg(file.environment), pathArg(file.path), ...targetArgs(file, target), '--json'];

/** `env files create <ENV> <PATH> [--from-template]`: the store file, from its template or empty, placed. */
export const envFilesCreateArgv = (file: EnvironmentFile, fromTemplate: boolean, target: RepositoryTarget): string[] =>
  ['env', 'files', 'create', environmentArg(file.environment), pathArg(file.path), ...(fromTemplate ? ['--from-template'] : []), ...targetArgs(file, target), '--json'];

/** `env files link <ENV> <PATH> --to <FILE>`: use a file the person already has. */
export const envFilesLinkArgv = (file: EnvironmentFile, to: string, target: RepositoryTarget): string[] =>
  ['env', 'files', 'link', environmentArg(file.environment), pathArg(file.path), '--to', locationArg(to), ...targetArgs(file, target), '--json'];

/**
 * Stop using a linked file: the path goes back to the private store. The spec names the action, not
 * its command; `env files unlink <ENV> <PATH>` is the engine's, built here only.
 */
export const envFilesUnlinkArgv = (file: EnvironmentFile, target: RepositoryTarget): string[] =>
  ['env', 'files', 'unlink', environmentArg(file.environment), pathArg(file.path), ...targetArgs(file, target), '--json'];

/** `env files adopt <ENV> <PATH>`: move the unmanaged file into the store and link it back. */
export const envFilesAdoptArgv = (file: EnvironmentFile, target: RepositoryTarget): string[] =>
  ['env', 'files', 'adopt', environmentArg(file.environment), pathArg(file.path), ...targetArgs(file, target), '--json'];

/** `env files add <ENV> <PATH> --personal`: a file only this person uses, in this window's repository. */
export const envFilesAddArgv = (environment: string, filePath: string): string[] =>
  ['env', 'files', 'add', environmentArg(environment), pathArg(filePath), '--personal', '--json'];

/** `env files remove <ENV> <PATH> --personal`. */
export const envFilesRemoveArgv = (file: EnvironmentFile, target: RepositoryTarget): string[] =>
  ['env', 'files', 'remove', environmentArg(file.environment), pathArg(file.path), '--personal', ...targetArgs(file, target), '--json'];

/** `env files root <ENV> <DIR>` or `env files root <ENV> --clear`: the workspace folder for an environment. */
export const envFilesRootArgv = (environment: string, directory: string | null): string[] =>
  ['env', 'files', 'root', environmentArg(environment), ...(directory ? [locationArg(directory)] : ['--clear']), '--json'];

/** `env files suggest --json`: framework candidates and an environments.yml draft. It never reads values. */
export const envFilesSuggestArgv = (): string[] => ['env', 'files', 'suggest', '--json'];

/** The argv of one row action that runs a command directly (Open and Reveal read `path` first). */
export function actionArgv(action: FileAction, file: EnvironmentFile, target: RepositoryTarget, linkedTo: string | null = null): string[] | null {
  switch (action) {
    case 'create': return envFilesCreateArgv(file, true, target);
    case 'create-empty': return envFilesCreateArgv(file, false, target);
    case 'link': return linkedTo ? envFilesLinkArgv(file, linkedTo, target) : null;
    case 'adopt': return envFilesAdoptArgv(file, target);
    case 'unlink': return envFilesUnlinkArgv(file, target);
    case 'remove': return envFilesRemoveArgv(file, target);
    case 'open': case 'reveal': return envFilesPathArgv(file, target);
    default: return null;
  }
}

/** What a person types for a personal file: a path in the repository, or why it is not one. */
export function personalPathProblem(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return 'Type the file\'s path, relative to the repository.';
  if (GLOB.test(candidate)) return 'A personal file is one exact path; a pattern only protects files.';
  if (relativeFilePath(candidate) === null) return 'Use a path inside the repository, relative to its root, without "..".';
  return null;
}

/** What the person did, in plain words, for the notice after an action. */
export function actionNotice(action: FileAction | 'add' | 'root' | 'root-clear', subject: { environment: string; path?: string; directory?: string | null }): string {
  const { environment, path: filePath = '', directory = null } = subject;
  switch (action) {
    case 'create': return `Created ${filePath} for ${environment} from its template and opened it. Fill in its values in the editor.`;
    case 'create-empty': return `Created an empty ${filePath} for ${environment} and opened it.`;
    case 'link': return `${filePath} now uses the file you chose for ${environment}.`;
    case 'adopt': return `${filePath} was moved into the private store for ${environment} and linked back.`;
    case 'unlink': return `${filePath} no longer uses your linked file for ${environment}; your file was left where it is.`;
    case 'remove': return `${filePath} is no longer a personal file for ${environment}.`;
    case 'add': return `${filePath} was added as a personal file for ${environment}. Create it or use an existing file.`;
    case 'root': return `Files for ${environment} now live in ${directory ?? 'the folder you chose'}, for every repository of the workspace.`;
    case 'root-clear': return `Files for ${environment} live in each repository's private store again.`;
    default: return '';
  }
}

// ---------------------------------------------------------------------------------------------
// Declare for the team

/** The proposal route VS Code names: it never writes environments.yml itself. */
export const PROPOSE_ENVIRONMENTS_COMMAND = 'singularity-flow configuration save singularity/environments.yml --propose';

function draftYaml(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? `${value.trimEnd()}\n` : null;
  const object = record(value);
  if (!object) return null;
  const environments = record(object.environments) ?? object;
  const block: Record<string, { localFiles: string[] }> = {};
  for (const [name, entry] of Object.entries(environments)) {
    const list = Array.isArray(entry) ? entry : record(entry)?.localFiles;
    const paths = (Array.isArray(list) ? list : []).flatMap((item) => { const relative = relativeFilePath(item); return relative ? [relative] : []; });
    if (ENVIRONMENT.test(name) && paths.length) block[name] = { localFiles: paths };
  }
  return Object.keys(block).length ? YAML.stringify({ environments: block }) : null;
}

/** `env files suggest --json`: the candidates and the draft, or null when the answer is neither. */
export function suggestionFrom(raw: unknown): EnvironmentFileSuggestion | null {
  const answer = record(unwrap(raw));
  if (!answer) return null;
  const candidates = (Array.isArray(answer.candidates) ? answer.candidates : Array.isArray(answer.suggestions) ? answer.suggestions : []).flatMap((item) => {
    const entry = record(item);
    const filePath = relativeFilePath(entry?.path);
    if (!entry || !filePath) return [];
    const environment = text(entry.environment);
    const framework = text(entry.framework);
    return [{ framework: framework && !CONTROL.test(framework) ? framework.slice(0, 80) : null, environment: environment && ENVIRONMENT.test(environment) ? environment : null,
      path: filePath, template: relativeFilePath(entry.template) }];
  });
  const draft = draftYaml(answer.draft ?? answer.localFilesDraft ?? answer.environmentsDraft ?? answer.environmentsYml ?? answer.localFiles ?? null);
  if (!draft && !candidates.length && !Array.isArray(answer.candidates) && !Array.isArray(answer.suggestions)) return null;
  const proposal = text(record(answer.proposal)?.command) ?? text(answer.proposalCommand);
  return { draft, candidates, command: proposal && proposal.startsWith('singularity-flow ') && !CONTROL.test(proposal) ? proposal : PROPOSE_ENVIRONMENTS_COMMAND };
}

// ---------------------------------------------------------------------------------------------
// Before a run: which files of the environment are missing, and the plain words for it

/** One file a run needs that is not on this computer. */
export interface MissingFile { repository: string | null; environment: string; path: string; template: string | null; commands: string[] }

/** What a run places: its repository, its capability's source roots, else the working directories of what runs. */
export interface RunScope {
  environment: string;
  capability: string;
  /** The capability's repositories; empty when it names none. */
  repositories: readonly string[];
  sourceRoots: readonly string[];
  /** The start entry's working directory (or the test commands'); null or "." is the repository root. */
  workingDirectories?: ReadonlyArray<string | null>;
}

const under = (filePath: string, root: string): boolean => filePath === root || filePath.startsWith(`${root}/`);

/**
 * Whether a run of the capability places this file, by the spec's rule: the run's repository; in a
 * monorepo only files under the capability's source roots, or under the start entry's working
 * directory when it has none. A file the engine names for the capability belongs to it. The engine
 * places; this only says early what it would.
 */
export function placedByRun(file: EnvironmentFile, scope: Omit<RunScope, 'environment'>): boolean {
  if (file.repository === null) return false;
  if (scope.repositories.length && !scope.repositories.includes(file.repository)) return false;
  if (file.app === scope.capability) return true;
  // A root that is the repository itself ("." or none) places every file of the repository.
  const roots = (scope.sourceRoots.length ? scope.sourceRoots : scope.workingDirectories ?? []).map((root) => root ? relativeFilePath(root) : null);
  return !roots.length || roots.some((root) => root === null || under(file.path, root));
}

/** The files of the environment a run would need and that are missing here. */
export function missingForRun(files: readonly EnvironmentFile[], scope: RunScope): MissingFile[] {
  return files.filter((file) => file.environment === scope.environment && file.status === 'missing' && placedByRun(file, scope))
    .map((file) => ({ repository: file.repository, environment: file.environment, path: file.path, template: linkedHere(file) ? null : file.template, commands: [] }));
}

/** Per environment, how many files a run of the capability places and how many of them are missing. */
export function environmentFileCounts(files: readonly EnvironmentFile[], scope: Omit<RunScope, 'environment'>, environments: readonly string[] = []):
  Array<{ environment: string; total: number; missing: number; words: string }> {
  const placed = files.filter((file) => placedByRun(file, scope));
  const names = [...new Set([...environments, ...placed.map((file) => file.environment)])];
  return names.flatMap((environment) => {
    const of = placed.filter((file) => file.environment === environment);
    if (!of.length) return [];
    const missing = of.filter((file) => file.status === 'missing').length;
    return [{ environment, total: of.length, missing, words: `${of.length} file${of.length === 1 ? '' : 's'}${missing ? ` · ${missing} missing` : ''}` }];
  });
}

/**
 * The engine's refusal of a run whose environment file is missing (ENV_FILE_MISSING, details
 * `{ environment, path, template, commands }`, or a list of them under `files`), as the same rows.
 */
export function missingFromRefusal(result: unknown): MissingFile[] {
  const answer = record(result);
  const error = record(answer?.error) ?? answer;
  if (error?.code !== 'ENV_FILE_MISSING') return [];
  const details = record(error.details) ?? {};
  const entries = Array.isArray(details.files) ? details.files : [details];
  return entries.flatMap((item) => {
    const entry = record(item);
    const environment = text(entry?.environment) ?? text(details.environment);
    const filePath = relativeFilePath(entry?.path);
    if (!entry || !environment || !ENVIRONMENT.test(environment) || !filePath) return [];
    const raw = Array.isArray(entry.commands) ? entry.commands : Object.values(record(entry.commands) ?? {});
    return [{ repository: text(entry.repository) && REPOSITORY.test(String(entry.repository)) ? String(entry.repository) : null, environment, path: filePath,
      template: relativeFilePath(entry.template),
      commands: raw.filter((command): command is string => typeof command === 'string' && command.startsWith('singularity-flow ') && !CONTROL.test(command)) }];
  });
}

/** A missing file as a row an action can act on (it has no location yet). */
export const missingAsFile = (missing: MissingFile): EnvironmentFile => ({
  repository: missing.repository, app: null, environment: missing.environment, path: missing.path, kind: 'declared',
  template: missing.template, source: null, location: null, status: 'missing', excluded: null
});

export const PREFLIGHT_CREATE = 'Create from template';
export const PREFLIGHT_LINK = 'Use existing file…';
export const PREFLIGHT_OPEN = 'Open Environment Files';
export type PreflightChoice = typeof PREFLIGHT_CREATE | typeof PREFLIGHT_LINK | typeof PREFLIGHT_OPEN;

/** The fixes offered: create when every missing file has a template, use a file when one is missing, and the page. */
export function preflightButtons(missing: readonly MissingFile[]): PreflightChoice[] {
  return [
    ...(missing.length && missing.every((file) => file.template) ? [PREFLIGHT_CREATE] as const : []),
    ...(missing.length === 1 ? [PREFLIGHT_LINK] as const : []),
    PREFLIGHT_OPEN
  ];
}

/**
 * The plain words shown instead of a failing task: what did not start, which file is missing, and
 * the two ways to fix it. No value and no file content is ever part of it.
 */
export function preflightMessage(run: { kind: 'start' | 'debug' | 'tests'; label: string; exitCode?: number | null }, environment: string, missing: readonly MissingFile[]): string {
  const ended = typeof run.exitCode === 'number';
  const what = ended ? `${run.label} ended with exit code ${run.exitCode}`
    : run.kind === 'tests' ? `${run.label} were not run` : `${run.label} was not started${run.kind === 'debug' ? ' with its debugger' : ''}`;
  const names = missing.map((file) => file.path);
  const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  const needs = missing.length === 1 ? `needs ${list}, which is missing on this computer` : `needs ${missing.length} files that are missing on this computer: ${list}`;
  const fix = missing.length === 1
    ? missing[0]!.template ? `Create it from its template ${missing[0]!.template}, or use an existing file.` : 'Create it, or use an existing file.'
    : missing.every((file) => file.template) ? 'Create them from their templates, or use existing files, on Environment Files.'
      : 'Create each one, or use an existing file, on Environment Files.';
  return `${what}: environment ${environment} ${needs}. ${fix}${ended ? '' : ' Nothing ran.'}`;
}
