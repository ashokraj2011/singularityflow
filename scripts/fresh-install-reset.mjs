#!/usr/bin/env node
import process from 'node:process';
import { freshInstallReset, freshInstallResetPlan, FRESH_INSTALL_CONFIRMATION } from '../src/fresh-install-reset.mjs';

const args = new Set(process.argv.slice(2));
const apply = args.has('--yes');

try {
  const options = {
    homeDirectory: process.env.HOME,
    projectDirectory: process.cwd(),
    environment: process.env,
    ...(apply ? { confirmation: FRESH_INSTALL_CONFIRMATION } : {})
  };
  const result = apply ? await freshInstallReset(options) : await freshInstallResetPlan(options);
  if (args.has('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    console.log(`Singularity Flow fresh-install reset — ${result.completed ? 'complete' : 'preview'}`);
    console.log(`Registered workspaces to delete: ${result.workspaces.length}`);
    for (const workspace of result.workspaces) console.log(`  - ${workspace.name}: ${workspace.path}`);
    if (result.missingRegistrations.length) {
      console.log(`Already-missing registrations: ${result.missingRegistrations.length}`);
      for (const target of result.missingRegistrations) console.log(`  - ${target}`);
    }
    console.log('Additional reset targets:');
    for (const target of result.remove.slice(result.workspaces.length)) console.log(`  - ${target}`);
    if (!apply) console.log(`\nTo delete this exact boundary and reinstall, run: ./install.sh --factory-reset --yes`);
  }
} catch (error) {
  console.error(`Fresh install reset refused: ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}
