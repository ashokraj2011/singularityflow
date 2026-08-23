import path from 'node:path';

import { recordSha256 } from './records.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

export const AST_LANGUAGE_CATALOG_SCHEMA_VERSION = currentSchemaVersion('ast-language-catalog');

const BUILTIN_ENTRIES = Object.freeze([
  { id: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], filenames: [], aliases: ['js'], priority: 100 },
  { id: 'typescript', extensions: ['.ts', '.tsx'], filenames: [], aliases: ['ts'], priority: 100 },
  { id: 'java', extensions: ['.java'], filenames: [], aliases: [], priority: 100 },
  { id: 'python', extensions: ['.py', '.pyi'], filenames: [], aliases: ['py'], priority: 100 },
  { id: 'kotlin', extensions: ['.kt', '.kts'], filenames: [], aliases: ['kotlin-script'], priority: 100 },
  { id: 'swift', extensions: ['.swift'], filenames: [], aliases: [], priority: 100 },
  { id: 'objective-c', extensions: ['.m'], filenames: [], aliases: ['objc'], priority: 90 },
  { id: 'objective-cpp', extensions: ['.mm'], filenames: [], aliases: ['objcpp'], priority: 90 },
  { id: 'go', extensions: ['.go'], filenames: [], aliases: [], priority: 100 },
  { id: 'rust', extensions: ['.rs'], filenames: [], aliases: [], priority: 100 },
  { id: 'csharp', extensions: ['.cs'], filenames: [], aliases: ['c-sharp'], priority: 100 },
  { id: 'ruby', extensions: ['.rb'], filenames: [], aliases: [], priority: 100 },
  { id: 'php', extensions: ['.php'], filenames: [], aliases: [], priority: 100 },
  { id: 'vue', extensions: ['.vue'], filenames: [], aliases: [], priority: 100 },
  { id: 'svelte', extensions: ['.svelte'], filenames: [], aliases: [], priority: 100 },
  { id: 'xml', extensions: ['.xml'], filenames: [], aliases: [], priority: 100 },
  { id: 'json', extensions: ['.json'], filenames: [], aliases: [], priority: 100 },
  { id: 'yaml', extensions: ['.yaml', '.yml'], filenames: [], aliases: ['yml'], priority: 100 },
  { id: 'dockerfile', extensions: [], filenames: ['Dockerfile'], aliases: [], priority: 100 }
]);

// This is deliberately narrower than "all text files". Markdown, configuration, stylesheets,
// templates, and assets may legitimately be selected beside source without becoming a claim that
// SFlow understands another programming language. The list mirrors the deterministic world-model
// source census plus native C/C++ header and Objective-C variants.
const PROGRAMMING_SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
  '.clj', '.cljc', '.cljs', '.cs', '.dart', '.ex', '.exs', '.fs', '.fsi', '.fsx',
  '.go', '.groovy', '.gsh', '.gvy', '.gy', '.java', '.js', '.jsx', '.kt', '.kts',
  '.lua', '.m', '.mm', '.php', '.pl', '.proto', '.py', '.pyi', '.r', '.rb', '.rs',
  '.scala', '.sh', '.sol', '.swift', '.ts', '.tsx', '.vue', '.svelte', '.zig'
]);

// Unknown files selected by an AST operation fail closed unless their format is explicitly
// classified as non-code. This list is intentionally an allowlist of data/document/asset formats,
// not an attempted census of programming languages. A repository-specific source extension is
// therefore unknown-source-kind until a reviewed adapter advertises it.
const EXPLICIT_NON_CODE_EXTENSIONS = new Set([
  '.bmp', '.csv', '.css', '.env', '.gif', '.html', '.ico', '.ini', '.jpeg', '.jpg',
  '.json', '.lock', '.md', '.pdf', '.png', '.properties', '.scss', '.svg', '.toml',
  '.txt', '.webp', '.xml', '.yaml', '.yml'
]);
const EXPLICIT_NON_CODE_FILENAMES = new Set([
  '.dockerignore', '.editorconfig', '.gitattributes', '.gitignore', '.npmignore',
  'license', 'license.md', 'readme', 'readme.md'
]);

function normalizeList(value, label, { extension = false } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new SingularityFlowError(`${label} must be a string array.`);
  }
  const normalized = value.map((item) => item.trim().toLowerCase());
  if (extension && normalized.some((item) => !/^\.[a-z0-9][a-z0-9+_-]*$/.test(item))) {
    throw new SingularityFlowError(`${label} contains an invalid extension.`);
  }
  return [...new Set(normalized)].sort();
}

function normalizeEntry(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !/^[a-z][a-z0-9-]*$/.test(value.id ?? '')) {
    throw new SingularityFlowError(`${source} requires a lower-case language id.`);
  }
  return {
    id: value.id,
    extensions: normalizeList(value.extensions, `${source}.extensions`, { extension: true }),
    filenames: normalizeList(value.filenames ?? value.canonicalFilenames, `${source}.filenames`),
    aliases: normalizeList(value.aliases, `${source}.aliases`),
    priority: Number.isInteger(value.priority) ? value.priority : 0,
    providers: [...new Set((value.providers ?? []).filter((item) => typeof item === 'string' && item))].sort()
  };
}

/**
 * Compile deterministic language detection from safe built-ins plus already-validated pack
 * advertisements. Adapter executable paths deliberately never enter this catalog.
 */
export function compileAstLanguageCatalog(adapters = []) {
  const entries = new Map(BUILTIN_ENTRIES.map((entry) => [entry.id, normalizeEntry(entry, `built-in language '${entry.id}'`)]));
  for (const adapter of [...adapters].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const [language, definition] of Object.entries(adapter.languageDefinitions ?? {})) {
      const current = entries.get(language) ?? normalizeEntry({ id: language }, `adapter '${adapter.id}' language '${language}'`);
      const advertised = normalizeEntry({
        id: language,
        extensions: definition.extensions,
        canonicalFilenames: definition.canonicalFilenames,
        aliases: definition.aliases,
        priority: definition.priority,
        providers: [adapter.id]
      }, `adapter '${adapter.id}' language '${language}'`);
      entries.set(language, {
        ...current,
        extensions: [...new Set([...current.extensions, ...advertised.extensions])].sort(),
        filenames: [...new Set([...current.filenames, ...advertised.filenames])].sort(),
        aliases: [...new Set([...current.aliases, ...advertised.aliases])].sort(),
        priority: Math.max(current.priority, advertised.priority),
        providers: [...new Set([...current.providers, adapter.id])].sort()
      });
    }
  }
  const languages = [...entries.values()].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const catalog = { schemaVersion: AST_LANGUAGE_CATALOG_SCHEMA_VERSION, languages };
  return Object.freeze({ ...catalog, sha256: recordSha256(catalog) });
}

export function detectAstLanguage(relative, catalog = compileAstLanguageCatalog()) {
  const basename = path.posix.basename(relative).toLowerCase();
  const extension = path.posix.extname(basename).toLowerCase();
  const matches = catalog.languages.filter((entry) => entry.filenames.includes(basename) || entry.extensions.includes(extension));
  if (!matches.length) return { language: 'unknown', ambiguous: false, candidates: [] };
  const priority = matches[0].priority;
  const preferred = matches.filter((entry) => entry.priority === priority);
  return {
    language: preferred.length === 1 ? preferred[0].id : 'unknown',
    ambiguous: preferred.length > 1,
    candidates: preferred.map((entry) => entry.id).sort()
  };
}

export function isAstProgrammingSource(relative) {
  return PROGRAMMING_SOURCE_EXTENSIONS.has(path.posix.extname(String(relative ?? '').toLowerCase()));
}

export function isExplicitAstNonCode(relative) {
  const normalized = String(relative ?? '').toLowerCase();
  const basename = path.posix.basename(normalized);
  return EXPLICIT_NON_CODE_FILENAMES.has(basename)
    || EXPLICIT_NON_CODE_EXTENSIONS.has(path.posix.extname(basename));
}

/**
 * A programming source is supported only when the compiled catalog can name it unambiguously.
 * Installed, validated packs extend that catalog, so adding support is possible without weakening
 * this fail-closed boundary. Non-programming files are intentionally outside this decision.
 */
export function unsupportedAstProgrammingPaths(paths, catalog = compileAstLanguageCatalog(), {
  classifyUnknown = false
} = {}) {
  return [...new Set((paths ?? []).map((value) => String(value)).filter(Boolean))]
    .map((sourcePath) => ({ path: sourcePath, ...detectAstLanguage(sourcePath, catalog) }))
    .filter((entry) => entry.language === 'unknown'
      && (isAstProgrammingSource(entry.path) || (classifyUnknown && !isExplicitAstNonCode(entry.path))))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function builtinAstLanguageCatalog() {
  return compileAstLanguageCatalog();
}
