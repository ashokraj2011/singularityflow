import { listLeadRepositories } from '../lead-repositories.mjs';
import { optionBoolean } from '../util.mjs';

let legacy = null;

function isLeads(context = {}) {
  return context.positionals?.[1] === 'leads';
}

async function loadLegacy() {
  legacy ??= await import('./legacy.mjs');
  await legacy.load();
  return legacy;
}

/** Preserve legacy module-load timing for every capability operation except the startup read. */
export async function load(context = {}) {
  if (!isLeads(context)) await loadLegacy();
}

export async function run(argv, context = {}) {
  if (!isLeads(context)) return (await loadLegacy()).run(argv);
  const leads = await listLeadRepositories();
  if (optionBoolean(context.options ?? {}, 'json')) return console.log(JSON.stringify(leads, null, 2));
  if (!leads.length) return console.log('No lead repository is known yet.');
  for (const lead of leads) console.log(`  ${lead.url}`);
}
