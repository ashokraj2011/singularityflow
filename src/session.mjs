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
      const selected = JSON.parse(process.env.SINGULARITY_FLOW_TEST_SELECTION)[label === 'work type' ? 'workType' : 'persona'];
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
  return choose('work type', Object.entries(definition.workTypes));
}

export async function selectPersona(root, definition, actor, workId = null) {
  const persona = await choose('persona', Object.entries(definition.personas));
  const record = { persona, actor, workId, selectedAt: nowIso() };
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
