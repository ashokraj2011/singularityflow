/**
 * A marketplace repository's CODEOWNERS, as SFlow reads it [OMK:REQ-013, docs/SPEC-OMK-ORG-MARKETPLACE-v1.md §5.2]: who
 * the repository declares as the code owners of a path, so a lifecycle record can say who guards it and an owner named
 * in apm.yml can be checked against its folder.
 *
 * - The file is the first of .github/CODEOWNERS, CODEOWNERS, docs/CODEOWNERS and .gitlab/CODEOWNERS that exists, at most
 *   64 KiB and 2,000 rules (the rest is not read, and says so).
 * - Patterns follow GitHub's and GitLab's syntax: `*`, `**`, `?`, `[…]`, a leading `/` anchors to the root, a trailing
 *   `/` is a folder and everything in it, a pattern with a `/` inside is anchored too, and `docs/*` is only the files
 *   directly in docs. A pattern with no owners leaves its paths with none.
 * - For one path the last rule that matches wins. GitLab's sections (`[Name]`, `^[Optional]`, `[Name][2] @default`) are
 *   joined: the last matching rule of each section counts, and their owners together are the path's code owners.
 *
 * Guarded means only that the marketplace declares code owners for a path: SFlow cannot see whether the host enforces
 * them (REQ-014). Pure: it reads only the text it is given.
 */

export const CODEOWNERS_PATHS = Object.freeze(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS']);
export const CODEOWNERS_LIMITS = Object.freeze({ bytes: 64 * 1024, rules: 2000, owners: 50, owner: 200 });

const SECTION = /^\^?\[([^\]\n]{1,200})\](?:\[(\d{1,3})\])?(?:\s+(.*))?$/u;
const OWNER = /^(?:@{1,2}[A-Za-z0-9][\w.\-/]*|[^\s@]+@[^\s@]+\.[^\s@]+)$/u;
const escapeRegExp = (character) => character.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');

/** A pattern as a regular expression over a repository path (no leading slash), by GitHub's and GitLab's rules. */
export function codeownersPatternRegExp(pattern) {
  let text = String(pattern);
  const anchored = text.startsWith('/') || text.replace(/\/+$/u, '').includes('/');
  text = text.replace(/^\/+/u, '');
  const folder = text.endsWith('/');
  text = text.replace(/\/+$/u, '');
  if (!text) return /^.*$/u;
  let body = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) { index += 1; body += escapeRegExp(text[index]); continue; }
    if (character === '*') {
      if (text[index + 1] === '*') {
        const starts = index === 0 || text[index - 1] === '/';
        const ends = index + 2 === text.length || text[index + 2] === '/';
        if (starts && ends) {
          // `**/` is any number of folders, a trailing `/**` everything inside.
          if (index + 2 === text.length) { body += '.*'; index += 1; } else { body += '(?:.*/)?'; index += 2; }
          continue;
        }
        body += '[^/]*'; index += 1; continue;
      }
      body += '[^/]*'; continue;
    }
    if (character === '?') { body += '[^/]'; continue; }
    if (character === '[') {
      const close = text.indexOf(']', index + 2);
      if (close > index) {
        const inside = text.slice(index + 1, close);
        const negated = inside.startsWith('!') || inside.startsWith('^');
        body += `[${negated ? '^' : ''}${(negated ? inside.slice(1) : inside).replace(/[\\\]]/gu, '\\$&')}]`;
        index = close;
        continue;
      }
    }
    body += escapeRegExp(character);
  }
  // `docs/*` is the files directly in docs (GitHub's own example), not what is further inside.
  const directOnly = !folder && /\/\*$/u.test(text) && !text.endsWith('**');
  return new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${body}${folder ? '/.*$' : directOnly ? '$' : '(?:/.*)?$'}`, 'u');
}

/** A rule line's pattern (with `\ ` and `\#` escapes) and the words after it, up to an inline comment. */
function splitRule(line) {
  let pattern = '';
  let index = 0;
  for (; index < line.length; index += 1) {
    const character = line[index];
    if (character === '\\' && index + 1 < line.length) { pattern += `\\${line[index + 1]}`; index += 1; continue; }
    if (/\s/u.test(character)) break;
    pattern += character;
  }
  const words = [];
  for (const word of line.slice(index).trim().split(/\s+/u).filter(Boolean)) {
    if (word.startsWith('#')) break;
    words.push(word);
  }
  return { pattern, words };
}

/**
 * The rules of a CODEOWNERS text: `{ path, rules, sections, problems }`, each rule `{ pattern, owners, section, line }`.
 * An owner is a handle (`@user`, `@org/team`, GitLab's `@@role`) or an email; another word is a problem, not an owner.
 */
export function parseCodeowners(text, { path: file = 'CODEOWNERS' } = {}) {
  const problems = [];
  const raw = String(text ?? '');
  if (Buffer.byteLength(raw, 'utf8') > CODEOWNERS_LIMITS.bytes) {
    return { path: file, rules: [], sections: [], problems: [`${file} is larger than 64 KiB, so it is not read: no path has code owners SFlow can see.`] };
  }
  const rules = [];
  const sections = [];
  let section = null;
  const lines = raw.replace(/^﻿/u, '').split(/\r?\n/u);
  for (const [at, source] of lines.entries()) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const header = SECTION.exec(line);
    if (header && (header[3] ?? '').split(/\s+/u).filter(Boolean).every((word) => OWNER.test(word) || word.startsWith('#'))) {
      const defaults = splitRule(`x ${header[3] ?? ''}`).words.filter((word) => OWNER.test(word));
      section = { name: header[1].trim(), optional: line.startsWith('^'), defaults };
      sections.push(section.name);
      continue;
    }
    if (rules.length >= CODEOWNERS_LIMITS.rules) {
      problems.push(`${file} has more than ${CODEOWNERS_LIMITS.rules} rules; the rules after line ${at} are not read.`);
      break;
    }
    const { pattern, words } = splitRule(line);
    if (!pattern) continue;
    const owners = [];
    for (const word of words.slice(0, CODEOWNERS_LIMITS.owners)) {
      if (OWNER.test(word) && word.length <= CODEOWNERS_LIMITS.owner) owners.push(word);
      else problems.push(`${file} line ${at + 1}: '${word.slice(0, 80)}' is not a handle or an email, so it is not an owner.`);
    }
    let regExp;
    try { regExp = codeownersPatternRegExp(pattern); } catch {
      problems.push(`${file} line ${at + 1}: the pattern '${pattern.slice(0, 80)}' cannot be read, so the rule is left out.`);
      continue;
    }
    rules.push({ pattern, owners: owners.length ? owners : section?.defaults ?? [], section: section?.name ?? null, line: at + 1, regExp });
  }
  return { path: file, rules, sections, problems };
}

/**
 * The code owners `parsed` declares for one repository path: `{ covered, owners, lines }`. Covered when the rules that
 * win for it name at least one owner; the last matching rule wins, within each GitLab section, and sections are joined.
 */
export function codeOwnersOf(parsed, file) {
  if (!parsed?.rules?.length) return { covered: false, owners: [], lines: [] };
  const relative = String(file ?? '').replace(/^\/+/u, '');
  const winners = new Map();
  for (const rule of parsed.rules) if (rule.regExp.test(relative)) winners.set(rule.section ?? '', rule);
  const owners = [...new Set([...winners.values()].flatMap((rule) => rule.owners))];
  return { covered: owners.length > 0, owners, lines: [...winners.values()].map((rule) => rule.line).sort((left, right) => left - right) };
}

/** Whether `handle` is among `owners`, as hosts compare them: without case. */
export function amongOwners(handle, owners = []) {
  const wanted = String(handle ?? '').trim().toLowerCase();
  return Boolean(wanted) && owners.some((owner) => owner.toLowerCase() === wanted);
}
