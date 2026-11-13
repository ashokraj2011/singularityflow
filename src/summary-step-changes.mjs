/**
 * A code step's summary written before a decision changed the step [owner, 2026-11-13].
 *
 * On a real Story the agent drafted its implementation summary ("No .nvmrc was added"), then a person chose
 * Pin Node 22 on the decision list, which created `.nvmrc` and amended the plan, and the next prepublish published
 * the summary as it was. Nothing said the summary was older than the change. A decision during the open generation
 * that changes the step's files or plan is recorded on the Story with its time (`planAmendments`: the Node pin and
 * any other plan amendment, a plan row correction, an evidence correction), and the summary file has its own time.
 * So: a summary last written before such a change is the draft's own correction, which its author makes in the same
 * draft before any person is asked (the draft's own correction leads [owner, 2026-11-10]); one written after it
 * names each path the change touched. Never reads what the prose says about a path, only whether it names it.
 */
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { authoredArtifactText, requiredArtifactRepoPath } from './artifact-review-read.mjs';
import { countedRecords } from './presence/counted.mjs';

const MAXIMUM_SUMMARY_BYTES = 4 * 1024 * 1024;
const SHOWN = 6;

const list = (values) => (values.length <= 1 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`);

/** What one plan record changed: the paths it names and its rows in words. */
function recordChanges(record) {
  const paths = new Set();
  const rows = [];
  const add = (value) => { if (typeof value === 'string' && value.trim()) paths.add(value.trim()); };
  for (const change of record.changes ?? []) {
    add(change.path);
    if (change.kind === 'add-supporting') rows.push(`${change.path} as a supporting change, ${change.class}`);
    else if (change.kind === 'add-location') rows.push(`${change.path} added to ${change.clauseId}'s row`);
  }
  for (const operation of record.operations ?? []) {
    for (const value of [operation.path, operation.test, operation.to, ...(operation.claim?.expectedPaths ?? []), ...(operation.claim?.tests ?? [])]) add(value);
    rows.push(`${operation.clauseId}'s row: ${String(operation.op ?? 'changed').replaceAll('-', ' ')}`);
  }
  if (record.kind === 'evidence-contract-correction') {
    add(record.path);
    rows.push(`${record.clauseId}'s evidence: ${record.path}`);
  }
  // A row change that names no file is named by its clause.
  const clauses = [...new Set([...(record.operations ?? []).map((entry) => entry.clauseId), record.clauseId].filter(Boolean))];
  return { paths: [...paths], names: paths.size ? [...paths] : clauses, rows };
}

/**
 * The plan records made while this generation was open, newest last: each with its time, the paths it names
 * and its rows in words. Empty for a step with no open code generation.
 */
export function stepChangesDuringGeneration(workflow, phase) {
  const since = Date.parse(phase?.generationIntent?.status === 'open' ? phase.generationIntent.startedAt ?? '' : '');
  if (!Number.isFinite(since)) return [];
  return countedRecords(workflow, workflow?.planAmendments)
    .filter((record) => record && Date.parse(record.at) > since)
    .map((record) => ({ id: record.id, at: record.at, ...recordChanges(record) }))
    .filter((change) => change.names.length);
}

/**
 * The draft-owned findings for a code step's summary at `relative` (its repository path): one per change made
 * after the summary was last written, or whose paths it does not name. Empty when nothing changed the step.
 */
export async function summaryStepChangeFindings(root, workflow, phase, relative) {
  const changes = stepChangesDuringGeneration(workflow, phase);
  if (!changes.length || typeof relative !== 'string' || !relative) return [];
  const file = path.join(root, relative);
  const entry = await lstat(file).catch(() => null);
  if (!entry?.isFile() || entry.size > MAXIMUM_SUMMARY_BYTES) return [];
  const text = authoredArtifactText(await readFile(file, 'utf8'));
  const written = entry.mtimeMs;
  const findings = [];
  for (const change of changes) {
    // The files of the change that were written after the summary: what the decision itself created or changed.
    const later = [];
    for (const name of change.paths) {
      const target = await lstat(path.join(root, name)).catch(() => null);
      if (target?.isFile() && target.mtimeMs > written) later.push(name);
    }
    const plan = change.rows.length ? ` and changed the plan: ${list(change.rows.slice(0, SHOWN))}` : '';
    const details = { change: change.id, at: change.at, paths: change.paths, plan: change.rows };
    if (Date.parse(change.at) > written) {
      const what = later.length ? `wrote ${list(later)}${plan}` : plan ? plan.replace(/^ and /u, '') : `changed ${list(change.names)}`;
      findings.push({ code: 'artifact.summary.before-change', category: 'artifact', path: relative, line: null, value: change.id, details,
        message: `The summary was written before ${change.id} changed this step: it ${what}. Say so in the summary: name ${list(change.names.slice(0, SHOWN))} and why ${change.names.length === 1 ? 'it' : 'they'} changed, then prepublish again.` });
      continue;
    }
    const unnamed = change.names.filter((name) => !text.includes(name));
    if (unnamed.length) findings.push({ code: 'artifact.summary.change-unnamed', category: 'artifact', path: relative, line: null, value: change.id, details,
      message: `The summary does not name what ${change.id} changed in this step: ${list(unnamed.slice(0, SHOWN))}${plan ? `; it${plan.replace(/^ and /u, ' ')}` : ''}. Name ${unnamed.length === 1 ? 'it' : 'each'} and why ${unnamed.length === 1 ? 'it' : 'they'} changed, then prepublish again.` });
  }
  return findings;
}

/**
 * What a decision just recorded means for the open code step's summary, in words for the author's turn, or null:
 * the summary exists and was written before the change, so it is updated in this turn before prepublish.
 */
export async function summaryUpdateAfterDecision(root, config, workflow) {
  const phase = workflow?.phases?.[workflow?.currentPhase];
  if (!phase || phase.status !== 'in_progress' || phase.generationIntent?.status !== 'open') return null;
  const [{ phaseRequiresCodeDelivery }, { agentPublicationProducer }] = await Promise.all([import('./code-delivery-policy.mjs'), import('./manual-authorship.mjs')]);
  // A kernel-built summary (a deterministic step) is rebuilt by prepare, never by its author.
  if (!phaseRequiresCodeDelivery(phase) || agentPublicationProducer(phase) !== 'governed-agent') return null;
  let relative = null;
  try { relative = requiredArtifactRepoPath(config, workflow, phase); } catch { return null; }
  const findings = (await summaryStepChangeFindings(root, workflow, phase, relative).catch(() => []))
    .filter((finding) => finding.code === 'artifact.summary.before-change');
  if (!findings.length) return null;
  const names = [...new Set(findings.flatMap((finding) => finding.details.paths.length ? finding.details.paths : []))];
  return { phase: phase.id, path: relative, changes: findings.map((finding) => finding.value), paths: names,
    words: `This changed ${phase.id} after its summary was written (${list(findings.map((finding) => finding.value))}${names.length ? `: ${list(names.slice(0, SHOWN))}` : ''}). `
      + `The step's author updates the summary at ${relative} to say so, in the same turn when it is the authoring turn, before prepublishing: prepublish refuses a summary written before the change.` };
}
