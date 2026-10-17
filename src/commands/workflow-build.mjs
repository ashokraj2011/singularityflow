/**
 * `workflow build start | add | status` — start a progressive workflow build from a workflow the
 * repository has, from a team's material, or from a description, and see what it holds
 * (src/workflow-build/). Builds are machine-local; nothing here changes a repository.
 */
import { readFile } from 'node:fs/promises';
import { SingularityFlowError, commandLineFile, optionBoolean, optionString, optionStrings } from '../util.mjs';

const OPTIONS = {
  start: new Set(['from-workflow', 'folder', 'file', 'notes', 'describe', 'name', 'json']),
  add: new Set(['build', 'folder', 'file', 'notes', 'json']),
  status: new Set(['build', 'json'])
};
const SHOWN_PER_KIND = 12;

function refuse(message, code = 'WORKFLOW_BUILD_USAGE') {
  throw new SingularityFlowError(message, { code });
}

async function repositoryRoot() {
  try { return (await import('../git.mjs')).repoRoot(); } catch { return null; }
}

async function notesFrom(options, root) {
  const notes = [];
  for (const value of optionStrings(options, 'notes')) {
    notes.push(value === '-' ? await (await import('../read-stdin.mjs')).readStdinText() : await readFile(commandLineFile(root, value, { reads: true }), 'utf8'));
  }
  return notes;
}

/** Where an item was found: a file, or a file and line; nothing more when its name already says it. */
const where = (entry) => {
  const span = entry.evidence?.[0];
  if (!span) return '';
  const file = span.path.replace(/^configuration:/u, '');
  const located = span.startLine > 1 || (span.endLine === span.startLine && entry.kind !== 'withheld') ? `${file}:${span.startLine}` : file;
  return located === entry.name ? '' : `  ${located}`;
};

function printBuild(view) {
  const { build } = view;
  const { ITEM_KIND_LABELS, ITEM_KINDS } = view.labels;
  console.log(`Build ${build.id}: ${build.label}`);
  for (const turn of build.conversation.slice(-1)) console.log(`  ${turn.text}`);
  for (const kind of ITEM_KINDS) {
    const items = build.items.filter((entry) => entry.kind === kind);
    if (!items.length) continue;
    console.log(`${ITEM_KIND_LABELS[kind]} (${items.length})`);
    for (const entry of items.slice(0, SHOWN_PER_KIND)) {
      console.log(`  ${entry.name.length > 70 ? `${entry.name.slice(0, 69)}…` : entry.name}${where(entry)}${entry.detail ? `  · ${entry.detail}` : ''}`);
    }
    if (items.length > SHOWN_PER_KIND) console.log(`  … and ${items.length - SHOWN_PER_KIND} more (--json lists every item)`);
  }
  console.log(`Kept on this computer until ${build.expiresAt.slice(0, 10)}. Nothing was run, fetched or changed in a repository.`);
  console.log(`  Add more: singularity-flow workflow build add --build ${build.id} --folder <DIR> | --file <FILE> | --notes <FILE>`);
  console.log(`  See it again: singularity-flow workflow build status --build ${build.id}`);
}

export async function run(argv, { positionals, options }) {
  const action = positionals[2] ?? 'status';
  if (!OPTIONS[action]) refuse(`workflow build supports start, add and status, not '${action}'.`);
  const unknown = Object.keys(options).filter((key) => !OPTIONS[action].has(key));
  if (unknown.length) refuse(`workflow build ${action} does not take --${unknown[0]}.`);
  if (positionals.length > 3) refuse(`workflow build ${action} takes options only, for example --folder <DIR>.`);
  const api = await import('../workflow-build/build.mjs');
  const inventory = await import('../workflow-build/inventory.mjs');
  const labels = { ITEM_KIND_LABELS: inventory.ITEM_KIND_LABELS, ITEM_KINDS: inventory.ITEM_KINDS };
  const root = await repositoryRoot();
  const json = optionBoolean(options, 'json');
  const material = async () => ({
    folders: optionStrings(options, 'folder').map((value) => commandLineFile(root, value, { reads: true })),
    files: optionStrings(options, 'file').map((value) => commandLineFile(root, value, { reads: true })),
    notes: await notesFrom(options, root)
  });
  if (action === 'status' && !optionString(options, 'build')) {
    const builds = await api.listWorkflowBuilds();
    const list = builds.map((record) => ({ id: record.id, label: record.goal.label, updatedAt: record.updatedAt, expiresAt: record.expiresAt,
      repository: record.repository, counts: inventory.itemCounts(record.items) }));
    if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'workflow-builds', builds: list }, null, 2));
    if (!list.length) return console.log('No workflow builds on this computer. Start one: singularity-flow workflow build start --folder <DIR> | --from-workflow <ID>');
    for (const entry of list) {
      console.log(`${entry.id}  ${entry.label}  changed ${entry.updatedAt.slice(0, 16).replace('T', ' ')}  ${Object.entries(entry.counts).map(([kind, count]) => inventory.countWords(kind, count)).join(', ')}`);
    }
    return;
  }
  let record;
  if (action === 'start') {
    record = await api.startWorkflowBuild({ root, fromWorkflow: optionString(options, 'from-workflow') ?? null, ...(await material()),
      describe: optionString(options, 'describe') ?? null, name: optionString(options, 'name') ?? null });
  } else if (action === 'add') {
    const id = optionString(options, 'build');
    if (!id) refuse('Name the build: workflow build add --build <ID> --folder <DIR>.');
    record = await api.addToWorkflowBuild(id, await material());
  } else {
    record = await api.readWorkflowBuild(optionString(options, 'build'));
  }
  const view = api.workflowBuildView(record);
  if (json) return console.log(JSON.stringify(view, null, 2));
  printBuild({ ...view, labels });
}
