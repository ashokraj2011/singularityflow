#!/usr/bin/env node
import {
  applyProductUninstall, prepareProductUninstall, productUninstallText
} from '../src/product-uninstall.mjs';

function usage() {
  return [
    'Usage: sf-uninstall [--dry-run] [--confirm "UNINSTALL SINGULARITY FLOW <fingerprint>"] [--yes] [--json]',
    '',
    'Remove only Singularity Flow product surfaces. Repositories, workspaces, credentials,',
    'retained artifacts, VS Code data, and personal Copilot skills are preserved.'
  ].join('\n');
}

function parse(argv) {
  const options = { dryRun: false, confirmation: null, yes: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--confirm') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`--confirm requires a value.\n\n${usage()}`);
      options.confirmation = value;
      index += 1;
    }
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--yes') options.yes = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') return { help: true };
    else throw new Error(`Unknown product uninstaller option '${argument}'.\n\n${usage()}`);
  }
  if ([options.dryRun, options.yes, Boolean(options.confirmation)].filter(Boolean).length > 1) {
    throw new Error('--dry-run, --yes, and --confirm are mutually exclusive.');
  }
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const plan = await prepareProductUninstall();
  if (!plan.present || options.dryRun || (!options.yes && !options.confirmation)) {
    console.log(options.json ? JSON.stringify(plan, null, 2) : productUninstallText(plan));
    return;
  }
  const completed = await applyProductUninstall(plan, {
    confirmation: options.yes ? plan.confirmation : options.confirmation
  });
  console.log(options.json ? JSON.stringify(completed, null, 2) : productUninstallText(completed));
}

main().catch((error) => {
  console.error(`Singularity Flow uninstall failed: ${error.message}`);
  process.exitCode = 1;
});
