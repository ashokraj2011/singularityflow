/** Pure AST-intelligence settings projection and governed YAML editing. */
import YAML from 'yaml';
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export type AstMode = 'auto' | 'off';
export type AstFallback = 'host-and-text' | 'text-only';
export type AstAssurance = 'text' | 'syntax' | 'semantic';

export interface AstLanguageDraft {
  language: string;
  mode: AstMode;
  minimumAssurance: AstAssurance;
}

export interface AstPredicateDraft {
  id: string;
  mode: 'required' | 'advisory';
  type: 'path-exists' | 'symbol-exists';
  target: string;
  minimumAssurance: AstAssurance;
}

export interface AstPolicyDraft {
  mode: AstMode;
  fallback: AstFallback;
  generatedRoots: string[];
  budgets: { maxFiles: number; maxBytes: number; maxFileBytes: number };
  languages: AstLanguageDraft[];
  predicates: AstPredicateDraft[];
}

const MODES = new Set<AstMode>(['auto', 'off']);
const FALLBACKS = new Set<AstFallback>(['host-and-text', 'text-only']);
const ASSURANCE = new Set<AstAssurance>(['text', 'syntax', 'semantic']);
const ID = /^[a-z][a-z0-9-]*$/;

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
  return {
    mode: raw.mode === 'off' ? 'off' : 'auto',
    fallback: raw.fallback === 'text-only' ? 'text-only' : 'host-and-text',
    generatedRoots: Array.isArray(raw.generatedRoots) ? raw.generatedRoots.filter((entry): entry is string => typeof entry === 'string') : [],
    budgets: {
      maxFiles: Number.isInteger(budgets.maxFiles) ? Number(budgets.maxFiles) : 500,
      maxBytes: Number.isInteger(budgets.maxBytes) ? Number(budgets.maxBytes) : 20 * 1024 * 1024,
      maxFileBytes: Number.isInteger(budgets.maxFileBytes) ? Number(budgets.maxFileBytes) : 2 * 1024 * 1024
    },
    languages: Object.entries(languages).map(([language, value]): AstLanguageDraft => ({
      language,
      mode: value.mode === 'off' ? 'off' : 'auto',
      minimumAssurance: ASSURANCE.has(value.minimumAssurance as AstAssurance)
        ? value.minimumAssurance as AstAssurance : 'text'
    })).sort((left, right) => left.language.localeCompare(right.language)),
    predicates: predicates.map((value): AstPredicateDraft => ({
      id: String(value.id ?? ''),
      mode: value.mode === 'required' ? 'required' : 'advisory',
      type: value.type === 'symbol-exists' ? 'symbol-exists' : 'path-exists',
      target: String(value.type === 'symbol-exists' ? value.symbol ?? '' : value.path ?? ''),
      minimumAssurance: ASSURANCE.has(value.minimumAssurance as AstAssurance)
        ? value.minimumAssurance as AstAssurance : 'text'
    }))
  };
}

export function validateAstPolicyDraft(draft: AstPolicyDraft): string[] {
  const errors: string[] = [];
  if (!MODES.has(draft.mode)) errors.push('Repository AST mode must be auto or off.');
  if (!FALLBACKS.has(draft.fallback)) errors.push('Fallback must be host-and-text or text-only.');
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
  }
  const predicates = new Set<string>();
  for (const row of draft.predicates) {
    // Predicate identifiers predate the language-key convention and the engine accepts any
    // non-empty identifier. Do not make an existing valid policy uneditable in the guided UI.
    if (!row.id.trim()) errors.push('Every predicate needs an identifier.');
    if (predicates.has(row.id)) errors.push(`Predicate '${row.id}' is duplicated.`);
    predicates.add(row.id);
    if (!['required', 'advisory'].includes(row.mode)) errors.push(`Predicate '${row.id}' mode is invalid.`);
    if (!['path-exists', 'symbol-exists'].includes(row.type)) errors.push(`Predicate '${row.id}' type is invalid.`);
    if (!row.target.trim()) errors.push(`Predicate '${row.id}' needs a path or symbol.`);
    if (row.type === 'path-exists' && unsafeRelative(row.target.trim())) errors.push(`Predicate '${row.id}' path must be repository-relative.`);
    if (!ASSURANCE.has(row.minimumAssurance)) errors.push(`Predicate '${row.id}' assurance is invalid.`);
    if (row.mode === 'required' && row.type === 'symbol-exists' && row.minimumAssurance === 'text') {
      errors.push(`Required symbol predicate '${row.id}' must use syntax or semantic assurance; lexical text matches are advisory only.`);
    }
  }
  if (draft.mode === 'off' && draft.predicates.some((row) => row.mode === 'required')) {
    errors.push('Repository mode cannot be off while a required structural predicate exists.');
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
  parsed.setIn(['ast', 'generatedRoots'], draft.generatedRoots.map((entry) => entry.trim()));
  parsed.setIn(['ast', 'budgets', 'maxFiles'], draft.budgets.maxFiles);
  parsed.setIn(['ast', 'budgets', 'maxBytes'], draft.budgets.maxBytes);
  parsed.setIn(['ast', 'budgets', 'maxFileBytes'], draft.budgets.maxFileBytes);
  parsed.setIn(['ast', 'languages'], Object.fromEntries(draft.languages.map((row) => [row.language, {
    mode: row.mode, minimumAssurance: row.minimumAssurance
  }])));
  parsed.setIn(['ast', 'predicates'], draft.predicates.map((row) => ({
    id: row.id, mode: row.mode, type: row.type,
    ...(row.type === 'path-exists' ? { path: row.target.trim() } : { symbol: row.target.trim() }),
    minimumAssurance: row.minimumAssurance
  })));
  return String(parsed);
}

export function parseAstLanguageRows(value: string): AstLanguageDraft[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [language = '', mode = '', minimumAssurance = ''] = line.split('|').map((part) => part.trim());
    return { language, mode: mode as AstMode, minimumAssurance: minimumAssurance as AstAssurance };
  });
}

export function parseAstPredicateRows(value: string): AstPredicateDraft[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [id = '', mode = '', type = '', target = '', minimumAssurance = ''] = line.split('|').map((part) => part.trim());
    return {
      id, mode: mode as AstPredicateDraft['mode'], type: type as AstPredicateDraft['type'],
      target, minimumAssurance: minimumAssurance as AstAssurance
    };
  });
}
