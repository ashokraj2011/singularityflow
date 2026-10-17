import { chmodSync, existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { SECRETS_SUBCOMMANDS } from '../command-registry.mjs';
import { gitDir, repoRoot, stagedEntriesForPaths } from '../git.mjs';
import { commandResult, effects, noEffects, noop, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { SingularityFlowError, optionBoolean, run, writeText } from '../util.mjs';

async function runSecrets(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => secretsCommand(positionals, options)));
}

export { runSecrets as run };

/**
 * `sflow secrets scan` / `sflow secrets protect`.
 *
 * The commit gate refuses without being asked, which is what makes it a control rather than advice.
 * These are the two things a person still needs: to look before they commit, and to extend the same
 * refusal to plain `git commit`, which never enters this CLI at all.
 */
export async function secretsCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'scan';
  if (!SECRETS_SUBCOMMANDS.includes(subcommand)) {
    throw new SingularityFlowError(`Unknown secrets subcommand '${subcommand}'. Use ${SECRETS_SUBCOMMANDS.join(' or ')}.`);
  }
  const root = repoRoot();
  const { scanEntries, secretRefusal } = await import('../secrets.mjs');

  if (subcommand === 'protect') {
    const hookPath = path.join(gitDir(root), 'hooks', 'pre-commit');
    /**
     * A hook, not a wrapper. It runs for `git commit` however it is invoked — terminal, editor,
     * another tool — which is the whole reason it exists; a check that only fires when someone
     * remembers to type a command is documentation.
     *
     * `--staged` matters: the hook must judge what is staged, not what is on disk. A file cleaned in
     * the editor after staging would otherwise pass with the credential still in the index.
     */
    /**
     * Resolve the CLI, do not assume it is on PATH.
     *
     * The first version of this hook was `exec sflow secrets scan --staged`, which failed closed for
     * the wrong reason on any machine where `sflow` was not installed globally: every commit broke
     * with `sflow: not found`, and the developer's only clue pointed at a tool they never installed.
     * Failing closed is right; failing closed illegibly teaches people to pass --no-verify.
     *
     * The CLI that installed the hook wins, and PATH is the fallback. The other order looks more
     * accommodating and is wrong: a stale global `sflow` shadows the one the person actually chose,
     * and if it predates this command every commit is refused with `Unknown command 'secrets'` —
     * observed, not hypothesised. A governance control should run the exact thing it was installed
     * from; picking up upgrades is not worth being at the mercy of whatever is first on PATH.
     */
    // From the package root, not this file: installed copies run this module inside bundle/cli.mjs,
    // one directory up from here, so a path counted from this file would leave the package.
    const installedFrom = path.join(PACKAGE_ROOT, 'bin', 'singularity-flow.mjs');
    const script = [
      '#!/bin/sh',
      '# Installed by `sflow secrets protect`. Refuses a commit containing a credential.',
      '# Bypass in a genuine emergency with `git commit --no-verify`; the commit path',
      '# checks again and cannot be bypassed that way.',
      `if [ -f ${JSON.stringify(installedFrom)} ]; then`,
      `  exec node ${JSON.stringify(installedFrom)} secrets scan --staged`,
      'elif command -v sflow >/dev/null 2>&1; then',
      '  exec sflow secrets scan --staged',
      'else',
      '  echo "singularity-flow: the secret check cannot run — sflow is not on PATH and" >&2',
      `  echo "${installedFrom} is missing. Reinstall, or re-run \\\`sflow secrets protect\\\`." >&2`,
      '  exit 1',
      'fi',
      ''
    ].join('\n');
    const existing = existsSync(hookPath) ? await readFile(hookPath, 'utf8') : null;
    if (existing && !existing.includes('sflow secrets scan') && !optionBoolean(options, 'force')) {
      throw new SingularityFlowError(
        `${hookPath} already exists and was not written by Singularity Flow. `
        + 'Add `sflow secrets scan --staged` to it, or re-run with --force to replace it.',
        { code: 'SECRET_HOOK_EXISTS' }
      );
    }
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeText(hookPath, script);
    chmodSync(hookPath, 0o755);
    const result = { resultType: 'secret-protection', schemaVersion: 1, hook: hookPath, installed: true, replaced: Boolean(existing) };
    const narration = commandResult({
      operation: { id: 'secrets.protect', classification: 'mutation' },
      outcome: succeeded('secrets.protected', { hook: hookPath }),
      effects: effects({ filesChanged: true }),
      restState: 'informational',
      data: result
    });
    if (!optionBoolean(options, 'json')) {
      console.log(`\`git commit\` now refuses a commit containing a credential.`);
    }
    emitCommandResult(narration, { json: optionBoolean(options, 'json') });
    return result;
  }

  // `--staged` judges the index, which is what a commit will use. Without it, the working tree.
  const staged = optionBoolean(options, 'staged');
  const listed = staged
    ? run('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { cwd: root }).stdout.split('\0').filter(Boolean)
    : run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean);

  const entries = [];
  if (staged) {
    entries.push(...stagedEntriesForPaths(root, listed, { label: 'secrets.scan staged blobs' }));
  } else {
    for (const item of listed) {
      try { entries.push({ path: item, content: await readFile(path.resolve(root, item), 'utf8') }); }
      catch (error) { if (error?.code !== 'ENOENT') entries.push({ path: item }); }
    }
  }

  const scan = scanEntries(entries);
  const scope = staged ? 'staged' : 'tracked';
  const slots = { scanned: scan.scanned, scope, blocking: scan.blocking.length };
  const narration = commandResult({
    operation: { id: 'secrets.scan', classification: 'read' },
    // A scan that finds something has not failed — it did its job. `noop` with the detected message
    // keeps "the command worked" and "the commit must not proceed" as separate facts; the exit code
    // below is what stops the commit.
    outcome: scan.blocking.length ? noop('secrets.detected', slots) : succeeded('secrets.clean', slots),
    effects: noEffects(),
    restState: 'informational',
    data: { ...scan, scope }
  });
  if (!optionBoolean(options, 'json')) {
    // The detail goes to stderr, where the pre-commit hook shows it, and where it cannot be piped
    // into something that records it by accident.
    const refusal = secretRefusal(scan);
    if (refusal) console.error(refusal);
    else if (scan.waived.length) console.log(`${scan.waived.length} waived finding(s) were allowed.`);
  }
  emitCommandResult(narration, { json: optionBoolean(options, 'json') });
  // Non-zero so the pre-commit hook refuses, and so CI does.
  if (scan.blocking.length) process.exitCode = 1;
  return scan;
}
