/** Model-free lifecycle UI: one exact engine plan, one human-confirmed action, no routing loop. */
import * as vscode from 'vscode';
import { approveWithReceipt } from './actions.ts';
import { commandGuidance } from './copilot-command.ts';
import type { SingularityFlowClient } from './cli/client.ts';
import type { DecisionInputSpec, SubmissionReadiness } from './cli/snapshot.ts';
import { decisionInputPrompt } from './decisions.ts';
import { unsavedRepositoryPaths } from './generation-guards.ts';
import { showCompactWarningMessage } from './compact-message.ts';
import { collectReviewConfirmation } from './views/review-confirmation.ts';
import { parseModelFreeTarget } from '../../../src/model-free-commands.mjs';

export type LifecycleChatCommand = 'submit' | 'publish' | 'approve' | 'continue';
export interface LifecycleChatSession {
  client: SingularityFlowClient; editorRoot: string; workId: string; phaseId: string;
}
export interface LifecycleChatAction {
  actionId: string; timing: string; executable: boolean; argv: string[];
  reason: string; command: string; skill: string | null;
  confirmation: { required: boolean };
}
interface LifecycleChatPlan {
  planId: string; subject: { kind: string; id: string };
  expiresAt: string; revision: { head: string }; actions: LifecycleChatAction[];
  publicationReadiness?: { status: string; findings?: { code: string; message: string }[];
    commands?: Record<string, string | null> } | null;
}

function inline(value: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 2400);
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/gu), match => match[0].length));
  const delimiter = '`'.repeat(longest + 1);
  return `${delimiter} ${text} ${delimiter}`;
}

/** Never run authoring/model, risk waivers, arbitrary scripts, or approval through action execute. */
export function lifecycleActionKind(action: LifecycleChatAction, phase: string, workId: string): LifecycleChatCommand | null {
  if (action.timing !== 'now' || !action.executable) return null;
  // Action plans use `executable` as a boolean, while guidance uses it as the program name.
  const guidance = commandGuidance({ command: action.command, argv: action.argv, skill: action.skill });
  if (!guidance || guidance.argv.some((value, index) => value !== action.argv[index])
      || guidance.argv.length !== action.argv.length) return null;
  const argv = action.argv;
  const safeOptions = (start: number, valued: string[], booleans: string[] = []) => {
    const seen = new Set<string>();
    for (let i = start; i < argv.length; i += 1) {
      const flag = argv[i]!;
      if (seen.has(flag) && flag !== '--decision') return false;
      seen.add(flag);
      if (booleans.includes(flag)) continue;
      if (!valued.includes(flag) || !argv[i + 1] || argv[i + 1]!.startsWith('--')) return false;
      const value = argv[++i]!;
      if (flag === '--work-id' && value !== workId) return false;
      if (flag === '--decision' && !/^[A-Za-z][A-Za-z0-9._-]*=.+$/u.test(value)) return false;
    }
    return true;
  };
  if (argv[0] === 'story' && argv[1] === 'advance' && argv.length === 4
      && argv[2] === '--work-id' && argv[3] === workId) return 'submit';
  if (argv[0] === 'submit' && argv[1] === phase && safeOptions(2, ['--decision', '--work-id'], ['--json', '--no-model'])) return 'submit';
  if (argv[0] === 'phase' && argv[1] === 'publish' && argv[2] === phase
      && safeOptions(3, ['--authored', '--channel', '--work-id'], ['--json', '--no-model'])) return 'publish';
  if (argv[0] === 'approve' && argv[1] === phase
      && argv[argv.indexOf('--work-id') + 1] === workId && argv.includes('--work-id')
      && safeOptions(2, ['--work-id'], ['--fetch', '--json', '--no-model'])) return 'approve';
  return null;
}

async function decisionAnswers(inputs: DecisionInputSpec[], token: vscode.CancellationToken): Promise<Record<string, string> | null> {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    if (token.isCancellationRequested) return null;
    const prompt = decisionInputPrompt(input);
    const answer = prompt.choices
      ? await vscode.window.showQuickPick(prompt.choices, { title: prompt.title, ignoreFocusOut: true })
      : await vscode.window.showInputBox({ title: prompt.title, ignoreFocusOut: true, validateInput: prompt.validate });
    if (answer === undefined) return null;
    const error = prompt.validate(answer);
    if (error) throw new Error(error);
    values[input.name] = answer.trim();
  }
  return values;
}

/** Injected session resolver is rechecked after every human interaction and before every write. */
export async function runLifecycleChat(
  command: LifecycleChatCommand, prompt: string, stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken, signal: AbortSignal,
  getSession: (signal: AbortSignal) => Promise<LifecycleChatSession>,
  isPaused: () => boolean, output: vscode.OutputChannel
): Promise<void> {
  const target = parseModelFreeTarget(prompt);
  const active = await getSession(signal);
  if ((target.phase && target.phase !== active.phaseId) || (target.workId && target.workId !== active.workId)) {
    throw new Error('The requested phase or Story is not the verified active session. Select it first; nothing was executed.');
  }
  const stillCurrent = async () => {
    if (token.isCancellationRequested || signal.aborted || isPaused()) return false;
    const current = await getSession(signal);
    if (unsavedRepositoryPaths(vscode.workspace.textDocuments ?? [], active.editorRoot).length) {
      throw new Error('Save the edited repository buffers before reviewing or executing a lifecycle action; unsaved changes were not published or approved.');
    }
    return current.editorRoot === active.editorRoot && current.workId === active.workId && current.phaseId === active.phaseId;
  };
  if (!(await stillCurrent())) return;
  stream.progress(`Reviewing model-free /${command} for ${active.workId} / ${active.phaseId}…`);
  const status = await active.client.run<{
    workItem: { id: string }; currentPhase: string;
    phases: Record<string, { status: string; generation: number }>
  }>(['status', active.workId, '--json'], signal);
  if (status.workItem?.id !== active.workId || status.currentPhase !== active.phaseId) throw new Error('Lifecycle status does not match the selected Story.');

  let values: Record<string, string> = {};
  if (command === 'submit' || command === 'continue') {
    const readiness = await active.client.run<SubmissionReadiness>(['status', active.workId, '--submission-readiness', '--json'], signal);
    if (readiness.phaseId === active.phaseId && readiness.lifecycleReady && readiness.decisionInputs?.length) {
      const answers = await decisionAnswers(readiness.decisionInputs, token);
      if (!answers || !(await stillCurrent())) { stream.markdown('Cancelled; no lifecycle action was executed.\n'); return; }
      values = answers;
    }
  }
  // The parameter values are part of the plan's content hash, not appended after authorization.
  const planArgs = ['action', 'plan', active.workId, '--json'];
  if (command === 'publish' || command === 'continue') planArgs.push('--operation', command === 'publish' ? 'publish' : 'lifecycle');
  for (const [name, value] of Object.entries(values)) planArgs.push('--decision', `${name}=${value}`);
  const plan = await active.client.run<LifecycleChatPlan>(planArgs, signal);
  if (plan.subject?.kind !== 'story' || plan.subject.id !== active.workId || !/^[a-f0-9]{24}$/u.test(plan.planId)
      || !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= Date.now()) {
    throw new Error('The current action plan is unavailable or not bound to this Story.');
  }
  const candidates = plan.actions.filter((action) => {
    const kind = lifecycleActionKind(action, active.phaseId, active.workId);
    return kind && (command === 'continue' || kind === command);
  });
  if (!candidates.length) {
    stream.markdown('No currently executable model-free lifecycle action matches this request. No gate was bypassed.\n\n');
    if (plan.publicationReadiness && plan.publicationReadiness.status !== 'ready') {
      for (const finding of (plan.publicationReadiness.findings ?? []).slice(0, 3)) {
        stream.markdown(`- ${inline(finding.code)}: ${inline(finding.message)}\n`);
      }
      for (const name of ['next', 'recheck', 'recover']) {
        const guidance = commandGuidance(plan.publicationReadiness.commands?.[name]);
        if (guidance) stream.markdown(`- Repair/check: ${inline(guidance.command)} · Copilot: ${inline(guidance.copilotCommand ?? 'no verified equivalent')}\n`);
      }
      return;
    }
    const next = await active.client.run<{ actions?: unknown[] }>(['nextsteps', active.workId, '--json'], signal);
    for (const item of (next.actions ?? []).slice(0, 3)) {
      const guidance = commandGuidance(item);
      if (guidance) stream.markdown(`- Shell: ${inline(guidance.command)} · Copilot: ${inline(guidance.copilotCommand ?? 'no verified equivalent')}\n`);
    }
    return;
  }
  const selected = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(
    candidates.map((action) => ({ label: action.reason, description: action.command, action })),
    { title: 'Choose one model-free lifecycle action', ignoreFocusOut: true }
  ))?.action;
  if (!selected || !(await stillCurrent())) { stream.markdown('Cancelled; no lifecycle action was executed.\n'); return; }
  const kind = lifecycleActionKind(selected, active.phaseId, active.workId);
  stream.markdown(`Story ${inline(active.workId)} · phase ${inline(active.phaseId)} · generation ${Number(status.phases[active.phaseId]?.generation) || 0}\n\n`);
  let completed = false;
  if (kind === 'approve') {
    // Same typed confirmation, checklist, identity and exact-hash receipt as the native UI.
    completed = await approveWithReceipt(active.client, {
      kind: 'story', workId: active.workId, phaseId: active.phaseId, expected: active.phaseId,
      summary: `Approve ${active.workId} / ${active.phaseId}`
    }, output, stillCurrent);
  } else if (selected.argv[0] === 'story' && selected.argv[1] === 'advance') {
    // Convergence submission is a distinct digest-reviewed contract, not generic submit.
    const preview = await active.client.runText(selected.argv, { signal });
    const matches = [...preview.matchAll(/^Confirmation digest: ([a-f0-9]{64})$/gmu)];
    if (matches.length !== 1) throw new Error('No exact convergence review digest was returned. Inspect /sf-converge; no submission was recorded.');
    const digest = matches[0]![1]!;
    const reviewed = await collectReviewConfirmation({
      title: `Review convergence for ${active.workId}`, summary: 'Confirm the exact convergence snapshot before submission.',
      detail: preview, expected: digest, confirmLabel: 'Submit reviewed convergence'
    });
    if (!reviewed || !(await stillCurrent())) { stream.markdown('Cancelled; convergence was not submitted.\n'); return; }
    output.appendLine(await active.client.runText([...selected.argv, '--confirm', digest], { signal }));
    completed = true;
  } else {
    const answer = await showCompactWarningMessage(`Run ${kind} for ${active.workId} / ${active.phaseId}?`, {
      modal: true, detail: `${selected.command}\n\nPlan ${plan.planId} · HEAD ${plan.revision.head}\nExpires ${plan.expiresAt}. Changed repository bytes or lifecycle state invalidate this plan. Tests and gates remain enforced.`
    }, 'Run exact action');
    if (answer !== 'Run exact action' || !(await stillCurrent())) { stream.markdown('Cancelled; no lifecycle action was executed.\n'); return; }
    const argv = ['action', 'execute', plan.planId, '--action', selected.actionId];
    if (selected.confirmation.required) {
      const authorization = await active.client.run<{ token: string }>([
        'action', 'authorize', plan.planId, '--action', selected.actionId,
        '--confirm', selected.actionId, '--channel', 'vscode', '--json'
      ], signal);
      if (!(await stillCurrent())) return;
      argv.push('--authorization', authorization.token);
    }
    // Text output is deliberately bounded by the client; nested CLI JSON is not a single envelope.
    const result = await active.client.runText(argv, { signal });
    output.appendLine(result);
    completed = true;
  }
  if (!completed) { stream.markdown('The action was cancelled or refused. No approval is claimed; inspect the SFlow result panel.\n'); return; }
  stream.markdown(`The governed **${kind}** command completed. No model was invoked by SFlow; it did not run another lifecycle action.\n\n`);
  // Refresh only this still-selected repository; a workspace switch must not repaint another Story.
  try {
    const current = await getSession(signal);
    if (current.editorRoot === active.editorRoot && current.workId === active.workId) {
      await vscode.commands.executeCommand('singularityFlow.refresh');
    }
  } catch { /* Lifecycle may now be complete; nextsteps remains readable without an active phase. */ }
  try {
    const next = await active.client.run<{ actions?: unknown[] }>(['nextsteps', active.workId, '--json'], signal);
    for (const item of (next.actions ?? []).slice(0, 3)) {
      const guidance = commandGuidance(item);
      if (guidance) stream.markdown(`- Next: ${inline(guidance.modelFreeCommand ?? guidance.copilotCommand ?? 'no verified equivalent')} · Shell: ${inline(guidance.command)}\n`);
    }
  } catch { stream.markdown('The command completed, but next-action refresh is unavailable. Run `@sflow /next`; do not repeat the mutation.\n'); }
}
