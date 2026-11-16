import { authorityCheckRead, withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { doctorSnapshot, doctorText } from '../doctor.mjs';
import { repoRoot } from '../git.mjs';
import { commandExists, optionBoolean, optionString, optionStrings, run as runCommand } from '../util.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => doctorCommand(positionals, options)));
}

export async function doctorCommand(positionals, options) {
  if (optionBoolean(options, 'git-speed')) {
    const root = repoRoot();
    const { applyFosGitSpeed, inspectFosGitSpeed } = await import('../fos-git-speed.mjs');
    const report = optionBoolean(options, 'apply')
      ? await applyFosGitSpeed(root, optionStrings(options, 'enable'))
      : inspectFosGitSpeed(root);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Git speed: ${report.status}`);
      const settings = report.report?.settings ?? report.settings ?? {};
      for (const [id, value] of Object.entries(settings)) {
        console.log(`${id}: ${value.value ?? 'unset'} · ${value.compatible ? 'compatible' : 'unsupported'} · ${value.scope}`);
      }
      if (report.receipt) console.log(`Receipt: ${report.receipt.receiptId}`);
    }
    return report;
  }
  if (optionString(options, 'fix') === 'telemetry') {
    const { telemetryCommand } = await import('./telemetry.mjs');
    return telemetryCommand(['telemetry', 'enable'], options);
  }
  const root = repoRoot();
  if (optionBoolean(options, 'repair-hooks')) return repairHooks(root, options);
  // The VS Code this person runs, as `reinstall` finds it: its own terminal, else the code command (never in tests).
  const { vscodeEditorVersion } = await import('../vscode-host-version.mjs');
  const editorVersion = vscodeEditorVersion({ exists: process.env.NODE_ENV === 'test' ? () => false : commandExists, execute: runCommand });
  const inspect = () => doctorSnapshot(root, {
    workId: positionals[1],
    offline: optionBoolean(options, 'offline'),
    performance: optionBoolean(options, 'performance'),
    editorVersion
  });
  // Performance doctor is explicitly a measurement of the checkout from which it was invoked,
  // including a new repository with no workflow. Routing already excludes the active workspace;
  // configuration overlay resolution must do the same or a missing/stale selection elsewhere on
  // the laptop can fail before the invoking checkout is measured at all.
  // Outside a Story checkout, doctor checks the configuration new work uses, sflow/config, never this checkout's
  // own singularity/ files, and says which commit it checked [SCF:REQ-001, finding ER-F5].
  const report = optionBoolean(options, 'performance')
    ? await inspect()
    : await withApprovedConfigurationRead(root, async (authority) => namedConfigurationChecks(await inspect(), authority),
      authorityCheckRead(root, { refreshAuthority: !optionBoolean(options, 'offline') }));
  const { buildCurrency, buildCurrencyLine } = await import('../build-currency.mjs');
  const update = buildCurrency();
  if (update) report.update = update;
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(`${doctorText(report)}${update ? `\n! ${buildCurrencyLine(update)}\n` : ''}`);
  if (!report.healthy) process.exitCode = 2;
}

/** Say which sflow/config commit the configuration checks read, so a problem is never sought in the checkout. */
function namedConfigurationChecks(report, authority) {
  if (!authority?.commit || authority.kind === 'working-tree') return report;
  const branch = String(authority.ref ?? authority.branch ?? 'sflow/config').replace(/^refs\/(?:heads|remotes\/[^/]+)\//u, '');
  for (const entry of report?.checks ?? []) {
    if (!['configuration', 'initialization-assets'].includes(entry.id)) continue;
    entry.message = `On ${branch} (${authority.commit.slice(0, 12)}): ${entry.message}`;
    if (entry.status === 'fail') entry.fix = 'Repair it with a proposal: singularity-flow configuration restore (back to its newest commit that loads), or singularity-flow workflow fix.';
  }
  return report;
}

/**
 * Writes this repository's Copilot hooks again for its own policy.plainChatEdits [PCR:REQ-030, REQ-033], into the working
 * tree only: the person reviews and commits them like any other change.
 */
async function repairHooks(root, options) {
  const [{ plainChatEditsPolicy }, { writeRepositoryHooks }] = await Promise.all([import('../copilot-plain-chat.mjs'), import('../repository-hooks.mjs')]);
  const setting = await plainChatEditsPolicy(root, '');
  const wrote = await writeRepositoryHooks(root, { setting });
  const result = { schemaVersion: 1, resultType: 'sflow-repository-hooks', setting, wrote,
    words: wrote.length ? `Wrote ${wrote.join(', ')} for policy.plainChatEdits: ${setting}. Review and commit them; nothing was committed.` : 'This repository\'s Copilot hooks are already what SFlow writes; nothing changed.' };
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(result.words);
  return result;
}
