/**
 * "Suggest from run configurations", as VS Code shows it. [RUN amendment 3, docs/SPEC-RUN-AND-TEST-v1.md]
 *
 * `app suggest --capability <ID> --json` reads the repository's IDE run configurations (IntelliJ,
 * PyCharm, WebStorm, GoLand, Rider, VS Code launch.json, .NET launchSettings) and platform markers,
 * and returns start-entry suggestions. This module reads that answer, lets the person keep some and
 * rename them, and builds the exact application block VS Code hands to `capability set|edit
 * --application-file`. Nothing here ever holds a secret value: a secret is a name the person binds
 * with `env bind`, and an argument that looks like it carries one is masked and cannot be kept.
 *
 * Pure on purpose (no `vscode` import), so the tests pin every draft and every argv.
 */
import YAML from 'yaml';
import { capabilityArgv, capabilityProposalArgv } from './capability-model.ts';
import type { ReviewConfirmationRequest } from './review-confirmation-page.ts';
import { DEBUG_RUNTIMES, debugPort, displayCommand, loopbackUrl, unwrapResult, type DebugRuntime } from './run-and-test-model.ts';

const START_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAPABILITY = /^[a-z0-9][a-z0-9-]*$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The amendment's list: a name with any of these words is a secret, whatever its value. */
const SECRET_NAME = /password|passwd|secret|token|key|credential|private/i;
const PLACEHOLDER = /^(?:\$\{[^}]*\}|\$[A-Za-z_]\w*|%[A-Za-z_]\w*%)$/;
const MAX_ARGV = 256;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const strings = (value: unknown, limit = MAX_ARGV): string[] | null =>
  Array.isArray(value) && value.length && value.length <= limit && value.every((item) => typeof item === 'string' && !CONTROL.test(item))
    ? [...value] as string[] : null;

export const SOURCE_WORDS: Record<string, string> = {
  intellij: 'IntelliJ IDEA', pycharm: 'PyCharm', webstorm: 'WebStorm', goland: 'GoLand', rider: 'Rider',
  vscode: 'VS Code launch.json', 'launch-settings': '.NET launchSettings.json', detected: 'Detected from the project files'
};

export interface SuggestionSource { kind: string; words: string; file: string | null; name: string | null }

/** A suggested `application.start` entry, in the shape singularity/capabilities.yml takes. */
export interface SuggestedStart {
  id: string;
  repository: string | null;
  argv: string[];
  workingDirectory: string | null;
  url: string | null;
  ready: { http?: string; log?: string; timeoutMs?: number } | null;
  environments: string[];
  arguments: Record<string, string[]>;
  debug: { runtime: DebugRuntime; port?: number; suspend?: boolean } | null;
}

/**
 * An environment variable the configuration used: a name and its kind, and for a flag its default or
 * for an endpoint its URL. A secret never has a value. `environment` when it differs per environment.
 */
export interface SuggestedName { name: string; kind: 'secret' | 'endpoint' | 'flag'; default: string | null; environment: string | null }

/** One of several IDE configurations merged into one entry with arguments per environment. */
export interface SuggestionVariant { file: string | null; name: string | null; environment: string | null }

export interface Suggestion {
  index: number;
  source: SuggestionSource;
  variants: SuggestionVariant[];
  start: SuggestedStart;
  /** The entry exactly as the engine's applicationDraft holds it (validated there); null when it left it out. */
  draft: Record<string, unknown> | null;
  environmentNames: SuggestedName[];
  notes: string[];
  /** Why this one cannot be kept as written; null when it can. */
  refusal: string | null;
}

export interface SuggestionSet {
  capability: string;
  repository: string | null;
  suggestions: Suggestion[];
  /**
   * The capability's application block as the engine's applicationDraft keeps it: the start entries
   * already declared and its tests. `--application-file` replaces the whole block, so these are
   * written back unchanged around the kept suggestions. Null when the draft could not be read.
   */
  existing: { start: Array<Record<string, unknown>>; tests: unknown[] | null } | null;
  /** The engine's own notes, and what it read and skipped. */
  notes: string[];
  files: { read: number | null; skipped: Array<{ file: string; reason: string }> };
  /** Suggestions the engine returned that VS Code cannot write exactly, with why. */
  dropped: string[];
  /** The engine's YAML additions for singularity/environments.yml: names, kinds and non-secret defaults. */
  environmentsDraft: string | null;
  /** Why the engine's additions are not shown, when they are not. */
  environmentsNote: string | null;
}

/** A relative path inside the repository: no `..`, not absolute, no control characters. */
export function repositoryRelative(value: unknown): string | null {
  const path = text(value);
  if (!path || CONTROL.test(path) || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return null;
  const parts = path.replaceAll('\\', '/').split('/');
  return parts.includes('..') ? null : path.replaceAll('\\', '/');
}

/**
 * The first argument that looks like it carries a secret value: `--db-password=…`,
 * `-Dspring.datasource.password=…`, `TOKEN=…`, or `--token …` followed by a value. A placeholder
 * such as `${DB_PASSWORD}` is a reference, not a value.
 */
export function secretArgument(argv: readonly string[]): { index: number; name: string } | null {
  for (const [index, argument] of argv.entries()) {
    const pair = /^(?:--?|-D)?([A-Za-z_][\w.-]*)=(.*)$/s.exec(argument);
    if (pair && SECRET_NAME.test(pair[1]!) && pair[2] && !PLACEHOLDER.test(pair[2])) return { index, name: pair[1]! };
    const flag = /^--?([A-Za-z_][\w.-]*)$/.exec(argument);
    const next = argv[index + 1];
    if (flag && SECRET_NAME.test(flag[1]!) && next !== undefined && !next.startsWith('-') && !PLACEHOLDER.test(next)) {
      return { index: index + 1, name: flag[1]! };
    }
  }
  return null;
}

/** An argv for reading: a value that looks secret is shown as `[hidden]`, never as itself. */
export function maskedArgv(argv: readonly string[]): string[] {
  const masked = [...argv];
  let remaining = argv;
  let offset = 0;
  for (let found = secretArgument(remaining); found; found = secretArgument(remaining)) {
    const at = offset + found.index;
    const argument = masked[at]!;
    masked[at] = argument.includes('=') && argument.split('=')[0]!.replace(/^(?:--?|-D)/, '') === found.name
      ? `${argument.slice(0, argument.indexOf('=') + 1)}[hidden]` : '[hidden]';
    offset = at + 1;
    remaining = argv.slice(offset);
  }
  return masked;
}

function readyFrom(value: unknown): SuggestedStart['ready'] {
  const ready = record(value);
  if (!ready) return null;
  const timeout = typeof ready.timeoutMs === 'number' && Number.isInteger(ready.timeoutMs)
    && ready.timeoutMs >= 1_000 && ready.timeoutMs <= 600_000 ? ready.timeoutMs : null;
  const http = typeof ready.http === 'string' && ready.http.startsWith('/') && !CONTROL.test(ready.http) ? ready.http : null;
  const log = typeof ready.log === 'string' && ready.log.length <= 200 && !CONTROL.test(ready.log) ? ready.log : null;
  if (!http && !log) return null;
  return { ...(http ? { http } : { log: log! }), ...(timeout ? { timeoutMs: timeout } : {}) };
}

function namesFrom(value: unknown): SuggestedName[] {
  if (!Array.isArray(value)) return [];
  // A variable that differs per environment comes once per environment; only an exact repeat is dropped.
  const seen = new Set<string>();
  return value.flatMap((item): SuggestedName[] => {
    const entry = record(item);
    const name = text(entry?.name);
    const scope = text(entry?.environment) ?? '';
    if (!entry || !name || !VARIABLE.test(name) || seen.has(`${name}\u0000${scope}`)) return [];
    seen.add(`${name}\u0000${scope}`);
    const declared = text(entry.kind);
    // A secret-looking name is a secret even when the engine called it something else.
    const kind = declared === 'secret' || SECRET_NAME.test(name) ? 'secret' : declared === 'endpoint' ? 'endpoint' : 'flag';
    const raw = typeof entry.default === 'string' && !CONTROL.test(entry.default) ? entry.default : null;
    const given = typeof entry.value === 'string' && !CONTROL.test(entry.value) ? entry.value : null;
    let fallback: string | null = null;
    const environment = text(entry.environment) && ENVIRONMENT.test(String(entry.environment)) ? String(entry.environment) : null;
    if (kind === 'flag') fallback = raw ?? given;
    if (kind === 'endpoint' && (given ?? raw)) {
      const value = (given ?? raw)!;
      try {
        const url = new URL(value);
        fallback = url.username || url.password ? null : value;
      } catch { fallback = null; }
    }
    return [{ name, kind, default: fallback, environment }];
  });
}

/** `app suggest --json`, read field by field; a suggestion VS Code cannot write exactly is set aside with why. */
export function suggestionsFrom(raw: unknown): SuggestionSet | null {
  const answer = record(unwrapResult(raw));
  if (!answer || answer.resultType !== undefined && answer.resultType !== 'sflow-app-suggestions') return null;
  const capability = text(answer.capability);
  if (!capability || !CAPABILITY.test(capability)) return null;
  const draft = draftBlock(answer.applicationDraft);
  const suggestionIds = new Set((Array.isArray(answer.suggestions) ? answer.suggestions : [])
    .map((item) => text(record(record(item)?.start)?.id)).filter(Boolean));
  const drafted = new Map((draft?.start ?? []).flatMap((entry) => {
    const id = text(entry.id);
    return id && suggestionIds.has(id) ? [[id, entry] as const] : [];
  }));
  const suggestions: Suggestion[] = [];
  const dropped: string[] = [];
  for (const [position, item] of (Array.isArray(answer.suggestions) ? answer.suggestions : []).entries()) {
    const entry = record(item);
    const source = record(entry?.source);
    const start = record(entry?.start);
    const label = text(source?.name) ?? text(start?.id) ?? `suggestion ${position + 1}`;
    const argv = strings(start?.argv);
    if (!entry || !start || !argv) { dropped.push(`${label}: it has no command VS Code can run exactly`); continue; }
    const workingDirectory = start.workingDirectory == null || start.workingDirectory === '' ? null : repositoryRelative(start.workingDirectory);
    if (start.workingDirectory != null && start.workingDirectory !== '' && !workingDirectory) {
      dropped.push(`${label}: its working directory ${JSON.stringify(start.workingDirectory)} is outside the repository`);
      continue;
    }
    const argumentsMap: Record<string, string[]> = {};
    for (const [name, list] of Object.entries(record(start.arguments) ?? {})) {
      const values = strings(list, 64);
      if (ENVIRONMENT.test(name) && values) argumentsMap[name] = values;
    }
    const declared = (Array.isArray(start.environments) ? start.environments : []).filter((name): name is string =>
      typeof name === 'string' && ENVIRONMENT.test(name));
    // `arguments` keys must be environments of the entry; the first one is the default.
    const environments = [...new Set([...declared, ...Object.keys(argumentsMap)])];
    const debug = record(start.debug);
    const runtime = text(debug?.runtime) as DebugRuntime | null;
    const notes = (Array.isArray(entry.notes) ? entry.notes : []).filter((note): note is string => typeof note === 'string' && !CONTROL.test(note));
    const url = start.url == null ? null : loopbackUrl(text(start.url));
    if (start.url != null && !url) notes.push('Its URL was left out: a start entry opens only on 127.0.0.1, localhost or [::1].');
    const id = text(start.id)?.trim() ?? '';
    const own = drafted.get(id) ?? null;
    const ownArguments = Object.values(record(own?.arguments) ?? {}).map((list) => strings(list, 64) ?? []);
    const secret = [argv, ...Object.values(argumentsMap), strings(own?.argv) ?? [], ...ownArguments].map(secretArgument).find(Boolean);
    const variants = (Array.isArray(entry.variants) ? entry.variants : []).flatMap((value): SuggestionVariant[] => {
      const variant = record(value);
      return variant ? [{ file: repositoryRelative(variant.file), name: text(variant.name) && !CONTROL.test(String(variant.name)) ? String(variant.name) : null,
        environment: text(variant.environment) && ENVIRONMENT.test(String(variant.environment)) ? String(variant.environment) : null }] : [];
    });
    suggestions.push({
      index: suggestions.length,
      source: {
        kind: text(source?.kind) ?? 'detected',
        words: SOURCE_WORDS[text(source?.kind) ?? 'detected'] ?? String(source?.kind),
        file: repositoryRelative(source?.file), name: text(source?.name)
      },
      variants,
      draft: own,
      start: {
        id, repository: text(start.repository) && ENVIRONMENT.test(String(start.repository)) ? String(start.repository) : null,
        argv, workingDirectory, url, ready: readyFrom(start.ready), environments, arguments: argumentsMap,
        debug: runtime && DEBUG_RUNTIMES.includes(runtime) ? {
          runtime,
          ...(debugPort(debug?.port) && runtime !== 'dotnet' ? { port: debugPort(debug?.port)! } : {}),
          ...((runtime === 'java' || runtime === 'node') && typeof debug?.suspend === 'boolean' ? { suspend: debug.suspend } : {})
        } : null
      },
      environmentNames: namesFrom(entry.environmentNames),
      notes,
      refusal: secret
        ? `An argument looks like it carries the value of ${secret.name}. Move it to singularity/environments.yml as a secret and bind it with env bind; this suggestion cannot be kept as written.`
        : !draft ? 'The engine\'s application draft could not be read, so nothing can be proposed from it.'
          : !own ? 'The engine left this one out of its application draft (its notes say why), so it cannot be kept.'
            : null
    });
  }
  const checked = checkedEnvironmentsDraft(typeof answer.environmentsDraft === 'string' && answer.environmentsDraft.trim() ? answer.environmentsDraft : null);
  const files = record(answer.files);
  return {
    capability, repository: text(answer.repository), suggestions, dropped,
    existing: draft ? { start: draft.start.filter((entry) => !suggestionIds.has(text(entry.id) ?? '')), tests: draft.tests } : null,
    notes: (Array.isArray(answer.notes) ? answer.notes : []).filter((note): note is string => typeof note === 'string' && !CONTROL.test(note)),
    files: {
      read: typeof files?.read === 'number' && Number.isInteger(files.read) ? files.read : null,
      skipped: (Array.isArray(files?.skipped) ? files.skipped : []).flatMap((value) => {
        const skipped = record(value);
        const path = repositoryRelative(skipped?.file);
        const reason = text(skipped?.reason);
        return path && reason && !CONTROL.test(reason) ? [{ file: path, reason }] : [];
      })
    },
    environmentsDraft: checked.draft, environmentsNote: checked.note
  };
}

/**
 * The engine's applicationDraft: the capability's whole application block, its existing entries
 * first, then the suggested ones (each one checked by the engine). '' means it drafted none.
 */
function draftBlock(value: unknown): { start: Array<Record<string, unknown>>; tests: unknown[] | null } | null {
  if (typeof value !== 'string') return null;
  if (!value.trim()) return { start: [], tests: null };
  let parsed: unknown;
  try { parsed = YAML.parse(value); } catch { return null; }
  const block = record(parsed);
  if (!block || !Array.isArray(block.start)) return null;
  const start = block.start.flatMap((entry) => record(entry) ? [record(entry)!] : []);
  return { start, tests: Array.isArray(block.tests) && block.tests.length ? block.tests : null };
}

/**
 * The engine's environments.yml additions, shown and copied only when no secret requirement in them
 * carries a `value` or `default` (environments.yml refuses one too). The note never repeats a value.
 */
export function checkedEnvironmentsDraft(draft: string | null): { draft: string | null; note: string | null } {
  if (!draft) return { draft: null, note: null };
  let parsed: unknown;
  try { parsed = YAML.parse(draft); } catch {
    return { draft: null, note: 'The suggested singularity/environments.yml additions are not shown: VS Code could not read them as YAML.' };
  }
  const leaks = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    const object = record(value);
    if (!object) return;
    const name = text(object.name);
    if (name && (object.kind === 'secret' || SECRET_NAME.test(name)) && (object.value !== undefined || object.default !== undefined)) leaks.add(name);
    Object.values(object).forEach(visit);
  };
  visit(parsed);
  return leaks.size
    ? { draft: null, note: `The suggested singularity/environments.yml additions are not shown: they give a value for ${[...leaks].join(', ')}, which is a secret. Declare it by name only and bind it with env bind.` }
    : { draft, note: null };
}

/** Which suggestions the person keeps, and the start ID each one gets. */
export interface SuggestionChoice { index: number; keep: boolean; id: string }

/** Nothing is kept until the person ticks it: a repository can suggest many more entries than it wants. */
export function defaultSelection(set: SuggestionSet): SuggestionChoice[] {
  return set.suggestions.map((suggestion) => ({ index: suggestion.index, keep: false, id: suggestion.start.id }));
}

/** The page's ticks and IDs, for suggestions the page was shown; anything else is ignored. */
export function selectionFrom(raw: unknown, set: SuggestionSet): SuggestionChoice[] {
  const given = new Map<number, SuggestionChoice>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = record(item);
    const index = typeof entry?.index === 'number' && Number.isInteger(entry.index) ? entry.index : -1;
    if (!entry || !set.suggestions[index] || given.has(index)) continue;
    given.set(index, { index, keep: entry.keep === true, id: typeof entry.id === 'string' ? entry.id.trim().slice(0, 64) : '' });
  }
  return set.suggestions.map((suggestion) => given.get(suggestion.index) ?? { index: suggestion.index, keep: false, id: suggestion.start.id });
}

/** What stops the kept suggestions being written: per suggestion, and for the whole selection. */
export function selectionProblems(set: SuggestionSet, selection: SuggestionChoice[], declaredIds: readonly string[]):
  { rows: Record<number, string>; general: string | null } {
  const rows: Record<number, string> = {};
  const kept = selection.filter((choice) => choice.keep);
  const counts = new Map<string, number>();
  for (const choice of kept) counts.set(choice.id, (counts.get(choice.id) ?? 0) + 1);
  for (const choice of kept) {
    const suggestion = set.suggestions[choice.index]!;
    if (suggestion.refusal) rows[choice.index] = suggestion.refusal;
    else if (!START_ID.test(choice.id)) rows[choice.index] = 'A start ID is lower-case kebab case, for example api or web-dev.';
    else if (declaredIds.includes(choice.id)) rows[choice.index] = `${choice.id} is already a start entry of ${set.capability}. Choose another ID.`;
    else if ((counts.get(choice.id) ?? 0) > 1) rows[choice.index] = `Two kept suggestions are both called ${choice.id}. Give each its own ID.`;
  }
  return { rows, general: kept.length ? null : 'Keep at least one suggestion to propose it.' };
}

/** The kept entries, renamed, in the order the engine suggested them: each one as the engine drafted it. */
export function keptStarts(set: SuggestionSet, selection: SuggestionChoice[]): Array<{ entry: Record<string, unknown>; id: string; suggestion: Suggestion }> {
  return selection.filter((choice) => choice.keep && set.suggestions[choice.index]?.draft).map((choice) => {
    const suggestion = set.suggestions[choice.index]!;
    return { suggestion, id: choice.id, entry: { ...suggestion.draft!, id: choice.id } };
  });
}

/**
 * The whole application block VS Code writes to the private file, exactly as the review page shows
 * it: the entries already declared, unchanged, then the kept ones, then the declared tests. It is the
 * engine's applicationDraft with only the person's choices applied. Short lists use flow style.
 */
export function applicationDraftYaml(existing: NonNullable<SuggestionSet['existing']>, kept: Array<Record<string, unknown>>): string {
  const document = new YAML.Document({ start: [...existing.start, ...kept], ...(existing.tests ? { tests: existing.tests } : {}) });
  YAML.visit(document, { Seq(_key, node, path) { if (path.length > 3) node.flow = true; } });
  return document.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** How the application block leaves this window: a reviewed proposal to the map's authority, or this checkout. */
export type ApplicationRoute = { kind: 'proposal'; lead: string } | { kind: 'local' };

/**
 * The capability page's choice: an implicit map is edited here; an explicit one is proposed to its
 * approved authority, or to the one registered lead repository. Several leads ask which one; none
 * leaves a local authoring change in this checkout.
 */
export function applicationRoute(mode: string | null | undefined, authorityRepository: string | null | undefined,
  leads: readonly string[]): ApplicationRoute | { kind: 'pick'; leads: string[] } {
  if (mode === 'implicit') return { kind: 'local' };
  if (authorityRepository?.trim()) return { kind: 'proposal', lead: authorityRepository.trim() };
  const known = [...new Set(leads.filter((lead) => typeof lead === 'string' && lead.trim()))];
  if (!known.length) return { kind: 'local' };
  return known.length === 1 ? { kind: 'proposal', lead: known[0]! } : { kind: 'pick', leads: known };
}

/** `capability edit <ID> --lead <URL> --mode set --application-file <FILE> --json`, or `capability set … --json`. */
export function applicationWriteArgv(route: ApplicationRoute, capability: string, file: string): string[] {
  if (!CAPABILITY.test(capability)) throw new Error(`Capability is invalid: ${capability}`);
  return route.kind === 'proposal'
    ? capabilityProposalArgv('set', capability, route.lead, {}, { applicationFile: file })
    : [...capabilityArgv('set', capability, {}, { applicationFile: file }), '--json'];
}

/** The engine's answer: a proposal branch to review, a local save, or nothing to change. */
export function applicationWriteOutcome(route: ApplicationRoute, result: unknown):
  { kind: 'proposal'; lead: string; branch: string } | { kind: 'local'; path: string | null } | { kind: 'unchanged' } {
  const answer = record(unwrapResult(result)) ?? {};
  if (route.kind === 'proposal') {
    const branch = text(answer.branch);
    return branch ? { kind: 'proposal', lead: text(answer.lead) ?? route.lead, branch } : { kind: 'unchanged' };
  }
  return answer.changed === false ? { kind: 'unchanged' } : { kind: 'local', path: text(answer.path) };
}

export const TEMPORARY_FILE_WORDS = '<private temporary file>';

/** The review page: the exact YAML written, the environments.yml additions to copy, and the command. */
export function suggestionReviewRequest(input: {
  capability: string; kept: Array<{ id: string; suggestion: Suggestion }>; route: ApplicationRoute;
  applicationYaml: string; environmentsDraft: string | null; existing: NonNullable<SuggestionSet['existing']>;
}): ReviewConfirmationRequest {
  const { capability, kept, route, applicationYaml, environmentsDraft, existing } = input;
  const declaredIds = existing.start.map((entry) => text(entry.id)).filter(Boolean);
  const from = (suggestion: Suggestion) => [suggestion.source.words, suggestion.source.file].filter(Boolean).join(', ');
  return {
    title: route.kind === 'proposal' ? `Propose start entries for ${capability}` : `Save start entries for ${capability}`,
    summary: route.kind === 'proposal'
      ? 'The capability\'s application block becomes the block below, through a reviewed capability proposal. Its review page shows the resulting singularity/capabilities.yml before anything is approved.'
      : 'The capability\'s application block in singularity/capabilities.yml in this checkout becomes the block below, as a local authoring change: nothing is proposed or committed.',
    detail: [
      `Capability: ${capability}`,
      `Start entries added: ${kept.map(({ id, suggestion }) => `${id} (from ${from(suggestion)})`).join('; ')}`,
      `Start entries already declared, kept as they are: ${declaredIds.length ? declaredIds.join(', ') : 'none'}`,
      `Tests already declared, kept as they are: ${existing.tests ? existing.tests.length : 'none'}`,
      route.kind === 'proposal' ? `Proposed to: ${route.lead}` : 'Written to: singularity/capabilities.yml in this checkout',
      '',
      'Application block. It replaces the capability\'s whole block; VS Code writes exactly this to a private temporary file, passes it to the command below, then deletes the file:',
      applicationYaml.trimEnd(),
      '',
      environmentsDraft
        ? `Additions for singularity/environments.yml. VS Code does not write these: copy them from the suggestion page into a configuration proposal. Secrets are names only; bind each with singularity-flow env bind <ENVIRONMENT> --stdin.\n${environmentsDraft.trimEnd()}`
        : 'Additions for singularity/environments.yml: none suggested.',
      '',
      `VS Code runs: ${displayCommand(applicationWriteArgv(route, capability, TEMPORARY_FILE_WORDS))}`
    ].join('\n'),
    confirmLabel: route.kind === 'proposal' ? 'Propose these start entries' : 'Save these start entries'
  };
}

/** `app suggest --capability <ID> --json`: a read; nothing is written. */
export const appSuggestArgv = (capability: string): string[] => {
  if (!CAPABILITY.test(capability)) throw new Error(`Capability is invalid: ${capability}`);
  return ['app', 'suggest', '--capability', capability, '--json'];
};

/** The note beside the environments.yml additions: VS Code has no environments.yml proposal of its own yet. */
export const ENVIRONMENTS_NOTE = 'VS Code does not edit singularity/environments.yml. Copy these additions into it, then propose the whole file through a configuration proposal: singularity-flow configuration save singularity/environments.yml --propose (the file on standard input). Secrets are names only: bind their values with your own secret helper, singularity-flow env bind <ENVIRONMENT> --stdin.';
