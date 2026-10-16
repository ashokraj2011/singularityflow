/** Activity log reads do not load lifecycle mutation handlers. */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { repoRoot, gitDir } from '../git-execution.mjs';
import { optionBoolean, optionString, optionNumber } from '../util.mjs';
import { filterLogEntries, logFilePath, normalizeLogLevel, parseLogLines, resolveLogging } from '../logging.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

// No command accounting: `logs` reads the file, and logging its own invocation would append noise
// to what it is showing (the general dispatcher excluded it for the same reason).
export async function run(_argv, { positionals, options }) {
  return withCommandConfirmation(options, () => logsCommand(positionals, options));
}

export async function logsCommand(positionals, options) {
  if (positionals[1] === 'workspace') {
    const { collectWorkspaceLogs } = await import('../workspace-logs.mjs');
    const report = await collectWorkspaceLogs({
      source: optionString(options, 'source', 'all'),
      repository: optionString(options, 'repository'),
      workId: optionString(options, 'work-id'),
      phase: optionString(options, 'phase'),
      agent: optionString(options, 'agent'),
      level: optionString(options, 'level'),
      since: optionString(options, 'since'),
      text: optionString(options, 'text'),
      limit: optionNumber(options, 'limit', 500)
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Workspace logs — ${report.workspace.id}`);
    console.log(`${report.entries.length} of ${report.total} matching entries · newest first`);
    for (const item of report.entries) {
      console.log(`${item.timestamp ?? '(no timestamp)'}  ${item.severity.toUpperCase().padEnd(5)}  ${item.source.padEnd(9)}  ${item.repositoryId ?? 'workspace'}  ${item.summary}`);
    }
    for (const warning of report.warnings) console.error(`Warning: ${warning}`);
    return;
  }
  const root = repoRoot();
  const file = logFilePath(gitDir(root));
  if (positionals[1] === 'path') return console.log(file);

  if (positionals[1] === 'level') {
    const { loadConfig } = await import('../state-stores.mjs');
    const config = await loadConfig(root).catch(() => null);
    const resolved = resolveLogging(config);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ ...resolved, file }));
    console.log(`Log file : ${file}`);
    console.log(`File level    : ${resolved.level}`);
    console.log(`Console level : ${resolved.console}`);
    console.log('Raise either for one command with SINGULARITY_FLOW_LOG_LEVEL=all or SINGULARITY_FLOW_LOG_CONSOLE=debug.');
    return;
  }

  if (!existsSync(file)) {
    console.log(`No activity log yet at ${file}.`);
    console.log('It is written as commands run. Set SINGULARITY_FLOW_LOG_LEVEL=all to capture everything.');
    return;
  }

  const entries = filterLogEntries(parseLogLines(await readFile(file, 'utf8')), {
    level: normalizeLogLevel(optionString(options, 'level') ?? 'trace', 'trace'),
    event: optionString(options, 'event'),
    since: optionString(options, 'since')
  });
  const limit = Number.parseInt(optionString(options, 'tail') ?? '80', 10);
  const shown = Number.isFinite(limit) && limit > 0 ? entries.slice(-limit) : entries;

  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(shown, null, 2));
  if (!shown.length) {
    console.log('No matching log entries. Widen with --level all, drop --event, or extend --since.');
    return;
  }
  for (const entry of shown) {
    const context = { ...entry };
    for (const key of ['ts', 'level', 'event', 'msg']) delete context[key];
    const detail = Object.keys(context).length ? `  ${JSON.stringify(context)}` : '';
    console.log(`${entry.ts ?? '(no timestamp)'}  ${String(entry.level ?? '?').toUpperCase().padEnd(5)}  ${entry.event ?? ''}${entry.msg ? `  ${entry.msg}` : ''}${detail}`);
  }
  const counts = shown.reduce((totals, entry) => ({ ...totals, [entry.level]: (totals[entry.level] ?? 0) + 1 }), {});
  console.log(`\n${shown.length} of ${entries.length} matching entries · ${Object.entries(counts).map(([level, count]) => `${level} ${count}`).join(' · ')}`);
  console.log(`Log file: ${file}`);
}
