/**
 * `singularity-flow apm install [PACKAGE]...` [APM A2, 2026-10-29]: one APM install as one commit a
 * pull request reviews.
 *
 * APM installs; SFlow only frames it. Before: the repository's APM files are committed, the checkout
 * is not a Story's, and this machine's APM CLI is the version `apm.yml` pins (`x-sflow.apm-cli`; the
 * first install records it). Then `apm install` runs in the person's own terminal with its own
 * output. After: `apm status` must find every deployed file intact, and exactly the paths APM
 * changed are committed on an `apm/` branch, once APM's own `apm audit --ci` passes: the lock, the
 * deployed files and the organisation's apm-policy.yml [APM A5]. The first install also adds the
 * pull-request check that runs the same audit. Nothing is pushed. Copilot never runs it
 * (copilot-mutation-guard.mjs); `--dry-run` is APM's own preview and changes nothing.
 */
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
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
// The actions APM's GitHub workflows run, pinned to reviewed commits.
export const CHECKOUT_ACTION = 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0';
export const APM_ACTION = 'microsoft/apm-action@d723bb64ed70c135bbaf87d126b721dd2dae0439 # v1.10.0';
export const APM_AUDIT_WORKFLOW = '.github/workflows/apm-audit.yml';

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

/**
 * The pull-request check the first install adds: APM's own audit of the lock, the deployed files and
 * the organisation's policy, so a package committed by hand is checked like an installed one.
 */
export function auditWorkflowText(apmVersion) {
  return [
    '# APM\'s checks for this repository\'s agent packages, written by singularity-flow apm install.',
    '# Every pull request: apm.lock.yaml matches apm.yml, every deployed file is the one APM wrote, and',
    '# every package is one the organisation\'s apm-policy.yml allows. apm-version is the version',
    '# apm.yml pins (x-sflow.apm-cli); change both together.',
    'name: APM audit',
    'on:',
    '  pull_request:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  audit:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${CHECKOUT_ACTION}`,
    `      - uses: ${APM_ACTION}`,
    '        with:',
    '          setup-only: true',
    `          apm-version: '${apmVersion}'`,
    '      - name: Lock, deployed files and policy',
    '        run: apm audit --ci',
    '        env:',
    '          # Reads a private organisation policy or package the default token cannot.',
    '          GITHUB_APM_PAT: ${{ secrets.APM_PAT }}',
    ''
  ].join('\n');
}

/** One run of the APM CLI whose JSON SFlow reads; APM's own messages stay on its stderr. */
export function captureApm(root, args, { run = spawnSync, environment = process.env } = {}) {
  const launch = resolvePlatformProcess('apm', args, { environment, cwd: root });
  const result = run(launch.executable, launch.arguments, {
    cwd: root, env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...launch.spawnOptions
  });
  if (result.error) fail(`The APM CLI could not be started: ${result.error.message}`, 'APM_CLI_UNAVAILABLE');
  return { status: result.status ?? 1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/**
 * `apm audit --ci` as APM reports it: whether it passed, each failed check, and APM's note when it
 * could not apply an organisation policy (no organisation in the remote, or none published). Drift
 * is left out: apm status has just checked every deployed file against the lock.
 */
export function apmAudit(root, capture = captureApm) {
  const result = capture(root, ['audit', '--ci', '--no-drift', '-f', 'json']);
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  if (!report || typeof report.passed !== 'boolean' || !Array.isArray(report.checks)) {
    const said = result.stderr.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? 'no report';
    fail(`apm audit --ci gave no report (exit ${result.status}): ${said}`, 'APM_AUDIT_UNREADABLE', { status: result.status });
  }
  const failed = report.checks.filter((check) => check && check.passed === false).map((check) => ({
    name: String(check.name ?? 'check'), message: String(check.message ?? ''),
    details: (Array.isArray(check.details) ? check.details : []).slice(0, 5).map(String)
  }));
  const note = result.stderr.split('\n').map((line) => line.replace(/^\[[!i]\]\s*/u, '').trim()).find((line) => /polic|enforcement/iu.test(line) && /skipped|not found|could not/iu.test(line)) ?? null;
  return { passed: report.passed && !failed.length, checks: report.checks.length, failed, policyNote: note };
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
export async function installApmPackages(root, {
  packages = [], dev = false, dryRun = false, apm = runApm, capture = captureApm, cliVersion = apmCliVersion
} = {}) {
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
  // The same audit the pull request's check runs; a package the organisation does not allow stops here.
  const audit = apmAudit(root, capture);
  if (!audit.passed) {
    const said = audit.failed.map((check) => `${check.name}: ${check.message}${check.details.length ? ` (${check.details.join('; ')})` : ''}`).join(' ');
    fail(`apm audit --ci failed after the install: ${said} Nothing was committed; git status shows what apm install wrote.`,
      'APM_INSTALL_AUDIT_FAILED', { failed: audit.failed });
  }
  const writesWorkflow = !pinned && !(await lstat(path.join(root, APM_AUDIT_WORKFLOW)).catch(() => null));
  if (writesWorkflow) {
    await mkdir(path.join(root, path.dirname(APM_AUDIT_WORKFLOW)), { recursive: true });
    await writeFile(path.join(root, APM_AUDIT_WORKFLOW), auditWorkflowText(found));
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
    audit: { passed: true, checks: audit.checks, policyNote: audit.policyNote }, workflowWritten: writesWorkflow,
    installed: touched.map(({ label, commit: locked, version, primitives }) => ({ label, commit: locked, version, primitives })),
    nextActions: [
      { command: `git push -u origin ${target}`, why: 'Send the branch.' },
      { command: 'gh pr create --fill', why: 'Open the pull request that reviews the agents this install adds.' }
    ]
  };
}

