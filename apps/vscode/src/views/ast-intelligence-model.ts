/** Pure AST-intelligence settings projection and governed YAML editing. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export type AstMode = 'auto' | 'off';
export type AstFallback = 'host-and-text' | 'text-only';
export type AstAssurance = 'text' | 'syntax' | 'semantic';
export type AstEvidenceMode = 'replayable' | 'identified' | 'off';
export type AstStoryStartWarmMode = 'background' | 'before-first-phase' | 'off';
export type AstStoryStartWarmScope = 'configured-roots' | 'repository';

export interface AstLanguageDraft {
  language: string;
  mode: AstMode;
  minimumAssurance: AstAssurance;
  syntaxProvider: string | null;
  semanticProvider: string | null;
  semanticProfile: string | null;
}

export interface AstPredicateDraft {
  id: string;
  mode: 'required' | 'advisory';
  type: 'path-exists' | 'symbol-exists' | 'import-boundary' | 'annotation-present'
    | 'inherits-from' | 'conforms-to' | 'override-exists' | 'public-signature-changed' | 'module-dependency';
  target: string;
  secondary?: string;
  languages?: string[];
  profiles?: string[];
  minimumAssurance: AstAssurance;
}

export interface AstPolicyDraft {
  mode: AstMode;
  fallback: AstFallback;
  evidence: { mode: AstEvidenceMode; store: string };
  warmOnStoryStart: { mode: AstStoryStartWarmMode; scope: AstStoryStartWarmScope };
  generatedRoots: string[];
  budgets: { maxFiles: number; maxBytes: number; maxFileBytes: number };
  languages: AstLanguageDraft[];
  predicates: AstPredicateDraft[];
}

export type AstPolicyPreset = 'automatic' | 'off' | 'custom';

/** The quiet, bounded policy used when a repository chooses the recommended automatic setup. */
export function recommendedAstPolicyDraft(): AstPolicyDraft {
  return {
    mode: 'auto',
    fallback: 'host-and-text',
    evidence: { mode: 'identified', store: 'local-directory' },
    warmOnStoryStart: { mode: 'background', scope: 'configured-roots' },
    generatedRoots: [],
    budgets: { maxFiles: 500, maxBytes: 20 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024 },
    languages: [],
    predicates: []
  };
}

/** Project the detailed schema into the three choices a normal settings page needs. */
export function astPolicyPreset(policy: AstPolicyDraft): AstPolicyPreset {
  if (policy.mode === 'off') return 'off';
  const recommended = recommendedAstPolicyDraft();
  const usesRecommendedDetails = policy.fallback === recommended.fallback
    && policy.evidence.mode === recommended.evidence.mode
    && policy.evidence.store === recommended.evidence.store
    && policy.warmOnStoryStart.mode === recommended.warmOnStoryStart.mode
    && policy.warmOnStoryStart.scope === recommended.warmOnStoryStart.scope
    && policy.budgets.maxFiles === recommended.budgets.maxFiles
    && policy.budgets.maxBytes === recommended.budgets.maxBytes
    && policy.budgets.maxFileBytes === recommended.budgets.maxFileBytes
    && policy.generatedRoots.length === 0
    && policy.languages.length === 0
    && policy.predicates.length === 0;
  return usesRecommendedDetails ? 'automatic' : 'custom';
}

/** The shared editor context this repository-scoped screen is acting on. */
export interface AstRepositoryScope {
  root: string;
  workspaceId: string | null;
  workspaceName: string | null;
  repositoryId: string | null;
  origin: string;
}

export interface AstRepositoryScopeView {
  workspace: string;
  repository: string;
  root: string;
  origin: string;
  key: string;
}

export interface AstWorkspaceRepositoryChoice {
  id: string;
  role: string | null;
  state: string | null;
}

export interface AstWorkspaceRepositoryInventory {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  selectedRepositoryId: string | null;
  repositories: AstWorkspaceRepositoryChoice[];
}

/** Project the CLI's workspace inventory into the closed repository choices the page may post. */
export function astWorkspaceRepositoryInventory(
  current: {
    active?: boolean; workspaceId?: string; workspaceName?: string; workspacePath?: string;
    repositoryId?: string;
  },
  status: { repositories?: Array<{ id?: string; role?: string; state?: string }> }
): AstWorkspaceRepositoryInventory | null {
  if (current.active !== true || !current.workspaceId || !current.workspacePath) return null;
  const repositories = (status.repositories ?? [])
    .filter((repository): repository is { id: string; role?: string; state?: string } =>
      typeof repository.id === 'string' && Boolean(repository.id.trim()))
    .map((repository) => ({
      id: repository.id,
      role: repository.role?.trim() || null,
      state: repository.state?.trim() || null
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    workspaceId: current.workspaceId,
    workspaceName: current.workspaceName?.trim() || current.workspaceId,
    workspacePath: current.workspacePath,
    selectedRepositoryId: current.repositoryId?.trim() || null,
    repositories
  };
}

/**
 * Give the webview a human-readable identity and a non-authoritative stale-screen key.
 *
 * The key is deliberately not a handle or permission. It merely prevents a form rendered for one
 * repository from being submitted after the extension has atomically switched its shared context
 * to another repository. The CLI remains the authority for every operation.
 */
export function astRepositoryScopeView(scope: AstRepositoryScope): AstRepositoryScopeView {
  const repository = scope.repositoryId?.trim() || path.basename(scope.root) || scope.root;
  const workspace = scope.workspaceName?.trim() || scope.workspaceId?.trim() || 'Open repository';
  const key = createHash('sha256').update(JSON.stringify({
    root: path.resolve(scope.root),
    workspaceId: scope.workspaceId,
    repositoryId: scope.repositoryId
  })).digest('hex');
  return { workspace, repository, root: path.resolve(scope.root), origin: scope.origin, key };
}

const MODES = new Set<AstMode>(['auto', 'off']);
const FALLBACKS = new Set<AstFallback>(['host-and-text', 'text-only']);
const ASSURANCE = new Set<AstAssurance>(['text', 'syntax', 'semantic']);
const ID = /^[a-z][a-z0-9-]*$/;
const PREDICATE_TYPES = new Set<AstPredicateDraft['type']>([
  'path-exists', 'symbol-exists', 'import-boundary', 'annotation-present', 'inherits-from',
  'conforms-to', 'override-exists', 'public-signature-changed', 'module-dependency'
]);
const RICH_PREDICATES = new Set<AstPredicateDraft['type']>([...PREDICATE_TYPES].filter((type) => !['path-exists', 'symbol-exists'].includes(type)));

function predicateProjection(value: Record<string, unknown>): AstPredicateDraft {
  const type = PREDICATE_TYPES.has(value.type as AstPredicateDraft['type'])
    ? value.type as AstPredicateDraft['type'] : 'path-exists';
  const primary = ['path-exists', 'import-boundary', 'public-signature-changed'].includes(type)
    ? value.path : type === 'module-dependency' ? value.module : value.symbol;
  const secondary = type === 'annotation-present' ? value.annotation
    : ['inherits-from', 'conforms-to', 'override-exists', 'import-boundary', 'module-dependency'].includes(type) ? value.target
      : type === 'public-signature-changed' ? value.expectedSha256 : null;
  return {
    id: String(value.id ?? ''), mode: value.mode === 'required' ? 'required' : 'advisory', type,
    target: String(primary ?? ''), minimumAssurance: ASSURANCE.has(value.minimumAssurance as AstAssurance)
      ? value.minimumAssurance as AstAssurance : 'text',
    ...(RICH_PREDICATES.has(type) ? {
      secondary: String(secondary ?? ''),
      languages: Array.isArray(value.languages) ? value.languages.map(String) : [],
      profiles: Array.isArray(value.profiles) ? value.profiles.map(String) : []
    } : {})
  };
}

function unsafeRelative(value: string): boolean {
  return !value || value === '.' || value.includes('\\') || /^(?:\/|[A-Za-z]:[\\/])/.test(value)
    || value.split('/').includes('..') || /[*?\[\]{}]/.test(value);
}

/** Project normalized defaults even when an older repository has no `ast` block yet. */
export function astPolicyView(snapshot: Pick<RepositorySnapshot, 'definition'>): AstPolicyDraft {
  const raw = (snapshot.definition?.ast ?? {}) as Record<string, unknown>;
  const budgets = (raw.budgets && typeof raw.budgets === 'object' ? raw.budgets : {}) as Record<string, unknown>;
  const languages = (raw.languages && typeof raw.languages === 'object' && !Array.isArray(raw.languages)
    ? raw.languages : {}) as Record<string, Record<string, unknown>>;
  const predicates = Array.isArray(raw.predicates) ? raw.predicates as Array<Record<string, unknown>> : [];
  const evidence = (raw.evidence && typeof raw.evidence === 'object' && !Array.isArray(raw.evidence)
    ? raw.evidence : {}) as Record<string, unknown>;
  const storyStart = (raw.warmOnStoryStart && typeof raw.warmOnStoryStart === 'object'
    && !Array.isArray(raw.warmOnStoryStart) ? raw.warmOnStoryStart : {}) as Record<string, unknown>;
  const recommended = recommendedAstPolicyDraft();
  return {
    mode: raw.mode === 'off' ? 'off' : 'auto',
    fallback: raw.fallback === 'text-only' ? 'text-only' : 'host-and-text',
    evidence: {
      mode: evidence.mode === 'replayable' || evidence.mode === 'off' || evidence.mode === 'identified'
        ? evidence.mode : recommended.evidence.mode,
      store: typeof evidence.store === 'string' && evidence.store ? evidence.store : 'local-directory'
    },
    warmOnStoryStart: {
      mode: storyStart.mode === 'off' || storyStart.mode === 'before-first-phase'
        ? storyStart.mode : 'background',
      scope: storyStart.scope === 'repository' ? 'repository' : 'configured-roots'
    },
    generatedRoots: Array.isArray(raw.generatedRoots) ? raw.generatedRoots.filter((entry): entry is string => typeof entry === 'string') : [],
    budgets: {
      maxFiles: Number.isInteger(budgets.maxFiles) ? Number(budgets.maxFiles) : recommended.budgets.maxFiles,
      maxBytes: Number.isInteger(budgets.maxBytes) ? Number(budgets.maxBytes) : recommended.budgets.maxBytes,
      maxFileBytes: Number.isInteger(budgets.maxFileBytes) ? Number(budgets.maxFileBytes) : recommended.budgets.maxFileBytes
    },
    languages: Object.entries(languages).map(([language, value]): AstLanguageDraft => ({
      language,
      mode: value.mode === 'off' ? 'off' : 'auto',
      minimumAssurance: ASSURANCE.has(value.minimumAssurance as AstAssurance)
        ? value.minimumAssurance as AstAssurance : 'text',
      syntaxProvider: typeof value.syntaxProvider === 'string' && value.syntaxProvider ? value.syntaxProvider : null,
      semanticProvider: typeof value.semanticProvider === 'string' && value.semanticProvider ? value.semanticProvider : null,
      semanticProfile: typeof value.semanticProfile === 'string' && value.semanticProfile ? value.semanticProfile : null
    })).sort((left, right) => left.language.localeCompare(right.language)),
    predicates: predicates.map(predicateProjection)
  };
}

export function validateAstPolicyDraft(draft: AstPolicyDraft): string[] {
  const errors: string[] = [];
  if (!MODES.has(draft.mode)) errors.push('Repository AST mode must be auto or off.');
  if (!FALLBACKS.has(draft.fallback)) errors.push('Fallback must be host-and-text or text-only.');
  if (!['replayable', 'identified', 'off'].includes(draft.evidence.mode)) errors.push('Evidence mode must be replayable, identified, or off.');
  if (!ID.test(draft.evidence.store)) errors.push('Evidence store must be a lower-case kebab-case logical identifier.');
  if (!['background', 'before-first-phase', 'off'].includes(draft.warmOnStoryStart.mode)) {
    errors.push('Story-start warming must be background, before-first-phase, or off.');
  }
  if (!['configured-roots', 'repository'].includes(draft.warmOnStoryStart.scope)) {
    errors.push('Story-start warming scope must be configured-roots or repository.');
  }
  for (const [name, value] of Object.entries(draft.budgets)) {
    if (!Number.isInteger(value) || value < 1) errors.push(`${name} must be a positive whole number.`);
  }
  if (new Set(draft.generatedRoots).size !== draft.generatedRoots.length) errors.push('Generated roots must not contain duplicates.');
  for (const root of draft.generatedRoots) {
    if (unsafeRelative(root.trim())) errors.push(`Generated root '${root}' must be a repository-relative directory without '..' or glob characters.`);
  }
  const languages = new Set<string>();
  for (const row of draft.languages) {
    if (!ID.test(row.language)) errors.push(`Language '${row.language}' must be lower-case kebab-case.`);
    if (languages.has(row.language)) errors.push(`Language '${row.language}' is duplicated.`);
    languages.add(row.language);
    if (!MODES.has(row.mode)) errors.push(`Language '${row.language}' mode must be auto or off.`);
    if (!ASSURANCE.has(row.minimumAssurance)) errors.push(`Language '${row.language}' assurance is invalid.`);
    for (const [label, provider] of [['syntax', row.syntaxProvider], ['semantic', row.semanticProvider]] as const) {
      if (provider && !ID.test(provider)) errors.push(`Language '${row.language}' ${label} provider must be a lower-case pack id.`);
    }
    if (row.semanticProfile != null && !row.semanticProfile.trim()) errors.push(`Language '${row.language}' semantic profile cannot be empty.`);
  }
  const predicates = new Set<string>();
  for (const row of draft.predicates) {
    // Predicate identifiers predate the language-key convention and the engine accepts any
    // non-empty identifier. Do not make an existing valid policy uneditable in the guided UI.
    if (!row.id.trim()) errors.push('Every predicate needs an identifier.');
    if (predicates.has(row.id)) errors.push(`Predicate '${row.id}' is duplicated.`);
    predicates.add(row.id);
    if (!['required', 'advisory'].includes(row.mode)) errors.push(`Predicate '${row.id}' mode is invalid.`);
    if (!PREDICATE_TYPES.has(row.type)) errors.push(`Predicate '${row.id}' type is invalid.`);
    if (!row.target.trim()) errors.push(`Predicate '${row.id}' needs a path or symbol.`);
    if (['path-exists', 'import-boundary', 'public-signature-changed'].includes(row.type) && unsafeRelative(row.target.trim())) errors.push(`Predicate '${row.id}' path must be repository-relative.`);
    if (RICH_PREDICATES.has(row.type)) {
      if (!(row.languages?.length) || !(row.profiles?.length)) errors.push(`Predicate '${row.id}' must declare applicable languages and profiles (use * explicitly).`);
      if (!row.secondary?.trim()) errors.push(`Predicate '${row.id}' requires its comparison value.`);
      if (row.type === 'public-signature-changed' && !/^[a-f0-9]{64}$/.test(row.secondary ?? '')) errors.push(`Predicate '${row.id}' expected signature must be a SHA-256 digest.`);
    }
    if (!ASSURANCE.has(row.minimumAssurance)) errors.push(`Predicate '${row.id}' assurance is invalid.`);
    if (row.mode === 'required' && row.type === 'symbol-exists' && row.minimumAssurance === 'text') {
      errors.push(`Required symbol predicate '${row.id}' must use syntax or semantic assurance; lexical text matches are advisory only.`);
    }
  }
  return errors;
}

function document(text: string): YAML.Document.Parsed {
  const parsed = YAML.parseDocument(text);
  if (parsed.errors.length) throw new Error(`workflow.yml is not valid YAML: ${parsed.errors[0]?.message}`);
  return parsed;
}

/** Update only the AST block; all unrelated workflow settings and YAML comments remain owned by the repository. */
export function updateAstPolicyYaml(text: string, draft: AstPolicyDraft): string {
  const errors = validateAstPolicyDraft(draft);
  if (errors.length) throw new Error(errors.join(' '));
  const parsed = document(text);
  parsed.setIn(['ast', 'mode'], draft.mode);
  parsed.setIn(['ast', 'fallback'], draft.fallback);
  parsed.setIn(['ast', 'evidence', 'mode'], draft.evidence.mode);
  if (draft.evidence.store === 'local-directory') parsed.deleteIn(['ast', 'evidence', 'store']);
  else parsed.setIn(['ast', 'evidence', 'store'], draft.evidence.store);
  parsed.setIn(['ast', 'warmOnStoryStart', 'mode'], draft.warmOnStoryStart.mode);
  parsed.setIn(['ast', 'warmOnStoryStart', 'scope'], draft.warmOnStoryStart.scope);
  parsed.setIn(['ast', 'generatedRoots'], draft.generatedRoots.map((entry) => entry.trim()));
  parsed.setIn(['ast', 'budgets', 'maxFiles'], draft.budgets.maxFiles);
  parsed.setIn(['ast', 'budgets', 'maxBytes'], draft.budgets.maxBytes);
  parsed.setIn(['ast', 'budgets', 'maxFileBytes'], draft.budgets.maxFileBytes);
  parsed.setIn(['ast', 'languages'], Object.fromEntries(draft.languages.map((row) => [row.language, {
    mode: row.mode, minimumAssurance: row.minimumAssurance,
    ...(row.syntaxProvider ? { syntaxProvider: row.syntaxProvider } : {}),
    ...(row.semanticProvider ? { semanticProvider: row.semanticProvider } : {}),
    ...(row.semanticProfile ? { semanticProfile: row.semanticProfile } : {})
  }])));
  parsed.setIn(['ast', 'predicates'], draft.predicates.map((row) => {
    const primary = ['path-exists', 'import-boundary', 'public-signature-changed'].includes(row.type)
      ? { path: row.target.trim() } : row.type === 'module-dependency'
        ? { module: row.target.trim() } : { symbol: row.target.trim() };
    const secondary = row.type === 'annotation-present' ? { annotation: row.secondary?.trim() }
      : ['inherits-from', 'conforms-to', 'override-exists', 'import-boundary', 'module-dependency'].includes(row.type)
        ? { target: row.secondary?.trim() }
        : row.type === 'public-signature-changed' ? { expectedSha256: row.secondary?.trim() } : {};
    return {
      id: row.id, mode: row.mode, type: row.type, ...primary, ...secondary,
      minimumAssurance: row.minimumAssurance,
      ...(RICH_PREDICATES.has(row.type) ? { languages: row.languages, profiles: row.profiles } : {})
    };
  }));
  return String(parsed);
}

export function parseAstLanguageRows(value: string): AstLanguageDraft[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [language = '', mode = '', minimumAssurance = '', syntaxProvider = '', semanticProvider = '', semanticProfile = ''] = line.split('|').map((part) => part.trim());
    return {
      language, mode: mode as AstMode, minimumAssurance: minimumAssurance as AstAssurance,
      syntaxProvider: syntaxProvider || null, semanticProvider: semanticProvider || null,
      semanticProfile: semanticProfile || null
    };
  });
}

export function parseAstPredicateRows(value: string): AstPredicateDraft[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [id = '', mode = '', type = '', target = '', minimumAssurance = '', languages = '', profiles = '', secondary = ''] = line.split('|').map((part) => part.trim());
    const typed = type as AstPredicateDraft['type'];
    return {
      id, mode: mode as AstPredicateDraft['mode'], type: typed,
      target, minimumAssurance: minimumAssurance as AstAssurance,
      ...(RICH_PREDICATES.has(typed) ? {
        languages: languages.split(',').map((entry) => entry.trim()).filter(Boolean),
        profiles: profiles.split(',').map((entry) => entry.trim()).filter(Boolean),
        secondary
      } : {})
    };
  });
}
