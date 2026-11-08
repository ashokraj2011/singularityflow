/**
 * Findings in the code step's loop [CQF:REQ-042 – REQ-046, decisions 6, 7, 8, 11].
 *
 * A code step's lint, static-analysis and security commands (each a finding command: a kind with a
 * finding reader, src/external-command-policy.mjs) run in its publish check, beside its tests. What a
 * finding on a line this Story changed means depends on `codeDelivery.staticAnalysis.mode`:
 *
 * - `warn` (the default): a counted finding (new code, a severity its gate fails on, not accepted by a
 *   person) goes back to the code step in the same turn. The loop has 3 attempts per generation: the
 *   first 2 publish checks that count findings return them; at the 3rd, or when one fingerprint has come
 *   back 3 times, the publication goes ahead with them recorded, escalated for the step's approvers.
 * - `enforce`: as warn, except that at the end of the loop the step stays held for a person: the
 *   findings are fixed in a later turn, or a person accepts each with `decision finding-risk`.
 * - `off`: none of it runs in the loop.
 *
 * A scanner that is missing, offline, not allowed to run with the model off, or that wrote no report,
 * is recorded as unavailable and blocks nothing [decision 11]. Under enforce, a required one holds the
 * step until a person accepts it as unavailable. A run on unchanged code, under the same tool version
 * and ruleset digest, stands for a later gate [CQF:REQ-045]. A suppression added on a changed line is
 * itself a finding [CQF:REQ-044].
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { staticAnalysisMode } from '../code-delivery-policy.mjs';
import { DEFAULT_FINDING_GATE, findingCommand, normalizeExternalCommand } from '../external-command-policy.mjs';
import { coveringFindingRisk, findingRiskAuthorities, findingRiskBinding, findingRiskDecisionCommand } from '../finding-risk.mjs';
import { head } from '../git.mjs';
import { secureRepositoryPath, SingularityFlowError } from '../util.mjs';
import { sourceLines, storyChangedLines } from './changed-lines.mjs';
import { createFinding, findingCounts, markNewCode, sortFindings, uniqueFindings, withToolIdentity } from './model.mjs';
import { readFindingReport } from './readers/index.mjs';
import { repositoryPaths } from './readers/common.mjs';
import { generationFindingRounds, recordFindingRound, recordFindingRun, unchangedFindingRun } from './runs.mjs';
import { addedSuppressions } from './suppressions.mjs';
import { findingToolIdentity } from './tool-identity.mjs';

export const FINDING_LOOP_ATTEMPTS = 3;
// What one refusal hands the code step: enough to fix, bounded like any refusal.
const RETURNED_FINDINGS = 20;
// What the delivery evidence keeps of a step's findings.
const KEPT_FINDINGS = 200;
const ENVIRONMENT_UNAVAILABLE = /^ENVIRONMENT_(?:BINDING_UNAVAILABLE|ISOLATED_RUNNER_REQUIRED)$/u;

/** The step's finding commands that run in its loop: a SonarQube server analysis runs at submit only. */
export function loopFindingCommands(commands) {
  return commands.map((command, index) => {
    try { return command && typeof command === 'object' ? normalizeExternalCommand(command, index) : null; } catch { return null; }
  }).filter((command) => command && findingCommand(command) && !command.sonarqube);
}

/** Why a check read no findings, or null when its report should be read. */
function unavailableReason(check) {
  if (!check) return 'it did not run';
  if (check.status === 'skipped-warning') return String(check.stderr || 'it was not run while model mode is disabled').slice(0, 400);
  if (check.status === 'blocked' && ENVIRONMENT_UNAVAILABLE.test(String(check.errorCode ?? ''))) return String(check.stderr).slice(0, 400);
  if (check.status === 'blocked' && check.errorCode) return String(check.stderr || check.errorCode).slice(0, 400);
  if (check.infrastructureUnavailable) return 'its program is not installed here';
  if (check.timedOut) return 'it ran past its timeout';
  return null;
}

/** A finding command's report, relative to the repository: its path is read from the command's own folder, as a test report's is. */
export function findingReportPath(command) {
  return path.posix.normalize(path.posix.join(command.workingDirectory && command.workingDirectory !== '.' ? command.workingDirectory : '.', command.result.path));
}

async function readReport(root, command, check, { identity }) {
  const relative = findingReportPath(command);
  const target = await secureRepositoryPath(root, relative, { label: `Finding report '${relative}'`, mustExist: false });
  if (!target.exists) return { status: 'unavailable', reason: `it wrote no report at ${relative} (exit ${check.exitCode ?? 'none'})` };
  const bytes = await readFile(target.absolute);
  const bases = [{ absolute: root, relative: '.' }];
  const roots = check.findingRoots ?? {};
  const working = command.workingDirectory && command.workingDirectory !== '.' ? command.workingDirectory : '.';
  if (roots.isolated) bases.push({ absolute: roots.isolated, relative: '.' });
  bases.push({ absolute: path.join(root, working), relative: working });
  const lines = sourceLines(root);
  try {
    const report = readFindingReport(command.result.adapter, bytes, { source: command.id, paths: repositoryPaths({ bases, cwd: working }),
      toolVersion: identity?.toolVersion ?? null, rulesetSha256: identity?.rulesetSha256 ?? null, snippetOf: lines });
    // A finding the reader could not hash a snippet for is hashed from the working tree's line here.
    return { status: 'read', findings: report.findings.map((finding) => withToolIdentity(finding, identity ?? {})), suppressed: report.suppressed ?? 0,
      omitted: report.omitted ?? 0, gate: report.gate ?? null, measures: report.measures ?? null };
  } catch (error) {
    return { status: 'unavailable', reason: `its report could not be read: ${String(error?.message ?? error).slice(0, 300)}` };
  }
}

/** What a finding that counted looks like to the code step: the shape, minus what only a gate needs. */
function returned(finding) {
  const { feed, source, rulesetSha256, newCode, ...rest } = finding;
  return rest;
}

/**
 * Run the step's finding commands for its publish check and decide [CQF:REQ-043]. Returns the
 * delivery evidence's `qualityFindings`, or null when nothing ran; throws the same-turn refusal while
 * the loop has attempts left, and the person's hold under enforce once it has none.
 *
 * `kernel` is the state kernel's: `{ qualityChecks, sourceTreeHash, testInputTreeHash, generation, itemRelative }`.
 */
export async function publishCheckFindings(root, config, workflow, phase, deliveryEvidence, kernel) {
  const mode = staticAnalysisMode(workflow);
  if (mode === 'off') return null;
  // Only configured commands report findings; inferred ones are tests, so nothing is inferred here.
  const commands = loopFindingCommands([...(phase.qualityCommands ?? []), ...(phase.storyTestCommands ?? [])]);
  if (!commands.length) return null;
  const outcome = await runFindingCommands(root, config, workflow, phase, commands, { kernel, purpose: 'preflight', deliveryEvidence });
  return decideLoop(root, workflow, phase, outcome, { mode, generation: kernel.generation });
}

/**
 * Run (or reuse) each finding command and read its findings, marked against the lines the Story
 * changed, with the suppressions the Story added. Every run is recorded in private storage.
 */
export async function runFindingCommands(root, config, workflow, phase, commands, { kernel, purpose, deliveryEvidence }) {
  const workId = workflow.workItem.id;
  const commit = head(root);
  const treeSha256 = await kernel.sourceTreeHash(root, config, workflow);
  const testInputSha256 = await kernel.testInputTreeHash(root, config, workflow);
  const candidate = { commit, treeSha256, ...(testInputSha256 ? { testInputSha256 } : {}) };
  const results = [];
  const toRun = [];
  for (const command of commands) {
    const executionRoot = path.join(root, command.workingDirectory && command.workingDirectory !== '.' ? command.workingDirectory : '');
    const identity = findingToolIdentity(root, executionRoot, command);
    const standing = await unchangedFindingRun(root, workflow, command, { commit, treeSha256, testInputSha256, identity });
    if (standing.run) {
      results.push({ command, identity, reused: standing.run, status: 'read', findings: standing.run.findings.map((entry) => createFinding(entry)) });
      console.warn(`Not run again: ${command.id} read this exact code with the same tool and rules (${standing.run.id}).`);
    } else {
      if (standing.moved) console.warn(`Running ${command.id} again: ${standing.moved}.`);
      toRun.push({ command, identity });
    }
  }
  const checks = toRun.length ? await kernel.qualityChecks(root, phase, config, workflow, toRun.map((entry) => entry.command)) : [];
  for (const [index, { command, identity }] of toRun.entries()) {
    const check = checks[index];
    const reason = unavailableReason(check);
    const read = reason ? { status: 'unavailable', reason } : await readReport(root, command, check, { identity });
    const findings = read.status === 'read' ? read.findings : [];
    const run = await recordFindingRun(root, { workId, phaseId: phase.id, generation: kernel.generation, purpose, command, candidate, identity,
      status: read.status, reason: read.reason ?? null, exitCode: check?.exitCode ?? null, findings,
      counts: read.status === 'read' ? { suppressed: read.suppressed, omitted: read.omitted } : null,
      startedAt: check?.startedAt ?? null, completedAt: check?.completedAt ?? null });
    results.push({ command, identity, check, run, ...read, findings });
  }
  const changed = storyChangedLines(root, workflow, deliveryEvidence?.changeSet);
  const lines = sourceLines(root);
  const suppressions = addedSuppressions(changed, { lineOf: (file, line) => lines(file, line, line), lineCount: lines.count });
  for (const result of results) result.findings = markNewCode(result.findings, changed);
  return { results, suppressions, candidate, changedFiles: changed.size };
}

/** What a gate counts: new-code findings at a severity the command's gate fails on, that no person accepted. */
export function countedFindings(workflow, phase, outcome, { at = new Date().toISOString() } = {}) {
  const counted = [];
  const accepted = [];
  for (const { command, findings } of outcome.results) {
    const failOn = command.gate?.failOn ?? DEFAULT_FINDING_GATE.failOn;
    for (const finding of findings) {
      if (!finding.newCode || !failOn.includes(finding.severity)) continue;
      const decision = coveringFindingRisk(workflow, { phaseId: phase.id, finding, at });
      if (decision) accepted.push({ finding, decision: findingRiskBinding(decision) }); else counted.push(finding);
    }
  }
  for (const finding of outcome.suppressions) {
    const decision = coveringFindingRisk(workflow, { phaseId: phase.id, finding, at });
    if (decision) accepted.push({ finding, decision: findingRiskBinding(decision) }); else counted.push(finding);
  }
  return { counted: uniqueFindings(counted), accepted };
}

/** The scanners that could not be read, and under enforce those a person has not accepted as unavailable. */
function unavailableScanners(workflow, phase, outcome, { at }) {
  return outcome.results.filter((result) => result.status === 'unavailable').map((result) => {
    const finding = scannerUnavailableFinding(result.command);
    const decision = coveringFindingRisk(workflow, { phaseId: phase.id, finding, at });
    return { commandId: result.command.id, requirement: result.command.requirement ?? 'required', reason: result.reason, finding,
      ...(decision ? { accepted: findingRiskBinding(decision) } : {}) };
  });
}

/** The finding a person accepts for a scanner that cannot run here: one per command, whatever the reason. */
export function scannerUnavailableFinding(command) {
  return createFinding({ feed: 'quality', source: command.id, tool: command.id, rule: 'scanner-unavailable', severity: 'high', kind: 'code-smell',
    snippet: `command:${command.id}`, message: `Scanner ${command.id} could not run or report here.` });
}

/** The delivery evidence's record of a gate's findings: bounded, the counted and accepted first. */
export function findingsEvidence(mode, outcome, { counted, accepted, unavailable, attempt, outcome: decided, escalated = [] }) {
  const all = sortFindings(uniqueFindings([...outcome.results.flatMap((result) => result.findings), ...outcome.suppressions]));
  const countedIds = new Set(counted.map((finding) => finding.fingerprint));
  const kept = [...counted, ...accepted.map((entry) => entry.finding), ...all.filter((finding) => finding.newCode && !countedIds.has(finding.fingerprint))]
    .filter((finding, index, list) => list.findIndex((other) => other.fingerprint === finding.fingerprint) === index).slice(0, KEPT_FINDINGS);
  return {
    schemaVersion: 1, mode, outcome: decided, attempt, maximumAttempts: FINDING_LOOP_ATTEMPTS,
    commands: outcome.results.map((result) => ({ id: result.command.id, kind: result.command.kind, adapter: result.command.result.adapter,
      status: result.status, ...(result.reason ? { reason: result.reason } : {}),
      ...(result.reused ? { reusedFrom: result.reused.id } : result.run ? { runId: result.run.id } : {}),
      tool: result.identity?.tool ?? null, toolVersion: result.identity?.toolVersion ?? null, rulesetSha256: result.identity?.rulesetSha256 ?? null,
      counts: findingCounts(result.findings) })),
    counts: { ...findingCounts(all), counted: counted.length, accepted: accepted.length, suppressionsAdded: outcome.suppressions.length },
    counted: counted.map((finding) => finding.fingerprint),
    accepted: accepted.map((entry) => ({ fingerprint: entry.finding.fingerprint, decision: entry.decision })),
    escalated, unavailable: unavailable.map(({ finding, ...entry }) => entry),
    findings: kept
  };
}

const findingWords = (list) => list.slice(0, 3).map((finding) => `${finding.tool} ${finding.rule ?? ''} at ${finding.file ?? '?'}:${finding.line ?? '?'}`.replace(/\s+/gu, ' ')).join('; ');

function warnUnavailable(mode, unavailable) {
  for (const entry of unavailable) {
    const held = mode === 'enforce' && entry.requirement === 'required' && !entry.accepted;
    console.warn(`Warning: scanner ${entry.commandId} is unavailable (${entry.reason}); ${held ? 'under enforce a person accepts it with decision finding-risk' : 'it is recorded and blocks nothing'}.`);
  }
}

/** Under enforce, a required scanner that cannot run here holds the step until a person accepts it [CQF:REQ-046]. */
function heldScannerRefusal(workflow, phase, mode, unavailable, operation) {
  const held = mode === 'enforce' ? unavailable.filter((entry) => entry.requirement === 'required' && !entry.accepted) : [];
  if (!held.length) return null;
  return new SingularityFlowError(
    `Phase ${phase.id} enforces its findings, and required scanner${held.length === 1 ? '' : 's'} ${held.map((entry) => entry.commandId).join(', ')} could not run here. `
    + `Make it available, or a person accepts it as unavailable with decision finding-risk; nothing was ${operation === 'submit' ? 'submitted' : 'published'}.`,
    { code: 'CODE_QUALITY_SCANNER_UNAVAILABLE', details: { phase: phase.id, workId: workflow.workItem.id,
      qualityFindings: { mode, unavailable: held.map(({ commandId, reason }) => ({ commandId, reason })), findings: [held[0].finding].map(returned) },
      recoveryCommands: held.slice(0, 3).map((entry) => ({ command: findingRiskDecisionCommand(workflow, { phaseId: phase.id, finding: entry.finding }),
        label: `A person who may decide (${findingRiskAuthorities(workflow, phase.id, entry.finding).join(', ') || 'the step approvers'}) accepts that ${entry.commandId} cannot run here.` })) } }
  );
}

/** Under enforce, findings that remain once the loop is spent hold the step for a person [decision 8]. */
function heldFindingsRefusal(workflow, phase, qualityFindings, counted, { attempt, operation }) {
  return new SingularityFlowError(
    `Phase ${phase.id} enforces its findings, and ${counted.length} finding(s) on changed lines remain${attempt ? ` after ${attempt} attempt(s)` : ''}: ${findingWords(counted)}. `
    + `Repairing again in this turn cannot pass. A person decides: fix them in a later turn, or accept each with decision finding-risk; nothing was ${operation === 'submit' ? 'submitted' : 'published'}.`,
    { code: 'CODE_QUALITY_FINDINGS_HELD', details: { phase: phase.id, workId: workflow.workItem.id, qualityFindings,
      findingIds: counted.map((finding) => finding.id),
      recoveryCommands: counted.slice(0, 3).map((finding) => ({ command: findingRiskDecisionCommand(workflow, { phaseId: phase.id, finding }),
        label: `A person who may decide (${findingRiskAuthorities(workflow, phase.id, finding).join(', ') || 'the step approvers'}) accepts ${finding.id} for this step, or it is fixed.` })) } }
  );
}

/** The same-turn refusal, the exhausted loop's outcome, or a pass. */
async function decideLoop(root, workflow, phase, outcome, { mode, generation }) {
  const at = new Date().toISOString();
  const { counted, accepted } = countedFindings(workflow, phase, outcome, { at });
  const unavailable = unavailableScanners(workflow, phase, outcome, { at });
  warnUnavailable(mode, unavailable);
  const workId = workflow.workItem.id;
  const scanners = heldScannerRefusal(workflow, phase, mode, unavailable, 'publish');
  if (scanners) throw scanners;
  if (!counted.length) return findingsEvidence(mode, outcome, { counted, accepted, unavailable, attempt: null, outcome: 'passed' });
  const rounds = await generationFindingRounds(root, workId, phase.id, generation);
  const attempt = rounds.length + 1;
  const sightings = new Map();
  for (const fingerprint of [...rounds.flatMap((round) => round.counted), ...counted.map((finding) => finding.fingerprint)]) {
    sightings.set(fingerprint, (sightings.get(fingerprint) ?? 0) + 1);
  }
  // The same finding a third time goes to a person, whatever attempt it is [decision 8].
  const escalated = counted.filter((finding) => sightings.get(finding.fingerprint) >= FINDING_LOOP_ATTEMPTS).map((finding) => finding.fingerprint);
  await recordFindingRound(root, { workId, phaseId: phase.id, generation, counted: counted.map((finding) => finding.fingerprint), at });
  const exhausted = attempt >= FINDING_LOOP_ATTEMPTS || escalated.length > 0;
  if (exhausted && mode === 'warn') {
    console.warn(`Warning: ${counted.length} finding(s) on changed lines remain after ${attempt} attempt(s): ${findingWords(counted)}. They are recorded for the step's approvers; under warn the publication goes ahead.`);
    return findingsEvidence(mode, outcome, { counted, accepted, unavailable, attempt, outcome: 'warned', escalated: escalated.length ? escalated : counted.map((finding) => finding.fingerprint) });
  }
  const shown = counted.slice(0, RETURNED_FINDINGS).map(returned);
  const qualityFindings = { mode, attempt, maximumAttempts: FINDING_LOOP_ATTEMPTS, findings: shown, more: Math.max(0, counted.length - shown.length),
    unavailable: unavailable.map(({ commandId, reason }) => ({ commandId, reason })), escalated };
  if (exhausted) throw heldFindingsRefusal(workflow, phase, qualityFindings, counted, { attempt, operation: 'publish' });
  throw new SingularityFlowError(
    `Phase ${phase.id} has ${counted.length} finding(s) on lines this Story changed (attempt ${attempt} of ${FINDING_LOOP_ATTEMPTS}): ${findingWords(counted)}. `
    + 'Fix each in the code, in this turn, without a suppression comment, then run the same prepublish again. Nothing was published.',
    { code: 'CODE_QUALITY_FINDINGS', details: { phase: phase.id, workId, generation, qualityFindings, findingIds: counted.map((finding) => finding.id) } }
  );
}

/**
 * A later step's read of CodeQL's alerts for the Story branch [CQF:REQ-049]: the code was published
 * by an earlier step, so its change set says which lines are new. It informs and never blocks, under
 * any mode: holding the code is the code step's.
 */
export async function laterStepCodeScanning(root, config, workflow, phase, { read: answer = null } = {}) {
  const coded = [...(workflow.phaseOrder ?? Object.keys(workflow.phases ?? {}))].reverse()
    .map((id) => workflow.phases?.[id]).find((entry) => entry?.id !== phase.id && entry?.deliveryEvidence?.changeSet);
  const read = await (await import('./servers.mjs')).codeScanningRead(root, config, workflow, { branch: workflow.workItem?.branch ?? null, commit: head(root),
    ...(answer ? { read: answer } : {}) });
  if (read.status !== 'read') console.warn(`Warning: ${read.reason}; it blocks nothing.`);
  const findings = coded ? markNewCode(read.findings, storyChangedLines(root, workflow, coded.deliveryEvidence.changeSet)) : read.findings;
  return { schemaVersion: 1, status: read.status, ...(read.reason ? { reason: read.reason } : {}), repository: read.repository ?? null,
    analysedCommit: read.analysedCommit ?? null, current: read.current ?? false, counts: findingCounts(findings),
    findings: sortFindings(findings.filter((finding) => finding.newCode)).slice(0, KEPT_FINDINGS) };
}

/** Finding commands apart from the others, each in its configured order: submission runs them through the findings rules. */
export function splitFindingCommands(commands) {
  const findings = [];
  const others = [];
  for (const [index, command] of commands.entries()) {
    let normalized = null;
    try { normalized = command && typeof command === 'object' ? normalizeExternalCommand(command, index) : null; } catch { normalized = null; }
    (normalized && findingCommand(normalized) ? findings : others).push(command);
  }
  return { findings, others };
}

/** A check for a finding command as submission records it: its findings decide it, never its exit code alone. */
function findingCheck(result, { mode, candidate, counted, status, reason = null }) {
  const { command } = result;
  const own = counted.filter((finding) => finding.source === command.id).length;
  return {
    id: command.id, command: command.command ?? command.argv.join(' '), kind: command.kind,
    // Unavailable under warn informs: the verdict never counts it as a required check missing [decision 11].
    requirement: status === 'unavailable' && mode !== 'enforce' ? 'advisory' : command.requirement ?? 'required',
    externalModelPolicy: command.modelPolicy, workingDirectory: command.workingDirectory ?? null,
    sourceCommit: result.reused?.candidate?.commit ?? candidate.commit, sourceTreeSha256: candidate.treeSha256,
    ...(candidate.testInputSha256 ? { testInputSha256: candidate.testInputSha256 } : {}),
    startedAt: result.reused?.startedAt ?? result.check?.startedAt ?? null, completedAt: result.reused?.completedAt ?? result.check?.completedAt ?? null,
    status, exitCode: result.reused ? result.reused.exitCode ?? null : result.check?.exitCode ?? null, signal: null,
    stdout: '', stderr: reason ?? '',
    findings: { mode, adapter: command.result.adapter, ...findingCounts(result.findings), counted: own,
      ...(result.reused ? { reusedFrom: result.reused.id } : result.run ? { runId: result.run.id } : {}) },
    ...(result.reused ? { evidenceUse: 'reused' } : {})
  };
}

/**
 * Submission's finding commands [CQF:REQ-045]: each run on this code stands when its tool and rules
 * are unchanged, so nothing reruns; a fresh one runs here otherwise. Under enforce what remains is
 * held for a person; under warn it is recorded. Returns the checks and the evidence submission keeps.
 */
export async function submitCheckFindings(root, config, workflow, phase, commands, kernel) {
  const mode = staticAnalysisMode(workflow);
  const normalized = commands.map((command, index) => normalizeExternalCommand(command, index));
  const loop = normalized.filter((command) => !command.sonarqube);
  const servers = normalized.filter((command) => command.sonarqube);
  const codeql = workflow.resolution?.codeDelivery?.staticAnalysis?.codeql === 'github';
  const testInputSha256 = await kernel.testInputTreeHash(root, config, workflow);
  const candidate = { commit: head(root), treeSha256: await kernel.sourceTreeHash(root, config, workflow), ...(testInputSha256 ? { testInputSha256 } : {}) };
  if (mode === 'off') {
    return { checks: normalized.map((command) => findingCheck({ command, findings: [] }, { mode, candidate, counted: [], status: 'unavailable',
      reason: 'codeDelivery.staticAnalysis.mode is off: not run' })), evidence: { schemaVersion: 1, mode, outcome: 'off' } };
  }
  const at = new Date().toISOString();
  const outcome = loop.length ? await runFindingCommands(root, config, workflow, phase, loop, { kernel, purpose: 'submission', deliveryEvidence: phase.deliveryEvidence })
    : { results: [], suppressions: [], candidate };
  const branch = workflow.workItem?.branch ?? null;
  const server = servers.length ? await (await import('./servers.mjs')).submitServerAnalyses(root, config, workflow, phase, servers,
    { kernel, candidate, branch }) : null;
  const changed = server || codeql ? storyChangedLines(root, workflow, phase.deliveryEvidence?.changeSet) : null;
  for (const result of server?.results ?? []) outcome.results.push({ ...result, findings: markNewCode(result.findings, changed) });
  const codeScanning = codeql ? await (await import('./servers.mjs')).codeScanningRead(root, config, workflow,
    { branch, commit: candidate.commit }) : null;
  if (codeScanning) {
    if (codeScanning.status !== 'read') console.warn(`Warning: ${codeScanning.reason}; it blocks nothing.`);
    else if (!codeScanning.current) console.warn(`Warning: CodeQL's latest analysis of this branch is of ${String(codeScanning.analysedCommit).slice(0, 12)}, not the submitted commit.`);
    // Alerts count as any finding on changed lines; the commit they were analysed on is shown beside them.
    if (codeScanning.findings.length) outcome.results.push({ command: { id: 'codeql', kind: 'security', requirement: 'advisory', result: { adapter: 'github-code-scanning' } },
      identity: { tool: 'CodeQL', toolVersion: codeScanning.toolVersion, rulesetSha256: null }, status: 'read', remote: true,
      findings: markNewCode(codeScanning.findings, changed) });
  }
  const { counted, accepted } = countedFindings(workflow, phase, outcome, { at });
  const unavailable = unavailableScanners(workflow, phase, outcome, { at });
  warnUnavailable(mode, unavailable);
  const scanners = heldScannerRefusal(workflow, phase, mode, unavailable, 'submit');
  if (scanners) throw scanners;
  if (counted.length && mode === 'enforce') {
    throw heldFindingsRefusal(workflow, phase, { mode, findings: counted.slice(0, RETURNED_FINDINGS).map(returned),
      more: Math.max(0, counted.length - RETURNED_FINDINGS), unavailable: [], escalated: counted.map((finding) => finding.fingerprint) }, counted, { attempt: null, operation: 'submit' });
  }
  if (counted.length) console.warn(`Warning: ${counted.length} finding(s) on changed lines are recorded for the step's approvers: ${findingWords(counted)}.`);
  // GitHub's alerts are a read, not a command of the step: they are evidence, never a check of their own.
  const checks = outcome.results.filter((result) => !result.remote).map((result) => findingCheck(result, { mode, candidate, counted,
    status: result.status === 'unavailable' ? 'unavailable' : 'passed', reason: result.reason ?? null }));
  const evidence = { ...findingsEvidence(mode, outcome, { counted, accepted, unavailable, attempt: null, outcome: counted.length ? 'warned' : 'passed' }),
    ...(server?.servers?.length ? { servers: server.servers } : {}),
    ...(codeScanning ? { codeScanning: { status: codeScanning.status, ...(codeScanning.reason ? { reason: codeScanning.reason } : {}),
      repository: codeScanning.repository ?? null, analysedCommit: codeScanning.analysedCommit ?? null, submittedCommit: codeScanning.submittedCommit ?? candidate.commit,
      current: codeScanning.current ?? false, alerts: codeScanning.findings.length } } : {}) };
  return { checks, evidence };
}
