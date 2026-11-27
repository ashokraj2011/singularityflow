/**
 * SFlow's text checks on the text already installed here (docs/SPEC-OMK-ORG-MARKETPLACE-v1.md §7, OMK:REQ-032): a skill
 * imported before the checks existed, or one whose checks were tightened since, never met them at its import. So the
 * texts an agent's prompt can hold are checked here too: every skill in the skill library, each agent's imported skills,
 * the imported templates and agents, and the agent file of each workflow made from a marketplace agent.
 *
 * - Run the way custom-workflow-health.mjs runs: by `singularity-flow check`, and wherever a page or a task reads it. A
 *   Copilot session's start never runs it: it says what the last run flagged, from what that run kept.
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

import { checkImportText, IMPORT_SAFETY_CHECKER, safetyFlag, safetyGate } from './import-safety.mjs';

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
  const ledger = await loadImportsLedger(configRoot).catch(() => ({ imports: {} }));
  // The lines a person looked at when it was imported, from its import record: they ask nothing again.
  const looked = (key) => ledger.imports?.[key]?.source?.safety ?? null;
  for (const skill of library.skills.values()) {
    texts.push({ key: `library-skill:${skill.id}`, kind: 'library-skill', id: skill.id, agent: null, path: skill.path, text: skill.text, looked: looked(`library-skill:${skill.id}`) });
  }
  for (const key of Object.keys(ledger.imports ?? {}).sort()) {
    const entry = ledger.imports[key];
    const relative = entry?.target?.path;
    if (!TEXT_KINDS.has(entry?.kind) || typeof relative !== 'string' || !relative) continue;
    const target = await secureRepositoryPath(configRoot, relative, { label: 'Imported file', type: 'file' }).catch(() => null);
    if (!target?.exists) continue;
    const text = await readFile(target.absolute, 'utf8').catch(() => null);
    if (text == null) continue;
    texts.push({ key, kind: entry.kind, id: entry.kind === 'workflow' ? entry.workflow ?? entry.target?.id ?? key : entry.target?.id ?? key,
      agent: entry.target?.agent ?? null, path: relative, text, looked: looked(key) });
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
    const { text: _text, looked: record, ...rest } = entry;
    // A look the person already gave at its import (its record's lines, by digest) is no flag; a block always is.
    const looks = result.state === 'look' ? safetyGate({ ...result, checker: IMPORT_SAFETY_CHECKER }, { previous: record }).unlooked : result.looks;
    const state = result.state === 'look' && !looks.length ? 'clean' : result.state;
    return { ...rest, sha256: digest, state, flag: safetyFlag({ ...result, looks, state, checker: IMPORT_SAFETY_CHECKER, notes: [] }, { what: installedWhat(entry) }) };
  });
  const checkedAt = fresh || !kept?.checkedAt ? new Date().toISOString() : kept.checkedAt;
  // What a Copilot session's start says without checking or reading any text (keptInstalledTextFlags): kept beside the
  // results, so it is written again whenever what is flagged changes, a look given at an import included.
  const flagged = rows.filter((entry) => entry.flag).map(({ key, kind, id, agent, state }) => ({ key, kind, id, ...(agent ? { agent } : {}), state }));
  if (file && (fresh || Object.keys(results).length !== Object.keys(known).length || JSON.stringify(kept?.flagged ?? null) !== JSON.stringify(flagged))) {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ resultType: INSTALLED_TEXT_SAFETY_RESULT, checker: IMPORT_SAFETY_CHECKER, checkedAt, results, flagged })}\n`, { mode: 0o600 });
      await rename(temporary, file);
    } catch { /* the result is still returned; it is only checked again next time */ }
  }
  return { resultType: INSTALLED_TEXT_SAFETY_RESULT, checker: IMPORT_SAFETY_CHECKER, checkedAt, source: fresh ? 'fresh' : 'kept', texts: rows,
    blocked: rows.filter((entry) => entry.state === 'blocked') };
}

/**
 * The installed texts the last sweep found refused or with lines to look at, `{ key, kind, id, agent?, state }`, read from
 * what it kept and never checked or read again: what a Copilot session's start says (agent-hooks.mjs), for one small read.
 * Empty when nothing was kept, or it was kept by another checker or before this list was kept; the next `check`, catalog
 * or task plan keeps it again.
 */
export async function keptInstalledTextFlags(root) {
  const file = await cacheFile(root).catch(() => null);
  const kept = file ? await readFile(file, 'utf8').then(JSON.parse, () => null) : null;
  if (kept?.resultType !== INSTALLED_TEXT_SAFETY_RESULT || kept.checker !== IMPORT_SAFETY_CHECKER || !Array.isArray(kept.flagged)) return [];
  return kept.flagged.filter((entry) => ['blocked', 'look'].includes(entry?.state) && typeof entry.id === 'string' && typeof entry.kind === 'string');
}

/** One line for the person about what `keptInstalledTextFlags` returned, with where the lines are shown; null when none. */
export function installedTextWords(flagged) {
  if (!flagged?.length) return null;
  const names = (entries) => {
    const shown = entries.slice(0, 3).map(installedWhat);
    if (entries.length > 3) return `${shown.join(', ')} and ${entries.length - 3} more`;
    return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
  };
  const refused = flagged.filter((entry) => entry.state === 'blocked');
  const looks = flagged.filter((entry) => entry.state === 'look');
  const said = [refused.length ? `refuse ${names(refused)}, so tasks do not offer ${refused.length === 1 ? 'it' : 'them'}` : null,
    looks.length ? `ask a person to look at lines in ${names(looks)}` : null].filter(Boolean).join(', and ');
  return `SFlow's text checks ${said}. See the lines: /sf-marketplace (or in your terminal: singularity-flow marketplace catalog).`;
}

/** The installed texts' flags by import key (`library-skill:<ID>` for a library skill): what the catalogs show. */
export function safetyFlagsByKey(result) {
  return new Map((result?.texts ?? []).filter((entry) => entry.flag).map((entry) => [entry.key, entry.flag]));
}
