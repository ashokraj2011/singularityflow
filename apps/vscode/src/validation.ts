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
import path from 'node:path';
import { isGovernedConfiguration } from './governed.ts';
import type { SingularityFlowClient } from './cli/client.ts';
import { CliError } from './cli/runner.ts';
import { LatestSingleFlight } from './single-flight.ts';

/** One located workflow.yml problem from a refusal's `error.details.configurationProblems`. */
interface ConfigurationProblem {
  file?: string;
  line?: number;
  column?: number;
  message?: string;
  fix?: string;
}

interface ValidationReport {
  valid?: boolean;
  errors?: string[];
  error?: string;
  problems?: ConfigurationProblem[];
  /** Internal cancellation receipt; never emitted by the CLI. */
  repositoryMoved?: true;
}

/**
 * Ask the engine, and turn the answer into diagnostics on the file that was saved.
 *
 * A refusal that locates its problems (every workflow.yml problem, with file, line and fix) puts each
 * diagnostic on that line of that file. Anything the engine did not locate sits at the top of the
 * saved file: the problem may be a reference between two files, and pointing at a line would invent
 * a precision the check does not have.
 */
export class ConfigurationValidator implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('singularityFlow');
  private readonly subscription: vscode.Disposable;
  private readonly client: SingularityFlowClient;
  private readonly flights = new Map<string, LatestSingleFlight<ValidationReport>>();
  private disposed = false;

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
    if (this.disposed) return;
    const repository = this.client.repository;
    let flight = this.flights.get(repository);
    if (!flight) {
      flight = new LatestSingleFlight(async () => {
        // A trailing request belongs to the repository that scheduled this flight. If the shared
        // client moved while the first process was running, do not accidentally validate the new
        // repository under the old flight's key.
        if (repository !== this.client.repository) return { repositoryMoved: true };
        try {
          return await this.client.run<ValidationReport>(['configuration', 'validate', '--json']);
        } catch (error) {
          // A non-zero exit is itself the finding: the CLI refuses to report on a configuration it
          // cannot load, and its message is the useful part.
          return { valid: false, error: (error as Error).message, problems: configurationProblems(error) };
        }
      });
      this.flights.set(repository, flight);
    }

    const report = await flight.request();

    // The client can be rebound while a validation process is running. Its process already used
    // the captured repository, but diagnostics belong only in the repository currently displayed.
    // A later save after switching back will request a fresh run through the same coordinator.
    if (this.disposed || report.repositoryMoved || repository !== this.client.repository) return;

    // Located problems may sit in a file other than the one saved, so the whole set is replaced.
    this.diagnostics.clear();
    if (report.valid) return;

    const located = new Map<string, vscode.Diagnostic[]>();
    const add = (uri: vscode.Uri, range: vscode.Range, message: string) => {
      const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'Singularity Flow';
      located.set(uri.fsPath, [...(located.get(uri.fsPath) ?? []), diagnostic]);
    };
    const uris = new Map<string, vscode.Uri>();
    // The repository path is canonical while the editor keeps the path a file was opened by
    // (/var vs /private/var on macOS), so a problem in the saved file uses the saved file's own URI.
    const real = (file: string) => { try { return realpathSync(file); } catch { return file; } };
    const saved = real(document.uri.fsPath);
    for (const problem of report.problems ?? []) {
      const relative = typeof problem.file === 'string' ? problem.file : '';
      const inside = relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes('..');
      const line = Number.isSafeInteger(problem.line) && (problem.line as number) > 0 ? (problem.line as number) - 1 : null;
      if (!inside || line == null || !problem.message) continue;
      const target = path.join(repository, relative);
      const uri = real(target) === saved ? document.uri : vscode.Uri.file(target);
      const column = Number.isSafeInteger(problem.column) && (problem.column as number) > 0 ? (problem.column as number) - 1 : 0;
      uris.set(uri.fsPath, uri);
      add(uri, new vscode.Range(line, column, line, Number.MAX_SAFE_INTEGER), problem.fix ? `${problem.message} Fix: ${problem.fix}` : problem.message);
    }
    if (!located.size) {
      const messages = report.errors?.length ? report.errors : [report.error ?? 'The configuration is not valid.'];
      uris.set(document.uri.fsPath, document.uri);
      for (const message of messages) add(document.uri, new vscode.Range(0, 0, 0, 0), message);
    }
    for (const [key, entries] of located) this.diagnostics.set(uris.get(key) as vscode.Uri, entries);
  }

  dispose(): void {
    this.disposed = true;
    this.flights.clear();
    this.subscription.dispose();
    this.diagnostics.dispose();
  }
}

/** The located problems a structured refusal carries, or none. */
function configurationProblems(error: unknown): ConfigurationProblem[] {
  if (!(error instanceof CliError) || !error.result || typeof error.result !== 'object') return [];
  const problems = (error.result as { error?: { details?: { configurationProblems?: unknown } } }).error?.details?.configurationProblems;
  return Array.isArray(problems) ? problems.filter((problem): problem is ConfigurationProblem => Boolean(problem) && typeof problem === 'object').slice(0, 50) : [];
}
