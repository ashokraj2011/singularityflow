/**
 * SFlow's text checks on the text already installed here (docs/SPEC-OMK-ORG-MARKETPLACE-v1.md §7, OMK:REQ-032): a skill
 * imported before the checks existed, or one whose checks were tightened since, never met them at its import. So the
 * texts an agent's prompt can hold are checked here too: every skill in the skill library, each agent's imported skills,
 * the imported templates and agents, and the agent file of each workflow made from a marketplace agent.
 *
 * - Run the way custom-workflow-health.mjs runs: by `singularity-flow check`, and wherever a page or a task reads it.
 * - Each text's result is kept in the repository's Git folder (never committed), keyed by the text's SHA-256 and the
 *   checker's version, so a text is checked once per checker and reading it again costs nothing.
 * - A text with a block-level finding is never offered by a task (task-skills.mjs), is flagged on the Marketplace and All
 *   skills pages and by `singularity-flow check` as a warning, and is named in the plan line of a task whose workflow
 *   attaches it. It is never removed, and running Stories keep their frozen snapshots (open question 3).
 *
 * Read only: it changes no configuration and asks nothing.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { checkImportText, IMPORT_SAFETY_CHECKER, safetyFlag } from './import-safety.mjs';

export const INSTALLED_TEXT_SAFETY_RESULT = 'installed-text-safety';
const FILE = 'installed-text-safety.json';
/** The import kinds whose file is text an agent's prompt holds. */
const TEXT_KINDS = new Set(['skill', 'template', 'agent', 'workflow']);

const sha256 = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

/** What an installed text is, in a person's words. */
export function installedWhat({ kind, id, agent = null }) {
  if (kind === 'library-skill') return `skill ${id}`;
  if (kind === 'skill') return `skill ${id} of agent ${agent}`;
  if (kind === 'template') return `template ${id}`;
  if (kind === 'agent') return `agent ${id}`;
  return `the agent of workflow ${id}`;
}

/**
 * Every installed text: `{ key, kind, id, agent, path, text }`, the library's skills by `library-skill:<ID>` (written here
 * or imported) and each other import whose file is text, by its import key. A file that cannot be read is left out.
 */
export async function installedTexts(root) {
  const [{ configurationReadRoot }, { loadSkillLibrary }, { loadImportsLedger }, { secureRepositoryPath }] = await Promise.all([
    import('./configuration-read-scope.mjs'), import('./skill-library.mjs'), import('./imports-ledger.mjs'), import('./util.mjs')]);
  const configRoot = configurationReadRoot(root);
  const texts = [];
  const library = await loadSkillLibrary(configRoot).catch(() => ({ skills: new Map() }));
  for (const skill of library.skills.values()) texts.push({ key: `library-skill:${skill.id}`, kind: 'library-skill', id: skill.id, agent: null, path: skill.path, text: skill.text });
  const ledger = await loadImportsLedger(configRoot).catch(() => ({ imports: {} }));
  for (const key of Object.keys(ledger.imports ?? {}).sort()) {
    const entry = ledger.imports[key];
    const relative = entry?.target?.path;
    if (!TEXT_KINDS.has(entry?.kind) || typeof relative !== 'string' || !relative) continue;
    const target = await secureRepositoryPath(configRoot, relative, { label: 'Imported file', type: 'file' }).catch(() => null);
    if (!target?.exists) continue;
    const text = await readFile(target.absolute, 'utf8').catch(() => null);
    if (text == null) continue;
    texts.push({ key, kind: entry.kind, id: entry.kind === 'workflow' ? entry.workflow ?? entry.target?.id ?? key : entry.target?.id ?? key,
      agent: entry.target?.agent ?? null, path: relative, text });
  }
  return texts;
}

async function cacheFile(root) {
  const { gitCommonDir } = await import('./git.mjs');
  return path.join(gitCommonDir(root), 'singularity-flow', FILE);
}

/**
 * The checks' result for every installed text: `{ resultType, checker, checkedAt, source: 'kept' | 'fresh', texts,
 * blocked }`, each text `{ key, kind, id, agent, path, sha256, state, flag }` (flag is safetyFlag's, null when clean),
 * and `blocked` the texts a block-level finding keeps from being offered. A text whose SHA-256 was checked by this checker
 * before is not checked again; `refresh` checks every one. `texts` replaces the read (tests).
 */
export async function installedTextSafety(root, { refresh = false, texts = null } = {}) {
  const read = texts ?? await installedTexts(root);
  const file = await cacheFile(root).catch(() => null);
  const kept = !refresh && file ? await readFile(file, 'utf8').then(JSON.parse, () => null) : null;
  const known = kept?.resultType === INSTALLED_TEXT_SAFETY_RESULT && kept.checker === IMPORT_SAFETY_CHECKER && kept.results && typeof kept.results === 'object' ? kept.results : {};
  const results = {};
  let fresh = false;
  const rows = read.map((entry) => {
    const digest = sha256(entry.text);
    let result = known[digest];
    if (!result) {
      const checked = checkImportText(entry.text);
      // A disposable cache of a read: blocks and looks only, the line's words and its spelled-out text.
      result = { state: checked.state, blocks: checked.blocks, looks: checked.looks };
      fresh = true;
    }
    results[digest] = result;
    const { text: _text, ...rest } = entry;
    return { ...rest, sha256: digest, state: result.state, flag: safetyFlag({ ...result, checker: IMPORT_SAFETY_CHECKER, notes: [] }, { what: installedWhat(entry) }) };
  });
  const checkedAt = fresh || !kept?.checkedAt ? new Date().toISOString() : kept.checkedAt;
  if (file && (fresh || Object.keys(results).length !== Object.keys(known).length)) {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ resultType: INSTALLED_TEXT_SAFETY_RESULT, checker: IMPORT_SAFETY_CHECKER, checkedAt, results })}\n`, { mode: 0o600 });
      await rename(temporary, file);
    } catch { /* the result is still returned; it is only checked again next time */ }
  }
  return { resultType: INSTALLED_TEXT_SAFETY_RESULT, checker: IMPORT_SAFETY_CHECKER, checkedAt, source: fresh ? 'fresh' : 'kept', texts: rows,
    blocked: rows.filter((entry) => entry.state === 'blocked') };
}

/** The installed texts' flags by import key (`library-skill:<ID>` for a library skill): what the catalogs show. */
export function safetyFlagsByKey(result) {
  return new Map((result?.texts ?? []).filter((entry) => entry.flag).map((entry) => [entry.key, entry.flag]));
}
