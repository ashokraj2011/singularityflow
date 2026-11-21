/**
 * `workflow build start | add | status` — start a progressive workflow build from a workflow the
 * repository has (changed in place with --change, copied with --from-workflow, or a simpler new copy
 * with --simplify, verified before it finishes), from a team's material, or from a description, and see what it holds
 * (src/workflow-build/). Builds are machine-local; nothing here changes a repository.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SingularityFlowError, commandLineFile, optionBoolean, optionString, optionStrings } from '../util.mjs';

const OPTIONS = {
  start: new Set(['change', 'from-workflow', 'folder', 'file', 'notes', 'describe', 'name', 'simplify', 'assess', 'intents', 'json']),
  add: new Set(['build', 'folder', 'file', 'notes', 'json']),
  status: new Set(['build', 'json']),
  propose: new Set(['build', 'proposal', 'by', 'accept', 'json']),
  source: new Set(['build', 'path', 'from', 'json']),
  decide: new Set(['build', 'proposal', 'accept', 'decline', 'reason', 'all', 'json']),
  answer: new Set(['build', 'question', 'choice', 'json']),
  check: new Set(['build', 'include', 'json']),
  intents: new Set(['build', 'intent', 'rule', 'confirm', 'json']),
  verify: new Set(['build', 'json']),
  finish: new Set(['build', 'propose', 'out', 'accept-problem', 'json']),
  export: new Set(['build', 'out', 'json']),
  import: new Set(['file', 'json'])
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
/** An assess build's findings file, issued like its proposal file (SPEC-WIA). */
async function issueFindingsPath(view, root) {
  const target = view.build?.assess?.findingsPath;
  if (!target) return;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }).catch(() => null);
  await import('../copilot-mutation-guard.mjs').then(({ issueBuildStaging, issueFixWorkflowStaging }) => Promise.all([
    issueBuildStaging(target, { root }), issueFixWorkflowStaging(target, { root })])).catch(() => 0);
}

async function issueProposalPath(id, root) {
  const { workflowBuildPaths } = await import('../workflow-build/store.mjs');
  const proposalPath = path.join((await workflowBuildPaths(id)).directory, 'proposal.json');
  // A /sf-fix-workflow turn applies the assessment's suggestions through a build too (SPEC-WIA).
  await import('../copilot-mutation-guard.mjs').then(({ issueBuildStaging, issueFixWorkflowStaging }) => Promise.all([
    issueBuildStaging(proposalPath, { root }), issueFixWorkflowStaging(proposalPath, { root })])).catch(() => 0);
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
  if (build.simplify) printCandidates(build);
  if (build.assess) printAssessment(build);
  console.log(`Kept on this computer until ${build.expiresAt.slice(0, 10)}. Nothing was run, fetched or changed in a repository.`);
  console.log(`  Add more: singularity-flow workflow build add --build ${build.id} --folder <DIR> | --file <FILE> | --notes <FILE>`);
  console.log(`  See it again: singularity-flow workflow build status --build ${build.id}`);
}

const where2 = (location) => (location ? `  (${location.file}${location.line ? `:${location.line}` : ''})` : '');

/** A simplify build's candidates: each located, with why; offered ones wait for the person's decision. */
function printCandidates(build) {
  const { candidates } = build.simplify;
  const status = (candidate) => {
    const proposal = build.proposals.find((entry) => entry.id === candidate.proposal);
    return proposal ? `${proposal.id} ${proposal.status}` : 'not offered';
  };
  console.log(candidates.length ? `Ways to make ${build.simplify.from} simpler (${candidates.length}):` : `Nothing the platform can see makes ${build.simplify.from} simpler.`);
  for (const candidate of candidates) {
    console.log(`  ${status(candidate).padEnd(14)} ${candidate.title}${where2(candidate.location)}`);
    console.log(`                 Why: ${candidate.why}`);
    if (candidate.notOffered) console.log(`                 Not offered: ${candidate.notOffered}`);
  }
  const pending = build.proposals.filter((entry) => entry.status === 'pending' && entry.by === 'sflow');
  if (pending.length) console.log(`  Decide each: singularity-flow workflow build decide --build ${build.id} --proposal <P> --accept | --decline --reason <TEXT>`);
  console.log(`  Before finishing: ${build.simplify.verify}`);
}

/** An assess build's suggestions: each located, with why and its effect; offered ones wait for the person's decision. */
function printAssessment(build) {
  const { candidates, before } = build.assess;
  const status = (candidate) => {
    const proposal = build.proposals.find((entry) => entry.id === candidate.proposal);
    return proposal ? `${proposal.id} ${proposal.status}` : 'not offered';
  };
  if (build.assess.verdict) console.log(`${build.assess.workflow}: ${build.assess.verdict.text}`);
  if (before) console.log(`  Now: ${before.bytes.toLocaleString('en-US')} bytes its agents receive (your team's ${before.teamBytes.toLocaleString('en-US')}); ${before.counts.problem} problems, ${before.counts.warning} warnings, ${before.counts.note} notes.`);
  for (const candidate of candidates) {
    console.log(`  ${status(candidate).padEnd(14)} ${candidate.title}${candidate.choiceLabel ? `: ${candidate.choiceLabel}` : ''}${where2(candidate.location)}${candidate.decidedBy === 'sflow' ? '' : '  (a person\'s choice)'}`);
    if (candidate.effect?.after) {
      const { before: was, after } = candidate.effect;
      console.log(`                 After it: ${after.bytes.toLocaleString('en-US')} bytes (${(after.bytes - was.bytes).toLocaleString('en-US')}); ${after.counts.problem} problems, ${after.counts.warning} warnings, ${after.counts.note} notes.`);
    }
    if (candidate.notOffered) console.log(`                 Not offered: ${candidate.notOffered}`);
  }
  if (build.proposals.some((entry) => entry.status === 'pending' && entry.by === 'sflow' && entry.decidedBy !== 'person')) {
    console.log(`  Accept every one SFlow decided itself: singularity-flow workflow build decide --build ${build.id} --accept --all`);
  }
  console.log(`  Decide each: singularity-flow workflow build decide --build ${build.id} --proposal <P> --accept | --decline --reason <TEXT>`);
  console.log(`  Before finishing: ${build.assess.verify}`);
}

/** What `workflow build verify` found in the workflow the build would propose. */
function printVerification(result) {
  console.log(`${result.build.label} (${result.build.workflow})${result.build.from ? `, simpler than ${result.build.from}` : ''}: checked with workflow validate${result.walk.available ? ' and workflow walk' : ''} on what it would propose.`);
  if (!result.walk.available) console.log(`  ${result.walk.reason ?? 'workflow walk did not run.'}`);
  else console.log(`  The walk ${result.walk.outcome ? `${result.walk.outcome}` : 'ran'}${result.walk.reused ? ' (kept from the last verify; nothing changed since)' : ''}.`);
  if (result.assessment?.before && result.assessment.after) {
    const { before, after } = result.assessment;
    const counts = (entry) => `${entry.counts.problem} problems, ${entry.counts.warning} warnings, ${entry.counts.note} notes`;
    console.log(`  What its agents are told: ${before.bytes.toLocaleString('en-US')} bytes before, ${after.bytes.toLocaleString('en-US')} after (your team's ${before.teamBytes.toLocaleString('en-US')} → ${after.teamBytes.toLocaleString('en-US')}); ${counts(before)} before, ${counts(after)} after.`);
  }
  for (const item of result.remaining) {
    console.log(`  ${(item.source === 'walk' ? (item.kind === 'not-judged' ? 'unjudged' : 'stop') : 'problem').padEnd(8)} ${item.title}${where2(item.location)}  [${item.id}${item.acceptable ? '' : ', cannot be accepted'}${result.accepted.includes(item.id) ? ', accepted' : ''}]`);
    if (item.fix) console.log(`           Fix: ${item.fix}`);
  }
  console.log(result.ready ? `Nothing remains. Finish: ${result.finish}`
    : `Not ready to finish: ${result.remaining.length} problem${result.remaining.length === 1 ? '' : 's'} or stop${result.remaining.length === 1 ? '' : 's'} remain. Accept a change that fixes each; only if the person accepts one as it is, finish with --accept-problem <ID>.`);
}

/** What the build adds, removes, moves or changes in the workflow it starts from; a removed step names what leaves with it. */
function printChanges(changes) {
  if (!changes) return;
  console.log(changes.inPlace ? `Changes to ${changes.label}:` : `Compared with ${changes.label}, which this copies:`);
  if (changes.none) return console.log('  nothing yet');
  if (changes.renamed) console.log(`  renamed  ${changes.renamed.from} → ${changes.renamed.to}`);
  for (const step of changes.added) console.log(`  added    ${step.label} (step ${step.position})`);
  for (const step of changes.removed) console.log(`  removed  ${step.label}${step.goes.length ? `; with it go ${step.goes.join(', ')}` : ''}`);
  for (const step of changes.moved) console.log(`  moved    ${step.label} to step ${step.position}`);
  for (const step of changes.changed) console.log(`  changed  ${step.label}: ${step.what.join(', ')}`);
  for (const decision of changes.decisions.added) console.log(`  added    decision after ${decision.after}: ${decision.label}`);
  for (const decision of changes.decisions.removed) console.log(`  removed  decision after ${decision.after}: ${decision.label}`);
}

/** What each step is for (step intents §6.4): every row with its badge and consequences, the facts, and the next command. */
function printIntents(table, { heading = true } = {}) {
  if (heading) console.log(`What each step of ${table.workflow} is for:`);
  for (const row of table.rows) {
    console.log(`  ${row.label}: ${row.intent} (${row.intentLabel.toLowerCase()})  [${row.badgeText}]  ${row.consequences.join(' · ')}`);
    console.log(`      Why: ${row.why}`);
    if (!row.question) continue;
    console.log(`      ${row.question.question}`);
    for (const choice of row.question.choices) console.log(`        ${choice.text}: ${choice.command}`);
  }
  for (const line of table.facts.lines) console.log(`  ${line}`);
  for (const question of table.questions) {
    console.log(`  ${question.question}`);
    for (const choice of question.choices) console.log(`    ${choice.label}: ${choice.command}`);
  }
  for (const problem of table.problems) console.log(`  problem  ${problem.message} ${problem.fix}`);
  if (table.confirmed) console.log('  Confirmed: every step says what it is for.');
  else if (table.confirmCommand) console.log(`  Confirm this table (code ${table.code}): ${table.confirmCommand}`);
  else if (table.open) console.log(`  ${table.open} ${table.open === 1 ? 'answer is' : 'answers are'} needed above before you confirm.`);
}

function printCheck(result) {
  console.log(`${result.draft.workflow.label} (${result.build.workflow}): ${result.explanation?.summary ?? `${result.draft.workflow.phases.length} steps so far.`}`);
  const changeImpact = result.preview?.workflows?.[0]?.changeImpact;
  if (changeImpact) console.log(`  ${changeImpact.text}.`);
  for (const step of result.explanation?.steps ?? []) {
    console.log(`  ${step.number}. ${step.label}: ${step.what}${step.why ? ` Why: ${step.why.text}` : ''}`);
    // Its parts, named: who drafts it, the skills and instructions it uses, what it reads, who signs it off.
    const parts = [step.agent ? `agent ${step.agent.label}` : 'no agent',
      step.skills.length ? `skills ${step.skills.map((skill) => skill.label).join(', ')}` : null,
      step.instructions.length ? `instructions ${step.instructions.join(', ')}` : null,
      step.reads.length ? `reads ${step.reads.map((read) => read.label).join(', ')}` : null,
      step.checks?.length ? `checks ${step.checks.map((check) => check.command).join(', ')}` : null].filter(Boolean);
    console.log(`     ${parts.join(' · ')}. ${step.signOff}`);
  }
  printChanges(result.changes);
  if (result.intents?.required && !result.intents.confirmed) {
    console.log(`  What each step is for: ${result.intents.open ? `${result.intents.open} ${result.intents.open === 1 ? 'row needs' : 'rows need'} your answer, then confirm` : 'confirm the table'}: ${result.intents.show}`);
  }
  for (const problem of result.plan.problems) console.log(`  problem  ${problem.message}`);
  for (const finding of result.findings) {
    console.log(`  ${SEVERITY[finding.severity].padEnd(8)} ${finding.title}${finding.location ? `  (${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ''})` : ''}`);
  }
  for (const proposal of result.pending) console.log(`  waiting  ${proposal.id} by ${proposal.by}: ${proposal.title}`);
  for (const question of result.questions) console.log(`  question ${question.id}: ${question.question} (${question.choices.join(' | ')})`);
  if (result.landed) {
    console.log(result.landed.change && result.landed.activated
      ? `Finished and activated: ${result.landed.label} is in the approved configuration with this change. To change it again: singularity-flow workflow build start --change ${result.landed.workflow}`
      : result.landed.change
      ? `Finished: the change to ${result.landed.label} was proposed; once it is reviewed and activated, new Stories use it. To change it again: singularity-flow workflow build start --change ${result.landed.workflow}`
      : `Finished: ${result.landed.label} is in the approved configuration. To change it in place: singularity-flow workflow build start --change ${result.landed.workflow}`);
    return;
  }
  if ((result.simplify || result.assess) && result.ready) return console.log(`No problem in the check. Before finishing, verify it: ${(result.simplify ?? result.assess).verify}`);
  console.log(result.ready ? 'Ready to finish: singularity-flow workflow build finish --build ' + result.build.id + ' --propose'
    : result.unchanged ? 'Not ready to finish: nothing is changed yet.'
      : result.counts.problem === 0 && result.intents?.required && !result.intents.confirmed ? `Not ready to finish: confirm what each step is for first: ${result.intents.show}`
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
  if (action === 'intents') {
    const set = optionStrings(options, 'intent').map((value) => {
      const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)=([a-z]+)$/u.exec(value);
      if (!match) refuse(`--intent takes STEP=INTENT, such as --intent run-checks=test; '${value}' is not that.`);
      return { step: match[1], intent: match[2] };
    });
    const rule = optionString(options, 'rule') ?? null;
    const confirm = optionString(options, 'confirm') ?? null;
    if (set.length || rule != null || confirm != null) await engine.settleBuildIntents(id, { set, rule, confirm, root });
    const result = await engine.checkBuild(id, { root });
    if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'workflow-build-intents', build: result.build, intents: result.intents ?? null, ready: result.ready }, null, 2));
    if (!result.intents) return console.log(`Build ${id} has no steps yet; accept a proposal that adds them first: singularity-flow workflow build check --build ${id}`);
    printIntents(result.intents);
    if (result.intents.confirmed) console.log(result.ready ? `Ready to finish: singularity-flow workflow build finish --build ${id} --propose` : `Next: singularity-flow workflow build check --build ${id}`);
    return;
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
  if (action === 'verify') {
    // A walk drives a throwaway Story through every step: minutes, so the person hears why it waits.
    if (!json) process.stderr.write('Checking what the build would propose with workflow validate, and workflow walk where this SFlow has it (a walk takes minutes)...\n');
    const result = await (await import('../workflow-build/simplify.mjs')).verifyBuild(id, { root });
    if (!result.ready) process.exitCode = 1;
    if (json) return console.log(JSON.stringify(result, null, 2));
    return printVerification(result);
  }
  if (action === 'finish') {
    const out = optionString(options, 'out');
    const result = await engine.finishBuild(id, { root, propose: optionBoolean(options, 'propose'), out: out ? commandLineFile(root, out) : null, json,
      acceptProblems: optionStrings(options, 'accept-problem') });
    if (result.kind === 'bundle') {
      if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'workflow-build-finish', kind: 'bundle', path: result.path, bundleSha256: result.bundleSha256 }, null, 2));
      console.log(`Wrote ${result.path}. Import it in Workflow Studio, or: singularity-flow workflow import ${result.path} --dry-run`);
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
    if (optionBoolean(options, 'all')) {
      // Every pending change SFlow offered and decided itself; a person's choices stay one at a time.
      if (!accept || optionString(options, 'proposal')) refuse('--all accepts every pending change SFlow decided itself: --accept --all, without --proposal.');
      const outcome = await (await import('../workflow-assess/offer.mjs')).acceptAllSflow(id, { root });
      record = outcome.record;
      if (!json) {
        console.log(`Accepted ${outcome.accepted.length}: ${outcome.accepted.join(', ') || 'none'}.`);
        for (const entry of outcome.stale) console.log(`  ${entry.id} no longer fits what was accepted before it: ${entry.reason}`);
      }
    } else record = await engine.decideInBuild(id, optionString(options, 'proposal') ?? refuse('Name the proposal: --proposal p-1.'), { accept, reason: optionString(options, 'reason') ?? null, root });
  } else {
    record = await engine.answerInBuild(id, optionString(options, 'question') ?? refuse('Name the question: --question q-1.'), optionString(options, 'choice') ?? refuse('Give the answer: --choice <TEXT>.'));
  }
  const view = { ...api.workflowBuildView(record), proposalPath: await issueProposalPath(record.id, root) };
  await issueFindingsPath(view, root);
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
    if (!list.length) return console.log('No workflow builds on this computer. Start one: singularity-flow workflow build start --folder <DIR> | --change <ID> | --from-workflow <ID>');
    for (const entry of list) {
      console.log(`${entry.id}  ${entry.label}  changed ${entry.updatedAt.slice(0, 16).replace('T', ' ')}  ${Object.entries(entry.counts).map(([kind, count]) => inventory.countWords(kind, count)).join(', ')}`);
    }
    return;
  }
  const buildId = () => optionString(options, 'build') ?? refuse(`Name the build: workflow build ${action} --build <ID>.`);
  if (['propose', 'decide', 'answer', 'check', 'intents', 'verify', 'finish', 'source'].includes(action)) return engineAction(action, { options, root, json, buildId, api, labels });
  if (action === 'export') {
    // One file to go on with the build on another computer: its record and screened copies.
    const id = buildId();
    const target = commandLineFile(root, optionString(options, 'out') ?? refuse('Say where to write it: --out <FILE>.'));
    const transfer = await api.exportWorkflowBuild(id);
    await writeFile(target, `${JSON.stringify(transfer)}\n`, { mode: 0o600 });
    if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'workflow-build-export', build: id, path: target, files: transfer.files.length }, null, 2));
    console.log(`Wrote ${target}: build ${id} and the ${transfer.files.length} screened files it keeps. It holds the team's material; share it as you would that.`);
    return console.log(`  On the other computer, inside the repository: singularity-flow workflow build import --file <FILE>`);
  }
  let record;
  if (action === 'import') {
    const source = commandLineFile(root, optionString(options, 'file') ?? refuse('Name the build file: --file <FILE>.'), { reads: true });
    let transfer;
    try { transfer = JSON.parse(await readFile(source, 'utf8')); } catch (error) { refuse(`The build file cannot be read: ${error.message}`, 'WORKFLOW_BUILD_TRANSFER_INVALID'); }
    record = await api.importWorkflowBuild(transfer, { root });
  } else if (action === 'start') {
    // --simplify ID: a new, simpler copy of that workflow (src/workflow-build/simplify.mjs).
    const simplify = options.simplify === undefined ? null : optionString(options, 'simplify') ?? refuse('Name the workflow to simplify: --simplify <ID>.');
    if (simplify && (options['from-workflow'] !== undefined || options.change !== undefined)) refuse('--simplify ID copies that workflow itself; leave out --from-workflow and --change.');
    // --assess ID: that workflow changed in place with the assessment's suggestions (src/workflow-assess/offer.mjs).
    const assess = options.assess === undefined ? null : optionString(options, 'assess') ?? refuse('Name the workflow to assess: --assess <ID>.');
    if (assess && (simplify || options['from-workflow'] !== undefined || options.change !== undefined)) refuse('--assess ID changes that workflow itself; leave out --simplify, --from-workflow and --change.');
    // --intents ID: what each step of that workflow is for, on one screen, written in place (step intents §6.4).
    const intents = options.intents === undefined ? null : optionString(options, 'intents') ?? refuse('Name the workflow whose steps to settle: --intents <ID>.');
    if (intents && (simplify || assess || options['from-workflow'] !== undefined || options.change !== undefined)) refuse('--intents ID settles that workflow itself; leave out --simplify, --assess, --from-workflow and --change.');
    record = await api.startWorkflowBuild({ root, fromWorkflow: simplify ?? optionString(options, 'from-workflow') ?? null, change: intents ?? assess ?? optionString(options, 'change') ?? null, ...(await material()),
      describe: optionString(options, 'describe') ?? null, name: optionString(options, 'name') ?? null, simplify: Boolean(simplify), assess: Boolean(assess), intents: Boolean(intents) });
  } else if (action === 'add') {
    const id = optionString(options, 'build');
    if (!id) refuse('Name the build: workflow build add --build <ID> --folder <DIR>.');
    record = await api.addToWorkflowBuild(id, await material());
  } else {
    record = await api.readWorkflowBuild(optionString(options, 'build'));
  }
  const view = { ...api.workflowBuildView(record), proposalPath: await issueProposalPath(record.id, root) };
  await issueFindingsPath(view, root);
  if (json) return console.log(JSON.stringify(view, null, 2));
  printBuild({ ...view, labels });
}
