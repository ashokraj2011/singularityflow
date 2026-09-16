#!/usr/bin/env node
import path from 'node:path';

import {
  applyLocalReinstall, distributionInstallPlanText, recoverPendingDistributionInstall,
  resolveDistributionInstallPlan
} from '../src/reinstall.mjs';

function usage() {
  return [
    'Usage: sf-install --artifact-key PUBLIC-KEY [--release-dir DIRECTORY] [--registry URL] [--cli-only]',
    '                  [--no-copilot-telemetry] [--dry-run | --confirm TEXT] [--json]',
    '',
    'Install the exact promoted npm tarball, Copilot assets, and VSIX without Git or a source checkout.',
    'A normal invocation validates and applies immediately. --dry-run prints a fingerprinted preview.'
  ].join('\n');
}

function parse(argv) {
  const options = {
    releaseDirectory: process.cwd(), artifactKey: null, registry: null, cliOnly: false,
    telemetry: true, dryRun: false, confirmation: null, json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const takeValue = (name) => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.\n\n${usage()}`);
      index += 1;
      return value;
    };
    if (argument === '--release-dir') options.releaseDirectory = takeValue(argument);
    else if (argument.startsWith('--release-dir=')) options.releaseDirectory = argument.slice(14);
    else if (argument === '--artifact-key') options.artifactKey = takeValue(argument);
    else if (argument.startsWith('--artifact-key=')) options.artifactKey = argument.slice(15);
    else if (argument === '--registry') options.registry = takeValue(argument);
    else if (argument.startsWith('--registry=')) options.registry = argument.slice(11);
    else if (argument === '--confirm') options.confirmation = takeValue(argument);
    else if (argument === '--cli-only') options.cliOnly = true;
    else if (argument === '--no-copilot-telemetry') options.telemetry = false;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') return { help: true };
    else throw new Error(`Unknown distribution installer option '${argument}'.\n\n${usage()}`);
  }
  if (!options.releaseDirectory) throw new Error('--release-dir requires a directory.');
  if (!options.artifactKey) throw new Error('--artifact-key is required and must name the externally trusted builder public key.');
  if (options.dryRun && options.confirmation) throw new Error('--dry-run and --confirm are mutually exclusive.');
  if (!options.telemetry && options.cliOnly) options.telemetry = false;
  options.releaseDirectory = path.resolve(options.releaseDirectory);
  options.artifactKey = path.resolve(options.artifactKey);
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const recovery = options.dryRun
    ? { recovered: false, status: 'not-requested' }
    : await recoverPendingDistributionInstall();
  const plan = await resolveDistributionInstallPlan(options);
  if (options.dryRun) {
    console.log(options.json ? JSON.stringify(plan, null, 2) : distributionInstallPlanText(plan));
    return;
  }
  const completed = await applyLocalReinstall(plan, {
    confirmation: options.confirmation || plan.confirmation
  });
  const nextActions = {
    shell: 'singularity-flow workspace refresh-configuration',
    copilot: '/sf-refresh-configuration'
  };
  if (options.json) console.log(JSON.stringify({ ...completed, recovery, nextActions }, null, 2));
  else {
    if (recovery.recovered) {
      console.log(`Recovered prior distribution install: ${recovery.status} (${recovery.fingerprint}).\n`);
    }
    console.log(distributionInstallPlanText(completed));
    console.log('\nWorkspace configuration was preserved. To refresh registered repositories explicitly:');
    console.log(`  Shell: ${nextActions.shell}`);
    console.log(`  Copilot: ${nextActions.copilot}`);
  }
}

main().catch((error) => {
  console.error(`Singularity Flow distribution install failed: ${error.message}`);
  process.exitCode = 1;
});
