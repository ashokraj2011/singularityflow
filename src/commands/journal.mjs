/** `sflow journal` — private, machine-local return memory. */
import path from 'node:path';

import { homeRepository } from '../gateway/home-context.mjs';
import {
  deleteAllJournal, deleteJournalDay, journalDoctor, journalToday, observeRepository,
  readJournalSettings, updateJournalSettings
} from '../local-work-journal.mjs';
import { readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath } from '../workspace.mjs';
import { workspaceRegistryFile } from '../workspace-context.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  optionBoolean, optionNumber, optionString, SingularityFlowError, writeAtomic
} from '../util.mjs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function emitJournal(operation, outcome, data, { json, changed = false } = {}) {
  return emitCommandResult(commandResult({
    operation: { id: operation.id, classification: operation.classification },
    outcome,
    effects: changed ? effects({ filesChanged: true }) : noEffects(),
    restState: 'informational',
    data
  }), { json });
}

async function selectedWorkspace(options, { required = true } = {}) {
  const reference = optionString(options, 'workspace');
  const selection = await homeRepository(reference, { allowMissing: !required && !reference });
  if (!selection && required) throw new SingularityFlowError('Select a workspace before using its local journal.');
  return selection;
}

function requireDate(options) {
  const date = optionString(options, 'date');
  const parsed = date && DATE.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new SingularityFlowError('Pass --date YYYY-MM-DD.');
  }
  return date;
}

function markdown(summary) {
  return [
    `# Local work summary — ${summary.date}`,
    '',
    `Time zone: ${summary.timeZone}`,
    '',
    '> Reviewed local summary. It contains no raw events, prompts, source, command output, or remote sync.',
    '',
    '## Progress',
    '',
    ...(summary.summaries.length
      ? summary.summaries.map((item) => `- ${item.workId ? `**${item.workId}:** ` : ''}${item.text}`)
      : ['- No local engineering outcomes were recorded.']),
    '',
    '## Worth checking',
    '',
    ...(summary.attention.length
      ? summary.attention.map((item) => `- ${item.workId ? `**${item.workId}:** ` : ''}${item.text}`)
      : ['- Nothing was recorded as needing local attention.']),
    ''
  ].join('\n');
}

async function assertExportOutsideWorkspaces(output, currentRepository = null) {
  if (typeof output !== 'string' || !output.trim()) {
    throw new SingularityFlowError('Journal export requires --output <path>.');
  }
  const resolved = path.resolve(output);
  const entries = await readWorkspaceRegistry(workspaceRegistryFile()).catch(() => []);
  const protectedRoots = [currentRepository, ...entries.map((entry) => entry.path)].filter(Boolean);
  for (const entry of entries) {
    try {
      const workspace = await readWorkspace(entry.path);
      protectedRoots.push(...Object.values(workspace.repositories)
        .map((repository) => workspaceRepositoryPath(workspace, repository)));
    } catch { /* The registered workspace root is still protected when its manifest is unreadable. */ }
  }
  const inside = protectedRoots.find((root) => {
    const relative = path.relative(path.resolve(root), resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (inside) throw new SingularityFlowError(
    `Local journal export must stay outside Git worktrees. '${resolved}' is inside a registered workspace or repository.`
  );
  return resolved;
}

export async function run(_argv, { positionals, options, operation }) {
  const subcommand = positionals[1] ?? 'today';
  const json = optionBoolean(options, 'json');
  if (subcommand === 'settings') {
    const mode = optionString(options, 'mode');
    const retentionDays = optionNumber(options, 'retention-days');
    const timeZone = optionString(options, 'time-zone');
    const settings = mode != null || retentionDays != null || timeZone != null
      ? await updateJournalSettings({
        ...(mode != null ? { mode } : {}),
        ...(retentionDays != null ? { retentionDays } : {}),
        ...(timeZone != null ? { timeZone } : {})
      })
      : await readJournalSettings();
    const changed = operation.id === 'journal.settings.update';
    return emitJournal(operation, succeeded(changed ? 'journal.settings-updated' : 'journal.settings-reported', {
      mode: settings.mode, paused: settings.paused, retentionDays: settings.retentionDays
    }), settings, { json, changed });
  }
  if (subcommand === 'pause' || subcommand === 'resume') {
    const settings = await updateJournalSettings({ paused: subcommand === 'pause' });
    return emitJournal(operation, succeeded('journal.settings-updated', {
      mode: settings.mode, paused: settings.paused, retentionDays: settings.retentionDays
    }), settings, { json, changed: true });
  }
  if (subcommand === 'doctor') {
    const result = await journalDoctor();
    return emitJournal(operation, succeeded('journal.doctor-reported', {
      status: result.healthy ? 'healthy' : 'needs attention'
    }), result, { json });
  }
  if (subcommand === 'delete') {
    if (optionBoolean(options, 'all')) {
      if (optionString(options, 'confirm') !== 'DELETE LOCAL JOURNAL') {
        throw new SingularityFlowError('Deleting all local journal history requires --confirm "DELETE LOCAL JOURNAL".');
      }
      const result = await deleteAllJournal();
      return emitJournal(operation, succeeded('journal.deleted', { scope: 'all local history' }), result, { json, changed: true });
    }
    const selection = await selectedWorkspace(options);
    const date = requireDate(options);
    if (optionString(options, 'confirm') !== date) {
      throw new SingularityFlowError(`Deleting ${date} requires --confirm ${date}.`);
    }
    const result = await deleteJournalDay(selection.context.workspaceId, date);
    return emitJournal(operation, succeeded('journal.deleted', { scope: date }), result, { json, changed: true });
  }
  if (subcommand === 'refresh') {
    const selection = await selectedWorkspace(options);
    const result = await observeRepository(selection.root, {
      workspaceId: selection.context.workspaceId,
      repositoryId: selection.selected.id,
      workId: selection.context.storyId ?? null
    });
    return emitJournal(operation, succeeded('journal.refreshed', { stored: result.stored === true }), {
      resultType: 'local-work-journal-refresh', ...result
    }, { json, changed: result.stored === true });
  }
  if (subcommand === 'today') {
    const selection = await selectedWorkspace(options);
    const date = optionString(options, 'date');
    if (date) requireDate(options);
    const result = await journalToday(selection.context.workspaceId, { date });
    return emitJournal(operation, succeeded('journal.today-reported', {
      date: result.date, events: result.totalEvents
    }), result, { json });
  }
  if (subcommand === 'export') {
    const selection = await selectedWorkspace(options);
    const date = requireDate(options);
    const format = optionString(options, 'format', 'markdown');
    if (!['markdown', 'json'].includes(format)) throw new SingularityFlowError('Journal export format must be markdown or json.');
    const output = await assertExportOutsideWorkspaces(optionString(options, 'output'), selection.root);
    const summary = await journalToday(selection.context.workspaceId, { date });
    const content = format === 'json' ? `${JSON.stringify(summary, null, 2)}\n` : markdown(summary);
    if (optionBoolean(options, 'dry-run')) {
      return emitJournal(operation, succeeded('journal.export-previewed', { date, format }), {
        date, format, preview: content
      }, { json });
    }
    await writeAtomic(output, content, { mode: 0o600 });
    return emitJournal(operation, succeeded('journal.exported', { date, format }), {
      date, format, file: path.basename(output), written: true
    }, { json, changed: true });
  }
  throw new SingularityFlowError(
    `Unknown journal subcommand '${subcommand}'. Use today, refresh, settings, pause, resume, delete, export, or doctor.`
  );
}
