/**
 * `singularity-flow apm status|install` [APM A1-A2, 2026-10-29]. status: the repository's APM
 * packages as the APM CLI left them (apm.yml, apm.lock.yaml and the files it deployed), and whether
 * each deployed file is still the one APM wrote and is committed; model-free and read-only.
 * install: one `apm install` committed for review (apm-install.mjs), in the person's own terminal.
 * attach: an agent APM deployed drafts a step, as a Studio change to workflow.yml `apm.agents`
 * (its own file stays APM's), reviewed like any configuration change [APM A3].
 * marketplace init and publish: the organisation's own APM marketplace, and this repository's
 * agents published to it as a package, each one commit for a pull request (apm-marketplace.mjs)
 * [APM A4]. policy init: the organisation's apm-policy.yml, which apm install and apm audit apply
 * (apm-policy.mjs) [APM A5].
 */
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['status', 'install', 'attach', 'marketplace', 'publish', 'policy']);
const OPTIONS = Object.freeze({
  status: ['json'], install: ['dev', 'dry-run', 'json'], attach: ['step', 'dry-run', 'propose', 'background-sync', 'json'],
  marketplace: ['name', 'owner', 'description', 'dry-run', 'json'],
  publish: ['marketplace', 'package', 'version', 'description', 'skill', 'dry-run', 'json'],
  policy: ['name', 'marketplace', 'allow', 'enforcement', 'dry-run', 'json']
});

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
  for (const [id, binding] of Object.entries(status.agents?.bindings ?? {})) {
    const steps = `${binding.defaultFor.length ? binding.defaultFor.join(', ') : 'no step by default'}${binding.steps.length ? ` and may draft ${binding.steps.join(', ')}` : ''}`;
    lines.push(binding.active ? `${id} drafts ${steps} (workflow.yml apm.agents).`
      : `${id} would draft ${steps} (workflow.yml apm.agents), but ${binding.waiting}; until then each step keeps its workflow's own agent.`);
  }
  for (const entry of status.agents?.unusable ?? []) lines.push(`SFlow cannot use agent ${entry.name} (${entry.path}, from ${entry.package}): ${entry.reason}`);
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
  lines.push(`apm audit --ci passed.${result.audit?.policyNote ? ` APM: ${result.audit.policyNote}` : ''}`);
  if (result.workflowWritten) lines.push('.github/workflows/apm-audit.yml runs the same audit on every pull request.');
  lines.push('Nothing was pushed. Review and share it:');
  for (const action of result.nextActions) lines.push(`  ${action.command}`);
  console.log(lines.join('\n'));
}

function printMarketplaceInit(result) {
  if (result.dryRun) {
    return console.log([`Would make this repository the ${result.name} APM marketplace on ${result.branch}, with apm ${result.apmVersion}: ${result.files.join(', ')}.`,
      'Nothing was changed.'].join('\n'));
  }
  const lines = [`Committed ${result.commit.slice(0, 12)} on ${result.branch}${result.createdBranch ? ` (new, from ${result.from})` : ''}: the ${result.name} APM marketplace, with no packages yet.`,
    `apm.yml pins apm ${result.apmVersion} (x-sflow.apm-cli); apm pack compiled .github/plugin/marketplace.json.`];
  if (result.workflowWritten) lines.push('.github/workflows/apm-marketplace.yml runs APM\'s gates on every pull request.');
  lines.push('Nothing was pushed. Review and share it:');
  for (const action of result.nextActions) lines.push(`  ${action.command}${action.why.startsWith('Once') ? `  (${action.why})` : ''}`);
  console.log(lines.join('\n'));
}

function printPublish(result) {
  const what = [`agent${result.agents.length === 1 ? '' : 's'} ${result.agents.join(', ')}`,
    result.skills.length ? `skill${result.skills.length === 1 ? '' : 's'} ${result.skills.join(', ')}` : null].filter(Boolean).join('; ');
  if (result.unchanged) return console.log(`${result.package} ${result.version} in ${result.marketplace} already has exactly these files (${what}); nothing to publish.`);
  const lines = [];
  const version = result.previousVersion ? `${result.version} (was ${result.previousVersion})` : `${result.version} (new)`;
  lines.push(`${result.dryRun ? 'Would publish' : 'Published'} ${result.package} ${version} to ${result.marketplace}: ${what}.`);
  for (const file of result.files) lines.push(`  ${file.path} (${file.bytes} bytes)`);
  for (const { agent, steps } of result.stepsKeptHere) {
    lines.push(`${agent}'s steps here (${steps.join(', ')}) stay in this repository; a repository that installs the package chooses them with apm attach.`);
  }
  if (result.skills.length) lines.push('The skills travel as the package\'s own: APM deploys them to .agents/skills, where Copilot finds each one by its description.');
  if (result.dryRun) return console.log([...lines, 'Nothing was changed.'].join('\n'));
  lines.push(`Committed ${result.commit.slice(0, 12)} on ${result.branch}${result.createdBranch ? ` (new, from ${result.from})` : ''} in the marketplace's checkout; apm pack listed it in ${result.indexed.join(', ')}.`);
  lines.push('Nothing was pushed. Review and share it:');
  for (const action of result.nextActions) lines.push(`  ${action.command}${action.why.startsWith('Once') ? `  (${action.why})` : ''}`);
  console.log(lines.join('\n'));
}

function printPolicy(result) {
  const lines = [`${result.dryRun ? 'Would write' : 'Wrote'} ${result.file}: ${result.name}, allowing ${result.allow.join(', ')}, enforcement ${result.enforcement}.`];
  for (const note of result.notes) lines.push(note);
  if (result.dryRun) return console.log([...lines, result.text.trimEnd(), 'Nothing was changed.'].join('\n'));
  for (const warning of result.warnings) lines.push(`APM: ${warning}`);
  lines.push(`Committed ${result.commit.slice(0, 12)} on ${result.branch}${result.createdBranch ? ` (new, from ${result.from})` : ''}; apm ${result.apmVersion} accepts it.`);
  lines.push('Nothing was pushed. Review and share it:');
  for (const action of result.nextActions) lines.push(`  ${action.command}${action.why.startsWith('Once') ? `  (${action.why})` : ''}`);
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
  if (subcommand === 'marketplace') {
    if (positionals[2] !== 'init' || positionals.length > 3) fail('Use: singularity-flow apm marketplace init --name <NAME> --owner <OWNER> [--description TEXT] [--dry-run].');
    const { initApmMarketplace } = await import('../apm-marketplace.mjs');
    const result = await initApmMarketplace(repoRoot(process.cwd()), {
      name: optionString(options, 'name'), owner: optionString(options, 'owner'), description: optionString(options, 'description') ?? null,
      dryRun: optionBoolean(options, 'dry-run')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else printMarketplaceInit(result);
    return result;
  }
  if (subcommand === 'policy') {
    if (positionals[2] !== 'init' || positionals.length > 3) fail('Use: singularity-flow apm policy init --marketplace <OWNER/REPOSITORY> [--allow PATTERN]... [--name TEXT] [--enforcement block|warn] [--dry-run].');
    const { initApmPolicy } = await import('../apm-policy.mjs');
    const result = await initApmPolicy(repoRoot(process.cwd()), {
      name: optionString(options, 'name') ?? null, marketplaces: optionStrings(options, 'marketplace'), allow: optionStrings(options, 'allow'),
      enforcement: optionString(options, 'enforcement') ?? 'block', dryRun: optionBoolean(options, 'dry-run')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else printPolicy(result);
    return result;
  }
  if (subcommand === 'publish') {
    const { publishApmPackage } = await import('../apm-marketplace.mjs');
    const result = await publishApmPackage(repoRoot(process.cwd()), {
      agents: positionals.slice(2).map(String), skills: optionStrings(options, 'skill'), marketplace: optionString(options, 'marketplace'),
      packageName: optionString(options, 'package') ?? null, version: optionString(options, 'version') ?? null,
      description: optionString(options, 'description') ?? null, dryRun: optionBoolean(options, 'dry-run')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else printPublish(result);
    return result;
  }
  if (subcommand === 'attach') {
    const agent = positionals[2];
    const step = optionString(options, 'step');
    if (!agent || positionals.length > 3 || !step) fail('Name the agent and its step: singularity-flow apm attach <AGENT> --step <STEP> [--propose].');
    const root = repoRoot(process.cwd());
    const { loadDefinition } = await import('../config.mjs');
    const known = (await loadDefinition(root)).agents?.[agent];
    if (!known?.apm) {
      fail(known ? `${agent} is not an agent APM deployed (${known.source}); choose its steps in Workflow Studio.`
        : `There is no agent '${agent}'. singularity-flow apm status lists the agents APM deployed.`, 'APM_AGENT_UNKNOWN', { agent });
    }
    const [router, { STUDIO_CHANGE_SET_SCHEMA }] = await Promise.all([import('../cli.mjs'), import('../workflow-studio.mjs')]);
    const result = await router.applyImportChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: 'phase.agent', phase: step, agent }] },
      options, { subject: agent, message: `[configuration] APM agent ${agent} drafts ${step}` });
    return router.emitImportMutation(root, result, options, { operation: 'apm.attach', messageId: 'apm.attached', slots: { agent, step } });
  }
  if (positionals.length > 2) fail(`apm ${subcommand} takes no further arguments.`);
  const { apmProjectStatus } = await import('../apm-project.mjs');
  const status = await apmProjectStatus(repoRoot(process.cwd()));
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(status, null, 2));
  else print(status);
  return status;
}
