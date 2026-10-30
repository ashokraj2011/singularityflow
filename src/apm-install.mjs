/**
 * `singularity-flow apm install [PACKAGE]...` [APM A2, 2026-10-29]: one APM install as one commit a
 * pull request reviews.
 *
 * APM installs; SFlow only frames it. Before: the repository's APM files are committed, the checkout
 * is not a Story's, and this machine's APM CLI is the version `apm.yml` pins (`x-sflow.apm-cli`; the
 * first install records it). Then `apm install` runs in the person's own terminal with its own
 * output. After: `apm status` must find every deployed file intact, and exactly the paths APM
 * changed are committed on an `apm/` branch. Nothing is pushed. Copilot never runs it
 * (copilot-mutation-guard.mjs); `--dry-run` is APM's own preview and changes nothing.
 */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { APM_LOCKFILE, APM_MANIFEST, apmCliVersion, apmProjectStatus } from './apm-project.mjs';
import { add, changedPaths, checkedOutBranch, checkout, commit, refExists } from './git.mjs';
import { resolvePlatformProcess } from './platform-process.mjs';
import { SingularityFlowError } from './util.mjs';

export const APM_INSTALL_RESULT = 'sflow-apm-install';
const PIN_KEY = 'x-sflow';
const PIN_FIELD = 'apm-cli';
// Copilot's target directories: agents, instructions and prompts in .github, skills in .agents.
const TARGET_ROOTS = Object.freeze(['.github', '.agents']);

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

/** The APM CLI version `apm.yml` pins, or null. */
export async function pinnedApmCli(root) {
  const text = await readFile(path.join(root, APM_MANIFEST), 'utf8').catch(() => null);
  if (text == null) return null;
  let value = null;
  try { value = YAML.parse(text)?.[PIN_KEY]?.[PIN_FIELD] ?? null; } catch { return null; }
  return value == null ? null : String(value);
}

/** Record the pin in `apm.yml`, keeping the rest of the file as APM wrote it. */
export async function recordPin(root, version) {
  const file = path.join(root, APM_MANIFEST);
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  document.setIn([PIN_KEY, PIN_FIELD], version);
  await writeFile(file, String(document));
}

/**
 * This machine's APM CLI version and the one `root`'s apm.yml pins (null before the first run that
 * records it), refusing a machine without APM or with another version than the pin.
 */
export async function requireApmCli(root, cliVersion = apmCliVersion) {
  const found = cliVersion();
  if (!found) {
    fail('No APM CLI on this machine\'s PATH. Install it (macOS: brew install apm; Windows: winget install --id Microsoft.APM --exact), then run this again.',
      'APM_CLI_MISSING', { nextAction: 'brew install apm' });
  }
  const pinned = await pinnedApmCli(root);
  if (pinned && pinned !== found) {
    fail(`This repository runs apm ${pinned} (apm.yml ${PIN_KEY}.${PIN_FIELD}); this machine has apm ${found}. Install apm ${pinned}, or change the pin in its own reviewed change.`,
      'APM_CLI_VERSION_MISMATCH', { pinned, found });
  }
  return { found, pinned };
}

/** A branch name for this install: `apm/install-<first package>`, made unique. */
export function installBranchName(root, packages) {
  const first = String(packages[0] ?? 'packages').split('#')[0].split('@')[0].replace(/\/+$/u, '');
  const slug = (path.posix.basename(first.replaceAll('\\', '/')) || 'packages').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'packages';
  const base = `apm/install-${slug}`;
  for (let index = 1; index < 100; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`;
    if (!refExists(root, `refs/heads/${name}`)) return name;
  }
  fail(`Every branch name from ${base} to ${base}-99 is taken; delete the old ones first.`, 'APM_INSTALL_BRANCH_TAKEN');
}

function apmPaths(status) {
  const roots = new Set(TARGET_ROOTS);
  for (const entry of [...status.packages.flatMap((item) => item.primitives), ...(status.local?.primitives ?? [])]) roots.add(entry.target);
  return [APM_MANIFEST, APM_LOCKFILE, '.gitignore', ...[...roots].sort()];
}

/** The Story this checkout's branch belongs to, or null (also when SFlow is not set up here). */
export async function storyOnBranch(root, name) {
  try {
    const { loadDefinition } = await import('./config.mjs');
    const { buildRepositorySubjectIndex, resolveContext } = await import('./repository-subject-index.mjs');
    const index = await buildRepositorySubjectIndex(root, { definition: await loadDefinition(root) });
    return resolveContext(index, { reference: name, kind: 'story', required: false })?.id ?? null;
  } catch {
    return null;
  }
}

/** One run of this machine's APM CLI in `root`, with APM's own output in the person's terminal. */
export function runApm(root, args, { run = spawnSync, environment = process.env } = {}) {
  const launch = resolvePlatformProcess('apm', args, { environment, cwd: root });
  const result = run(launch.executable, launch.arguments, { cwd: root, env: environment, stdio: 'inherit', ...launch.spawnOptions });
  if (result.error) fail(`The APM CLI could not be started: ${result.error.message}`, 'APM_CLI_UNAVAILABLE');
  return result.status ?? 1;
}

function lockedCommits(status) {
  return new Map(status.packages.map((entry) => [entry.label, entry.commit ?? entry.version ?? null]));
}

/**
 * Install with APM and commit what it changed. `apm` runs the APM CLI and `cliVersion` reports it;
 * both are injected by tests.
 */
export async function installApmPackages(root, { packages = [], dev = false, dryRun = false, apm = runApm, cliVersion = apmCliVersion } = {}) {
  const { found, pinned } = await requireApmCli(root, cliVersion);
  const args = ['install', ...(dev ? ['--dev'] : []), ...(dryRun ? ['--dry-run'] : []), ...packages];
  if (dryRun) {
    const status = apm(root, args);
    if (status !== 0) fail(`apm install --dry-run exited with status ${status}. Nothing was changed.`, 'APM_INSTALL_FAILED', { status });
    return { schemaVersion: 1, resultType: APM_INSTALL_RESULT, dryRun: true, apmVersion: found, packages, committed: false };
  }

  const current = checkedOutBranch(root);
  if (!current) fail('Check out a branch first; an install is committed on a branch for review.', 'APM_INSTALL_DETACHED');
  const story = await storyOnBranch(root, current);
  if (story) {
    fail(`This checkout is Story ${story}'s. Install packages from the base branch's checkout; Stories started after its pull request is merged have them.`,
      'APM_INSTALL_STORY_CHECKOUT', { workId: story });
  }
  const before = await apmProjectStatus(root, { cliVersion: false });
  const scope = apmPaths(before);
  const dirty = changedPaths(root, scope);
  if (dirty.length) {
    fail(`Commit or stash these first, so the install's commit holds only what APM changed: ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}.`,
      'APM_INSTALL_DIRTY', { paths: dirty });
  }

  const exit = apm(root, args);
  if (exit !== 0) {
    fail(`apm install exited with status ${exit}. Nothing was committed; git status shows anything it changed.`, 'APM_INSTALL_FAILED', { status: exit });
  }
  if (!pinned) await recordPin(root, found);
  const after = await apmProjectStatus(root, { cliVersion: false });
  if (!['intact', 'uncommitted'].includes(after.state)) {
    fail(`After apm install, apm status says ${after.state}: ${after.findings.slice(0, 3).map((entry) => entry.message).join(' ')} Nothing was committed.`,
      'APM_INSTALL_NOT_INTACT', { state: after.state, findings: after.findings });
  }
  const changed = changedPaths(root, [...new Set([...scope, ...apmPaths(after)])]);
  if (!changed.length) {
    return { schemaVersion: 1, resultType: APM_INSTALL_RESULT, dryRun: false, apmVersion: found, packages, committed: false, changed: [], state: after.state };
  }

  const earlier = lockedCommits(before);
  const touched = after.packages.filter((entry) => earlier.get(entry.label) !== (entry.commit ?? entry.version ?? null));
  const target = current.startsWith('apm/') ? current : installBranchName(root, packages);
  if (target !== current) await checkout(root, target, { base: current });
  add(root, changed);
  const words = touched.length ? touched.map((entry) => entry.label).join(', ') : packages.join(', ') || 'the locked packages';
  const message = [
    `Install APM package${touched.length === 1 ? '' : 's'} ${words}`,
    '',
    `apm ${args.join(' ')} (apm ${found})`,
    ...touched.map((entry) => `- ${entry.label}${entry.commit ? ` @ ${entry.commit}` : ''}${entry.version ? ` (${entry.version})` : ''}`)
  ].join('\n');
  const sha = commit(root, message, changed);
  return {
    schemaVersion: 1, resultType: APM_INSTALL_RESULT, dryRun: false, apmVersion: found, pinRecorded: !pinned, packages,
    committed: true, commit: sha, branch: target, createdBranch: target !== current, from: current, changed,
    installed: touched.map(({ label, commit: locked, version, primitives }) => ({ label, commit: locked, version, primitives })),
    nextActions: [
      { command: `git push -u origin ${target}`, why: 'Send the branch.' },
      { command: 'gh pr create --fill', why: 'Open the pull request that reviews the agents this install adds.' }
    ]
  };
}

