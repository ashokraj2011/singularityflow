/**
 * Keep this window on the build the machine installed.
 *
 * Two jobs, both after the first paint and never on the activation path:
 * - when a new build loads, and at most daily after that, ask the CLI whether every product surface
 *   runs the installed build. When the machine retains the installed build for a lagging surface,
 *   align it in the background; otherwise say once what one full install would fix;
 * - notice when this extension's own files are replaced while the window is open. The window keeps
 *   running the old bundle against the new engine until it reloads, so offer the reload.
 *
 * Everything here goes through `singularity-flow product`; the extension decides nothing about
 * builds itself.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ProductSurface {
  id: 'vscode' | 'cli' | 'copilot';
  state: string;
  live?: string | null;
  installed?: string | null;
  reason?: string;
}

export interface ProductSurfaceStatus {
  verdict: 'aligned' | 'repairable' | 'split' | 'no-receipt' | 'receipt-invalid';
  surfaces: ProductSurface[];
  actions: Array<{ surface: string; kind: string }>;
  split: { cli: string | null; vscode: string | null } | null;
  next: Array<{ command: string; reason: string }>;
}

export interface ProductAlignmentResult extends ProductSurfaceStatus {
  status: string;
  steps: Array<{ surface: string; kind: string; outcome: string; reason?: string }>;
}

interface Envelope<T> { data?: T }

type Maybe<T> = Promise<T> | Thenable<T>;

export interface ProductAlignmentHost {
  run<T>(args: string[]): Promise<T>;
  extensionPath: string;
  log(line: string): void;
  progress<T>(title: string, task: () => Promise<T>): Maybe<T>;
  inform(message: string, ...actions: string[]): Maybe<string | undefined>;
  warn(message: string, ...actions: string[]): Maybe<string | undefined>;
  reload(): Maybe<unknown>;
  remembered<T>(key: string): T | undefined;
  remember(key: string, value: unknown): Maybe<void>;
  now?(): number;
}

export const PRODUCT_CHECK_KEY = 'singularityFlow.productAlignment.lastCheck';
export const PRODUCT_SPLIT_KEY = 'singularityFlow.productAlignment.reportedSplit';
const DAY_MS = 24 * 60 * 60 * 1000;
const RELOAD_MESSAGE = 'Singularity Flow was updated. Reload this window to run the installed build.';

/** VS Code's own launcher, so alignment works where `code` was never added to PATH. */
export function codeLauncher(appRoot: string | undefined, platform: NodeJS.Platform = process.platform): string | null {
  if (!appRoot) return null;
  const launcher = path.join(appRoot, 'bin', platform === 'win32' ? 'code.cmd' : 'code');
  return existsSync(launcher) ? launcher : null;
}

/** A packaged extension stages its CLI beside it; a development host loads a checkout instead. */
export function packagedExtension(extensionPath: string): boolean {
  return existsSync(path.join(extensionPath, 'cli', 'package.json'));
}

export function bundleFingerprint(file: string): string | null {
  try {
    const entry = statSync(file);
    return `${entry.size}:${entry.mtimeMs}:${entry.ino}`;
  } catch {
    return null;
  }
}

/** The extension bundle this window loaded, and whether the one on disk has since replaced it. */
export class LoadedBundle {
  private readonly file: string;
  private readonly loaded: string | null;
  private offered = false;
  constructor(file: string) {
    this.file = file;
    this.loaded = bundleFingerprint(file);
  }

  replaced(): boolean {
    const current = bundleFingerprint(this.file);
    return Boolean(this.loaded && current && current !== this.loaded);
  }

  /** Offer one reload per window. `force` is for an update this window itself just installed. */
  async offerReload(host: Pick<ProductAlignmentHost, 'inform' | 'reload'>, force = false): Promise<boolean> {
    if (this.offered || (!force && !this.replaced())) return false;
    this.offered = true;
    if (await host.inform(RELOAD_MESSAGE, 'Reload') === 'Reload') await host.reload();
    return true;
  }
}

/** Whether this window should check now: a newly loaded build always, otherwise once a day. */
export function productCheckDue(host: Pick<ProductAlignmentHost, 'remembered' | 'now'>, loadedBuild: string): boolean {
  const last = host.remembered<{ build?: string; at?: number }>(PRODUCT_CHECK_KEY);
  const now = host.now?.() ?? Date.now();
  return !last || last.build !== loadedBuild || !Number.isFinite(last.at) || now - Number(last.at) >= DAY_MS;
}

function failureText(error: unknown): string {
  return String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 300);
}

/**
 * One background pass: status, then alignment only when the machine can repair a surface itself.
 * Returns what happened, for the caller's log and for tests.
 */
export async function alignProductSurfaces(host: ProductAlignmentHost, {
  loadedBuild, bundle
}: { loadedBuild: string; bundle: LoadedBundle }): Promise<string> {
  if (loadedBuild === 'unstamped' || !packagedExtension(host.extensionPath)) return 'skipped-development';
  if (!productCheckDue(host, loadedBuild)) return 'skipped-recent';
  const target = ['--extension-path', host.extensionPath];
  let status: ProductSurfaceStatus | undefined;
  try {
    status = (await host.run<Envelope<ProductSurfaceStatus>>(['product', 'status', '--json', ...target])).data;
  } catch (error) {
    host.log(`Product surface check was unavailable: ${failureText(error)}`);
    return 'unavailable';
  }
  await host.remember(PRODUCT_CHECK_KEY, { build: loadedBuild, at: host.now?.() ?? Date.now() });
  if (!status) return 'unavailable';
  for (const surface of status.surfaces) {
    host.log(`Product surface ${surface.id}: ${surface.state}${surface.live ? ` · ${surface.live}` : ''}`);
  }
  if (status.verdict === 'repairable') {
    let result: ProductAlignmentResult | undefined;
    try {
      result = (await host.progress('Singularity Flow: aligning every surface to the installed build',
        () => host.run<Envelope<ProductAlignmentResult>>([
          'product', 'align', '--json', ...target, '--trigger', 'vscode-activation'
        ]))).data;
    } catch (error) {
      void host.warn(`Singularity Flow could not align its surfaces: ${failureText(error)} Run \`singularity-flow product align\` to retry.`);
      return 'failed';
    }
    for (const step of result?.steps ?? []) {
      host.log(`Product alignment ${step.surface}: ${step.outcome}${step.reason ? ` — ${step.reason}` : ''}`);
    }
    const failed = result?.steps.find((step) => step.outcome === 'failed');
    if (failed) {
      void host.warn(`Singularity Flow stopped aligning the ${failed.surface} surface: ${failed.reason ?? 'unknown failure'} Run \`singularity-flow product align\` to retry.`);
      return 'failed';
    }
    // A reinstalled VSIX of the same version replaces this window's files in place; of another
    // version, it lands beside them. Either way the window runs the old build until it reloads.
    if (result?.steps.some((step) => step.surface === 'vscode' && step.outcome === 'aligned')) {
      await bundle.offerReload(host, true);
    }
    return 'repaired';
  }
  if (status.verdict === 'split') {
    const reported = JSON.stringify(status.split ?? status.surfaces.map((surface) => [surface.id, surface.state]));
    if (host.remembered<string>(PRODUCT_SPLIT_KEY) === reported) return 'split-reported';
    await host.remember(PRODUCT_SPLIT_KEY, reported);
    const next = status.next.at(-1);
    void host.inform(`Singularity Flow surfaces run different builds. ${next ? `${next.reason} ${next.command}` : 'A full install puts one build on every surface.'}`);
    return 'split';
  }
  return status.verdict;
}
