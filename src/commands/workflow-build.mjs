/**
 * `workflow build start | add | status` — start a progressive workflow build from a workflow the
 * repository has, from a team's material, or from a description, and see what it holds
 * (src/workflow-build/). Builds are machine-local; nothing here changes a repository.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SingularityFlowError, commandLineFile, optionBoolean, optionString, optionStrings } from '../util.mjs';

const OPTIONS = {
  start: new Set(['from-workflow', 'folder', 'file', 'notes', 'describe', 'name', 'json']),
  add: new Set(['build', 'folder', 'file', 'notes', 'json']),
  status: new Set(['build', 'json']),
  propose: new Set(['build', 'proposal', 'by', 'accept', 'json']),
  source: new Set(['build', 'path', 'from', 'json']),
  decide: new Set(['build', 'proposal', 'accept', 'decline', 'reason', 'json']),
  answer: new Set(['build', 'question', 'choice', 'json']),
  check: new Set(['build', 'include', 'json']),
  finish: new Set(['build', 'propose', 'out', 'json'])
};
const SEVERITY = { problem: 'problem', warning: 'warning', note: 'note' };
const SHOWN_PER_KIND = 12;

function refuse(message, code = 'WORKFLOW_BUILD_USAGE') {
  throw new SingularityFlowError(message, { code });
}

/**
 * The one file a /sf-build-workflow turn may write: the build's proposal.json, issued to every live
 * build-workflow turn for this repository. Shown as proposalPath; a paused Copilot gets none.
 */
async function issueProposalPath(id, root) {
  const { workflowBuildPaths } = await import('../workflow-build/store.mjs');
  const proposalPath = path.join((await workflowBuildPaths(id)).directory, 'proposal.json');
  await import('../copilot-mutation-guard.mjs').then(({ issueBuildStaging }) => issueBuildStaging(proposalPath, { root })).catch(() => 0);
  return proposalPath;
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

function printCheck(result) {
  console.log(`${result.draft.workflow.label} (${result.build.workflow}): ${result.explanation?.summary ?? `${result.draft.workflow.phases.length} steps so far.`}`);
  for (const step of result.explanation?.steps ?? []) {
    console.log(`  ${step.number}. ${step.label}: ${step.what}${step.why ? ` Why: ${step.why.text}` : ''}`);
  }
  for (const problem of result.plan.problems) console.log(`  problem  ${problem.message}`);
  for (const finding of result.findings) {
    console.log(`  ${SEVERITY[finding.severity].padEnd(8)} ${finding.title}${finding.location ? `  (${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ''})` : ''}`);
  }
  for (const proposal of result.pending) console.log(`  waiting  ${proposal.id} by ${proposal.by}: ${proposal.title}`);
  for (const question of result.questions) console.log(`  question ${question.id}: ${question.question} (${question.choices.join(' | ')})`);
  if (result.landed) {
    console.log(`Finished: ${result.landed.label} is in the approved configuration. To change it: singularity-flow workflow build start --from-workflow ${result.landed.workflow}`);
    return;
  }
  console.log(result.ready ? 'Ready to finish: singularity-flow workflow build finish --build ' + result.build.id + ' --propose'
    : `Not ready to finish: ${result.counts.problem} problem${result.counts.problem === 1 ? '' : 's'}${result.questions.some((question) => question.blocking) ? ', questions waiting for an answer' : ''}.`);
}

async function engineAction(action, { options, root, json, buildId, api, labels }) {
  const engine = await import('../workflow-build/engine.mjs');
  const id = buildId();
  if (action === 'check') {
    const result = await engine.checkBuild(id, { root, include: optionString(options, 'include') ?? null });
    if (json) return console.log(JSON.stringify({ ...result, proposalPath: await issueProposalPath(id, root) }, null, 2));
    return printCheck(result);
  }
  if (action === 'source') {
    const from = optionString(options, 'from');
    if (from != null && !/^[1-9]\d{0,6}$/u.test(from)) refuse('--from is a line number, 1 or more.');
    const result = await engine.sourceOfBuild(id, optionString(options, 'path') ?? refuse('Name the captured file: --path <PATH>.'), { from: from ? Number(from) : 1 });
    if (json) return console.log(JSON.stringify(result, null, 2));
    const width = String(result.endLine).length;
    result.lines.forEach((line, index) => console.log(`${String(result.startLine + index).padStart(width)}  ${line}`));
    if (result.next) console.log(`… ${result.totalLines - result.endLine} more lines: --from ${result.next}`);
    return;
  }
  if (action === 'finish') {
    const out = optionString(options, 'out');
    const result = await engine.finishBuild(id, { root, propose: optionBoolean(options, 'propose'), out: out ? commandLineFile(root, out) : null, json });
    if (result.kind === 'bundle') {
      if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'workflow-build-finish', kind: 'bundle', path: result.path, bundleSha256: result.bundleSha256 }, null, 2));
      console.log(`Wrote ${result.path} (${result.bundleSha256}). Import it in Workflow Studio, or: singularity-flow workflow import ${result.path} --dry-run`);
    }
    return;
  }
  let record;
  if (action === 'propose') {
    const source = optionString(options, 'proposal') ?? refuse('Give the proposal: --proposal <FILE> or --proposal - (standard input).');
    const text = source === '-' ? await (await import('../read-stdin.mjs')).readStdinText() : await readFile(commandLineFile(root, source, { reads: true }), 'utf8');
    let payload;
    try { payload = JSON.parse(text); } catch (error) { refuse(`The proposal is not valid JSON: ${error.message}`, 'WORKFLOW_BUILD_PROPOSAL_INVALID'); }
    ({ record } = await engine.proposeToBuild(id, payload, { root, by: optionString(options, 'by') ?? 'copilot', accept: optionBoolean(options, 'accept') }));
  } else if (action === 'decide') {
    const accept = optionBoolean(options, 'accept');
    if (accept === optionBoolean(options, 'decline')) refuse('Decide with --accept or --decline.');
    record = await engine.decideInBuild(id, optionString(options, 'proposal') ?? refuse('Name the proposal: --proposal p-1.'), { accept, reason: optionString(options, 'reason') ?? null, root });
  } else {
    record = await engine.answerInBuild(id, optionString(options, 'question') ?? refuse('Name the question: --question q-1.'), optionString(options, 'choice') ?? refuse('Give the answer: --choice <TEXT>.'));
  }
  const view = { ...api.workflowBuildView(record), proposalPath: await issueProposalPath(record.id, root) };
  if (json) return console.log(JSON.stringify(view, null, 2));
  const last = record.conversation.slice(-3).map((turn) => `  ${turn.by === 'you' ? 'You' : turn.by === 'copilot' ? 'Copilot' : 'SFlow'}: ${turn.text}`);
  console.log(`Build ${record.id}: ${record.goal.label}`);
  for (const line of last) console.log(line);
  console.log(`  Next: singularity-flow workflow build check --build ${record.id}`);
}

export async function run(argv, { positionals, options }) {
  const action = positionals[2] ?? 'status';
  if (!OPTIONS[action]) refuse(`workflow build supports ${Object.keys(OPTIONS).join(', ')}, not '${action}'.`);
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
    const list = builds.map((record) => {
      const counts = inventory.itemCounts(record.items);
      return { id: record.id, label: record.goal.label, updatedAt: record.updatedAt, expiresAt: record.expiresAt, repository: record.repository, counts,
        found: Object.entries(counts).filter(([kind]) => kind !== 'withheld').map(([kind, count]) => inventory.countWords(kind, count)).join(', '),
        finished: record.finished ? { at: record.finished.at, kind: record.finished.kind } : null };
    });
    if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'workflow-builds', builds: list }, null, 2));
    if (!list.length) return console.log('No workflow builds on this computer. Start one: singularity-flow workflow build start --folder <DIR> | --from-workflow <ID>');
    for (const entry of list) {
      console.log(`${entry.id}  ${entry.label}  changed ${entry.updatedAt.slice(0, 16).replace('T', ' ')}  ${Object.entries(entry.counts).map(([kind, count]) => inventory.countWords(kind, count)).join(', ')}`);
    }
    return;
  }
  const buildId = () => optionString(options, 'build') ?? refuse(`Name the build: workflow build ${action} --build <ID>.`);
  if (['propose', 'decide', 'answer', 'check', 'finish', 'source'].includes(action)) return engineAction(action, { options, root, json, buildId, api, labels });
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
  const view = { ...api.workflowBuildView(record), proposalPath: await issueProposalPath(record.id, root) };
  if (json) return console.log(JSON.stringify(view, null, 2));
  printBuild({ ...view, labels });
}
