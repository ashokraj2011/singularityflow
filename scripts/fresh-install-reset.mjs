#!/usr/bin/env node
import process from 'node:process';

const args = new Set(process.argv.slice(2));

function posixQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// This source-checkout helper is intentionally preview-only. Destructive reset code must come
// from the already-installed, reviewed CLI rather than modules that the checkout can replace.
if (args.has('--yes')) {
  console.error('Fresh install reset refused: this source-checkout helper cannot delete data.');
  console.error('Use the trusted installed CLI: singularity-flow fresh-install --checkout DIRECTORY --yes');
  process.exitCode = 1;
} else {
  try {
    const { freshInstallResetPlan } = await import('../src/fresh-install-reset.mjs');
    const result = await freshInstallResetPlan({
      homeDirectory: process.env.HOME,
      projectDirectory: process.cwd(),
      environment: process.env
    });
    if (args.has('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      console.log('Singularity Flow fresh-install reset — preview');
      console.log(`Registered workspaces to delete: ${result.workspaces.length}`);
      for (const workspace of result.workspaces) console.log(`  - ${workspace.name}: ${workspace.path}`);
      if (result.missingRegistrations.length) {
        console.log(`Already-missing registrations: ${result.missingRegistrations.length}`);
        for (const target of result.missingRegistrations) console.log(`  - ${target}`);
      }
      if (result.installerGeneratedPaths.length) {
        console.log('Generated state in this installer checkout:');
        for (const target of result.installerGeneratedPaths) console.log(`  - ${target}`);
      }
      console.log('Additional reset targets:');
      for (const target of result.remove.slice(
        result.installerGeneratedPaths.length + result.workspaces.length
      )) console.log(`  - ${target}`);
      const recoveryArgv = [
        'singularity-flow', 'fresh-install', '--checkout', process.cwd(), '--yes'
      ];
      console.log('\nDeletion must use the trusted installed CLI:');
      console.log(`  macOS/Linux: ${recoveryArgv.map(posixQuote).join(' ')}`);
      console.log(`  PowerShell: & ${recoveryArgv.map(powershellQuote).join(' ')}`);
    }
  } catch (error) {
    console.error(`Fresh install reset refused: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  }
}
