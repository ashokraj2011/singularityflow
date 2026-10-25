/**
 * Where a terminal or task this window opens starts.
 *
 * VS Code 1.143 refuses to start any terminal process, a task's included, in a window with no
 * folder open unless it starts in the home folder: "Cannot launch a terminal process in an empty
 * workspace with cwd … different from userHome …". A window bound to a repository without opening
 * it as a folder is that window, so there a terminal starts at home and reaches the checkout itself.
 */
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { terminalDirectorySetup } from './cli/runner.ts';

function startsIn(cwd: string): boolean {
  return Boolean(vscode.workspace.workspaceFolders?.length) || path.resolve(cwd) === path.resolve(os.homedir());
}

/** A task's start folder: `cwd`, or home in a window with no folder (the CLI binds its surface context). */
export function taskStartFolder(cwd: string): string {
  return startsIn(cwd) ? cwd : os.homedir();
}

/** Open a terminal in `cwd`. In a window with no folder it starts at home, and its shell moves there first. */
export function createTerminalIn(options: Omit<vscode.TerminalOptions, 'cwd'>, cwd: string): vscode.Terminal {
  if (startsIn(cwd)) return vscode.window.createTerminal({ ...options, cwd });
  const setup = terminalDirectorySetup(options, cwd);
  const terminal = vscode.window.createTerminal({ ...options, shellPath: setup.shellPath, cwd: os.homedir() });
  terminal.sendText(setup.command, true);
  return terminal;
}
