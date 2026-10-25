import { portableCheckPath } from './check-path-policy.mjs';
import { spawnSync } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const GENERATED_PRIVACY_DIRECTORIES = Object.freeze(['bundle', 'apps/vscode/dist']);

/** Audit known build products even though Git correctly ignores them; never follow symlinks. */
export async function generatedPrivacyFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  for (const relative of GENERATED_PRIVACY_DIRECTORIES) {
    const directory = path.join(root, relative);
    let metadata;
    try { metadata = await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (metadata.isDirectory()) await visit(directory);
  }
  return files.sort();
}

/** Documentation includes native skills, templates and generated catalogs, wherever stored. */
export function isDocumentationPath(value) {
  return /\.(?:md|mdx|markdown|mdown|rst|txt|html?|adoc|asciidoc|tex|org|svg)$/i
    .test(portableCheckPath(value));
}

const homePath = /(?:\/(?:Users|home)\/|[a-z]:[\\/]+Users[\\/]+)(?!<|\$\{|\$\(|\{|%|\[)[a-z0-9_.-]+/i;
const fixtureIdentity = /\b(?:test|fixture|example|runner|bot|build|singularity flow|github actions)\b/i;
const genericHomeAccount = /^(?:root|user|developer|administrator|admin|default|public|system|container|runner.*|test.*|fixture.*|example.*)$/i;

/** Read identity hints in memory; never store a developer's name or account in the policy. */
export function configuredPersonalTerms({ name = '', email = '', homeDirectory = '' } = {}) {
  const terms = [];
  const displayName = String(name).trim();
  if (displayName && !fixtureIdentity.test(displayName)) {
    // A full identity is useful; its individual words can be ordinary English or API names.
    terms.push(displayName);
  }
  const address = String(email).trim();
  if (address && !/@(?:[^@.]+\.)*(?:example\.(?:com|org|net)|invalid|test)$/i.test(address)) {
    terms.push(address, address.split('@')[0].split('+').at(-1));
  }
  const account = portableCheckPath(homeDirectory).replace(/\/+$/, '').split('/').at(-1);
  if (account && !fixtureIdentity.test(account) && !genericHomeAccount.test(account)) terms.push(account);
  return [...new Set(terms.map(term => term.toLowerCase()).filter(term => term.length >= 4))];
}

/** Share the same in-memory identity inputs between source checks and post-build checks. */
export function readConfiguredPrivacyTerms(root) {
  const result = spawnSync('git', ['config', '--null', '--get-regexp', '^user[.](name|email)$'], {
    cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  if (![0, 1].includes(result.status)) throw new Error('Unable to read local identity hints for source privacy checks.');
  const fields = Object.fromEntries(String(result.stdout ?? '').split('\0').filter(Boolean)
    .map(entry => { const separator = entry.indexOf('\n'); return [entry.slice(0, separator), entry.slice(separator + 1)]; }));
  return configuredPersonalTerms({ name: fields['user.name'], email: fields['user.email'], homeDirectory: homedir() });
}

function personalTermPattern(terms) {
  const escape = term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const strong = terms.filter(term => term && !/^[a-z]+$/iu.test(term)).map(escape);
  const ambiguous = terms.filter(term => term && /^[a-z]+$/iu.test(term)).map(escape);
  const patterns = [];
  if (strong.length) patterns.push(new RegExp(`(?:^|[^a-z0-9])(?:${strong.join('|')})(?=$|[^a-z0-9])`, 'i'));
  if (ambiguous.length) {
    // Bare account/display-name words are evidence only in an identity-bearing context, not in
    // comments, identifiers or filenames such as mark-performance.mjs or a sentence with "will".
    const account = `(?:${ambiguous.join('|')})`;
    patterns.push(new RegExp(`(?:/(?:Users|home)/|[a-z]:[\\\\/]+Users[\\\\/]+)${account}(?=[\\\\/]|$)`, 'i'));
    patterns.push(new RegExp(`(?:https?|ssh|git)://[^\\s'"<>]*[/:]${account}(?=[/\\s'"<>]|$)`, 'i'));
    patterns.push(new RegExp(`(?:^|[^a-z0-9_.+-])${account}@[a-z0-9.-]+`, 'i'));
    patterns.push(new RegExp(`(?:^|\\s)[a-z0-9_.-]+@[^\\s:'"<>]+:${account}/`, 'i'));
  }
  return patterns.length ? { test: value => patterns.some(pattern => pattern.test(value)) } : null;
}

/** Scan all text sources and generated output using only caller-supplied local identity hints. */
export function sourcePrivacyProblems(relative, text, personalTerms = []) {
  const problems = [];
  const pattern = personalTermPattern(personalTerms);
  if (pattern?.test(relative)) problems.push(`${relative}: personal identity in filename`);
  const obsoleteGitHost = ['git', 'example', 'corp'].join('.');
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (pattern?.test(line)) {
      problems.push(`${relative}:${index + 1}: personal name or account reference`);
    }
    if (line.toLowerCase().includes(obsoleteGitHost)) {
      problems.push(`${relative}:${index + 1}: use the generic Git URL placeholder instead of the retired example host`);
    }
  }
  return problems;
}

/** Keep examples portable without treating placeholder usernames as real identities. */
export function documentationPrivacyProblems(relative, text, personalTerms = []) {
  if (!isDocumentationPath(relative)) return [];
  const problems = sourcePrivacyProblems(relative, text, personalTerms);
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    if (homePath.test(line)) problems.push(`${relative}:${index + 1}: use a placeholder instead of a machine-specific home path`);
    if (/https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\//iu.test(line)) {
      problems.push(`${relative}:${index + 1}: use a generic Git URL placeholder instead of a public repository reference`);
    }
  }
  return problems;
}
