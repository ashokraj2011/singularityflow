/**
 * Validating governed configuration as it is edited.
 *
 * These files are edited in ordinary editor tabs, against the files on disk — a custom editor would
 * be worse at editing YAML than the editor is. But saving a broken workflow.yml through the editor
 * skips the check the engine performs when *it* writes one, and the first sign of trouble becomes a
 * command failing later for a reason that has nothing to do with what was typed.
 *
 * So the engine is asked after every save of a governed file, and its answer becomes a diagnostic.
 * The check is the engine's; this only decides when to ask and where to show the answer.
 */
import * as vscode from 'vscode';
import { realpathSync } from 'node:fs';
import { isGovernedConfiguration } from './governed.ts';
import type { SingularityFlowClient } from './cli/client.ts';

interface ValidationReport {
  valid?: boolean;
  errors?: string[];
  error?: string;
}

/**
 * Ask the engine, and turn the answer into diagnostics on the file that was saved.
 *
 * `desktop validate` reports on the configuration as a whole rather than per line, so the diagnostic
 * sits at the top of the file. That is honest about what was checked: the problem may well be a
 * reference between two files, and pointing at a line would invent a precision the check does not
 * have.
 */
export class ConfigurationValidator implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('singularityFlow');
  private readonly subscription: vscode.Disposable;
  private readonly client: SingularityFlowClient;

  /**
   * The repository is read from the client rather than captured, because it moves: choosing a
   * different workspace re-points the client, and a validator holding the old path would either
   * validate the wrong repository or quietly decide nothing was configuration any more.
   */
  constructor(client: SingularityFlowClient) {
    this.client = client;
    this.subscription = vscode.workspace.onDidSaveTextDocument((document) => {
      if (this.governs(this.client.repository, document.uri.fsPath)) void this.validate(document);
    });
  }

  /**
   * Whether a saved file is this repository's governed configuration.
   *
   * The repository path is canonical — validateRepositoryDirectory resolves it — while the editor
   * reports whatever path the file was opened by. On macOS /var is a symlink to /private/var, so
   * those two disagree for anything under a temporary directory, and a straight comparison silently
   * decides that nothing is configuration. The path is resolved before comparing, and the
   * unresolved form is still tried in case the file no longer exists.
   */
  private governs(repository: string, file: string): boolean {
    if (isGovernedConfiguration(repository, file)) return true;
    try {
      return isGovernedConfiguration(repository, realpathSync(file));
    } catch {
      return false;
    }
  }

  async validate(document: vscode.TextDocument): Promise<void> {
    let report: ValidationReport;
    try {
      report = await this.client.run<ValidationReport>(['desktop', 'validate', '--json']);
    } catch (error) {
      // A non-zero exit is itself the finding: the CLI refuses to report on a configuration it
      // cannot load, and its message is the useful part.
      report = { valid: false, error: (error as Error).message };
    }

    if (report.valid) {
      this.diagnostics.delete(document.uri);
      return;
    }

    const messages = report.errors?.length ? report.errors : [report.error ?? 'The configuration is not valid.'];
    this.diagnostics.set(document.uri, messages.map((message) => {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        message,
        vscode.DiagnosticSeverity.Error
      );
      diagnostic.source = 'Singularity Flow';
      return diagnostic;
    }));
  }

  dispose(): void {
    this.subscription.dispose();
    this.diagnostics.dispose();
  }
}
