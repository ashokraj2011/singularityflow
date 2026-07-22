import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { exists } from './util.mjs';
import { SingularityFlowError, nowIso } from './util.mjs';

function sessionPath(root) {
  return path.join(root, '.git/singularity-flow/session.json');
}

async function choose(label, entries) {
  if (label === 'persona' && process.env.SINGULARITY_FLOW_GITHUB_PERSONA) {
    const selected = process.env.SINGULARITY_FLOW_GITHUB_PERSONA;
    if (!entries.some(([id]) => id === selected)) throw new SingularityFlowError(`Unknown GitHub approval persona '${selected}'.`);
    return selected;
  }
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_SELECTION) {
      const selection = JSON.parse(process.env.SINGULARITY_FLOW_TEST_SELECTION);
      const selected = selection[label === 'workflow template' ? 'workType' : label === 'intake source' ? 'source' : 'persona']
        ?? (label === 'intake source' ? 'manual' : undefined);
      if (entries.some(([id]) => id === selected)) return selected;
    }
    throw new SingularityFlowError(`Selecting a ${label} requires an interactive terminal.`);
  }
  const io = readline.createInterface({ input, output });
  try {
    console.log(`\nChoose ${label}:`);
    entries.forEach(([id, item], index) => console.log(`  ${index + 1}. ${item.label} (${id})${item.description ? ` — ${item.description}` : ''}`));
    const answer = (await io.question(`Enter 1-${entries.length}: `)).trim();
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || !entries[index]) throw new SingularityFlowError(`Invalid ${label} selection.`);
    return entries[index][0];
  } finally { io.close(); }
}

export async function selectWorkType(definition) {
  return choose('workflow template', Object.entries(definition.workTypes));
}

export async function selectIntakeSource() {
  return choose('intake source', [
    ['jira', { label: 'Jira story', description: 'Retrieve the work item and configured fields from Jira.' }],
    ['manual', { label: 'Manual description and documents', description: 'Enter the request and attach local files or URLs.' }]
  ]);
}

export async function selectPersona(root, definition, actor, workId = null) {
  const persona = await choose('persona', Object.entries(definition.personas));
  return setPersonaSession(root, definition, actor, persona, workId);
}

export async function setPersonaSession(root, definition, actor, persona, workId = null) {
  if (!definition.personas?.[persona]) throw new SingularityFlowError(`Unknown persona '${persona}'.`);
  const existing = await loadSession(root, { required: false });
  const record = { ...(existing?.agent ? { agent: existing.agent, agentSource: existing.agentSource, agentSelectedAt: existing.agentSelectedAt } : {}), persona, actor, workId, selectedAt: nowIso() };
  await mkdir(path.dirname(sessionPath(root)), { recursive: true });
  await writeFile(sessionPath(root), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function setAgentSession(root, agent, actor = null) {
  const existing = await loadSession(root, { required: false });
  const record = { ...(existing ?? {}), agent: agent.id, agentSource: agent.source, agentSelectedAt: nowIso() };
  if (actor && !record.actor) record.actor = actor;
  await mkdir(path.dirname(sessionPath(root)), { recursive: true });
  await writeFile(sessionPath(root), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function loadSession(root, { required = true } = {}) {
  const file = sessionPath(root);
  if (!(await exists(file))) {
    if (required) throw new SingularityFlowError('No active persona session. Run singularity-flow resume <WORK-ID> and choose a persona.');
    return null;
  }
  return JSON.parse(await readFile(file, 'utf8'));
}
