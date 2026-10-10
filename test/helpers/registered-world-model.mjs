/**
 * The registered World Model (WMB v4) is off unless a repository sets `worldModel.registered: on`.
 * Tests of the registered model turn it on in their fixture's configuration, keeping its formatting.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function enableRegisteredWorldModel(root, relative = path.join('singularity', 'workflow.yml')) {
  const file = path.join(root, relative);
  const text = await readFile(file, 'utf8');
  if (/^ {2}registered: on$/mu.test(text)) return;
  const next = /^ {2}registered: off$/mu.test(text)
    ? text.replace(/^ {2}registered: off$/mu, '  registered: on')
    : text.replace(/^worldModel:\n/mu, 'worldModel:\n  registered: on\n');
  if (next === text) throw new Error(`${relative} has no worldModel section to turn the registered World Model on in.`);
  await writeFile(file, next);
}

/** The same switch on an in-memory definition. */
export function withRegisteredWorldModel(definition = {}) {
  return { ...definition, worldModel: { ...(definition.worldModel ?? {}), registered: 'on' } };
}
