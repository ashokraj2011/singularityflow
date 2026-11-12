/**
 * The throwaway place a workflow walk runs in (`workflow walk`, src/workflow-walk/walk.mjs).
 *
 * Everything lives under one temporary folder: a small Node project with a `node --test` test, the
 * workflow configuration copied in, a bare repository standing in for its remote, a home folder and
 * every machine-wide Singularity Flow location (src/machine-state-locations.mjs). Every command runs
 * as a child process with that environment, so a walk never reads or writes the person's
 * ~/.singularity-flow, ~/.copilot or Git configuration, never runs a model, and never contacts a
 * remote. The repository it is run from is only read: its workflow configuration is copied out.
 */
import { rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ISOLATED_RUN_SWITCHES, MACHINE_STATE_LOCATIONS } from '../machine-state-locations.mjs';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { runQualityCommand } from '../quality-command-runner.mjs';
import { removeTemporaryTree } from '../util.mjs';

export const WALK_IDENTITY = Object.freeze({ name: 'Workflow Walk', email: 'workflow-walk@example.invalid' });
const CLI = path.join(PACKAGE_ROOT, 'bin', 'singularity-flow.mjs');

// The only inherited variables a walk's commands see: where programs are, the locale and terminal,
// what Windows needs to start a process, and the bundle selectors that keep the walk on this build.
// Everything else (tokens and secrets, another Story's session or Copilot turn, a Git directory a
// caller pointed at, a test seam, proxies) stays out.
const INHERITED = /^(?:PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|LANG|LANGUAGE|LC_[A-Z]+|TERM|TZ|SHELL|NODE_OPTIONS|SINGULARITY_FLOW_BUNDLE|SINGULARITY_FLOW_BUNDLE_DIR)$/iu;

/** The environment every command of one walk runs with: all of it under `base`. */
export function walkEnvironment(base, env = process.env) {
  const home = path.join(base, 'home');
  const inherited = Object.fromEntries(Object.entries(env).filter(([name]) => INHERITED.test(name)));
  return {
    ...inherited,
    ...Object.fromEntries(Object.entries(MACHINE_STATE_LOCATIONS).map(([name, relative]) => [name, path.join(base, 'machine', relative)])),
    HOME: home, USERPROFILE: home, COPILOT_HOME: path.join(home, '.copilot'),
    TMPDIR: path.join(base, 'tmp'), TMP: path.join(base, 'tmp'), TEMP: path.join(base, 'tmp'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    ...ISOLATED_RUN_SWITCHES, SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1'
  };
}

// Everything a walk prints is read whole: a refusal's JSON is often its last lines.
const CAPTURE_BYTES = 64 * 1024 * 1024;

/**
 * One child process through the bounded quality-command runner (its whole process tree is stopped
 * at `timeoutMs`); never throws for a non-zero exit.
 */
export async function runChild(command, args, { cwd, env, timeoutMs, input = null }) {
  const started = Date.now();
  const result = await runQualityCommand(command, args, { cwd, env, timeoutMs: Math.max(1, timeoutMs), input, captureBytes: CAPTURE_BYTES });
  const stderr = `${result.stderr ?? ''}${result.error ? `\n${result.error.message ?? result.error}` : ''}`;
  return { status: result.timedOut ? null : result.status, timedOut: result.timedOut, stdout: String(result.stdout ?? ''),
    stderr, milliseconds: Date.now() - started };
}

/**
 * Git, run only inside a walk's own folder (`cwd` is its repository, its bare remote or its reference
 * copy) with the walk's environment: its own home, global configuration and no system configuration.
 */
function gitInWalkFolder(args, options) {
  return runChild('git', args, options);
}

const PROJECT_FILES = Object.freeze({
  'package.json': `${JSON.stringify({ name: 'workflow-walk-fixture', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  'README.md': '# Workflow walk fixture\n\nA small Node project a workflow walk drives one throwaway Story through.\n',
  'src/value.mjs': 'export const value = 1;\n',
  'test/value.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n\ntest('value', () => assert.equal(value, 1));\n"
});

/** Every configuration file under `from`, by the policy that decides what configuration is. */
async function configurationFiles(from, policy, { isConfigurationAssetPath, configurationAssetSearchRoots }) {
  const files = [];
  for (const root of configurationAssetSearchRoots(policy)) {
    const absolute = path.join(from, root);
    const entries = await readdir(absolute, { recursive: true, withFileTypes: true }).catch(() => null);
    if (!entries) {
      // A search root may be a single file (apm.lock.yaml).
      if (isConfigurationAssetPath(root, policy)) await readFile(absolute).then(() => files.push(root), () => null);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const relative = path.relative(from, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/');
      if (isConfigurationAssetPath(relative, policy)) files.push(relative);
    }
  }
  return [...new Set(files)].sort();
}

/**
 * The repository's workflow configuration, as `workflow check --for-start` reads it: the approved
 * `sflow/config` copy where this checkout has one, else the checkout's own files. Returns the files
 * (repository-relative path → bytes) and where they came from. Reads only.
 */
export async function readRepositoryConfiguration(root) {
  const { withApprovedConfigurationRead } = await import('../approved-configuration-reader.mjs');
  const { configurationReadRoot } = await import('../configuration-read-scope.mjs');
  return withApprovedConfigurationRead(root, async (authority) => ({
    files: await configurationFilesIn(configurationReadRoot(root)),
    source: authority?.commit ? { kind: 'approved', ref: authority.ref ?? 'sflow/config', commit: authority.commit } : { kind: 'checkout' }
  }), { preferAuthority: true });
}

/**
 * The workflow configuration in a folder an in-process caller names (`walkWorkflows({ configurationRoot })`),
 * by the same policy: a workflow build's staged copy, so the walk drives the workflow the build would
 * propose, which the repository does not have yet. Reads only.
 */
export async function readConfigurationFolder(folder) {
  return { files: await configurationFilesIn(path.resolve(folder)), source: { kind: 'staged' } };
}

/** Every configuration file under `from` (repository-relative path → bytes). */
async function configurationFilesIn(from) {
  const YAML = (await import('yaml')).default;
  const assets = await import('../configuration-assets.mjs');
  const parse = async (relative) => YAML.parse(await readFile(path.join(from, relative), 'utf8').catch(() => '')) ?? {};
  const policy = assets.configurationAssetPolicy(await parse('singularity/workflow.yml'), await parse('singularity/portfolio.yml'));
  const files = new Map();
  for (const relative of await configurationFiles(from, policy, assets)) files.set(relative, await readFile(path.join(from, relative)));
  return files;
}

// Folders a walk is still using: an interrupted walk removes them before it exits, as a finished one does.
const LIVE = new Set();
let interruptible = false;
function removeOnInterrupt(base) {
  LIVE.add(base);
  if (interruptible) return;
  interruptible = true;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      for (const folder of LIVE) rmSync(folder, { recursive: true, force: true });
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

/** A walk folder's home, machine state, Git identity and command runners; nothing in its repository yet. */
async function newFolder({ timeoutMs, keep }) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-walk-')));
  if (!keep) removeOnInterrupt(base);
  const repository = path.join(base, 'repository');
  const remote = path.join(base, 'origin.git');
  const env = walkEnvironment(base);
  await mkdir(env.HOME, { recursive: true });
  await mkdir(path.join(base, 'machine'), { recursive: true });
  await mkdir(env.TMPDIR, { recursive: true });
  await writeFile(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = ${WALK_IDENTITY.name}\n\temail = ${WALK_IDENTITY.email}\n`
    + '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n');
  return { base, repository, remote, env, keep,
    git: (args, options = {}) => gitInWalkFolder(args, { cwd: options.cwd ?? repository, env, timeoutMs: options.timeoutMs ?? timeoutMs }),
    run: (args, options = {}) => runChild(process.execPath, [CLI, '--no-model', ...args],
      { cwd: options.cwd ?? repository, env: options.env ? { ...env, ...options.env } : env, timeoutMs: options.timeoutMs ?? timeoutMs, input: options.input ?? null }),
    dispose: () => (keep ? Promise.resolve() : removeTemporaryTree(base).finally(() => LIVE.delete(base)))
  };
}

/**
 * The walk sends nothing to other systems: each step's after-step actions (a Jira write, a webhook)
 * are taken out of the walk's own copy of the configuration. Returns where they were, for the report.
 */
export async function withoutAfterStepActions(file) {
  const YAML = (await import('yaml')).default;
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text == null) return [];
  const document = YAML.parse(text) ?? {};
  const leftOut = [];
  const strip = (owner, where) => {
    for (const [id, phase] of Object.entries(owner ?? {})) {
      if (Array.isArray(phase?.afterStep) && phase.afterStep.length) { leftOut.push({ where: `${where}${id}`, actions: phase.afterStep.length }); delete phase.afterStep; }
    }
  };
  strip(document.phases, 'phases.');
  for (const [workType, definition] of Object.entries(document.workTypes ?? {})) strip(definition?.phaseOverrides, `workTypes.${workType}.phaseOverrides.`);
  if (leftOut.length) await writeFile(file, YAML.stringify(document));
  return leftOut;
}

const failed = (what, result) => Object.assign(new Error(`${what} failed in the walk's own repository: ${(result.stderr || result.stdout || '').trim().slice(0, 600)}`),
  { code: 'WORKFLOW_WALK_SANDBOX_FAILED' });

/**
 * A fresh walk folder: the project committed on `main`, the configuration copied in (or the shipped
 * one from `init` when `configuration` is null), `init` run, and `main` pushed to a local bare remote.
 * `run(args)` runs the CLI there; `git(args)` runs Git.
 */
export async function createSandbox({ configuration = null, timeoutMs = 120_000, keep = false } = {}) {
  const sandbox = await newFolder({ timeoutMs, keep });
  const { repository, remote, base } = sandbox;
  const must = async (promise, what) => {
    const result = await promise;
    if (result.status !== 0) throw failed(what, result);
    return result;
  };
  try {
    await mkdir(repository, { recursive: true });
    await must(sandbox.git(['init', '-q', '-b', 'main']), 'git init');
    for (const [relative, text] of Object.entries(PROJECT_FILES)) {
      await mkdir(path.dirname(path.join(repository, relative)), { recursive: true });
      await writeFile(path.join(repository, relative), text);
    }
    await must(sandbox.git(['add', '-A']), 'git add');
    await must(sandbox.git(['commit', '-q', '-m', 'A small Node project for a workflow walk']), 'git commit');
    for (const [relative, bytes] of configuration?.files ?? []) {
      await mkdir(path.dirname(path.join(repository, relative)), { recursive: true });
      await writeFile(path.join(repository, relative), bytes);
    }
    sandbox.init = await must(sandbox.run(['init']), 'singularity-flow init');
    sandbox.actionsLeftOut = await withoutAfterStepActions(path.join(repository, 'singularity', 'workflow.yml'));
    await must(sandbox.git(['add', '-A']), 'git add');
    await must(sandbox.git(['commit', '-q', '-m', 'The workflow configuration under walk']), 'git commit');
    await must(sandbox.git(['init', '-q', '--bare', '-b', 'main', remote], { cwd: base }), 'git init --bare');
    await must(sandbox.git(['remote', 'add', 'origin', remote]), 'git remote add');
    // The throwaway project's own branch, pushed by name of the checked-out branch: no application branch is a
    // literal push target in source (architecture-boundaries).
    await must(sandbox.git(['push', '-q', '-u', 'origin', 'HEAD']), 'git push');
    return sandbox;
  } catch (error) {
    await sandbox.dispose();
    throw error;
  }
}

/**
 * A copy of a prepared sandbox's repository and remote in a new folder, with a home and machine
 * state of its own (nothing the template's commands recorded), its remote pointed at its own copy.
 */
export async function copySandbox(template, { timeoutMs = 120_000, keep = false } = {}) {
  const sandbox = await newFolder({ timeoutMs, keep });
  try {
    await cp(template.repository, sandbox.repository, { recursive: true, verbatimSymlinks: true });
    await cp(template.remote, sandbox.remote, { recursive: true, verbatimSymlinks: true });
    const pointed = await sandbox.git(['remote', 'set-url', 'origin', sandbox.remote]);
    if (pointed.status !== 0) throw failed('git remote set-url', pointed);
    return sandbox;
  } catch (error) {
    await sandbox.dispose();
    throw error;
  }
}
