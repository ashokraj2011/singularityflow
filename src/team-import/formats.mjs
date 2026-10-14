/**
 * Which files of a team directory `workflow import-team` interprets, and as what. [TAWI-REQ-002]
 *
 * Recognition is by path and front matter, never by guessing from prose. Two families are read:
 *
 * - the GitHub Copilot layout: `.github/agents`, chat modes, scoped and repository instructions,
 *   prompt files, and directory skills (`<id>/SKILL.md`);
 * - the hidden-tool layout other coding agents use: `.<tool>/agents/<name>.md` agents,
 *   `.<tool>/skills/<id>/SKILL.md` skills, and a root `<TOOL>.md` instruction file beside its
 *   `.<tool>/` directory. It is matched by that shape, so no tool is named here.
 *
 * `AGENTS.md` is read wherever it appears. Anything else is inventoried by name and kind and never
 * interpreted as behaviour; a Markdown or text file a recognised file links to becomes a reference
 * document. The table is versioned: adding a format is a capture change with its own tests.
 */
import path from 'node:path';
import YAML from 'yaml';

export const TEAM_IMPORT_FORMAT_VERSION = 1;

/** Interpreted formats, in the order a summary lists them. */
export const TEAM_IMPORT_FORMATS = Object.freeze([
  { id: 'copilot-agent', role: 'agent', label: 'Copilot agent' },
  { id: 'copilot-chatmode', role: 'agent', label: 'Copilot chat mode' },
  { id: 'tool-agent', role: 'agent', label: 'Agent in a hidden tool directory' },
  { id: 'skill', role: 'skill', label: 'Directory skill (SKILL.md)' },
  { id: 'scoped-instructions', role: 'instruction', label: 'Scoped instructions (applyTo)' },
  { id: 'repository-instructions', role: 'instruction', label: 'Repository instructions' },
  { id: 'agents-md', role: 'instruction', label: 'AGENTS.md' },
  { id: 'tool-instructions', role: 'instruction', label: 'Tool instruction file beside its hidden directory' },
  { id: 'prompt-file', role: 'procedure', label: 'Prompt file' }
]);
const ROLE = new Map(TEAM_IMPORT_FORMATS.map((format) => [format.id, format.role]));

/** Directories never walked: Git metadata, dependencies and build output. Reported, not read. */
export const EXCLUDED_DIRECTORIES = Object.freeze(new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.venv', 'venv',
  '__pycache__', '.next', '.cache', '.turbo', '.gradle', '.idea'
]));

/**
 * Paths that are never read, the same patterns governed evidence handles refuse
 * (harness-imports.mjs): secrets, keys, sessions and environment files.
 */
const BLOCKED_SEGMENTS = new Set(['.git', '.env', '.ssh']);
const BLOCKED_FILES = [
  /(?:^|\/)(?:credentials?|secrets?|tokens?|session|selection-receipts?)(?:[./-]|$)/iu,
  /(?:^|\/)(?:id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|key))$/iu
];

export function blockedPath(relative) {
  return relative.split('/').some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()))
    || BLOCKED_FILES.some((pattern) => pattern.test(relative));
}

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.yml', '.yaml', '.json', '.mdc']);

/** Whether a file may be captured as text at all (others are inventoried by size only). */
export function textCandidate(relative) {
  return TEXT_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()) || !path.posix.extname(relative);
}

/**
 * The interpreted format of `relative` (a POSIX path inside one root), or null.
 * `toolDirectories` is the set of hidden top-level directory names (without the dot) in that root,
 * which decides whether `ACME.md` is the instruction file of `.acme/`.
 */
export function recognizeFormat(relative, toolDirectories = new Set()) {
  const segments = relative.split('/');
  const name = segments.at(-1);
  const lower = relative.toLowerCase();
  if (/^\.github\/agents\/[^/]+\.md$/u.test(lower)) return 'copilot-agent';
  if (/\.agent\.md$/u.test(lower)) return 'copilot-agent';
  if (/\.chatmode\.md$/u.test(lower)) return 'copilot-chatmode';
  if (/\.instructions\.md$/u.test(lower)) return 'scoped-instructions';
  if (lower === '.github/copilot-instructions.md') return 'repository-instructions';
  if (/\.prompt\.md$/u.test(lower)) return 'prompt-file';
  if (name === 'SKILL.md' && segments.length >= 2) return 'skill';
  if (name === 'AGENTS.md') return 'agents-md';
  const hidden = segments[0].startsWith('.') && segments[0] !== '.github' ? segments[0].slice(1) : null;
  if (hidden && segments.length === 3 && segments[1] === 'agents' && /\.md$/iu.test(name)) return 'tool-agent';
  const upper = /^([A-Z][A-Z0-9-]*)\.md$/u.exec(name);
  if (upper && toolDirectories.has(upper[1].toLowerCase())
      && (segments.length === 1 || (segments.length === 2 && segments[0] === `.${upper[1].toLowerCase()}`))) {
    return 'tool-instructions';
  }
  return null;
}

export function formatRole(format) {
  return ROLE.get(format) ?? null;
}

/**
 * Split YAML front matter from a Markdown body. Lenient by design: imported files are data, so a
 * malformed header is reported, not thrown. Line numbers are 1-based in the original text.
 */
export function splitFrontMatter(text) {
  const source = text.replace(/^﻿/u, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(source);
  if (!match) return { frontMatter: {}, body: source, bodyStartLine: 1, problem: null };
  const bodyStartLine = (match[0].match(/\n/gu)?.length ?? 0) + 1;
  try {
    const value = YAML.parse(match[1], { maxAliasCount: 50, prettyErrors: false });
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      return { frontMatter: {}, body: source.slice(match[0].length), bodyStartLine, problem: 'front matter is not a mapping' };
    }
    return { frontMatter: value ?? {}, body: source.slice(match[0].length), bodyStartLine, problem: null };
  } catch (error) {
    return { frontMatter: {}, body: source.slice(match[0].length), bodyStartLine,
      problem: `front matter is not valid YAML: ${String(error.message).split('\n')[0]}` };
  }
}

/** A stable, portable id for a recognised file: kebab-case of its declared name or file name. */
export function sourceItemId(relative, format, frontMatter = {}) {
  const segments = relative.split('/');
  const declared = typeof frontMatter.name === 'string' ? frontMatter.name : '';
  const fallback = format === 'skill' ? segments.at(-2)
    : segments.at(-1).replace(/\.(?:agent|chatmode|instructions|prompt)\.md$/iu, '').replace(/\.md$/iu, '');
  return kebab(declared) || kebab(fallback) || 'item';
}

export function kebab(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
}

/** The front matter fields each format may declare that capture records (others are kept as-is). */
export function describeFrontMatter(format, frontMatter) {
  const text = (value) => (typeof value === 'string' ? value.slice(0, 2000) : null);
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 64)
    : typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 64) : []);
  const described = {
    name: text(frontMatter.name),
    description: text(frontMatter.description)
  };
  if (formatRole(format) === 'agent') {
    described.tools = list(frontMatter.tools);
    described.model = text(frontMatter.model);
    described.handoffs = Array.isArray(frontMatter.handoffs)
      ? frontMatter.handoffs.map((entry) => text(entry?.agent ?? entry)).filter(Boolean).slice(0, 32) : [];
  }
  if (format === 'scoped-instructions') described.applyTo = text(frontMatter.applyTo) ?? (list(frontMatter.applyTo).join(', ') || null);
  if (format === 'prompt-file') {
    described.mode = text(frontMatter.mode);
    described.agent = text(frontMatter.agent);
    described.tools = list(frontMatter.tools);
  }
  return Object.fromEntries(Object.entries(described).filter(([, value]) => value !== null && !(Array.isArray(value) && !value.length)));
}
