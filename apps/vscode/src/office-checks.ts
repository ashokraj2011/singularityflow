/**
 * "SFlow: Run office checks": the CLI's `probe office --host-questions` in this folder, with VS Code's own
 * buttons for its questions (docs/OFFICE-CHECKS.md). The CLI does every check and writes the report; this only
 * answers its questions, shows its progress, opens the chat when a guided step asks for a message, and says where
 * the report is. Cancel asks the CLI to stop after its current step, so anything it pushed is still deleted.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import * as vscode from 'vscode';
import type { CliLocation } from './cli/client.ts';

interface ProbeQuestion { id?: string; question?: string; why?: string; yes?: string; no?: string; kind?: string }
interface ProbeNote { text?: string; action?: string; message?: string }
interface ProbeDone { markdown?: string; json?: string }

export interface OfficeChecksOptions {
  location: CliLocation;
  environment: NodeJS.ProcessEnv;
  folder: string;
  output: vscode.OutputChannel;
}

function parse<T>(line: string, prefix: string): T | null {
  if (!line.startsWith(prefix)) return null;
  try { return JSON.parse(line.slice(prefix.length)) as T; } catch { return null; }
}

async function answer(question: ProbeQuestion): Promise<string> {
  if (question.kind === 'text') {
    const value = await vscode.window.showInputBox({
      title: 'SFlow office checks', prompt: `${question.question ?? ''} ${question.why ?? ''}`.trim(),
      placeHolder: 'ABC-123 (leave empty to skip)', ignoreFocusOut: true
    });
    return (value ?? '').trim();
  }
  const detail = [`Why: ${question.why ?? ''}`, question.yes ?? '', question.no ?? ''].filter(Boolean).join('\n\n');
  const choice = await vscode.window.showWarningMessage(question.question ?? 'Continue?', { modal: true, detail }, 'Yes', 'No');
  return choice === 'Yes' ? 'yes' : 'no';
}

function showNote(note: ProbeNote): void {
  if (note.action === 'send-chat' && note.message) {
    void vscode.window.showInformationMessage(note.text ?? '', 'Open chat').then((choice) => {
      if (choice !== 'Open chat') return;
      void vscode.commands.executeCommand('workbench.action.chat.open', { query: note.message, isPartialQuery: true })
        .then(undefined, () => vscode.commands.executeCommand('workbench.action.chat.open'));
    });
  } else if (note.action) void vscode.window.showInformationMessage(note.text ?? '');
}

async function finished(done: ProbeDone | null): Promise<void> {
  if (!done?.markdown) {
    void vscode.window.showErrorMessage('The office checks stopped before writing their report. The Singularity Flow output says why.');
    return;
  }
  const file = vscode.Uri.file(done.markdown);
  const choice = await vscode.window.showInformationMessage(
    `Office checks written to ${path.basename(done.markdown)} in this folder. Send this file back.`, 'Open report', 'Reveal in folder');
  if (choice === 'Open report') await vscode.window.showTextDocument(file);
  else if (choice === 'Reveal in folder') await vscode.commands.executeCommand('revealFileInOS', file);
}

export async function runOfficeChecks({ location, environment, folder, output }: OfficeChecksOptions): Promise<void> {
  output.appendLine(`\nSFlow office checks in ${folder}`);
  const done = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: 'SFlow office checks', cancellable: true
  }, (progress, token) => new Promise<ProbeDone | null>((resolve) => {
    const child = spawn(location.executable, [location.cli, 'probe', 'office', '--host-questions'], {
      cwd: folder, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let result: ProbeDone | null = null;
    let pending = '';
    let queue = Promise.resolve();
    const write = (text: string): void => { if (child.stdin.writable) child.stdin.write(`${text}\n`); };
    token.onCancellationRequested(() => write('cancel'));
    const handle = async (line: string): Promise<void> => {
      const question = parse<ProbeQuestion>(line, 'SFLOW_PROBE_ASK ');
      if (question) { write(await answer(question)); return; }
      const note = parse<ProbeNote>(line, 'SFLOW_PROBE_NOTE ');
      if (note) { progress.report({ message: note.text }); output.appendLine(note.text ?? ''); showNote(note); return; }
      const done = parse<ProbeDone>(line, 'SFLOW_PROBE_DONE ');
      if (done) { result = done; return; }
      if (line.trim()) output.appendLine(line);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
        const line = pending.slice(0, at).replace(/\r$/u, '');
        pending = pending.slice(at + 1);
        queue = queue.then(() => handle(line));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => output.append(String(chunk)));
    child.on('error', (error) => { output.appendLine(`The office checks could not start: ${error.message}`); resolve(null); });
    child.on('close', () => { void queue.then(() => resolve(result)); });
  }));
  await finished(done);
}
