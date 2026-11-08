/**
 * What a finding command's results depend on besides the code [CQF:REQ-045]: the tool's version and a
 * digest of its rules. Read before the run, from what is installed, so a later gate can tell that a run
 * on unchanged code still stands without running it again.
 *
 * - ESLint: the installed `eslint` package's version; the installed versions of every ESLint plugin
 *   and config the package declares; the bytes of its configuration files.
 * - Any other program: an npm-installed one's package version, else the resolved file's path, size and
 *   modification time; the bytes of the files its arguments name and of the tool's usual
 *   configuration files.
 *
 * Null when the program cannot be found here: such a run is never reused.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../records.mjs';

const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', '.eslintignore'];
const OTHER_CONFIGS = ['.semgrep.yml', '.semgrep.yaml', '.semgrepignore', 'sonar-project.properties', '.bandit', '.golangci.yml', '.golangci.yaml',
  'ruff.toml', '.ruff.toml', '.flake8', 'codeql-config.yml', '.github/codeql/codeql-config.yml'];
const RUNNERS = new Set(['npx', 'pnpm', 'yarn', 'bunx', 'pnpx']);
const MAX_CONFIG_BYTES = 1024 * 1024;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function fileDigest(absolute) {
  try {
    const info = statSync(absolute);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return info.isFile() ? `size:${info.size}:${info.mtimeMs}` : null;
    return sha256(readFileSync(absolute));
  } catch { return null; }
}

/** The version of an installed npm package, looked up from `from` towards `top` as Node resolves it. */
function installedVersion(name, from, top) {
  let directory = path.resolve(from);
  const stop = path.resolve(top);
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
      if (typeof manifest.version === 'string') return manifest.version;
    } catch { /* not here */ }
    const parent = path.dirname(directory);
    if (directory === stop || parent === directory) return null;
    directory = parent;
  }
}

function declaredPackages(from, top) {
  const names = new Set();
  for (const directory of [...new Set([path.resolve(from), path.resolve(top)])]) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
      }
    } catch { /* no manifest */ }
  }
  return [...names].sort();
}

/** A program on PATH: its resolved file, or null. Nothing is run. */
function onPath(program, env = process.env) {
  if (!program || program.includes('/') || program.includes('\\')) return null;
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        const candidate = path.join(directory, `${program}${extension}`);
        if (statSync(candidate).isFile()) return realpathSync(candidate);
      } catch { /* next */ }
    }
  }
  return null;
}

/**
 * `{ tool, toolVersion, rulesetSha256 }` for `command` as it would run in `executionRoot`, inside the
 * repository at `root`; null when its program is not found.
 */
export function findingToolIdentity(root, executionRoot, command, { env = process.env } = {}) {
  const argv = command.argv ?? String(command.command ?? '').trim().split(/\s+/u);
  const [first, ...rest] = argv;
  const program = RUNNERS.has(path.basename(String(first ?? ''))) ? rest.find((argument) => !argument.startsWith('-')) ?? null : first;
  const name = program ? path.basename(program).replace(/\.(?:cmd|exe|bat)$/iu, '') : null;
  if (!name) return null;
  const eslint = command.result?.adapter === 'eslint-json' || name === 'eslint';
  const tool = eslint ? 'eslint' : name;
  const packageVersion = installedVersion(eslint ? 'eslint' : name, executionRoot, root);
  let toolVersion = packageVersion;
  if (!toolVersion) {
    const relative = program.includes('/') || program.includes('\\') ? path.resolve(executionRoot, program) : null;
    let resolved = null;
    try { resolved = relative ? realpathSync(relative) : onPath(program, env); } catch { resolved = null; }
    if (!resolved) return null;
    try {
      const info = statSync(resolved);
      toolVersion = `file:${sha256(`${resolved}\u0000${info.size}\u0000${info.mtimeMs}`).slice(0, 16)}`;
    } catch { return null; }
  }
  const plugins = eslint
    ? Object.fromEntries(declaredPackages(executionRoot, root).filter((entry) => /eslint/u.test(entry) && entry !== 'eslint')
      .map((entry) => [entry, installedVersion(entry, executionRoot, root)]))
    : {};
  const configs = {};
  for (const relative of eslint ? ESLINT_CONFIGS : OTHER_CONFIGS) {
    const digest = fileDigest(path.join(executionRoot, relative));
    if (digest) configs[relative] = digest;
  }
  // A file an argument names (a ruleset, a query suite, a config) is part of what the run read.
  for (const argument of argv.slice(1)) {
    const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument;
    if (!value || value.startsWith('-') || value.length > 512 || value.includes('\0')) continue;
    const absolute = path.resolve(executionRoot, value);
    // The run's own report and caches under .sflow/results are what it writes, not what it reads.
    if (!absolute.startsWith(path.resolve(root)) || absolute === path.resolve(root)
        || /(?:^|[\\/])\.sflow[\\/]results(?:[\\/]|$)/u.test(path.relative(root, absolute))) continue;
    const digest = fileDigest(absolute);
    if (digest) configs[`arg:${path.relative(root, absolute).replaceAll('\\', '/')}`] = digest;
  }
  return { tool, toolVersion, rulesetSha256: `sha256:${sha256(canonicalJson({ tool, plugins, configs }))}` };
}
