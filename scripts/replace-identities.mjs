#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.next', '.cache', 'coverage', 'dist', 'node_modules', 'out', 'release'
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertSafeRoot(root) {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) throw new Error('Refusing to scan a filesystem root.');
  if (resolved === path.resolve(homedir())) throw new Error('Refusing to scan the home directory. Choose a specific workspace or checkout.');
  return resolved;
}

function normalizeMappings(mappings) {
  if (!Array.isArray(mappings) || mappings.length === 0) throw new Error('At least one --replace OLD=NEW mapping is required.');
  return mappings.map((mapping) => {
    const oldValue = String(mapping.oldValue ?? '');
    const newValue = String(mapping.newValue ?? '');
    if (!oldValue) throw new Error('Replacement source values cannot be empty.');
    if (oldValue === newValue) throw new Error(`Replacement for ${JSON.stringify(oldValue)} does not change anything.`);
    return { oldValue, newValue };
  });
}

async function collectTextFiles(root, maxBytes) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.size > maxBytes) continue;
      const bytes = await readFile(absolute);
      if (bytes.includes(0)) continue;
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      files.push({ absolute, relative: path.relative(root, absolute), bytes, text, mode: metadata.mode });
    }
  }
  await visit(root);
  return files;
}

function replaceText(text, mappings, ignoreCase) {
  let output = text;
  let replacements = 0;
  for (const { oldValue, newValue } of mappings) {
    const expression = new RegExp(escapeRegExp(oldValue), ignoreCase ? 'gi' : 'g');
    output = output.replace(expression, () => {
      replacements += 1;
      return newValue;
    });
  }
  return { output, replacements };
}

function fingerprintFor(root, mappings, matches, ignoreCase, maxBytes) {
  return sha256(JSON.stringify({
    root,
    mappings,
    ignoreCase,
    maxBytes,
    files: matches.map(({ relative, beforeSha256, afterSha256, replacements }) => ({
      relative, beforeSha256, afterSha256, replacements
    }))
  })).slice(0, 12);
}

export async function planIdentityReplacement({ root, mappings, ignoreCase = false, maxBytes = DEFAULT_MAX_BYTES }) {
  const safeRoot = assertSafeRoot(root);
  const normalizedMappings = normalizeMappings(mappings);
  const metadata = await lstat(safeRoot);
  if (!metadata.isDirectory()) throw new Error(`Replacement root is not a directory: ${safeRoot}`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('--max-bytes must be a positive integer.');

  const files = await collectTextFiles(safeRoot, maxBytes);
  const matches = [];
  for (const file of files) {
    const before = file.text;
    const { output: after, replacements } = replaceText(before, normalizedMappings, ignoreCase);
    if (replacements === 0) continue;
    matches.push({
      path: file.absolute,
      relative: file.relative,
      mode: file.mode,
      replacements,
      beforeSha256: sha256(file.bytes),
      afterSha256: sha256(after),
      after
    });
  }
  const fingerprint = fingerprintFor(safeRoot, normalizedMappings, matches, ignoreCase, maxBytes);
  return {
    schemaVersion: 1,
    root: safeRoot,
    mappings: normalizedMappings,
    ignoreCase,
    maxBytes,
    files: matches,
    totals: {
      files: matches.length,
      replacements: matches.reduce((total, match) => total + match.replacements, 0)
    },
    fingerprint,
    confirmation: `REPLACE IDENTITIES ${fingerprint}`
  };
}

async function atomicWrite(file, contents, mode) {
  const temporary = `${file}.sflow-identity-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, contents, { mode });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function applyIdentityReplacement(plan, confirmation) {
  if (confirmation !== plan.confirmation) throw new Error(`Exact confirmation required: ${plan.confirmation}`);
  const current = await planIdentityReplacement(plan);
  if (current.fingerprint !== plan.fingerprint) {
    throw new Error('Replacement inputs changed after preview. Generate a new preview and confirmation.');
  }
  for (const file of current.files) {
    const bytes = await readFile(file.path);
    if (sha256(bytes) !== file.beforeSha256) {
      throw new Error(`File changed after preview: ${file.relative}. Generate a new preview.`);
    }
    await atomicWrite(file.path, file.after, file.mode);
  }
  return { filesChanged: current.totals.files, replacements: current.totals.replacements };
}

function parseMapping(value) {
  const separator = value.indexOf('=');
  if (separator <= 0) throw new Error(`Invalid --replace mapping ${JSON.stringify(value)}. Use OLD=NEW.`);
  return { oldValue: value.slice(0, separator), newValue: value.slice(separator + 1) };
}

export function parseArguments(argv) {
  const options = { root: process.cwd(), mappings: [], ignoreCase: false, maxBytes: DEFAULT_MAX_BYTES, apply: false, confirm: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[++index];
    else if (argument === '--replace') options.mappings.push(parseMapping(argv[++index] ?? ''));
    else if (argument === '--ignore-case') options.ignoreCase = true;
    else if (argument === '--max-bytes') options.maxBytes = Number(argv[++index]);
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') options.apply = false;
    else if (argument === '--confirm') options.confirm = argv[++index] ?? '';
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/replace-identities.mjs --root PATH --replace OLD=NEW [--replace OLD=NEW ...]\n\nOptions:\n  --dry-run          Preview only (default)\n  --apply            Apply the previewed replacements\n  --confirm TEXT     Exact fingerprint-bound confirmation\n  --ignore-case      Match source values case-insensitively\n  --max-bytes N      Maximum file size to inspect (default ${DEFAULT_MAX_BYTES})`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    printHelp();
    return;
  }
  const plan = await planIdentityReplacement(options);
  console.log('Singularity Flow identity replacement — preview');
  console.log(`Root: ${plan.root}`);
  console.log(`Files: ${plan.totals.files} · replacements: ${plan.totals.replacements}`);
  for (const file of plan.files) console.log(`- ${file.relative} (${file.replacements})`);
  console.log(`Confirmation required: ${plan.confirmation}`);
  if (!options.apply) {
    console.log(`Run again with --apply --confirm ${JSON.stringify(plan.confirmation)}`);
    return;
  }
  const result = await applyIdentityReplacement(plan, options.confirm);
  console.log(`Applied ${result.replacements} replacement(s) across ${result.filesChanged} file(s).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`Identity replacement failed: ${error.message}`);
    process.exitCode = 1;
  });
}
