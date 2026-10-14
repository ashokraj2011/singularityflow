/**
 * `workflow import-team inspect|compile|status` — convert a team's agent directory into one
 * validated workflow bundle (src/team-import/). Nothing here changes a repository: the bundle is
 * imported later through `workflow import` and its review.
 */
import { SingularityFlowError, optionBoolean, optionString, optionStrings } from '../util.mjs';

const OPTIONS = {
  inspect: new Set(['entry', 'root', 'max-files', 'max-total-bytes', 'json']),
  compile: new Set(['session', 'out', 'destination', 'dry-run', 'answer', 'allow-not-ready', 'json']),
  status: new Set(['session', 'json'])
};
const POSITIONALS = { inspect: 4, compile: 3, status: 3 };

function refuse(message, code = 'TEAM_IMPORT_USAGE') {
  throw new SingularityFlowError(message, { code });
}

function positiveInteger(options, key) {
  const value = optionString(options, key);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) refuse(`--${key} must be a positive whole number.`);
  return number;
}

async function repositoryRoot() {
  try { return (await import('../git.mjs')).repoRoot(); } catch { return null; }
}

function printInspection(result) {
  const { counts } = result.capture;
  console.log(`Captured ${counts.files} files from ${result.source.roots.map((root) => root.path).join(', ')}: `
    + `${counts.interpreted} interpreted, ${counts.references} referenced documents, ${counts.withheld} withheld, ${counts.blocked} blocked, ${counts.excluded} excluded.`);
  for (const item of result.items) console.log(`  ${item.format.padEnd(24)} ${item.id.padEnd(28)} ${item.path}`);
  if (result.withheld.length) console.log(`Withheld (never read or returned): ${result.withheld.map((entry) => `${entry.path} (${entry.screening})`).join(', ')}`);
  if (result.entry.status === 'choose') {
    console.log('Choose the entry agent: the one that describes the whole process.');
    for (const candidate of result.entry.candidates) console.log(`  ${candidate.id.padEnd(28)} ${candidate.path}  ${candidate.reasons.join('; ')}`);
    console.log('Then: singularity-flow workflow import-team inspect <DIRECTORY> --entry <AGENT>');
    return;
  }
  if (result.entry.status === 'none') {
    console.log('No agent or prompt describes a multi-step process. Name one with --entry <AGENT>.');
    return;
  }
  console.log(`Entry: ${result.entry.selected.map((entry) => entry.id).join(', ')}${result.entry.selectedBy === 'only-candidate' ? ' (the only plausible entry)' : ''}`);
  console.log(`Session ${result.session.id} (expires ${result.session.expiresAt}); ${result.closure.length} files to interpret.`);
  console.log(`Write the team-import-candidate record to ${result.candidate.path}`);
  console.log(`Then: singularity-flow workflow import-team compile --session ${result.session.id} --dry-run`);
}

function printCompile(result) {
  console.log(`State: ${result.state}${result.bundleSha256 ? `  bundle ${result.bundleSha256}` : ''}`);
  if (result.workflow) {
    console.log(`Workflow ${result.workflow.id}: ${result.workflow.phases.map((phase) => phase.id).join(' -> ')}`);
    if (result.workflow.decisions.length) console.log(`Decisions: ${result.workflow.decisions.map((decision) => `${decision.kind} after ${decision.after}`).join(', ')}`);
  }
  console.log(`Route simulation: ${result.routeSimulation.status}${result.routeSimulation.counts ? ` ${JSON.stringify(result.routeSimulation.counts)}` : ''}`);
  for (const finding of result.findings.slice(0, 30)) console.log(`  ${finding.code} at ${finding.at}: ${finding.message}`);
  if (result.findings.length > 30) console.log(`  … ${result.findings.length - 30} more (use --json)`);
  for (const question of result.questions) console.log(`  question ${question.id}: ${question.question} [${question.choices.join(' | ')}]`);
  if (result.destination) console.log(`Destination ${result.destination.root}: ${result.destination.status} plan ${result.destination.planSha256}`);
  if (result.output) console.log(`Wrote ${result.output.path}${result.output.ready ? '' : ' (NOT READY)'}`);
  if (result.repair.stop) console.log(`Repair stopped after attempt ${result.repair.attempt}${result.repair.unchanged ? ' (findings unchanged)' : ''}.`);
  console.log(result.meaning);
}

function printStatus(result) {
  if (result.session) {
    const last = result.session.compiles.at(-1);
    console.log(`${result.session.id}: ${last?.state ?? 'awaiting-candidate'}; candidate ${result.session.candidatePath}; expires ${result.session.expiresAt}`);
    return;
  }
  if (!result.sessions.length) return console.log('No team import sessions.');
  for (const session of result.sessions) console.log(`${session.id}  ${session.state.padEnd(22)} ${session.entry.map((entry) => entry.id).join(', ')}  ${session.source}`);
}

export async function run(argv, { positionals, options }) {
  const action = positionals[2] ?? 'status';
  if (!OPTIONS[action]) refuse(`workflow import-team has no '${action}'; use inspect, compile or status.`);
  const unknown = Object.keys(options).filter((key) => !OPTIONS[action].has(key));
  if (unknown.length) refuse(`workflow import-team ${action} does not take ${unknown.map((key) => `--${key}`).join(', ')}.`);
  if (positionals.length > POSITIONALS[action]) refuse(`workflow import-team ${action} takes ${POSITIONALS[action] === 4 ? 'one directory' : 'no positional arguments'}.`);
  const json = optionBoolean(options, 'json');
  if (action === 'inspect') {
    if (!positionals[3]) refuse('Name the team directory: singularity-flow workflow import-team inspect <DIRECTORY> [--entry <AGENT>] [--root <DIRECTORY>]...');
    const { inspectTeamDirectory } = await import('../team-import/inspect.mjs');
    const result = await inspectTeamDirectory(positionals[3], {
      roots: optionStrings(options, 'root'), entries: optionStrings(options, 'entry'),
      bounds: { files: positiveInteger(options, 'max-files'), totalBytes: positiveInteger(options, 'max-total-bytes') },
      repositoryRoot: await repositoryRoot()
    });
    return json ? console.log(JSON.stringify(result, null, 2)) : printInspection(result);
  }
  if (action === 'compile') {
    const sessionId = optionString(options, 'session');
    if (!sessionId) refuse('Name the session inspect returned: --session <ID>.');
    const { compileTeamImport } = await import('../team-import/compile.mjs');
    const result = await compileTeamImport(sessionId, {
      out: optionString(options, 'out') ?? null, destination: optionString(options, 'destination') ?? null,
      dryRun: optionBoolean(options, 'dry-run'), answers: optionStrings(options, 'answer'),
      allowNotReady: optionBoolean(options, 'allow-not-ready')
    });
    return json ? console.log(JSON.stringify(result, null, 2)) : printCompile(result);
  }
  const session = await import('../team-import/session.mjs');
  const sessionId = optionString(options, 'session');
  await session.pruneTeamImportSessions();
  const result = sessionId
    ? { schemaVersion: 1, resultType: 'team-import-status', session: await session.readTeamImportSession(sessionId) }
    : { schemaVersion: 1, resultType: 'team-import-status', sessions: await session.listTeamImportSessions() };
  if (json) {
    // The capture manifest is large and already returned by inspect; status carries the summary.
    if (result.session) {
      const { capture, ...rest } = result.session;
      result.session = { ...rest, capture: { sha256: capture.sha256, roots: capture.roots, files: capture.files.length } };
    }
    return console.log(JSON.stringify(result, null, 2));
  }
  return printStatus(result);
}
