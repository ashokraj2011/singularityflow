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

export interface ProductRequirementCheck {
  repository: string;
  verdict: string;
  checkedAt: string | null;
  required?: string | null;
  reason?: string | null;
}

export interface ProductSurfaceStatus {
  verdict: 'aligned' | 'repairable' | 'split' | 'no-receipt' | 'receipt-invalid';
  surfaces: ProductSurface[];
  actions: Array<{ surface: string; kind: string }>;
  split: { cli: string | null; vscode: string | null } | null;
  next: Array<{ command: string; reason: string }>;
  requirements?: ProductRequirementCheck[];
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
export const PRODUCT_REQUIREMENT_WARNED_KEY = 'singularityFlow.productRequirement.warned';
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

  /**
   * Whether this window runs a build the machine has since replaced, whether or not its reload was
   * accepted. A new version's VSIX lands beside this one, leaving these files unchanged, so an offered
   * reload counts too.
   */
  reloadPending(): boolean {
    return this.offered || this.replaced();
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

/**
 * Say once, per repository and attempt, that a required build could not be installed. The terminal
 * printed it too, but a window may be where the person looks.
 */
function warnFailedRequirements(host: ProductAlignmentHost, requirements: ProductRequirementCheck[]): void {
  const warned = new Set(host.remembered<string[]>(PRODUCT_REQUIREMENT_WARNED_KEY) ?? []);
  const fresh = requirements.filter((entry) => entry.verdict === 'failed' && !warned.has(`${entry.repository}|${entry.checkedAt}`));
  if (!fresh.length) return;
  for (const entry of fresh) warned.add(`${entry.repository}|${entry.checkedAt}`);
  void host.remember(PRODUCT_REQUIREMENT_WARNED_KEY, [...warned].slice(-20));
  const first = fresh[0]!;
  void host.warn(`Singularity Flow could not install the build ${path.basename(first.repository)} requires${first.reason ? `: ${first.reason}` : '.'} `
    + 'It keeps working on the current build. `singularity-flow product status` shows every repository\'s requirement.');
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
  warnFailedRequirements(host, status.requirements ?? []);
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

export const CONFIGURATION_REVIEW_KEY = 'singularityFlow.configurationReview.lastBuild';

interface ReviewsResult {
  status: 'ran' | 'recorded' | 'running' | 'development';
  outcome: string | null;
  reviews: Array<{ repository: string; proposalBranch: string }>;
  unfinished?: Array<{ repository: string; reason: string }>;
  reason?: string | null;
}

/**
 * Once per newly loaded build, open a review for each registered repository whose approved
 * configuration lags this build's packaged configuration. Nothing is applied: a person merges each
 * review. The pass is the CLI's own `product reviews`, shared with a terminal's background pass
 * through one per-build record, so a window and a terminal never refresh the same configuration at
 * once and a review a terminal already opened is reported, not opened again.
 *
 * A window waiting to reload onto a newer build proposes nothing: its CLI would propose the
 * configuration the machine just replaced, and the reloaded build proposes its own.
 */
export async function openConfigurationReviews(host: ProductAlignmentHost, {
  loadedBuild, bundle = null
}: { loadedBuild: string; bundle?: Pick<LoadedBundle, 'reloadPending'> | null }): Promise<string> {
  if (loadedBuild === 'unstamped' || !packagedExtension(host.extensionPath)) return 'skipped-development';
  if (bundle?.reloadPending()) return 'skipped-reload-pending';
  if (host.remembered<string>(CONFIGURATION_REVIEW_KEY) === loadedBuild) return 'skipped-recent';
  let result: ReviewsResult | undefined;
  try {
    result = (await host.progress('Singularity Flow: opening configuration reviews for this build',
      () => host.run<Envelope<ReviewsResult>>(['product', 'reviews', '--json']))).data;
  } catch (error) {
    void host.warn(`Singularity Flow could not open configuration reviews for this build: ${failureText(error)} Run \`singularity-flow product reviews\` to retry.`);
    return 'failed';
  }
  if (!result) return 'unavailable';
  // A terminal's background pass still owns this build's reviews; a later window reports them.
  if (result.status === 'running') return 'running';
  // A failed pass is retried after an hour; the window that ran it has already warned.
  if (result.outcome === 'failed') return 'failed';
  const unfinished = result.unfinished ?? [];
  if (unfinished.length) {
    host.log(`Configuration reviews not yet checked, tried again after an hour: ${unfinished
      .map((entry) => `${entry.repository} (${entry.reason})`).join('; ')}`);
  }
  if (result.outcome === 'unavailable') return 'unavailable';
  // A pass that left repositories unchecked is not done for this build: a later window runs it again.
  if (!unfinished.length) await host.remember(CONFIGURATION_REVIEW_KEY, loadedBuild);
  const reviews = (result.reviews ?? []).filter((entry) => entry.proposalBranch);
  for (const entry of reviews) host.log(`Configuration review opened: ${entry.repository} → ${entry.proposalBranch}`);
  if (!reviews.length) return unfinished.length ? 'incomplete' : 'current';
  // Announce reviews once: from the window whose pass opened them, or from a finished pass.
  if (result.status === 'ran' || !unfinished.length) {
    void host.inform(`Singularity Flow opened ${reviews.length} configuration review(s) for this build: `
      + `${reviews.map((entry) => `${entry.repository} → ${entry.proposalBranch}`).join('; ')}. `
      + 'Nothing changes until each review is merged.');
  }
  return 'reviews-opened';
}
