/**
 * "Open native diff" for the Change Explorer [XPL2 14.4, XPL2-AC-025].
 *
 * Both sides are read through the existing exact-source owner (`comprehension source`), page by
 * bounded page, and verified against the full-content digest it reports. The documents are served
 * read-only from memory under a private scheme and released when their editor closes. The live
 * working file is never substituted for the captured after-side: if the repository moved, the
 * source owner refuses and this surfaces that refusal instead of showing different bytes.
 *
 * Read-only content-provider documents are visible to other installed extensions through the
 * normal editor APIs; this module does not claim isolation from them.
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { ComprehensionSourceReference } from '../cli/snapshot.ts';
import { readExactSource, type ExactSourceContext, type SourceRunner } from './change-explorer-source.ts';

export const CHANGE_EXPLORER_DIFF_SCHEME = 'singularity-flow-explained';

export type { ExactSource, ExactSourceContext } from './change-explorer-source.ts';

class ExactSourceBuffers {
  private readonly documents = new Map<string, string>();

  /** The document keeps the file's own path, so the editor picks its language; the side and a
   * one-time id live in the query, so two captures of one path never share a buffer. */
  add(path: string, side: 'baseline' | 'capture', text: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: CHANGE_EXPLORER_DIFF_SCHEME, path: `/${path.replace(/^\/+/u, '')}`, query: `${side}-${randomUUID()}`
    });
    this.documents.set(uri.toString(), text);
    return uri;
  }

  content(uri: vscode.Uri): string | undefined { return this.documents.get(uri.toString()); }
  release(uri: vscode.Uri): void { this.documents.delete(uri.toString()); }
  clear(): void { this.documents.clear(); }
}

export interface NativeDiffRequest {
  client: SingularityFlowClient;
  context: ExactSourceContext;
  path: string;
  unitId: string;
  before: ComprehensionSourceReference | null;
  after: ComprehensionSourceReference | null;
  signal?: AbortSignal;
}

const hosts = new WeakMap<vscode.ExtensionContext, (request: NativeDiffRequest) => Promise<void>>();

/** One content provider per extension context; buffers are released on close and on disposal. */
export function changeExplorerDiffHost(extension: vscode.ExtensionContext): (request: NativeDiffRequest) => Promise<void> {
  const retained = hosts.get(extension);
  if (retained) return retained;
  const buffers = new ExactSourceBuffers();
  const provider = vscode.workspace.registerTextDocumentContentProvider(CHANGE_EXPLORER_DIFF_SCHEME, {
    provideTextDocumentContent: (uri) => {
      const text = buffers.content(uri);
      if (text === undefined) throw new Error('This captured source is no longer retained. Open the diff again from the Change Explorer.');
      return text;
    }
  });
  const closed = vscode.workspace.onDidCloseTextDocument((document) => {
    if (document.uri.scheme === CHANGE_EXPLORER_DIFF_SCHEME) buffers.release(document.uri);
  });
  extension.subscriptions.push(provider, closed, { dispose: () => { buffers.clear(); hosts.delete(extension); } });
  const open = async (request: NativeDiffRequest): Promise<void> => {
    const run: SourceRunner = (args, signal) => request.client.run(args, signal);
    const [before, after] = await Promise.all([
      request.before ? readExactSource(run, request.context, request.before, request.signal) : Promise.resolve(null),
      request.after ? readExactSource(run, request.context, request.after, request.signal) : Promise.resolve(null)
    ]);
    if (request.signal?.aborted) return;
    const left = buffers.add(request.path, 'baseline', before?.text ?? '');
    const right = buffers.add(request.path, 'capture', after?.text ?? '');
    try {
      await vscode.commands.executeCommand('vscode.diff', left, right,
        `${request.path} · ${request.unitId} (baseline ↔ captured change, read-only)`, { preview: true });
    } catch (error) {
      buffers.release(left);
      buffers.release(right);
      throw error;
    }
  };
  hosts.set(extension, open);
  return open;
}
