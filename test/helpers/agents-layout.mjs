// A repository as an SFlow build before SPEC-AGH left it: agents in .github/agents and no
// agentPromptsRoot in workflow.yml. Tests of the legacy layout build their fixture with init and then
// this, so the legacy behaviour SPEC-AGH keeps [AGH:REQ-005] stays tested.
import { mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function toLegacyAgentsLayout(root) {
  const home = path.join(root, 'singularity', 'agents');
  const legacy = path.join(root, '.github', 'agents');
  await mkdir(legacy, { recursive: true });
  for (const name of await readdir(home).catch(() => [])) await rename(path.join(home, name), path.join(legacy, name));
  await rmdir(home).catch(() => {});
  const file = path.join(root, 'singularity', 'workflow.yml');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace(/^# SFlow's step agents live in singularity\/agents;.*\r?\n/mu, '').replace(/^agentPromptsRoot:.*\r?\n/mu, ''));
}

/** A legacy-layout workflow.yml (the packaged one, with no agentPromptsRoot) in a repository with none. */
export async function writeLegacyWorkflow(root) {
  const packaged = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../templates/workflow.yml');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), await readFile(packaged));
}
