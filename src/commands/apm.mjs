/**
 * `singularity-flow apm status|install` [APM A1-A2, 2026-10-29]. status: the repository's APM
 * packages as the APM CLI left them (apm.yml, apm.lock.yaml and the files it deployed), and whether
 * each deployed file is still the one APM wrote and is committed; model-free and read-only.
 * install: one `apm install` committed for review (apm-install.mjs), in the person's own terminal.
 */
import { optionBoolean, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['status', 'install']);
const OPTIONS = Object.freeze({ status: ['json'], install: ['dev', 'dry-run', 'json'] });

const STATE_WORDS = Object.freeze({
  absent: 'This repository has no APM project (no apm.yml or apm.lock.yaml).',
  unreadable: 'The APM files cannot be read.',
  drifted: 'Some deployed APM files are no longer the ones apm install wrote.',
  unlocked: 'Some declared APM packages are not locked yet.',
  uncommitted: 'The APM files are intact but not all committed.',
  intact: 'Every deployed APM file matches apm.lock.yaml and is committed.'
});

function fail(message, code = 'APM_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function primitiveWords(primitives) {
  const kinds = ['agent', 'skill', 'instruction', 'prompt'];
  return kinds.map((kind) => {
    const names = [...new Set(primitives.filter((entry) => entry.kind === kind).map((entry) => entry.name))];
    return names.length ? `${kind}${names.length === 1 ? '' : 's'} ${names.join(', ')}` : null;
  }).filter(Boolean).join('; ');
}

function print(status) {
  const lines = [];
  const manifest = status.manifest;
  if (manifest) {
    const identity = [manifest.name, manifest.version].filter(Boolean).join(' ');
    lines.push(`APM project ${identity || '(no name)'}: ${plural(manifest.apm?.length ?? 0, 'declared package')}${manifest.mcp ? `, ${plural(manifest.mcp, 'MCP server')}` : ''}${manifest.marketplace ? `, publishes a marketplace of ${plural(manifest.marketplace.packages, 'package')}` : ''}.`);
  }
  if (status.lock) {
    lines.push(`${status.lock.path}: ${plural(status.lock.packages, 'locked package')}${status.lock.apmVersion ? `, written by apm ${status.lock.apmVersion}` : ''}.`);
  }
  for (const entry of status.packages) {
    const at = entry.commit ? ` @ ${entry.commit.slice(0, 12)}` : '';
    const via = entry.marketplace && !entry.label.includes('@') ? ` (from ${entry.marketplace})` : '';
    const what = primitiveWords(entry.primitives);
    lines.push(`  ${entry.label}${at}${via}${entry.depth > 1 ? ' (needed by another package)' : ''}: ${plural(entry.files.total, 'file')}${what ? `; ${what}` : ''}.`);
  }
  if (status.local?.files.total) {
    const what = primitiveWords(status.local.primitives);
    lines.push(`  This project's own: ${plural(status.local.files.total, 'file')}${what ? `; ${what}` : ''}.`);
  }
  if (status.unmanagedAgents.length) {
    const names = status.unmanagedAgents.map((file) => file.replace(/^\.github\/agents\//u, ''));
    const shown = names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', ');
    lines.push(`${plural(names.length, 'agent')} in .github/agents ${names.length === 1 ? 'is' : 'are'} the repository's own, not from APM: ${shown}.`);
  }
  lines.push(STATE_WORDS[status.state]);
  for (const entry of status.findings.slice(0, 20)) {
    lines.push(`  ${entry.owner && entry.code.startsWith('deployed-') ? `${entry.message.replace(/\.$/u, '')} (from ${entry.owner}).` : entry.message}`);
  }
  if (status.findings.length > 20) lines.push(`  …and ${status.findings.length - 20} more (see --json).`);
  if (status.cli.found) {
    lines.push(`APM CLI here: ${status.cli.found}${status.cli.lockWrittenBy && status.cli.lockWrittenBy !== status.cli.found ? ` (the lock was written by ${status.cli.lockWrittenBy})` : ''}.`);
  } else if (status.state !== 'absent' || status.nextActions.length) {
    lines.push('No APM CLI on this machine\'s PATH; apm install and apm audit need it. SFlow reads the committed files without it.');
  }
  for (const action of status.nextActions) lines.push(`Next: ${action.command} — ${action.why}`);
  console.log(lines.join('\n'));
}

function printInstall(result) {
  if (result.dryRun) return console.log(`That was APM's preview (apm ${result.apmVersion}); nothing was changed.`);
  if (!result.committed) return console.log(`apm install changed nothing to commit (apm status: ${result.state}).`);
  const lines = [`Committed ${result.commit.slice(0, 12)} on ${result.branch}${result.createdBranch ? ` (new, from ${result.from})` : ''}: ${result.changed.length} file${result.changed.length === 1 ? '' : 's'} apm ${result.apmVersion} changed.`];
  for (const entry of result.installed) {
    const what = primitiveWords(entry.primitives);
    lines.push(`  ${entry.label}${entry.commit ? ` @ ${entry.commit.slice(0, 12)}` : ''}${what ? `: ${what}` : ''}.`);
  }
  if (result.pinRecorded) lines.push(`apm.yml now pins apm ${result.apmVersion} (x-sflow.apm-cli), so every machine installs with the same version.`);
  lines.push('Nothing was pushed. Review and share it:');
  for (const action of result.nextActions) lines.push(`  ${action.command}`);
  console.log(lines.join('\n'));
}

export async function run(_argv, { positionals, options = {} }) {
  const subcommand = positionals[1] ?? 'status';
  if (!SUBCOMMANDS.includes(subcommand)) {
    fail(`Unknown apm subcommand '${subcommand}'. Supported: ${SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND',
      { command: 'apm', subcommand, available: [...SUBCOMMANDS] });
  }
  const unknown = Object.keys(options).filter((key) => ![...OPTIONS[subcommand], 'timings'].includes(key)).sort();
  if (unknown.length) fail(`apm ${subcommand} does not accept ${unknown.map((key) => `--${key}`).join(', ')}. Use: ${OPTIONS[subcommand].map((key) => `--${key}`).join(', ')}.`);
  const { repoRoot } = await import('../git.mjs');
  if (subcommand === 'install') {
    const { installApmPackages } = await import('../apm-install.mjs');
    const result = await installApmPackages(repoRoot(process.cwd()), {
      packages: positionals.slice(2).map(String), dev: optionBoolean(options, 'dev'), dryRun: optionBoolean(options, 'dry-run')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else printInstall(result);
    return result;
  }
  if (positionals.length > 2) fail(`apm ${subcommand} takes no further arguments.`);
  const { apmProjectStatus } = await import('../apm-project.mjs');
  const status = await apmProjectStatus(repoRoot(process.cwd()));
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(status, null, 2));
  else print(status);
  return status;
}
