/** ARA command adapter. Reads are narrow; browser/process/writer closures are loaded only on demand. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { optionString, optionBoolean } from '../util.mjs';
import { ARA_ACTIONS, ARA_READS, araFail, exactFields, reviewDigest } from '../application-review-contract.mjs';
import { applicationReviewPhase } from '../code-delivery-policy.mjs';

const allowed = ['work-id', 'phase', 'json', 'for-agent', 'timings', 'action-id', 'revision', 'input', 'input-json', 'help'];
export const APPLICATION_REVIEW_USAGE = `Usage: singularity-flow app-review plan|start [--work-id ID] [--phase PHASE] [--json]
       singularity-flow app-review status|inspect|accept|capture|defer|close SESSION [--work-id ID] [--json]
       singularity-flow app-review feedback|repair|repair-result SESSION --input FILE --action-id ID --revision NUMBER [--work-id ID] [--json]
       singularity-flow app-review recheck SESSION
       singularity-flow app-review browser install
Inspect opens the person's local review surface. All good and rechecks are collected there; no actor, role, checklist, --yes or model-authored consent is accepted.
Images remain local. Required review is pinned only by explicit workflow adoption; phase approval stays separate.`;

export async function applicationReviewHostDescriptor(root, sessionId) {
  if (!/^ARA-[a-f0-9]{24}$/u.test(sessionId ?? '')) araFail('ARA_SESSION_INVALID', 'Use the exact session ID returned by app-review start.');
  const { reviewLocalRoot, localCheckoutIdentity } = await import('../application-review-read.mjs');
  return path.join(reviewLocalRoot(root), 'hosts', `${reviewDigest({ sessionId, checkout: localCheckoutIdentity(root) }).slice(7)}.json`);
}

/** Open only the retained owned host. Its private secret URL is never returned to a model. */
export async function inspectApplicationReview(root, workId, sessionId, { openReview = null } = {}) {
  const descriptor = await applicationReviewHostDescriptor(root, sessionId);
  const { readPrivateSidecar } = await import('../private-sidecar.mjs');
  const { recordedProcessAlive } = await import('../application-run.mjs');
  const { localCheckoutIdentity } = await import('../application-review-read.mjs');
  const checkout = localCheckoutIdentity(root);
  const read = async (launchId = null) => {
    const bytes = await readPrivateSidecar(root, descriptor, { optional: true, maximumBytes: 8192 });
    if (!bytes) return null;
    const record = JSON.parse(bytes.toString('utf8'));
    if (record.sessionId !== sessionId || record.checkout !== checkout) return null;
    if (record.kind === 'local-application-review-host-failed') {
      if (launchId === record.launchId) araFail(record.error.code, record.error.message, record.error.details);
      return null;
    }
    const url = new URL(record.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\/[a-f0-9]{64}\/$/u.test(url.pathname)
        || url.username || url.password || url.search || url.hash) araFail('ARA_HOST_INVALID', 'The retained review host address is invalid. No browser was opened.');
    return recordedProcessAlive(record, { requireIdentity: true, fresh: true }) ? record : null;
  };
  const { withSubjectLock } = await import('../subject-lock.mjs');
  const record = await withSubjectLock(root, { kind: 'application-review-host', id: `${checkout}:${sessionId}` }, async () => {
    let current = await read();
    if (!current) {
      const launchId = randomUUID();
      let launchError;
      const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'app-review-host.mjs'), root, sessionId, workId ?? '', launchId], {
        detached: true, stdio: 'ignore', shell: false, windowsHide: true, env: { ...process.env, SINGULARITY_FLOW_SURFACE_CONTEXT: '' }
      });
      child.once('error', error => { launchError = error; }); child.unref();
      for (let index = 0; index < 300; index += 1) {
        await delay(100); current = await read(launchId);
        if (current || launchError || child.exitCode != null) break;
      }
      if (!current) araFail('ARA_HOST_UNAVAILABLE', 'The local review host did not become ready. The review is retained; inspect its status and retry the same session.',
        { cause: launchError ? { code: launchError.code, message: launchError.message } : null, exitCode: child.exitCode, timeoutMs: 30000 });
    }
    return current;
  });
  const { openBrowser } = await import('../local-evidence-review.mjs');
  await (openReview ?? openBrowser)(record.url);
  return { status: 'opened', sessionId, message: 'Application review opened locally. Report problems, recheck repairs and say All good there. No acceptance was inferred from opening this view.' };
}

export async function run(_argv, { positionals, options = {} }) {
  const sub = positionals[1] ?? 'plan';
  if (options.help === true) { console.log(APPLICATION_REVIEW_USAGE); return; }
  const unknown = Object.keys(options).filter(key => !allowed.includes(key));
  if (unknown.length || !ARA_ACTIONS.includes(sub)) araFail('ARA_COMMAND_INVALID', `${unknown.length ? `Unsupported options: ${unknown.join(', ')}.` : `Unknown review action '${sub}'.`} ${APPLICATION_REVIEW_USAGE}`);
  const dataAction = ['feedback', 'repair', 'repair-result'].includes(sub);
  const invalidForAction = Object.keys(options).filter(key => ['action-id', 'revision', 'input', 'input-json'].includes(key)
    && !(dataAction || sub === 'start' && key === 'action-id') || key === 'phase' && !['plan', 'start'].includes(sub));
  if (invalidForAction.length || positionals.length > (['plan', 'start'].includes(sub) ? 2 : 3)) araFail('ARA_COMMAND_INVALID', APPLICATION_REVIEW_USAGE);
  if (sub === 'browser') {
    if (positionals[2] !== 'install' || positionals.length !== 3) araFail('ARA_COMMAND_INVALID', 'Use app-review browser install to provision the pinned Chromium used only by SFlow.');
    const executable = path.join(PACKAGE_ROOT, 'node_modules', 'playwright-core', 'cli.js');
    const json = optionBoolean(options, 'json') || optionBoolean(options, 'for-agent');
    if (!json) console.log('Installing the pinned SFlow review browser…');
    const { runQualityCommand } = await import('../quality-command-runner.mjs');
    const installed = await runQualityCommand(process.execPath, [executable, 'install', 'chromium'], { cwd: PACKAGE_ROOT, timeoutMs: 600000, maxBuffer: 4 * 1024 * 1024 });
    if (installed.status !== 0 && installed.exitCode !== 0) {
      const { redactDiagnosticText } = await import('../git-remote-diagnostics.mjs');
      araFail('ARA_CAPTURE_UNAVAILABLE', 'Review browser provisioning failed. No review or application was modified.',
        { exitCode: installed.exitCode ?? installed.status, timedOut: installed.timedOut ?? false, cause: redactDiagnosticText(installed.stderr || installed.stdout || installed.error?.message || 'No process output', { multiline: true }).slice(-4000) });
    }
    const result = { schemaVersion: 1, resultType: 'sflow-application-review', status: 'ready', message: 'The pinned SFlow review browser is installed.',
      commandGuidance: { copilotCommand: '/sf-app-review', command: 'singularity-flow app-review plan --json', modelFreeCommand: null } };
    console.log(json ? JSON.stringify(result, null, 2) : result.message);
    return result;
  }
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot();
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const { config, workflow } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  const workId = workflow.workItem.id;
  const phaseId = optionString(options, 'phase', null) ?? applicationReviewPhase(workflow);
  const { applicationReviewPlan, applicationReviewStatus, findReviewSession } = await import('../application-review-read.mjs');
  let result;
  if (sub === 'plan') result = await applicationReviewPlan(root, config, workflow, { phaseId });
  else if (sub === 'start') {
    const { startApplicationReview } = await import('../application-review.mjs');
    const prior = (workflow.applicationReviews ?? []).findLast(item => item.subject.phaseId === phaseId);
    result = prior ? { session: await applicationReviewStatus(root, config, workflow, prior.id), replay: true }
      : await startApplicationReview(root, { workId, phaseId, actionId: optionString(options, 'action-id', null) ?? randomUUID() });
  } else {
    const session = findReviewSession(workflow, positionals[2] ?? null, phaseId);
    if (positionals.length > 3) araFail('ARA_COMMAND_INVALID', APPLICATION_REVIEW_USAGE);
    if (sub === 'status') result = await applicationReviewStatus(root, config, workflow, session.id);
    else if (['inspect', 'accept', 'recheck', 'capture', 'defer', 'close'].includes(sub)) result = await inspectApplicationReview(root, workId, session.id);
    else {
      const inputFile = optionString(options, 'input');
      const inline = optionString(options, 'input-json');
      if ((!inputFile && !inline) || inputFile && inline) araFail('ARA_INPUT_REQUIRED', 'Use exactly one input file or --input-json for observation data. Human acceptance is collected separately.');
      let inputText = inline;
      if (inputFile) {
        const { readFile, lstat } = await import('node:fs/promises');
        const info = await lstat(inputFile);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) araFail('ARA_INPUT_INVALID', 'Review input is a regular JSON file of at most 64 KiB.');
        inputText = await readFile(inputFile, 'utf8');
      }
      if (Buffer.byteLength(inputText) > 65536) araFail('ARA_INPUT_INVALID', 'Review input exceeds 64 KiB.');
      const input = JSON.parse(inputText);
      exactFields(input, sub === 'feedback' ? ['observed', 'expected', 'intent', 'targetId'] : sub === 'repair' ? ['findingId', 'obligationRefs'] : ['attemptId', 'result'], 'Review input');
      const invocation = { workId, sessionId: session.id, actionId: optionString(options, 'action-id'), expectedRevision: Number(optionString(options, 'revision')), input };
      const writer = await import('../application-review.mjs');
      if (sub === 'feedback') result = await writer.recordApplicationFeedback(root, invocation);
      else if (sub === 'repair') result = await writer.prepareApplicationRepair(root, invocation);
      else result = await writer.mutateApplicationReview(root, { ...invocation, type: 'repair-observed', prepare: ({ view }) => {
        if (!view.repairAttempts.some(item => item.id === input.attemptId)) araFail('ARA_ATTEMPT_NOT_FOUND', 'Use the existing repair attempt; do not recreate it.');
        if (typeof input.result !== 'object' || !input.result) araFail('ARA_REPAIR_RESULT_INVALID', 'Record observed changes, checks and the actual replacement target.');
        return input;
      } });
    }
  }
  const sessionId = result.session?.id ?? (result.kind !== 'application-review-plan' ? result.id ?? result.sessionId : null);
  const value = { schemaVersion: 1, resultType: 'sflow-application-review', repositoryPath: root, ...result,
    commandGuidance: sub === 'repair' || sub === 'repair-result'
      ? { copilotCommand: '/sf-code', command: `singularity-flow phase enter ${phaseId} --work-id ${workId} --compose --for-agent --json`, modelFreeCommand: null }
      : { copilotCommand: '/sf-app-review', command: `singularity-flow app-review ${sessionId ? `inspect ${sessionId}` : sub === 'plan' ? 'start' : 'plan'} --work-id ${workId}`, modelFreeCommand: null } };
  const presented = optionBoolean(options, 'for-agent') ? applicationReviewAgentView(value) : value;
  if (optionBoolean(options, 'json') || optionBoolean(options, 'for-agent')) console.log(JSON.stringify(presented, null, 2));
  else {
    console.log(value.message ?? `Application review: ${value.state ?? value.session?.state ?? value.status ?? 'available'}.`);
    console.log(`\n- Copilot: ${value.commandGuidance.copilotCommand}\n- Shell: ${value.commandGuidance.command}\n- VS Code (model-free): not available for this action`);
  }
  return presented;
}

/** Copilot needs state and exact continuation, not duplicate manifests, case inventories or events. */
export function applicationReviewAgentView(value) {
  const session = value.session ?? value;
  return { schemaVersion: 1, resultType: value.resultType, repositoryPath: value.repositoryPath, subject: session.subject,
    sessionId: value.session?.id ?? value.sessionId ?? (value.kind !== 'application-review-plan' ? value.id : null),
    status: value.status ?? session.state, revision: session.revision, message: value.message,
    required: value.required, capabilities: value.capabilities, completion: session.completion, localEvidence: session.localEvidence,
    findings: session.findings?.slice(0, 10).map(item => ({ id: item.id, observed: item.observed.slice(0, 2000), expected: item.expected.slice(0, 2000), state: item.state })),
    omittedFindings: Math.max(0, (session.findings?.length ?? 0) - 10), documents: value.documents,
    repair: value.generationIntent ? { generationIntent: { id: value.generationIntent.id, status: value.generationIntent.status, generation: value.generationIntent.generation },
      attempt: session.repairAttempts?.at(-1)?.id } : null,
    results: (value.results ?? session.target?.results) ? { packet: (value.results ?? session.target.results).packet,
      ready: (value.results ?? session.target.results).ready, reason: (value.results ?? session.target.results).reason } : null,
    error: session.error, commandGuidance: value.commandGuidance,
    instruction: 'Open the exact local review session. The person reports, rechecks and confirms there; opening it, model text and passing tests never constitute acceptance.' };
}
