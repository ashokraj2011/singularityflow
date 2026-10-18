import { portableCheckPath } from './check-path-policy.mjs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

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
  for (const relative of ['bundle', 'apps/vscode/dist']) {
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
    terms.push(displayName, ...displayName.split(/\s+/).filter(part => part.length >= 4));
  }
  const address = String(email).trim();
  if (address && !/@(?:[^@.]+\.)*(?:example\.(?:com|org|net)|invalid|test)$/i.test(address)) {
    terms.push(address, address.split('@')[0].split('+').at(-1));
  }
  const account = portableCheckPath(homeDirectory).replace(/\/+$/, '').split('/').at(-1);
  if (account && !fixtureIdentity.test(account) && !genericHomeAccount.test(account)) terms.push(account);
  return [...new Set(terms.map(term => term.toLowerCase()).filter(term => term.length >= 4))];
}

function personalTermPattern(terms) {
  const escaped = terms.filter(Boolean).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return escaped.length ? new RegExp(`(?:^|[^a-z0-9])(?:${escaped.join('|')})(?=$|[^a-z0-9])`, 'i') : null;
}

/** Scan all text sources and generated output using only caller-supplied local identity hints. */
export function sourcePrivacyProblems(relative, text, personalTerms = []) {
  const problems = [];
  const pattern = personalTermPattern(personalTerms);
  if (!pattern) return problems;
  if (pattern.test(relative)) problems.push(`${relative}: personal identity in filename`);
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (pattern.test(line)) {
      problems.push(`${relative}:${index + 1}: personal name or account reference`);
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
  }
  return problems;
}
